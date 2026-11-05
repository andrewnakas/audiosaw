/*
 * ASSpectro: a spectrogram image from samples. Behind /spectrogram.
 *
 * grid(): one column per output pixel. Each column is an FFT (Hann, N
 * points) centred on that column's time (the loudest of up to 8 across it
 * when zoomed out), so zooming in re-analyses the audio
 * rather than stretching a picture. Rows map to frequency, linear or log;
 * where a row covers several bins (the top of a log scale, or a short
 * image), it takes the loudest, so a narrow tone is never averaged away.
 * Values are dB relative to a full-scale sine.
 *
 * paint(): the grid into RGBA with a perceptually even colormap (magma's
 * stops), floor to 0 dB.
 *
 * Checked by tools/check-spectrogram.js: a 1 kHz tone, two tones and a log
 * chirp must land on their rows.
 *
 * UMD: runs in Node for the check and in the page.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./spectral.js'));
  else root.ASSpectro = factory(root.ASSpectral);
})(typeof self !== 'undefined' ? self : this, function (Spectral) {
  'use strict';

  // magma, 9 stops (matplotlib's), dark to light.
  var MAGMA = [[0, 0, 4], [28, 16, 68], [79, 18, 123], [129, 37, 129], [181, 54, 122], [229, 80, 100], [251, 135, 97], [254, 194, 135], [252, 253, 191]];
  var LUT = (function () {
    var t = new Uint8Array(256 * 3);
    for (var i = 0; i < 256; i++) {
      var x = i / 255 * (MAGMA.length - 1), k = Math.min(MAGMA.length - 2, Math.floor(x)), f = x - k;
      for (var c = 0; c < 3; c++) t[i * 3 + c] = Math.round(MAGMA[k][c] + (MAGMA[k + 1][c] - MAGMA[k][c]) * f);
    }
    return t;
  })();

  var ffts = {};
  function fftOf(N) { return ffts[N] || (ffts[N] = { f: Spectral.makeFFT(N), w: hann(N) }); }
  function hann(N) { var w = new Float64Array(N), s = 0; for (var i = 0; i < N; i++) { w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N); s += w[i]; } w.sum = s; return w; }

  // Frequency of row r (0 = top) of `rows`.
  function rowHz(r, rows, o) {
    var u = 1 - (r + 0.5) / rows;
    return o.log ? o.minHz * Math.pow(o.maxHz / o.minHz, u) : o.minHz + (o.maxHz - o.minHz) * u;
  }
  function hzRow(hz, rows, o) {
    var u = o.log ? Math.log(hz / o.minHz) / Math.log(o.maxHz / o.minHz) : (hz - o.minHz) / (o.maxHz - o.minHz);
    return (1 - u) * rows - 0.5;
  }

  // x: mono Float32Array. o: { rate, t0, t1 (s), cols, rows, fft, log,
  // minHz, maxHz }. Returns Float32Array(cols * rows) of dB, row-major from
  // the top row.
  function grid(x, o) {
    var rate = o.rate, N = o.fft || 4096, F = fftOf(N), cols = o.cols, rows = o.rows;
    var minHz = o.minHz || (o.log ? 20 : 0), maxHz = Math.min(o.maxHz || rate / 2, rate / 2);
    var opt = { log: !!o.log, minHz: Math.max(o.log ? 1 : 0, minHz), maxHz: maxHz };
    var t0 = o.t0 || 0, t1 = o.t1 == null ? x.length / rate : o.t1;
    var out = new Float32Array(cols * rows), re = new Float64Array(N), im = new Float64Array(N);
    var bins = N / 2 + 1, mag = new Float64Array(bins), binHz = rate / N;
    // Bin range per row, fixed for the whole image.
    var lo = new Int32Array(rows), hi = new Int32Array(rows);
    for (var r = 0; r < rows; r++) {
      var fa = rowHz(r - 0.5, rows, opt), fb = rowHz(r + 0.5, rows, opt);
      var a = Math.min(fa, fb), b = Math.max(fa, fb);
      lo[r] = Math.max(0, Math.min(bins - 1, Math.round(a / binHz)));
      hi[r] = Math.max(lo[r], Math.min(bins - 1, Math.round(b / binHz)));
    }
    var scale = 2 / F.w.sum; // a full-scale sine reads 0 dB
    // Zoomed out, a column spans many FFT lengths: take the loudest of up to
    // 8 spread across it, so a click or a short note between two column
    // centres still shows.
    var span = (t1 - t0) * rate / cols, per = Math.max(1, Math.min(8, Math.round(span / (N / 2))));
    for (var c = 0; c < cols; c++) {
      for (var z = 0; z < bins; z++) mag[z] = 0;
      for (var p = 0; p < per; p++) {
        var centre = Math.round((t0 + (t1 - t0) * (c + (p + 0.5) / per) / cols) * rate), s = centre - N / 2;
        for (var i = 0; i < N; i++) { var j = s + i; re[i] = j >= 0 && j < x.length ? x[j] * F.w[i] : 0; im[i] = 0; }
        F.f.run(re, im, false);
        for (var k = 0; k < bins; k++) { var v = Math.hypot(re[k], im[k]) * scale; if (v > mag[k]) mag[k] = v; }
      }
      for (var r2 = 0; r2 < rows; r2++) {
        var m = 0;
        if (hi[r2] > lo[r2]) { for (var q = lo[r2]; q <= hi[r2]; q++) if (mag[q] > m) m = mag[q]; }
        else {
          // Several rows share one bin: interpolate between neighbours.
          var f = rowHz(r2, rows, opt) / binHz, k0 = Math.min(bins - 2, Math.floor(f)), u = f - k0;
          m = mag[k0] * (1 - u) + mag[k0 + 1] * u;
        }
        out[r2 * cols + c] = 20 * Math.log10(m + 1e-12);
      }
    }
    return out;
  }

  function paint(g, cols, rows, floorDb, rgba) {
    rgba = rgba || new Uint8ClampedArray(cols * rows * 4);
    for (var i = 0; i < cols * rows; i++) {
      var v = (g[i] - floorDb) / -floorDb, k = Math.max(0, Math.min(255, Math.round(v * 255)));
      rgba[i * 4] = LUT[k * 3]; rgba[i * 4 + 1] = LUT[k * 3 + 1]; rgba[i * 4 + 2] = LUT[k * 3 + 2]; rgba[i * 4 + 3] = 255;
    }
    return rgba;
  }

  return { grid: grid, paint: paint, rowHz: rowHz, hzRow: hzRow, LUT: LUT };
});
