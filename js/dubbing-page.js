/*
 * /video-dubbing page controller.
 *
 *   1. decode the video's soundtrack (AudioSaw), fold it to 16 kHz mono;
 *   2. Whisper (transcribe-worker.js, unmodified) gives timed phrases,
 *      transcribed or translated into English;
 *   3. the phrases are joined into lines (ASDub.merge) and shown for editing;
 *   4. Kokoro (tts-worker.js) reads each line; ASDub.fit speeds a line that
 *      overruns its slot, up to 1.3x;
 *   5. the original is ducked under the lines, or dropped, and the dub laid
 *      over it at the original's rate;
 *   6. ffmpeg copies the video stream untouched and muxes the new audio in.
 *
 * English output only: Kokoro's voices on this site are English, and
 * Whisper's own translation goes only into English.
 */
(function () {
  'use strict';

  var ASSET_V = (function () {
    var m = document.currentScript && /[?&]v=([^&]+)/.exec(document.currentScript.src);
    return m ? m[1] : (window.AS_VERSION || '1');
  })();

  if (typeof CV === 'undefined' || typeof AudioSaw === 'undefined' || typeof ASTTS === 'undefined' || typeof ASDub === 'undefined' || typeof ASSubs === 'undefined') {
    console.error('[video-dubbing] the /js/* includes must come before dubbing-page.js');
    return;
  }

  var $ = CV.$;
  var TTS_SR = ASTTS.SAMPLE_RATE;
  var MAX_BYTES = 600 * 1048576;

  var dropzone = $('#dropzone'), fileInput = $('#fileInput'), fileList = $('#fileList');
  var controls = $('#controls'), goBtn = $('#convertBtn'), dubBtn = $('#dubBtn');
  var taskSel = $('#task'), langSel = $('#language'), modelSel = $('#model');
  var voiceSel = $('#voice'), bgSel = $('#background');
  var statusEl = $('#status'), progressWrap = $('#progressWrap'), progressBar = $('#progressBar');
  var linesPanel = $('#linesPanel'), linesEl = $('#lines'), resultEl = $('#result'), videoEl = $('#preview');
  var dlVideo = $('#dlVideo'), dlAudio = $('#dlAudio'), dlSrt = $('#dlSrt');
  if (!dropzone || !goBtn) return;

  var file = null, orig = null, lines = null, outputs = null;
  var asr = null, tts = null, seq = 0, waiting = {};
  var baseTitle = document.title;

  ASTTS.fillVoiceSelect(voiceSel, false);
  voiceSel.value = 'am_michael';
  CV.remember(voiceSel, 'as_dub_voice');
  CV.remember(bgSel, 'as_dub_bg');

  function setProgress(pct, msg) {
    progressWrap.style.display = '';
    CV.setProgress(progressBar, pct);
    if (msg) CV.setStatus(statusEl, 'info', msg);
    document.title = '(' + Math.round(pct) + '%) ' + baseTitle;
  }
  function fmtT(s) { var m = Math.floor(s / 60); return m + ':' + ('0' + (s - m * 60).toFixed(1)).slice(-4); }

  /* ---------------------------------------------------------- workers */

  function call(w, msg, transfer) {
    var s = ++seq;
    msg.seq = s;
    return new Promise(function (resolve, reject) {
      waiting[s] = { resolve: resolve, reject: reject };
      w.postMessage(msg, transfer || []);
    });
  }
  function settle(m, ok) {
    var key = m.seq != null && waiting[m.seq] ? m.seq : Object.keys(waiting)[0];
    if (key == null || !waiting[key]) return;
    var p = waiting[key]; delete waiting[key];
    if (ok) p.resolve(m); else p.reject(new Error(m.message || 'failed'));
  }

  function whisper() {
    if (asr) return asr;
    asr = new Worker('/js/transcribe-worker.js?v=' + ASSET_V, { type: 'module' });
    asr.onmessage = function (e) {
      var m = e.data || {};
      if (m.type === 'status') setProgress(m.phase === 'model' ? m.pct * 0.25 : 25 + m.pct * 0.25, m.detail);
      else if (m.type === 'done') settle(m, true);
      else if (m.type === 'error') settle(m, false);
    };
    return asr;
  }
  function voice() {
    if (tts) return tts;
    tts = new Worker('/js/tts-worker.js?v=' + ASSET_V + (/[?&]backend=wasm\b/.test(location.search) ? '&backend=wasm' : ''));
    tts.onmessage = function (e) {
      var m = e.data || {};
      if (m.type === 'status') CV.setStatus(statusEl, 'info', m.detail);
      else if (m.type === 'audio') settle(m, true);
      else if (m.type === 'error') settle(m, false);
    };
    tts.postMessage({ type: 'load' });
    return tts;
  }

  /* ------------------------------------------------------------ step 1-3 */

  function onFiles(picked) {
    var f = picked && picked[0];
    if (!f) return;
    if (f.size > MAX_BYTES) {
      CV.setStatus(statusEl, 'error', 'That file is ' + Math.round(f.size / 1048576) + ' MB. Over about 600 MB the browser runs out of memory putting the video back together; trim it first.');
      return;
    }
    file = f; orig = null; lines = null; outputs = null;
    fileList.style.display = '';
    CV.renderFileList(fileList, [f], function () { file = null; fileList.innerHTML = ''; controls.style.display = 'none'; });
    controls.style.display = '';
    goBtn.disabled = false;
    linesPanel.hidden = true; resultEl.hidden = true;
  }
  CV.bindDropzone(dropzone, fileInput, onFiles, ['.mp4', '.mov', '.webm', '.m4v', '.mkv', '.mp3', '.wav', '.m4a']);

  async function transcribe() {
    goBtn.disabled = true;
    try {
      setProgress(1, 'Reading the soundtrack…');
      orig = await AudioSaw.decodeToAudioBuffer(file);
      var mono = orig.numberOfChannels > 1 ? await AudioSaw.mixToMono(orig) : orig;
      var r16 = await AudioSaw.resampleBuffer(mono, 16000);
      var audio = Float32Array.from(r16.getChannelData(0));
      var w = whisper();
      w.postMessage({ type: 'load', model: modelSel.value });
      var done = await call(w, { type: 'run', model: modelSel.value, audio: audio, language: langSel.value, task: taskSel.value }, [audio.buffer]);
      lines = ASDub.snapStarts(ASDub.merge(done.segments), r16.getChannelData(0), 16000);
      if (!lines.length) throw new Error('No speech was found in the soundtrack.');
      // Whisper is done: free its memory before Kokoro loads.
      asr.terminate(); asr = null;
      renderLines();
      CV.setProgress(progressBar, 50);
      CV.setStatus(statusEl, 'success', lines.length + ' lines. Check the wording below, then make the dub.');
      linesPanel.hidden = false;
      linesPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      voice();   // start the voice model downloading while they read
    } catch (e) {
      CV.setStatus(statusEl, 'error', 'Could not transcribe the video. ' + (e.message || e), e);
    }
    document.title = baseTitle;
    goBtn.disabled = false;
  }

  function renderLines() {
    linesEl.innerHTML = '';
    lines.forEach(function (ln, i) {
      var row = document.createElement('div');
      row.className = 'dub-line';
      var t = document.createElement('span');
      t.className = 'dub-time';
      t.textContent = fmtT(ln.start) + '–' + fmtT(ln.end);
      var ta = document.createElement('textarea');
      ta.rows = 2; ta.value = ln.text; ta.setAttribute('aria-label', 'Line ' + (i + 1) + ' at ' + fmtT(ln.start));
      ta.addEventListener('input', function () { ln.text = ta.value; });
      var st = document.createElement('span');
      st.className = 'dub-state';
      ln.stateEl = st;
      row.appendChild(t); row.appendChild(ta); row.appendChild(st);
      linesEl.appendChild(row);
    });
  }

  /* ------------------------------------------------------------ step 4-6 */

  async function speak(text, id, speed) {
    var m = await call(voice(), { type: 'synth', job: 1, text: text, lang: ASTTS.voice(id).lang, mix: [{ id: id, w: 1 }], speed: speed });
    var x = ASTTS.trimSilence(m.samples);
    var out = new Float32Array(x.length); out.set(x);
    return out;
  }

  async function dub() {
    dubBtn.disabled = true; goBtn.disabled = true;
    var t0 = Date.now(), id = voiceSel.value, total = orig.duration;
    try {
      var live = lines.filter(function (l) { return l.text.trim(); });
      var placed = [], dub24 = new Float32Array(Math.ceil(total * TTS_SR) + TTS_SR * 4), over = 0;
      for (var i = 0; i < live.length; i++) {
        setProgress(50 + 40 * i / live.length, 'Voicing line ' + (i + 1) + ' of ' + live.length + '…');
        var x = await speak(live[i].text, id, 1);
        var f = ASDub.fit(live, i, x.length / TTS_SR, total);
        if (f.speed > 1) x = await speak(live[i].text, id, f.speed);
        var a = Math.round(f.start * TTS_SR);
        if (a + x.length > dub24.length) x = x.subarray(0, Math.max(0, dub24.length - a));
        dub24.set(x, a);
        placed.push({ start: f.start, seconds: x.length / TTS_SR });
        if (f.overflow > 0.2) over++;
        live[i].stateEl.textContent = (f.speed > 1.01 ? f.speed.toFixed(2) + '× ' : '') + (f.overflow > 0.2 ? '· runs ' + f.overflow.toFixed(1) + ' s over' : '✓');
      }
      setProgress(91, 'Mixing…');
      var rate = orig.sampleRate;
      var dubBuf = await AudioSaw.resampleBuffer(AudioSaw.makeBuffer([dub24], TTS_SR), rate);
      var dubX = dubBuf.getChannelData(0);
      var chans = CV.channelsOf(orig);
      var mode = bgSel.value;
      var gain = mode === 'replace' ? new Float32Array(orig.length) : mode === 'keep' ? new Float32Array(orig.length).fill(1)
        : ASDub.duck(orig.length, rate, placed, 18, 0.15);
      var mixed = ASDub.mix(chans, gain, dubX);
      // The dub can extend past the original by a few seconds at most; keep
      // the original's length so the video and audio end together.
      if (window.ASLoudness && ASLoudness.truePeak(mixed) > 0.891) ASLoudness.limit(mixed, rate, Math.pow(10, -1 / 20));
      var mixBuf = AudioSaw.makeBuffer(mixed, rate);
      var srt = ASSubs.toSRT(live.map(function (l) { return { text: l.text, start: l.start, end: l.end }; }), total);
      var base = file.name.replace(/\.[^.]+$/, '');
      outputs = { srt: srt, base: base };
      outputs.audio = await AudioSaw.encode(mixBuf, 'mp3', { bitrate: 192 });
      if (/^video\//.test(file.type) || /\.(mp4|mov|webm|m4v|mkv)$/i.test(file.name)) {
        setProgress(95, 'Putting the new soundtrack on the video…');
        var wav = AudioSaw.floatWav(mixBuf);
        var ext = (file.name.split('.').pop() || 'mp4').toLowerCase();
        outputs.video = await AudioSaw.runFFmpeg(null, null,
          ['-i', 'v.' + ext, '-i', 'a.wav', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart'],
          'mp4', 'video/mp4', function (p) { CV.setProgress(progressBar, 95 + p * 0.05); }, 'Muxing…',
          { raw: true, files: [{ name: 'v.' + ext, data: new Uint8Array(await file.arrayBuffer()) }, { name: 'a.wav', data: new Uint8Array(await wav.arrayBuffer()) }] });
      }
      CV.setProgress(progressBar, 100);
      document.title = baseTitle;
      resultEl.hidden = false;
      if (outputs.video) {
        videoEl.hidden = false;
        videoEl.src = URL.createObjectURL(outputs.video);
        dlVideo.hidden = false;
      } else { videoEl.hidden = true; dlVideo.hidden = true; }
      CV.setStatus(statusEl, 'success', 'Dubbed ' + live.length + ' lines in ' + Math.round((Date.now() - t0) / 1000) + ' s' +
        (over ? '; ' + over + ' line' + (over > 1 ? 's run' : ' runs') + ' past the next — shorten ' + (over > 1 ? 'them' : 'it') + ' and dub again' : '') + '.');
      resultEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      window.__dub = { outputs: outputs, placed: placed, lines: live.map(function (l) { return { text: l.text, start: l.start, end: l.end }; }) };
    } catch (e) {
      CV.setStatus(statusEl, 'error', 'Could not make the dub. ' + (e.message || e), e);
    }
    document.title = baseTitle;
    dubBtn.disabled = false; goBtn.disabled = false;
  }

  goBtn.addEventListener('click', function () { if (file) transcribe(); });
  dubBtn.addEventListener('click', function () { if (lines && orig) dub(); });
  var savedOnce = false;
  function save(blob, name) { CV.downloadBlob(blob, name, savedOnce ? { again: true } : undefined); savedOnce = true; }
  dlVideo.addEventListener('click', function () { if (outputs && outputs.video) save(outputs.video, outputs.base + '-dubbed.mp4'); });
  dlAudio.addEventListener('click', function () { if (outputs) save(outputs.audio, outputs.base + '-dubbed.mp3'); });
  dlSrt.addEventListener('click', function () { if (outputs) save(new Blob([outputs.srt], { type: 'application/x-subrip;charset=utf-8' }), outputs.base + '-english.srt'); });

  window.__dubPage = { transcribe: transcribe, dub: dub, setLines: function (l) { lines = ASDub.merge(l); renderLines(); linesPanel.hidden = false; }, state: function () { return { file: !!file, orig: !!orig, lines: lines && lines.length }; } };
})();
