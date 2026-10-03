/*
 * /video-dubbing page controller.
 *
 *   1. decode the video's soundtrack (AudioSaw), fold it to 16 kHz mono;
 *   2. Whisper (transcribe-worker.js, unmodified) gives timed phrases,
 *      transcribed or translated into English;
 *   3. the phrases are joined into lines (ASDub.merge); for a dub into
 *      Spanish, French, Italian, Portuguese or Hindi, the English lines go
 *      through OPUS-MT (translate-worker.js); then they are shown for editing;
 *   4. Kokoro (tts-worker.js) reads each line; ASDub.fit speeds a line that
 *      overruns its slot, up to 1.3x;
 *   5. the original is ducked under the lines, or dropped, and the dub laid
 *      over it at the original's rate;
 *   6. ffmpeg copies the video stream untouched and muxes the new audio in.
 *
 * Whisper's own translation goes only into English, hence the second model
 * for the other five of Kokoro's languages.
 */
(function () {
  'use strict';

  var ASSET_V = (function () {
    var m = document.currentScript && /[?&]v=([^&]+)/.exec(document.currentScript.src);
    return m ? m[1] : (window.AS_VERSION || '1');
  })();

  if (typeof CV === 'undefined' || typeof AudioSaw === 'undefined' || typeof ASTTS === 'undefined' || typeof ASDub === 'undefined' || typeof ASSubs === 'undefined' || typeof ASDiar === 'undefined') {
    console.error('[video-dubbing] the /js/* includes must come before dubbing-page.js');
    return;
  }

  var $ = CV.$;
  var TTS_SR = ASTTS.SAMPLE_RATE;
  var MAX_BYTES = 600 * 1048576;

  var dropzone = $('#dropzone'), fileInput = $('#fileInput'), fileList = $('#fileList');
  var controls = $('#controls'), goBtn = $('#convertBtn'), dubBtn = $('#dubBtn');
  var taskSel = $('#task'), langSel = $('#language'), modelSel = $('#model');
  var voiceSel = $('#voice'), bgSel = $('#background'), perSpk = $('#perSpeaker'), spkBox = $('#speakerVoices');
  var ownVoice = $('#ownVoice'), ownNote = $('#ownVoiceNote');
  var statusEl = $('#status'), progressWrap = $('#progressWrap'), progressBar = $('#progressBar');
  var linesPanel = $('#linesPanel'), linesEl = $('#lines'), resultEl = $('#result'), videoEl = $('#preview');
  var dlVideo = $('#dlVideo'), dlAudio = $('#dlAudio'), dlSrt = $('#dlSrt');
  if (!dropzone || !goBtn) return;

  var file = null, orig = null, lines = null, outputs = null;
  var asr = null, tts = null, seq = 0, waiting = {};
  // Per-speaker voices: speakerVoice[n] is the voice for speaker n.
  // Defaults alternate a man's and a woman's voice, which is what makes two
  // people easy to tell apart in a dub.
  var DEFAULT_VOICES = ['am_michael', 'af_heart', 'bm_george', 'bf_emma', 'am_fenrir', 'af_bella'];
  // The same alternation in the other languages Kokoro speaks. French has
  // one voice, so every speaker shares it.
  var LANG_VOICES = {
    'es': ['em_alex', 'ef_dora', 'em_santa'], 'fr-fr': ['ff_siwis'], 'it': ['im_nicola', 'if_sara'],
    'pt-br': ['pm_alex', 'pf_dora', 'pm_santa'], 'hi': ['hm_omega', 'hf_alpha', 'hm_psi', 'hf_beta']
  };
  var target = null;   // the language the lines were translated into, or null
  var speakerVoice = {}, speakers = 0;
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
      var into = /^to:/.test(taskSel.value) ? taskSel.value.slice(3) : null;
      var done = await call(w, { type: 'run', model: modelSel.value, audio: audio, language: langSel.value, task: into ? 'translate' : taskSel.value }, [audio.buffer]);
      var segs = done.segments;
      spokenLang = String(done.language || langSel.value || '').toLowerCase();
      speakers = 0; speakerVoice = {};
      if (perSpk && perSpk.checked) {
        setProgress(48, 'Telling the speakers apart…');
        var d = await diarizeAudio(Float32Array.from(r16.getChannelData(0)));
        if (d.turns.length) { segs = ASDiar.labelSegments(segs, d.turns); speakers = d.speakers; }
      }
      lines = ASDub.snapStarts(ASDub.merge(segs), r16.getChannelData(0), 16000);
      renderSpeakerVoices();
      if (!lines.length) throw new Error('No speech was found in the soundtrack.');
      // Whisper is done: free its memory before the next model loads.
      asr.terminate(); asr = null;
      target = null;
      if (into) {
        setProgress(49, 'Translating into ' + langName(into) + '…');
        var tr = await translateLines(lines.map(function (l) { return l.text; }), into);
        lines.forEach(function (l, i) { l.en = l.text; l.text = tr[i] || l.text; });
        target = into;
        voiceSel.value = LANG_VOICES[into][0];
        renderSpeakerVoices();
      }
      renderLines();
      CV.setProgress(progressBar, 50);
      CV.setStatus(statusEl, 'success', lines.length + ' lines. Check the wording below, then make the dub.');
      linesPanel.hidden = false;
      linesPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      gateOwnVoice();
      if (!useOwn()) voice();   // start the voice model downloading while they read
    } catch (e) {
      CV.setStatus(statusEl, 'error', 'Could not transcribe the video. ' + (e.message || e), e);
    }
    document.title = baseTitle;
    goBtn.disabled = false;
  }

  function diarizeAudio(audio) {
    return new Promise(function (resolve, reject) {
      var w = new Worker('/js/diarize-worker.js?v=' + ASSET_V, { type: 'module' });
      w.onmessage = function (e) {
        var m = e.data || {};
        if (m.type === 'status') CV.setStatus(statusEl, 'info', m.detail);
        else if (m.type === 'done') { w.terminate(); resolve(m); }
        else if (m.type === 'error') { w.terminate(); reject(new Error(m.message)); }
      };
      w.postMessage({ type: 'run', audio: audio, speakers: 0 }, [audio.buffer]);
    });
  }

  function langName(code) {
    var l = ASTTS.LANGS.filter(function (x) { return x[0] === code; })[0];
    return l ? l[1] : code;
  }

  function translateLines(texts, lang) {
    return new Promise(function (resolve, reject) {
      var w = new Worker('/js/translate-worker.js?v=' + ASSET_V);
      w.onmessage = function (e) {
        var m = e.data || {};
        if (m.type === 'status') CV.setStatus(statusEl, 'info', m.detail);
        else if (m.type === 'done') { w.terminate(); resolve(m.lines); }
        else if (m.type === 'error') { w.terminate(); reject(new Error(m.message)); }
      };
      w.onerror = function (e) { w.terminate(); reject(new Error((e && e.message) || 'The translation worker failed to start.')); };
      w.postMessage({ type: 'run', lang: lang, lines: texts });
    });
  }

  function renderSpeakerVoices() {
    if (!spkBox) return;
    spkBox.innerHTML = '';
    spkBox.hidden = speakers < 2;
    for (var k = 1; k <= speakers; k++) {
      var l = document.createElement('label'), sel = document.createElement('select');
      ASTTS.fillVoiceSelect(sel, false);
      var pool = (target && LANG_VOICES[target]) || DEFAULT_VOICES;
      sel.value = speakerVoice[k] = pool[(k - 1) % pool.length];
      sel.dataset.k = k;
      sel.addEventListener('change', function () { speakerVoice[this.dataset.k] = this.value; });
      l.appendChild(document.createTextNode('Speaker ' + k + ' '));
      l.appendChild(sel);
      spkBox.appendChild(l);
    }
  }

  function renderLines() {
    linesEl.innerHTML = '';
    lines.forEach(function (ln, i) {
      var row = document.createElement('div');
      row.className = 'dub-line';
      var t = document.createElement('span');
      t.className = 'dub-time';
      t.textContent = fmtT(ln.start) + '–' + fmtT(ln.end) + (speakers > 1 && ln.speaker ? ' · Speaker ' + ln.speaker : '');
      var ta = document.createElement('textarea');
      ta.rows = 2; ta.value = ln.text; ta.setAttribute('aria-label', 'Line ' + (i + 1) + ' at ' + fmtT(ln.start));
      var cell = ta;
      if (ln.en) {
        ta.lang = target === 'fr-fr' ? 'fr' : target === 'pt-br' ? 'pt-BR' : target;
        cell = document.createElement('div');
        var en = document.createElement('small');
        en.className = 'dub-en'; en.lang = 'en'; en.textContent = ln.en;
        cell.appendChild(ta); cell.appendChild(en);
      }
      ta.addEventListener('input', function () { ln.text = ta.value; });
      var st = document.createElement('span');
      st.className = 'dub-state';
      ln.stateEl = st;
      row.appendChild(t); row.appendChild(cell); row.appendChild(st);
      linesEl.appendChild(row);
    });
  }

  /* ------------------------------------------------------------ step 4-6 */

  /* ------------------------------------------- each speaker's own voice */

  // "Use each speaker's own voice": Chatterbox Turbo (clone-worker.js, the
  // /voice-cloning model) reads every line in a voice cloned from that
  // speaker's own lines in the video. English only, WebGPU only; the box is
  // the same consent the cloning page asks for.
  var spokenLang = '', cloner = null, cloneWait = {}, cloneSeq = 0;
  function englishOut() {
    if (target) return false;
    if (taskSel.value === 'translate') return true;
    return /^(en|english)$/.test(spokenLang) || langSel.value === 'en';
  }
  function useOwn() { return !!(ownVoice && ownVoice.checked && navigator.gpu && englishOut()); }
  function gateOwnVoice() {
    if (!ownVoice) return;
    var why = !navigator.gpu ? 'needs WebGPU (desktop Chrome or Edge)' : (lines && !englishOut() ? 'speaks English only, so it is off for this dub' : '');
    ownVoice.disabled = !!why;
    if (why) ownVoice.checked = false;
    if (ownNote) ownNote.textContent = why ? 'Voice cloning ' + why + '.' : '';
  }
  if (ownVoice) { gateOwnVoice(); [taskSel, langSel].forEach(function (s) { s.addEventListener('change', gateOwnVoice); }); }

  function clonerWorker() {
    if (cloner) return cloner;
    cloner = new Worker('/js/clone-worker.js?v=' + ASSET_V, { type: 'module' });
    cloner.onmessage = function (e) {
      var m = e.data || {};
      if (m.type === 'status') CV.setStatus(statusEl, 'info', m.detail);
      var key = m.type === 'referenced' ? 'ref' : m.seq;
      if (m.type === 'error' && !cloneWait[key]) key = Object.keys(cloneWait)[0];
      if ((m.type === 'referenced' || m.type === 'audio' || m.type === 'error') && cloneWait[key]) {
        var w = cloneWait[key]; delete cloneWait[key];
        if (m.type === 'error') w.reject(new Error(m.message || 'Voice cloning failed.')); else w.resolve(m);
      }
    };
    cloner.postMessage({ type: 'load' });
    return cloner;
  }
  function cloneCall(key, msg, transfer) {
    return new Promise(function (resolve, reject) { cloneWait[key] = { resolve: resolve, reject: reject }; clonerWorker().postMessage(msg, transfer || []); });
  }

  // About five seconds of one speaker's own speech, from their longest lines
  // in the original: mono, 24 kHz, silence trimmed, levelled. Null when the
  // speaker says less than three seconds in the whole video.
  async function referenceFor(list, mono24) {
    var parts = [], have = 0;
    list.slice().sort(function (a, b) { return (b.end - b.start) - (a.end - a.start); }).forEach(function (l) {
      if (have >= 5.5 * TTS_SR) return;
      var x = ASTTS.trimSilence(mono24.subarray(Math.floor(l.start * TTS_SR), Math.min(mono24.length, Math.ceil(l.end * TTS_SR))), 0.01, Math.round(0.08 * TTS_SR));
      if (x.length > 0.4 * TTS_SR) { parts.push(x); have += x.length; }
    });
    if (have < 3 * TTS_SR) return null;
    var out = new Float32Array(Math.min(have, 5 * TTS_SR)), o = 0;
    for (var i = 0; i < parts.length && o < out.length; i++) { var n = Math.min(parts[i].length, out.length - o); out.set(parts[i].subarray(0, n), o); o += n; }
    var pk = 0; for (var j = 0; j < out.length; j++) pk = Math.max(pk, Math.abs(out[j]));
    if (pk > 0) for (var k = 0; k < out.length; k++) out[k] *= 0.9 / pk;
    return out;
  }

  // Every line in its own speaker's cloned voice, grouped by speaker so the
  // reference is encoded once each. Returns { samples: [per line], fallback }.
  async function cloneAll(live) {
    var mono = orig.numberOfChannels > 1 ? await AudioSaw.mixToMono(orig) : orig;
    var m24 = (await AudioSaw.resampleBuffer(mono, TTS_SR)).getChannelData(0);
    var groups = {};
    live.forEach(function (l, i) { var k = speakers > 1 && l.speaker ? l.speaker : 0; (groups[k] = groups[k] || []).push(i); });
    var out = new Array(live.length), fallback = [], done = 0;
    for (var k in groups) {
      var ref = await referenceFor(groups[k].map(function (i) { return live[i]; }), m24);
      if (!ref) { fallback.push(k); continue; }
      setProgress(50 + 40 * done / live.length, 'Listening to ' + (k > 0 ? 'speaker ' + k : 'the speaker') + '\'s voice…');
      await cloneCall('ref', { type: 'reference', audio: ref }, [ref.buffer]);
      for (var g = 0; g < groups[k].length; g++) {
        var i = groups[k][g];
        setProgress(50 + 40 * done / live.length, 'Cloning line ' + (done + 1) + ' of ' + live.length + (k > 0 ? ' (speaker ' + k + ')' : '') + '…');
        var s = ++cloneSeq, r = await cloneCall(s, { type: 'synth', seq: s, text: live[i].text });
        var x = ASTTS.trimSilence(r.samples), y = new Float32Array(x.length); y.set(x);
        out[i] = y; done++;
      }
    }
    return { samples: out, fallback: fallback };
  }

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
      var cloned = useOwn() ? await cloneAll(live) : null;
      if (cloned && cloned.fallback.length) CV.setStatus(statusEl, 'warn', (cloned.fallback[0] > 0 ? 'Speaker ' + cloned.fallback.join(', ') : 'The speaker') + ' says less than three seconds, too little to clone; a built-in voice reads those lines.');
      for (var i = 0; i < live.length; i++) {
        var vid = speakers > 1 && live[i].speaker ? (speakerVoice[live[i].speaker] || id) : id;
        var x, f;
        if (cloned && cloned.samples[i]) {
          // The cloning model has no speed input: an overlong line is
          // time-stretched at the same pitch instead (PSOLA, ASVoice.stretch).
          x = cloned.samples[i];
          f = ASDub.fit(live, i, x.length / TTS_SR, total);
          if (f.speed > 1) x = ASVoice.stretch([x], TTS_SR, 1 / f.speed)[0];
        } else {
          setProgress(50 + 40 * i / live.length, 'Voicing line ' + (i + 1) + ' of ' + live.length + '…');
          x = await speak(live[i].text, vid, 1);
          f = ASDub.fit(live, i, x.length / TTS_SR, total);
          if (f.speed > 1) x = await speak(live[i].text, vid, f.speed);
        }
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
      // Labelled in its own tags, as every voice this site makes is.
      outputs.audio = new Blob([ASTTS.tagMp3(new Uint8Array(await outputs.audio.arrayBuffer()), {
        title: base + ' (dubbed)', software: 'AudioSaw video dubbing',
        comment: cloned ? 'Dubbed with cloned synthetic voices (Chatterbox Turbo) at audiosaw.com/video-dubbing' : 'Dubbed with synthetic speech (Kokoro-82M) at audiosaw.com/video-dubbing'
      })], { type: 'audio/mpeg' });
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
      window.__dub = { cloned: !!cloned, outputs: outputs, placed: placed, lines: live.map(function (l) { return { text: l.text, start: l.start, end: l.end, speaker: l.speaker || 0, voice: speakers > 1 && l.speaker ? speakerVoice[l.speaker] : voiceSel.value }; }) };
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
  dlSrt.addEventListener('click', function () { if (outputs) save(new Blob([outputs.srt], { type: 'application/x-subrip;charset=utf-8' }), outputs.base + '-' + (target || (taskSel.value === 'translate' ? 'en' : (langSel.value === 'auto' ? 'dub' : langSel.value))) + '.srt'); });

  window.__dubPage = { transcribe: transcribe, dub: dub, setLines: function (l) { lines = ASDub.merge(l); renderLines(); linesPanel.hidden = false; }, state: function () { return { file: !!file, orig: !!orig, lines: lines && lines.length }; } };
})();
