/*
 * /fix-audio-sync page controller.
 *
 * Two ways to say where the sound belongs:
 *  - by hand: "the sound is 120 ms late", optionally a different amount at
 *    the end (drift), previewed live: the <video> plays muted and the decoded
 *    sound plays beside it through Web Audio, moved by the current setting,
 *    restarted whenever the setting, the position or the play state changes;
 *  - from a separate recording of the same take (a lavalier, a Zoom, a
 *    phone): js/av-sync.js finds where it sits against the camera's sound,
 *    at the start and end of the take, and the recording becomes the sound.
 *
 * The new sound is exactly the video's length and goes beside the copied
 * picture (CV.remuxVideo), so no frame is re-encoded.
 */
(function () {
  'use strict';

  if (typeof CV === 'undefined' || typeof AudioSaw === 'undefined' || typeof ASSync === 'undefined' || !CV.remuxVideo) {
    console.error('[fix-audio-sync] the /js/* includes (with tool-shell.js) must come before sync-page.js');
    return;
  }

  var $ = CV.$;
  var VIDEO_EXT = ['.mp4', '.m4v', '.mov', '.mkv', '.webm'];
  var AUDIO_EXT = ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus', '.aif', '.aiff', '.caf', '.wma', '.amr'];

  var dropzone = $('#dropzone'), fileInput = $('#fileInput'), fileList = $('#fileList'), controls = $('#controls');
  var goBtn = $('#convertBtn'), statusEl = $('#status'), progressWrap = $('#progressWrap'), progressBar = $('#progressBar');
  var preview = $('#preview'), modeSel = $('#mode'), dirSel = $('#dir'), msIn = $('#ms'), driftBox = $('#drift');
  var endDirSel = $('#endDir'), endMsIn = $('#endMs'), recBtn = $('#recBtn'), recInput = $('#recInput');
  var findBtn = $('#findBtn'), foundEl = $('#found'), listenBox = $('#listen');
  if (!dropzone || !goBtn) return;

  var video = null, rec = null, sound = null, soundFor = null, recBuf = null, recFor = null, aligned = null;
  var baseTitle = document.title;

  function ext(f) { var m = /\.([a-z0-9]+)$/i.exec(f.name); return m ? '.' + m[1].toLowerCase() : ''; }
  function isVideo(f) { return CV.isVideoFile(f) && ext(f) !== '.m4a'; }

  function probe(file) {
    return new Promise(function (resolve) {
      var v = document.createElement('video'), url = URL.createObjectURL(file), done = false;
      function fin(r) { if (done) return; done = true; URL.revokeObjectURL(url); resolve(r); }
      v.preload = 'metadata'; v.muted = true;
      v.onloadedmetadata = function () { fin(isFinite(v.duration) ? v.duration : null); };
      v.onerror = function () { fin(null); };
      setTimeout(function () { fin(null); }, 8000);
      v.src = url;
    });
  }

  // Seconds the current sound is late by (negative: early), start and end.
  function lateness() {
    var s = (+msIn.value || 0) / 1000 * (dirSel.value === 'early' ? -1 : 1);
    var e = driftBox && driftBox.checked ? (+endMsIn.value || 0) / 1000 * (endDirSel.value === 'early' ? -1 : 1) : s;
    return { late: s, lateEnd: e };
  }

  function mode() { return modeSel ? modeSel.value : 'shift'; }

  function showMode() {
    var m = mode();
    document.querySelectorAll('[data-for]').forEach(function (el) {
      el.hidden = el.getAttribute('data-for').split(' ').indexOf(m) === -1;
    });
    if (driftBox) document.querySelectorAll('[data-drift]').forEach(function (el) { el.hidden = !driftBox.checked; });
    goBtn.disabled = !video || (m === 'rec' && !rec);
    restart();
  }

  function render() {
    var rows = [];
    if (video) rows.push(video);
    if (rec) rows.push(rec);
    CV.renderFileList(fileList, rows, function (idx) {
      if (rows[idx] === video) { video = null; sound = null; } else { rec = null; recBuf = null; aligned = null; }
      update();
    });
  }

  function update() {
    fileList.style.display = video || rec ? '' : 'none';
    controls.style.display = video ? '' : 'none';
    render();
    if (preview) {
      if (video && preview.dataset.name !== video.name + video.size) {
        if (preview.src) URL.revokeObjectURL(preview.src);
        preview.src = URL.createObjectURL(video); preview.dataset.name = video.name + video.size; preview.hidden = false;
        preview.muted = true;
      }
      if (!video) { preview.hidden = true; preview.removeAttribute('src'); delete preview.dataset.name; }
    }
    if (recBtn) recBtn.textContent = rec ? 'Choose a different recording' : 'Choose the separate recording';
    if (foundEl && !aligned) foundEl.textContent = '';
    if (rec && modeSel && modeSel.value !== 'rec') modeSel.value = 'rec';
    showMode();
    if (video) loadSound();
  }

  function take(files) {
    files.forEach(function (f) {
      if (isVideo(f)) { video = f; sound = null; aligned = null; }
      else { rec = f; recBuf = null; aligned = null; }
    });
    if (!video && rec) CV.setStatus(statusEl, 'info', 'Now add the video the recording belongs to.');
    update();
  }

  CV.bindDropzone(dropzone, fileInput, take, VIDEO_EXT.concat(AUDIO_EXT));
  if (recBtn && recInput) {
    recBtn.addEventListener('click', function () { recInput.accept = AUDIO_EXT.concat(VIDEO_EXT).join(',') + ',audio/*'; recInput.click(); });
    recInput.addEventListener('change', function () {
      if (recInput.files.length) { rec = recInput.files[0]; recBuf = null; aligned = null; if (modeSel) modeSel.value = 'rec'; update(); }
      recInput.value = '';
    });
  }

  // The video's own sound, decoded once, for the preview and the shift.
  var loading = null;
  function loadSound() {
    if (sound && soundFor === video) return Promise.resolve(sound);
    if (loading && loading.f === video) return loading.p;
    var f = video;
    var p = AudioSaw.decodeToAudioBuffer(f).then(function (b) {
      if (f !== video) return null;
      sound = b; soundFor = f; return b;
    }, function (e) { if (f === video) { sound = null; soundFor = f; } throw e; });
    loading = { f: f, p: p };
    p.catch(function () {});
    return p;
  }

  /* --------------------------------------------------------- live preview */

  var ctx = null, src = null;
  function stopSrc() { if (src) { try { src.stop(); } catch (e) {} src.disconnect(); src = null; } }

  // The sound the preview plays: the camera's, or the lined-up recording.
  function previewTiming() {
    if (mode() === 'rec') {
      if (!recBuf || !aligned) return null;
      return { buf: recBuf, late: aligned.offset, lateEnd: aligned.offsetEnd };
    }
    if (!sound) return null;
    var l = lateness();
    return { buf: sound, late: l.late, lateEnd: l.lateEnd };
  }

  function restart() {
    stopSrc();
    if (!preview || preview.paused || preview.hidden) return;
    var p = previewTiming();
    if (!p) { preview.muted = false; return; }       // nothing decoded yet: let the video play its own sound
    if (mode() === 'shift' && listenBox && listenBox.checked) { preview.muted = false; return; } // A/B: the original
    preview.muted = true;
    if (!ctx) { var AC = window.AudioContext || window.webkitAudioContext; ctx = new AC(); }
    if (ctx.state === 'suspended') ctx.resume();
    var D = preview.duration || p.buf.duration, t = preview.currentTime;
    var speed = D > 0 ? 1 + (p.lateEnd - p.late) / D : 1;
    var at = t * speed + p.late;                       // where in the old sound "now" is
    src = ctx.createBufferSource();
    src.buffer = p.buf;
    src.playbackRate.value = speed;
    src.connect(ctx.destination);
    if (at >= 0) src.start(0, Math.min(at, p.buf.duration));
    else src.start(ctx.currentTime - at / speed, 0);
  }

  if (preview) {
    ['play', 'seeked', 'ratechange'].forEach(function (ev) { preview.addEventListener(ev, function () { if (preview.playbackRate !== 1) preview.playbackRate = 1; restart(); }); });
    ['pause', 'ended', 'seeking', 'waiting'].forEach(function (ev) { preview.addEventListener(ev, stopSrc); });
    preview.addEventListener('playing', restart);
  }
  [msIn, endMsIn].forEach(function (el) { if (el) el.addEventListener('input', restart); });
  [dirSel, endDirSel, listenBox].forEach(function (el) { if (el) el.addEventListener('change', restart); });
  if (driftBox) driftBox.addEventListener('change', showMode);
  if (modeSel) modeSel.addEventListener('change', showMode);

  // Nudge buttons move the signed lateness, and flip late/early across zero.
  document.querySelectorAll('[data-nudge]').forEach(function (b) {
    b.addEventListener('click', function () {
      var target = b.getAttribute('data-end') ? [endDirSel, endMsIn] : [dirSel, msIn];
      var v = (+target[1].value || 0) * (target[0].value === 'early' ? -1 : 1) + (+b.getAttribute('data-nudge'));
      target[0].value = v < 0 ? 'early' : 'late';
      target[1].value = Math.abs(v);
      restart();
    });
  });

  /* ---------------------------------------------------- separate recording */

  function step(p, msg) {
    progressWrap.style.display = '';
    CV.setProgress(progressBar, p);
    if (msg) CV.setStatus(statusEl, 'info', msg);
    document.title = '(' + Math.round(p) + '%) ' + baseTitle;
  }

  function fmtMs(s) { var ms = Math.round(Math.abs(s) * 1000 * 10) / 10; return ms >= 1000 ? (Math.abs(s)).toFixed(3) + ' s' : ms + ' ms'; }

  async function findRecording() {
    if (!video || !rec) return null;
    if (aligned && recFor === rec) return aligned;
    step(5, 'Reading the video\'s own sound…');
    var cam;
    try { cam = await loadSound(); } catch (e) { throw new Error('The video has no sound to line the recording up against. Lining up needs the camera\'s own sound, even a poor one.'); }
    step(25, 'Reading the recording…');
    var r = await AudioSaw.decodeToAudioBuffer(rec);
    if (r.sampleRate !== cam.sampleRate) { step(40, 'Matching the recording to the video\'s sample rate…'); r = await AudioSaw.resampleBuffer(r, cam.sampleRate); }
    step(55, 'Listening for where the two recordings match…');
    await new Promise(function (res) { setTimeout(res, 30); });
    var al = ASSync.align(CV.channelsOf(cam), CV.channelsOf(r), cam.sampleRate, { maxLag: 30 });
    if (!(al.confidence > 1.5)) throw new Error('These two recordings do not seem to share the same sound. Is it the same take? Lining up needs the camera to have heard what the recorder heard.');
    recBuf = r; recFor = rec; aligned = al;
    var lead = al.offset > 0 ? 'The recording started ' + fmtMs(al.offset) + ' before the video' : 'The recording started ' + fmtMs(al.offset) + ' after the video';
    var drift = Math.abs(al.offsetEnd - al.offset) >= 0.0005
      ? '; its clock runs ' + (al.drift > 0 ? 'slow' : 'fast') + ' by ' + Math.round(Math.abs(al.drift) * 1e6) + ' ppm, ' + fmtMs(al.offsetEnd - al.offset) + ' over the video, which is corrected too'
      : '';
    if (foundEl) foundEl.textContent = lead + drift + '.';
    CV.clearStatus(statusEl);
    progressWrap.style.display = 'none';
    document.title = baseTitle;
    return al;
  }

  if (findBtn) findBtn.addEventListener('click', async function () {
    findBtn.disabled = true;
    try { await findRecording(); restart(); } catch (e) { document.title = baseTitle; CV.setStatus(statusEl, 'error', e.message || String(e), e); }
    findBtn.disabled = false;
  });

  /* ------------------------------------------------------------------ run */

  async function run() {
    if (!video) return;
    goBtn.disabled = true;
    try {
      var m = mode(), D = await probe(video), chans, rate, note;
      if (m === 'rec') {
        var al = await findRecording();
        rate = recBuf.sampleRate;
        var len = Math.round((D || sound.duration) * rate);
        chans = ASSync.place(CV.channelsOf(recBuf), rate, len, al, await AudioSaw.ensureResampler());
        note = (foundEl && foundEl.textContent) || '';
        if (CV.signal) CV.signal.input('Video ' + (D || 0).toFixed(1) + ' s; separate recording ' + recBuf.duration.toFixed(1) + ' s at ' + rate + ' Hz');
      } else {
        step(5, 'Reading the video\'s sound…');
        var b = await loadSound();
        if (!b) throw new Error('That video has no sound to move.');
        rate = b.sampleRate;
        var l = lateness();
        if (!l.late && !l.lateEnd) throw new Error('Set how late or early the sound is first: 0 ms leaves it where it is.');
        var n = Math.round((D || b.duration) * rate);
        step(25, 'Moving the sound…');
        await new Promise(function (res) { setTimeout(res, 30); });
        chans = ASSync.shift(CV.channelsOf(b), rate, { late: l.late, lateEnd: l.lateEnd, length: n, resample: await AudioSaw.ensureResampler() });
        note = 'The sound moved ' + fmtMs(l.late) + (l.late > 0 ? ' earlier' : ' later') + (l.lateEnd !== l.late ? ' at the start and ' + fmtMs(l.lateEnd) + (l.lateEnd > 0 ? ' earlier' : ' later') + ' at the end' : '') + '.';
      }
      var out = AudioSaw.makeBuffer(chans, rate);
      var made = await CV.remuxVideo(video, out, function (p) { step(45 + p * 0.55, 'Putting the sound back on the video…'); });
      CV.setProgress(progressBar, 100);
      document.title = baseTitle;
      CV.setStatus(statusEl, 'success', 'Done. ' + note + ' The picture was copied untouched, and the file is exactly as long as before.');
      CV.downloadBlob(made.blob, video.name.replace(/\.[^.]+$/, '') + '-synced.' + made.ext);
    } catch (e) {
      document.title = baseTitle;
      CV.setStatus(statusEl, 'error', 'Could not fix the sync. ' + (e.message || e), e);
    }
    goBtn.disabled = !video || (mode() === 'rec' && !rec);
  }

  goBtn.addEventListener('click', run);
  showMode();

  window.__sync = {
    use: function (v, r) { take([v].concat(r ? [r] : [])); return loadSound(); },
    set: function (o) {
      if (o.mode && modeSel) modeSel.value = o.mode;
      if (o.late != null) { dirSel.value = o.late < 0 ? 'early' : 'late'; msIn.value = Math.abs(o.late * 1000); }
      if (o.lateEnd != null) { driftBox.checked = true; endDirSel.value = o.lateEnd < 0 ? 'early' : 'late'; endMsIn.value = Math.abs(o.lateEnd * 1000); }
      showMode();
    },
    find: findRecording,
    run: run
  };
})();
