/*
 * ASDeclick: clicks, pops and crackle out of vinyl and tape transfers (and
 * the odd digital tick), with everything that is not a click left bit for
 * bit as it was.
 *
 * Detection. Music and speech are predictable a fraction of a millisecond
 * ahead; a click is not. Each 4096-sample block gets a 32nd-order linear
 * predictor (autocorrelation method, Levinson-Durbin, Hann-windowed), and
 * its prediction error is compared with the error's *local* level: the
 * median absolute error over the surrounding 20 ms, in 1 ms pieces, so a
 * hi-hat or a breath raises its own bar and is not taken for a click. A
 * sample is a click candidate where the error passes `k` times that level
 * (k from the sensitivity setting). Candidates within 8 samples are joined
 * and widened by 3 samples each side (a click's tail is still in the
 * predictor's memory). Then two tests:
 *   - short: a run over 2.5 ms is not a click (a note's attack, a word);
 *   - isolated: the error in the 3 ms after the run must fall back to the
 *     level before it. A drum or a consonant starts a burst of error that
 *     goes on; a click stops.
 *
 * Repair. Least-squares AR interpolation (Godsill and Rayner's LSAR): the
 * missing samples are the ones that make the prediction error over the gap
 * and the 32 samples after it as small as possible, given the samples
 * either side. That is an m x m linear system (m the gap length), solved by
 * Cholesky. The predictor for a repair (order 128, see PR) is fitted on the
 * 2048 samples either
 * side of the click with the click itself left out, so a loud click does not
 * bend the model that fills it. Two passes: the second sees the first's
 * repairs, so crackle packed close together is found against a cleaner
 * model.
 *
 * Checked by tools/check-declick.js (synthetic clicks laid on music and
 * `say` speech at known places; clean drums that must be left alone).
 *
 * UMD: runs in Node for the check and in the page.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ASDeclick = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var P = 32, BLOCK = 4096, HOP = 2048;
  // The repair's predictor is far longer than the detector's: filling a gap
  // needs every partial of a chord modelled (two coefficients each), and
  // three notes with six harmonics each is already 36. Measured on the
  // check's chords, the median click improved 14.7 dB filled with order 32,
  // 19.3 with 64 and 22.7 with 128.
  var PR = 128;
  var SENS = { gentle: 14, normal: 9, strong: 6 };
  // Samples kept past the last flagged one: a click's ring is still dying
  // away when the error falls under the bar.
  var END = 10;

  // AR coefficients a[1..p] (x[n] ~ sum a[k] x[n-k]) from x[from..to), with
  // the samples in `skip` ([s, e) ranges) left out of the autocorrelation.
  function arFit(x, from, to, p, skip) {
    var n = to - from, w = new Float64Array(n);
    for (var i = 0; i < n; i++) w[i] = x[from + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / n));
    if (skip) skip.forEach(function (r) { for (var j = Math.max(r[0], from); j < Math.min(r[1], to); j++) w[j - from] = 0; });
    var r = new Float64Array(p + 1);
    for (var lag = 0; lag <= p; lag++) { var s = 0; for (var k = lag; k < n; k++) s += w[k] * w[k - lag]; r[lag] = s; }
    if (r[0] <= 1e-20) return null;
    r[0] *= 1 + 1e-9; // white-noise floor for numerical safety
    var a = new Float64Array(p + 1), tmp = new Float64Array(p + 1), e = r[0];
    for (var m = 1; m <= p; m++) {
      var acc = r[m];
      for (var q = 1; q < m; q++) acc -= a[q] * r[m - q];
      var kk = acc / e;
      tmp.set(a);
      a[m] = kk;
      for (var q2 = 1; q2 < m; q2++) a[q2] = tmp[q2] - kk * tmp[m - q2];
      e *= 1 - kk * kk;
      if (e <= 0) break;
    }
    return a;
  }

  // Prediction error over the whole channel, block by block: forward (each
  // sample from the 32 before it) or, with back set, backward (from the 32
  // after it; the autocorrelation method's predictor serves both ways).
  // A click starts as a burst of forward error and ends as one of backward
  // error: once the predictor has seen a few samples of a ringing click it
  // predicts the rest, so the forward error alone marks only its start.
  function residual(x, skip, back) {
    var n = x.length, e = new Float32Array(n);
    for (var b = 0; b < n; b += HOP) {
      var f = Math.max(0, b - (BLOCK - HOP) / 2), t = Math.min(n, f + BLOCK);
      if (t - f < 2 * P) continue;
      var a = arFit(x, f, t, P, skip);
      var end = Math.min(n, b + HOP);
      for (var i = b; i < end; i++) {
        if (!a) { e[i] = 0; continue; }
        var s = x[i];
        if (back) { for (var k2 = 1; k2 <= P && i + k2 < n; k2++) s -= a[k2] * x[i + k2]; }
        else { for (var k = 1; k <= P && i - k >= 0; k++) s -= a[k] * x[i - k]; }
        e[i] = s;
      }
    }
    return e;
  }

  function median(arr) { var s = Array.prototype.slice.call(arr).sort(function (u, v) { return u - v; }); return s.length ? s[s.length >> 1] : 0; }

  // Median |error| in 1 ms pieces, then the median of the pieces over +-10 ms.
  function localLevel(e, rate) {
    var piece = Math.max(8, Math.round(rate / 1000)), np = Math.ceil(e.length / piece), pm = new Float64Array(np);
    for (var j = 0; j < np; j++) {
      var a = j * piece, b = Math.min(e.length, a + piece), buf = [];
      for (var i = a; i < b; i++) buf.push(Math.abs(e[i]));
      pm[j] = median(buf);
    }
    var R = 10, lv = new Float64Array(np);
    for (var c = 0; c < np; c++) lv[c] = median(pm.subarray(Math.max(0, c - R), Math.min(np, c + R + 1)));
    return { piece: piece, lv: lv };
  }

  function runsOf(e, lv, piece, thr, floorOf) {
    var runs = [], cur = null, n = e.length;
    for (var i = 0; i < n; i++) {
      var lev = Math.max(floorOf(i), lv[Math.floor(i / piece)]);
      if (Math.abs(e[i]) > thr * 1.4826 * lev) {
        if (cur && i - cur[1] <= 8) cur[1] = i + 1;
        else { if (cur) runs.push(cur); cur = [i, i + 1]; }
      }
    }
    if (cur) runs.push(cur);
    return runs;
  }

  function find(x, rate, k, skip) {
    var n = x.length;
    var ef = residual(x, skip, false), eb = residual(x, skip, true);
    var Lf = localLevel(ef, rate), Lb = localLevel(eb, rate), piece = Lf.piece;
    // A floor 80 dB under the music around it, and -120 dBFS absolute:
    // synthesised or digitally silent stretches are predicted almost exactly,
    // and a bar set on that would call every rounding step a click.
    var bl = new Float64Array(Math.ceil(n / 4096));
    for (var b = 0; b < bl.length; b++) { var s2 = 0, c2 = 0; for (var i2 = b * 4096; i2 < Math.min(n, b * 4096 + 4096); i2++) { s2 += x[i2] * x[i2]; c2++; } bl[b] = Math.sqrt(s2 / Math.max(1, c2)); }
    var floorOf = function (i) { return Math.max(1e-6, 1e-4 * bl[Math.floor(i / 4096)]); };
    var maxLen = Math.round(0.0025 * rate), after = Math.round(0.003 * rate), JOIN = Math.round(0.0006 * rate), END_PAD = END;
    var fr = runsOf(ef, Lf.lv, piece, k, floorOf), br = runsOf(eb, Lb.lv, piece, k, floorOf);
    // Pair each forward run (a start) with the last backward run (an end)
    // that begins within maxLen of it; whatever is left on either side
    // stands alone.
    var spans = [], used = new Uint8Array(br.length), bi = 0;
    fr.forEach(function (f) {
      while (bi < br.length && br[bi][1] < f[0]) bi++;
      var end = f[1];
      for (var j = bi; j < br.length && br[j][0] < f[0] + maxLen; j++) { end = Math.max(end, br[j][1]); used[j] = 1; }
      spans.push([f[0], end]);
    });
    br.forEach(function (b2, j) { if (!used[j]) spans.push(b2); });
    spans.sort(function (u, v) { return u[0] - v[0]; });
    var out = [];
    spans.forEach(function (r) {
      var s = Math.max(0, r[0] - 3), t = Math.min(n, r[1] + END_PAD);
      if (t - s > maxLen) return;
      // Isolated: the forward error after the span, and the backward error
      // before it, are back to the local level. A drum or a consonant starts
      // a burst of error that goes on; a click stops.
      var lev = Math.max(floorOf(s), Lf.lv[Math.floor(s / piece)]), big = 0, cnt = 0;
      for (var j2 = t + P; j2 < Math.min(n, t + P + after); j2++) { cnt++; if (Math.abs(ef[j2]) > 3 * 1.4826 * lev) big++; }
      if (cnt && big / cnt > 0.15) return;
      var levb = Math.max(floorOf(s), Lb.lv[Math.floor(s / piece)]); big = 0; cnt = 0;
      for (var j3 = Math.max(0, s - P - after); j3 < s - P; j3++) { cnt++; if (Math.abs(eb[j3]) > 3 * 1.4826 * levb) big++; }
      if (cnt && big / cnt > 0.15) return;
      // Pieces of one click (a scratch is several impulses) closer than
      // 0.6 ms are repaired as one.
      if (out.length && s <= out[out.length - 1][1] + JOIN && t - out[out.length - 1][0] <= maxLen) out[out.length - 1][1] = Math.max(out[out.length - 1][1], t);
      else out.push([s, t]);
    });
    return out;
  }

  // Solve the LSAR system for x[s..t) in place.
  function lsar(x, s, t, a) {
    var p = a.length - 1, m = t - s, n = x.length;
    // Rows: prediction errors e[i] for i in [s, t + p), each e[i] = sum_{j=0..p} c_j x[i-j], c_0 = 1, c_j = -a_j.
    // Unknown part U (columns for s..t-1) and known part K.
    var A = new Float64Array(m * m), b = new Float64Array(m);
    for (var i = s; i < Math.min(n, t + p); i++) {
      // Contribution of this row: coefficients on unknowns and the known sum.
      var known = 0, idx = [], val = [];
      for (var j = 0; j <= p; j++) {
        var q = i - j;
        if (q < 0) continue;
        var c = j === 0 ? 1 : -a[j];
        if (q >= s && q < t) { idx.push(q - s); val.push(c); } else known += c * x[q];
      }
      for (var u = 0; u < idx.length; u++) {
        b[idx[u]] -= val[u] * known;
        for (var v = 0; v < idx.length; v++) A[idx[u] * m + idx[v]] += val[u] * val[v];
      }
    }
    // Cholesky.
    for (var r = 0; r < m; r++) A[r * m + r] += 1e-12;
    for (var c1 = 0; c1 < m; c1++) {
      var d = A[c1 * m + c1];
      for (var k = 0; k < c1; k++) d -= A[c1 * m + k] * A[c1 * m + k];
      if (d <= 0) return false;
      d = Math.sqrt(d); A[c1 * m + c1] = d;
      for (var r2 = c1 + 1; r2 < m; r2++) {
        var sum = A[r2 * m + c1];
        for (var k2 = 0; k2 < c1; k2++) sum -= A[r2 * m + k2] * A[c1 * m + k2];
        A[r2 * m + c1] = sum / d;
      }
    }
    var y = new Float64Array(m);
    for (var r3 = 0; r3 < m; r3++) { var s3 = b[r3]; for (var k3 = 0; k3 < r3; k3++) s3 -= A[r3 * m + k3] * y[k3]; y[r3] = s3 / A[r3 * m + r3]; }
    for (var r4 = m - 1; r4 >= 0; r4--) { var s4 = y[r4]; for (var k4 = r4 + 1; k4 < m; k4++) s4 -= A[k4 * m + r4] * y[k4]; y[r4] = s4 / A[r4 * m + r4]; }
    for (var w = 0; w < m; w++) x[s + w] = y[w];
    return true;
  }

  function repair(x, clicks) {
    var n = x.length, fixed = 0;
    clicks.forEach(function (c) {
      if (c[0] < PR || c[1] + PR > n) return;
      var f = Math.max(0, c[0] - 2048), t = Math.min(n, c[1] + 2048);
      // Leave this click and its neighbours out of the fit.
      var near = clicks.filter(function (d) { return d[1] > f && d[0] < t; });
      var a = arFit(x, f, t, PR, near);
      if (a && lsar(x, c[0], c[1], a)) fixed++;
    });
    return fixed;
  }

  // chans: Float32Arrays (not modified). opts: { sensitivity: 'gentle' |
  // 'normal' | 'strong' } or { k }. Returns { channels, clicks: [[s, e]]
  // per channel, count, samples }.
  function process(chans, rate, opts) {
    opts = opts || {};
    var k = opts.k || SENS[opts.sensitivity || 'normal'];
    var out = [], all = [], count = 0, touched = 0;
    chans.forEach(function (ch) {
      var x = Float32Array.from(ch), found = [];
      for (var pass = 0; pass < 2; pass++) {
        var c = find(x, rate, k, found);
        // Only new clicks: ones not already repaired.
        c = c.filter(function (r) { return !found.some(function (q) { return r[0] < q[1] && r[1] > q[0]; }); });
        if (!c.length) break;
        repair(x, c);
        found = found.concat(c).sort(function (u, v) { return u[0] - v[0]; });
      }
      out.push(x); all.push(found);
      count += found.length;
      found.forEach(function (r) { touched += r[1] - r[0]; });
    });
    return { channels: out, clicks: all, count: count, samples: touched };
  }

  return { process: process, find: find, repair: repair, arFit: arFit, lsar: lsar, residual: residual, SENS: SENS };
});
