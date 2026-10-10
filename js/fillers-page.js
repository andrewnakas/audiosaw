/*
 * /remove-filler-words page controller.
 *
 * 1. The file is decoded at its own rate; a 16 kHz mono copy goes to the
 *    timestamped Whisper base (transcribe-worker.js, words: true).
 * 2. js/fillers.js finds the fillers on the word list and the audio, and the
 *    long pauses between words. Each is a toggle in the transcript.
 * 3. The ticked ones are cut from the full-rate audio with 10 ms crossfades.
 *    A video's picture is cut at the same places by ffmpeg (trim + concat),
 *    which means it is re-encoded; the page says so.
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

  if (typeof CV === 'undefined' || typeof AudioSaw === 'undefined' || typeof ASFillers === 'undefined') {
    console.error('[remove-filler-words] the /js/* includes must come before fillers-page.js');
    return;
  }

  var $ = CV.$;
  var MODEL = 'onnx-community/whisper-base_timestamped';
  var MAX_SECONDS = 2 * 3600;
  var ACCEPT = ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus', '.webm', '.aif', '.aiff', '.caf', '.wma',
    '.mp4', '.mov', '.mkv', '.m4v', '.amr', '.3gp'];

  var dropzone = $('#dropzone');
  var fileInput = $('#fileInput');
  var fileList = $('#fileList');
  var controls = $('#controls');
  var goBtn = $('#convertBtn');
  var statusEl = $('#status');
  var progressWrap = $('#progressWrap');
  var progressBar = $('#progressBar');
  var review = $('#review');
  var textEl = $('#transcript');
  var summaryEl = $('#summary');
  var cutBtn = $('#cutBtn');
  var fmtSel = $('#format');
  var pauseBox = $('#pauses');
  var maybeBox = $('#maybes');
  var langSel = $('#language');
  var player = $('#player');

  if (!dropzone || !goBtn) return;

  var file = null, buffer = null, words = null, finds = [], asr = null, seq = 0, waiting = {};
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
    file = f; buffer = null; words = null; finds = [];
    fileList.style.display = '';
    CV.renderFileList(fileList, [f], function () { file = null; fileList.innerHTML = ''; controls.style.display = 'none'; review.hidden = true; });
    controls.style.display = '';
    review.hidden = true;
    goBtn.disabled = false;
    if (fmtSel) fmtSel.closest('label').hidden = isVideo(f);
    if (player) { if (player.src) URL.revokeObjectURL(player.src); player.src = URL.createObjectURL(f); }
  }
  CV.bindDropzone(dropzone, fileInput, onFiles, ACCEPT);

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
      var keep16 = x16.slice();
      var w = whisper();
      w.postMessage({ type: 'load', model: MODEL });
      step(5, 'Loading the speech model (135 MB the first time, then kept)…');
      var done = await call(w, { type: 'run', model: MODEL, audio: x16, language: langSel ? langSel.value : 'en', task: 'transcribe', words: true }, [x16.buffer]);
      asr.terminate(); asr = null;
      words = (done.words || []).filter(function (x) { return x.start != null; });
      if (!words.length) throw new Error('No speech was found in that file.');
      finds = ASFillers.find(words, keep16, 16000).map(function (f) { f.cut = ASFillers.span(f, words, keep16, 16000); return f; })
        .concat(ASFillers.pauses(words, keep16, 16000).map(function (p) { p.cut = [p.start, p.end]; return p; }));
      render();
      CV.setProgress(progressBar, 100);
      document.title = baseTitle;
      CV.clearStatus(statusEl);
      review.hidden = false;
      review.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      document.title = baseTitle;
      if (asr) { asr.terminate(); asr = null; }
      CV.setStatus(statusEl, 'error', 'Could not find the fillers. ' + (e.message || e), e);
    }
    goBtn.disabled = false;
  }
  goBtn.addEventListener('click', analyse);

  /* --------------------------------------------------------------- review */

  function fmt(t) { var m = Math.floor(t / 60), s = t - m * 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1); }

  function active() {
    var pauses = !pauseBox || pauseBox.checked;
    return finds.filter(function (f) { return f.on && (f.kind !== 'pause' || pauses); });
  }

  function summarise() {
    var a = active(), saved = 0;
    a.forEach(function (f) { saved += f.cut[1] - f.cut[0]; });
    var nf = finds.filter(function (f) { return f.kind === 'filler'; }).length;
    var nm = finds.filter(function (f) { return f.kind === 'maybe'; }).length;
    var np = finds.filter(function (f) { return f.kind === 'pause'; }).length;
    summaryEl.textContent = nf + ' filler' + (nf === 1 ? '' : 's') + ' found' + (nm ? ', ' + nm + ' possible' : '') +
      (np ? ', ' + np + ' long pause' + (np === 1 ? '' : 's') : '') + '. ' + a.length + ' cut' + (a.length === 1 ? '' : 's') +
      ' ticked, ' + saved.toFixed(1) + ' s shorter.';
    cutBtn.disabled = !a.length;
  }

  function render() {
    textEl.innerHTML = '';
    var byWord = {};
    finds.forEach(function (f) { if (f.at != null) byWord[f.at] = f; });
    var pausesAfter = {};
    finds.forEach(function (f) {
      if (f.kind !== 'pause') return;
      var last = -1;
      for (var i = 0; i < words.length; i++) if (words[i].end != null && words[i].end <= f.start + 0.4) last = i;
      if (last >= 0) pausesAfter[last] = f;
    });
    words.forEach(function (w, i) {
      var f = byWord[i];
      var el = document.createElement(f ? 'button' : 'span');
      el.textContent = w.text;
      if (f) {
        el.type = 'button';
        el.className = 'fw fw-' + f.kind + (f.on ? ' on' : '');
        el.title = (f.kind === 'maybe' ? 'Possible filler' : 'Filler') + ' at ' + fmt(f.cut[0]) + ': click to ' + (f.on ? 'keep' : 'cut') + '. Shift-click to hear it.';
        el.addEventListener('click', function (e) {
          if (e.shiftKey) { hear(f); return; }
          f.on = !f.on;
          el.classList.toggle('on', f.on);
          summarise();
        });
      }
      textEl.appendChild(el);
      var p = pausesAfter[i];
      if (p) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'fw fw-pause' + (p.on ? ' on' : '');
        b.textContent = ' ⏸ ' + (p.end - p.start + 0.5).toFixed(1) + ' s ';
        b.title = 'A long pause: click to keep it as it is.';
        b.addEventListener('click', function () { p.on = !p.on; b.classList.toggle('on', p.on); summarise(); });
        textEl.appendChild(b);
      }
    });
    summarise();
  }

  function hear(f) {
    if (!player) return;
    player.currentTime = Math.max(0, f.cut[0] - 1);
    player.play();
    var stopAt = f.cut[1] + 1;
    var t = setInterval(function () { if (player.currentTime >= stopAt || player.paused) { player.pause(); clearInterval(t); } }, 50);
  }

  if (pauseBox) pauseBox.addEventListener('change', summarise);
  if (maybeBox) maybeBox.addEventListener('change', function () {
    finds.forEach(function (f) { if (f.kind === 'maybe') f.on = maybeBox.checked; });
    render();
  });

  /* ----------------------------------------------------------------- cut */

  async function cut() {
    if (!buffer) return;
    cutBtn.disabled = true;
    try {
      var ranges = active().map(function (f) { return f.cut; });
      var chans = [];
      for (var c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
      var res = ASFillers.cut(chans, buffer.sampleRate, ranges);
      var out = AudioSaw.makeBuffer(res.channels, buffer.sampleRate);
      var base = file.name.replace(/\.[^.]+$/, '') + '-no-fillers';
      if (CV.signal) CV.signal.input(ranges.length + ' cuts, ' + res.removed.toFixed(1) + ' s removed');
      if (isVideo(file)) {
        var blob = await cutVideo(file, out, res.keep, buffer.sampleRate);
        CV.setStatus(statusEl, 'success', 'Done: ' + ranges.length + ' cuts, ' + res.removed.toFixed(1) + ' s shorter. The picture was cut at the same places.');
        CV.downloadBlob(blob, base + '.mp4');
      } else {
        var fmt0 = fmtSel ? fmtSel.value : 'wav';
        var enc = await AudioSaw.encode(out, fmt0, { srcInfo: buffer.srcInfo });
        CV.setStatus(statusEl, 'success', 'Done: ' + ranges.length + ' cuts, ' + res.removed.toFixed(1) + ' s shorter.');
        CV.downloadBlob(enc, base + '.' + AudioSaw.extFor(fmt0));
      }
    } catch (e) {
      CV.setStatus(statusEl, 'error', 'Could not write the file. ' + (e.message || e), e);
    }
    cutBtn.disabled = false;
  }
  if (cutBtn) cutBtn.addEventListener('click', cut);

  // The picture cut where the sound was. Each kept piece after the first
  // lost the 10 ms its crossfade overlapped, so its video starts that much
  // later too and the two stay the same length.
  async function cutVideo(f, audio, keep, rate) {
    var xf = Math.round(0.01 * rate);
    var parts = [], filt = [];
    keep.forEach(function (k, i) {
      var s = (k[0] + (i ? xf : 0)) / rate, e = k[1] / rate;
      filt.push('[0:v]trim=start=' + s.toFixed(4) + ':end=' + e.toFixed(4) + ',setpts=PTS-STARTPTS[v' + i + ']');
      parts.push('[v' + i + ']');
    });
    var graph = filt.join(';') + ';' + parts.join('') + 'concat=n=' + parts.length + ':v=1:a=0[v]';
    var ext = ((/\.([^.]+)$/.exec(f.name) || [])[1] || 'mp4').toLowerCase();
    var wav = AudioSaw.floatWav(audio);
    return AudioSaw.runFFmpeg(f, ext,
      ['-i', 'cut.wav', '-filter_complex', graph, '-map', '[v]', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'superfast', '-crf', '20',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'],
      'mp4', 'video/mp4',
      function (p, msg) { step(p, msg || 'Cutting the picture to match…'); }, 'Cutting the picture to match…',
      { files: [{ name: 'cut.wav', data: new Uint8Array(await wav.arrayBuffer()) }] });
  }

  window.__fillers = {
    analyse: analyse, cut: cut, finds: function () { return finds; }, words: function () { return words; },
    use: function (f) { onFiles([f]); }
  };
})();
