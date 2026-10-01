/*
 * /record-computer-audio: record what a browser tab (or, where the platform
 * allows it, the whole computer) is playing.
 *
 * The capture comes from getDisplayMedia. It has to ask for video, because
 * the API has no audio-only form, so the video track is stopped the moment
 * the share is granted: nothing of the picture is kept or even looked at.
 *
 * The audio is taken the way /voice-recorder's studio mode takes a
 * microphone: an AudioWorklet copies the samples out as 32-bit float, stereo,
 * in an AudioContext opened at the track's own rate, and the buffer goes
 * straight to the encoder. "Match the source" is then a float WAV or a 24-bit
 * FLAC. MediaRecorder is only the fallback for a browser with no worklet.
 *
 * The constraints matter more than they look. Asked for with `audio: true`,
 * Chrome hands tab audio over as if it were a phone call: mono, 48 kHz, with
 * echo cancellation, noise suppression and auto gain on. Measured in
 * tools/check-record-computer.js, a 0.5 sine came through peaking anywhere
 * from 0.05 to 0.3 as the gain control worked on it. With all three off and
 * two channels asked for it arrives stereo, and every sample is within
 * 1.5e-7 (-136 dB, float rounding) of what the tab played.
 *
 * Chrome moves the focus to a tab when sharing it starts, so while it records
 * this page is usually hidden: no meter frames, and a timer held to about
 * once a second. The worklet is on the audio thread and is not slowed.
 *
 * Only Chromium browsers return an audio track from a share at all. Firefox
 * and Safari share screens and windows but never their sound, so the page
 * says so up front, and again if a share comes back without audio.
 */
(function () {
  'use strict';

  var CV = window.CV;
  if (!CV || !window.AudioSaw) { console.error('record-computer-page: CV or AudioSaw missing — /js includes must come first'); return; }

  var $ = CV.$;
  var startBtn = $('#recordBtn');
  var stopBtn = $('#stopBtn');
  var resetBtn = $('#resetBtn');
  var statusEl = $('#status');
  var timerEl = $('#timer');
  var sizeEl = $('#recSize');
  var meterBar = $('#meterBar');
  var resultList = $('#resultList');
  var controls = $('#controls');
  var progressWrap = $('#progressWrap');
  var progressBar = $('#progressBar');
  var browserNote = $('#browserNote');
  var noteEl = $('#recNote');
  if (!startBtn) return;

  /* ----------------------------------------------------------- the browser */

  var ua = navigator.userAgent || '';
  var uad = navigator.userAgentData;
  var brands = (uad && uad.brands) || [];
  var chromium = brands.some(function (b) { return /Chromium|Google Chrome|Microsoft Edge/.test(b.brand); }) ||
    (/Chrome\/|CriOS\/|Edg\//.test(ua) && !/Firefox\//.test(ua));
  var firefox = /Firefox\/|FxiOS\//.test(ua);
  var mobile = (uad && uad.mobile) || /Android|iPhone|iPad|iPod|Mobile/.test(ua);
  var mac = /mac/i.test((uad && uad.platform) || navigator.platform || ua) && !mobile;
  var win = /win/i.test((uad && uad.platform) || navigator.platform || ua);
  var hasCapture = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);

  function banner(kind, text) {
    if (!browserNote) return;
    browserNote.textContent = text;
    browserNote.className = 'status ' + kind;
  }

  if (!hasCapture) {
    banner('warn', 'This browser does not let web pages capture a tab or the screen, so there is nothing to record here. ' +
      'Open this page in Chrome or Edge on a desktop or laptop computer.');
    startBtn.disabled = true;
    return;
  }
  if (firefox) {
    banner('warn', 'Firefox can share a screen or a window with a page, but never its sound, so this page cannot record anything in Firefox. ' +
      'Open it in Chrome or Edge instead.');
  } else if (!chromium) {
    banner('warn', 'Safari can share a screen or a window with a page, but never its sound, so this page cannot record anything in Safari. ' +
      'Open it in Chrome or Edge instead.');
  } else if (mobile) {
    banner('warn', 'Tab audio capture is a desktop feature. On a phone or tablet the share usually comes back without sound.');
  }

  function setNote() {
    if (!noteEl) return;
    noteEl.textContent = mac
      ? 'On a Mac, choose a tab in the picker and leave “Also share tab audio” switched on. Tab audio is the share that is known to work on macOS.'
      : win
        ? 'Choose a tab and leave “Also share tab audio” on, or choose Entire screen and switch on “Also share system audio” to record everything the computer plays.'
        : 'Choose a tab in the picker and leave “Also share tab audio” switched on.';
  }
  setNote();

  /* ----------------------------------------------------------- the capture */

  var stream = null;          // the audio-only stream we keep
  var track = null;
  var audioCtx = null;
  var analyser = null;
  var meterId = null;
  var timerId = null;
  var startedAt = 0;
  var cap = null;             // { node, src, sink, chunks, frames, done }
  var recorder = null;        // MediaRecorder fallback
  var mrChunks = [];
  var recordedBuf = null;
  var recordedBlob = null;
  var source = null;          // { kind: 'tab'|'screen'|'window', label, rate, channels }
  var stopping = false;

  // Copies the input's samples out in blocks of 4096 frames, as
  // voice-recorder.js does.
  var WORKLET = [
    'class RCRec extends AudioWorkletProcessor {',
    '  constructor() { super(); this.buf = null; this.n = 0; this.on = true;',
    '    this.port.onmessage = (e) => { if (e.data === "stop") { this.flush(); this.on = false; this.port.postMessage("done"); } }; }',
    '  flush() { if (this.buf && this.n) this.port.postMessage(this.buf.map((b) => b.slice(0, this.n))); this.buf = null; this.n = 0; }',
    '  process(inputs) {',
    '    const inp = inputs[0];',
    '    if (!this.on) return false;',
    '    if (!inp || !inp.length) return true;',
    '    if (!this.buf) { this.buf = [new Float32Array(4096), new Float32Array(4096)]; this.n = 0; }',
    '    for (let c = 0; c < 2; c++) this.buf[c].set(inp[c] || inp[0], this.n);',
    '    this.n += inp[0].length;',
    '    if (this.n + 128 > 4096) this.flush();',
    '    return true;',
    '  }',
    '}',
    'registerProcessor("rc-rec", RCRec);'
  ].join('\n');

  // No voice processing, two channels. Left to its defaults Chrome treats tab
  // audio as a call (see the header). The video track is only a ticket in.
  function displayOptions() {
    return {
      video: { displaySurface: 'browser' },
      audio: {
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        channelCount: { ideal: 2 }, suppressLocalAudioPlayback: false
      },
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
      preferCurrentTab: false
    };
  }

  function kindOf(surface, label) {
    if (surface === 'browser') return 'tab';
    if (surface === 'monitor') return 'screen';
    if (surface === 'window') return 'window';
    return /tab/i.test(label || '') ? 'tab' : 'screen';
  }
  function sourceName(s) {
    return s.kind === 'tab' ? 'Tab audio' : s.kind === 'window' ? 'Window audio' : 'System audio';
  }

  function noAudioMessage(kind) {
    if (firefox || !chromium) return 'The share came back without any sound, which is what this browser always does. Open this page in Chrome or Edge to record audio.';
    if (kind === 'tab') return 'That tab was shared without its sound, so there is nothing to record. Press Record again, pick the tab, and make sure “Also share tab audio” is switched on at the bottom of the picker.';
    if (kind === 'window') return 'A window was shared without its sound. Press Record again and choose the tab that is playing instead, with “Also share tab audio” on: tab audio is the share that works everywhere Chrome and Edge do.';
    if (mac) return 'The screen was shared without sound. On a Mac, share the tab that is playing instead: press Record again, choose it under the tabs, and leave “Also share tab audio” on.';
    return 'The screen was shared without its sound. Press Record again and either switch on “Also share system audio” under Entire screen, or choose the tab that is playing.';
  }

  function startWorklet(st, rate) {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!window.AudioWorkletNode) return Promise.reject(new Error('no AudioWorklet'));
    // At the track's own rate, so the browser does not convert it.
    try { audioCtx = rate ? new Ctx({ sampleRate: rate }) : new Ctx(); } catch (e) { audioCtx = new Ctx(); }
    var url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    return audioCtx.audioWorklet.addModule(url).then(function () {
      return audioCtx.resume();
    }).then(function () {
      var src = audioCtx.createMediaStreamSource(st);
      var node = new AudioWorkletNode(audioCtx, 'rc-rec', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit' });
      // A silent sink keeps the worklet pulled without playing the tab back
      // through this one (which would double it on the speakers).
      var sink = audioCtx.createGain();
      sink.gain.value = 0;
      var c = { node: node, src: src, sink: sink, chunks: [], frames: 0, done: null };
      node.port.onmessage = function (e) {
        if (e.data === 'done') { if (c.done) c.done(); return; }
        c.chunks.push(e.data); c.frames += e.data[0].length;
      };
      src.connect(node); node.connect(sink); sink.connect(audioCtx.destination);
      cap = c;
      startMeterOn(src);
    });
  }

  function finishWorklet() {
    var c = cap;
    cap = null;
    if (!c) return Promise.resolve(null);
    return new Promise(function (res) {
      c.done = res;
      try { c.node.port.postMessage('stop'); } catch (e) { res(); }
      setTimeout(res, 400);
    }).then(function () {
      try { c.src.disconnect(); c.node.disconnect(); c.sink.disconnect(); } catch (e) {}
      var total = 0;
      c.chunks.forEach(function (ch) { total += ch[0].length; });
      if (!total) return null;
      // Two identical channels are a mono source: keep one.
      var mono = true;
      for (var i = 0; i < c.chunks.length && mono; i++) {
        var a = c.chunks[i][0], b = c.chunks[i][1];
        for (var j = 0; j < a.length; j += 7) if (a[j] !== b[j]) { mono = false; break; }
      }
      var nch = mono ? 1 : 2, chans = [];
      for (var k = 0; k < nch; k++) {
        var d = new Float32Array(total), pos = 0;
        c.chunks.forEach(function (ch) { d.set(ch[k], pos); pos += ch[k].length; });
        chans.push(d);
      }
      var buf = AudioSaw.makeBuffer(chans, audioCtx.sampleRate);
      // "Match the source" on a float capture means float WAV, 24-bit FLAC.
      buf.srcInfo = { container: 'capture', codec: 'float', sampleRate: buf.sampleRate, channels: nch, bits: 32, float: true, lossless: true };
      return buf;
    });
  }

  function startRecorder(st) {
    var types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    var mime = '';
    for (var i = 0; i < types.length; i++) if (window.MediaRecorder && MediaRecorder.isTypeSupported(types[i])) { mime = types[i]; break; }
    mrChunks = [];
    var o = { audioBitsPerSecond: 256000 };
    if (mime) o.mimeType = mime;
    recorder = new MediaRecorder(st, o);
    recorder.ondataavailable = function (e) { if (e.data && e.data.size) mrChunks.push(e.data); };
    recorder.start(1000);
    var Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
    startMeterOn(audioCtx.createMediaStreamSource(st));
  }

  function finishRecorder() {
    var r = recorder;
    recorder = null;
    if (!r) return Promise.resolve(null);
    return new Promise(function (res) {
      if (r.state === 'inactive') { res(); return; }
      r.onstop = function () { res(); };
      r.stop();
    }).then(function () {
      var blob = new Blob(mrChunks, { type: mrChunks[0] ? mrChunks[0].type : 'audio/webm' });
      return blob.size ? blob : null;
    });
  }

  /* ------------------------------------------------------- meter and clock */

  function startMeterOn(node) {
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    node.connect(analyser);
    var data = new Float32Array(analyser.fftSize);
    (function loop() {
      meterId = requestAnimationFrame(loop);
      analyser.getFloatTimeDomainData(data);
      var peak = 0;
      for (var i = 0; i < data.length; i++) { var v = Math.abs(data[i]); if (v > peak) peak = v; }
      meterBar.style.width = Math.min(100, Math.pow(peak, 0.6) * 100) + '%';
      meterBar.classList.toggle('hot', peak >= 0.999);
    })();
  }

  function stopMeter() {
    if (meterId) cancelAnimationFrame(meterId);
    meterId = null;
    if (audioCtx) { try { audioCtx.close(); } catch (e) {} }
    audioCtx = null;
    if (meterBar) { meterBar.style.width = '0%'; meterBar.classList.remove('hot'); }
  }

  function fmtTime(sec) {
    var t = Math.floor(sec), h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  function tick() {
    timerEl.textContent = fmtTime((Date.now() - startedAt) / 1000);
    if (sizeEl) {
      sizeEl.textContent = cap
        ? CV.fmtBytes(cap.frames * 2 * 4) + ' held in this tab'
        : recorder ? CV.fmtBytes(mrChunks.reduce(function (n, b) { return n + b.size; }, 0)) + ' held in this tab' : '';
    }
  }

  function release() {
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
    track = null;
  }

  function setIdle() {
    clearInterval(timerId);
    timerId = null;
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }

  /* -------------------------------------------------------------- the flow */

  startBtn.addEventListener('click', async function () {
    CV.clearStatus(statusEl);
    resultList.innerHTML = '';
    recordedBuf = null;
    recordedBlob = null;
    source = null;
    stopping = false;
    if (controls) controls.style.display = 'none';
    progressWrap.style.display = 'none';
    timerEl.textContent = '0:00';
    if (sizeEl) sizeEl.textContent = '';

    var st;
    try {
      st = await navigator.mediaDevices.getDisplayMedia(displayOptions());
    } catch (e) {
      if (e && e.name === 'NotAllowedError') {
        CV.setStatus(statusEl, 'warn', 'The share was cancelled, so nothing is recording. Press Record and pick the tab that is playing.');
      } else {
        CV.setStatus(statusEl, 'error', 'The browser would not start the capture. ' + ((e && (e.message || e.name)) || ''));
      }
      return;
    }

    var v = st.getVideoTracks()[0];
    var surface = '';
    try { surface = (v && v.getSettings().displaySurface) || ''; } catch (e) {}
    var a = st.getAudioTracks()[0];
    // The picture was only the way in; nothing of it is kept.
    st.getVideoTracks().forEach(function (t) { t.stop(); });
    var kind = kindOf(surface, a && a.label);
    if (!a) {
      CV.setStatus(statusEl, 'warn', noAudioMessage(kind));
      return;
    }

    track = a;
    stream = new MediaStream([a]);
    var set = {};
    try { set = a.getSettings() || {}; } catch (e) {}
    source = { kind: kind, label: a.label || '', rate: set.sampleRate || 0, channels: set.channelCount || 0 };
    // "Stop sharing" in the browser's own bar ends the track: keep what was
    // recorded up to then rather than losing it.
    a.addEventListener('ended', function () { if (!stopping) stop(true); });

    var how = 'worklet';
    try {
      await startWorklet(stream, source.rate);
    } catch (e) {
      stopMeter();
      cap = null;
      how = 'recorder';
      try { startRecorder(stream); } catch (e2) {
        release();
        CV.setStatus(statusEl, 'error', 'This browser shared the audio but could not record it. ' + (e2.message || e2.name || ''));
        return;
      }
    }

    startedAt = Date.now();
    timerId = setInterval(tick, 250);
    tick();
    startBtn.disabled = true;
    stopBtn.disabled = false;
    var rate = audioCtx && how === 'worklet' ? audioCtx.sampleRate : source.rate;
    CV.setStatus(statusEl, 'info', 'Recording ' + sourceName(source).toLowerCase() +
      (rate ? ' at ' + (rate / 1000) + ' kHz' : '') +
      (how === 'worklet' ? ', 32-bit float, no processing' : ', compressed while recording (this browser has no AudioWorklet)') +
      '. Play the audio in what you shared, then come back and press Stop, or press “Stop sharing” in the browser’s bar, when it is done.');
  });

  stopBtn.addEventListener('click', function () { stop(false); });

  async function stop(fromBrowser) {
    if (stopping) return;
    stopping = true;
    stopBtn.disabled = true;
    var buf = null, blob = null;
    if (cap) buf = await finishWorklet();
    else if (recorder) blob = await finishRecorder();
    var secs = (Date.now() - startedAt) / 1000;
    setIdle();
    stopMeter();
    release();
    if (!buf && !blob) { CV.setStatus(statusEl, 'warn', 'The share ended before any sound arrived, so there is nothing to save.'); return; }

    var lead = fromBrowser ? 'The share ended from the browser’s side (its “Stop sharing” bar, or the shared tab closing); the recording up to that point is kept. ' : '';
    if (buf) {
      recordedBuf = buf;
      var silent = true;
      for (var c = 0; c < buf.numberOfChannels && silent; c++) {
        var d = buf.getChannelData(c);
        for (var i = 0; i < d.length; i++) if (d[i] !== 0) { silent = false; break; }
      }
      timerEl.textContent = fmtTime(buf.duration);
      if (CV.signal) {
        CV.signal.input([sourceName(source), (buf.sampleRate / 1000) + ' kHz', '32-bit float',
          buf.numberOfChannels === 1 ? 'mono' : 'stereo'].join(' · ') + (source.label && !/^(tab|system) audio$/i.test(source.label) ? ' · ' + source.label : ''));
      }
      if (controls) controls.style.display = '';
      if (silent) {
        CV.setStatus(statusEl, 'warn', lead + 'Recorded ' + fmtTime(buf.duration) + ', but every sample is silent: nothing was playing in what you shared. ' +
          'Check that the sound was playing in the shared tab, then record again.');
        return;
      }
      CV.setStatus(statusEl, 'info', lead + 'Recorded ' + fmtTime(buf.duration) + ', ' + (buf.numberOfChannels === 1 ? 'mono (both channels were identical)' : 'stereo') +
        ' at ' + (buf.sampleRate / 1000) + ' kHz, 32-bit float. Choose a format and save it.');
    } else {
      recordedBlob = blob;
      if (controls) controls.style.display = '';
      CV.setStatus(statusEl, 'info', lead + 'Recorded ' + fmtTime(secs) + '. Choose a format and save it.');
    }
  }

  $('#saveBtn').addEventListener('click', async function () {
    if (!recordedBuf && !recordedBlob) return;
    var fmt = ($('#outFmt').value || 'wav').toLowerCase();
    var bitrate = $('#bitrate').value;
    progressWrap.style.display = '';
    CV.setProgress(progressBar, 5);
    CV.setStatus(statusEl, 'info', 'Encoding…');
    try {
      var stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      var name = (source && source.kind === 'tab' ? 'tab-audio-' : 'computer-audio-') + stamp + '.' + AudioSaw.extFor(fmt);
      var buf = recordedBuf;
      if (!buf) {
        buf = await AudioSaw.decodeToAudioBuffer(new File([recordedBlob], 'capture.webm', { type: recordedBlob.type }));
      }
      CV.setProgress(progressBar, 40);
      var out = await AudioSaw.encode(buf, AudioSaw.resolveFormat(fmt, bitrate), {
        bitrate: AudioSaw.bitrateOf(bitrate), srcInfo: buf.srcInfo,
        onProgress: function (pct) { CV.setProgress(progressBar, 40 + pct * 0.6); }
      });
      CV.downloadBlob(out, name);
      CV.setStatus(statusEl, 'success', 'Done — ' + name);

      var row = document.createElement('div');
      row.className = 'file-item';
      var label = document.createElement('span');
      var nm = document.createElement('span'); nm.className = 'name'; nm.textContent = name;
      var sz = document.createElement('span'); sz.className = 'size'; sz.textContent = CV.fmtBytes(out.size);
      label.appendChild(nm); label.appendChild(sz);
      row.appendChild(label);
      var btn = document.createElement('button');
      btn.className = 'btn btn-small'; btn.textContent = 'download';
      btn.onclick = function () { CV.downloadBlob(out, name, { again: true }); };
      row.appendChild(btn);
      resultList.appendChild(row);
    } catch (e) {
      CV.setStatus(statusEl, 'error', 'Could not save the recording. ' + (e.message || e));
    } finally {
      CV.setProgress(progressBar, 100);
    }
  });

  if (resetBtn) {
    resetBtn.addEventListener('click', function () {
      stopping = true;
      if (recorder) { try { recorder.onstop = null; recorder.stop(); } catch (e) {} recorder = null; }
      if (cap) { try { cap.node.port.postMessage('stop'); } catch (e) {} cap = null; }
      setIdle();
      stopMeter();
      release();
      recordedBuf = null;
      recordedBlob = null;
      resultList.innerHTML = '';
      if (controls) controls.style.display = 'none';
      progressWrap.style.display = 'none';
      timerEl.textContent = '0:00';
      if (sizeEl) sizeEl.textContent = '';
      CV.clearStatus(statusEl);
    });
  }

  // Leaving the page ends the share rather than leaving the tab captured.
  window.addEventListener('pagehide', function () { release(); });
})();
