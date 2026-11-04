/*
 * ASTone: test tones, sweeps and noise as sample arrays, for /tone-generator.
 * UMD, so tools/check-tone.js measures the output in Node.
 *
 *   ASTone.render({ wave, freq, freq2, sweep, seconds, rate, amp, channel, fade, beat })
 *     -> [left Float32Array, right Float32Array]
 *
 *   wave    'sine' | 'square' | 'sawtooth' | 'triangle' | 'white' | 'pink' | 'brown'
 *   freq    Hz (the start of a sweep)
 *   freq2   Hz, the end of a sweep; omitted for a steady tone
 *   sweep   'log' (equal time per octave, the usual one) | 'lin'
 *   amp     peak level, 0..1 (a noise is scaled so its peak is amp)
 *   channel 'both' | 'left' | 'right'
 *   fade    seconds of raised-cosine fade at each end (0 = none)
 *   beat    Hz added to the right channel's frequency (binaural beat)
 *
 * The phase is accumulated in double precision from each sample's own
 * frequency, so a sweep is continuous and a steady 1 kHz tone at 48 kHz
 * repeats exactly every 48 samples. Square, sawtooth and triangle are
 * band-limited: summed from their harmonics below Nyquist, never drawn as
 * hard edges, which would fold harmonics back down as inharmonic tones
 * (check-tone: a naive 5.1 kHz square at 48 kHz has its 9th harmonic folded
 * to 2.1 kHz at -19 dB; here it is -173 dB).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ASTone = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TAU = 2 * Math.PI;

  // Harmonic n's weight in a unit-peak waveform, and which n are present.
  // Square: odd n, 4/(pi n). Sawtooth: all n, 2/(pi n), alternating sign.
  // Triangle: odd n, 8/(pi^2 n^2), alternating sign. The truncated sums
  // overshoot (Gibbs), so each is renormalised to its measured peak below.
  function weight(wave, n) {
    if (wave === 'square') return n % 2 ? 4 / (Math.PI * n) : 0;
    if (wave === 'sawtooth') return (n % 2 ? 1 : -1) * 2 / (Math.PI * n);
    if (wave === 'triangle') return n % 2 ? ((n - 1) / 2 % 2 ? -1 : 1) * 8 / (Math.PI * Math.PI * n * n) : 0;
    return n === 1 ? 1 : 0;
  }

  // One period of the wave, summed from its harmonics up to topH, in a table
  // of TABLE points, scaled to a peak of 1. 32768 points put 27 points on a
  // cycle of even the 1,200th harmonic, so reading it with linear
  // interpolation errs by well under -100 dB.
  var TABLE = 32768, tables = {};
  function tableFor(wave, topH) {
    var key = wave + topH;
    if (tables[key]) return tables[key];
    var t = new Float64Array(TABLE + 1), pk = 0;
    for (var h = 1; h <= topH; h++) {
      var w = weight(wave, h);
      if (!w) continue;
      for (var i = 0; i < TABLE; i++) t[i] += w * Math.sin(TAU * h * i / TABLE);
    }
    for (var j = 0; j < TABLE; j++) pk = Math.max(pk, Math.abs(t[j]));
    for (var k = 0; k < TABLE; k++) t[k] /= pk || 1;
    t[TABLE] = t[0];
    return (tables[key] = t);
  }

  // Square, sawtooth and triangle read a table chosen per third of an
  // octave: it holds the harmonics below Nyquist at the TOP of that band,
  // so nothing can fold over, at the cost of the top harmonic or two near
  // the bottom of the band. Browsers' OscillatorNode does the same.
  function tone(out, o, rate, freqAt, wave) {
    var nyq = rate / 2, phase = 0, n = out.length;
    var maxH = wave === 'triangle' ? 41 : 4000;    // a triangle's 41st harmonic is 64 dB down
    var band = -1, t = null;
    for (var i = 0; i < n; i++) {
      var f = freqAt(i);
      if (wave === 'sine') out[i] = Math.sin(TAU * phase);
      else {
        var b = Math.ceil(3 * Math.log(f / 10) / Math.LN2);
        if (b !== band) {
          band = b;
          t = tableFor(wave, Math.max(1, Math.min(maxH, Math.floor(nyq / (10 * Math.pow(2, b / 3))))));
        }
        var x = phase * TABLE, k = Math.floor(x), fr = x - k;
        out[i] = t[k] + (t[k + 1] - t[k]) * fr;
      }
      phase += f / rate;
      if (phase >= 1) phase -= Math.floor(phase);
    }
  }

  // Seeded, so a rendered noise is the same file every time.
  function rng(seed) {
    var s = seed >>> 0 || 1;
    return function () { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296) * 2 - 1; };
  }

  function noise(out, wave, seed) {
    var r = rng(seed), n = out.length;
    if (wave === 'white') { for (var i = 0; i < n; i++) out[i] = r(); return; }
    if (wave === 'pink') {
      // Paul Kellet's refined filter: -3 dB/octave within 0.05 dB from
      // 9 Hz to Nyquist at 44.1 kHz.
      var b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (var j = 0; j < n; j++) {
        var w = r();
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.96900 * b2 + w * 0.1538520; b3 = 0.86650 * b3 + w * 0.3104856;
        b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
        out[j] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
        b6 = w * 0.115926;
      }
      return;
    }
    // Brown: integrated white, leaking just enough not to wander off.
    var y = 0;
    for (var k = 0; k < n; k++) { y = 0.998 * y + r() * 0.06; out[k] = y; }
  }

  function render(o) {
    var rate = o.rate || 48000, n = Math.max(1, Math.round((o.seconds || 1) * rate));
    var wave = o.wave || 'sine', amp = o.amp == null ? 0.25 : o.amp;
    var L = new Float32Array(n), R = null;
    var isNoise = /^(white|pink|brown)$/.test(wave);
    function freqFn(f0, f1) {
      if (!f1 || f1 === f0) return function () { return f0; };
      if (o.sweep === 'lin') return function (i) { return f0 + (f1 - f0) * i / n; };
      var k = Math.log(f1 / f0);
      return function (i) { return f0 * Math.exp(k * i / n); };
    }
    if (isNoise) noise(L, wave, o.seed || 12345);
    else tone(L, o, rate, freqFn(o.freq || 440, o.freq2), wave);
    if (!isNoise && o.beat) {
      R = new Float32Array(n);
      tone(R, o, rate, freqFn((o.freq || 440) + o.beat, o.freq2 ? o.freq2 + o.beat : 0), wave);
    }
    // Scale to the asked peak. A pure sine already peaks at 1; the summed
    // waves and the noises are measured.
    var pk = 0;
    for (var i = 0; i < n; i++) { var a = Math.abs(L[i]); if (a > pk) pk = a; }
    if (R) for (var j = 0; j < n; j++) { var b = Math.abs(R[j]); if (b > pk) pk = b; }
    var g = wave === 'sine' ? amp : pk > 0 ? amp / pk : 0;
    var fadeN = Math.min(Math.floor(n / 2), Math.round((o.fade || 0) * rate));
    for (var s = 0; s < n; s++) {
      var e = 1;
      if (s < fadeN) e = 0.5 - 0.5 * Math.cos(Math.PI * s / fadeN);
      else if (s >= n - fadeN) e = 0.5 - 0.5 * Math.cos(Math.PI * (n - 1 - s) / fadeN);
      L[s] *= g * e;
      if (R) R[s] *= g * e;
    }
    if (!R) R = L.slice();
    if (o.channel === 'left') R.fill(0);
    else if (o.channel === 'right') L.fill(0);
    return [L, R];
  }

  var NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  function noteOf(hz, a4) {
    var m = 69 + 12 * Math.log(hz / (a4 || 440)) / Math.LN2, r = Math.round(m);
    return { name: NAMES[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1), cents: Math.round((m - r) * 100), midi: r };
  }
  function hzOf(midi, a4) { return (a4 || 440) * Math.pow(2, (midi - 69) / 12); }

  return { render: render, noteOf: noteOf, hzOf: hzOf, NAMES: NAMES };
});
