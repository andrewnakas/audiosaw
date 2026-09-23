/*
 * The audio editor's sound: live playback, offline export and recording.
 *
 * Playback and export build the same graph — one AudioBufferSourceNode per
 * clip, through a per-clip gain carrying its fades, into a per-track gain and
 * panner, into the master — the only difference being whether it is an
 * AudioContext or an OfflineAudioContext underneath. That is deliberate: the
 * export cannot drift from what you heard, because it is the same code.
 *
 * Fades are scheduled as value curves sampled from ASEditModel.clipGainAt, the
 * function the waveform drawing also uses, so the curve on screen, the curve
 * you hear and the curve in the file are one curve.
 *
 * Recording goes through an AudioWorklet in the playback context rather than
 * MediaRecorder. MediaRecorder hands back a compressed blob with no timing
 * information, so a take recorded over the other tracks could only be lined up
 * by guessing. The worklet delivers raw samples stamped with the context's own
 * clock, which is the clock the playback is scheduled on; the remaining offset
 * is the round trip through the hardware, which the context reports.
 */
(function (global) {
  'use strict';

  var M = global.ASEditModel;
  var Ctx = global.AudioContext || global.webkitAudioContext;
  var Octx = global.OfflineAudioContext || global.webkitOfflineAudioContext;

  var ctx = null;
  var master = null, meterL = null, meterR = null;
  var playing = null;          // { from, t0, nodes:[], tracks:{} }
  var buffers = new Map();     // sourceId -> AudioBuffer

  function ensureCtx() {
    if (ctx) return ctx;
    ctx = new Ctx({ latencyHint: 'interactive' });
    master = ctx.createGain();
    var split = ctx.createChannelSplitter(2);
    meterL = ctx.createAnalyser(); meterL.fftSize = 1024;
    meterR = ctx.createAnalyser(); meterR.fftSize = 1024;
    master.connect(ctx.destination);
    master.connect(split);
    split.connect(meterL, 0);
    split.connect(meterR, 1);
    return ctx;
  }

  // Resume inside the user gesture that started playback: iOS keeps a context
  // created outside one suspended forever.
  function unlock() {
    ensureCtx();
    if (ctx.state === 'suspended') return ctx.resume();
    return Promise.resolve();
  }

  /* ------------------------------------------------------------ the graph */

  function scheduleClipGain(param, clip, local, when, until) {
    var g0 = M.clipGainAt(clip, local);
    param.setValueAtTime(g0, when);
    var fi = clip.fadeIn || 0, fo = clip.fadeOut || 0, d = clip.duration;
    var lastEnd = when;

    function curve(a, b) {
      // a, b are local times; sample the model's gain function across them.
      if (b - a < 0.002) return;
      var start = when + (a - local);
      if (start < lastEnd) start = lastEnd + 1e-4;
      var dur = b - a;
      if (start + dur > until) dur = until - start;
      if (dur <= 0.001) return;
      var n = Math.max(16, Math.min(512, Math.ceil(dur * 200)));
      var arr = new Float32Array(n);
      for (var i = 0; i < n; i++) arr[i] = M.clipGainAt(clip, a + (b - a) * (i / (n - 1)));
      try {
        param.setValueCurveAtTime(arr, start, dur);
        lastEnd = start + dur;
      } catch (e) { /* overlapping automation: leave the level where it was */ }
    }

    if (fi > 0 && local < fi) curve(local, fi);
    if (fo > 0) {
      var fs = Math.max(local, d - fo);
      if (fs < d) {
        if (fs > Math.max(local, fi)) param.setValueAtTime(M.clipGainAt(clip, fs), when + (fs - local));
        curve(fs, d);
      }
    }
  }

  // Build the mix of [from, to) into `dest`, starting at context time `when`.
  // Returns the nodes so live playback can stop them and adjust track levels.
  function build(c, dest, project, from, to, when) {
    var audible = M.audibleTracks(project);
    var nodes = [], tracks = {};
    project.tracks.forEach(function (t) {
      var tg = c.createGain();
      tg.gain.value = audible[t.id] ? M.dbToGain(t.volDb || 0) : 0;
      var out = tg;
      var pan = null;
      if (c.createStereoPanner) {
        pan = c.createStereoPanner();
        pan.pan.value = t.pan || 0;
        tg.connect(pan);
        out = pan;
      }
      out.connect(dest);
      tracks[t.id] = { gain: tg, pan: pan };

      t.clips.forEach(function (clip) {
        var ce = M.clipEnd(clip);
        if (ce <= from || clip.start >= to) return;
        var buf = buffers.get(clip.sourceId);
        if (!buf) return;
        var cs = Math.max(clip.start, from);
        var local = cs - clip.start;
        var dur = Math.min(ce, to) - cs;
        if (dur <= 0.0005) return;
        var at = when + (cs - from);
        var src = c.createBufferSource();
        src.buffer = buf;
        var g = c.createGain();
        scheduleClipGain(g.gain, clip, local, at, at + dur);
        src.connect(g);
        g.connect(tg);
        src.start(at, clip.offset + local, dur);
        nodes.push(src);
      });
    });
    return { nodes: nodes, tracks: tracks };
  }

  /* ------------------------------------------------------------- playback */

  function play(project, from, opts) {
    opts = opts || {};
    ensureCtx();
    stop();
    var to = opts.to != null ? opts.to : M.duration(project);
    if (to - from < 0.01) return false;
    var when = ctx.currentTime + 0.06;
    var g = build(ctx, master, project, from, to, when);
    playing = { from: from, to: to, t0: when, nodes: g.nodes, tracks: g.tracks };
    return true;
  }

  function stop() {
    if (!playing) return;
    playing.nodes.forEach(function (n) { try { n.stop(); } catch (e) {} try { n.disconnect(); } catch (e) {} });
    Object.keys(playing.tracks).forEach(function (k) {
      var t = playing.tracks[k];
      try { t.gain.disconnect(); } catch (e) {}
      if (t.pan) { try { t.pan.disconnect(); } catch (e) {} }
    });
    playing = null;
  }

  function isPlaying() { return !!playing; }

  // Timeline position being heard right now. Output latency is subtracted so
  // the playhead sits on the sound, not on the sample being handed to the
  // driver — on Bluetooth headphones that difference is a visible 150+ ms.
  function position() {
    if (!playing) return null;
    var lat = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
    return playing.from + Math.max(0, ctx.currentTime - playing.t0 - lat);
  }

  function playEnd() { return playing ? playing.to : null; }
  function playInfo() { return playing ? { from: playing.from, t0: playing.t0 } : null; }

  // Mute, solo, volume and pan apply to the running graph without a restart.
  function updateTracks(project) {
    if (!playing) return;
    var audible = M.audibleTracks(project);
    project.tracks.forEach(function (t) {
      var n = playing.tracks[t.id];
      if (!n) return;
      n.gain.gain.setTargetAtTime(audible[t.id] ? M.dbToGain(t.volDb || 0) : 0, ctx.currentTime, 0.015);
      if (n.pan) n.pan.pan.setTargetAtTime(t.pan || 0, ctx.currentTime, 0.015);
    });
  }

  function meter() {
    if (!meterL) return [0, 0];
    return [peakOf(meterL), peakOf(meterR)];
  }
  var meterBuf = null;
  function peakOf(an) {
    if (!meterBuf || meterBuf.length !== an.fftSize) meterBuf = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(meterBuf);
    var p = 0;
    for (var i = 0; i < meterBuf.length; i++) { var v = meterBuf[i] < 0 ? -meterBuf[i] : meterBuf[i]; if (v > p) p = v; }
    return p;
  }

  // Short audition of a single source region, for scrubbing a trim edge.
  function audition(sourceId, offset, dur) {
    ensureCtx();
    var buf = buffers.get(sourceId);
    if (!buf) return;
    var src = ctx.createBufferSource();
    src.buffer = buf;
    var g = ctx.createGain();
    var t = ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.9, t + 0.005);
    g.gain.setValueAtTime(0.9, t + dur - 0.01);
    g.gain.linearRampToValueAtTime(0, t + dur);
    src.connect(g); g.connect(master);
    src.start(t, Math.max(0, offset), dur);
  }

  /* --------------------------------------------------------------- export */

  function render(project, t0, t1, opts) {
    opts = opts || {};
    var sr = opts.sampleRate || 44100;
    var ch = opts.channels || 2;
    var len = Math.max(1, Math.ceil((t1 - t0) * sr));
    var off = new Octx(ch, len, sr);
    var bus = off.createGain();
    bus.connect(off.destination);
    build(off, bus, project, t0, t1, 0);
    return off.startRendering().then(function (out) {
      var peak = 0;
      for (var c = 0; c < out.numberOfChannels; c++) {
        var d = out.getChannelData(c);
        for (var i = 0; i < d.length; i++) { var v = d[i] < 0 ? -d[i] : d[i]; if (v > peak) peak = v; }
      }
      // Only ever turn a mix down. A mix that would clip is brought to -1 dBFS
      // peak; one that would not is left exactly as you heard it.
      var ceiling = Math.pow(10, -1 / 20);
      if (opts.protect !== false && peak > ceiling) {
        var g = ceiling / peak;
        for (var c2 = 0; c2 < out.numberOfChannels; c2++) {
          var dd = out.getChannelData(c2);
          for (var j = 0; j < dd.length; j++) dd[j] *= g;
        }
      }
      return { buffer: out, peak: peak };
    });
  }

  /* ------------------------------------------------------------ recording */

  var WORKLET = [
    'class ASRec extends AudioWorkletProcessor {',
    '  constructor() { super(); this.buf = null; this.n = 0; this.t = 0; this.on = true;',
    '    this.port.onmessage = (e) => { if (e.data === "stop") { this.flush(); this.on = false; } }; }',
    '  flush() { if (this.buf && this.n) { this.port.postMessage({ t: this.t, ch: this.buf.map((b) => b.slice(0, this.n)) }); } this.buf = null; this.n = 0; }',
    '  process(inputs) {',
    '    const inp = inputs[0];',
    '    if (!this.on) return false;',
    '    if (!inp || !inp.length) return true;',
    '    if (!this.buf) { this.buf = inp.map(() => new Float32Array(4096)); this.n = 0; this.t = currentTime; }',
    '    const len = inp[0].length;',
    '    for (let c = 0; c < this.buf.length; c++) this.buf[c].set(inp[c] || inp[0], this.n);',
    '    this.n += len;',
    '    if (this.n + 128 > 4096) this.flush();',
    '    return true;',
    '  }',
    '}',
    'registerProcessor("as-rec", ASRec);'
  ].join('\n');
  var workletReady = null;

  function loadWorklet() {
    if (workletReady) return workletReady;
    if (!ctx.audioWorklet) return (workletReady = Promise.resolve(false));
    var url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    workletReady = ctx.audioWorklet.addModule(url).then(function () { return true; }, function () { return false; });
    return workletReady;
  }

  var rec = null;

  // Starts capturing. `onChunk(channels)` receives raw Float32 arrays as they
  // arrive, for the live waveform. Resolves once the microphone is open.
  function startRecording(onChunk) {
    ensureCtx();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error('This browser cannot record audio.'));
    }
    return navigator.mediaDevices.getUserMedia({
      // Off, because every one of these is designed for calls and damages music:
      // AGC pumps, noise suppression eats sustained notes, echo cancellation
      // ducks the take whenever the backing track is loud.
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    }).then(function (stream) {
      return loadWorklet().then(function (hasWorklet) {
        var srcNode = ctx.createMediaStreamSource(stream);
        var sink = ctx.createGain();
        sink.gain.value = 0;
        sink.connect(ctx.destination);
        var chunks = [], firstT = null, node;
        function take(t, chans) {
          if (firstT === null) firstT = t;
          chunks.push(chans);
          if (onChunk) onChunk(chans);
        }
        if (hasWorklet) {
          node = new AudioWorkletNode(ctx, 'as-rec', { numberOfInputs: 1, numberOfOutputs: 1, channelCountMode: 'explicit', channelCount: 2 });
          node.port.onmessage = function (e) { take(e.data.t, e.data.ch); };
        } else {
          node = ctx.createScriptProcessor(4096, 2, 2);
          node.onaudioprocess = function (e) {
            var ib = e.inputBuffer, chans = [];
            for (var c = 0; c < ib.numberOfChannels; c++) chans.push(new Float32Array(ib.getChannelData(c)));
            take(e.playbackTime - ib.duration, chans);
          };
        }
        srcNode.connect(node);
        node.connect(sink);
        var settings = {};
        try { settings = stream.getAudioTracks()[0].getSettings() || {}; } catch (e) {}
        rec = {
          stream: stream, node: node, srcNode: srcNode, sink: sink, chunks: chunks,
          firstT: function () { return firstT; }, worklet: hasWorklet,
          inputLatency: typeof settings.latency === 'number' ? settings.latency : 0.01,
          mono: settings.channelCount === 1
        };
        return true;
      });
    });
  }

  function isRecording() { return !!rec; }

  // Stops and returns { buffer, firstT, latency } — the samples, the context
  // time of the first one, and the round trip to subtract when placing it.
  function stopRecording() {
    if (!rec) return Promise.resolve(null);
    var r = rec;
    rec = null;
    var done = r.worklet
      ? new Promise(function (res) {
          var prev = r.node.port.onmessage;
          r.node.port.onmessage = function (e) { prev(e); };
          r.node.port.postMessage('stop');
          setTimeout(res, 120);
        })
      : Promise.resolve();
    return done.then(function () {
      try { r.srcNode.disconnect(); r.node.disconnect(); r.sink.disconnect(); } catch (e) {}
      r.stream.getTracks().forEach(function (t) { t.stop(); });
      var total = 0;
      r.chunks.forEach(function (ch) { total += ch[0].length; });
      if (!total) return null;
      // A mono microphone arrives upmixed to two identical channels; keep one.
      var nch = r.mono ? 1 : Math.min(2, r.chunks[0].length);
      if (nch === 2 && isDualMono(r.chunks)) nch = 1;
      var buf = ctx.createBuffer(nch, total, ctx.sampleRate);
      for (var c = 0; c < nch; c++) {
        var d = buf.getChannelData(c), pos = 0;
        r.chunks.forEach(function (ch) { d.set(ch[c] || ch[0], pos); pos += ch[0].length; });
      }
      return {
        buffer: buf,
        firstT: r.firstT(),
        latency: (ctx.outputLatency || 0) + (ctx.baseLatency || 0) + r.inputLatency
      };
    });
  }

  function isDualMono(chunks) {
    for (var i = 0; i < chunks.length; i += 7) {
      var a = chunks[i][0], b = chunks[i][1];
      if (!b) return true;
      for (var j = 0; j < a.length; j += 31) if (Math.abs(a[j] - b[j]) > 1e-6) return false;
    }
    return true;
  }

  // Context time -> timeline time, while playing.
  function timelineAt(ctxTime) {
    if (!playing) return null;
    return playing.from + (ctxTime - playing.t0);
  }

  function now() { return ctx ? ctx.currentTime : 0; }
  function sampleRate() { ensureCtx(); return ctx.sampleRate; }
  function createBuffer(ch, len, sr) { ensureCtx(); return ctx.createBuffer(ch, len, sr); }

  global.ASEditEngine = {
    buffers: buffers,
    unlock: unlock,
    play: play, stop: stop, isPlaying: isPlaying, position: position, playEnd: playEnd, playInfo: playInfo,
    updateTracks: updateTracks, meter: meter, audition: audition,
    render: render,
    startRecording: startRecording, stopRecording: stopRecording, isRecording: isRecording,
    timelineAt: timelineAt, now: now, sampleRate: sampleRate, createBuffer: createBuffer
  };
})(window);
