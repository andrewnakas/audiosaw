/*
 * Browser voice recorder.
 *
 * MediaRecorder captures from the microphone; the result is decoded and
 * re-encoded through the site's normal path so it comes out as MP3 or WAV
 * rather than whatever Opus-in-WebM blob the browser happened to produce.
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
  var adPost = $('#adSlotPost');
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
    var source = audioCtx.createMediaStreamSource(src);
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
    if (controls) controls.style.display = 'none';

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: $('#cleanup').value !== 'raw',
          noiseSuppression: $('#cleanup').value !== 'raw',
          autoGainControl: $('#cleanup').value === 'full'
        }
      });
    } catch (e) {
      // The most common outcome is the visitor declining, which is not an error
      // worth shouting about.
      var denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      CV.setStatus(statusEl, 'error', denied
        ? 'Microphone access was blocked. Allow it in your browser\'s address bar, then press record again.'
        : 'Could not open the microphone. ' + (e.message || e.name || ''));
      return;
    }

    chunks = [];
    var mime = pickMimeType();
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = onRecordingStopped;
    recorder.start();

    startedAt = Date.now();
    timerId = setInterval(tick, 200);
    tick();
    startMeter(stream);

    startBtn.disabled = true;
    stopBtn.disabled = false;
    CV.setStatus(statusEl, 'info', 'Recording. Nothing is being uploaded — this is all happening in the page.');
  });

  stopBtn.addEventListener('click', function () {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  });

  async function onRecordingStopped() {
    clearInterval(timerId);
    stopMeter();
    releaseStream();
    startBtn.disabled = false;
    stopBtn.disabled = true;

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
    if (!recordedBlob) return;
    var fmt = ($('#outFmt').value || 'mp3').toLowerCase();
    var bitrate = parseInt($('#bitrate').value, 10) || 192;

    progressWrap.style.display = '';
    CV.setProgress(progressBar, 5);
    CV.setStatus(statusEl, 'info', 'Encoding…');

    try {
      var stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      var name = 'recording-' + stamp + '.' + fmt;
      // Hand the recorded blob to the normal decode path so it behaves exactly
      // like a dropped file would.
      var asFile = new File([recordedBlob], 'recording.webm', { type: recordedBlob.type });
      var buf = await AudioSaw.decodeToAudioBuffer(asFile);
      CV.setProgress(progressBar, 40);

      var out = await CV.encodeBuffer(buf, fmt, bitrate, function (pct) {
        CV.setProgress(progressBar, 40 + pct * 0.6);
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
      if (adPost) adPost.classList.add('visible');
    } catch (e) {
      CV.setStatus(statusEl, 'error', 'Could not save the recording. ' + (e.message || e));
    } finally {
      CV.setProgress(progressBar, 100);
    }
  });

  if (resetBtn) {
    resetBtn.addEventListener('click', function () {
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      clearInterval(timerId);
      stopMeter();
      releaseStream();
      recordedBlob = null;
      chunks = [];
      resultList.innerHTML = '';
      if (controls) controls.style.display = 'none';
      progressWrap.style.display = 'none';
      timerEl.textContent = '0:00';
      startBtn.disabled = false;
      stopBtn.disabled = true;
      CV.clearStatus(statusEl);
      if (adPost) adPost.classList.remove('visible');
    });
  }

  // Don't leave the microphone open if the visitor navigates away mid-recording.
  window.addEventListener('pagehide', function () {
    if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch (e) { /* ignore */ } }
    releaseStream();
  });
})();
