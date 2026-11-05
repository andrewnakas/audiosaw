/*
 * ASLoop: a loop that repeats without a click or a hiccup. Behind
 * /seamless-loop-maker.
 *
 * find(): given a rough start and end, where should the loop really end?
 * A loop is seamless when the sound just before its end matches the sound
 * just before its start, because on repeat one runs straight into the
 * other. So the end is searched within +-maxShift of the rough one for the
 * offset whose preceding window (default 50 ms) best matches the window
 * before the start: normalised cross-correlation, computed with FFTs over
 * the whole search range, on all channels. The best lag is refined to the
 * sample, and the end then moved to the nearest upward zero crossing within
 * a millisecond whose slope matches the start's. With a tempo, the length
 * is whole bars to the sample, with no search, so the loop stays in time
 * with a project at that tempo; the crossfade makes the seam.
 *
 * make(): the loop itself. The last `fade` (default 10 ms) is crossfaded
 * equal-power with the sound just before the start, so the join is the
 * same sound arriving from both sides: playing the result on repeat runs
 * through the seam with no step.
 *
 * Checked by tools/check-loop.js.
 *
 * UMD: runs in Node for the check and in the page.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./spectral.js'));
  else root.ASLoop = factory(root.ASSpectral);
})(typeof self !== 'undefined' ? self : this, function (Spectral) {
  'use strict';

  function pow2(n) { var p = 1; while (p < n) p *= 2; return p; }
  function mono(chans) {
    if (chans.length === 1) return chans[0];
    var n = chans[0].length, m = new Float32Array(n);
    for (var c = 0; c < chans.length; c++) for (var i = 0; i < n; i++) m[i] += chans[c][i] / chans.length;
    return m;
  }

  // Normalised correlation of the template t against every position of the
  // signal x[a .. b + t.length): returns scores for lags 0 .. b - a.
  function ncc(x, a, b, t) {
    var L = t.length, n = b - a + L, N = pow2(n + L);
    var fft = Spectral.makeFFT(N), xr = new Float64Array(N), xi = new Float64Array(N), tr = new Float64Array(N), ti = new Float64Array(N);
    var tm = 0; for (var i = 0; i < L; i++) tm += t[i]; tm /= L;
    var tn = 0; for (var j = 0; j < L; j++) { tr[j] = t[j] - tm; tn += tr[j] * tr[j]; }
    for (var k = 0; k < n; k++) xr[k] = a + k >= 0 && a + k < x.length ? x[a + k] : 0;
    fft.run(xr, xi, false); fft.run(tr, ti, false);
    // x correlated with t: X * conj(T).
    var pr = new Float64Array(N), pi = new Float64Array(N);
    for (var q = 0; q < N; q++) { pr[q] = xr[q] * tr[q] + xi[q] * ti[q]; pi[q] = xi[q] * tr[q] - xr[q] * ti[q]; }
    fft.run(pr, pi, true);
    // Local energy of x under the window, for normalising.
    var out = new Float64Array(b - a + 1), s = 0, s2 = 0, xs = [];
    for (var m = 0; m < n; m++) xs.push(a + m >= 0 && a + m < x.length ? x[a + m] : 0);
    for (var u = 0; u < L; u++) { s += xs[u]; s2 += xs[u] * xs[u]; }
    for (var lag = 0; lag <= b - a; lag++) {
      var varx = s2 - s * s / L;
      out[lag] = varx > 1e-12 && tn > 1e-12 ? pr[lag] / Math.sqrt(varx * tn) : 0;
      if (lag + L < n) { s += xs[lag + L] - xs[lag]; s2 += xs[lag + L] * xs[lag + L] - xs[lag] * xs[lag]; }
    }
    return out;
  }

  // o: { start, end (samples), maxShift (samples), win (samples), bpm,
  // beatsPerBar }. Returns { start, end, score, bars }.
  function find(chans, rate, o) {
    var x = mono(chans), n = x.length;
    var win = o.win || Math.round(0.05 * rate), start = Math.max(win, Math.round(o.start));
    var end = Math.round(o.end), bars = null, maxShift = o.maxShift != null ? o.maxShift : Math.round(0.25 * rate);
    if (o.bpm) {
      var bar = 60 / o.bpm * (o.beatsPerBar || 4) * rate;
      bars = Math.max(1, Math.round((end - start) / bar));
      end = start + Math.round(bars * bar);
      maxShift = 0; // whole bars, to the sample: the crossfade makes the seam
    }
    end = Math.min(n, end);
    var tmpl = x.subarray(start - win, start);
    var a = Math.max(win, end - maxShift) - win, b = Math.min(n, end + maxShift) - win;
    var sc = ncc(x, a, b, tmpl), best = 0;
    for (var i = 1; i < sc.length; i++) if (sc[i] > sc[best]) best = i;
    var newEnd = a + best + win;
    // The nearest zero crossing (same slope as at the start) within 1 ms.
    var up = x[start] >= x[start - 1], ms = Math.round(0.001 * rate), zc = null;
    for (var d = 0; d <= ms && zc == null; d++) {
      [newEnd - d, newEnd + d].forEach(function (k) {
        if (zc != null || k < 1 || k >= n) return;
        if ((x[k - 1] <= 0 && x[k] > 0 && up) || (x[k - 1] >= 0 && x[k] < 0 && !up)) zc = k;
      });
    }
    // Only take the zero crossing when it does not cost the match (a bar
    // loop must keep its length to the sample).
    if (zc != null && !o.bpm) newEnd = zc;
    return { start: start, end: newEnd, score: sc[best], bars: bars };
  }

  // The loop, with its last `fade` samples crossfaded into what came before
  // the start. Returns new channels of length end - start.
  function make(chans, rate, start, end, opts) {
    opts = opts || {};
    var len = end - start, F = Math.min(Math.round((opts.fade || 0.01) * rate), Math.floor(len / 4), start);
    return chans.map(function (x) {
      var y = Float32Array.from(x.subarray(start, end));
      for (var i = 0; i < F; i++) {
        // At the end of the loop, fade from the loop's own tail into the
        // sound just before the start, which is what plays into y[0].
        var u = (i + 0.5) / F, gOut = Math.cos(u * Math.PI / 2), gIn = Math.sin(u * Math.PI / 2);
        var k = len - F + i;
        y[k] = x[start + k] * gOut + x[start - F + i] * gIn;
      }
      return y;
    });
  }

  // Repeat a loop n times (for the "longer file" download).
  function repeat(loop, times) {
    return loop.map(function (y) { var out = new Float32Array(y.length * times); for (var t = 0; t < times; t++) out.set(y, t * y.length); return out; });
  }

  return { find: find, make: make, repeat: repeat, ncc: ncc };
});
