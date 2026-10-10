/*
 * /lyrics-from-song page controller: the words of a song as text and as
 * synced lyrics (LRC, SRT, VTT).
 *
 *   decode -> [MDX-Net vocal, stem-worker.js] -> 16 kHz mono ->
 *   Whisper base with word times (transcribe-worker.js, words: true) ->
 *   lines (the worker's phrases) -> drop lines sung over silence ->
 *   ASSubs.toLRC / toSRT / toVTT.
 *
 * Isolating the vocal first is what makes Whisper hear the words over a
 * band; on a GPU it costs about the song's length, on the CPU about ten
 * times that, so without a GPU the page offers to skip it for a clear vocal.
 * The two models never run together: the stem worker is ended before
 * Whisper loads, because both together are more than a phone has.
 *
 * Cross-origin isolated like /stem-splitter and /audio-to-text (threads);
 * so no ffmpeg (formats only ffmpeg reads are turned away) and no ads.
 */
(function () {
  'use strict';

  var ASSET_V = (function () {
    var m = document.currentScript && /[?&]v=([^&]+)/.exec(document.currentScript.src);
    return m ? m[1] : '1';
  })();

  if (typeof CV === 'undefined' || typeof AudioSaw === 'undefined' || typeof ASSubs === 'undefined') {
    console.error('[lyrics-from-song] the /js/* includes must come before lyrics-page.js');
    return;
  }

  var $ = CV.$;
  var MODEL = 'onnx-community/whisper-base_timestamped';
  var MAX_SECONDS = 10 * 60, SR_STEM = 44100;
  var dropzone = $('#dropzone');
  var fileInput = $('#fileInput');
  var fileList = $('#fileList');
  var controls = $('#controls');
  var goBtn = $('#convertBtn');
  var statusEl = $('#status');
  var progressWrap = $('#progressWrap');
  var progressBar = $('#progressBar');
  var isoBox = $('#isolate');
  var isoNote = $('#isoNote');
  var langSel = $('#language');
  var result = $('#result');
  var linesEl = $('#lines');
  var player = $('#player');

  if (!dropzone || !goBtn) return;

  var file = null, lines = null, duration = 0, gpu = null, stem = null, asr = null, baseTitle = document.title;

  function step(p, msg) {
    progressWrap.style.display = '';
    CV.setProgress(progressBar, p);
    if (msg) CV.setStatus(statusEl, 'info', msg);
    document.title = '(' + Math.round(p) + '%) ' + baseTitle;
  }

  (async function probe() {
    var a = null;
    try { a = navigator.gpu ? await navigator.gpu.requestAdapter() : null; } catch (e) { a = null; }
    gpu = !!a;
    if (isoBox) isoBox.checked = gpu;
    if (isoNote) isoNote.textContent = gpu
      ? 'Your browser can use the GPU: separating the vocal takes about as long as the song (a 64 MB model, once).'
      : 'No usable GPU here, so separating the vocal runs on the CPU, roughly ten times the song’s length. For a clear vocal over a light backing, leave it off.';
  })();

  function onFiles(picked) {
    var f = picked && picked[0];
    if (!f) return;
    file = f;
    fileList.style.display = '';
    CV.renderFileList(fileList, [f], function () { file = null; fileList.innerHTML = ''; controls.style.display = 'none'; result.hidden = true; });
    controls.style.display = '';
    goBtn.disabled = false;
    result.hidden = true;
    if (player) { if (player.src) URL.revokeObjectURL(player.src); player.src = URL.createObjectURL(f); }
  }
  CV.bindDropzone(dropzone, fileInput, onFiles,
    ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus', '.webm', '.aif', '.aiff', '.caf', '.mp4', '.mov', '.m4v']);

  /* -------------------------------------------------------------- workers */

  function stemSeparate(left, right) {
    return new Promise(function (resolve, reject) {
      stem = new Worker('/js/stem-worker.js?v=' + ASSET_V);
      stem.onmessage = function (e) {
        var m = e.data || {};
        if (m.type === 'status') step(m.phase === 'model' ? 5 + m.pct * 0.1 : m.phase === 'session' ? 15 : 15 + m.pct * 0.4, m.detail);
        else if (m.type === 'done') resolve(m);
        else if (m.type === 'error' && m.phase !== 'warmup') { var er = new Error(m.message); if (m.name) er.name = m.name; reject(er); }
      };
      stem.onerror = function () { reject(new Error('The separation worker could not start. Your browser may be blocking it.')); };
      stem.postMessage({ type: 'separate', left: left, right: right }, [left.buffer, right.buffer]);
    });
  }

  function transcribe(audio, lang, from) {
    return new Promise(function (resolve, reject) {
      asr = new Worker('/js/transcribe-worker.js?v=' + ASSET_V, { type: 'module' });
      asr.onmessage = function (e) {
        var m = e.data || {};
        if (m.type === 'status') step(m.phase === 'model' ? from + m.pct * 0.15 : from + 15 + m.pct * (95 - from - 15) / 100, m.detail);
        else if (m.type === 'done') resolve(m);
        else if (m.type === 'error') { var er = new Error(m.message); if (m.name) er.name = m.name; reject(er); }
      };
      asr.onerror = function () { reject(new Error('The transcription worker could not start. Your browser may be blocking it.')); };
      asr.postMessage({ type: 'load', model: MODEL });
      asr.postMessage({ type: 'run', model: MODEL, audio: audio, language: lang, task: 'transcribe', words: true }, [audio.buffer]);
    });
  }

  function end() {
    if (stem) { stem.terminate(); stem = null; }
    if (asr) { asr.terminate(); asr = null; }
  }

  /* -------------------------------------------------------------------- run */

  // Whisper fills silence with stock phrases; over an instrumental break in
  // an isolated vocal that is most of what goes wrong. A line is kept only
  // if the vocal under it is within 30 dB of the song's loudest singing.
  function voiced(segs, x, rate) {
    var lv = segs.map(function (s) {
      var a = Math.max(0, Math.round(s.start * rate)), b = Math.min(x.length, Math.round(s.end * rate)), e = 0;
      for (var i = a; i < b; i++) e += x[i] * x[i];
      return b > a ? Math.sqrt(e / (b - a)) : 0;
    });
    var top = Math.max.apply(null, lv.concat([1e-9]));
    return segs.filter(function (s, i) { return lv[i] > top * 0.0316; });
  }

  async function run() {
    if (!file) return;
    goBtn.disabled = true;
    result.hidden = true;
    try {
      step(1, 'Decoding…');
      var buf = await AudioSaw.decodeToAudioBuffer(file, null, { ffmpeg: false });
      if (buf.duration > MAX_SECONDS) throw new Error('That song is over 10 minutes long. Cut it into parts first.');
      duration = buf.duration;
      var vocal16, from = 5;
      if (isoBox && isoBox.checked) {
        step(3, 'Getting the vocal on its own…');
        var b44 = buf.sampleRate === SR_STEM ? buf : await AudioSaw.resampleBuffer(buf, SR_STEM);
        var l = Float32Array.from(b44.getChannelData(0)), r = Float32Array.from(b44.numberOfChannels > 1 ? b44.getChannelData(1) : b44.getChannelData(0));
        var sep = await stemSeparate(l, r);
        stem.terminate(); stem = null;
        var v = new Float32Array(sep.vocals[0].length);
        for (var i = 0; i < v.length; i++) v[i] = (sep.vocals[0][i] + sep.vocals[1][i]) / 2;
        vocal16 = (await AudioSaw.resampleBuffer(AudioSaw.makeBuffer([v], sep.sampleRate), 16000)).getChannelData(0);
        from = 55;
      } else {
        var mono = buf.numberOfChannels > 1 ? await AudioSaw.mixToMono(buf) : buf;
        vocal16 = (await AudioSaw.resampleBuffer(mono, 16000)).getChannelData(0);
      }
      var x16 = Float32Array.from(vocal16), keep = x16.slice();
      step(from, 'Loading the speech model (135 MB the first time, then kept)…');
      var done = await transcribe(x16, langSel ? langSel.value : 'auto', from);
      end();
      lines = voiced((done.segments || []).filter(function (s) { return s.text && s.text.trim(); }), keep, 16000);
      if (!lines.length) throw new Error('No words were heard. If the song has a band, tick "Separate the vocal first"; an instrumental has nothing to write.');
      render();
      CV.setProgress(progressBar, 100);
      document.title = baseTitle;
      CV.setStatus(statusEl, 'success', lines.length + ' lines. Correct any word in place, then download the lyrics.');
      if (CV.signal) CV.signal.input(duration.toFixed(0) + ' s song, ' + lines.length + ' lines' + (isoBox && isoBox.checked ? ', vocal separated first' : ''));
      result.hidden = false;
      result.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      end();
      document.title = baseTitle;
      CV.setStatus(statusEl, 'error', 'Could not get the lyrics. ' + (e.message || e), e);
    }
    goBtn.disabled = false;
  }
  goBtn.addEventListener('click', run);

  /* ---------------------------------------------------------------- output */

  function fmt(t) { var m = Math.floor(t / 60), s = Math.floor(t - m * 60); return m + ':' + (s < 10 ? '0' : '') + s; }

  function render() {
    linesEl.innerHTML = '';
    lines.forEach(function (ln) {
      var row = document.createElement('div');
      row.className = 'lyr-line';
      var t = document.createElement('button');
      t.type = 'button';
      t.className = 'lyr-time';
      t.textContent = fmt(ln.start);
      t.title = 'Play from here';
      t.addEventListener('click', function () { if (player) { player.currentTime = ln.start; player.play(); } });
      var inp = document.createElement('input');
      inp.type = 'text';
      inp.value = ln.text.trim();
      inp.setAttribute('aria-label', 'Line at ' + fmt(ln.start));
      inp.addEventListener('input', function () { ln.text = inp.value; });
      row.appendChild(t); row.appendChild(inp);
      linesEl.appendChild(row);
    });
  }

  function base() { return (file ? file.name.replace(/\.[^.]+$/, '') : 'lyrics') + '-lyrics'; }
  function save(text, ext, type) { CV.downloadBlob(new Blob([text], { type: type + ';charset=utf-8' }), base() + '.' + ext); }
  function plain() { return lines.map(function (l) { return l.text.trim(); }).filter(Boolean).join('\n') + '\n'; }

  function bind(sel, fn) { var el = $(sel); if (el) el.addEventListener('click', function () { if (lines) fn(); }); }
  bind('#dlLrc', function () { save(ASSubs.toLRC(lines, { duration: duration, title: file && file.name.replace(/\.[^.]+$/, '') }), 'lrc', 'text/plain'); });
  bind('#dlSrt', function () { save(ASSubs.toSRT(lines, duration), 'srt', 'application/x-subrip'); });
  bind('#dlVtt', function () { save(ASSubs.toVTT(lines, duration), 'vtt', 'text/vtt'); });
  bind('#dlTxt', function () { save(plain(), 'txt', 'text/plain'); });
  var copied = false;
  bind('#copyBtn', function () {
    var t = plain();
    if (!copied) { copied = true; CV.track('convert_success', { tool: 'lyrics-from-song', target_format: 'copy' }); }
    if (navigator.clipboard) navigator.clipboard.writeText(t).catch(function () {});
    var b = $('#copyBtn'); b.textContent = 'copied'; setTimeout(function () { b.textContent = 'Copy the words'; }, 1500);
  });

  window.__lyrics = { use: function (f) { onFiles([f]); }, run: run, lines: function () { return lines; }, isolate: function (on) { if (isoBox) isoBox.checked = !!on; } };
})();
