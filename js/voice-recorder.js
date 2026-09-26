/*
 * Browser voice recorder.
 *
 * Two capture paths:
 *
 *  - Voice (the default): MediaRecorder, with the browser's echo cancellation
 *    and noise suppression. The result is decoded and re-encoded through the
 *    site's normal path so it comes out as MP3, WAV or FLAC rather than
 *    whatever Opus-in-WebM blob the browser happened to produce. That is two
 *    lossy steps for an MP3, which is fine for speech.
 *  - Studio: no MediaRecorder at all. An AudioWorklet copies the raw samples
 *    as 32-bit float, stereo, with all processing off, in an AudioContext
 *    opened at the microphone's own rate so nothing is resampled. The buffer
 *    goes straight to the encoder, so a WAV or FLAC is exactly what the
 *    microphone delivered.
 *
 * The privacy claim is the whole point of this one. The audio goes from the
 * microphone into a MediaRecorder in the page and then into an encoder in the
 * page. There is no upload, no server, no account. Every other online voice
 * recorder streams to a backend.
 *
 * Notes on the platform:
 *  - getUserMedia requires a secure context; on HTTPS or localhost only.
 *  - Safari produces MP4/AAC rather than WebM/Opus, so the container is picked
 *    from what the browser reports it can record.
 *  - The permission prompt is the browser's own, and is only triggered when the
 *    visitor presses record.
 */
(function () {
  'use strict';

  var $ = CV.$;
  var startBtn = $('#recordBtn');
  var stopBtn = $('#stopBtn');
  var resetBtn = $('#resetBtn');
  var statusEl = $('#status');
  var timerEl = $('#timer');
  var meterBar = $('#meterBar');
  var resultList = $('#resultList');
  var controls = $('#controls');
  var progressWrap = $('#progressWrap');
  var progressBar = $('#progressBar');
  var unsupported = $('#unsupported');

  if (!startBtn) return;

  var supported = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  if (!supported) {
    if (unsupported) unsupported.style.display = '';
    startBtn.disabled = true;
    return;
  }

  var stream = null;
  var recorder = null;
  var chunks = [];
  var startedAt = 0;
  var timerId = null;
  var audioCtx = null;
  var analyser = null;
  var meterId = null;
  var recordedBlob = null;
  var recordedBuf = null;     // studio mode: the float samples themselves
  var studio = null;          // { node, src, sink, chunks }
  var delivered = null;

  var qualitySel = $('#cleanup');
  var devSel = $('#inputDev');
  var noteEl = $('#recNote');
  CV.remember(qualitySel, 'vr_quality');
  CV.remember(devSel, 'vr_input');

  // Input names are hidden until the page has microphone permission, so the
  // list is filled now (maybe unnamed) and again after the first recording.
  function listInputs() {
    if (!devSel || !navigator.mediaDevices.enumerateDevices) return;
    navigator.mediaDevices.enumerateDevices().then(function (devs) {
      var keep = devSel.value;
      var ins = devs.filter(function (d) { return d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications'; });
      devSel.innerHTML = '<option value="">The default input</option>';
      ins.forEach(function (d, i) {
        var o = document.createElement('option');
        o.value = d.deviceId; o.textContent = d.label || 'Input ' + (i + 1);
        devSel.appendChild(o);
      });
      var saved = keep;
      try { saved = keep || localStorage.getItem('as_pref:vr_input') || ''; } catch (e) {}
      if (ins.some(function (d) { return d.deviceId === saved; })) devSel.value = saved;
    }).catch(function () {});
  }
  listInputs();

  function isStudio() { return qualitySel && qualitySel.value === 'studio'; }
  function describe(d) {
    if (!d) return '';
    return (d.label ? '“' + d.label + '”: ' : '') + (d.channels === 1 ? 'mono' : d.channels === 2 ? 'stereo' : 'stereo') +
      ' at ' + (d.sampleRate / 1000) + ' kHz, ' + (d.processing ? 'with the browser’s voice processing' : 'no processing') +
      (d.studio ? ', 32-bit float' : ', compressed while recording');
  }
  function syncNote() {
    if (!noteEl) return;
    noteEl.textContent = isStudio()
      ? 'Studio: raw samples, stereo if your input has two channels, at its own sample rate. Save as WAV or FLAC to keep every bit.'
      : 'Voice: cleans up speech; the browser compresses it while recording.';
  }
  if (qualitySel) qualitySel.addEventListener('change', syncNote);
  syncNote();

  // Copies the input's samples out in blocks of 4096 frames, as the editor's
  // recorder does.
  var WORKLET = [
    'class VRRec extends AudioWorkletProcessor {',
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
    'registerProcessor("vr-rec", VRRec);'
  ].join('\n');

  function micConstraints() {
    var s = isStudio();
    var a = {
      echoCancellation: !s,
      noiseSuppression: !s,
      autoGainControl: qualitySel && qualitySel.value === 'full'
    };
    // Asked for explicitly: left to itself Chrome opens a mono track.
    if (s) { a.channelCount = { ideal: 2 }; a.sampleSize = { ideal: 24 }; }
    if (devSel && devSel.value) a.deviceId = { exact: devSel.value };
    return { audio: a };
  }

  function readDelivered(st, studioMode, rate) {
    var set = {}, label = '';
    try { var tr = st.getAudioTracks()[0]; set = tr.getSettings() || {}; label = tr.label || ''; } catch (e) {}
    return {
      label: label, channels: set.channelCount || null, sampleRate: rate || set.sampleRate || 0, studio: studioMode,
      processing: !!(set.echoCancellation || set.noiseSuppression || set.autoGainControl)
    };
  }

  // Studio capture. Resolves once samples are flowing.
  function startStudio(st) {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    var rate = 0;
    try { rate = st.getAudioTracks()[0].getSettings().sampleRate || 0; } catch (e) {}
    // At the microphone's own rate, so the browser does not convert it.
    try { audioCtx = rate ? new Ctx({ sampleRate: rate }) : new Ctx(); } catch (e) { audioCtx = new Ctx(); }
    var url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    return audioCtx.audioWorklet.addModule(url).then(function () {
      return audioCtx.resume();
    }).then(function () {
      var src = audioCtx.createMediaStreamSource(st);
      var node = new AudioWorkletNode(audioCtx, 'vr-rec', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit' });
      var sink = audioCtx.createGain();
      sink.gain.value = 0;
      var chunksF = [];
      node.port.onmessage = function (e) { if (e.data !== 'done') chunksF.push(e.data); else if (studio && studio.done) studio.done(); };
      src.connect(node); node.connect(sink); sink.connect(audioCtx.destination);
      studio = { node: node, src: src, sink: sink, chunks: chunksF };
      startMeterOn(src);
      return readDelivered(st, true, audioCtx.sampleRate);
    });
  }

  function stopStudio() {
    var s = studio;
    studio = null;
    if (!s) return Promise.resolve(null);
    return new Promise(function (res) {
      s.done = res;
      s.node.port.postMessage('stop');
      setTimeout(res, 400);
    }).then(function () {
      try { s.src.disconnect(); s.node.disconnect(); s.sink.disconnect(); } catch (e) {}
      var total = 0;
      s.chunks.forEach(function (ch) { total += ch[0].length; });
      if (!total) return null;
      // Two identical channels are a mono microphone on a stereo input: keep one.
      var mono = delivered && delivered.channels === 1;
      if (!mono) {
        mono = true;
        for (var i = 0; i < s.chunks.length && mono; i += 3) {
          var a = s.chunks[i][0], b = s.chunks[i][1];
          for (var j = 0; j < a.length; j += 17) if (a[j] !== b[j]) { mono = false; break; }
        }
      }
      var nch = mono ? 1 : 2, chans = [];
      for (var c = 0; c < nch; c++) {
        var d = new Float32Array(total), pos = 0;
        s.chunks.forEach(function (ch) { d.set(ch[c], pos); pos += ch[c].length; });
        chans.push(d);
      }
      var buf = AudioSaw.makeBuffer(chans, audioCtx.sampleRate);
      // "Match the source" on a float capture means float WAV, 24-bit FLAC.
      buf.srcInfo = { container: 'capture', codec: 'float', sampleRate: buf.sampleRate, channels: nch, bits: 32, float: true, lossless: true };
      return buf;
    });
  }

  function pickMimeType() {
    var candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg;codecs=opus'
    ];
    for (var i = 0; i < candidates.length; i++) {
      if (MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return '';
  }

  function fmtTime(ms) {
    var total = Math.floor(ms / 1000);
    var m = Math.floor(total / 60);
    var s = total % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function tick() {
    timerEl.textContent = fmtTime(Date.now() - startedAt);
  }

  function startMeter(src) {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
    startMeterOn(audioCtx.createMediaStreamSource(src));
  }

  function startMeterOn(source) {
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    var data = new Uint8Array(analyser.fftSize);

    (function loop() {
      meterId = requestAnimationFrame(loop);
      analyser.getByteTimeDomainData(data);
      var peak = 0;
      for (var i = 0; i < data.length; i++) {
        var v = Math.abs(data[i] - 128) / 128;
        if (v > peak) peak = v;
      }
      // A little headroom compression so quiet speech still moves the bar.
      meterBar.style.width = Math.min(100, Math.pow(peak, 0.6) * 100) + '%';
      meterBar.classList.toggle('hot', peak > 0.95);
    })();
  }

  function stopMeter() {
    if (meterId) cancelAnimationFrame(meterId);
    meterId = null;
    if (audioCtx) { try { audioCtx.close(); } catch (e) { /* already closed */ } }
    audioCtx = null;
    if (meterBar) { meterBar.style.width = '0%'; meterBar.classList.remove('hot'); }
  }

  function releaseStream() {
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
  }

  startBtn.addEventListener('click', async function () {
    CV.clearStatus(statusEl);
    resultList.innerHTML = '';
    recordedBlob = null;
    recordedBuf = null;
    delivered = null;
    if (controls) controls.style.display = 'none';

    try {
      try {
        stream = await navigator.mediaDevices.getUserMedia(micConstraints());
      } catch (e1) {
        // An input chosen earlier and since unplugged: use the default.
        if (!(devSel && devSel.value && e1 && (e1.name === 'OverconstrainedError' || e1.name === 'NotFoundError'))) throw e1;
        devSel.value = '';
        stream = await navigator.mediaDevices.getUserMedia(micConstraints());
      }
    } catch (e) {
      // The most common outcome is the visitor declining, which is not an error
      // worth shouting about.
      var denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      CV.setStatus(statusEl, 'error', denied
        ? 'Microphone access was blocked. Allow it in your browser\'s address bar, then press record again.'
        : 'Could not open the microphone. ' + (e.message || e.name || ''));
      return;
    }

    listInputs();
    if (isStudio()) {
      try {
        delivered = await startStudio(stream);
      } catch (e) {
        releaseStream(); stopMeter();
        CV.setStatus(statusEl, 'error', 'Could not start studio recording in this browser. ' + (e.message || '') + ' Voice mode still works.');
        return;
      }
    } else {
      chunks = [];
      var mime = pickMimeType();
      var ropts = { audioBitsPerSecond: 256000 };
      if (mime) ropts.mimeType = mime;
      try { recorder = new MediaRecorder(stream, ropts); } catch (e) { recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); }
      recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.onstop = onRecordingStopped;
      recorder.start();
      startMeter(stream);
      delivered = readDelivered(stream, false, 0);
    }

    startedAt = Date.now();
    timerId = setInterval(tick, 200);
    tick();

    startBtn.disabled = true;
    stopBtn.disabled = false;
    if (qualitySel) qualitySel.disabled = true;
    if (devSel) devSel.disabled = true;
    CV.setStatus(statusEl, 'info', 'Recording ' + describe(delivered) + '. Nothing is being uploaded; this is all happening in the page.');
  });

  stopBtn.addEventListener('click', function () {
    if (studio) { onStudioStopped(); return; }
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  });

  function afterStop() {
    clearInterval(timerId);
    startBtn.disabled = false;
    stopBtn.disabled = true;
    if (qualitySel) qualitySel.disabled = false;
    if (devSel) devSel.disabled = false;
  }

  async function onStudioStopped() {
    stopBtn.disabled = true;
    var buf = await stopStudio();
    afterStop();
    stopMeter();
    releaseStream();
    if (!buf) { CV.setStatus(statusEl, 'error', 'Nothing was recorded.'); return; }
    recordedBuf = buf;
    if (CV.signal) CV.signal.input(AudioSaw.describeFormat(buf.srcInfo) + (delivered && delivered.label ? ' · ' + delivered.label : ''));
    if (controls) controls.style.display = '';
    CV.setStatus(statusEl, 'info', 'Recorded ' + fmtTime(buf.duration * 1000) + ', ' + (buf.numberOfChannels === 1 ? 'mono' : 'stereo') +
      ' at ' + (buf.sampleRate / 1000) + ' kHz, 32-bit float' +
      (buf.numberOfChannels === 1 && delivered && delivered.channels !== 1 ? ' (both input channels were identical, so it is kept as mono)' : '') +
      '. Choose a format and save it.');
  }

  async function onRecordingStopped() {
    afterStop();
    stopMeter();
    releaseStream();

    var raw = new Blob(chunks, { type: chunks[0] ? chunks[0].type : 'audio/webm' });
    if (!raw.size) {
      CV.setStatus(statusEl, 'error', 'Nothing was recorded.');
      return;
    }
    recordedBlob = raw;
    if (controls) controls.style.display = '';
    CV.setStatus(statusEl, 'info', 'Recorded ' + fmtTime(Date.now() - startedAt) + '. Choose a format and save it.');
  }

  $('#saveBtn').addEventListener('click', async function () {
    if (!recordedBlob && !recordedBuf) return;
    var fmt = ($('#outFmt').value || 'mp3').toLowerCase();
    var bitrate = $('#bitrate').value;

    progressWrap.style.display = '';
    CV.setProgress(progressBar, 5);
    CV.setStatus(statusEl, 'info', 'Encoding…');

    try {
      var stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      var name = 'recording-' + stamp + '.' + AudioSaw.extFor(fmt);
      // Hand the recorded blob to the normal decode path so it behaves exactly
      // like a dropped file would.
      var buf = recordedBuf;
      if (!buf) {
        var asFile = new File([recordedBlob], 'recording.webm', { type: recordedBlob.type });
        buf = await AudioSaw.decodeToAudioBuffer(asFile);
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
      btn.onclick = function () { CV.downloadBlob(out, name); };
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
      if (recorder && recorder.state !== 'inactive') { recorder.onstop = null; recorder.stop(); }
      if (studio) { try { studio.node.port.postMessage('stop'); } catch (e) {} studio = null; }
      afterStop();
      stopMeter();
      releaseStream();
      recordedBlob = null;
      recordedBuf = null;
      chunks = [];
      resultList.innerHTML = '';
      if (controls) controls.style.display = 'none';
      progressWrap.style.display = 'none';
      timerEl.textContent = '0:00';
      startBtn.disabled = false;
      stopBtn.disabled = true;
      CV.clearStatus(statusEl);
    });
  }

  // Don't leave the microphone open if the visitor navigates away mid-recording.
  window.addEventListener('pagehide', function () {
    if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch (e) { /* ignore */ } }
    releaseStream();
  });
})();
