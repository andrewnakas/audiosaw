/*
 * ASResample: band-limited sample-rate conversion (windowed sinc, Kaiser).
 *
 * Why not Web Audio: resampling by playing a buffer into an OfflineAudioContext
 * at another rate is done by the buffer source node. Chromium interpolates
 * there with a short kernel, so the top octave is dulled and content above the
 * new Nyquist folds back down. This converter is checked by
 * tools/check-fidelity.js. Going 96 -> 48 kHz, it must be flat within 0.05 dB
 * to 20 kHz, and a 30 kHz tone must fold back below -100 dB.
 *
 * How: the ratio is reduced to L/M. When L is small (every common pair:
 * 44.1<->48 is 147/160), each of the L output phases gets its own exactly
 * computed kernel. Otherwise the kernel is read from a table at 4096 points per
 * zero crossing with linear interpolation. The passband ends at 91% of the
 * lower Nyquist (20.07 kHz at 44.1 kHz) and the stopband begins at Nyquist,
 * with a 120 dB Kaiser window. Each phase is normalised to unity DC gain. The
 * kernel is symmetric about the output instant, so there is no delay and the
 * output is ceil(len * L / M) samples long.
 *
 * UMD: runs in Node for the check, and in the page.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ASResample = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PASS = 0.91;          // passband edge, fraction of the lower Nyquist
  var ATTEN = 120;          // stopband attenuation, dB
  var BETA = 0.1102 * (ATTEN - 8.7);
  var TABLE_RES = 4096;     // table points per input sample, for awkward ratios

  function gcd(a, b) { while (b) { var t = a % b; a = b; b = t; } return a; }

  function besselI0(x) {
    var sum = 1, term = 1, k = 1, h = x / 2;
    do { term *= (h / k) * (h / k); sum += term; k++; } while (term > sum * 1e-17);
    return sum;
  }

  // The continuous kernel in input-sample units, plus its half-width.
  function design(inRate, outRate) {
    var low = Math.min(inRate, outRate);
    var nyq = low / 2;
    var pass = PASS * nyq;
    var cutoff = (pass + nyq) / 2;                 // -6 dB point, mid-transition
    var tw = 2 * Math.PI * (nyq - pass) / low;     // transition, rad/sample at the low rate
    var taps = Math.ceil((ATTEN - 7.95) / (2.285 * tw));
    var half = Math.ceil(taps / 2 * (inRate / low)) + 1;   // in input samples
    var fcn = 2 * cutoff / inRate;                 // cutoff as a fraction of the input rate
    var i0b = besselI0(BETA);
    function h(t) {
      var a = Math.abs(t);
      if (a >= half) return 0;
      var s = a < 1e-12 ? fcn : Math.sin(Math.PI * fcn * t) / (Math.PI * t);
      var r = t / half;
      return s * besselI0(BETA * Math.sqrt(1 - r * r)) / i0b;
    }
    return { h: h, half: half };
  }

  // Kernel bank. bank[p] is 2*half coefficients for output phase p/L.
  var cache = {};
  function plan(inRate, outRate) {
    var key = inRate + '>' + outRate;
    if (cache[key]) return cache[key];
    var g = gcd(inRate, outRate), L = outRate / g, M = inRate / g;
    var d = design(inRate, outRate), W = 2 * d.half;
    var p = { L: L, M: M, half: d.half, W: W };
    if (L <= 2048) {
      p.bank = [];
      for (var ph = 0; ph < L; ph++) {
        var c = new Float64Array(W), frac = ph / L, sum = 0;
        for (var m = 0; m < W; m++) { c[m] = d.h(frac + d.half - 1 - m); sum += c[m]; }
        for (var m2 = 0; m2 < W; m2++) c[m2] /= sum;
        p.bank.push(c);
      }
    } else {
      var n = d.half * TABLE_RES + 2;
      p.table = new Float64Array(n);
      for (var i = 0; i < n; i++) p.table[i] = d.h(i / TABLE_RES);
    }
    cache[key] = p;
    return p;
  }

  function kernelAt(p, t) {
    var x = Math.abs(t) * TABLE_RES, i = x | 0, f = x - i;
    return i + 1 < p.table.length ? p.table[i] + (p.table[i + 1] - p.table[i]) * f : 0;
  }

  // Resample one channel. Returns a Float32Array.
  function channel(x, inRate, outRate) {
    if (inRate === outRate) return Float32Array.from(x);
    var p = plan(inRate, outRate), L = p.L, M = p.M, half = p.half, W = p.W;
    var n = x.length, outLen = Math.ceil(n * L / M);
    var y = new Float32Array(outLen);
    var tmp = p.bank ? null : new Float64Array(W);
    for (var k = 0; k < outLen; k++) {
      var num = k * M, i = Math.floor(num / L), ph = num - i * L;
      var j0 = i - half + 1;
      var c;
      if (p.bank) c = p.bank[ph];
      else {
        var frac = ph / L, s = 0;
        for (var m = 0; m < W; m++) { tmp[m] = kernelAt(p, frac + half - 1 - m); s += tmp[m]; }
        for (var m2 = 0; m2 < W; m2++) tmp[m2] /= s;
        c = tmp;
      }
      var acc = 0, m0 = 0, m1 = W;
      if (j0 < 0) m0 = -j0;
      if (j0 + W > n) m1 = n - j0;
      for (var q = m0; q < m1; q++) acc += x[j0 + q] * c[q];
      y[k] = acc;
    }
    return y;
  }

  // Resample a list of channels. Yields to the event loop between channels,
  // since a long file at a high ratio takes a few seconds.
  function channels(chans, inRate, outRate) {
    var out = [];
    var i = 0;
    return new Promise(function (resolve, reject) {
      (function next() {
        try {
          if (i >= chans.length) { resolve(out); return; }
          out.push(channel(chans[i++], inRate, outRate));
          setTimeout(next, 0);
        } catch (e) { reject(e); }
      })();
    });
  }

  return { channel: channel, channels: channels, plan: plan, PASS: PASS, ATTEN: ATTEN };
});
