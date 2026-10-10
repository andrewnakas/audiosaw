/*
 * /add-audio-to-video page controller: a song or a voice-over on a video.
 * Replace the video's sound, mix with it, or duck the music under the speech
 * (js/audio-bed.js does the mixing). The picture is never re-encoded:
 * CV.remuxVideo copies the video stream and writes the new sound as AAC.
 *
 * The mix is made at the video's own sound rate (the new track is resampled
 * to it with the site's sinc resampler), as long as the video, then limited
 * to -1 dBTP so a loud song on top of loud speech does not clip.
 */
(function () {
  'use strict';

  if (typeof CV === 'undefined' || typeof AudioSaw === 'undefined' || typeof ASBed === 'undefined' || !CV.remuxVideo) {
    console.error('[add-audio-to-video] the /js/* includes must come before add-audio-video-page.js');
    return;
  }

  var $ = CV.$;
  var VIDEO_EXT = ['.mp4', '.m4v', '.mov', '.mkv', '.webm'];
  var AUDIO_EXT = ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus', '.aif', '.aiff', '.caf', '.wma', '.m4b', '.amr'];

  var dropzone = $('#dropzone');
  var fileInput = $('#fileInput');
  var fileList = $('#fileList');
  var controls = $('#controls');
  var goBtn = $('#convertBtn');
  var statusEl = $('#status');
  var progressWrap = $('#progressWrap');
  var progressBar = $('#progressBar');
  var musicBtn = $('#musicBtn');
  var musicInput = $('#musicInput');
  var modeSel = $('#mode');
  var musicDb = $('#musicDb');
  var origDb = $('#origDb');
  var duckSel = $('#duckDb');
  var offsetIn = $('#offset');
  var skipIn = $('#skip');
  var loopBox = $('#loop');
  var fadeSel = $('#fadeOut');
  var preview = $('#preview');
  var musicOut = $('#musicDbOut');
  var origOut = $('#origDbOut');

  if (!dropzone || !goBtn) return;

  var video = null, music = null, videoInfo = null;
  var baseTitle = document.title;

  function ext(f) { var m = /\.([a-z0-9]+)$/i.exec(f.name); return m ? '.' + m[1].toLowerCase() : ''; }
  function isVideo(f) { return CV.isVideoFile(f) && ext(f) !== '.m4a'; }
  function isAudio(f) { return !isVideo(f) && (/^audio\//.test(f.type) || AUDIO_EXT.indexOf(ext(f)) !== -1); }

  // The length and whether there is a sound track, from a <video> element:
  // cheap, and it works on a video with no audio, which a decode does not.
  function probe(file) {
    return new Promise(function (resolve) {
      var v = document.createElement('video'), url = URL.createObjectURL(file), done = false;
      function fin(r) { if (done) return; done = true; URL.revokeObjectURL(url); resolve(r); }
      v.preload = 'metadata';
      v.muted = true;
      v.onloadedmetadata = function () { fin({ duration: isFinite(v.duration) ? v.duration : null }); };
      v.onerror = function () { fin({ duration: null }); };
      setTimeout(function () { fin({ duration: null }); }, 8000);
      v.src = url;
    });
  }

  function render() {
    var rows = [];
    if (video) rows.push(video);
    if (music) rows.push(music);
    CV.renderFileList(fileList, rows, function (idx) {
      if (rows[idx] === video) video = null; else music = null;
      update();
    });
  }

  function update() {
    fileList.style.display = video || music ? '' : 'none';
    controls.style.display = video || music ? '' : 'none';
    render();
    if (musicBtn) musicBtn.textContent = !video ? 'Choose the video' : music ? 'Choose a different track' : 'Choose the music or voice-over';
    goBtn.disabled = !(video && music);
    if (preview) {
      if (video && !preview.dataset.src) { preview.src = URL.createObjectURL(video); preview.dataset.src = '1'; preview.hidden = false; }
      if (!video) { preview.hidden = true; preview.removeAttribute('src'); delete preview.dataset.src; }
    }
    if (video && !music) CV.setStatus(statusEl, 'info', 'Now add the song or voice-over to put on it.');
    else if (music && !video) CV.setStatus(statusEl, 'info', 'Now add the video to put it on.');
    else CV.clearStatus(statusEl);
  }

  function take(files) {
    files.forEach(function (f) {
      if (isVideo(f)) { video = f; videoInfo = null; if (preview) delete preview.dataset.src; }
      else if (isAudio(f)) music = f;
    });
    update();
  }

  CV.bindDropzone(dropzone, fileInput, take, VIDEO_EXT.concat(AUDIO_EXT));
  if (musicBtn && musicInput) {
    musicBtn.addEventListener('click', function () {
      musicInput.accept = !video ? VIDEO_EXT.join(',') + ',video/*' : AUDIO_EXT.join(',') + ',audio/*';
      musicInput.click();
    });
    musicInput.addEventListener('change', function () {
      if (musicInput.files.length) take(Array.prototype.slice.call(musicInput.files));
      musicInput.value = '';
    });
  }

  function showDb(input, out) { if (input && out) out.textContent = (+input.value > 0 ? '+' : '') + (+input.value) + ' dB'; }
  [[musicDb, musicOut], [origDb, origOut]].forEach(function (p) {
    if (p[0]) { p[0].addEventListener('input', function () { showDb(p[0], p[1]); }); showDb(p[0], p[1]); }
  });
  function showMode() {
    var m = modeSel ? modeSel.value : 'duck';
    document.querySelectorAll('[data-for]').forEach(function (el) {
      el.hidden = el.getAttribute('data-for').split(' ').indexOf(m) === -1;
    });
  }
  if (modeSel) { modeSel.addEventListener('change', showMode); showMode(); }

  function opts() {
    return {
      mode: modeSel ? modeSel.value : 'duck',
      musicDb: musicDb ? +musicDb.value : 0,
      origDb: origDb ? +origDb.value : 0,
      duckDb: duckSel ? +duckSel.value : 12,
      offset: Math.max(0, +(offsetIn && offsetIn.value) || 0),
      skip: Math.max(0, +(skipIn && skipIn.value) || 0),
      loop: loopBox ? loopBox.checked : true,
      fadeOut: fadeSel ? +fadeSel.value : 3
    };
  }

  function step(p, msg) {
    progressWrap.style.display = '';
    CV.setProgress(progressBar, p);
    if (msg) CV.setStatus(statusEl, 'info', msg);
    document.title = '(' + Math.round(p) + '%) ' + baseTitle;
  }

  async function run(v, m, o) {
    o = o || opts();
    goBtn.disabled = true;
    try {
      step(2, 'Reading the video…');
      var info = await probe(v);
      var orig = null;
      try { orig = await AudioSaw.decodeToAudioBuffer(v); } catch (e) { orig = null; }
      var duration = info.duration || (orig && orig.duration);
      if (!duration) throw new Error('Could not read how long that video is. Try an MP4 or MOV.');
      step(20, 'Reading the new track…');
      var mb = await AudioSaw.decodeToAudioBuffer(m);
      var rate = orig ? orig.sampleRate : Math.min(48000, mb.sampleRate) || 48000;
      if (mb.sampleRate !== rate) { step(30, 'Matching the track to the video\'s sample rate…'); mb = await AudioSaw.resampleBuffer(mb, rate); }
      step(40, orig ? (o.mode === 'duck' ? 'Finding the speech and ducking the music under it…' : 'Mixing…') : 'That video has no sound of its own, so the track becomes its sound…');
      var mchans = [], ochans = null;
      for (var c = 0; c < mb.numberOfChannels; c++) mchans.push(mb.getChannelData(c));
      if (orig) { ochans = []; for (var d = 0; d < orig.numberOfChannels; d++) ochans.push(orig.getChannelData(d)); }
      var length = Math.round(duration * rate);
      var res = ASBed.mix({
        rate: rate, length: length, orig: ochans, music: mchans, mode: o.mode,
        musicDb: o.musicDb, origDb: o.origDb, duckDb: o.duckDb,
        offset: o.offset, skip: o.skip, loop: o.loop, fadeOut: o.fadeOut
      });
      var chans = res.channels;
      if (window.ASLoudness && ASLoudness.truePeak(chans) > 0.891) ASLoudness.limit(chans, rate, Math.pow(10, -1 / 20));
      var out = AudioSaw.makeBuffer(chans, rate);
      if (CV.signal) CV.signal.input('Video ' + duration.toFixed(1) + ' s' + (orig ? ', its sound ' + rate + ' Hz' : ', no sound') + '; new track ' + mb.duration.toFixed(1) + ' s');
      var made = await CV.remuxVideo(v, out, function (p) { step(55 + p * 0.45, 'Putting the new sound on the video…'); });
      var name = v.name.replace(/\.[^.]+$/, '') + (o.mode === 'replace' || !orig ? '-new-sound.' : '-with-music.') + made.ext;
      CV.setProgress(progressBar, 100);
      document.title = baseTitle;
      var note = !orig ? 'The video had no sound, so the track is its sound now.'
        : o.mode === 'duck' ? 'The music drops ' + o.duckDb + ' dB while someone is talking (' + Math.round(res.ducked * 100) + '% of the video).'
        : o.mode === 'mix' ? 'The track is mixed with the video\'s own sound.' : 'The video\'s own sound is replaced.';
      CV.setStatus(statusEl, 'success', 'Done. ' + note + ' The picture was copied untouched.');
      CV.downloadBlob(made.blob, name);
    } catch (e) {
      document.title = baseTitle;
      CV.setStatus(statusEl, 'error', 'Could not make the video. ' + (e.message || e), e);
    }
    goBtn.disabled = !(video && music);
  }

  goBtn.addEventListener('click', function () { if (video && music) run(video, music); });

  window.__aav = { run: run };
})();
