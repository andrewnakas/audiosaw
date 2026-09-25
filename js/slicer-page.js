/*
 * /sample-slicer: chop a break or a loop into slices, play them on pads, and
 * download them as sampler-ready WAVs. The cutting is js/slicer.js, checked
 * by tools/check-slicer.js; this file is the waveform, the pads and the
 * export.
 *
 * Export goes through CV.downloadBlob like every other tool, so flow.js
 * gives it the next-step panel and the convert_success event.
 */
(function (global) {
  'use strict';
  var CV = global.CV;
  if (!CV) { console.error('slicer-page: CV missing — /js includes must come first'); return; }

  var $ = CV.$, SL = global.ASSlicer;
  var dropzone = $('#dropzone'), fileInput = $('#fileInput'), fileList = $('#fileList');
  var controls = $('#controls'), statusEl = $('#status'), progressWrap = $('#progressWrap'), progressBar = $('#progressBar');
  var el = {
    mode: $('#slMode'), sens: $('#slSens'), count: $('#slCount'), beats: $('#slBeats'), bpm: $('#slBpm'),
    wave: $('#slWave'), pads: $('#slPads'), preset: $('#slPreset'), mono: $('#slMono'), prefix: $('#slPrefix'),
    go: $('#convertBtn'), reset: $('#resetBtn'), info: $('#slInfo')
  };

  var ACCEPT = ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus', '.aif', '.aiff', '.m4b', '.wma', '.mp4', '.mov', '.webm', '.mkv'];
  var KEYS = '1234567890qwertyuiopasdfghjklzxc';
  var buffer = null, chans = null, cuts = [], ctx = null, playing = null, fileName = 'sample';

  function audio() {
    if (!ctx) { var C = global.AudioContext || global.webkitAudioContext; ctx = new C({ latencyHint: 'interactive' }); }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function compute() {
    if (!buffer) return;
    var dur = buffer.duration, m = el.mode.value;
    el.sens.closest('label').hidden = m !== 'transients';
    el.count.closest('label').hidden = m !== 'equal';
    el.beats.closest('label').hidden = m !== 'beats';
    el.bpm.closest('label').hidden = m !== 'beats';
    if (m === 'transients') {
      cuts = SL.onsets(chans, buffer.sampleRate, { sensitivity: parseFloat(el.sens.value) });
      if (!cuts.length || cuts[0] > 0.02) cuts.unshift(0);
    } else if (m === 'equal') {
      cuts = SL.equal(dur, parseInt(el.count.value, 10) || 16);
    } else {
      var bpm = parseFloat(el.bpm.value);
      cuts = bpm >= 30 && bpm <= 300 ? SL.grid(dur, bpm, parseFloat(el.beats.value) || 1, 0) : [0];
    }
    redraw();
  }

  function slices() {
    return SL.cut(chans, buffer.sampleRate, cuts);
  }

  /* ------------------------------------------------------------- waveform */

  var peaks = null;
  function buildPeaks(w) {
    var d = chans[0], n = d.length, out = new Float32Array(w);
    for (var x = 0; x < w; x++) {
      var a = Math.floor(x * n / w), b = Math.floor((x + 1) * n / w), m = 0;
      for (var i = a; i < b; i++) { var v = Math.abs(d[i]); if (v > m) m = v; }
      out[x] = m;
    }
    return out;
  }

  function redraw() {
    var cv = el.wave, dpr = global.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); peaks = null; }
    var g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    if (!buffer) return;
    if (!peaks || peaks.length !== w) peaks = buildPeaks(w);
    var css = getComputedStyle(document.documentElement);
    var amber = css.getPropertyValue('--amber').trim() || '#c2410c', ink = css.getPropertyValue('--ink-soft').trim() || '#4a4338';
    g.fillStyle = ink;
    for (var x = 0; x < w; x++) { var ph = peaks[x] * (h / 2 - 4); g.fillRect(x, h / 2 - ph, 1, Math.max(1, ph * 2)); }
    g.font = '600 11px ' + (css.getPropertyValue('--mono').trim() || 'monospace');
    g.textBaseline = 'top';
    cuts.forEach(function (t, i) {
      var cx = Math.round(t / buffer.duration * w) + 0.5;
      g.fillStyle = amber;
      g.fillRect(cx - 0.5, 0, 2, h);
      g.fillText(String(i + 1), cx + 4, 3);
    });
    if (playing) {
      var px = Math.round(playing.pos() / buffer.duration * w);
      g.fillStyle = 'rgba(194,65,12,0.18)';
      g.fillRect(Math.round(playing.t0 / buffer.duration * w), 0, Math.max(1, px - Math.round(playing.t0 / buffer.duration * w)), h);
    }
    drawPads();
    el.info.textContent = cuts.length + ' slice' + (cuts.length === 1 ? '' : 's') + ' · click the waveform to add a cut, click a cut to remove it';
  }

  // Click near a cut removes it; anywhere else adds one, at the nearest
  // zero crossing so it does not click.
  el.wave.addEventListener('click', function (e) {
    if (!buffer) return;
    var r = el.wave.getBoundingClientRect(), t = (e.clientX - r.left) / r.width * buffer.duration;
    var tol = 6 / r.width * buffer.duration, near = -1;
    cuts.forEach(function (c, i) { if (Math.abs(c - t) < tol && i > 0) near = i; });
    if (near > 0) cuts.splice(near, 1);
    else {
      var i0 = SL.zeroBefore(chans[0], Math.round(t * buffer.sampleRate), Math.round(0.005 * buffer.sampleRate));
      cuts.push(i0 / buffer.sampleRate);
      cuts.sort(function (a, b) { return a - b; });
    }
    el.mode.value = 'manual';
    redraw();
  });

  /* ----------------------------------------------------------------- pads */

  var padSlices = null;
  function drawPads() {
    padSlices = slices();
    el.pads.innerHTML = padSlices.map(function (s, i) {
      return '<button type="button" class="sl-pad" data-i="' + i + '"><span class="sl-pad-n">' + (i + 1) + '</span>' +
        '<span class="sl-pad-k">' + (KEYS[i] || '') + '</span><span class="sl-pad-d">' + ((s.end - s.start) * 1000).toFixed(0) + ' ms</span></button>';
    }).join('');
  }

  function play(i) {
    if (!padSlices || !padSlices[i]) return;
    var c = audio(), s = padSlices[i], b = c.createBuffer(s.channels.length, s.channels[0].length, buffer.sampleRate);
    s.channels.forEach(function (d, k) { b.copyToChannel(d, k); });
    if (playing && playing.src) try { playing.src.stop(); } catch (e) {}
    var src = c.createBufferSource(); src.buffer = b; src.connect(c.destination);
    var at = c.currentTime;
    src.start();
    playing = { src: src, t0: s.start, pos: function () { return Math.min(s.end, s.start + (c.currentTime - at)); } };
    src.onended = function () { if (playing && playing.src === src) { playing = null; redraw(); } };
    var btn = el.pads.querySelector('[data-i="' + i + '"]');
    if (btn) { btn.classList.add('hit'); setTimeout(function () { btn.classList.remove('hit'); }, 120); }
    (function tick() { if (playing && playing.src === src) { redraw(); requestAnimationFrame(tick); } })();
  }
  el.pads.addEventListener('pointerdown', function (e) {
    var b = e.target.closest('[data-i]');
    if (b) { e.preventDefault(); play(parseInt(b.getAttribute('data-i'), 10)); }
  });
  document.addEventListener('keydown', function (e) {
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea' || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    var i = KEYS.indexOf(e.key.toLowerCase());
    if (i >= 0 && padSlices && padSlices[i]) { e.preventDefault(); play(i); }
  });

  /* ---------------------------------------------------------------- input */

  function reset() {
    buffer = null; chans = null; cuts = []; peaks = null;
    fileList.innerHTML = '';
    controls.style.display = 'none';
    CV.clearStatus(statusEl);
    progressWrap.style.display = 'none';
    el.pads.innerHTML = '';
    redraw();
  }

  CV.bindDropzone(dropzone, fileInput, async function (picked) {
    if (!picked || !picked.length) return;
    var file = picked[0];
    fileName = file.name.replace(/\.[^.]+$/, '').replace(/[^\w\- ]+/g, '').trim().slice(0, 40) || 'sample';
    el.prefix.value = fileName.replace(/\s+/g, '_');
    fileList.style.display = '';
    CV.renderFileList(fileList, [file], function () { reset(); });
    CV.setStatus(statusEl, 'info', 'Decoding…');
    try {
      buffer = await AudioSaw.decodeToAudioBuffer(file);
      if (buffer.duration > 600) throw new Error('That is over 10 minutes; slicing is for loops, breaks and phrases.');
      chans = [];
      for (var c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
      controls.style.display = '';
      var t = global.ASBpm ? global.ASBpm.analyse(buffer) : null;
      if (t && t.confidence >= 0.06) el.bpm.value = (Math.round(t.bpm * 10) / 10).toFixed(1);
      el.mode.value = 'transients';
      compute();
      CV.setStatus(statusEl, 'success', 'Cut into ' + cuts.length + ' slices at the hits. Play them on the pads, adjust, then download.');
    } catch (e) {
      CV.setStatus(statusEl, 'error', 'Could not read that file. ' + (e.message || e));
      buffer = null;
    }
  }, ACCEPT);

  ['mode', 'sens', 'count', 'beats', 'bpm'].forEach(function (k) {
    el[k].addEventListener(k === 'sens' ? 'input' : 'change', function () { if (el.mode.value !== 'manual') compute(); });
  });
  global.addEventListener('resize', function () { peaks = null; redraw(); });
  el.reset.addEventListener('click', reset);

  /* --------------------------------------------------------------- export */

  el.go.addEventListener('click', async function () {
    if (!buffer) return;
    el.go.disabled = true;
    progressWrap.style.display = '';
    CV.setProgress(progressBar, 0);
    try {
      var list = slices(), rate = parseInt(el.preset.value, 10) || buffer.sampleRate, mono = el.mono.checked;
      var prefix = (el.prefix.value || fileName).replace(/[^\w\-]+/g, '_').slice(0, 40) || 'slice';
      var entries = [];
      for (var i = 0; i < list.length; i++) {
        var s = list[i], ch = mono && s.channels.length > 1 ? [mixMono(s.channels)] : s.channels;
        var b = new AudioBuffer({ numberOfChannels: ch.length, length: ch[0].length, sampleRate: buffer.sampleRate });
        ch.forEach(function (d, k) { b.copyToChannel(d, k); });
        var out = await AudioSaw.resampleBuffer(b, rate);
        entries.push({ name: prefix + '_' + (i + 1 < 10 ? '0' : '') + (i + 1) + '.wav', blob: await AudioSaw.encode(out, 'wav16') });
        CV.setProgress(progressBar, (i + 1) / list.length * 90);
      }
      var zip = await AudioSaw.zipBlobs(entries);
      CV.setProgress(progressBar, 100);
      CV.downloadBlob(zip, prefix + '-slices.zip');
      CV.setStatus(statusEl, 'success', list.length + ' slices, 16-bit WAV at ' + (rate / 1000) + ' kHz' + (mono ? ', mono' : '') + ', zipped.');
    } catch (e) {
      CV.setStatus(statusEl, 'error', 'Could not export the slices. ' + (e.message || e));
    } finally {
      el.go.disabled = false;
    }
  });

  function mixMono(chs) {
    var n = chs[0].length, out = new Float32Array(n);
    for (var c = 0; c < chs.length; c++) for (var i = 0; i < n; i++) out[i] += chs[c][i] / chs.length;
    return out;
  }
})(window);
