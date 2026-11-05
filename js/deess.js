/*
 * ASDeess: turns down harsh "s", "sh", "ch" and "t" sounds in a voice, and
 * nothing else. Behind /de-esser.
 *
 * Split. The high band is the signal minus a zero-phase low-pass (a 4th-
 * order Butterworth run forwards and backwards), so the two bands add back
 * to the input exactly, and the output is x - (1 - g) * high: wherever the
 * gain g is 1, the output is the input, sample for sample.
 *
 * Detect. A sibilant is a sound whose energy is mostly in the high band:
 * in 5 ms frames, the share of the energy above the crossover. Vowels sit
 * under 10%; an "s" is well over half. Frames over `share` (default 45%)
 * and loud enough to matter (within 40 dB of the voice's loud frames) are
 * sibilant; the reduction ramps in over the 15 points above the threshold.
 *
 * Shape. The gain curve is smoothed with a 6 ms raised-cosine window
 * centred on each sample: that is look-ahead (it starts turning down before
 * the "s" arrives) and release in one, with no pumping.
 *
 * Where. The crossover is placed under the voice's own sibilance: the peak
 * of the high band's spectrum in sibilant frames, divided by 1.6, kept
 * between 3.5 and 8 kHz (a deep male voice's "s" peaks near 5 kHz, a
 * female voice's near 7-9).
 *
 * Checked by tools/check-deess.js.
 *
 * UMD: runs in Node for the check and in the page.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./spectral.js'));
  else root.ASDeess = factory(root.ASSpectral);
})(typeof self !== 'undefined' ? self : this, function (Spectral) {
  'use strict';

  function butterLP(x, fc, rate) {
    // Two cascaded biquads (Q 0.541 and 1.307) = 4th-order Butterworth, run forward then back.
    var y = Float64Array.from(x);
    [0.5412, 1.3066].forEach(function (Q) {
      var w = 2 * Math.PI * fc / rate, al = Math.sin(w) / (2 * Q), c = Math.cos(w), a0 = 1 + al;
      var b0 = (1 - c) / 2 / a0, b1 = (1 - c) / a0, b2 = b0, a1 = -2 * c / a0, a2 = (1 - al) / a0;
      for (var pass = 0; pass < 2; pass++) {
        var x1 = 0, x2 = 0, y1 = 0, y2 = 0, n = y.length;
        for (var k = 0; k < n; k++) {
          var i = pass ? n - 1 - k : k, v = y[i], o = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
          x2 = x1; x1 = v; y2 = y1; y1 = o; y[i] = o;
        }
      }
    });
    return y;
  }

  function mono(chans) {
    var n = chans[0].length, m = new Float64Array(n);
    for (var c = 0; c < chans.length; c++) for (var i = 0; i < n; i++) m[i] += chans[c][i] / chans.length;
    return m;
  }

  // Frame energies of the full and the high band (5 ms).
  function frames(x, high, rate) {
    var F = Math.max(32, Math.round(0.005 * rate)), nf = Math.ceil(x.length / F), full = new Float64Array(nf), hi = new Float64Array(nf);
    for (var f = 0; f < nf; f++) {
      var a = f * F, b = Math.min(x.length, a + F), s = 0, h = 0;
      for (var i = a; i < b; i++) { s += x[i] * x[i]; h += high[i] * high[i]; }
      full[f] = s / Math.max(1, b - a); hi[f] = h / Math.max(1, b - a);
    }
    return { F: F, full: full, hi: hi };
  }

  // Where the voice's sibilance peaks, in Hz.
  function centre(x, rate) {
    var fc0 = 3500, hp = butterLP(x, fc0, rate), high = new Float64Array(x.length);
    for (var i = 0; i < x.length; i++) high[i] = x[i] - hp[i];
    var fr = frames(x, high, rate), N = 1024, fft = Spectral.makeFFT(N), acc = new Float64Array(N / 2), re = new Float64Array(N), im = new Float64Array(N), used = 0;
    for (var f = 0; f < fr.full.length && used < 400; f++) {
      if (!(fr.hi[f] > 0.5 * fr.full[f]) || fr.full[f] < 1e-6) continue;
      var a = Math.max(0, f * fr.F + (fr.F >> 1) - N / 2);
      if (a + N > x.length) break;
      for (var j = 0; j < N; j++) { re[j] = x[a + j] * (0.5 - 0.5 * Math.cos(2 * Math.PI * j / N)); im[j] = 0; }
      fft.run(re, im, false);
      for (var k = 0; k < N / 2; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
      used++;
    }
    if (!used) return null;
    var lo = Math.round(4000 / (rate / N)), hiB = Math.min(N / 2 - 1, Math.round(11000 / (rate / N))), best = lo;
    // Smooth over ~500 Hz so one strong bin does not decide it.
    var w = Math.max(1, Math.round(250 / (rate / N)));
    var sm = function (k) { var s = 0; for (var d = -w; d <= w; d++) s += acc[Math.max(0, Math.min(N / 2 - 1, k + d))]; return s; };
    for (var b = lo; b <= hiB; b++) if (sm(b) > sm(best)) best = b;
    return best * rate / N;
  }

  // chans: Float32Arrays. o: { amount (dB, default 6), share (0..1),
  // crossover (Hz, else found), listen (true: return only what is removed) }.
  function process(chans, rate, o) {
    o = o || {};
    var amount = o.amount != null ? o.amount : 6, thr = o.share != null ? o.share : 0.45;
    var m = mono(chans);
    var peak = o.crossover ? null : centre(m, rate);
    var fc = o.crossover || Math.max(3500, Math.min(8000, (peak || 6500) / 1.6));
    if (fc >= rate * 0.45) return { channels: chans.map(function (c) { return Float32Array.from(c); }), crossover: fc, peak: peak, reduced: 0, frames: 0 };
    // The gain curve, from the mono mix, applied to every channel alike.
    var low = butterLP(m, fc, rate), high = new Float64Array(m.length);
    for (var i = 0; i < m.length; i++) high[i] = m[i] - low[i];
    var fr = frames(m, high, rate), nf = fr.full.length;
    var loud = Array.prototype.slice.call(fr.full).sort(function (a, b) { return a - b; })[Math.floor(nf * 0.95)] || 0;
    var floor = loud * 1e-4; // 40 dB under the loud frames
    var gf = new Float64Array(nf), red = Math.pow(10, -amount / 20), sib = 0;
    for (var f = 0; f < nf; f++) {
      var share = fr.full[f] > floor ? fr.hi[f] / fr.full[f] : 0;
      var t = Math.max(0, Math.min(1, (share - thr) / 0.15));
      gf[f] = 1 - t * (1 - red);
      if (t > 0) sib++;
    }
    // Per sample, then smoothed with a 6 ms raised cosine (look-ahead and release).
    var n = m.length, g = new Float64Array(n), F = fr.F;
    for (var s = 0; s < n; s++) g[s] = gf[Math.floor(s / F)];
    var H = Math.round(0.003 * rate), win = new Float64Array(2 * H + 1), ws = 0;
    for (var k = -H; k <= H; k++) { win[k + H] = 0.5 + 0.5 * Math.cos(Math.PI * k / (H + 1)); ws += win[k + H]; }
    var gs = new Float64Array(n), any = false;
    for (var s2 = 0; s2 < n; s2++) {
      // Only where some reduction is near: elsewhere the gain is exactly 1.
      if (gf[Math.floor(s2 / F)] === 1 && gf[Math.floor(Math.max(0, s2 - H) / F)] === 1 && gf[Math.floor(Math.min(n - 1, s2 + H) / F)] === 1) { gs[s2] = 1; continue; }
      var acc = 0; for (var k2 = -H; k2 <= H; k2++) acc += win[k2 + H] * g[Math.max(0, Math.min(n - 1, s2 + k2))];
      gs[s2] = acc / ws; any = true;
    }
    var out = chans.map(function (x) {
      var y = new Float32Array(x.length);
      if (!any) { y.set(x); return o.listen ? new Float32Array(x.length) : y; }
      var lowc = butterLP(x, fc, rate);
      for (var j = 0; j < x.length; j++) {
        if (gs[j] === 1) { y[j] = o.listen ? 0 : x[j]; continue; }
        var hb = x[j] - lowc[j], cut = (1 - gs[j]) * hb;
        y[j] = o.listen ? cut : x[j] - cut;
      }
      return y;
    });
    return { channels: out, crossover: fc, peak: peak, reduced: sib * F / rate, frames: sib, gain: gs };
  }

  return { process: process, centre: centre, butterLP: butterLP };
});
