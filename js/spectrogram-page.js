/*
 * /spectrogram page controller. The file is decoded at its own rate, mixed
 * or split by channel, and js/spectrogram.js analyses only the stretch on
 * screen, one FFT per pixel column, so zooming in shows real detail rather
 * than a stretched picture. Columns are drawn left to right in batches,
 * yielding between them, so a long file never freezes the tab.
 *
 * Drag across the picture to zoom into that stretch; double-click (or Fit)
 * to see the whole file. The readout under the cursor is time, frequency and
 * level. Play runs the file from the left edge of the view (or from a click)
 * with a moving line. "Save PNG" renders a fresh image with axes, a
 * colour bar and the file name, and goes through CV.downloadBlob, so it is
 * this page's convert_success.
 */
(function (global) {
  'use strict';
  var CV = global.CV, S = global.ASSpectro;
  if (!CV || !S || !global.AudioSaw) { console.error('[spectrogram] the /js/* includes must come before spectrogram-page.js'); return; }
  var $ = CV.$;
  var el = {
    dropzone: $('#dropzone'), fileInput: $('#fileInput'), fileList: $('#fileList'), status: $('#status'), view: $('#sgView'),
    canvas: $('#sgCanvas'), over: $('#sgOver'), readout: $('#sgReadout'), scale: $('#sgScale'), fft: $('#sgFft'), floor: $('#sgFloor'),
    channel: $('#sgChannel'), top: $('#sgTop'), play: $('#sgPlay'), fit: $('#sgFit'), zin: $('#sgIn'), zout: $('#sgOut'), png: $('#sgPng')
  };
  if (!el.dropzone || !el.canvas) return;
  var file = null, buf = null, mono = null, view = { t0: 0, t1: 0 }, job = 0, grid = null, gridOpt = null;
  var AX_L = 52, AX_B = 22;
  var actx = null, src = null, playFrom = 0, playAt = 0, raf = 0;

  function opts() {
    var rate = buf.sampleRate, top = el.top.value === 'nyq' ? rate / 2 : Math.min(rate / 2, +el.top.value);
    return { rate: rate, fft: +el.fft.value, log: el.scale.value === 'log', minHz: el.scale.value === 'log' ? 20 : 0, maxHz: top, floor: +el.floor.value };
  }
  function signal() {
    var c = el.channel.value, n = buf.length;
    if (c === 'L' || buf.numberOfChannels === 1) return buf.getChannelData(0);
    if (c === 'R') return buf.getChannelData(1);
    if (mono) return mono;
    mono = new Float32Array(n);
    for (var k = 0; k < buf.numberOfChannels; k++) { var d = buf.getChannelData(k); for (var i = 0; i < n; i++) mono[i] += d[i] / buf.numberOfChannels; }
    return mono;
  }
  function fmtT(s) { var m = Math.floor(s / 60), r = s - m * 60; return m ? m + ':' + (r < 10 ? '0' : '') + r.toFixed(r < 10 && (view.t1 - view.t0) < 20 ? 2 : 1) : r.toFixed((view.t1 - view.t0) < 5 ? 3 : 1) + ' s'; }
  function axHz(f) { return f >= 1000 ? (f / 1000) + 'k' : String(f); }
  function fmtHz(h) { return h >= 1000 ? (h / 1000).toFixed(h >= 10000 ? 1 : 2) + ' kHz' : Math.round(h) + ' Hz'; }

  function axisTicks(g, W, H, o, t0, t1, ink) {
    g.fillStyle = ink; g.strokeStyle = ink; g.font = '11px system-ui, sans-serif'; g.lineWidth = 1;
    var plotW = W - AX_L, plotH = H - AX_B;
    var freqs = o.log ? [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 40000] : (function () { var s = o.maxHz > 30000 ? 10000 : o.maxHz > 12000 ? 2000 : o.maxHz > 5000 ? 1000 : 500, a = []; for (var f = 0; f <= o.maxHz; f += s) a.push(f); return a; })();
    freqs.forEach(function (f) {
      if (f < o.minHz || f > o.maxHz) return;
      var y = S.hzRow(f, plotH, o) + 0.5;
      g.fillRect(AX_L - 4, y, 4, 1);
      g.fillText(axHz(f), 2, Math.max(10, Math.min(plotH - 2, y + 4)));
    });
    var span = t1 - t0, steps = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600], st = steps.filter(function (s) { return span / s <= 10; })[0] || 600;
    for (var t = Math.ceil(t0 / st) * st; t <= t1; t += st) {
      var x = AX_L + (t - t0) / span * plotW;
      g.fillRect(x, plotH, 1, 4);
      g.fillText(fmtT(t), Math.min(W - 40, x - 10), H - 6);
    }
  }

  async function draw() {
    if (!buf) return;
    var my = ++job, dpr = global.devicePixelRatio || 1;
    var W = el.canvas.clientWidth, H = el.canvas.clientHeight;
    el.canvas.width = Math.round(W * dpr); el.canvas.height = Math.round(H * dpr);
    el.over.width = el.canvas.width; el.over.height = el.canvas.height;
    var g = el.canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    var css = getComputedStyle(document.body), ink = css.getPropertyValue('--ink').trim() || '#222', paper = css.getPropertyValue('--card').trim() || '#fff';
    g.fillStyle = paper; g.fillRect(0, 0, W, H);
    var o = opts(), cols = Math.min(2400, Math.round((W - AX_L) * dpr)), rows = Math.min(1200, Math.round((H - AX_B) * dpr));
    var x = signal();
    grid = new Float32Array(cols * rows); gridOpt = { o: o, cols: cols, rows: rows, t0: view.t0, t1: view.t1 };
    var img = g.createImageData(cols, rows), B = 64;
    for (var c0 = 0; c0 < cols; c0 += B) {
      if (my !== job) return;
      var c1 = Math.min(cols, c0 + B), span = (view.t1 - view.t0) / cols;
      var part = S.grid(x, { rate: o.rate, fft: o.fft, log: o.log, minHz: o.minHz, maxHz: o.maxHz, t0: view.t0 + c0 * span, t1: view.t0 + c1 * span, cols: c1 - c0, rows: rows });
      var rgba = S.paint(part, c1 - c0, rows, o.floor);
      for (var r = 0; r < rows; r++) {
        for (var c = c0; c < c1; c++) {
          var si = (r * (c1 - c0) + (c - c0)), di = (r * cols + c);
          grid[di] = part[si];
          img.data[di * 4] = rgba[si * 4]; img.data[di * 4 + 1] = rgba[si * 4 + 1]; img.data[di * 4 + 2] = rgba[si * 4 + 2]; img.data[di * 4 + 3] = 255;
        }
      }
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.putImageData(img, Math.round(AX_L * dpr), 0, c0, 0, c1 - c0, rows);
      await new Promise(function (res) { setTimeout(res, 0); });
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    axisTicks(g, W, H, o, view.t0, view.t1, ink);
    el.view.setAttribute('data-ready', '1');
  }

  function at(ev) {
    var r = el.canvas.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top;
    var plotW = r.width - AX_L, plotH = r.height - AX_B;
    if (x < AX_L || y > plotH || !gridOpt) return null;
    var t = view.t0 + (x - AX_L) / plotW * (view.t1 - view.t0), hz = S.rowHz(y / plotH * gridOpt.rows - 0.5, gridOpt.rows, gridOpt.o);
    var c = Math.min(gridOpt.cols - 1, Math.floor((x - AX_L) / plotW * gridOpt.cols)), row = Math.min(gridOpt.rows - 1, Math.floor(y / plotH * gridOpt.rows));
    return { x: x, t: t, hz: hz, db: grid[row * gridOpt.cols + c] };
  }

  function overlay(selA, selB) {
    var dpr = global.devicePixelRatio || 1, g = el.over.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, el.over.width, el.over.height);
    var W = el.over.clientWidth, H = el.over.clientHeight - AX_B;
    if (selA != null) { g.fillStyle = 'rgba(255,255,255,.18)'; g.fillRect(Math.min(selA, selB), 0, Math.abs(selB - selA), H); }
    if (src && actx) {
      var t = playFrom + (actx.currentTime - playAt);
      if (t >= view.t0 && t <= view.t1) { var x = AX_L + (t - view.t0) / (view.t1 - view.t0) * (W - AX_L); g.fillStyle = '#fff'; g.fillRect(x, 0, 1.5, H); }
    }
  }

  var dragA = null;
  el.over.addEventListener('pointerdown', function (ev) { var p = at(ev); if (!p) return; dragA = p; el.over.setPointerCapture(ev.pointerId); });
  el.over.addEventListener('pointermove', function (ev) {
    var p = at(ev);
    if (p) el.readout.textContent = fmtT(p.t) + ' · ' + fmtHz(p.hz) + ' · ' + (isFinite(p.db) ? p.db.toFixed(1) : '–') + ' dB';
    if (dragA && p) overlay(dragA.x, p.x);
  });
  el.over.addEventListener('pointerup', function (ev) {
    var p = at(ev), a = dragA; dragA = null; overlay();
    if (!a || !p) return;
    if (Math.abs(p.x - a.x) < 6) { playFrom = a.t; if (src) { stop(); play(); } return; }
    view = { t0: Math.min(a.t, p.t), t1: Math.max(a.t, p.t) };
    if (view.t1 - view.t0 < 0.02) view.t1 = view.t0 + 0.02;
    draw();
  });
  el.over.addEventListener('dblclick', fit);

  function fit() { if (!buf) return; view = { t0: 0, t1: buf.duration }; draw(); }
  function zoom(f) {
    if (!buf) return;
    var c = (view.t0 + view.t1) / 2, h = Math.min(buf.duration, Math.max(0.02, (view.t1 - view.t0) * f)) / 2;
    view = { t0: Math.max(0, c - h), t1: Math.min(buf.duration, c + h) };
    draw();
  }
  el.fit.addEventListener('click', fit);
  el.zin.addEventListener('click', function () { zoom(0.5); });
  el.zout.addEventListener('click', function () { zoom(2); });
  [el.scale, el.fft, el.floor, el.channel, el.top].forEach(function (s) { s.addEventListener('change', draw); });
  global.addEventListener('resize', function () { if (buf) draw(); });

  function stop() { if (src) { try { src.stop(); } catch (e) {} src = null; } cancelAnimationFrame(raf); el.play.textContent = 'Play'; overlay(); }
  function play() {
    if (!buf) return;
    var C = global.AudioContext || global.webkitAudioContext;
    actx = actx || new C();
    actx.resume();
    src = actx.createBufferSource(); src.buffer = buf; src.connect(actx.destination);
    var from = playFrom >= view.t0 && playFrom < view.t1 ? playFrom : view.t0;
    playFrom = from; playAt = actx.currentTime;
    src.start(0, from);
    src.onended = function () { if (src) stop(); };
    el.play.textContent = 'Stop';
    (function loop() { overlay(); raf = requestAnimationFrame(loop); })();
  }
  el.play.addEventListener('click', function () { if (src) stop(); else play(); });

  // A fresh image for saving: the view, with axes, a colour bar and a title.
  function exportPng() {
    if (!buf) return;
    var W = 1600, H = 900, L = 70, T = 44, Rm = 90, Bm = 46, pw = W - L - Rm, ph = H - T - Bm;
    var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    var g = cv.getContext('2d'), o = opts();
    g.fillStyle = '#111'; g.fillRect(0, 0, W, H);
    var part = S.grid(signal(), { rate: o.rate, fft: o.fft, log: o.log, minHz: o.minHz, maxHz: o.maxHz, t0: view.t0, t1: view.t1, cols: pw, rows: ph });
    var img = g.createImageData(pw, ph); S.paint(part, pw, ph, o.floor, img.data); g.putImageData(img, L, T);
    g.fillStyle = '#eee'; g.font = '600 18px system-ui, sans-serif'; g.fillText(file.name, L, 28);
    g.font = '13px system-ui, sans-serif'; g.fillStyle = '#bbb';
    g.fillText((buf.sampleRate / 1000) + ' kHz · FFT ' + o.fft + ' · ' + (o.log ? 'log' : 'linear') + ' frequency · audiosaw.com/spectrogram', L + pw - 420, 28);
    g.save(); g.translate(0, T);
    var freqs = o.log ? [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 40000] : []; if (!o.log) { var s = o.maxHz > 12000 ? 2000 : 1000; for (var f = 0; f <= o.maxHz; f += s) freqs.push(f); }
    freqs.forEach(function (f) { if (f < o.minHz || f > o.maxHz) return; var y = S.hzRow(f, ph, o) + 0.5; g.fillStyle = '#ccc'; g.fillRect(L - 6, y, 6, 1); g.fillText(axHz(f) + 'Hz', 6, y + 4); });
    g.restore();
    var span = view.t1 - view.t0, steps = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600], st = steps.filter(function (q) { return span / q <= 12; })[0] || 600;
    g.fillStyle = '#ccc';
    for (var t = Math.ceil(view.t0 / st) * st; t <= view.t1; t += st) { var x = L + (t - view.t0) / span * pw; g.fillRect(x, T + ph, 1, 6); g.fillText(fmtT(t), x - 14, T + ph + 22); }
    for (var y2 = 0; y2 < ph; y2++) { var k = Math.round((1 - y2 / ph) * 255); g.fillStyle = 'rgb(' + S.LUT[k * 3] + ',' + S.LUT[k * 3 + 1] + ',' + S.LUT[k * 3 + 2] + ')'; g.fillRect(L + pw + 24, T + y2, 18, 1); }
    g.fillStyle = '#ccc'; g.fillText('0 dB', L + pw + 48, T + 10); g.fillText(o.floor + ' dB', L + pw + 48, T + ph);
    cv.toBlob(function (b) { CV.downloadBlob(b, file.name.replace(/\.[^.]+$/, '') + '-spectrogram.png'); }, 'image/png');
  }
  el.png.addEventListener('click', exportPng);

  CV.bindDropzone(el.dropzone, el.fileInput, async function (files) {
    var f = files[0]; if (!f) return;
    stop();
    CV.renderFileList(el.fileList, [f], function () { buf = null; el.view.hidden = true; el.fileList.style.display = 'none'; });
    el.fileList.style.display = '';
    try {
      CV.setStatus(el.status, 'info', 'Reading ' + f.name + '…');
      var b = await global.AudioSaw.decodeToAudioBuffer(f);
      file = f; buf = b; mono = null; playFrom = 0;
      el.channel.disabled = b.numberOfChannels < 2;
      el.top.querySelector('[value="nyq"]').textContent = 'Up to ' + fmtHz(b.sampleRate / 2) + ' (all of it)';
      el.view.hidden = false;
      view = { t0: 0, t1: b.duration };
      CV.clearStatus(el.status);
      if (CV.signal && b.srcInfo) CV.signal.input(global.AudioSaw.describeFormat(b.srcInfo));
      await draw();
    } catch (e) { CV.setStatus(el.status, 'error', 'Could not read that file. ' + (e.message || e), e); }
  });

  global.__spectro = { draw: draw, png: exportPng, view: function () { return view; }, grid: function () { return { grid: grid, opt: gridOpt }; }, setView: function (a, b) { view = { t0: a, t1: b }; return draw(); } };
})(window);
