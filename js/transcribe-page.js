/*
 * /audio-to-text page controller.
 *
 * Decodes the file, folds it to mono, resamples it to the 16 kHz Whisper was
 * trained on (the sinc resampler, not Web Audio), and hands it to
 * transcribe-worker.js. What comes back is a list of timed segments, written
 * out as plain text, SRT or VTT by subtitles.js.
 *
 * The transcript is editable before download: Whisper gets names wrong, and
 * fixing three words in the page is quicker than fixing them in three files.
 * Edits to the text box apply to the .txt download only; subtitles keep their
 * timing and come from the segment list.
 */
(function () {
  'use strict';

  // The worker's ?v= comes from this script's own src, which the release bump
  // rewrites. window.AS_VERSION is not touched by the bump and sat at
  // 2026-09-22 for weeks, pinning the worker to whatever was cached first.
  var ASSET_V = (function () {
    var m = document.currentScript && /[?&]v=([^&]+)/.exec(document.currentScript.src);
    return m ? m[1] : (window.AS_VERSION || '1');
  })();

  if (typeof CV === 'undefined' || typeof AudioSaw === 'undefined' || typeof ASSubs === 'undefined' || typeof ASDiar === 'undefined') {
    console.error('[audio-to-text] the /js/* includes must come before transcribe-page.js');
    return;
  }

  var $ = CV.$;
  var SR = 16000;
  var MAX_SECONDS = 2 * 3600;

  // Measured speed relative to the audio's length, per model and backend, on
  // the reference machine (Apple GPU, 8 cores). Used only for the estimate.
  var COST = {
    'onnx-community/whisper-tiny': { webgpu: 0.06, wasm: 0.12 },
    'onnx-community/whisper-base': { webgpu: 0.16, wasm: 0.29 },
    'onnx-community/whisper-small': { webgpu: 0.4, wasm: 1.0 }
  };

  var dropzone = $('#dropzone');
  var fileInput = $('#fileInput');
  var fileList = $('#fileList');
  var controls = $('#controls');
  var goBtn = $('#convertBtn');
  var resetBtn = $('#resetBtn');
  var statusEl = $('#status');
  var progressWrap = $('#progressWrap');
  var progressBar = $('#progressBar');
  var envEl = $('#envNote');
  var liveEl = $('#liveText');
  var resultEl = $('#result');
  var textEl = $('#transcript');
  var modelSel = $('#model');
  var langSel = $('#language');
  var taskSel = $('#task');
  var tsBox = $('#withTimes');

  if (!dropzone) return;

  var files = [];
  var worker = null;
  var gpuUsable = null;
  var trackSeconds = null;
  var segments = null;
  var duration = 0;
  var downloadedOnce = false;
  var baseTitle = document.title;
  // ?backend=wasm skips the GPU. safeMode is the one automatic retry after a
  // model failed to load for a reason other than the network (see the worker).
  var forceWasm = /[?&]backend=wasm\b/.test(location.search);
  var safeMode = false;

  // Phones get Whisper tiny by default. Base needs a 135 MB download and
  // several times that in memory, and on 1-4 Oct a third of this page's
  // errors were phones running out of it; the FAQ already says tiny is the
  // one that works on a phone. The choice stays in the menu.
  var uad = navigator.userAgentData;
  var mobile = (uad && uad.mobile) || /Android|iPhone|iPad|iPod|Mobile/.test(navigator.userAgent || '');
  if (mobile && modelSel && modelSel.value === 'onnx-community/whisper-base') modelSel.value = 'onnx-community/whisper-tiny';

  /* --------------------------------------------------------- environment */

  function probeGpu() {
    if (!navigator.gpu || forceWasm) { gpuUsable = false; describe(); return; }
    navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
      .then(function (a) { gpuUsable = !!a; describe(); })
      .catch(function () { gpuUsable = false; describe(); });
  }

  function fmtDuration(s) {
    if (s < 90) return Math.round(s) + ' seconds';
    if (s < 3600) return Math.round(s / 60) + ' minutes';
    return (s / 3600).toFixed(1) + ' hours';
  }

  function describe(ready) {
    if (!envEl) return;
    var parts = [];
    var backend = ready ? ready.backend : (gpuUsable ? 'webgpu' : 'wasm');
    if (ready) {
      parts.push(ready.backend === 'webgpu' ? 'Running on your GPU (WebGPU).'
        : 'Running on the CPU' + (ready.threads > 1 ? ' across ' + ready.threads + ' threads.' : ' on one thread.'));
    } else if (gpuUsable === null) parts.push('Checking whether your browser can use the GPU…');
    else if (gpuUsable) parts.push('Your browser can use the GPU, which is the fast path.');
    else parts.push('No usable GPU here, so this runs on the CPU — slower, same words.');
    var cost = COST[modelSel.value] && COST[modelSel.value][backend];
    if (cost && trackSeconds) {
      // Threads are the difference between the measured CPU figure and a
      // much slower one; say so rather than promise the fast number.
      if (backend === 'wasm' && !self.crossOriginIsolated) cost *= 4;
      parts.push('Estimated ' + fmtDuration(Math.max(5, trackSeconds * cost)) + ' for this file, after the model download.');
    }
    envEl.textContent = parts.join(' ');
    envEl.className = 'control-note' + (backend === 'webgpu' ? '' : ' warn-note');
  }

  function measureDuration(file) {
    var url = URL.createObjectURL(file);
    var probe = document.createElement(/^video\//.test(file.type) ? 'video' : 'audio');
    probe.preload = 'metadata';
    probe.onloadedmetadata = function () {
      if (isFinite(probe.duration)) { trackSeconds = probe.duration; describe(); }
      URL.revokeObjectURL(url);
    };
    probe.onerror = function () { URL.revokeObjectURL(url); };
    probe.src = url;
  }

  /* ------------------------------------------------------------- worker */

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker('/js/transcribe-worker.js?v=' + ASSET_V + (forceWasm ? '&backend=wasm' : '') + (safeMode ? '&safe=1' : ''), { type: 'module' });
    worker.onmessage = function (e) {
      var m = e.data || {};
      if (m.type === 'status') onStatus(m);
      else if (m.type === 'ready') describe(m);
      else if (m.type === 'note') { gpuUsable = false; describe(); }
      else if (m.type === 'partial') onPartial(m.text);
      else if (m.type === 'done') onDone(m);
      else if (m.type === 'error') onWorkerError(m);
    };
    worker.onerror = function (e) {
      onWorkerError({ stage: 'load', message: 'The transcription worker could not start' + (e && e.message ? ' (' + e.message + ')' : '') + '. Your browser may be blocking it.' });
    };
    return worker;
  }

  function setTitle(pct) {
    document.title = pct === null ? baseTitle : '(' + Math.round(pct) + '%) ' + baseTitle;
  }

  function onStatus(m) {
    var pct = m.phase === 'model' ? m.pct * 0.3 : m.phase === 'session' ? 30 : 32 + m.pct * 0.68;
    CV.setProgress(progressBar, pct);
    CV.setStatus(statusEl, 'info', m.detail);
    setTitle(pct);
  }

  function onPartial(text) {
    if (!liveEl) return;
    liveEl.hidden = false;
    liveEl.textContent += text;
    liveEl.scrollTop = liveEl.scrollHeight;
  }

  // The model failed to load on this browser's first choice of engine (the
  // GPU, or the threaded CPU build). Before showing an error, try once more
  // in a fresh worker on the plain CPU build: slower, but it is what runs
  // where the others do not. A dropped download is not retried here; the
  // worker already resumed it and the message says to press again.
  function onWorkerError(m) {
    if (m.stage === 'load' && !m.network && !safeMode && files.length) {
      safeMode = true;
      gpuUsable = false;
      try { worker.terminate(); } catch (e) {}
      worker = null;
      CV.setStatus(statusEl, 'info', 'The fast engine would not start in this browser — retrying on the simpler CPU engine…');
      transcribe();
      return;
    }
    onError(m.message);
  }

  function onError(message) {
    setTitle(null);
    CV.setStatus(statusEl, 'error', 'Transcription failed. ' + message);
    goBtn.disabled = files.length === 0;
    resetBtn.disabled = false;
    CV.setProgress(progressBar, 100);
  }

  // Speaker labels (diarize-worker.js + ASDiar): run after Whisper, on a
  // copy of the 16 kHz audio, only when asked for. names: the renames typed
  // into the speaker boxes.
  var diarAudio = null, speakerCount = 0, names = {}, diarWorker = null;

  function renderText() {
    if (!segments) return;
    textEl.value = speakerCount
      ? ASDiar.toText(segments, names)
      : ASSubs.toText(segments, { duration: duration, timestamps: tsBox && tsBox.checked });
  }
  function cueSegments() { return speakerCount ? ASDiar.prefixCues(segments, names) : segments; }

  function renderNames() {
    var box = $('#speakerNames');
    if (!box) return;
    box.innerHTML = '';
    box.hidden = !speakerCount;
    for (var k = 1; k <= speakerCount; k++) {
      var l = document.createElement('label'), inp = document.createElement('input');
      inp.type = 'text'; inp.placeholder = 'Speaker ' + k; inp.value = names[k] || ''; inp.dataset.k = k;
      inp.addEventListener('input', function () { names[this.dataset.k] = this.value; renderText(); });
      l.appendChild(document.createTextNode('Speaker ' + k + ' is '));
      l.appendChild(inp);
      box.appendChild(l);
    }
  }

  function diarize(audio, speakers) {
    return new Promise(function (resolve, reject) {
      if (!diarWorker) diarWorker = new Worker('/js/diarize-worker.js?v=' + ASSET_V, { type: 'module' });
      diarWorker.onmessage = function (e) {
        var m = e.data || {};
        if (m.type === 'status') { CV.setStatus(statusEl, 'info', m.detail); CV.setProgress(progressBar, 90 + m.pct * 0.1); }
        else if (m.type === 'done') resolve(m);
        else if (m.type === 'error') reject(new Error(m.message));
      };
      diarWorker.onerror = function (e) { reject(new Error('The speaker worker could not start' + (e && e.message ? ' (' + e.message + ')' : ''))); };
      diarWorker.postMessage({ type: 'run', audio: audio, speakers: speakers }, [audio.buffer]);
    });
  }

  async function onDone(m) {
    segments = m.segments && m.segments.length ? m.segments : [{ text: m.text, start: 0, end: duration }];
    speakerCount = 0; names = {};
    if (diarAudio) {
      var a = diarAudio; diarAudio = null;
      try {
        var d = await diarize(a, +(($('#speakers') || {}).value || 0));
        if (d.turns.length) { segments = ASDiar.labelSegments(segments, d.turns); speakerCount = d.speakers; }
      } catch (e) {
        CV.setStatus(statusEl, 'warn', 'The transcript is ready, but the speakers could not be labelled (' + (e.message || e) + ').', e);
      }
    }
    renderNames();
    renderText();
    resultEl.hidden = false;
    if (liveEl) liveEl.hidden = true;
    var words = (textEl.value.match(/\S+/g) || []).length;
    var took = m.seconds < 90 ? Math.round(m.seconds) + ' s' : (m.seconds / 60).toFixed(1) + ' min';
    CV.setStatus(statusEl, 'success', 'Done in ' + took + ' — ' + words + ' words, ' + segments.length + ' segments' +
      (speakerCount ? ', ' + speakerCount + ' speaker' + (speakerCount > 1 ? 's' : '') + ' (name them below)' : '') + '. Check the names, then download.');
    CV.setProgress(progressBar, 100);
    setTitle(null);
    goBtn.disabled = false;
    resetBtn.disabled = false;
    resultEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ------------------------------------------------------------ decoding */

  async function decode16k(file) {
    CV.setStatus(statusEl, 'info', 'Decoding…');
    var buf = await AudioSaw.decodeToAudioBuffer(file);
    if (buf.duration > MAX_SECONDS) {
      throw new Error('That file is ' + fmtDuration(buf.duration) + ' long. Past two hours the tab runs out of memory — split it into parts first.');
    }
    duration = buf.duration;
    var n = buf.length, nch = buf.numberOfChannels;
    var mono = new Float32Array(n);
    for (var c = 0; c < nch; c++) {
      var x = buf.getChannelData(c);
      for (var i = 0; i < n; i++) mono[i] += x[i] / nch;
    }
    if (buf.sampleRate === SR) return mono;
    CV.setStatus(statusEl, 'info', 'Resampling to 16 kHz for the model…');
    var r = await AudioSaw.resampleBuffer(AudioSaw.makeBuffer([mono], buf.sampleRate), SR);
    return Float32Array.from(r.getChannelData(0));
  }

  /* ------------------------------------------------------------ downloads */

  function baseName() {
    return (files[0] ? files[0].name : 'audio').replace(/\.[^.]+$/, '');
  }

  function save(text, ext, type) {
    var blob = new Blob([text], { type: type + ';charset=utf-8' });
    CV.downloadBlob(blob, baseName() + '.' + ext, downloadedOnce ? { again: true } : undefined);
    downloadedOnce = true;
  }

  function bind(id, fn) { var el = $(id); if (el) el.addEventListener('click', fn); }

  bind('#dlTxt', function () { if (segments) save(textEl.value, 'txt', 'text/plain'); });
  bind('#dlSrt', function () { if (segments) save(ASSubs.toSRT(cueSegments(), duration), 'srt', 'application/x-subrip'); });
  bind('#dlVtt', function () { if (segments) save(ASSubs.toVTT(cueSegments(), duration), 'vtt', 'text/vtt'); });
  bind('#copyBtn', function () {
    var btn = this;
    // Copying the transcript is using it, as much as downloading a .txt.
    // Before this, only downloads counted, and a visitor who copied the text
    // into their notes looked like one who gave up.
    if (segments && !downloadedOnce) {
      downloadedOnce = true;
      CV.track('convert_success', { tool: 'audio-to-text', target_format: 'copy' });
    }
    var done = function () { btn.textContent = 'copied'; setTimeout(function () { btn.textContent = 'copy text'; }, 1500); };
    if (navigator.clipboard) navigator.clipboard.writeText(textEl.value).then(done, function () { textEl.select(); });
    else { textEl.select(); try { document.execCommand('copy'); done(); } catch (e) {} }
  });
  if (tsBox) tsBox.addEventListener('change', renderText);
  if (modelSel) modelSel.addEventListener('change', function () { describe(); });

  /* ------------------------------------------------------------------ ui */

  function onFiles(picked) {
    if (!picked || !picked.length) return;
    files = picked.slice(0, 1);
    fileList.style.display = '';
    controls.style.display = '';
    goBtn.disabled = false;
    CV.renderFileList(fileList, files, function () { reset(); });
    measureDuration(files[0]);
  }

  function reset() {
    files = [];
    segments = null;
    fileList.innerHTML = '';
    controls.style.display = 'none';
    goBtn.disabled = true;
    CV.clearStatus(statusEl);
    progressWrap.style.display = 'none';
    CV.setProgress(progressBar, 0);
    resultEl.hidden = true;
    if (liveEl) { liveEl.hidden = true; liveEl.textContent = ''; }
    setTitle(null);
  }

  CV.bindDropzone(dropzone, fileInput, onFiles,
    ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus', '.webm', '.aif', '.aiff', '.caf', '.wma',
      '.mp4', '.mov', '.mkv', '.m4v', '.m4b', '.amr', '.3gp']);
  if (resetBtn) resetBtn.addEventListener('click', reset);

  goBtn.addEventListener('click', function () { downloadedOnce = false; transcribe(); });

  async function transcribe() {
    if (!files.length) return;
    goBtn.disabled = true;
    resetBtn.disabled = true;
    progressWrap.style.display = '';
    CV.setProgress(progressBar, 0);
    resultEl.hidden = true;
    segments = null;
    if (liveEl) liveEl.textContent = '';
    try {
      var w = ensureWorker();
      // Start the model download while the file decodes.
      w.postMessage({ type: 'load', model: modelSel.value });
      var audio = await decode16k(files[0]);
      var dz = $('#diarize');
      diarAudio = dz && dz.checked ? audio.slice() : null;
      w.postMessage({
        type: 'run', model: modelSel.value, audio: audio,
        language: langSel ? langSel.value : 'auto',
        task: taskSel ? taskSel.value : 'transcribe'
      }, [audio.buffer]);
    } catch (e) {
      onError(e.message || String(e));
    }
  }

  describe();
  probeGpu();
})();
