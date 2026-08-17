/*
 * Vocal / instrumental separation page controller.
 *
 * Decodes the dropped file, resamples to the 44.1 kHz the model expects, hands
 * the channels to the inference worker, then encodes what comes back.
 */
(function () {
  'use strict';

  var $ = CV.$;
  var SR = 44100;
  var MAX_SECONDS = 600;

  var dropzone = $('#dropzone');
  var fileInput = $('#fileInput');
  var fileList = $('#fileList');
  var controls = $('#controls');
  var goBtn = $('#convertBtn');
  var resetBtn = $('#resetBtn');
  var statusEl = $('#status');
  var progressWrap = $('#progressWrap');
  var progressBar = $('#progressBar');
  var resultList = $('#resultList');
  var adPost = $('#adSlotPost');
  var envEl = $('#envNote');

  if (!dropzone) return;

  var files = [];
  var worker = null;
  var startedAt = 0;
  var warmed = false;

  /* --------------------------------------------------------- capabilities */

  var costPerSecond = null;   // measured wall-clock seconds per second of audio
  var trackSeconds = null;

  function fmtDuration(s) {
    if (s < 90) return Math.round(s) + ' seconds';
    if (s < 3600) return Math.round(s / 60) + ' minutes';
    return (s / 3600).toFixed(1) + ' hours';
  }

  function describeEnvironment(info) {
    if (!envEl) return;

    if (info) {
      costPerSecond = info.costPerSecond;
      envEl.className = 'control-note' + (info.backend === 'webgpu' ? '' : ' warn-note');
    }

    var parts = [];
    if (!info) {
      parts.push(navigator.gpu
        ? 'WebGPU available — should run at about the length of the track.'
        : 'No WebGPU in this browser, so this will run on the CPU and take a lot longer.');
    } else if (info.backend === 'webgpu') {
      parts.push('Running on your GPU (WebGPU) — the fast path.');
    } else {
      parts.push('Running on the CPU' +
        (info.threads > 1 ? ' across ' + info.threads + ' threads' : ' on a single thread') + '.');
    }

    // Once both the backend and the track length are known, say plainly how
    // long this is going to take rather than letting someone discover it.
    if (costPerSecond && trackSeconds) {
      var est = trackSeconds * costPerSecond;
      parts.push('Estimated ' + fmtDuration(est) + ' for this track.');
      if (est > 600) {
        parts.push('That is a long wait — consider trimming to the section you need first.');
      }
    }
    envEl.textContent = parts.join(' ');
  }

  // Read the duration from metadata rather than decoding, so the estimate can
  // appear as soon as the file is picked.
  function measureDuration(file) {
    var url = URL.createObjectURL(file);
    var probe = new Audio();
    probe.preload = 'metadata';
    probe.onloadedmetadata = function () {
      if (isFinite(probe.duration)) { trackSeconds = probe.duration; describeEnvironment(null); }
      URL.revokeObjectURL(url);
    };
    probe.onerror = function () { URL.revokeObjectURL(url); };
    probe.src = url;
  }

  /* ------------------------------------------------------------- worker io */

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker('/js/stem-worker.js?v=' + (window.AS_VERSION || '1'));
    worker.onmessage = function (e) {
      var m = e.data || {};
      if (m.type === 'status') onStatus(m);
      else if (m.type === 'ready') describeEnvironment(m);
      else if (m.type === 'done') onDone(m);
      else if (m.type === 'error') onError(m.message);
    };
    worker.onerror = function () {
      onError('The separation worker could not start. Your browser may be blocking it.');
    };
    return worker;
  }

  function onStatus(m) {
    // The model download dominates a first visit, so give it a real share of
    // the bar rather than leaving it pinned at zero.
    var pct = m.phase === 'model' ? m.pct * 0.25
      : m.phase === 'session' ? 25
      : 30 + m.pct * 0.65;
    CV.setProgress(progressBar, pct);
    CV.setStatus(statusEl, 'info', m.detail);
  }

  function onError(message) {
    CV.setStatus(statusEl, 'error', 'Separation failed. ' + message);
    goBtn.disabled = files.length === 0;
    resetBtn.disabled = false;
    CV.setProgress(progressBar, 100);
  }

  /* -------------------------------------------------------------- decoding */

  async function decodeTo441(file) {
    CV.setStatus(statusEl, 'info', 'Decoding…');
    var buf = await AudioSaw.decodeToAudioBuffer(file);
    if (buf.duration > MAX_SECONDS) {
      throw new Error('That track is ' + Math.round(buf.duration / 60) + ' minutes long. ' +
        'Both stems are held in memory at once, so past ' + Math.round(MAX_SECONDS / 60) +
        ' minutes the tab runs out of room — split it into parts first.');
    }
    if (buf.sampleRate !== SR) {
      CV.setStatus(statusEl, 'info', 'Resampling to 44.1 kHz…');
      buf = await AudioSaw.resampleBuffer(buf, SR);
    }
    var l = buf.getChannelData(0);
    var r = buf.numberOfChannels > 1 ? buf.getChannelData(1) : l;
    return { left: Float32Array.from(l), right: Float32Array.from(r) };
  }

  /* ------------------------------------------------------------- rendering */

  async function onDone(m) {
    var opts = readOpts();
    var wanted = [];
    if (opts.instrumental) wanted.push({ key: 'instrumental', ch: m.instrumental });
    if (opts.acapella) wanted.push({ key: 'acapella', ch: m.vocals });
    if (!wanted.length) wanted.push({ key: 'instrumental', ch: m.instrumental });

    var base = (files[0] ? files[0].name : 'audio').replace(/\.[^.]+$/, '');
    var outputs = [];

    for (var i = 0; i < wanted.length; i++) {
      var w = wanted[i];
      CV.setStatus(statusEl, 'info', 'Encoding the ' + w.key + '…');
      CV.setProgress(progressBar, 95 + (i / wanted.length) * 5);
      var buffer = CV.bufferFrom([w.ch[0], w.ch[1]], m.sampleRate);
      var blob = await CV.encodeBuffer(buffer, opts.fmt, opts.bitrate);
      outputs.push({ name: base + '-' + w.key + '.' + opts.fmt, blob: blob });
    }

    var mins = ((Date.now() - startedAt) / 60000);
    var took = mins < 1 ? Math.round(mins * 60) + ' s' : mins.toFixed(1) + ' min';

    if (outputs.length === 1) {
      CV.downloadBlob(outputs[0].blob, outputs[0].name);
      CV.setStatus(statusEl, 'success', 'Done in ' + took + ' — ' + outputs[0].name);
    } else {
      var zip = await AudioSaw.zipBlobs(outputs);
      CV.downloadBlob(zip, base + '-separated.zip');
      CV.setStatus(statusEl, 'success', 'Done in ' + took + ' — ' + outputs.length + ' files zipped');
    }

    resultList.innerHTML = '';
    outputs.forEach(function (o) {
      var wrap = document.createElement('div');
      wrap.className = 'stem-row';

      var row = document.createElement('div');
      row.className = 'file-item';
      var label = document.createElement('span');
      var nm = document.createElement('span'); nm.className = 'name'; nm.textContent = o.name;
      var sz = document.createElement('span'); sz.className = 'size'; sz.textContent = CV.fmtBytes(o.blob.size);
      label.appendChild(nm); label.appendChild(sz);
      row.appendChild(label);
      var btn = document.createElement('button');
      btn.className = 'btn btn-small'; btn.textContent = 'download';
      btn.onclick = function () { CV.downloadBlob(o.blob, o.name); };
      row.appendChild(btn);

      var play = document.createElement('audio');
      play.controls = true; play.preload = 'none';
      play.src = URL.createObjectURL(o.blob);
      play.className = 'stem-preview';

      wrap.appendChild(row);
      wrap.appendChild(play);
      resultList.appendChild(wrap);
    });

    if (adPost) adPost.classList.add('visible');
    goBtn.disabled = files.length === 0;
    resetBtn.disabled = false;
    CV.setProgress(progressBar, 100);
  }

  /* ------------------------------------------------------------------- ui */

  function readOpts() {
    return {
      instrumental: $('#wantInstrumental').checked,
      acapella: $('#wantAcapella').checked,
      fmt: ($('#outFmt').value || 'mp3').toLowerCase(),
      bitrate: parseInt($('#bitrate').value, 10) || 320
    };
  }

  function onFiles(picked) {
    if (!picked || !picked.length) return;
    files = picked.slice(0, 1);
    fileList.style.display = '';
    controls.style.display = '';
    goBtn.disabled = false;
    CV.renderFileList(fileList, files, function () { reset(); });
    measureDuration(files[0]);
    // Start pulling the model down while they pick options.
    if (!warmed) { warmed = true; try { ensureWorker().postMessage({ type: 'warmup' }); } catch (e) {} }
  }

  function reset() {
    files = [];
    fileList.innerHTML = '';
    controls.style.display = 'none';
    goBtn.disabled = true;
    CV.clearStatus(statusEl);
    progressWrap.style.display = 'none';
    CV.setProgress(progressBar, 0);
    resultList.innerHTML = '';
    if (adPost) adPost.classList.remove('visible');
  }

  CV.bindDropzone(dropzone, fileInput, onFiles, null);
  if (resetBtn) resetBtn.addEventListener('click', reset);

  goBtn.addEventListener('click', async function () {
    if (!files.length) return;
    goBtn.disabled = true;
    resetBtn.disabled = true;
    progressWrap.style.display = '';
    CV.setProgress(progressBar, 0);
    resultList.innerHTML = '';
    startedAt = Date.now();
    try {
      var audio = await decodeTo441(files[0]);
      ensureWorker().postMessage({ type: 'separate', left: audio.left, right: audio.right },
        [audio.left.buffer, audio.right.buffer]);
    } catch (e) {
      onError(e.message || String(e));
    }
  });

  describeEnvironment(null);
})();
