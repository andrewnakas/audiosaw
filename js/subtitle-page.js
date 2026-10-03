/*
 * /add-subtitles-to-video page controller.
 *
 *   1. the video's soundtrack is decoded and folded to 16 kHz mono;
 *   2. captions come from Whisper (transcribe-worker.js, unmodified), in the
 *      spoken language or translated into English, or from the user's own
 *      SRT/VTT file (ASSubs.parse);
 *   3. "short captions" cuts each cue into 3-5 word pieces (ASSubs.split),
 *      the social-video style; the times are spread by length, not measured;
 *   4. the cues are edited in a list and previewed live on the video through
 *      a <track> built from them;
 *   5. out: burned into the picture (ffmpeg's subtitles filter, libass, with
 *      Noto Sans from /vendor/fonts; the picture is re-encoded with x264), or
 *      added as a subtitle track (stream copy: seconds, no quality change),
 *      plus the SRT and VTT.
 */
(function () {
  'use strict';

  var ASSET_V = (function () {
    var m = document.currentScript && /[?&]v=([^&]+)/.exec(document.currentScript.src);
    return m ? m[1] : '1';
  })();

  if (typeof CV === 'undefined' || typeof AudioSaw === 'undefined' || typeof ASSubs === 'undefined') {
    console.error('[subtitles] the /js/* includes must come before subtitle-page.js');
    return;
  }

  var $ = CV.$;
  var MAX_BYTES = 600 * 1048576;
  var FONT = { file: 'NotoSans-SemiBold.ttf', url: '/vendor/fonts/NotoSans-SemiBold.ttf?v=2.013', name: 'Noto Sans SemiBold' };

  var dropzone = $('#dropzone'), fileInput = $('#fileInput'), fileList = $('#fileList');
  var controls = $('#controls'), goBtn = $('#convertBtn');
  var sourceSel = $('#source'), taskSel = $('#task'), langSel = $('#language'), modelSel = $('#model'), lenSel = $('#length');
  var srtInput = $('#srtInput'), srtBtn = $('#srtBtn'), srtName = $('#srtName');
  var statusEl = $('#status'), progressWrap = $('#progressWrap'), progressBar = $('#progressBar');
  var cuesPanel = $('#cuesPanel'), cuesEl = $('#cues'), videoEl = $('#preview');
  var sizeSel = $('#subSize'), posSel = $('#subPos'), colourSel = $('#subColour'), bgSel = $('#subBg');
  var burnBtn = $('#burnBtn'), softBtn = $('#softBtn'), dlSrt = $('#dlSrt'), dlVtt = $('#dlVtt');
  if (!dropzone || !goBtn) return;

  var file = null, ownSubs = null, cues = null, duration = 0, asr = null, seq = 0, waiting = {}, trackUrl = null, videoUrl = null;
  var baseTitle = document.title;

  [sizeSel, posSel, colourSel, bgSel, lenSel, sourceSel].forEach(function (s, i) { if (s) CV.remember(s, 'as_sub_' + ['size', 'pos', 'col', 'bg', 'len', 'src'][i]); });

  function setProgress(pct, msg) {
    progressWrap.style.display = '';
    CV.setProgress(progressBar, pct);
    if (msg) CV.setStatus(statusEl, 'info', msg);
    document.title = '(' + Math.round(pct) + '%) ' + baseTitle;
  }
  function fmtT(s) { var m = Math.floor(s / 60); return m + ':' + ('0' + (s - m * 60).toFixed(1)).slice(-4); }
  function isVideo(f) { return /^video\//.test(f.type || '') || /\.(mp4|m4v|mov|mkv|webm)$/i.test(f.name); }
  function ext(f) { return ((/\.([^.]+)$/.exec(f.name) || [])[1] || 'mp4').toLowerCase(); }

  /* ------------------------------------------------------------ whisper */

  function call(w, msg, transfer) {
    var s = ++seq; msg.seq = s;
    return new Promise(function (resolve, reject) { waiting[s] = { resolve: resolve, reject: reject }; w.postMessage(msg, transfer || []); });
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
      if (m.type === 'status') setProgress(m.phase === 'model' ? m.pct * 0.5 : 50 + m.pct * 0.45, m.detail);
      else if (m.type === 'done') settle(m, true);
      else if (m.type === 'error') settle(m, false);
    };
    return asr;
  }

  /* -------------------------------------------------------------- input */

  function onFiles(picked) {
    var list = Array.prototype.slice.call(picked || []);
    var sub = list.filter(function (f) { return /\.(srt|vtt)$/i.test(f.name); })[0];
    var vid = list.filter(isVideo)[0];
    if (sub) readSubs(sub);
    if (!vid) { if (!sub) CV.setStatus(statusEl, 'error', 'That is not a video. Drop an MP4, MOV, WebM or MKV, and optionally an SRT or VTT file with it.'); return; }
    if (vid.size > MAX_BYTES) { CV.setStatus(statusEl, 'error', 'That video is ' + Math.round(vid.size / 1048576) + ' MB. Over about 600 MB the browser runs out of memory; trim it first.'); return; }
    file = vid; cues = null;
    fileList.style.display = '';
    CV.renderFileList(fileList, [vid], function () { file = null; fileList.innerHTML = ''; controls.style.display = 'none'; cuesPanel.hidden = true; });
    controls.style.display = '';
    cuesPanel.hidden = true;
    goBtn.disabled = false;
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    videoUrl = URL.createObjectURL(vid);
    videoEl.src = videoUrl;
    syncSource();
  }
  CV.bindDropzone(dropzone, fileInput, onFiles, ['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.srt', '.vtt']);

  function readSubs(f) {
    f.text().then(function (t) {
      var segs = ASSubs.parse(t);
      if (!segs.length) throw new Error('No cues found in ' + f.name + '.');
      ownSubs = segs;
      if (srtName) srtName.textContent = f.name + ': ' + segs.length + ' cues';
      if (sourceSel) sourceSel.value = 'file';
      syncSource();
    }).catch(function (e) { CV.setStatus(statusEl, 'error', 'Could not read that subtitle file. ' + (e.message || e), e); });
  }
  if (srtBtn && srtInput) {
    srtBtn.addEventListener('click', function () { srtInput.click(); });
    srtInput.addEventListener('change', function () { if (srtInput.files[0]) readSubs(srtInput.files[0]); srtInput.value = ''; });
  }
  function syncSource() {
    var own = sourceSel && sourceSel.value === 'file';
    document.querySelectorAll('[data-auto]').forEach(function (el) { el.hidden = own; });
    document.querySelectorAll('[data-own]').forEach(function (el) { el.hidden = !own; });
    goBtn.textContent = own ? 'Use these subtitles' : 'Make the captions';
  }
  if (sourceSel) sourceSel.addEventListener('change', syncSource);

  /* ------------------------------------------------------------- captions */

  async function make() {
    goBtn.disabled = true;
    try {
      var segs;
      if (sourceSel && sourceSel.value === 'file') {
        if (!ownSubs) throw new Error('Choose an SRT or VTT file first.');
        segs = ownSubs;
        duration = await mediaDuration();
      } else {
        setProgress(1, 'Reading the soundtrack…');
        var buf = await AudioSaw.decodeToAudioBuffer(file);
        duration = buf.duration;
        var mono = buf.numberOfChannels > 1 ? await AudioSaw.mixToMono(buf) : buf;
        var audio = Float32Array.from((await AudioSaw.resampleBuffer(mono, 16000)).getChannelData(0));
        var w = whisper();
        w.postMessage({ type: 'load', model: modelSel.value });
        var done = await call(w, { type: 'run', model: modelSel.value, audio: audio, language: langSel.value, task: taskSel.value }, [audio.buffer]);
        asr.terminate(); asr = null;
        segs = done.segments;
        if (!segs.length) throw new Error('No speech was found in the soundtrack.');
      }
      cues = ASSubs.normalise(lenSel && lenSel.value === 'short' ? ASSubs.split(segs, 4) : segs, duration);
      renderCues();
      CV.setProgress(progressBar, 100);
      CV.setStatus(statusEl, 'success', cues.length + ' captions. Check the wording, choose a style, then save.');
      cuesPanel.hidden = false;
      cuesPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      CV.setStatus(statusEl, 'error', 'Could not make the captions. ' + (e.message || e), e);
    }
    document.title = baseTitle;
    goBtn.disabled = false;
  }
  goBtn.addEventListener('click', make);

  function mediaDuration() {
    return new Promise(function (resolve) {
      if (videoEl.readyState >= 1 && isFinite(videoEl.duration)) return resolve(videoEl.duration);
      videoEl.addEventListener('loadedmetadata', function () { resolve(videoEl.duration || 0); }, { once: true });
      setTimeout(function () { resolve(videoEl.duration || 0); }, 4000);
    });
  }

  function renderCues() {
    cuesEl.innerHTML = '';
    cues.forEach(function (c, i) {
      var row = document.createElement('div');
      row.className = 'dub-line';
      var t = document.createElement('button');
      t.type = 'button'; t.className = 'dub-time sub-seek';
      t.textContent = fmtT(c.start) + '–' + fmtT(c.end);
      t.title = 'Play from here';
      t.addEventListener('click', function () { videoEl.currentTime = c.start; videoEl.play(); });
      var ta = document.createElement('textarea');
      ta.rows = 2; ta.value = c.text; ta.setAttribute('aria-label', 'Caption ' + (i + 1) + ' at ' + fmtT(c.start));
      ta.addEventListener('input', function () { c.text = ta.value; schedulePreview(); });
      row.appendChild(t); row.appendChild(ta);
      cuesEl.appendChild(row);
    });
    preview();
  }

  // The captions on the video, as a <track>: the browser's own caption
  // rendering, so the style is approximate; the burned-in file uses libass.
  var pv = 0;
  function schedulePreview() { clearTimeout(pv); pv = setTimeout(preview, 400); }
  function preview() {
    if (!cues) return;
    Array.prototype.slice.call(videoEl.querySelectorAll('track')).forEach(function (t) { t.remove(); });
    if (trackUrl) URL.revokeObjectURL(trackUrl);
    trackUrl = URL.createObjectURL(new Blob([ASSubs.toVTT(live(), duration)], { type: 'text/vtt' }));
    var tr = document.createElement('track');
    tr.kind = 'subtitles'; tr.label = 'Captions'; tr.srclang = 'en'; tr.src = trackUrl; tr.default = true;
    videoEl.appendChild(tr);
    tr.addEventListener('load', function () { try { tr.track.mode = 'showing'; } catch (e) {} });
  }
  function live() { return cues.filter(function (c) { return String(c.text).trim(); }); }

  /* --------------------------------------------------------------- output */

  // ASS style for libass. SRT cues are laid out on libass's default 384x288
  // script canvas, so sizes and margins are in those units, whatever the
  // video's resolution.
  function forceStyle() {
    var size = { s: 16, m: 20, l: 26 }[sizeSel ? sizeSel.value : 'm'] || 20;
    var col = colourSel && colourSel.value === 'yellow' ? '&H0000E5FF' : '&H00FFFFFF';
    var top = posSel && posSel.value === 'top';
    var box = bgSel && bgSel.value === 'box';
    return ['FontName=' + FONT.name, 'FontSize=' + size, 'PrimaryColour=' + col, 'Alignment=' + (top ? 8 : 2), 'MarginV=' + (top ? 14 : 18),
      box ? 'BorderStyle=3' : 'BorderStyle=1', box ? 'OutlineColour=&H80000000' : 'OutlineColour=&H00000000', 'BackColour=&H80000000',
      box ? 'Outline=1' : 'Outline=1.6', 'Shadow=' + (box ? 0 : 0.6), 'Bold=0'].join(',');
  }

  var fontBytes = null;
  async function font() {
    if (!fontBytes) fontBytes = new Uint8Array(await (await fetch(FONT.url)).arrayBuffer());
    return fontBytes;
  }

  function base() { return file.name.replace(/\.[^.]+$/, ''); }

  async function burn() {
    if (!cues) return;
    burnBtn.disabled = softBtn.disabled = true;
    var t0 = Date.now();
    try {
      setProgress(2, 'Loading the video encoder…');
      var srt = new TextEncoder().encode(ASSubs.toSRT(live(), duration));
      var inExt = ext(file);
      var audio = /^(mp4|m4v|mov)$/.test(inExt) ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k'];
      var out = await AudioSaw.runFFmpeg(file, inExt,
        ['-vf', "subtitles=subs.srt:fontsdir=.:force_style='" + forceStyle() + "'", '-c:v', 'libx264', '-preset', 'superfast', '-crf', '20', '-pix_fmt', 'yuv420p']
          .concat(audio, ['-movflags', '+faststart']),
        'mp4', 'video/mp4', function (p, msg) { setProgress(p, msg); }, 'Writing the captions into the picture…',
        // A copy: ffmpeg's writeFile transfers the buffer to its worker, and a
        // second burn would find the cached one detached.
        { files: [{ name: 'subs.srt', data: srt }, { name: FONT.file, data: (await font()).slice() }] });
      CV.setProgress(progressBar, 100);
      CV.setStatus(statusEl, 'success', 'Done in ' + Math.round((Date.now() - t0) / 1000) + ' s: the captions are part of the picture now, so they show everywhere.');
      window.__subs = { kind: 'burn', blob: out, cues: live().length };
      CV.downloadBlob(out, base() + '-captioned.mp4');
    } catch (e) {
      CV.setStatus(statusEl, 'error', 'Could not write the video. ' + (e.message || e), e);
    }
    document.title = baseTitle;
    burnBtn.disabled = softBtn.disabled = false;
  }

  // A subtitle track beside the picture: nothing is re-encoded. MP4 and MOV
  // carry it as mov_text, MKV as SRT, WebM as WebVTT.
  async function soft() {
    if (!cues) return;
    burnBtn.disabled = softBtn.disabled = true;
    try {
      var inExt = ext(file), outExt = inExt === 'm4v' ? 'mp4' : inExt;
      var codec = { mp4: 'mov_text', mov: 'mov_text', mkv: 'srt', webm: 'webvtt' }[outExt] || 'mov_text';
      var subName = codec === 'webvtt' ? 'subs.vtt' : 'subs.srt';
      var text = codec === 'webvtt' ? ASSubs.toVTT(live(), duration) : ASSubs.toSRT(live(), duration);
      var lang = (taskSel && taskSel.value === 'translate') ? 'eng' : '';
      var out = await AudioSaw.runFFmpeg(file, inExt,
        ['-i', subName, '-map', '0:v', '-map', '0:a?', '-map', '1:0', '-c:v', 'copy', '-c:a', 'copy', '-c:s', codec]
          .concat(lang ? ['-metadata:s:s:0', 'language=' + lang] : [], ['-disposition:s:0', 'default']),
        outExt, { mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm' }[outExt] || 'video/mp4',
        function (p, msg) { setProgress(p, msg); }, 'Adding the subtitle track…',
        { files: [{ name: subName, data: new TextEncoder().encode(text) }] });
      CV.setProgress(progressBar, 100);
      CV.setStatus(statusEl, 'success', 'Added as a subtitle track, with the picture untouched. Turn it on in the player\'s CC menu; Instagram and TikTok ignore tracks, so burn them in for those.');
      window.__subs = { kind: 'soft', blob: out, cues: live().length };
      CV.downloadBlob(out, base() + '-subtitled.' + outExt);
    } catch (e) {
      CV.setStatus(statusEl, 'error', 'Could not add the subtitle track. ' + (e.message || e), e);
    }
    document.title = baseTitle;
    burnBtn.disabled = softBtn.disabled = false;
  }

  burnBtn.addEventListener('click', burn);
  softBtn.addEventListener('click', soft);
  dlSrt.addEventListener('click', function () { if (cues) CV.downloadBlob(new Blob([ASSubs.toSRT(live(), duration)], { type: 'application/x-subrip;charset=utf-8' }), base() + '.srt', { again: true }); });
  dlVtt.addEventListener('click', function () { if (cues) CV.downloadBlob(new Blob([ASSubs.toVTT(live(), duration)], { type: 'text/vtt;charset=utf-8' }), base() + '.vtt', { again: true }); });

  window.__subPage = { make: make, burn: burn, soft: soft, cues: function () { return cues; }, style: forceStyle };
})();
