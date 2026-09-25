/*
 * The audio editor's sound: live playback, offline export and recording.
 *
 * Playback and export build the same graph — one AudioBufferSourceNode per
 * clip, through a per-clip gain carrying its fades, into the track's insert
 * effects, fader, pan and sends, through the return buses and the master
 * chain — the only difference being whether it is an AudioContext or an
 * OfflineAudioContext underneath. That is deliberate: the export cannot drift
 * from what you heard, because it is the same code. The effects themselves
 * are built by editor-dsp.js; this file only wires them.
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

  var M = global.ASEditModel, D = global.ASEditDsp;
  var Ctx = global.AudioContext || global.webkitAudioContext;
  var Octx = global.OfflineAudioContext || global.webkitOfflineAudioContext;

  var ctx = null;
  var master = null, meterL = null, meterR = null;
  var playing = null;          // { from, to, t0, G, project, loop, next, prev, passes }
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
    // The effect processors load in the background. Anything that plays
    // before they are ready is rebuilt the moment they are.
    D.ensureWorklet(ctx).then(function (ok) { if (ok && playing) replay(); });
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

  /*
   * The mixer. Per track:
   *
   *   clips → in → [inserts] → (latency make-up) → volume → pan → mute → out ─┬→ mix bus
   *                                                                           └→ sends → bus in → [bus inserts] → bus volume → mix bus
   *   mix bus → [master inserts] → master volume → dest
   *
   * `in` is stereo. A mono clip reaches it at -3 dB and the pan law adds the
   * 3 dB back only on the side it is panned to, so a mono track sounds exactly
   * as it did before the mixer existed: centre is 0.707 per side, hard left is
   * unity on the left. The pan is built from gains driven through a pair of
   * wave-shapers by one ConstantSource, so it can be automated sample-accurately
   * like any other AudioParam.
   *
   * A plugin with look-ahead (the limiter) delays its track. Every track and
   * every bus is padded to the slowest one so they stay in time with each
   * other, and the export trims the total off the front.
   */
  var PAN_L = null, PAN_R = null;
  function panCurves() {
    if (PAN_L) return;
    var n = 1025;
    PAN_L = new Float32Array(n); PAN_R = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var x = (i / (n - 1)) * Math.PI / 2;   // pan -1..1 -> 0..pi/2
      PAN_L[i] = Math.SQRT2 * Math.cos(x);
      PAN_R[i] = Math.SQRT2 * Math.sin(x);
    }
  }

  function dbGain(db) { return M.dbToGain(db); }

  // Schedule an automation lane onto an AudioParam from timeline time `from`
  // (context time `when`) to `to`. Segments are sampled into value curves, the
  // same way fades are, because a dB lane ramped linearly in gain would bend.
  function scheduleLane(param, pts, from, to, when, map) {
    var v0 = map(M.autoValueAt(pts, from));
    param.cancelScheduledValues(when);
    param.setValueAtTime(v0, when);
    var cursor = from;
    for (var i = 0; i < pts.length && cursor < to; i++) {
      var tEnd = Math.min(pts[i][0], to);
      if (tEnd <= cursor + 1e-4) continue;
      var a = M.autoValueAt(pts, cursor), b = M.autoValueAt(pts, tEnd);
      var start = when + (cursor - from), dur = tEnd - cursor;
      if (Math.abs(a - b) < 1e-9) param.setValueAtTime(map(b), start + dur);
      else {
        var n = Math.max(8, Math.min(1024, Math.ceil(dur * 100)));
        var arr = new Float32Array(n);
        for (var k = 0; k < n; k++) arr[k] = map(M.autoValueAt(pts, cursor + dur * k / (n - 1)));
        try { param.setValueCurveAtTime(arr, start, dur); } catch (e) { param.setValueAtTime(map(b), start + dur); }
      }
      cursor = tEnd;
    }
  }

  // Lanes the user is overriding by hand right now (a slider held while
  // automation records): the lane is ignored and the static value plays.
  var holds = {};
  function hold(path, on) { if (on) holds[path] = true; else delete holds[path]; }

  // Parameters for a slot at timeline time t, with its automation applied.
  function slotParams(owner, slot, t) {
    var q = D.resolve(slot), auto = owner && owner.auto;
    if (!auto) return q;
    var pre = 'fx:' + slot.id + ':';
    Object.keys(auto).forEach(function (path) {
      if (path.indexOf(pre) !== 0 || holds[path]) return;
      var k = path.slice(pre.length), v = M.autoValueAt(auto[path], t);
      var pd = D.PLUGINS[slot.type] && D.PLUGINS[slot.type].byKey[k];
      if (pd && !pd.opts && v != null) q[k] = v;
    });
    return q;
  }

  function buildChain(c, owner, fx, env, t) {
    var list = [];
    (fx || []).forEach(function (slot) {
      if (slot.on === false || !D.PLUGINS[slot.type]) return;
      var inst = D.create(c, { id: slot.id, type: slot.type, on: true, params: slotParams(owner, slot, t) }, env);
      if (inst) { inst.slotJson = JSON.stringify(slot.params); list.push(inst); }
    });
    return list;
  }
  function chainSig(fx) { return (fx || []).map(D.sig).filter(Boolean).join('>'); }
  function chainLatency(list) { return list.reduce(function (s, i) { return s + (i.latency || 0); }, 0); }
  function wire(pre, list, post) {
    var node = pre;
    list.forEach(function (inst) { node.connect(inst.in); node = inst.out; });
    node.connect(post);
  }
  function unwire(pre, list, post) {
    try { pre.disconnect(list.length ? list[0].in : post); } catch (e) {}
    list.forEach(function (inst) { inst.dispose(); });
  }
  function delayNode(c, secs) {
    if (!(secs > 1e-7)) return null;
    var d = c.createDelay(Math.max(1, secs + 0.01));
    d.delayTime.value = secs;
    return d;
  }

  function busUsed(project, busId) {
    return project.tracks.some(function (t) { return (t.sends[busId] > -60) || !!t.auto['send:' + busId]; });
  }

  // Start every clip's audio for timeline [from, to) at context time `when`,
  // into the track inputs of a built graph. A looping playback calls this
  // again for each pass, into the same graph. `into` collects the sources.
  function scheduleClips(G, project, from, to, when, into) {
    var c = G.ctx;
    into = into || G.nodes;
    project.tracks.forEach(function (t) {
      var T = G.tracks[t.id];
      if (!T) return;
      t.clips.forEach(function (clip) {
        var ce = M.clipEnd(clip);
        if (ce <= from || clip.start >= to) return;
        var msrc = project.sources[clip.sourceId];
        if (msrc && msrc.kind === 'midi') { scheduleMidi(G, project, t, clip, msrc, from, to, when, into); return; }
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
        if (buf.numberOfChannels === 1) {
          // Upmixed to both sides at -3 dB: see the pan law above.
          var m3 = c.createGain(); m3.gain.value = Math.SQRT1_2;
          g.connect(m3); m3.connect(T.in);
        } else g.connect(T.in);
        src.start(at, clip.offset + local, dur);
        src.onended = function () { src.done = true; try { src.disconnect(); } catch (e) {} };
        into.push(src);
        if (into !== G.nodes) G.nodes.push(src);
      });
    });
  }

  // A MIDI clip: each note through the track's instrument, into one gain
  // per clip that carries the clip's gain and fades, exactly as a sample
  // clip's does. A note already sounding at `from` (playback started in the
  // middle of it) starts there, so a held pad is not silent until its next
  // note. Notes are cut at `to`, and ring on for their release after it.
  function instOf(track, src) { return track.inst || (src.drums ? 'drums' : 'keys'); }
  function scheduleMidi(G, project, track, clip, src, from, to, when, into) {
    var S = global.ASEditSynth, c = G.ctx, T = G.tracks[track.id];
    if (!S || !T) return;
    var cs = Math.max(clip.start, from), ce = Math.min(M.clipEnd(clip), to);
    if (ce - cs <= 0.0005) return;
    var g = c.createGain();
    scheduleClipGain(g.gain, clip, cs - clip.start, when + (cs - from), when + (ce - from));
    // The instruments are mono: in at -3 dB, like a mono clip (the pan law).
    var m3 = c.createGain(); m3.gain.value = Math.SQRT1_2;
    g.connect(m3); m3.connect(T.in);
    var inst = instOf(track, src), list = [];
    M.clipNotes(project, clip).forEach(function (n) {
      var a = Math.max(n.start, from), b = Math.min(n.start + n.duration, to);
      if (b - a < 0.001 || a >= to) return;
      if (inst === 'drums' && a > n.start + 1e-6) return;     // a drum hit is its start
      list.push({ at: when + (a - from), dur: b - a, midi: n.midi, vel: n.velocity });
    });
    list.sort(function (x, y) { return x.at - y.at; });
    // The notes are built a little ahead of when they sound (feedMidi), not
    // all now: a finished note's nodes are cheap, but thousands of waiting
    // ones are not. Measured on a 3-minute part of 5,000 notes: building
    // them all up front took 5.6 minutes to export.
    var rec = { g: g, inst: inst, list: list, i: 0, into: into, dead: false };
    var handle = { rec: rec, stop: function () { rec.dead = true; }, disconnect: function () {} };
    into.push(handle);
    if (into !== G.nodes) G.nodes.push(handle);
    (G.midi = G.midi || []).push(rec);
  }

  // Build every pending note that starts before context time `until`.
  function feedMidi(G, until) {
    if (!G || !G.midi || !G.midi.length) return;
    var S = global.ASEditSynth;
    G.midi = G.midi.filter(function (rec) {
      if (rec.dead) return false;
      var started = [];
      while (rec.i < rec.list.length && rec.list[rec.i].at < until) {
        var n = rec.list[rec.i++];
        S.note(G.ctx, rec.g, rec.inst, n.midi, n.at, n.dur, n.vel, started);
      }
      started.forEach(function (x) {
        x.onended = function () { x.done = true; try { x.disconnect(); } catch (e) {} };
        rec.into.push(x);
        if (rec.into !== G.nodes) G.nodes.push(x);
      });
      return rec.i < rec.list.length;
    });
  }

  // Build the mix of [from, to) into `dest`, starting at context time `when`.
  function build(c, dest, project, from, to, when, opts) {
    opts = opts || {};
    M.normalize(project);
    panCurves();
    var audible = M.audibleTracks(project);
    var G = { ctx: c, nodes: [], owners: {}, tracks: {}, buses: {}, lanes: [], project: project, from: from, when: when };
    var env = { bpm: project.bpm, key: function (id) { return G.tracks[id] ? G.tracks[id].in : null; } };
    G.env = env;
    var mix = c.createGain();
    G.mix = mix;

    // Pass 1: every track's input exists before any ducker asks for one.
    project.tracks.forEach(function (t) {
      var tin = c.createGain();
      tin.channelCount = 2; tin.channelCountMode = 'explicit'; tin.channelInterpretation = 'speakers';
      G.tracks[t.id] = { in: tin, sends: {} };
    });

    // Pass 2: chains, faders, pans, sends.
    var trackChains = {};
    project.tracks.forEach(function (t) {
      trackChains[t.id] = buildChain(c, t, t.fx, env, from);
    });
    var tMax = 0, bMax = 0;
    Object.keys(trackChains).forEach(function (k) { tMax = Math.max(tMax, chainLatency(trackChains[k])); });
    var busChains = {};
    project.buses.forEach(function (b) {
      if (!busUsed(project, b.id)) return;
      busChains[b.id] = buildChain(c, b, b.fx, env, from);
      bMax = Math.max(bMax, chainLatency(busChains[b.id]));
    });

    project.tracks.forEach(function (t) {
      var T = G.tracks[t.id], list = trackChains[t.id];
      var vol = c.createGain(), mute = c.createGain(), out = c.createGain();
      var split = c.createChannelSplitter(2), merge = c.createChannelMerger(2), gl = c.createGain(), gr = c.createGain();
      gl.gain.value = 0; gr.gain.value = 0;
      var panSrc = c.createConstantSource(), shL = c.createWaveShaper(), shR = c.createWaveShaper();
      shL.curve = PAN_L; shR.curve = PAN_R;
      panSrc.offset.value = t.pan || 0;
      panSrc.connect(shL); panSrc.connect(shR); shL.connect(gl.gain); shR.connect(gr.gain);
      panSrc.start(when);
      G.nodes.push(panSrc);

      var comp = delayNode(c, tMax - chainLatency(list));
      var post = comp || vol;
      if (comp) comp.connect(vol);
      wire(T.in, list, post);
      G.owners[t.id] = { pre: T.in, post: post, list: list, sig: chainSig(t.fx) };

      vol.gain.value = dbGain(t.volDb || 0);
      vol.connect(split); split.connect(gl, 0); split.connect(gr, 1);
      gl.connect(merge, 0, 0); gr.connect(merge, 0, 1);
      merge.connect(mute);
      mute.gain.value = audible[t.id] ? 1 : 0;
      mute.connect(out);
      var dry = delayNode(c, bMax);
      if (dry) { out.connect(dry); dry.connect(mix); } else out.connect(mix);

      T.vol = vol; T.pan = panSrc.offset; T.mute = mute; T.out = out;
      if (t.auto.vol) G.lanes.push([vol.gain, t.auto.vol, dbGain]);
      if (t.auto.pan) G.lanes.push([panSrc.offset, t.auto.pan, function (v) { return Math.max(-1, Math.min(1, v)); }]);
      project.buses.forEach(function (b) {
        if (!busChains[b.id]) return;
        var sg = c.createGain();
        sg.gain.value = t.sends[b.id] > -60 ? dbGain(t.sends[b.id]) : 0;
        out.connect(sg);
        T.sends[b.id] = sg;
        if (t.auto['send:' + b.id]) G.lanes.push([sg.gain, t.auto['send:' + b.id], dbGain]);
      });

    });
    scheduleClips(G, project, from, to, when);

    project.buses.forEach(function (b) {
      if (!busChains[b.id]) return;
      var bin = c.createGain(), vol = c.createGain();
      bin.channelCount = 2; bin.channelCountMode = 'explicit';
      var list = busChains[b.id];
      var comp = delayNode(c, bMax - chainLatency(list));
      var post = comp || vol;
      if (comp) comp.connect(vol);
      wire(bin, list, post);
      vol.gain.value = dbGain(b.volDb || 0);
      vol.connect(mix);
      project.tracks.forEach(function (t) { var sg = G.tracks[t.id].sends[b.id]; if (sg) sg.connect(bin); });
      G.buses[b.id] = { in: bin, vol: vol };
      G.owners[b.id] = { pre: bin, post: post, list: list, sig: chainSig(b.fx) };
    });

    var mvol = c.createGain();
    mvol.gain.value = dbGain(project.master.volDb || 0);
    var mlist = opts.noMaster ? [] : buildChain(c, project.master, project.master.fx, env, from);
    wire(mix, mlist, mvol);
    mvol.connect(dest);
    G.owners.master = { pre: mix, post: mvol, list: mlist, sig: opts.noMaster ? '' : chainSig(project.master.fx) };
    G.masterVol = mvol;
    if (project.master.auto.vol && !opts.noMaster) G.lanes.push([mvol.gain, project.master.auto.vol, dbGain]);
    G.latency = tMax + bMax + chainLatency(mlist);

    G.lanes.forEach(function (l) { scheduleLane(l[0], l[1], from, to, when, l[2]); });
    G.fxLanes = fxLanes(project, G);
    return G;
  }

  // Plugin parameters with automation lanes. These are not AudioParams (a
  // plugin's "Decay" can be several nodes, or a regenerated curve), so they
  // are stepped: every 25 ms live, and at render-quantum suspends offline.
  function fxLanes(project, G) {
    var out = [];
    function scan(key, owner) {
      var o = G.owners[key];
      if (!o || !owner.auto) return;
      o.list.forEach(function (inst) {
        var has = Object.keys(owner.auto).some(function (p) { return p.indexOf('fx:' + inst.id + ':') === 0; });
        if (has) out.push({ owner: owner, key: key, inst: inst });
      });
    }
    project.tracks.forEach(function (t) { scan(t.id, t); });
    scan('master', project.master);
    return out;
  }
  function slotOf(owner, id) { for (var i = 0; i < owner.fx.length; i++) if (owner.fx[i].id === id) return owner.fx[i]; return null; }
  function applyFxLanes(G, t) {
    G.fxLanes.forEach(function (l) {
      var slot = slotOf(l.owner, l.inst.id);
      if (!slot) return;
      var q = slotParams(l.owner, slot, t), js = JSON.stringify(q);
      if (js !== l.last) { l.last = js; l.inst.set(q); }
    });
  }

  /* ------------------------------------------------------------ metronome */

  // The click goes straight to the speakers, past the master chain and the
  // meters. Only live playback schedules it: render() builds its own offline
  // context and never comes here, so a click cannot end up in an export.
  // Clicks are scheduled ~150 ms ahead on the context clock, the clock the
  // clips play on, so they stay sample-locked however late the timer fires.
  var click = { on: false, vol: 0.6, gain: null, bufs: null, timer: 0, nodes: [], log: [] };

  function clickBufs() {
    if (click.bufs) return click.bufs;
    var sr = ctx.sampleRate;
    // Beat, group (the 4 of 6/8) and downbeat.
    click.bufs = [1000, 1400, 2000].map(function (hz) {
      var n = Math.round(sr * 0.04), b = ctx.createBuffer(1, n, sr), d = b.getChannelData(0);
      for (var i = 0; i < n; i++) {
        var t = i / sr;
        d[i] = 0.8 * Math.sin(2 * Math.PI * hz * t) * Math.exp(-t / 0.008) * Math.min(1, t / 0.0005);
      }
      return b;
    });
    click.gain = ctx.createGain();
    click.gain.gain.value = click.vol;
    click.gain.connect(ctx.destination);
    return click.bufs;
  }

  function clickAt(when, accent) {
    if (when < ctx.currentTime) return;
    var s = ctx.createBufferSource();
    s.when = when;
    s.buffer = clickBufs()[accent || 0];
    s.connect(click.gain);
    s.start(when);
    click.nodes.push(s);
    s.onended = function () { var i = click.nodes.indexOf(s); if (i >= 0) click.nodes.splice(i, 1); try { s.disconnect(); } catch (e) {} };
    click.log.push({ when: when, accent: accent || 0 });
    if (click.log.length > 256) click.log.shift();
  }

  // Each pass of a loop is a segment with its own clock mapping; the next
  // one is already scheduled when this runs near a loop's end.
  function scheduleClicks() {
    if (!playing || !click.on) return;
    var now = ctx.currentTime;
    clicksFor(playing, now);
    if (playing.next) clicksFor(playing.next, now);
  }
  function clicksFor(p, now) {
    // Never behind "now": switching the click on mid-song must not fire a
    // burst of every beat it missed.
    var fromT = Math.max(p.clickT, p.from + (now - p.t0));
    var toT = Math.min(p.to, p.from + (now + 0.15 - p.t0));
    if (toT <= fromT) return;
    M.clickTimes(playing.project, fromT, toT).forEach(function (c) { clickAt(p.t0 + c.t - p.from, c.accent); });
    p.clickT = toT;
  }

  function silenceClicks() {
    click.nodes.forEach(function (n) { try { n.stop(); } catch (e) {} try { n.disconnect(); } catch (e) {} });
    click.nodes = [];
    // The log is of clicks heard, so drop the ones just cancelled.
    if (ctx) click.log = click.log.filter(function (c) { return c.when <= ctx.currentTime; });
  }

  function setClick(o) {
    if (o.vol != null) { click.vol = Math.max(0, Math.min(1, +o.vol)); if (click.gain) click.gain.gain.value = click.vol; }
    if (o.on != null) {
      click.on = !!o.on;
      if (!click.on) silenceClicks();
      else if (playing) {
        playing.clickT = playing.from + Math.max(0, ctx.currentTime - playing.t0);
        if (playing.next) playing.next.clickT = playing.next.from;
        scheduleClicks();
      }
    }
  }
  function clickState() { return { on: click.on, vol: click.vol, log: click.log.slice() }; }

  /* ------------------------------------------------------------- playback */

  var ticker = 0;
  var MIN_LOOP = 0.05;

  // opts.countIn: seconds of count-in clicks before `from` starts sounding.
  // The timeline mapping simply starts that much later, so everything keyed
  // off t0 (the playhead, recording placement) needs no special case.
  //
  // opts.loop: [r0, r1]. When the playback reaches `to` it carries on from r0
  // without a break. Each pass is scheduled into the running graph on the
  // context clock shortly before the one before it ends, so the join is
  // sample-exact: stopping and rebuilding the graph at the end, as looping
  // used to, left about 0.1 s of silence every time round.
  function play(project, from, opts) {
    opts = opts || {};
    ensureCtx();
    stop();
    var to = opts.to != null ? opts.to : M.duration(project);
    if (to - from < 0.01) return false;
    var pre = opts.countIn > 0 ? opts.countIn : 0;
    var when = ctx.currentTime + 0.06 + pre;
    var G = build(ctx, master, project, from, to, when);
    playing = { from: from, to: to, t0: when, G: G, project: project, clickT: from, loop: null, next: null, prev: null, passes: [{ from: from, t0: when }] };
    setLoop(opts.loop);
    if (pre) M.clickTimes(project, from - pre, from).forEach(function (c) { clickAt(when + c.t - from, c.accent); });
    pump();
    click.timer = setInterval(pump, 25);
    if (G.fxLanes.length) {
      ticker = setInterval(function () {
        if (!playing) return;
        applyFxLanes(playing.G, playing.from + Math.max(0, ctx.currentTime - playing.t0));
      }, 25);
    }
    return true;
  }

  function pump() {
    advanceLoop();
    // A hidden tab's timers can be held to once a second.
    if (playing) feedMidi(playing.G, ctx.currentTime + ((global.document && global.document.hidden) ? 2.5 : 1));
    scheduleClicks();
  }

  // Schedule the next pass of a loop ahead of time, and step onto it once
  // it has begun.
  function advanceLoop() {
    var p = playing;
    if (!p) return;
    var now = ctx.currentTime;
    if (p.next && now >= p.next.t0) {
      var n = p.next;
      p.prev = { from: p.from, to: p.to, t0: p.t0 };
      p.from = n.from; p.to = n.to; p.t0 = n.t0; p.clickT = n.clickT; p.next = null;
      p.passes.push({ from: p.from, t0: p.t0 });
      p.G.nodes = p.G.nodes.filter(function (x) { return !x.done && !(x.rec && x.rec.i >= x.rec.list.length); });
    }
    if (!p.loop || p.next) return;
    var end = p.t0 + (p.to - p.from);
    // A hidden tab's timers can be held to once a second.
    var ahead = (global.document && global.document.hidden) ? 1.5 : 0.3;
    if (now < end - ahead) return;
    var r0 = p.loop[0], r1 = p.loop[1];
    var next = { from: r0, to: r1, t0: end, clickT: r0, nodes: [] };
    // A timer that fired too late still keeps the loop in time: the pass
    // starts partway in rather than late.
    var at = Math.max(end, now + 0.02), skip = at - end;
    if (skip < r1 - r0) {
      scheduleClips(p.G, p.project, r0 + skip, r1, at, next.nodes);
      p.G.lanes.forEach(function (l) {
        try { scheduleLane(l[0], l[1], r0 + skip, r1, at, l[2]); } catch (e) { /* leave the lane where it is */ }
      });
    }
    p.next = next;
  }

  // Loop [r0, r1] from the end of the current pass, or null to stop at its
  // end. A pass already scheduled for the old range is called off.
  function setLoop(range) {
    if (!playing) return;
    if (range && !(range[1] - range[0] >= MIN_LOOP)) range = null;
    var cur = playing.loop;
    if (range && cur && Math.abs(range[0] - cur[0]) < 1e-9 && Math.abs(range[1] - cur[1]) < 1e-9) return;
    if (!range && !cur) return;
    playing.loop = range ? [range[0], range[1]] : null;
    var n = playing.next;
    if (n) {
      n.nodes.forEach(function (x) { try { x.stop(); } catch (e) {} try { x.disconnect(); } catch (e) {} });
      click.nodes = click.nodes.filter(function (x) {
        if (x.when < n.t0 - 1e-6) return true;
        try { x.stop(); x.disconnect(); } catch (e) {}
        return false;
      });
      playing.next = null;
    }
  }
  function isLooping() { return !!(playing && playing.loop); }
  function passes() { return playing ? playing.passes.slice() : []; }

  function replay() {
    if (!playing) return;
    var pos = playing.from + Math.max(0, ctx.currentTime - playing.t0);
    var p = playing;
    play(p.project, Math.min(pos, p.to - 0.02), { to: p.to, loop: p.loop });
    if (playing) { playing.from0 = p.from0 != null ? p.from0 : p.from; playing.passes = p.passes; }
  }

  function stop() {
    clearInterval(ticker); ticker = 0;
    clearInterval(click.timer); click.timer = 0;
    silenceClicks();
    if (!playing) return;
    var G = playing.G;
    G.nodes.forEach(function (n) { try { n.stop(); } catch (e) {} try { n.disconnect(); } catch (e) {} });
    Object.keys(G.owners).forEach(function (k) { G.owners[k].list.forEach(function (i) { i.dispose(); }); });
    try { G.masterVol.disconnect(); } catch (e) {}
    Object.keys(G.tracks).forEach(function (k) { try { G.tracks[k].out.disconnect(); } catch (e) {} });
    Object.keys(G.buses).forEach(function (k) { try { G.buses[k].vol.disconnect(); } catch (e) {} });
    probes = {};
    playing = null;
  }

  function isPlaying() { return !!playing; }

  // Timeline time at context time t: on the pass that was playing then, so
  // just after a loop comes round the end of the last pass still maps to
  // the end of the range.
  function mapTime(t, raw) {
    var p = playing;
    if (p.prev && t < p.t0) return p.prev.from + (t - p.prev.t0);
    return p.from + (raw ? t - p.t0 : Math.max(0, t - p.t0));
  }

  // Timeline position being heard right now. Output latency is subtracted so
  // the playhead sits on the sound, not on the sample being handed to the
  // driver — on Bluetooth headphones that difference is a visible 150+ ms.
  function position() {
    if (!playing) return null;
    var lat = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
    return mapTime(ctx.currentTime - lat);
  }

  function playEnd() { return playing ? playing.to : null; }
  function playInfo() { return playing ? { from: playing.from, t0: playing.t0 } : null; }

  // Mute, solo, volume, pan, sends, bus and master levels apply to the running
  // graph without a restart. A level with an automation lane follows the lane.
  function updateTracks(project) {
    if (!playing) return;
    var G = playing.G, now = ctx.currentTime, audible = M.audibleTracks(project);
    playing.project = project;
    project.tracks.forEach(function (t) {
      var n = G.tracks[t.id];
      if (!n || !n.vol) return;
      if (!t.auto.vol || holds[t.id + '|vol']) { n.vol.gain.cancelScheduledValues(now); n.vol.gain.setTargetAtTime(dbGain(t.volDb || 0), now, 0.015); }
      if (!t.auto.pan || holds[t.id + '|pan']) { n.pan.cancelScheduledValues(now); n.pan.setTargetAtTime(t.pan || 0, now, 0.015); }
      n.mute.gain.setTargetAtTime(audible[t.id] ? 1 : 0, now, 0.015);
      Object.keys(n.sends).forEach(function (b) {
        if (!t.auto['send:' + b] || holds[t.id + '|send:' + b]) { n.sends[b].gain.cancelScheduledValues(now); n.sends[b].gain.setTargetAtTime(t.sends[b] > -60 ? dbGain(t.sends[b]) : 0, now, 0.015); }
      });
    });
    project.buses.forEach(function (b) { var n = G.buses[b.id]; if (n) n.vol.gain.setTargetAtTime(dbGain(b.volDb || 0), now, 0.015); });
    if (!project.master.auto.vol || holds['master|vol']) { G.masterVol.gain.cancelScheduledValues(now); G.masterVol.gain.setTargetAtTime(dbGain(project.master.volDb || 0), now, 0.015); }
  }

  // Re-schedule the level, pan and send lanes from where playback is now,
  // after a lane was drawn, moved or recorded. Plugin lanes follow through
  // syncFx, which the caller runs as well.
  function relane(project) {
    if (!playing) return;
    var G = playing.G, now = ctx.currentTime + 0.005, pos = playing.from + Math.max(0, now - playing.t0), to = playing.to;
    var nx = playing.next;
    function lane(param, pts, map, key, fallback) {
      if (pts && !holds[key]) {
        scheduleLane(param, pts, pos, to, now, map);
        // Cancelling from now also cancelled the next pass of a loop.
        if (nx) try { scheduleLane(param, pts, nx.from, nx.to, nx.t0, map); } catch (e) {}
      }
      else { param.cancelScheduledValues(now); param.setTargetAtTime(fallback, now, 0.015); }
    }
    project.tracks.forEach(function (t) {
      var n = G.tracks[t.id];
      if (!n || !n.vol) return;
      lane(n.vol.gain, t.auto.vol, dbGain, t.id + '|vol', dbGain(t.volDb || 0));
      lane(n.pan, t.auto.pan, function (v) { return Math.max(-1, Math.min(1, v)); }, t.id + '|pan', t.pan || 0);
      Object.keys(n.sends).forEach(function (b) {
        lane(n.sends[b].gain, t.auto['send:' + b], dbGain, t.id + '|send:' + b, t.sends[b] > -60 ? dbGain(t.sends[b]) : 0);
      });
    });
    lane(G.masterVol.gain, project.master.auto.vol, dbGain, 'master|vol', dbGain(project.master.volDb || 0));
  }

  // Bring the running effect chains in line with the project. A parameter
  // change is applied in place; adding, removing, reordering or bypassing a
  // plugin (or changing one that alters the graph's shape) rebuilds that one
  // chain and leaves the rest of the mix playing. Returns false when the
  // change needs a full restart instead: a send to a bus that was idle, or a
  // look-ahead plugin appearing or going.
  function syncFx(project) {
    if (!playing) return true;
    var G = playing.G;
    playing.project = project;
    var t = playing.from + Math.max(0, ctx.currentTime - playing.t0);
    var restart = false;
    project.buses.forEach(function (b) { if (busUsed(project, b.id) !== !!G.buses[b.id]) restart = true; });
    if (restart) { replay(); return false; }
    var owners = [['master', project.master]].concat(project.tracks.map(function (x) { return [x.id, x]; }), project.buses.map(function (b) { return [b.id, b]; }));
    for (var i = 0; i < owners.length; i++) {
      var key = owners[i][0], owner = owners[i][1], o = G.owners[key];
      if (!o) continue;
      var sg = chainSig(owner.fx);
      if (sg !== o.sig) {
        var before = chainLatency(o.list);
        var list = buildChain(ctx, owner, owner.fx, G.env, t);
        if (Math.abs(chainLatency(list) - before) > 1e-7) { list.forEach(function (x) { x.dispose(); }); replay(); return false; }
        unwire(o.pre, o.list, o.post);
        try { if (o.list.length) o.list[o.list.length - 1].out.disconnect(); } catch (e) {}
        wire(o.pre, list, o.post);
        o.list = list; o.sig = sg;
        probes = {};
        continue;
      }
      o.list.forEach(function (inst) {
        var slot = slotOf(owner, inst.id);
        if (!slot) return;
        var js = JSON.stringify(slot.params) + JSON.stringify(owner.auto || {});
        if (js === inst.slotJson) return;
        inst.slotJson = js;
        inst.set(slotParams(owner, slot, t));
      });
    }
    G.fxLanes = fxLanes(project, G);
    if (G.fxLanes.length && !ticker) {
      ticker = setInterval(function () { if (playing) applyFxLanes(playing.G, playing.from + Math.max(0, ctx.currentTime - playing.t0)); }, 25);
    }
    return true;
  }

  // Levels, gain reduction and spectrum for one plugin while it plays. The
  // analysers are only attached to the plugin being looked at.
  var probes = {};
  function findInst(fxId) {
    if (!playing) return null;
    var O = playing.G.owners;
    for (var k in O) for (var i = 0; i < O[k].list.length; i++) if (O[k].list[i].id === fxId) return O[k].list[i];
    return null;
  }
  function analyser(node, size) {
    var a = ctx.createAnalyser();
    a.fftSize = size || 2048;
    a.smoothingTimeConstant = 0.75;
    node.connect(a);
    return a;
  }
  function probe(fxId) {
    var inst = findInst(fxId);
    if (!inst) return null;
    var pr = probes[fxId];
    if (!pr || pr.inst !== inst) pr = probes[fxId] = { inst: inst, a: analyser(inst.in, 1024), b: analyser(inst.out, 4096) };
    return {
      inPeak: peakOf(pr.a), outPeak: peakOf(pr.b), gr: inst.meter(), note: inst.note,
      bands: inst.core && inst.core.bands ? inst.core.bands() : null,
      spectrum: function (arr) { pr.b.getFloatFrequencyData(arr); return arr; },
      bins: pr.b.frequencyBinCount, sampleRate: ctx.sampleRate
    };
  }
  function trackPeak(key) {
    if (!playing) return 0;
    var G = playing.G, node = key === 'master' ? G.masterVol : G.tracks[key] ? G.tracks[key].out : G.buses[key] ? G.buses[key].vol : null;
    if (!node) return 0;
    var pk = 'track:' + key;
    if (!probes[pk] || probes[pk].node !== node) probes[pk] = { node: node, a: analyser(node, 1024) };
    return peakOf(probes[pk].a);
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

  // Notes not yet saved, through an instrument, straight to the speakers:
  // the note editor's Play. Returns the context time they start at.
  var preview = [];
  function previewNotes(notes, inst) {
    ensureCtx();
    stopPreview();
    var S = global.ASEditSynth, t = ctx.currentTime + 0.05, g = ctx.createGain();
    g.gain.value = Math.SQRT1_2;
    g.connect(master);
    notes.forEach(function (n) { S.note(ctx, g, inst, n.midi, t + n.start, n.duration, n.velocity, preview); });
    preview.gain = g;
    return t;
  }
  function stopPreview() {
    preview.forEach(function (n) { try { n.stop(); } catch (e) {} try { n.disconnect(); } catch (e) {} });
    if (preview.gain) try { preview.gain.disconnect(); } catch (e) {}
    preview = [];
  }

  /* --------------------------------------------------------------- export */

  // How long the effects keep ringing after the last clip stops.
  function tailOf(project, noMaster) {
    M.normalize(project);
    var t = 0;
    function chain(fx) { return (fx || []).reduce(function (s, x) { return s + D.tailOf(x, project.bpm); }, 0); }
    project.tracks.forEach(function (tr) { t = Math.max(t, chain(tr.fx)); });
    project.buses.forEach(function (b) { if (busUsed(project, b.id)) t = Math.max(t, chain(b.fx)); });
    return Math.min(60, t + (noMaster ? 0 : chain(project.master.fx)));
  }

  // opts: sampleRate, channels, protect (turn a clipping mix down to -1 dBFS),
  // tails (render past t1 until the effects have died away), noMaster (stems).
  function render(project, t0, t1, opts) {
    opts = opts || {};
    project = M.normalize(M.copy(project));
    var sr = opts.sampleRate || 44100;
    var ch = opts.channels || 2;
    var extra = opts.tails ? tailOf(project, opts.noMaster) : 0;
    // Room for the look-ahead too, which is trimmed off the front afterwards.
    var pad = 0.05;
    var len = Math.max(1, Math.ceil((t1 - t0 + extra + pad) * sr));
    var off = new Octx(ch, len, sr);
    return D.ensureWorklet(off).then(function () {
      var bus = off.createGain();
      bus.connect(off.destination);
      var G = build(off, bus, project, t0, t1, 0, { noMaster: opts.noMaster });
      // Work to do partway through, at render-quantum boundaries: one
      // suspend per time, since a second one at the same time throws.
      var at = {}, span = t1 - t0 + extra;
      function every(stepT, fn) {
        for (var x = stepT; x < span; x += stepT) {
          var q = Math.round(x * sr / 128) * 128 / sr;
          if (q <= 0 || q >= len / sr) continue;
          (at[q] = at[q] || []).push(fn);
        }
      }
      // Step plugin automation; build MIDI notes two seconds ahead.
      if (G.fxLanes.length) every(0.025, function (tq) { applyFxLanes(G, t0 + tq); });
      if (G.midi && G.midi.length) { feedMidi(G, 2); every(1, function (tq) { feedMidi(G, tq + 2); }); }
      Object.keys(at).forEach(function (k) {
        var tq = +k;
        off.suspend(tq).then(function () { at[k].forEach(function (fn) { fn(tq); }); off.resume(); });
      });
      return off.startRendering().then(function (out) { return finish(out, G.latency, t1 - t0, !!opts.tails); });
    }).then(function (out) {
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

  // Trim the look-ahead off the front, and either cut to the exact length or,
  // with tails, to where the sound has died below -90 dBFS.
  function finish(out, latency, dur, tails) {
    var sr = out.sampleRate, skip = Math.round((latency || 0) * sr);
    var want = Math.round(dur * sr), total = out.length - skip;
    var n = Math.min(total, want);
    if (tails) {
      var floor = Math.pow(10, -90 / 20), last = want;
      for (var c = 0; c < out.numberOfChannels; c++) {
        var d = out.getChannelData(c);
        for (var i = out.length - 1; i >= skip + want; i--) { if (d[i] > floor || d[i] < -floor) { if (i - skip + 1 > last) last = i - skip + 1; break; } }
      }
      n = Math.min(total, last + Math.round(0.02 * sr));
    }
    n = Math.max(1, n);
    var res = new AudioBuffer({ numberOfChannels: out.numberOfChannels, length: n, sampleRate: sr });
    for (var c2 = 0; c2 < out.numberOfChannels; c2++) res.copyToChannel(out.getChannelData(c2).subarray(skip, skip + n), c2);
    return res;
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
    return mapTime(ctxTime, true);
  }

  function now() { return ctx ? ctx.currentTime : 0; }
  function sampleRate() { ensureCtx(); return ctx.sampleRate; }
  function createBuffer(ch, len, sr) { ensureCtx(); return ctx.createBuffer(ch, len, sr); }

  global.ASEditEngine = {
    buffers: buffers,
    unlock: unlock,
    previewNotes: previewNotes, stopPreview: stopPreview,
    play: play, stop: stop, isPlaying: isPlaying, position: position, playEnd: playEnd, playInfo: playInfo,
    setLoop: setLoop, isLooping: isLooping, passes: passes,
    updateTracks: updateTracks, syncFx: syncFx, relane: relane, hold: hold, probe: probe, trackPeak: trackPeak, meter: meter, audition: audition,
    render: render, tailOf: tailOf, setClick: setClick, clickState: clickState,
    startRecording: startRecording, stopRecording: stopRecording, isRecording: isRecording,
    timelineAt: timelineAt, now: now, sampleRate: sampleRate, createBuffer: createBuffer
  };
})(window);
