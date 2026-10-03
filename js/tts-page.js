/*
 * /text-to-speech page controller.
 *
 * Splits the text into sentence-sized chunks (ASTTS.chunk), sends them one
 * at a time to tts-worker.js, and plays each as it comes back, so the first
 * words are heard after one sentence rather than after the whole text. The
 * chunks are also kept, joined with the chosen pauses, for the download.
 *
 * The voice mixer blends the built-in voices' style tables (ASTTS.mixTables).
 * It is a mix of existing voices, not a voice designed from a description,
 * and the page says so.
 */
(function () {
  'use strict';

  var ASSET_V = (function () {
    var m = document.currentScript && /[?&]v=([^&]+)/.exec(document.currentScript.src);
    return m ? m[1] : (window.AS_VERSION || '1');
  })();

  if (typeof CV === 'undefined' || typeof AudioSaw === 'undefined' || typeof ASTTS === 'undefined') {
    console.error('[text-to-speech] the /js/* includes must come before tts-page.js');
    return;
  }

  var $ = CV.$;
  var SR = ASTTS.SAMPLE_RATE;
  var MAX_CHARS = 20000;

  var textEl = $('#ttsText');
  var countEl = $('#charCount');
  var voiceSel = $('#voice');
  var speedEl = $('#speed');
  var speedOut = $('#speedOut');
  var fmtSel = $('#format');
  var goBtn = $('#convertBtn');
  var stopBtn = $('#stopBtn');
  var dlBtn = $('#dlBtn');
  var sampleBtn = $('#sampleBtn');
  var statusEl = $('#status');
  var progressWrap = $('#progressWrap');
  var progressBar = $('#progressBar');
  var envEl = $('#envNote');
  var mixToggle = $('#mixToggle');
  var mixRows = $('#mixRows');
  var mixNote = $('#mixNote');
  var engineSel = $('#engine');

  if (!textEl || !goBtn) return;

  var worker = null;
  var ready = null;
  var gpuUsable = null;
  var job = 0;
  var pending = null;     // { job, total, got, parts: [], started, mix, voiceLabel, onDone }
  var ctx = null;
  var playAt = 0;
  var playing = [];
  var result = null;      // { samples, label, words }
  var downloadedOnce = false;
  var baseTitle = document.title;

  /* -------------------------------------------------------------- voices */

  var fillVoices = ASTTS.fillVoiceSelect;

  fillVoices(voiceSel, false);
  voiceSel.value = 'af_heart';
  CV.remember(voiceSel, 'as_tts_voice');

  var mixSels = [], mixWeights = [];
  if (mixRows) {
    Array.prototype.forEach.call(mixRows.querySelectorAll('.mix-row'), function (row) {
      var s = row.querySelector('select'), w = row.querySelector('input[type=range]');
      if (!s) return;   // the main voice's own weight row
      fillVoices(s, true);
      mixSels.push(s);
      mixWeights.push(w);
      s.addEventListener('change', describeMix);
      w.addEventListener('input', describeMix);
    });
  }
  var mainWeight = $('#mainWeight');
  if (mainWeight) mainWeight.addEventListener('input', describeMix);

  function currentMix() {
    var list = [{ id: voiceSel.value, w: mainWeight && mixRows && !mixRows.hidden ? +mainWeight.value : 1 }];
    if (mixRows && !mixRows.hidden) {
      mixSels.forEach(function (s, i) {
        if (s.value && +mixWeights[i].value > 0) list.push({ id: s.value, w: +mixWeights[i].value });
      });
    }
    // The same voice twice is one voice at the summed weight.
    var by = {};
    list.forEach(function (x) { by[x.id] = (by[x.id] || 0) + x.w; });
    return Object.keys(by).filter(function (k) { return by[k] > 0; }).map(function (k) { return { id: k, w: by[k] }; });
  }

  // Each mix is phonemized with the first voice's accent.
  function mixLang(mix) { var v = ASTTS.voice(mix[0] ? mix[0].id : 'af_heart'); return v ? v.lang : 'en-us'; }

  function mixName(mix) {
    if (mix.length === 1) return ASTTS.voice(mix[0].id).name;
    var sum = mix.reduce(function (a, x) { return a + x.w; }, 0);
    return mix.map(function (x) { return ASTTS.voice(x.id).name + ' ' + Math.round(x.w / sum * 100) + '%'; }).join(' + ');
  }

  function describeMix() {
    if (!mixNote) return;
    var mix = currentMix();
    mixNote.textContent = mix.length > 1
      ? 'Blend: ' + mixName(mix) + '. The accent follows the first voice.'
      : 'Pick a second voice to blend it in.';
    try { localStorage.setItem('as_tts_mix', ASTTS.formatMix(mix)); } catch (e) {}
  }

  if (mixToggle && mixRows) {
    mixToggle.addEventListener('click', function () {
      mixRows.hidden = !mixRows.hidden;
      mixToggle.setAttribute('aria-expanded', String(!mixRows.hidden));
      mixToggle.textContent = mixRows.hidden ? 'Mix voices…' : 'Use one voice';
      describeMix();
    });
  }

  // ?voice=af_bella:2,am_michael:1 or the last mix used.
  (function restoreMix() {
    var q = /[?&]voice=([^&]+)/.exec(location.search);
    var saved = q ? decodeURIComponent(q[1]) : null;
    if (!saved) { try { saved = localStorage.getItem('as_tts_mix'); } catch (e) {} }
    var mix = ASTTS.parseMix(saved);
    if (!mix.length) return;
    voiceSel.value = mix[0].id;
    if (mix.length > 1 && mixRows) {
      mixRows.hidden = false;
      if (mixToggle) { mixToggle.textContent = 'Use one voice'; mixToggle.setAttribute('aria-expanded', 'true'); }
      if (mainWeight) mainWeight.value = mix[0].w;
      mix.slice(1, 1 + mixSels.length).forEach(function (x, i) { mixSels[i].value = x.id; mixWeights[i].value = x.w; });
    }
    describeMix();
  })();

  /* ------------------------------------------------------------ settings */

  function showSpeed() { if (speedOut) speedOut.textContent = (+speedEl.value).toFixed(2).replace(/0$/, '') + '×'; }
  if (speedEl) { speedEl.addEventListener('input', showSpeed); showSpeed(); }
  if (fmtSel) CV.remember(fmtSel, 'as_tts_fmt');
  if (engineSel) {
    CV.remember(engineSel, 'as_tts_engine');
    engineSel.addEventListener('change', function () {
      // A different model means a different worker; the cached one is kept.
      if (worker && !pending) { worker.terminate(); worker = null; ready = null; }
      describe();
    });
  }

  function countChars() {
    var n = textEl.value.length;
    var words = (textEl.value.match(/\S+/g) || []).length;
    if (countEl) {
      countEl.textContent = words + ' words · about ' + fmtTime(words / 2.6) + ' of speech' +
        (n > MAX_CHARS ? ' — over the ' + (MAX_CHARS / 1000) + 'k-character limit; use the audiobook maker for long texts' : '');
      countEl.className = 'control-note' + (n > MAX_CHARS ? ' warn-note' : '');
    }
    goBtn.disabled = !textEl.value.trim() || n > MAX_CHARS;
    describe();
  }
  textEl.addEventListener('input', countChars);

  function fmtTime(s) {
    if (s < 90) return Math.max(1, Math.round(s)) + ' s';
    if (s < 3600) return Math.round(s / 60) + ' min';
    return (s / 3600).toFixed(1) + ' h';
  }

  /* --------------------------------------------------------- environment */

  // Measured cost per second of speech, for the estimate: check-tts on an
  // idle machine (Apple GPU, 8 cores) gave 0.48 on WebGPU and 1.36 on seven
  // CPU threads; one thread is about three times slower. Rounded up, since
  // most machines are busier than a test runner.
  var COST = { webgpu: 0.6, wasm: 1.6, wasm1: 4.5 };

  function wantsSmall() { return (engineSel && engineSel.value === 'small') || /[?&]backend=wasm\b/.test(location.search); }

  function describe() {
    if (!envEl) return;
    var parts = [];
    var backend = ready ? ready.backend : (gpuUsable && !wantsSmall() ? 'webgpu' : 'wasm');
    if (ready) {
      parts.push(ready.backend === 'webgpu' ? 'Running on your GPU (WebGPU).'
        : 'Running on the CPU' + (ready.threads > 1 ? ' across ' + ready.threads + ' threads' : ' on one thread') + ' — slower than a GPU, same voice.');
    } else if (gpuUsable === null) parts.push('Checking whether your browser can use the GPU…');
    else if (gpuUsable && !wantsSmall()) parts.push('Your browser can use the GPU, the fast path. The first run downloads a 326 MB voice model, once; on a slow or metered connection, choose the smaller download.');
    else if (gpuUsable) parts.push('The smaller download (92 MB) runs on the CPU: same voice, about three times slower than your GPU would be.');
    else parts.push('No usable GPU here, so this runs on the CPU: a 92 MB model, once, and roughly one and a half times as long as the speech to generate.');
    var words = (textEl.value.match(/\S+/g) || []).length;
    if (words > 20) {
      var cost = backend === 'webgpu' ? COST.webgpu : (self.crossOriginIsolated ? COST.wasm : COST.wasm1);
      parts.push('About ' + fmtTime(Math.max(3, words / 2.6 / (+speedEl.value || 1) * cost)) + ' for this text.');
    }
    envEl.textContent = parts.join(' ');
    envEl.className = 'control-note' + (backend === 'webgpu' ? '' : ' warn-note');
  }

  function probeGpu() {
    if (!navigator.gpu) { gpuUsable = false; describe(); return; }
    navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
      .then(function (a) { gpuUsable = !!a; describe(); })
      .catch(function () { gpuUsable = false; describe(); });
  }

  /* -------------------------------------------------------------- worker */

  function ensureWorker() {
    if (worker) return worker;
    var force = /[?&]backend=(wasm|webgpu)\b/.exec(location.search);
    var backend = force ? force[1] : (engineSel && engineSel.value === 'small' ? 'wasm' : '');
    var ph = /[?&]ph=(en|misaki|plain)\b/.exec(location.search);   // tools/measure-tts-langs.js
    worker = new Worker('/js/tts-worker.js?v=' + ASSET_V + (backend ? '&backend=' + backend : '') + (ph ? '&ph=' + ph[1] : ''));
    worker.onmessage = function (e) {
      var m = e.data || {};
      if (m.type === 'status') onStatus(m);
      else if (m.type === 'ready') { ready = m; describe(); }
      else if (m.type === 'note') { gpuUsable = false; describe(); }
      else if (m.type === 'audio') onAudio(m);
      else if (m.type === 'error') onError(m.message, m.job);
    };
    worker.onerror = function (e) {
      onError('The speech worker could not start' + (e && e.message ? ' (' + e.message + ')' : '') + '. Your browser may be blocking it.');
    };
    worker.postMessage({ type: 'load' });
    return worker;
  }

  function setTitle(pct) {
    document.title = pct === null ? baseTitle : '(' + Math.round(pct) + '%) ' + baseTitle;
  }

  function onStatus(m) {
    if (!pending) return;
    var pct = m.phase === 'model' ? m.pct * 0.4 : 40;
    progressWrap.style.display = '';
    CV.setProgress(progressBar, pct);
    CV.setStatus(statusEl, 'info', m.detail);
    setTitle(pct);
  }

  /* ------------------------------------------------------------ playback */

  function audioCtx() {
    if (!ctx) {
      var C = window.AudioContext || window.webkitAudioContext;
      ctx = new C();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function schedule(samples) {
    if (!pending || !pending.play || !samples.length) return;
    var c = audioCtx();
    var b = c.createBuffer(1, samples.length, SR);
    b.getChannelData(0).set(samples);
    var src = c.createBufferSource();
    src.buffer = b;
    src.connect(c.destination);
    var t = Math.max(c.currentTime + 0.05, playAt);
    src.start(t);
    playAt = t + b.duration;
    playing.push(src);
    src.onended = function () { playing = playing.filter(function (s) { return s !== src; }); };
  }

  function stopPlayback() {
    playing.forEach(function (s) { try { s.stop(); } catch (e) {} });
    playing = [];
    playAt = 0;
  }

  /* ----------------------------------------------------------- synthesis */

  function silence(sec) { return new Float32Array(Math.round(sec * SR)); }

  function speak(text, opts) {
    opts = opts || {};
    var chunks = ASTTS.chunk(text);
    if (!chunks.length) return;
    var mix = opts.mix || currentMix();
    cancel();
    job++;
    pending = {
      job: job, chunks: chunks, total: chunks.length, got: 0, parts: [], started: Date.now(),
      mix: mix, play: opts.play !== false, sample: !!opts.sample, words: (text.match(/\S+/g) || []).length
    };
    var w = ensureWorker();
    var speed = +speedEl.value || 1;
    chunks.forEach(function (c, i) {
      w.postMessage({ type: 'synth', job: job, seq: i, text: c.text, lang: mixLang(mix), mix: mix, speed: speed });
    });
    progressWrap.style.display = '';
    CV.setProgress(progressBar, ready ? 40 : 0);
    CV.setStatus(statusEl, 'info', ready ? 'Speaking…' : 'Loading the voice model…');
    goBtn.disabled = true;
    if (stopBtn) stopBtn.disabled = false;
    if (dlBtn) dlBtn.disabled = true;
    if (!opts.sample) result = null;
  }

  function onAudio(m) {
    if (!pending || m.job !== pending.job) return;
    var c = pending.chunks[m.seq];
    var trimmed = ASTTS.trimSilence(m.samples);
    var piece = new Float32Array(trimmed.length);
    piece.set(trimmed);
    pending.parts[m.seq] = { samples: piece, pause: c.pause };
    pending.got++;
    schedule(piece);
    schedule(silence(c.pause));
    var pct = 40 + pending.got / pending.total * 60;
    CV.setProgress(progressBar, pct);
    setTitle(pct);
    if (pending.got < pending.total) {
      var el = (Date.now() - pending.started) / 1000;
      var eta = el / pending.got * (pending.total - pending.got);
      CV.setStatus(statusEl, 'info', 'Speaking… sentence ' + (pending.got + 1) + ' of ' + pending.total +
        (pending.got > 1 ? ' — about ' + fmtTime(eta) + ' left' : ''));
    } else finish();
  }

  function finish() {
    var p = pending;
    var len = 0;
    p.parts.forEach(function (x, i) { len += x.samples.length + (i < p.parts.length - 1 ? Math.round(x.pause * SR) : 0); });
    var all = new Float32Array(len), off = 0;
    p.parts.forEach(function (x, i) {
      all.set(x.samples, off);
      off += x.samples.length + (i < p.parts.length - 1 ? Math.round(x.pause * SR) : 0);
    });
    pending = null;
    setTitle(null);
    goBtn.disabled = !textEl.value.trim();
    if (stopBtn) stopBtn.disabled = !playing.length;
    CV.setProgress(progressBar, 100);
    if (p.sample) { CV.clearStatus(statusEl); progressWrap.style.display = 'none'; return; }
    result = { samples: all, label: mixName(p.mix), mix: p.mix, words: p.words };
    if (dlBtn) {
      dlBtn.disabled = false;
      dlBtn.textContent = 'Download ' + fmtLabel();
    }
    var took = (Date.now() - p.started) / 1000;
    CV.setStatus(statusEl, 'success', 'Done: ' + fmtTime(all.length / SR) + ' of speech in ' + fmtTime(took) +
      (ready ? (ready.backend === 'webgpu' ? ' on your GPU' : ' on the CPU') : '') + '. Download it below, or change the text and generate again.');
    if (CV.signal) CV.signal.input('Text — ' + p.words + ' words, voice ' + result.label + ', ' + (+speedEl.value) + '× speed');
  }

  function cancel() {
    if (pending && worker) worker.postMessage({ type: 'cancel', job: pending.job });
    pending = null;
    stopPlayback();
    setTitle(null);
  }

  function onError(message, j) {
    if (j != null && pending && j !== pending.job) return;
    cancel();
    CV.setStatus(statusEl, 'error', 'Speech generation failed. ' + message);
    goBtn.disabled = !textEl.value.trim();
    if (stopBtn) stopBtn.disabled = true;
    CV.setProgress(progressBar, 100);
  }

  /* ------------------------------------------------------------ download */

  function fmtLabel() {
    var v = fmtSel ? fmtSel.value : 'mp3';
    return v === 'wav16' ? 'WAV' : v === 'm4a' ? 'M4A' : 'MP3';
  }

  function fileName() {
    var words = textEl.value.trim().split(/\s+/).slice(0, 6).join(' ')
      .replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'speech';
    return words.slice(0, 48);
  }

  async function download() {
    if (!result) return;
    dlBtn.disabled = true;
    try {
      var fmt = fmtSel ? fmtSel.value : 'mp3';
      var buf = AudioSaw.makeBuffer([result.samples], SR);
      var blob = await AudioSaw.encode(buf, fmt, { bitrate: 192 });
      var bytes = new Uint8Array(await blob.arrayBuffer());
      var tag = {
        title: textEl.value.trim().slice(0, 80),
        artist: 'AI voice: ' + result.label,
        software: 'AudioSaw text-to-speech (Kokoro-82M)',
        comment: 'Synthetic speech generated with Kokoro-82M at audiosaw.com/text-to-speech'
      };
      if (fmt === 'mp3') bytes = ASTTS.tagMp3(bytes, tag);
      else if (fmt === 'wav16') bytes = ASTTS.tagWav(bytes, tag);
      var out = new Blob([bytes], { type: blob.type });
      CV.downloadBlob(out, fileName() + '.' + AudioSaw.extFor(fmt), downloadedOnce ? { again: true } : undefined);
      downloadedOnce = true;
    } catch (e) {
      CV.setStatus(statusEl, 'error', 'Could not write the file. ' + (e.message || e));
    }
    dlBtn.disabled = false;
  }

  /* ------------------------------------------------------------------ ui */

  goBtn.addEventListener('click', function () {
    if (!textEl.value.trim()) return;
    audioCtx();   // unlock audio inside the click
    speak(textEl.value);
  });
  if (stopBtn) stopBtn.addEventListener('click', function () {
    var wasRunning = !!pending;
    cancel();
    stopBtn.disabled = true;
    goBtn.disabled = !textEl.value.trim();
    if (wasRunning) { CV.setStatus(statusEl, 'info', 'Stopped.'); progressWrap.style.display = 'none'; }
  });
  if (dlBtn) dlBtn.addEventListener('click', download);
  if (fmtSel) fmtSel.addEventListener('change', function () { if (dlBtn && result) dlBtn.textContent = 'Download ' + fmtLabel(); });
  if (sampleBtn) sampleBtn.addEventListener('click', function () {
    audioCtx();
    var mix = currentMix();
    speak('Hello! This is ' + mixName(mix).replace(/ \d+%/g, '') + '. Here is how I sound reading your text.', { mix: mix, sample: true });
  });

  // Ctrl/Cmd+Enter generates.
  textEl.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !goBtn.disabled) goBtn.click();
  });

  // "Open a file": a TXT, PDF, Word or EPUB file read into the box by ASBook
  // (book-parse.js; pdf.js is imported only for a PDF). Chapter titles stay
  // as their own paragraphs. Past the limit the box gets the first 20,000
  // characters, cut at a paragraph, and the note says where the rest can go.
  var fileBtn = $('#ttsFileBtn'), fileIn = $('#ttsFile');
  if (fileBtn && fileIn && window.ASBook) {
    fileBtn.addEventListener('click', function () { fileIn.click(); });
    fileIn.addEventListener('change', async function () {
      var f = fileIn.files && fileIn.files[0];
      fileIn.value = '';
      if (!f) return;
      try {
        CV.setStatus(statusEl, 'info', 'Reading ' + f.name + '…');
        var b = await ASBook.readFile(f, function (m) { CV.setStatus(statusEl, 'info', m); });
        var text = b.chapters.map(function (c, i) {
          return (b.chapters.length > 1 || !/^(Part 1|Opening)$/.test(c.title) ? c.title + '.\n\n' : '') + c.text;
        }).join('\n\n').trim();
        if (b.chapters.length === 1 && /^(Part 1|Opening)$/.test(b.chapters[0].title)) text = b.chapters[0].text.trim();
        var cut = text.length > MAX_CHARS;
        if (cut) {
          var at = text.lastIndexOf('\n\n', MAX_CHARS);
          text = text.slice(0, at > MAX_CHARS * 0.6 ? at : MAX_CHARS);
        }
        textEl.value = text;
        countChars();
        CV.setStatus(statusEl, cut ? 'warn' : 'success', cut
          ? 'Loaded the first ' + text.length.toLocaleString() + ' characters of ' + f.name + '. For the whole thing as one file with chapters, use the text to audiobook page.'
          : 'Loaded ' + f.name + '. Press Speak, or edit the text first.');
      } catch (e) {
        CV.setStatus(statusEl, 'error', 'Could not read that file. ' + (e.message || e), e);
      }
    });
  }

  // ?text= prefill, for links from other pages.
  (function prefill() {
    var q = /[?&]text=([^&]+)/.exec(location.search);
    if (q && !textEl.value) { try { textEl.value = decodeURIComponent(q[1].replace(/\+/g, ' ')).slice(0, MAX_CHARS); } catch (e) {} }
  })();

  countChars();
  describe();
  probeGpu();

  // Exposed for tools/check-tts.js.
  window.__tts = {
    speak: speak,
    state: function () { return { pending: !!pending, ready: ready, result: result && { seconds: result.samples.length / SR, label: result.label } }; },
    samples: function () { return result && result.samples; }
  };
})();
