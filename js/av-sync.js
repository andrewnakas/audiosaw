/*
 * ASSync: put a video's sound back in time with its picture.
 *
 * shift(): the sound is late (or early) by a fixed amount, or by one amount
 * at the start and another at the end (drift: a phone or camera whose audio
 * clock runs slightly fast or slow, so a talk that starts in sync is half a
 * second out an hour later). The output is always exactly `length` samples,
 * the video's own length, so the picture can be copied untouched beside it.
 *
 *   An event the camera filmed at video time t is heard in the file at
 *   s(t) = t + late + (lateEnd - late) * t / D. Reading the old sound at s(t)
 *   puts it back on t. That is a skip of `late` and then a read at speed
 *   1 + (lateEnd - late) / D: the sinc resampler (resample.js), at a ratio
 *   resolved to a thousandth of a hertz. Rounding the rate to whole hertz,
 *   which is what AudioSaw.varispeed does, would leave up to 37 ms of drift
 *   per hour at 48 kHz.
 *
 *   Where the shift cuts into sound (the start of an advanced track, the end
 *   of a delayed one) it fades over 5 ms, so the cut is not a click.
 *
 * align(): where the sound really is, found against a second recording of
 * the same moment: the camera's own sound against a separate microphone.
 * GCC-PHAT (cross-correlation with each frequency weighted to unit size):
 * the peak is the delay, not the loudest band, so two microphones with very
 * different tone still meet on one sharp peak. Coarse on a ~8 kHz copy over
 * the whole overlap, then at the full rate in a 2 s window around that, then
 * a parabola through the peak for a fraction of a sample. Done at the start
 * and the end of the take, it measures drift too. Checked by
 * tools/check-av-sync.js.
 *
 * UMD: runs in Node for the check and in the page.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./spectral.js'), require('./resample.js'));
  else root.ASSync = factory(root.ASSpectral, root.ASResample);
})(typeof self !== 'undefined' ? self : this, function (Spectral, Resample) {
  'use strict';

  var FADE = 0.005;

  function pow2(n) { var p = 1; while (p < n) p *= 2; return p; }

  // o: { late (s), lateEnd (s, optional), length (samples out), resample }
  function shift(chans, rate, o) {
    var late = +o.late || 0;
    var length = o.length != null ? o.length : chans[0].length;
    var D = length / rate;
    var lateEnd = o.lateEnd == null ? late : +o.lateEnd;
    var speed = D > 0 ? 1 + (lateEnd - late) / D : 1;
    var a = Math.round(late * rate);
    var R = o.resample || Resample;
    var fadeN = Math.max(1, Math.round(FADE * rate));
    return chans.map(function (x) {
      // Skip (or pad) to the first sample the output needs.
      var need = Math.ceil(length * speed) + 64;
      var src = new Float32Array(Math.max(0, need));
      for (var i = 0; i < src.length; i++) { var j = i + a; if (j >= 0 && j < x.length) src[i] = x[j]; }
      // A cut into sound at the front: the old file started before this.
      if (a > 0) for (var f = 0; f < fadeN && f < src.length; f++) src[f] *= f / fadeN;
      var y = src;
      if (Math.abs(speed - 1) > 1e-9) {
        if (!R || !R.channel) throw new Error('the resampler is not loaded');
        // Read at `speed`: the file treated as recorded at rate*speed, written at rate.
        y = R.channel(src, Math.round(rate * speed * 1000), rate * 1000);
      }
      var out = new Float32Array(length);
      out.set(y.length > length ? y.subarray(0, length) : y);
      // Where the old sound ran past the end of the new file, fade it out.
      var srcEnd = (x.length - a) / speed; // output sample where the old sound ends
      if (srcEnd > length) for (var e = 0; e < fadeN; e++) out[length - 1 - e] *= e / fadeN;
      // Where a delay leaves silence at the front, the old sound starts on a
      // real sample of the original, so nothing needs fading there.
      return out;
    });
  }

  function mono(chans, from, to) {
    var n = Math.max(0, to - from), m = new Float64Array(n), c = chans.length;
    for (var k = 0; k < c; k++) { var x = chans[k]; for (var i = 0; i < n; i++) { var j = from + i; if (j >= 0 && j < x.length) m[i] += x[j] / c; } }
    return m;
  }

  function decimate(x, k) {
    if (k <= 1) return x;
    var n = Math.floor(x.length / k), y = new Float64Array(n);
    for (var i = 0; i < n; i++) { var s = 0; for (var j = 0; j < k; j++) s += x[i * k + j]; y[i] = s / k; }
    return y;
  }

  // GCC-PHAT of a against b: returns the lag (in samples of these signals)
  // by which b's content sits later than a's, searched within +-maxLag, and
  // how much the peak stands above the rest.
  function gcc(a, b, maxLag, guard) {
    var N = pow2(a.length + b.length);
    var fft = Spectral.makeFFT(N);
    var ar = new Float64Array(N), ai = new Float64Array(N), br = new Float64Array(N), bi = new Float64Array(N);
    ar.set(a); br.set(b);
    fft.run(ar, ai, false); fft.run(br, bi, false);
    // Cross-spectrum B * conj(A), each bin brought to unit size.
    for (var i = 0; i < N; i++) {
      var re = br[i] * ar[i] + bi[i] * ai[i], im = bi[i] * ar[i] - br[i] * ai[i];
      var m = Math.hypot(re, im);
      if (m > 1e-20) { ar[i] = re / m; ai[i] = im / m; } else { ar[i] = 0; ai[i] = 0; }
    }
    fft.run(ar, ai, true);
    var best = -Infinity, at = 0;
    maxLag = Math.min(maxLag, N / 2 - 1);
    function v(l) { return ar[(l + N) % N]; }
    for (var l = -maxLag; l <= maxLag; l++) { var x = v(l); if (x > best) { best = x; at = l; } }
    // The runner-up outside the peak's own lobe, for confidence.
    var second = 0, sum = 0, cnt = 0;
    guard = guard || 8;
    for (var l2 = -maxLag; l2 <= maxLag; l2++) {
      var x2 = v(l2);
      if (Math.abs(l2 - at) > guard && x2 > second) second = x2;
      sum += x2 * x2; cnt++;
    }
    var rms = Math.sqrt(sum / Math.max(1, cnt));
    var y0 = v(at - 1), y1 = best, y2 = v(at + 1), den = y0 - 2 * y1 + y2;
    var frac = den < 0 ? 0.5 * (y0 - y2) / den : 0;
    return { lag: at + Math.max(-0.5, Math.min(0.5, frac)), peak: best, ratio: second > 0 ? best / second : Infinity, snr: rms > 0 ? best / rms : 0 };
  }

  function loudestWindow(m, len, rate) {
    // The most energetic stretch of `len` samples, in 0.5 s steps.
    var step = Math.max(1, Math.round(0.5 * rate)), best = -1, at = 0;
    var pre = new Float64Array(m.length + 1);
    for (var i = 0; i < m.length; i++) pre[i + 1] = pre[i] + m[i] * m[i];
    for (var s = 0; s + len <= m.length; s += step) { var e = pre[s + len] - pre[s]; if (e > best) { best = e; at = s; } }
    return at;
  }

  // Where `other` (a separate recording) sits against `ref` (the camera's
  // sound), both at `rate`, using the stretch [from, to) of ref (seconds).
  // Returns the offset in seconds: other's sample at time t + offset is the
  // ref's sample at time t (so offset > 0 means other started earlier).
  function offsetIn(refCh, othCh, rate, from, to, maxLagS) {
    var k = Math.max(1, Math.floor(rate / 8000)), cr = rate / k;
    var maxLag = Math.round(maxLagS * rate);
    // Coarse: the ref's stretch against the other's same stretch +- maxLag.
    var r0 = Math.max(0, Math.round(from * rate)), r1 = Math.min(refCh[0].length, Math.round(to * rate));
    var o0 = r0 - maxLag, o1 = r1 + maxLag;
    var ra = decimate(mono(refCh, r0, r1), k), ob = decimate(mono(othCh, o0, o1), k);
    var g = gcc(ra, ob, Math.round(2 * maxLag / k) + 2, Math.ceil(0.004 * cr));
    // ob starts maxLag before ra, so its content at lag L means other's
    // time = ref time + L*k - maxLag.
    var coarse = g.lag * k - maxLag;
    // Fine: 2 s of the loudest part of the stretch, at the full rate (short,
    // so drift does not smear the peak).
    var W = Math.min(r1 - r0, Math.round(2 * rate));
    var full = mono(refCh, r0, r1), w0 = r0 + loudestWindow(full, W, rate);
    var pad = 4 * k + 64, c = Math.round(coarse);
    var fa = mono(refCh, w0, w0 + W), fb = mono(othCh, w0 + c - pad, w0 + c + W + pad);
    var f = gcc(fa, fb, pad + 8, Math.ceil(0.004 * rate));
    var fine = c - pad + f.lag;
    if (Math.abs(fine - coarse) > 2 * k + 2) fine = coarse; // the fine window disagrees: trust the overlap
    return { offset: fine / rate, at: (w0 + W / 2) / rate, confidence: Math.min(g.ratio, f.ratio), snr: g.snr, coarseRate: cr };
  }

  // Lines `other` up with `ref`. Measures at the start and, for takes over
  // two minutes, at the end as well, which gives the drift.
  function align(refCh, othCh, rate, opts) {
    opts = opts || {};
    var D = refCh[0].length / rate, maxLagS = opts.maxLag || 10;
    var span = Math.min(D, opts.window || 60);
    var start = offsetIn(refCh, othCh, rate, 0, span, maxLagS);
    var res = { offset: start.offset, offsetEnd: start.offset, confidence: start.confidence, drift: 0, measuredAt: [start.at] };
    if (D > 120 && opts.drift !== false) {
      var e = offsetIn(refCh, othCh, rate, D - span, D, maxLagS);
      // Drift is a fraction of a second; a wildly different answer at the end
      // is a different moment matched, not drift.
      if (e.confidence > 2 && Math.abs(e.offset - start.offset) < 2) {
        // Each measurement holds at the middle of its fine window.
        var tA = start.at, tB = e.at;
        var slope = (e.offset - start.offset) / (tB - tA);
        res.offset = start.offset - slope * tA;
        res.offsetEnd = res.offset + slope * D;
        res.drift = slope;
        res.confidence = Math.min(start.confidence, e.confidence);
        res.measuredAt = [tA, tB];
      }
    }
    return res;
  }

  // A recording lined up to the video: `offset` and `offsetEnd` from align().
  // other at (t + offset(t)) goes to t. Same arithmetic as shift(), where the
  // "lateness" of the other recording against the picture is its offset.
  function place(othCh, rate, length, al, resample) {
    return shift(othCh, rate, { late: al.offset, lateEnd: al.offsetEnd, length: length, resample: resample });
  }

  return { shift: shift, align: align, place: place, gcc: gcc, FADE: FADE };
});
