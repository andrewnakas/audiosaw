/*
 * /text-to-audiobook page controller.
 *
 * A book is parsed into chapters (book-parse.js), each chapter is read by the
 * same Kokoro worker as /text-to-speech, and each finished chapter is encoded
 * at once (AAC for the M4B, MP3 for the zip) so a long book never sits in
 * memory as raw samples: an hour of 24 kHz float is 345 MB, of 64 kbps AAC
 * 29 MB. The M4B is assembled at the end by ffmpeg, which concatenates the
 * chapter files without re-encoding and writes the chapter marks from an
 * ffmetadata file (ASBook.ffmetadata).
 *
 * Finished chapters are kept in IndexedDB (audiosaw-tts, store chapters),
 * keyed by the chapter's text, voice and speed, so a closed tab or a crash
 * resumes where it stopped instead of starting the book again.
 */
(function () {
  'use strict';

  var ASSET_V = (function () {
    var m = document.currentScript && /[?&]v=([^&]+)/.exec(document.currentScript.src);
    return m ? m[1] : (window.AS_VERSION || '1');
  })();

  if (typeof CV === 'undefined' || typeof AudioSaw === 'undefined' || typeof ASTTS === 'undefined' || typeof ASBook === 'undefined') {
    console.error('[text-to-audiobook] the /js/* includes must come before audiobook-page.js');
    return;
  }

  var $ = CV.$;
  var SR = ASTTS.SAMPLE_RATE;
  var WORDS_PER_S = 2.6;

  var dropzone = $('#dropzone'), fileInput = $('#fileInput');
  var pasteEl = $('#bookText'), pasteBtn = $('#useText');
  var bookPanel = $('#book'), listEl = $('#chapters');
  var titleEl = $('#bookTitle'), authorEl = $('#bookAuthor');
  var voiceSel = $('#voice'), speedEl = $('#speed'), speedOut = $('#speedOut');
  var engineSel = $('#engine'), outSel = $('#outFmt'), readTitles = $('#readTitles');
  var goBtn = $('#convertBtn'), stopBtn = $('#stopBtn'), sampleBtn = $('#sampleBtn');
  var statusEl = $('#status'), progressWrap = $('#progressWrap'), progressBar = $('#progressBar');
  var envEl = $('#envNote'), summaryEl = $('#summary');

  if (!goBtn || !listEl) return;

  var book = null;      // { title, author, chapters: [{ title, text, words, on }] }
  var worker = null, ready = null, seq = 0, waiting = {};
  var running = null;   // { stop: bool }
  var baseTitle = document.title;

  ASTTS.fillVoiceSelect(voiceSel, false);
  voiceSel.value = 'af_heart';
  CV.remember(voiceSel, 'as_tts_voice');
  if (engineSel) CV.remember(engineSel, 'as_tts_engine');
  if (outSel) CV.remember(outSel, 'as_ab_fmt');
  function showSpeed() { speedOut.textContent = (+speedEl.value).toFixed(2).replace(/0$/, '') + '×'; summarize(); }
  speedEl.addEventListener('input', showSpeed);

  function fmtTime(s) {
    if (s < 90) return Math.max(1, Math.round(s)) + ' s';
    if (s < 5400) return Math.round(s / 60) + ' min';
    return (s / 3600).toFixed(1) + ' h';
  }

  /* -------------------------------------------------------------- worker */

  function ensureWorker() {
    if (worker) return worker;
    var small = (engineSel && engineSel.value === 'small') || /[?&]backend=wasm\b/.test(location.search);
    worker = new Worker('/js/tts-worker.js?v=' + ASSET_V + (small ? '&backend=wasm' : ''));
    worker.onmessage = function (e) {
      var m = e.data || {};
      if (m.type === 'status' && running) {
        CV.setStatus(statusEl, 'info', m.detail);
        CV.setProgress(progressBar, m.phase === 'model' ? m.pct * 0.05 : 5);
      } else if (m.type === 'ready') { ready = m; summarize(); }
      else if (m.type === 'audio' && waiting[m.seq]) { waiting[m.seq].resolve(m.samples); delete waiting[m.seq]; }
      else if (m.type === 'error') {
        if (m.seq != null && waiting[m.seq]) { waiting[m.seq].reject(new Error(m.message)); delete waiting[m.seq]; }
        else Object.keys(waiting).forEach(function (k) { waiting[k].reject(new Error(m.message)); delete waiting[k]; });
      }
    };
    worker.onerror = function (e) {
      Object.keys(waiting).forEach(function (k) { waiting[k].reject(new Error('The speech worker stopped' + (e && e.message ? ' (' + e.message + ')' : ''))); delete waiting[k]; });
    };
    worker.postMessage({ type: 'load' });
    return worker;
  }
  if (engineSel) engineSel.addEventListener('change', function () {
    if (worker && !running) { worker.terminate(); worker = null; ready = null; }
    summarize();
  });

  function synth(text, mix, speed) {
    var s = ++seq;
    return new Promise(function (resolve, reject) {
      waiting[s] = { resolve: resolve, reject: reject };
      ensureWorker().postMessage({ type: 'synth', job: 1, seq: s, text: text, lang: ASTTS.voice(mix[0].id).lang, mix: mix, speed: speed });
    });
  }

  /* ------------------------------------------------------------- storage */

  // audiosaw-tts: its own database, like the editor's, so neither the
  // service worker's pinned version nor the editor's upgrade path is touched.
  var dbP = null;
  function db() {
    if (dbP) return dbP;
    dbP = new Promise(function (resolve) {
      try {
        var r = indexedDB.open('audiosaw-tts', 1);
        r.onupgradeneeded = function () { r.result.createObjectStore('chapters'); };
        r.onsuccess = function () { resolve(r.result); };
        r.onerror = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
    return dbP;
  }
  function store(mode, fn) {
    return db().then(function (d) {
      if (!d) return null;
      return new Promise(function (resolve) {
        try {
          var tx = d.transaction('chapters', mode), req = fn(tx.objectStore('chapters'));
          tx.oncomplete = function () { resolve(req && req.result); };
          tx.onerror = tx.onabort = function () { resolve(null); };
        } catch (e) { resolve(null); }
      });
    });
  }
  function hash(s) {
    var h1 = 0x811c9dc5, h2 = 0;
    for (var i = 0; i < s.length; i++) { h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619); h2 = (h2 * 31 + s.charCodeAt(i)) | 0; }
    return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
  }

  /* ------------------------------------------------------------ the book */

  function load(b) {
    book = {
      title: b.title || '', author: b.author || '',
      chapters: b.chapters.map(function (c) { return { title: c.title, text: c.text, words: ASBook.words(c.text), on: true }; })
    };
    titleEl.value = book.title;
    authorEl.value = book.author;
    renderList();
    bookPanel.hidden = false;
    goBtn.disabled = false;
    if (CV.signal) CV.signal.input('Text — ' + book.chapters.length + ' chapters, ' + total().toLocaleString() + ' words');
    bookPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function total() {
    return book ? book.chapters.reduce(function (a, c) { return a + (c.on ? c.words : 0); }, 0) : 0;
  }

  function renderList() {
    listEl.innerHTML = '';
    book.chapters.forEach(function (c, i) {
      var row = document.createElement('div');
      row.className = 'chapter-row';
      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = c.on; cb.setAttribute('aria-label', 'Include chapter ' + (i + 1));
      cb.addEventListener('change', function () { c.on = cb.checked; summarize(); });
      var t = document.createElement('input');
      t.type = 'text'; t.value = c.title; t.className = 'chapter-title'; t.setAttribute('aria-label', 'Chapter ' + (i + 1) + ' title');
      t.addEventListener('input', function () { c.title = t.value; });
      var meta = document.createElement('span');
      meta.className = 'chapter-meta';
      meta.textContent = c.words.toLocaleString() + ' words · ' + fmtTime(c.words / WORDS_PER_S);
      var st = document.createElement('span');
      st.className = 'chapter-state';
      c.stateEl = st;
      row.appendChild(cb); row.appendChild(t); row.appendChild(meta); row.appendChild(st);
      listEl.appendChild(row);
    });
    summarize();
  }

  // Busy-machine figures from tts-worker.js: GPU about the speech's length,
  // CPU about five times it.
  function summarize() {
    if (!book || !summaryEl) return;
    var w = total(), speech = w / WORDS_PER_S / (+speedEl.value || 1);
    var gpu = ready ? ready.backend === 'webgpu' : (navigator.gpu && !(engineSel && engineSel.value === 'small'));
    var cost = gpu ? 0.6 : 4.5;
    summaryEl.textContent = book.chapters.filter(function (c) { return c.on; }).length + ' chapters, ' + w.toLocaleString() +
      ' words: about ' + fmtTime(speech) + ' of audio. Expect roughly ' + fmtTime(speech * cost) + ' to make it ' +
      (gpu ? 'on a GPU' : 'on the CPU') + '; keep the tab open. Finished chapters are saved, so it can be stopped and resumed.';
  }

  async function onFiles(files) {
    var f = files[0];
    if (!f) return;
    try {
      CV.setStatus(statusEl, 'info', 'Reading ' + f.name + '…');
      var b;
      if (/\.epub$/i.test(f.name)) b = await ASBook.fromEpub(await f.arrayBuffer());
      else b = ASBook.fromText(await f.text());
      if (!b.title) b.title = f.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
      if (!b.chapters.length) throw new Error('There is no text in that file.');
      CV.clearStatus(statusEl);
      load(b);
    } catch (e) {
      CV.setStatus(statusEl, 'error', 'Could not read that book. ' + (e.message || e));
    }
  }
  CV.bindDropzone(dropzone, fileInput, onFiles, ['.txt', '.md', '.markdown', '.epub', '.text']);
  if (pasteBtn) pasteBtn.addEventListener('click', function () {
    if (!pasteEl.value.trim()) return;
    var b = ASBook.fromText(pasteEl.value);
    if (!b.chapters.length) return;
    load(b);
  });

  /* ----------------------------------------------------------- rendering */

  function silence(sec) { return new Float32Array(Math.round(sec * SR)); }

  async function renderChapter(c, mix, speed, onPart) {
    var parts = [];
    var chunks = ASTTS.chunk(c.text);
    if (readTitles && readTitles.checked && c.title) chunks.unshift({ text: c.title.replace(/[.:]?\s*$/, '.'), pause: 0.9 });
    for (var i = 0; i < chunks.length; i++) {
      if (running.stop) throw new Error('stopped');
      var x = ASTTS.trimSilence(await synth(chunks[i].text, mix, speed));
      parts.push(x.slice(), silence(i < chunks.length - 1 ? chunks[i].pause : 1.2));
      onPart(i + 1, chunks.length);
    }
    var len = parts.reduce(function (a, p) { return a + p.length; }, 0), all = new Float32Array(len), off = 0;
    parts.forEach(function (p) { all.set(p, off); off += p.length; });
    return all;
  }

  async function run() {
    var chosen = book.chapters.filter(function (c) { return c.on && c.words; });
    if (!chosen.length) return;
    var mix = [{ id: voiceSel.value, w: 1 }], speed = +speedEl.value || 1;
    var fmt = outSel ? outSel.value : 'm4b';
    var meta = {
      title: titleEl.value.trim() || 'Audiobook', author: authorEl.value.trim(),
      comment: 'Synthetic speech: AudioSaw text-to-audiobook, Kokoro-82M voice ' + ASTTS.voice(mix[0].id).name
    };
    running = { stop: false };
    goBtn.disabled = true; stopBtn.disabled = false;
    progressWrap.style.display = '';
    CV.setProgress(progressBar, 0);
    var t0 = Date.now(), wordsAll = chosen.reduce(function (a, c) { return a + c.words; }, 0), wordsDone = 0, wordsRendered = 0;
    var out = [];
    try {
      for (var k = 0; k < chosen.length; k++) {
        var c = chosen[k];
        var key = hash([c.title, c.text, mix[0].id, speed, fmt, readTitles && readTitles.checked].join('\u0001'));
        var saved = await store('readonly', function (s) { return s.get(key); });
        if (saved && saved.blob) {
          c.stateEl.textContent = '✓ saved';
          out.push({ title: c.title, blob: saved.blob, seconds: saved.seconds });
          wordsDone += c.words;
          continue;
        }
        c.stateEl.textContent = 'reading…';
        var started = Date.now();
        var pcm = await renderChapter(c, mix, speed, function (i, n) {
          var w = wordsDone + c.words * i / n;
          var el = (Date.now() - t0) / 1000, rate = (wordsRendered + c.words * i / n) / Math.max(1, el);
          var left = rate > 0 ? (wordsAll - w) / rate : 0;
          var pct = 5 + 90 * w / wordsAll;
          CV.setProgress(progressBar, pct);
          document.title = '(' + Math.round(pct) + '%) ' + baseTitle;
          CV.setStatus(statusEl, 'info', 'Chapter ' + (k + 1) + ' of ' + chosen.length + ': ' + c.title + ' — part ' + i + ' of ' + n +
            (i > 1 || k > 0 ? ' · about ' + fmtTime(left) + ' left' : ''));
        });
        var buf = AudioSaw.makeBuffer([pcm], SR);
        var blob = await AudioSaw.encode(buf, fmt === 'm4b' ? 'm4a' : 'mp3', { bitrate: 64, quiet: true });
        var seconds = pcm.length / SR;
        await store('readwrite', function (s) { return s.put({ blob: blob, seconds: seconds, at: Date.now() }, key); });
        out.push({ title: c.title, blob: blob, seconds: seconds });
        wordsDone += c.words; wordsRendered += c.words;
        c.stateEl.textContent = '✓ ' + fmtTime(seconds) + ' in ' + fmtTime((Date.now() - started) / 1000);
      }

      CV.setStatus(statusEl, 'info', fmt === 'm4b' ? 'Assembling the M4B with chapter marks…' : 'Zipping the chapters…');
      var name = (meta.title || 'audiobook').replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 80) || 'audiobook';
      var result;
      if (fmt === 'm4b') result = { blob: await writeM4B(out, meta), name: name + '.m4b' };
      else {
        var entries = [];
        for (var j = 0; j < out.length; j++) {
          var o = out[j];
          var nm = String(j + 1).padStart(2, '0') + ' ' + o.title.replace(/[\\/:*?"<>|]+/g, '').slice(0, 60) + '.mp3';
          var tagged = ASTTS.tagMp3(new Uint8Array(await o.blob.arrayBuffer()), {
            title: o.title, artist: meta.author || 'AI voice', software: 'AudioSaw text-to-audiobook (Kokoro-82M)', comment: meta.comment
          });
          entries.push({ name: nm, blob: new Blob([tagged], { type: 'audio/mpeg' }) });
        }
        result = { blob: await AudioSaw.zipBlobs(entries), name: name + ' (mp3).zip' };
      }
      var secs = out.reduce(function (a, o) { return a + o.seconds; }, 0);
      CV.setProgress(progressBar, 100);
      CV.downloadBlob(result.blob, result.name);
      CV.setStatus(statusEl, 'success', 'Done: ' + fmtTime(secs) + ' of audio in ' + out.length + ' chapters, made in ' +
        fmtTime((Date.now() - t0) / 1000) + '. ' + result.name + ' is downloading.');
      window.__audiobook = { result: result, chapters: out.map(function (o) { return { title: o.title, seconds: o.seconds }; }) };
    } catch (e) {
      if (running && running.stop) { CV.setStatus(statusEl, 'info', 'Stopped. Finished chapters are saved; press Make audiobook to carry on.'); progressWrap.style.display = 'none'; }
      else CV.setStatus(statusEl, 'error', 'Could not make the audiobook. ' + (e.message || e), e);
    } finally {
      running = null;
      document.title = baseTitle;
      goBtn.disabled = false; stopBtn.disabled = true;
    }
  }

  // Chapter files are concatenated without re-encoding; the chapter marks
  // and tags come from an ffmetadata file. The .m4b extension picks ffmpeg's
  // ipod muxer, which writes them as a QuickTime chapter track: what Apple
  // Books, VLC and most audiobook players read.
  async function writeM4B(parts, meta) {
    var files = [], list = [];
    for (var i = 0; i < parts.length; i++) {
      var nm = 'ch' + i + '.m4a';
      files.push({ name: nm, data: new Uint8Array(await parts[i].blob.arrayBuffer()) });
      list.push("file '" + nm + "'");
    }
    var enc = new TextEncoder();
    files.push({ name: 'list.txt', data: enc.encode(list.join('\n') + '\n') });
    files.push({ name: 'meta.txt', data: enc.encode(ASBook.ffmetadata(meta, parts.map(function (p) { return { title: p.title, seconds: p.seconds }; }))) });
    return AudioSaw.runFFmpeg(null, null,
      ['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-i', 'meta.txt', '-map', '0:a', '-map_metadata', '1', '-map_chapters', '1', '-c', 'copy'],
      'm4b', 'audio/mp4', function (pct) { CV.setProgress(progressBar, 95 + pct * 0.05); }, 'Assembling…',
      { files: files, raw: true });
  }

  goBtn.addEventListener('click', function () { if (book && !running) run(); });
  stopBtn.addEventListener('click', function () {
    if (!running) return;
    running.stop = true;
    Object.keys(waiting).forEach(function (k) { waiting[k].reject(new Error('stopped')); delete waiting[k]; });
    if (worker) worker.postMessage({ type: 'cancel', job: 1 });
    // The worker drops cancelled work; a fresh job id would be cleaner, but a
    // new worker is simpler and the model stays in the cache.
    if (worker) { worker.terminate(); worker = null; ready = null; }
  });
  if (sampleBtn) sampleBtn.addEventListener('click', async function () {
    if (!book || running) return;
    var first = book.chapters.filter(function (c) { return c.on; })[0];
    if (!first) return;
    sampleBtn.disabled = true;
    var C = window.AudioContext || window.webkitAudioContext, ctx = new C();
    try {
      running = { stop: false };
      CV.setStatus(statusEl, 'info', 'Reading the opening…');
      var x = await synth(ASTTS.chunk(first.text)[0].text, [{ id: voiceSel.value, w: 1 }], +speedEl.value || 1);
      var b = ctx.createBuffer(1, x.length, SR); b.getChannelData(0).set(x);
      var src = ctx.createBufferSource(); src.buffer = b; src.connect(ctx.destination); src.start();
      CV.clearStatus(statusEl);
    } catch (e) { CV.setStatus(statusEl, 'error', 'Preview failed. ' + (e.message || e)); }
    running = null;
    sampleBtn.disabled = false;
  });

  if (envEl) envEl.textContent = navigator.gpu
    ? 'The first run downloads the voice model (326 MB for the fast GPU version, 92 MB for the smaller one) and keeps it.'
    : 'No WebGPU in this browser, so the book is read on the CPU: a 92 MB model, and several times the audio\'s length to make.';

  window.__ab = { load: load, run: run, book: function () { return book; } };
})();
