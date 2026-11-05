/*
 * ASDehum: mains hum and buzz (50 or 60 Hz and its harmonics) out of a
 * recording, leaving everything between the harmonics alone.
 *
 * detect(): which mains, and exactly where. Mains is never exactly 50.00 or
 * 60.00: the grid wanders by a few hundredths of a hertz, and a recording
 * played back at the wrong speed moves it further. A notch narrow enough to
 * leave the voice alone misses a hum that is 0.1 Hz off, so the fundamental
 * is measured. The file is low-passed and decimated to ~2 kHz, then each
 * candidate between 47-53 and 57-63 Hz is scored by the energy of its first
 * eight harmonics (Goertzel over up to 60 s, so ~0.02 Hz resolution) against
 * the energy a few hertz either side. The best candidate is refined to
 * 0.005 Hz by a parabola through its neighbours. It is called hum when at
 * least two harmonics stand 10 dB above their surroundings.
 *
 * track(): the fundamental second by second, because it wanders (see there).
 *
 * remove(): one RBJ notch per harmonic, k * f(t) for k = 1..n, each about
 * (0.6 + 0.03 k) Hz wide and following the track in 1024-sample blocks, run
 * forward and then backward over the file
 * (zero phase: nothing is delayed or smeared, and each notch's depth doubles).
 * The ends are padded with 3 s of the hum itself, fitted at each end, so the
 * notches have settled by the first real sample (see padded()). Odd harmonics carry buzz (rectifiers, dimmers, guitar
 * pickups), so "buzz" goes up to 4 kHz; "hum" stops at 1 kHz; "light" takes
 * the first four.
 *
 * Checked by tools/check-dehum.js: hum at -30 dBFS with eight harmonics, off
 * frequency and wandering, under `say` speech.
 *
 * UMD: runs in Node for the check and in the page.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ASDehum = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = { light: 4, hum: 1000, buzz: 4000 };

  function mono(chans) {
    var n = chans[0].length, m = new Float64Array(n), c = chans.length;
    for (var k = 0; k < c; k++) for (var i = 0; i < n; i++) m[i] += chans[k][i] / c;
    return m;
  }

  // RBJ biquad coefficients.
  function notchCoef(f, bw, rate) {
    var w = 2 * Math.PI * f / rate, q = f / bw, al = Math.sin(w) / (2 * q), c = Math.cos(w), a0 = 1 + al;
    return [1 / a0, -2 * c / a0, 1 / a0, -2 * c / a0, (1 - al) / a0];
  }
  function lowpassCoef(f, rate) {
    var w = 2 * Math.PI * f / rate, al = Math.sin(w) / (2 * 0.7071), c = Math.cos(w), a0 = 1 + al;
    return [(1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0, -2 * c / a0, (1 - al) / a0];
  }
  function biquad(x, k, from, to, dir) {
    var b0 = k[0], b1 = k[1], b2 = k[2], a1 = k[3], a2 = k[4], x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    if (dir > 0) {
      for (var i = from; i < to; i++) { var v = x[i], y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = v; y2 = y1; y1 = y; x[i] = y; }
    } else {
      for (var j = to - 1; j >= from; j--) { var u = x[j], z = b0 * u + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = u; y2 = y1; y1 = z; x[j] = z; }
    }
  }

  function goertzel(x, f, rate) {
    var w = 2 * Math.PI * f / rate, c = 2 * Math.cos(w), s1 = 0, s2 = 0;
    for (var i = 0; i < x.length; i++) { var s = x[i] + c * s1 - s2; s2 = s1; s1 = s; }
    return (s1 * s1 + s2 * s2 - c * s1 * s2) / (x.length * x.length);
  }

  // A ~2 kHz copy of (up to) the first 60 s, for detection.
  function lowCopy(chans, rate) {
    var m = mono(chans), k = Math.max(1, Math.floor(rate / 2000)), r = rate / k;
    var n = Math.min(m.length, Math.round(60 * rate));
    var lp = lowpassCoef(Math.min(900, r * 0.45), rate);
    var a = m.subarray(0, n);
    biquad(a, lp, 0, n, 1); biquad(a, lp, 0, n, 1);
    var y = new Float64Array(Math.floor(n / k));
    for (var i = 0; i < y.length; i++) y[i] = a[i * k];
    return { x: y, rate: r };
  }

  function score(x, rate, f0, H) {
    var on = 0, off = 0, prom = [];
    for (var h = 1; h <= H; h++) {
      var f = f0 * h;
      if (f > rate * 0.45) break;
      var p = goertzel(x, f, rate);
      var q = (goertzel(x, f - 3.1, rate) + goertzel(x, f + 3.3, rate) + goertzel(x, f - 6.2, rate) + goertzel(x, f + 6.6, rate)) / 4;
      on += p; off += q;
      prom.push(10 * Math.log10((p + 1e-30) / (q + 1e-30)));
    }
    return { on: on, off: off, prom: prom };
  }

  // opts.mains: 50 or 60 to search only there (the page's override).
  function detect(chans, rate, opts) {
    opts = opts || {};
    var lc = lowCopy(chans, rate), x = lc.x, r = lc.rate;
    if (x.length < r * 1) return { found: false, reason: 'short' };
    var best = null;
    (opts.mains ? [+opts.mains] : [50, 60]).forEach(function (base) {
      // Coarse 0.05 Hz scan on the first four harmonics, then the best one fine.
      for (var f = base - 3; f <= base + 3 + 1e-9; f += 0.05) {
        var on = 0;
        for (var h = 1; h <= 4; h++) on += goertzel(x, f * h, r);
        if (!best || on > best.on) best = { f: f, on: on, base: base };
      }
    });
    // Fine: 0.01 Hz steps around it with eight harmonics, then a parabola.
    var fs = [], vs = [];
    for (var g = best.f - 0.06; g <= best.f + 0.06 + 1e-9; g += 0.01) {
      var e = 0; for (var hh = 1; hh <= 8; hh++) if (g * hh < r * 0.45) e += goertzel(x, g * hh, r);
      fs.push(g); vs.push(e);
    }
    var at = 0; for (var i = 1; i < vs.length; i++) if (vs[i] > vs[at]) at = i;
    var f0 = fs[at];
    if (at > 0 && at < vs.length - 1) {
      var den = vs[at - 1] - 2 * vs[at] + vs[at + 1];
      if (den < 0) f0 += 0.01 * 0.5 * (vs[at - 1] - vs[at + 1]) / den;
    }
    var s = score(x, r, f0, 8);
    var strong = s.prom.filter(function (p) { return p >= 10; }).length;
    var level = 10 * Math.log10(s.on + 1e-30) + 3; // power of the harmonics, as dBFS of a sine
    return {
      found: strong >= 2, f0: f0, mains: best.base, harmonics: s.prom.map(function (p) { return Math.round(p * 10) / 10; }),
      strong: strong, levelDb: level, oddHeavy: s.prom.length >= 6 && (s.prom[2] + s.prom[4]) > (s.prom[1] + s.prom[3]) + 6
    };
  }

  function harmonicsFor(f0, rate, strength) {
    var lim = LIMITS[strength] || LIMITS.hum, top = Math.min(rate * 0.45, strength === 'light' ? f0 * 4.5 : lim);
    var list = [];
    for (var k = 1; k * f0 <= top; k++) list.push(k);
    return list;
  }

  // The fundamental, second by second: mains wanders by a few hundredths of
  // a hertz, which moves the 8th harmonic by a few tenths, out of a notch
  // narrow enough to leave the voice alone. Each 4 s window (1 s apart) is
  // searched 0.15 Hz either side of f0 on eight harmonics, with a parabola
  // through the peak; a window where the hum does not stand out keeps the
  // previous value. Then a 3-point median.
  function track(chans, rate, f0) {
    var m = mono(chans), k = Math.max(1, Math.floor(rate / 2000)), r = rate / k;
    var lp = lowpassCoef(Math.min(900, r * 0.45), rate);
    biquad(m, lp, 0, m.length, 1); biquad(m, lp, 0, m.length, 1);
    var x = new Float64Array(Math.floor(m.length / k));
    for (var i = 0; i < x.length; i++) x[i] = m[i * k];
    var W = Math.round(4 * r), hop = Math.round(r), fs = [], prev = f0;
    for (var c = 0; ; c += hop) {
      var a = Math.max(0, Math.min(c - W / 2, x.length - W)), seg = x.subarray(Math.max(0, a), Math.max(0, a) + Math.min(W, x.length));
      var vs = [], best = 0;
      for (var d = -15; d <= 15; d++) {
        var f = f0 + d * 0.01, e = 0;
        for (var h = 1; h <= 8; h++) if (f * h < r * 0.45) e += goertzel(seg, f * h, r);
        vs.push(e); if (e > vs[best]) best = vs.length - 1;
      }
      var g = f0 + (best - 15) * 0.01;
      if (best > 0 && best < vs.length - 1) { var den = vs[best - 1] - 2 * vs[best] + vs[best + 1]; if (den < 0) g += 0.01 * 0.5 * (vs[best - 1] - vs[best + 1]) / den; }
      // An edge of the search range is not a measurement.
      if (best === 0 || best === vs.length - 1) g = prev;
      fs.push(g); prev = g;
      if (c >= x.length) break;
    }
    var sm = fs.map(function (v, j) { var t = [fs[Math.max(0, j - 1)], v, fs[Math.min(fs.length - 1, j + 1)]].sort(); return t[1]; });
    return { hop: hop * k, f: sm };
  }

  // One notch at harmonic `h`, its frequency following the track, over a
  // padded copy y (pad samples of mirror at each end), forward then back.
  var BLOCK = 1024;
  function notchPass(y, pad, h, tr, f0, rate) {
    var bw = 0.6 + 0.03 * h, n = y.length;
    function coefAt(i) {
      var f = f0;
      if (tr) { var t = (i - pad) / tr.hop, j = Math.max(0, Math.min(tr.f.length - 1, Math.floor(t))), u = Math.max(0, Math.min(1, t - j)); f = tr.f[j] + ((tr.f[Math.min(tr.f.length - 1, j + 1)] - tr.f[j]) * u); }
      return notchCoef(h * f, bw, rate);
    }
    var st = [0, 0, 0, 0];
    function run(from, to, dir, k) {
      var b0 = k[0], b1 = k[1], b2 = k[2], a1 = k[3], a2 = k[4], x1 = st[0], x2 = st[1], y1 = st[2], y2 = st[3], i, v, o;
      if (dir > 0) for (i = from; i < to; i++) { v = y[i]; o = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = v; y2 = y1; y1 = o; y[i] = o; }
      else for (i = to - 1; i >= from; i--) { v = y[i]; o = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = v; y2 = y1; y1 = o; y[i] = o; }
      st[0] = x1; st[1] = x2; st[2] = y1; st[3] = y2;
    }
    var b;
    for (b = 0; b < n; b += BLOCK) run(b, Math.min(n, b + BLOCK), 1, coefAt(b + BLOCK / 2));
    st = [0, 0, 0, 0];
    for (b = Math.floor((n - 1) / BLOCK) * BLOCK; b >= 0; b -= BLOCK) run(b, Math.min(n, b + BLOCK), -1, coefAt(b + BLOCK / 2));
  }

  // The hum carried on past each end of the file, for the notches to settle
  // on. A mirrored edge does not continue a sine (its slope flips), and a
  // notch a hertz wide rings for a second when it meets one: that cost
  // 15 dB of depth over a minute. So each harmonic's amplitude and phase are
  // fitted over the first (last) whole periods of the file and synthesised
  // into a 3 s pad.
  var PAD_S = 3;
  function padded(x, pad, rate, hs, fStart, fEnd) {
    var n = x.length, y = new Float64Array(n + 2 * pad);
    for (var i = 0; i < n; i++) y[pad + i] = x[i];
    [[fStart, 0], [fEnd, 1]].forEach(function (e) {
      var f = e[0], atEnd = e[1], per = rate / f;
      var W = Math.min(n, Math.max(1, Math.round(Math.floor(Math.min(n, rate) / per) * per)));
      var o = atEnd ? n - W : 0;
      hs.forEach(function (h) {
        var w = 2 * Math.PI * h * f / rate;
        if (w >= Math.PI) return;
        var re = 0, im = 0;
        for (var j = 0; j < W; j++) { re += x[o + j] * Math.cos(w * j); im -= x[o + j] * Math.sin(w * j); }
        re *= 2 / W; im *= 2 / W;
        // x[o + j] ~ re cos(w j) - im sin(w j); continue it for j outside [0, W).
        if (atEnd) for (var q = 0; q < pad; q++) { var jj = W + q; y[pad + n + q] += re * Math.cos(w * jj) - im * Math.sin(w * jj); }
        else for (var r = 1; r <= pad; r++) { var jk = -r; y[pad - r] += re * Math.cos(w * jk) - im * Math.sin(w * jk); }
      });
    });
    return y;
  }
  function unpad(y, pad, n) { var o = new Float32Array(n); for (var j = 0; j < n; j++) o[j] = y[pad + j]; return o; }

  // Returns new channels; the input is not touched. opts: { f0, track (from
  // track(), optional), strength, onProgress(fraction) }. Async: it yields to
  // the page between notches so a long file does not freeze the tab.
  function remove(chans, rate, opts) {
    var hs = harmonicsFor(opts.f0, rate, opts.strength || 'hum'), pad = Math.round(PAD_S * rate);
    var tf = opts.track ? opts.track.f : [opts.f0], fA = tf[0], fB = tf[tf.length - 1];
    var total = chans.length * hs.length, done = 0, out = [];
    var tick = opts.sync ? function () { return Promise.resolve(); } : function () { return new Promise(function (r) { setTimeout(r, 0); }); };
    return chans.reduce(function (p, x) {
      var y;
      return p.then(function () {
        y = padded(x, pad, rate, hs, fA, fB);
        return hs.reduce(function (pp, h) {
          return pp.then(function () {
            notchPass(y, pad, h, opts.track, opts.f0, rate);
            done++; if (opts.onProgress) opts.onProgress(done / total);
            return tick();
          });
        }, Promise.resolve());
      }).then(function () { out.push(unpad(y, pad, x.length)); });
    }, Promise.resolve()).then(function () { return out; });
  }

  return { detect: detect, track: track, remove: remove, harmonicsFor: harmonicsFor, goertzel: goertzel, LIMITS: LIMITS };
});
