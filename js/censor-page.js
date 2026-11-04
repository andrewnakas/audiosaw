/*
 * /censor-audio page controller.
 *
 * 1. The file is decoded at its own rate; a 16 kHz mono copy goes to the
 *    timestamped Whisper base (transcribe-worker.js, words: true).
 * 2. js/censor.js marks the swear words and places each span on the audio.
 *    Every word in the transcript is a toggle: a found word can be let
 *    through, and any other word (a name, an address) can be bleeped.
 * 3. The ticked spans are replaced at the full rate, as a bleep or silence.
 *    The length does not change, so a video gets the new sound beside its
 *    copied picture (CV.remuxVideo), in sync, with nothing re-encoded.
 *
 * Not cross-origin isolated, because a video needs ffmpeg and /vendor/ffmpeg
 * carries no COEP; Whisper therefore runs on one CPU thread here, or the GPU.
 */
(function () {
  'use strict';

  var ASSET_V = (function () {
    var m = document.currentScript && /[?&]v=([^&]+)/.exec(document.currentScript.src);
    return m ? m[1] : '1';
  })();

  if (typeof CV === 'undefined' || typeof AudioSaw === 'undefined' || typeof ASCensor === 'undefined' || !CV.remuxVideo) {
    console.error('[censor-audio] the /js/* includes (with tool-shell.js) must come before censor-page.js');
    return;
  }

  var $ = CV.$;
  var MODEL = 'onnx-community/whisper-base_timestamped';
  var MAX_SECONDS = 2 * 3600;
  var ACCEPT = ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus', '.webm', '.aif', '.aiff', '.caf', '.wma',
    '.mp4', '.mov', '.mkv', '.m4v', '.amr', '.3gp'];

  var dropzone = $('#dropzone'), fileInput = $('#fileInput'), fileList = $('#fileList'), controls = $('#controls');
  var goBtn = $('#convertBtn'), statusEl = $('#status'), progressWrap = $('#progressWrap'), progressBar = $('#progressBar');
  var review = $('#review'), textEl = $('#transcript'), summaryEl = $('#summary'), cleanBtn = $('#cleanBtn');
  var fmtSel = $('#format'), modeSel = $('#mode'), mildBox = $('#mild'), customEl = $('#custom'), langSel = $('#language');
  var player = $('#player');
  if (!dropzone || !goBtn) return;

  var file = null, buffer = null, words = null, mono16 = null, marks = {}, asr = null, seq = 0, waiting = {};
  var baseTitle = document.title;

  function isVideo(f) { return CV.isVideoFile ? CV.isVideoFile(f) && !/\.m4a$/i.test(f.name) : /\.(mp4|mov|mkv|m4v|webm)$/i.test(f.name); }

  function step(p, msg) {
    progressWrap.style.display = '';
    CV.setProgress(progressBar, p);
    if (msg) CV.setStatus(statusEl, 'info', msg);
    document.title = '(' + Math.round(p) + '%) ' + baseTitle;
  }

  /* --------------------------------------------------------------- worker */

  function call(w, msg, transfer) {
    var s = ++seq; msg.seq = s;
    return new Promise(function (resolve, reject) { waiting[s] = { resolve: resolve, reject: reject }; w.postMessage(msg, transfer || []); });
  }
  function settle(m, ok) {
    var key = m.seq != null && waiting[m.seq] ? m.seq : Object.keys(waiting)[0];
    if (key == null || !waiting[key]) return;
    var p = waiting[key]; delete waiting[key];
    if (ok) p.resolve(m); else { var e = new Error(m.message || 'failed'); if (m.name) e.name = m.name; p.reject(e); }
  }
  function whisper() {
    if (asr) return asr;
    asr = new Worker('/js/transcribe-worker.js?v=' + ASSET_V, { type: 'module' });
    asr.onmessage = function (e) {
      var m = e.data || {};
      if (m.type === 'status') step(m.phase === 'model' ? 5 + m.pct * 0.35 : 40 + m.pct * 0.55, m.detail);
      else if (m.type === 'done') settle(m, true);
      else if (m.type === 'error') settle(m, false);
    };
    asr.onerror = function (e) { settle({ message: 'The transcription worker could not start' + (e && e.message ? ' (' + e.message + ')' : '') + '.' }, false); };
    return asr;
  }

  /* ---------------------------------------------------------------- input */

  function onFiles(picked) {
    var f = picked && picked[0];
    if (!f) return;
    file = f; buffer = null; words = null; marks = {};
    fileList.style.display = '';
    CV.renderFileList(fileList, [f], function () { file = null; fileList.innerHTML = ''; controls.style.display = 'none'; review.hidden = true; });
    controls.style.display = '';
    review.hidden = true;
    goBtn.disabled = false;
    if (fmtSel) fmtSel.closest('label').hidden = isVideo(f);
    if (player) { if (player.src) URL.revokeObjectURL(player.src); player.src = URL.createObjectURL(f); }
  }
  CV.bindDropzone(dropzone, fileInput, onFiles, ACCEPT);

  function customWords() {
    return String(customEl ? customEl.value : '').toLowerCase().split(/[,\n]+/)
      .map(function (w) { return w.replace(/[’']/g, '').replace(/[^a-z*]/g, ''); }).filter(Boolean);
  }

  /* ------------------------------------------------------------- analysis */

  async function analyse() {
    if (!file) return;
    goBtn.disabled = true;
    review.hidden = true;
    try {
      step(1, 'Decoding…');
      buffer = await AudioSaw.decodeToAudioBuffer(file);
      if (buffer.duration > MAX_SECONDS) throw new Error('That file is over 120 minutes long. Split it into parts first.');
      var mono = buffer.numberOfChannels > 1 ? await AudioSaw.mixToMono(buffer) : buffer;
      var x16 = Float32Array.from((await AudioSaw.resampleBuffer(mono, 16000)).getChannelData(0));
      mono16 = x16.slice();
      var w = whisper();
      w.postMessage({ type: 'load', model: MODEL });
      step(5, 'Loading the speech model (135 MB the first time, then kept)…');
      var done = await call(w, { type: 'run', model: MODEL, audio: x16, language: langSel ? langSel.value : 'en', task: 'transcribe', words: true }, [x16.buffer]);
      asr.terminate(); asr = null;
      words = (done.words || []).filter(function (x) { return x.start != null && x.end != null; });
      if (!words.length) throw new Error('No speech was found in that file.');
      mark();
      CV.setProgress(progressBar, 100);
      document.title = baseTitle;
      CV.clearStatus(statusEl);
      review.hidden = false;
      review.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      document.title = baseTitle;
      if (asr) { asr.terminate(); asr = null; }
      CV.setStatus(statusEl, 'error', 'Could not transcribe the file. ' + (e.message || e), e);
    }
    goBtn.disabled = false;
  }
  goBtn.addEventListener('click', analyse);

  // marks: word index -> { kind, start, end, on }. Found words come from
  // ASCensor.find; a word the user clicks is added with ASCensor.spanOf.
  function mark() {
    var keep = {};
    Object.keys(marks).forEach(function (k) { if (marks[k].kind === 'picked') keep[k] = marks[k]; });
    marks = keep;
    ASCensor.find(words, mono16, 16000, { custom: customWords(), kinds: { strong: true, slur: true, custom: true, mild: !!(mildBox && mildBox.checked) } })
      .forEach(function (f) { if (!marks[f.at]) marks[f.at] = f; });
    render();
  }

  /* --------------------------------------------------------------- review */

  function fmt(t) { var m = Math.floor(t / 60), s = t - m * 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1); }
  function active() { return Object.keys(marks).map(function (k) { return marks[k]; }).filter(function (m) { return m.on; }); }

  function summarise() {
    var all = Object.keys(marks).map(function (k) { return marks[k]; });
    var found = all.filter(function (m) { return m.kind !== 'picked'; }).length, on = active().length;
    summaryEl.textContent = found + ' word' + (found === 1 ? '' : 's') + ' found. ' + on + ' will be ' + (modeSel && modeSel.value === 'silence' ? 'muted' : 'bleeped') + '.';
    cleanBtn.disabled = !on;
  }

  function render() {
    textEl.innerHTML = '';
    words.forEach(function (w, i) {
      var el = document.createElement('button');
      el.type = 'button';
      el.textContent = String(w.text).trim();
      var m = marks[i];
      el.className = 'cw' + (m ? ' cw-' + m.kind : '') + (m && m.on ? ' on' : '');
      el.title = fmt(w.start) + (m ? (m.on ? ': will be bleeped. Click to let it through.' : ': found, let through. Click to bleep it.') : ': click to bleep this word too.') + ' Shift-click to hear it.';
      el.addEventListener('click', function (e) {
        if (e.shiftKey) { hear(i); return; }
        var cur = marks[i];
        if (!cur) {
          var sp = ASCensor.spanOf(words, i, mono16, 16000);
          cur = marks[i] = { at: i, text: el.textContent, kind: 'picked', start: sp[0], end: sp[1], on: true };
        } else cur.on = !cur.on;
        el.className = 'cw' + ' cw-' + cur.kind + (cur.on ? ' on' : '');
        summarise();
      });
      textEl.appendChild(el);
      textEl.appendChild(document.createTextNode(' '));
    });
    summarise();
  }

  function hear(i) {
    if (!player) return;
    var w = words[i];
    player.currentTime = Math.max(0, w.start - 1);
    player.play();
    var stopAt = w.end + 1;
    var t = setInterval(function () { if (player.currentTime >= stopAt || player.paused) { player.pause(); clearInterval(t); } }, 50);
  }

  if (mildBox) mildBox.addEventListener('change', function () { if (words) mark(); });
  if (customEl) customEl.addEventListener('change', function () { if (words) mark(); });
  if (modeSel) modeSel.addEventListener('change', function () { if (words) summarise(); });

  /* --------------------------------------------------------------- write */

  async function clean() {
    if (!buffer) return;
    cleanBtn.disabled = true;
    try {
      var spans = active().map(function (m) { return [m.start, m.end]; });
      var chans = [];
      for (var c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
      var mode = modeSel ? modeSel.value : 'bleep';
      var out = AudioSaw.makeBuffer(ASCensor.apply(chans, buffer.sampleRate, spans, { mode: mode }), buffer.sampleRate);
      var base = file.name.replace(/\.[^.]+$/, '') + '-clean';
      var what = spans.length + ' word' + (spans.length === 1 ? '' : 's') + ' ' + (mode === 'silence' ? 'muted' : 'bleeped');
      if (CV.signal) CV.signal.input(what + ', same length as the original');
      if (isVideo(file)) {
        var made = await CV.remuxVideo(file, out, function (p, msg) { step(p, msg || 'Putting the clean sound on the video…'); });
        CV.setStatus(statusEl, 'success', 'Done: ' + what + '. The picture is copied untouched and stays in sync.');
        CV.downloadBlob(made.blob, base + '.' + made.ext);
      } else {
        var fmt0 = fmtSel ? fmtSel.value : 'wav';
        var enc = await AudioSaw.encode(out, fmt0, { srcInfo: buffer.srcInfo });
        if (player) { if (player.src) URL.revokeObjectURL(player.src); player.src = URL.createObjectURL(enc); }
        CV.setStatus(statusEl, 'success', 'Done: ' + what + '. The player above now plays the clean version.');
        CV.downloadBlob(enc, base + '.' + AudioSaw.extFor(fmt0));
      }
    } catch (e) {
      CV.setStatus(statusEl, 'error', 'Could not write the file. ' + (e.message || e), e);
    }
    cleanBtn.disabled = false;
  }
  if (cleanBtn) cleanBtn.addEventListener('click', clean);

  window.__censor = {
    analyse: analyse, clean: clean, use: function (f) { onFiles([f]); },
    marks: function () { return Object.keys(marks).map(function (k) { return marks[k]; }); },
    words: function () { return words; },
    mono16: function () { return mono16; }
  };
})();
