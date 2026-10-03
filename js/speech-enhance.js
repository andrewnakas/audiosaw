/*
 * ASEnhance — the polish half of /enhance-speech, after the AI denoise
 * (ASDenoise.ai, which the page runs first). UMD, pure DSP: check-enhance
 * runs it in Node and through the page.
 *
 *   1. high-pass at 80 Hz (12 dB/oct): rumble, desk thumps, mic handling
 *   2. EQ: -2.5 dB at 250 Hz (boxiness) and +3 dB at 3.5 kHz (presence,
 *      the band that carries consonants)
 *   3. a gentle compressor, 3:1 above a threshold set 8 dB under the
 *      speech's own RMS level, 10 ms attack, 150 ms release, 6 dB soft knee:
 *      a quiet sentence comes up towards a loud one. Written here rather than
 *      using DynamicsCompressorNode, which adds unreported make-up gain
 *      (CLAUDE.md, the editor's dynamics)
 *   4. loudness to a target (ITU-R BS.1770, loudness.js) with the true-peak
 *      limiter holding -1 dBTP
 *
 * It cleans and polishes the real voice. It does not regenerate one, which
 * is what Adobe's Enhance Speech does with a generative model.
 */
(function (root, factory) {
  // loudness.js sets a global rather than exporting.
  if (typeof module === 'object' && module.exports) { require('./loudness.js'); module.exports = factory(globalThis.ASLoudness); }
  else root.ASEnhance = factory(root.ASLoudness);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (L) {
  'use strict';

  // RBJ biquads, normalised [b0, b1, b2, a1, a2].
  function hp(f, sr) {
    var w = 2 * Math.PI * f / sr, c = Math.cos(w), a = Math.sin(w) / (2 * Math.SQRT1_2), a0 = 1 + a;
    return [(1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0, -2 * c / a0, (1 - a) / a0];
  }
  function peak(f, sr, db, q) {
    var A = Math.pow(10, db / 40), w = 2 * Math.PI * f / sr, c = Math.cos(w), a = Math.sin(w) / (2 * q), a0 = 1 + a / A;
    return [(1 + a * A) / a0, -2 * c / a0, (1 - a * A) / a0, -2 * c / a0, (1 - a / A) / a0];
  }
  function run(x, k) {
    var y = new Float32Array(x.length), x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (var i = 0; i < x.length; i++) {
      var v = k[0] * x[i] + k[1] * x1 + k[2] * x2 - k[3] * y1 - k[4] * y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
    }
    return y;
  }

  function rmsDb(chs) {
    var s = 0, n = 0;
    chs.forEach(function (c) { for (var i = 0; i < c.length; i++) { s += c[i] * c[i]; n++; } });
    return 10 * Math.log10(s / Math.max(1, n) + 1e-20);
  }

  // The speech's own level: RMS over the louder half of 50 ms frames, so the
  // pauses do not drag the threshold down.
  function speechLevelDb(chs, sr) {
    var fr = Math.round(sr * 0.05), e = [];
    for (var a = 0; a + fr <= chs[0].length; a += fr) {
      var s = 0;
      chs.forEach(function (c) { for (var i = a; i < a + fr; i++) s += c[i] * c[i]; });
      e.push(s / (fr * chs.length));
    }
    e.sort(function (p, q) { return q - p; });
    var top = e.slice(0, Math.max(1, Math.floor(e.length / 2))), m = 0;
    top.forEach(function (v) { m += v; });
    return 10 * Math.log10(m / top.length + 1e-20);
  }

  // Feed-forward compressor, linked across channels, on a smoothed level.
  function compress(chs, sr, thrDb, ratio, kneeDb) {
    var att = Math.exp(-1 / (0.010 * sr)), rel = Math.exp(-1 / (0.150 * sr)), env = 0, n = chs[0].length;
    var out = chs.map(function () { return new Float32Array(n); }), maxGr = 0;
    for (var i = 0; i < n; i++) {
      var p = 0;
      for (var c = 0; c < chs.length; c++) p = Math.max(p, chs[c][i] * chs[c][i]);
      env = p > env ? att * env + (1 - att) * p : rel * env + (1 - rel) * p;
      var lvl = 10 * Math.log10(env + 1e-20), over = lvl - thrDb, gr = 0;
      if (over > kneeDb / 2) gr = over * (1 - 1 / ratio);
      else if (over > -kneeDb / 2) { var t = over + kneeDb / 2; gr = (1 - 1 / ratio) * t * t / (2 * kneeDb); }
      if (gr > maxGr) maxGr = gr;
      var g = Math.pow(10, -gr / 20);
      for (var d = 0; d < chs.length; d++) out[d][i] = chs[d][i] * g;
    }
    return { channels: out, maxGr: maxGr };
  }

  // Steps 1-3. -> { channels, speechLevelDb, compressionDb }
  function pre(chs, sr) {
    var kHp = hp(80, sr), kMud = peak(250, sr, -2.5, 1), kPres = peak(3500, sr, 3, 0.9);
    var x = chs.map(function (c) { return run(run(run(run(c, kHp), kHp), kMud), kPres); });
    var lvl = speechLevelDb(x, sr);
    var comp = compress(x, sr, lvl - 8, 3, 6);
    return { channels: comp.channels, speechLevelDb: lvl, compressionDb: comp.maxGr };
  }

  // Step 4, given the loudness of pre()'s output measured at 48 kHz (the
  // rate BS.1770's K-weighting is defined at; the page measures a resampled
  // copy). The true peak is limited on the buffer actually written.
  function finish(x, sr, measuredLufs, opts) {
    opts = opts || {};
    var target = opts.target == null ? -16 : opts.target, ceiling = opts.ceiling == null ? -1 : opts.ceiling;
    if (!isFinite(measuredLufs)) throw new Error('That recording is silent, or too quiet to measure.');
    var gain = Math.pow(10, (target - measuredLufs) / 20);
    x.forEach(function (c) { for (var i = 0; i < c.length; i++) c[i] *= gain; });
    L.limit(x, sr, Math.pow(10, ceiling / 20));   // in place
    return x;
  }

  // The whole chain for a buffer already at 48 kHz (Node, tests).
  function chain(chs, sr, opts) {
    var p = pre(chs, sr), meas = L.integratedLoudness(p.channels, sr).integrated;
    var x = finish(p.channels, sr, meas, opts);
    return { channels: x, report: { speechLevelDb: p.speechLevelDb, compressionDb: p.compressionDb, measuredLufs: meas, gainDb: (opts && opts.target != null ? opts.target : -16) - meas } };
  }

  return { chain: chain, pre: pre, finish: finish, compress: compress, speechLevelDb: speechLevelDb, hp: hp, peak: peak, run: run, rmsDb: rmsDb };
}));
