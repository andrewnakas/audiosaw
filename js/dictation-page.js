/*
 * /dictation page controller: speak, and the words appear.
 *
 * The microphone is captured at 16 kHz (or resampled to it with the sinc
 * resampler when the browser will not open a 16 kHz context), split into
 * phrases by ASVad (dictation-vad.js), and each phrase is transcribed by the
 * same Whisper worker as /audio-to-text, unmodified, through its message
 * protocol. Phrases are queued, so speaking faster than the model only
 * delays the text; nothing is dropped.
 *
 * Processing is left ON for the microphone here, unlike the recorder's
 * studio mode: echo cancellation and noise suppression help recognition,
 * and nothing is kept but the words.
 */
(function () {
  'use strict';

  var ASSET_V = (function () {
    var m = document.currentScript && /[?&]v=([^&]+)/.exec(document.currentScript.src);
    return m ? m[1] : (window.AS_VERSION || '1');
  })();

  if (typeof CV === 'undefined' || typeof ASVad === 'undefined') {
    console.error('[dictation] the /js/* includes must come before dictation-page.js');
    return;
  }

  var $ = CV.$;
  var SR = 16000;
  var micBtn = $('#micBtn'), textEl = $('#dictText'), statusEl = $('#status');
  var modelSel = $('#model'), langSel = $('#language'), taskSel = $('#task');
  var meterEl = $('#meter'), liveEl = $('#liveLine'), envEl = $('#envNote');
  var copyBtn = $('#copyBtn'), dlBtn = $('#dlBtn'), clearBtn = $('#clearBtn');
  if (!micBtn || !textEl) return;

  var worker = null, ready = null, busy = false, queue = [];
  var ctx = null, stream = null, node = null, seg = null, raf = 0;
  var listening = false, startedAt = 0, phrases = 0, saved = false, blocks = 0;

  if (modelSel) CV.remember(modelSel, 'as_dict_model');
  if (langSel) CV.remember(langSel, 'as_dict_lang');
  try { var draft = localStorage.getItem('as_dict_text'); if (draft && !textEl.value) textEl.value = draft; } catch (e) {}
  function keep() { try { localStorage.setItem('as_dict_text', textEl.value.slice(-50000)); } catch (e) {} }
  textEl.addEventListener('input', keep);

  /* -------------------------------------------------------------- whisper */

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker('/js/transcribe-worker.js?v=' + ASSET_V, { type: 'module' });
    worker.onmessage = function (e) {
      var m = e.data || {};
      if (m.type === 'status' && m.phase === 'model') CV.setStatus(statusEl, 'info', m.detail);
      else if (m.type === 'ready') {
        ready = m;
        if (envEl) envEl.textContent = m.backend === 'webgpu' ? 'Whisper is running on your GPU.' : 'Whisper is running on the CPU' + (m.threads > 1 ? ' across ' + m.threads + ' threads' : '') + '; text follows a few seconds behind.';
        if (listening) CV.setStatus(statusEl, 'info', 'Listening… speak, then pause; the text appears after each phrase.');
      } else if (m.type === 'partial') { if (liveEl) { liveEl.hidden = false; liveEl.textContent += m.text; } }
      else if (m.type === 'done') onText(m);
      else if (m.type === 'error') { busy = false; CV.setStatus(statusEl, 'error', 'Transcription failed. ' + m.message); next(); }
    };
    worker.onerror = function (e) {
      CV.setStatus(statusEl, 'error', 'The speech model could not start' + (e && e.message ? ' (' + e.message + ')' : '') + '.');
    };
    worker.postMessage({ type: 'load', model: modelSel.value });
    return worker;
  }
  if (modelSel) modelSel.addEventListener('change', function () { if (worker && !busy) worker.postMessage({ type: 'load', model: modelSel.value }); });

  function next() {
    if (busy || !queue.length) return;
    busy = true;
    var a = queue.shift();
    if (liveEl) liveEl.textContent = '';
    ensureWorker().postMessage({
      type: 'run', model: modelSel.value, audio: a,
      language: langSel ? langSel.value : 'auto', task: taskSel ? taskSel.value : 'transcribe'
    }, [a.buffer]);
  }

  // Each phrase is appended at the end with a space, or a new paragraph
  // after a long pause; the box stays editable throughout.
  var lastEnd = 0;
  function onText(m) {
    busy = false;
    if (liveEl) { liveEl.textContent = ''; liveEl.hidden = true; }
    var t = (m.text || '').replace(/\s+/g, ' ').trim();
    if (t && !ASVad.phantom(t)) {
      var v = textEl.value;
      var sep = !v ? '' : (Date.now() - lastEnd > 6000 ? '\n\n' : (/\s$/.test(v) ? '' : ' '));
      textEl.value = v + sep + t;
      textEl.scrollTop = textEl.scrollHeight;
      lastEnd = Date.now();
      phrases++;
      keep();
    }
    if (!listening && !queue.length) CV.setStatus(statusEl, 'success', 'Stopped. ' + words() + ' words so far — edit, copy or download them below.');
    next();
  }

  function words() { return (textEl.value.match(/\S+/g) || []).length; }

  /* ---------------------------------------------------------------- mic */

  var WORKLET = [
    'class DictTap extends AudioWorkletProcessor {',
    '  constructor() { super(); this.b = new Float32Array(2048); this.n = 0; }',
    '  process(inputs) {',
    '    const c = inputs[0] && inputs[0][0];',
    '    if (!c) return true;',
    '    this.b.set(c, this.n); this.n += c.length;',
    '    if (this.n + 128 > this.b.length) { this.port.postMessage(this.b.slice(0, this.n)); this.n = 0; }',
    '    return true;',
    '  }',
    '}',
    'registerProcessor("dict-tap", DictTap);'
  ].join('\n');

  async function start() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      CV.setStatus(statusEl, 'error', 'This browser cannot open the microphone here.');
      return;
    }
    ensureWorker();
    // The context is made here, inside the click, before anything is
    // awaited: the permission prompt can take seconds, and a context made
    // after it has lost the click's user activation and stays suspended,
    // silently delivering nothing (measured: zero samples in headless Chrome).
    var C = window.AudioContext || window.webkitAudioContext;
    try { ctx = new C({ sampleRate: SR }); } catch (e) { ctx = new C(); }
    ctx.resume();
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    } catch (e) {
      try { ctx.close(); } catch (e2) {}
      ctx = null;
      CV.setStatus(statusEl, 'warn', e && e.name === 'NotAllowedError'
        ? 'Microphone permission was refused. Allow it from the address bar and press the button again.'
        : 'No microphone could be opened (' + ((e && e.message) || e) + ').');
      return;
    }
    // A 16 kHz context lets the browser do the conversion; Firefox refuses to
    // connect a microphone to a context at another rate, so fall back to
    // the device rate and resample each block.
    var resample = ctx.sampleRate !== SR ? ctx.sampleRate : null;
    try { ctx.createMediaStreamSource(stream); } catch (e) {
      try { ctx.close(); } catch (e2) {}
      ctx = new C();
      resample = ctx.sampleRate;
    }
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })));
    await ctx.resume();
    var src = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, 'dict-tap');
    var sink = ctx.createGain(); sink.gain.value = 0;
    src.connect(node); node.connect(sink); sink.connect(ctx.destination);
    seg = ASVad.segmenter({
      rate: SR,
      onUtterance: function (u) {
        queue.push(u);
        if (ready) CV.setStatus(statusEl, 'info', listening ? 'Listening… ' + (busy ? 'writing the last phrase' : '') : 'Finishing…');
        next();
      }
    });
    node.port.onmessage = function (e) {
      var x = e.data;
      blocks++;
      if (resample && window.ASResample) x = ASResample.channel(x, resample, SR);
      seg.push(x);
    };
    listening = true;
    startedAt = Date.now();
    micBtn.textContent = '■ Stop';
    micBtn.classList.add('recording');
    micBtn.setAttribute('aria-pressed', 'true');
    CV.setStatus(statusEl, 'info', ready ? 'Listening… speak, then pause; the text appears after each phrase.' : 'Listening — loading the speech model for the first phrase (once, then cached)…');
    meter();
  }

  function stop() {
    listening = false;
    if (seg) seg.flush();
    try { node && node.disconnect(); } catch (e) {}
    try { stream && stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    try { ctx && ctx.close(); } catch (e) {}
    node = null; stream = null; ctx = null;
    cancelAnimationFrame(raf);
    if (meterEl) meterEl.style.width = '0%';
    micBtn.textContent = '● Start dictating';
    micBtn.classList.remove('recording');
    micBtn.setAttribute('aria-pressed', 'false');
    if (!busy && !queue.length) CV.setStatus(statusEl, 'success', 'Stopped. ' + words() + ' words so far — edit, copy or download them below.');
    else CV.setStatus(statusEl, 'info', 'Finishing the last phrase…');
  }

  function meter() {
    if (!listening || !seg) return;
    var db = 20 * Math.log10(Math.max(1e-5, seg.level()));
    if (meterEl) {
      meterEl.style.width = Math.max(0, Math.min(100, (db + 60) / 60 * 100)) + '%';
      meterEl.classList.toggle('on', seg.speaking());
    }
    raf = requestAnimationFrame(meter);
  }

  micBtn.addEventListener('click', function () { if (listening) stop(); else start(); });

  /* ------------------------------------------------------------ output */

  if (copyBtn) copyBtn.addEventListener('click', function () {
    var done = function () { copyBtn.textContent = 'copied'; setTimeout(function () { copyBtn.textContent = 'copy text'; }, 1500); };
    if (navigator.clipboard) navigator.clipboard.writeText(textEl.value).then(done, function () { textEl.select(); });
    else { textEl.select(); try { document.execCommand('copy'); done(); } catch (e) {} }
  });
  // The .txt download is this page's "conversion": it is what fires
  // convert_success through flow.js.
  if (dlBtn) dlBtn.addEventListener('click', function () {
    if (!textEl.value.trim()) return;
    var stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
    CV.downloadBlob(new Blob([textEl.value], { type: 'text/plain;charset=utf-8' }), 'dictation-' + stamp + '.txt', saved ? { again: true } : undefined);
    saved = true;
  });
  if (clearBtn) clearBtn.addEventListener('click', function () {
    if (textEl.value && !window.confirm('Clear the text? It cannot be undone.')) return;
    textEl.value = ''; keep();
  });

  window.__dict = { start: start, stop: stop, level: function () { return seg ? seg.level() : -1; }, state: function () { return { listening: listening, busy: busy, queue: queue.length, ready: ready, phrases: phrases, blocks: blocks, ctx: ctx && ctx.state, rate: ctx && ctx.sampleRate }; } };
})();
