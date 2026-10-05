/*
 * /mp3-to-mp4 page controller: a song or a recording, plus a picture, into an
 * MP4 that YouTube, Instagram and TikTok will take.
 *
 * The picture is drawn on a canvas: the visitor's own image (whole, on a
 * blurred copy of itself, or cropped to fill), or a generated cover with the
 * title and the track's own waveform. The canvas becomes one PNG.
 *
 * The video is made in two ffmpeg runs, because encoding the still at 25 fps
 * for the whole song is slow in WebAssembly: measured, a 4-minute 1080p track
 * took 526 s at 25 fps against 45 s at 1 fps (on a loaded machine). Feeds
 * that expect a normal frame rate are the reason not to ship 1 fps. So:
 *   1. two seconds of 25 fps H.264 from the PNG (one keyframe, ~4 s), then
 *   2. that clip looped under the audio by stream copy (-stream_loop, -c:v
 *      copy), cut to the audio's length. Measured: 4 minutes in 17 s.
 *
 * The sound is AAC 320 kbps, or copied untouched when it already is AAC.
 */
(function () {
  'use strict';

  if (typeof CV === 'undefined' || typeof AudioSaw === 'undefined') {
    console.error('[mp3-to-mp4] the /js/* includes must come before mp3-to-mp4-page.js');
    return;
  }

  var $ = CV.$;
  var AUDIO_EXT = ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus', '.aif', '.aiff', '.caf', '.wma', '.m4b', '.amr', '.webm'];
  var IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif'];
  var SHAPES = {
    landscape: [1920, 1080],
    square: [1080, 1080],
    portrait: [1080, 1920]
  };
  var PALETTES = {
    ember: ['#2b1d16', '#a4442a', '#f6e7cf'],
    night: ['#0d1326', '#38427a', '#e8ecff'],
    forest: ['#0f231b', '#3d7a52', '#e6f2e2'],
    paper: ['#f6efe2', '#e2d2b4', '#2a2118'],
    mono: ['#111111', '#3a3a3a', '#f2f2f2']
  };
  var CLIP_S = 2, FPS = 25;

  var dropzone = $('#dropzone');
  var fileInput = $('#fileInput');
  var fileList = $('#fileList');
  var controls = $('#controls');
  var goBtn = $('#convertBtn');
  var statusEl = $('#status');
  var progressWrap = $('#progressWrap');
  var progressBar = $('#progressBar');
  var canvas = $('#cover');
  var shapeSel = $('#shape');
  var pictureSel = $('#picture');
  var fitSel = $('#fit');
  var paletteSel = $('#palette');
  var titleIn = $('#titleText');
  var subIn = $('#subText');
  var waveBox = $('#withWave');
  var textBox = $('#withText');
  var imgBtn = $('#imageBtn');
  var imgInput = $('#imageInput');
  var imgName = $('#imageName');

  if (!dropzone || !canvas) return;

  var audios = [];          // the picked audio files, in order
  var image = null;         // an ImageBitmap or HTMLImageElement
  var peaks = {};           // file name -> Float32Array of 0..1 peaks
  var titleEdited = false;
  var baseTitle = document.title;

  function ext(f) { var m = /\.([a-z0-9]+)$/i.exec(f.name); return m ? m[1].toLowerCase() : ''; }
  function isImage(f) { return /^image\//.test(f.type) || IMAGE_EXT.indexOf('.' + ext(f)) !== -1; }
  function baseName(f) { return f.name.replace(/\.[^.]+$/, ''); }
  function prettyName(f) { return baseName(f).replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim(); }

  function setProgress(p, msg) {
    progressWrap.style.display = '';
    CV.setProgress(progressBar, p);
    if (msg) CV.setStatus(statusEl, 'info', msg);
  }

  /* ------------------------------------------------------------- picture */

  async function loadImage(file) {
    if (typeof createImageBitmap === 'function') {
      try { return await createImageBitmap(file); } catch (e) { /* fall through: some formats only decode via <img> */ }
    }
    var url = URL.createObjectURL(file);
    try {
      var img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      return img;
    } finally {
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }
  }

  // 1200 columns of peak level, mixed over the channels. Only for the drawing,
  // so the decode is the one the rest of the site uses and nothing more.
  async function peaksOf(file) {
    if (peaks[file.name]) return peaks[file.name];
    var buf = await AudioSaw.decodeToAudioBuffer(file);
    var n = 1200, len = buf.length, out = new Float32Array(n), ch = buf.numberOfChannels;
    var step = Math.max(1, Math.floor(len / n));
    for (var c = 0; c < ch; c++) {
      var x = buf.getChannelData(c);
      for (var i = 0; i < n; i++) {
        var s = Math.floor(i * len / n), e = Math.min(len, s + step), m = 0;
        for (var j = s; j < e; j += 4) { var v = x[j] < 0 ? -x[j] : x[j]; if (v > m) m = v; }
        if (m > out[i]) out[i] = m;
      }
    }
    var top = 0;
    for (var k = 0; k < n; k++) if (out[k] > top) top = out[k];
    if (top > 0) for (var q = 0; q < n; q++) out[q] /= top;
    peaks[file.name] = { p: out, duration: buf.duration };
    return peaks[file.name];
  }

  function wrap(ctx, text, maxW) {
    var words = String(text).split(/\s+/), lines = [], cur = '';
    words.forEach(function (w) {
      var t = cur ? cur + ' ' + w : w;
      if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t;
    });
    if (cur) lines.push(cur);
    return lines.slice(0, 3);
  }

  // areaH: the height the whole picture is centred in (the full frame unless
  // something has to fit under it). Returns the bottom edge of the picture.
  function drawImageFit(ctx, img, W, H, mode, areaH) {
    var iw = img.width, ih = img.height;
    var cover = Math.max(W / iw, H / ih), contain = Math.min(W / iw, H / ih);
    if (mode === 'fill') {
      ctx.drawImage(img, (W - iw * cover) / 2, (H - ih * cover) / 2, iw * cover, ih * cover);
      return H;
    }
    // The whole picture, on a blurred, darkened copy of itself. Where the
    // canvas has no filter (older Safari), the copy is only darkened.
    ctx.save();
    if ('filter' in ctx) ctx.filter = 'blur(' + Math.round(W / 40) + 'px) brightness(0.6)';
    ctx.drawImage(img, (W - iw * cover * 1.1) / 2, (H - ih * cover * 1.1) / 2, iw * cover * 1.1, ih * cover * 1.1);
    ctx.restore();
    if (!('filter' in ctx)) { ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(0, 0, W, H); }
    var ph = ih * contain, top = ((areaH && ph <= areaH ? areaH : H) - ph) / 2;
    ctx.drawImage(img, (W - iw * contain) / 2, top, iw * contain, ph);
    return top + ph;
  }

  function drawWave(ctx, p, x, y, w, h, colour) {
    var bars = Math.min(p.length, Math.floor(w / 6)), bw = w / bars;
    ctx.fillStyle = colour;
    for (var i = 0; i < bars; i++) {
      var s = Math.floor(i * p.length / bars), e = Math.floor((i + 1) * p.length / bars), m = 0;
      for (var j = s; j < e; j++) if (p[j] > m) m = p[j];
      var bh = Math.max(2, m * h);
      ctx.fillRect(x + i * bw + bw * 0.2, y + (h - bh) / 2, bw * 0.6, bh);
    }
  }

  async function draw(file) {
    var size = SHAPES[shapeSel.value] || SHAPES.landscape, W = size[0], H = size[1];
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext('2d');
    var pal = PALETTES[paletteSel.value] || PALETTES.ember;
    var useImage = pictureSel.value === 'image' && image;

    var u = Math.min(W, H) / 1080;     // 1 at 1080 px on the short side
    // Vertical feeds lay their caption and buttons over the bottom fifth, so
    // the text and waveform stop above it there.
    var bottom = H > W ? H * 0.78 : H - 90 * u;
    var picBottom = H;
    if (useImage) {
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
      // In 9:16 the whole picture moves up to leave the waveform a band of
      // its own under it, rather than across the artwork.
      picBottom = drawImageFit(ctx, image, W, H, fitSel.value, H > W && waveBox.checked ? bottom - 180 * u : 0);
    } else {
      var g = ctx.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, pal[0]); g.addColorStop(1, pal[1]);
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }

    var ink = useImage ? '#ffffff' : pal[2];

    if (waveBox.checked && file) {
      try {
        var pk = await peaksOf(file);
        var wh = (useImage ? 120 : 220) * u;
        var wy = useImage ? (picBottom + 30 * u + wh <= bottom ? picBottom + 30 * u : bottom - wh) : H * (H > W ? 0.56 : 0.58);
        drawWave(ctx, pk.p, 90 * u, wy, W - 180 * u, wh, useImage ? 'rgba(255,255,255,0.85)' : ink);
        if (useImage) bottom = wy - 30 * u;
      } catch (e) {
        // A file the browser cannot decode still gets its video; ffmpeg reads
        // it. The waveform is the only thing lost.
        waveBox.checked = false;
        CV.setStatus(statusEl, 'warn', 'The waveform could not be drawn for this file (' + (e.message || e) + '); the video will still be made.', e);
      }
    }

    if (textBox.checked) {
      var title = titleIn.value.trim(), sub = subIn.value.trim();
      if (title || sub) {
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        if (useImage) { ctx.shadowColor = 'rgba(0,0,0,0.7)'; ctx.shadowBlur = 18 * u; }
        ctx.fillStyle = ink;
        var tSize = Math.round((W > H ? 96 : 84) * u), sSize = Math.round(46 * u);
        ctx.font = '600 ' + tSize + 'px Fraunces, Georgia, serif';
        var lines = wrap(ctx, title, W - 180 * u);
        var y0;
        if (useImage) y0 = bottom - (sub ? sSize * 1.6 : 0) - (lines.length - 1) * tSize * 1.1;
        else y0 = H * (H > W ? 0.36 : 0.30) + tSize;
        lines.forEach(function (l, i) { ctx.fillText(l, 90 * u, y0 + i * tSize * 1.1); });
        if (sub) {
          ctx.font = '500 ' + sSize + 'px "IBM Plex Sans", system-ui, sans-serif';
          ctx.globalAlpha = 0.85;
          ctx.fillText(sub, 90 * u, y0 + (lines.length - 1) * tSize * 1.1 + sSize * 1.6);
          ctx.globalAlpha = 1;
        }
        ctx.shadowBlur = 0;
      }
    }
  }

  var drawing = null;
  function redraw() {
    if (!audios.length) return;
    var f = audios[0];
    drawing = (drawing || Promise.resolve()).then(function () { return draw(f); }).catch(function () {});
    return drawing;
  }

  /* --------------------------------------------------------------- video */

  async function sniff(file) {
    try { return AudioSaw.sniffFormat(new Uint8Array(await file.slice(0, 1 << 20).arrayBuffer())); } catch (e) { return null; }
  }

  async function durationOf(file) {
    if (peaks[file.name]) return peaks[file.name].duration;
    var url = URL.createObjectURL(file);
    try {
      var a = document.createElement('audio');
      a.preload = 'metadata';
      a.src = url;
      var d = await new Promise(function (res) {
        a.onloadedmetadata = function () { res(a.duration); };
        a.onerror = function () { res(NaN); };
      });
      if (isFinite(d) && d > 0) return d;
    } finally { URL.revokeObjectURL(url); }
    // The browser cannot play it (WMA, AMR…): decode, which falls back to ffmpeg.
    var buf = await AudioSaw.decodeToAudioBuffer(file);
    return buf.duration;
  }

  function pngOfCanvas() {
    return new Promise(function (res, rej) {
      canvas.toBlob(function (b) {
        if (!b) { rej(new Error('The picture could not be drawn')); return; }
        b.arrayBuffer().then(function (ab) { res(new Uint8Array(ab)); }, rej);
      }, 'image/png');
    });
  }

  async function makeOne(file, index, count) {
    var tag = count > 1 ? ' (' + (index + 1) + ' of ' + count + ')' : '';
    if (count > 1 && !titleEdited) titleIn.value = prettyName(file);
    await draw(file);
    var png = await pngOfCanvas();
    var dur = await durationOf(file);

    setProgress(5, 'Drawing the picture into two seconds of video' + tag + '…');
    var clip = await AudioSaw.runFFmpeg(null, null,
      ['-loop', '1', '-framerate', String(FPS), '-i', 'cover.png', '-t', String(CLIP_S),
        '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-crf', '18',
        '-pix_fmt', 'yuv420p', '-g', String(FPS * CLIP_S), '-r', String(FPS)],
      'mp4', 'video/mp4', function (p, msg) { setProgress(Math.min(30, p * 0.3), msg); }, 'Encoding the picture' + tag + '…',
      { raw: true, files: [{ name: 'cover.png', data: png }] });

    var info = await sniff(file);
    var copyAudio = !!(info && info.codec === 'aac');
    var inName = 'audio.' + (ext(file) || 'bin');
    var out = await AudioSaw.runFFmpeg(null, null,
      ['-stream_loop', '-1', '-i', 'clip.mp4', '-i', inName,
        '-map', '0:v', '-map', '1:a:0', '-c:v', 'copy']
        .concat(copyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '320k'],
          ['-t', dur.toFixed(3), '-movflags', '+faststart']),
      'mp4', 'video/mp4', function (p, msg) { setProgress(30 + p * 0.7, msg); }, 'Adding the sound' + tag + '…',
      { raw: true, files: [{ name: 'clip.mp4', data: new Uint8Array(await clip.arrayBuffer()) }, { name: inName, data: new Uint8Array(await file.arrayBuffer()) }] });
    return { blob: out, name: baseName(file) + '.mp4', copied: copyAudio, duration: dur };
  }

  goBtn.addEventListener('click', async function () {
    if (!audios.length) return;
    goBtn.disabled = true;
    var t0 = Date.now(), made = [];
    try {
      for (var i = 0; i < audios.length; i++) {
        var r = await makeOne(audios[i], i, audios.length);
        made.push(r);
        CV.downloadBlob(r.blob, r.name, i ? { again: true } : undefined);
      }
      CV.setProgress(progressBar, 100);
      var s = Math.round((Date.now() - t0) / 1000);
      var size = SHAPES[shapeSel.value];
      CV.setStatus(statusEl, 'success', (made.length > 1 ? made.length + ' videos' : 'Your video') + ' in ' + s + ' s: ' +
        size[0] + '×' + size[1] + ' H.264 at ' + FPS + ' fps, sound ' +
        (made.every(function (m) { return m.copied; }) ? 'copied untouched (it was already AAC).' : 'as AAC 320 kbps.'));
      window.__mp4 = { made: made.map(function (m) { return { name: m.name, size: m.blob.size, copied: m.copied, duration: m.duration }; }), blobs: made.map(function (m) { return m.blob; }) };
      if (audios.length > 1) titleEdited = false;
    } catch (e) {
      CV.setStatus(statusEl, 'error', 'Could not make the video. ' + (e.message || e), e);
    }
    document.title = baseTitle;
    goBtn.disabled = false;
  });

  /* ------------------------------------------------------------------ ui */

  function showPictureControls() {
    var img = pictureSel.value === 'image';
    document.querySelectorAll('[data-img]').forEach(function (el) { el.hidden = !img; });
    document.querySelectorAll('[data-gen]').forEach(function (el) { el.hidden = img; });
  }

  async function setImage(file) {
    try {
      image = await loadImage(file);
      imgName.textContent = file.name;
      pictureSel.value = 'image';
      // A photo usually carries its own title, or none is wanted on it.
      textBox.checked = false;
      showPictureControls();
      redraw();
    } catch (e) {
      CV.setStatus(statusEl, 'error', 'That picture could not be opened. JPG, PNG or WebP work everywhere.', e);
    }
  }

  function renderList() {
    CV.renderFileList(fileList, audios, function (idx) {
      audios.splice(idx, 1);
      if (!audios.length) { controls.style.display = 'none'; goBtn.disabled = true; fileList.innerHTML = ''; return; }
      renderList();
      redraw();
    });
  }

  function onFiles(picked) {
    if (!picked || !picked.length) return;
    var imgs = picked.filter(isImage), aud = picked.filter(function (f) { return !isImage(f); });
    if (imgs.length) setImage(imgs[0]);
    if (aud.length) {
      audios = aud;
      fileList.style.display = '';
      controls.style.display = '';
      goBtn.disabled = false;
      renderList();
      if (!titleEdited) titleIn.value = prettyName(audios[0]);
      CV.clearStatus(statusEl);
      redraw();
    } else if (!audios.length) {
      CV.setStatus(statusEl, 'info', 'Got the picture. Now drop the song or recording to put under it.');
    }
  }

  CV.bindDropzone(dropzone, fileInput, onFiles, AUDIO_EXT.concat(IMAGE_EXT));
  imgBtn.addEventListener('click', function () { imgInput.click(); });
  imgInput.addEventListener('change', function () { if (imgInput.files[0]) setImage(imgInput.files[0]); imgInput.value = ''; });
  titleIn.addEventListener('input', function () { titleEdited = true; redraw(); });
  subIn.addEventListener('input', redraw);
  pictureSel.addEventListener('change', function () {
    showPictureControls();
    textBox.checked = pictureSel.value !== 'image';
    if (pictureSel.value === 'image' && !image) imgInput.click();
    redraw();
  });
  [shapeSel, fitSel, paletteSel, waveBox, textBox].forEach(function (el) { el.addEventListener('change', redraw); });
  if (document.fonts && document.fonts.load) {
    Promise.all([document.fonts.load('600 96px Fraunces'), document.fonts.load('500 46px "IBM Plex Sans"')]).then(redraw, function () {});
  }
  showPictureControls();

  window.__mp4page = { redraw: redraw, setImage: setImage };
})();
