/*
 * /voice-cloning page controller.
 *
 * A reference clip (recorded here, or a file) is folded to mono, resampled
 * to 24 kHz with the sinc resampler, trimmed of silence and capped at
 * MAX_REF seconds, then encoded once by clone-worker.js. The text is split
 * into sentences (ASTTS.chunk) and each is generated in the cloned voice and
 * played as it arrives, as on /text-to-speech.
 *
 * Nothing works until the consent box is ticked, and every file written says
 * in its tags that it is a cloned, synthetic voice.
 */
(function () {
  'use strict';

  var ASSET_V = (function () {
    var m = document.currentScript && /[?&]v=([^&]+)/.exec(document.currentScript.src);
    return m ? m[1] : (window.AS_VERSION || '1');
  })();
  if (typeof CV === 'undefined' || typeof AudioSaw === 'undefined' || typeof ASTTS === 'undefined') {
    console.error('[voice-cloning] the /js/* includes must come before clone-page.js');
    return;
  }

  var $ = CV.$;
  var SR = 24000, MIN_REF = 4, MAX_REF = 15;
  var consent = $('#consent'), recBtn = $('#recBtn'), dropzone = $('#dropzone'), fileInput = $('#fileInput');
  var refInfo = $('#refInfo'), refPlay = $('#refPlay'), textEl = $('#cloneText'), goBtn = $('#convertBtn');
  var stopBtn = $('#stopBtn'), dlBtn = $('#dlBtn'), fmtSel = $('#format'), statusEl = $('#status');
  var progressWrap = $('#progressWrap'), progressBar = $('#progressBar'), envEl = $('#envNote'), stepTwo = $('#stepTwo');
  if (!consent || !goBtn) return;

  var worker = null, ready = false, refAudio = null, refEncoded = false, seq = 0, waiting = {};
  var ctx = null, playAt = 0, playing = [], result = null, running = false, downloadedOnce = false;
  var baseTitle = document.title;

  function gate() {
    var ok = consent.checked;
    [recBtn, fileInput].forEach(function (el) { if (el) el.disabled = !ok; });
    dropzone.classList.toggle('disabled', !ok);
    goBtn.disabled = !ok || !refAudio || !textEl.value.trim() || running;
  }
  consent.addEventListener('change', gate);
  textEl.addEventListener('input', gate);

  /* -------------------------------------------------------------- worker */

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker('/js/clone-worker.js?v=' + ASSET_V);
    worker.onmessage = function (e) {
      var m = e.data || {};
      if (m.type === 'status') { progressWrap.style.display = ''; CV.setProgress(progressBar, m.pct * 0.5); CV.setStatus(statusEl, 'info', m.detail); }
      else if (m.type === 'ready') { ready = true; envEl.textContent = 'The cloning model is running on your GPU.'; }
      else if (m.type === 'referenced') settle('ref', m, true);
      else if (m.type === 'progress' && running) CV.setStatus(statusEl, 'info', running.label + ' — ' + Math.round(m.tokens / 25) + ' s of speech so far');
      else if (m.type === 'audio') settle(m.seq, m, true);
      else if (m.type === 'error') settle(m.seq != null && waiting[m.seq] ? m.seq : (waiting.ref ? 'ref' : Object.keys(waiting)[0]), m, false);
    };
    worker.onerror = function (e) { CV.setStatus(statusEl, 'error', 'The cloning worker could not start' + (e && e.message ? ' (' + e.message + ')' : '') + '.'); };
    worker.postMessage({ type: 'load' });
    return worker;
  }
  function settle(key, m, ok) {
    var w = waiting[key]; if (!w) { if (!ok) CV.setStatus(statusEl, 'error', m.message); return; }
    delete waiting[key];
    if (ok) w.resolve(m); else w.reject(new Error(m.message));
  }
  function call(key, msg, transfer) {
    return new Promise(function (resolve, reject) { waiting[key] = { resolve: resolve, reject: reject }; ensureWorker().postMessage(msg, transfer || []); });
  }

  /* ----------------------------------------------------------- reference */

  // Mono, 24 kHz, leading/trailing silence off, at most MAX_REF seconds:
  // the speaker encoder wants clean speech, and more than ~15 s adds
  // compute without improving the likeness.
  async function useReference(buf, label) {
    var mono = buf.numberOfChannels > 1 ? await AudioSaw.mixToMono(buf) : buf;
    var r = mono.sampleRate === SR ? mono : await AudioSaw.resampleBuffer(mono, SR);
    var x = ASTTS.trimSilence(r.getChannelData(0), 0.01, Math.round(0.1 * SR));
    if (x.length < MIN_REF * SR) throw new Error('That clip has ' + (x.length / SR).toFixed(1) + ' s of speech. Give it at least ' + MIN_REF + ' seconds — ten is better.');
    if (x.length > MAX_REF * SR) x = x.subarray(0, MAX_REF * SR);
    var peak = 0; for (var i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
    refAudio = new Float32Array(x.length);
    for (var j = 0; j < x.length; j++) refAudio[j] = x[j] * (peak > 0 ? 0.9 / peak : 1);
    refEncoded = false;
    refInfo.textContent = label + ': ' + (refAudio.length / SR).toFixed(1) + ' s of speech will be used.';
    if (refPlay) refPlay.hidden = false;
    stepTwo.hidden = false;
    if (CV.signal) CV.signal.input('Reference voice — ' + (refAudio.length / SR).toFixed(1) + ' s, ' + label);
    ensureWorker();
    gate();
  }

  CV.bindDropzone(dropzone, fileInput, async function (files) {
    if (!consent.checked) return;
    try {
      var b = await AudioSaw.decodeToAudioBuffer(files[0]);
      await useReference(b, files[0].name);
      CV.clearStatus(statusEl);
    } catch (e) { CV.setStatus(statusEl, 'error', 'Could not use that clip. ' + (e.message || e), e); }
  }, ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.webm', '.aif', '.aiff', '.caf', '.mp4', '.mov']);

  // Recording: the context is made inside the click (see dictation-page.js:
  // made after the permission prompt, it stays suspended and records zeros).
  var rec = null;
  if (recBtn) recBtn.addEventListener('click', async function () {
    if (rec) { rec.stop(); return; }
    var C = window.AudioContext || window.webkitAudioContext, c = new C();
    c.resume();
    var stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } }); }
    catch (e) { c.close(); CV.setStatus(statusEl, 'warn', 'The microphone could not be opened (' + ((e && e.message) || e) + ').', e); return; }
    var src = c.createMediaStreamSource(stream), proc = c.createScriptProcessor(4096, 1, 1), chunks = [], t0 = Date.now();
    var sink = c.createGain(); sink.gain.value = 0;
    proc.onaudioprocess = function (ev) { chunks.push(new Float32Array(ev.inputBuffer.getChannelData(0))); };
    src.connect(proc); proc.connect(sink); sink.connect(c.destination);
    recBtn.textContent = '■ Stop (0 s)';
    var tick = setInterval(function () {
      var s = Math.round((Date.now() - t0) / 1000);
      recBtn.textContent = '■ Stop (' + s + ' s)';
      if (s >= MAX_REF + 1) rec.stop();
    }, 250);
    rec = {
      stop: async function () {
        clearInterval(tick);
        rec = null;
        recBtn.textContent = '● Record 10 seconds';
        stream.getTracks().forEach(function (t) { t.stop(); });
        var n = chunks.reduce(function (a, x) { return a + x.length; }, 0), all = new Float32Array(n), off = 0;
        chunks.forEach(function (x) { all.set(x, off); off += x.length; });
        var rate = c.sampleRate;
        c.close();
        try { await useReference(AudioSaw.makeBuffer([all], rate), 'Your recording'); CV.clearStatus(statusEl); }
        catch (e) { CV.setStatus(statusEl, 'warn', e.message); }
      }
    };
  });

  if (refPlay) refPlay.addEventListener('click', function () { if (refAudio) play(refAudio, true); });

  /* ------------------------------------------------------------ playback */

  function audioCtx() {
    if (!ctx) { var C = window.AudioContext || window.webkitAudioContext; ctx = new C(); }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function play(x, now) {
    var c = audioCtx(), b = c.createBuffer(1, x.length, SR);
    b.getChannelData(0).set(x);
    var s = c.createBufferSource(); s.buffer = b; s.connect(c.destination);
    var t = now ? c.currentTime + 0.05 : Math.max(c.currentTime + 0.05, playAt);
    s.start(t);
    if (!now) playAt = t + b.duration;
    playing.push(s);
  }

  /* ------------------------------------------------------------ generate */

  async function generate() {
    var chunks = ASTTS.chunk(textEl.value);
    if (!chunks.length || !refAudio) return;
    running = { label: 'Speaking' };
    gate();
    stopBtn.disabled = false; dlBtn.disabled = true; result = null;
    progressWrap.style.display = '';
    audioCtx();
    var t0 = Date.now(), parts = [];
    try {
      if (!refEncoded) {
        CV.setStatus(statusEl, 'info', ready ? 'Listening to the reference voice…' : 'Loading the cloning model…');
        var a = refAudio.slice();
        await call('ref', { type: 'reference', audio: a }, [a.buffer]);
        refEncoded = true;
      }
      for (var i = 0; i < chunks.length; i++) {
        if (!running) throw new Error('stopped');
        running.label = 'Sentence ' + (i + 1) + ' of ' + chunks.length;
        CV.setStatus(statusEl, 'info', running.label + '…');
        CV.setProgress(progressBar, 50 + 50 * i / chunks.length);
        document.title = '(' + Math.round(100 * i / chunks.length) + '%) ' + baseTitle;
        var k = ++seq;
        var m = await call(k, { type: 'synth', seq: k, text: chunks[i].text });
        var x = ASTTS.trimSilence(m.samples), piece = new Float32Array(x.length);
        piece.set(x);
        parts.push(piece, new Float32Array(Math.round(chunks[i].pause * SR)));
        play(piece);
        play(new Float32Array(Math.round(chunks[i].pause * SR)));
      }
      var n = parts.reduce(function (s, p) { return s + p.length; }, 0), all = new Float32Array(n), off = 0;
      parts.forEach(function (p) { all.set(p, off); off += p.length; });
      result = all;
      CV.setProgress(progressBar, 100);
      dlBtn.disabled = false;
      CV.setStatus(statusEl, 'success', 'Done: ' + (all.length / SR).toFixed(1) + ' s of speech in ' + Math.round((Date.now() - t0) / 1000) + ' s. Download it below.');
    } catch (e) {
      if (/stopped|cancelled/.test(e.message)) CV.setStatus(statusEl, 'info', 'Stopped.');
      else CV.setStatus(statusEl, 'error', 'Voice cloning failed. ' + (e.message || e), e);
    }
    running = false;
    document.title = baseTitle;
    stopBtn.disabled = true;
    gate();
  }

  goBtn.addEventListener('click', function () { if (consent.checked) generate(); });
  stopBtn.addEventListener('click', function () {
    running = false;
    if (worker) worker.postMessage({ type: 'cancel' });
    playing.forEach(function (s) { try { s.stop(); } catch (e) {} }); playing = []; playAt = 0;
  });

  dlBtn.addEventListener('click', async function () {
    if (!result) return;
    var fmt = fmtSel ? fmtSel.value : 'mp3';
    var blob = await AudioSaw.encode(AudioSaw.makeBuffer([result], SR), fmt, { bitrate: 192 });
    var bytes = new Uint8Array(await blob.arrayBuffer());
    var tag = { title: textEl.value.trim().slice(0, 80), artist: 'Cloned voice (synthetic)', software: 'AudioSaw voice cloning (Chatterbox Turbo)',
      comment: 'Synthetic speech in a cloned voice, generated at audiosaw.com/voice-cloning with the speaker\'s stated consent' };
    if (fmt === 'mp3') bytes = ASTTS.tagMp3(bytes, tag); else if (fmt === 'wav16') bytes = ASTTS.tagWav(bytes, tag);
    CV.downloadBlob(new Blob([bytes], { type: blob.type }), 'cloned-voice.' + AudioSaw.extFor(fmt), downloadedOnce ? { again: true } : undefined);
    downloadedOnce = true;
  });

  if (envEl) {
    if (!navigator.gpu) envEl.textContent = 'This browser has no WebGPU, which voice cloning needs. Use current Chrome or Edge on a desktop or laptop.';
    else envEl.textContent = 'The first run downloads the cloning model (about 560 MB) and keeps it.';
  }
  gate();

  window.__clone = {
    setReference: function (x, rate) { consent.checked = true; return useReference(AudioSaw.makeBuffer([x], rate), 'test'); },
    generate: generate, result: function () { return result; }, state: function () { return { running: !!running, ready: ready, ref: !!refAudio }; }
  };
})();
