/*
 * ASVoice — the voice changer's DSP. Pure functions on Float32Arrays, UMD, so
 * tools/check-voice.js runs it in Node against synthetic voices.
 *
 * Two controls do most of the work, and keeping them separate is the point:
 *
 *   pitch    how high the voice is (the fundamental, f0)
 *   formant  how big the head sounds (the resonances that make vowels)
 *
 * Plain resampling moves both together, which is the chipmunk sound. A
 * deeper voice that still sounds human lowers the pitch and leaves the
 * formants nearly alone; a monster lowers both. So:
 *
 *   1. formant shift f: resample by f (pitch and formants both × f, length
 *      ÷ f) with the site's sinc resampler;
 *   2. TD-PSOLA on that: grains one pitch period long, cut at pitch marks and
 *      laid back down with the spacing changed to give pitch × p/f, while the
 *      output timeline is stretched by f so the length comes back to the
 *      original. The grains are not resampled, so their formants stay where
 *      step 1 put them.
 *
 * Unvoiced sound (s, f, breath) has no period; it is carried through with
 * fixed 10 ms grains at its original pitch, which is what PSOLA does with it
 * in every implementation and why sibilants survive a big shift.
 *
 * The other effects (ring modulation, band-limiting, drive, a small reverb)
 * are the ordinary textbook versions.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.ASVoice = factory(root);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  function pitchLib() {
    var P = root.ASPitch;
    if (!P && typeof require === 'function') { require('./pitch-track.js'); P = root.ASPitch; }
    return P;
  }
  function resampler() {
    var R = root.ASResample;
    if (!R && typeof require === 'function') R = require('./resample.js');
    return R;
  }

  /* ------------------------------------------------------------- analysis */

  // f0 every 10 ms, measured on a copy decimated to 11.025 kHz: YIN's cost
  // grows with the square of the rate, and a voice's f0 (55-900 Hz) needs
  // nothing above 5 kHz. At 44.1 kHz a three-minute file took most of a
  // minute; decimated, about a second. Voiced where YIN is confident and the
  // frame is above the file's own noise floor (the 10th percentile of frame
  // level, as in silence-gaps.js: the right absolute level differs by 30 dB
  // between rooms). hop and win come back in the caller's samples.
  var AR = 11025;
  function f0Track(mono, sr) {
    var P = pitchLib();
    var x = sr === AR ? mono : resampler().channel(mono, sr, AR);
    var hop = Math.round(AR * 0.01), win = Math.round(AR * 0.04);
    var frames = [];
    for (var s = 0; s + win <= x.length; s += hop) {
      var sl = x.subarray(s, s + win), e = 0;
      for (var i = 0; i < sl.length; i++) e += sl[i] * sl[i];
      frames.push({ rms: Math.sqrt(e / sl.length), hz: 0, clarity: 0 });
    }
    var lv = frames.map(function (f) { return f.rms; }).sort(function (a, b) { return a - b; });
    // Capped at 20 dB under the loud frames: a recording with almost no
    // pauses has its 10th percentile on the voice itself, and three times
    // that put every frame under the floor, so nothing was shifted at all.
    var loud = lv[Math.floor(lv.length * 0.95)] || 0;
    var floor = Math.max(1e-4, Math.min((lv[Math.floor(lv.length * 0.1)] || 0) * 3, loud * 0.1));
    frames.forEach(function (f, k) {
      if (f.rms < floor) return;
      var r = P.yin(x.subarray(k * hop, k * hop + win), AR, { minHz: 55, maxHz: 900, threshold: 0.2 });
      if (r.clarity > 0.6) { f.hz = r.hz; f.clarity = r.clarity; }
    });
    // A voiced frame alone between unvoiced ones is usually a detector blip.
    for (var k = 1; k < frames.length - 1; k++) {
      if (frames[k].hz && !frames[k - 1].hz && !frames[k + 1].hz) frames[k].hz = 0;
    }
    return { frames: frames, hop: hop * sr / AR, win: Math.round(win * sr / AR) };
  }

  function biquad(type, f0, sr, q) {
    var w = 2 * Math.PI * f0 / sr, c = Math.cos(w), a = Math.sin(w) / (2 * (q || Math.SQRT1_2));
    var b0, b1, b2;
    if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; }
    else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
    else { b0 = a; b1 = 0; b2 = -a; }   // band-pass, 0 dB peak
    var a0 = 1 + a;
    return [b0 / a0, b1 / a0, b2 / a0, -2 * c / a0, (1 - a) / a0];
  }
  function filter(x, k) {
    var y = new Float32Array(x.length), x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (var i = 0; i < x.length; i++) {
      var v = k[0] * x[i] + k[1] * x1 + k[2] * x2 - k[3] * y1 - k[4] * y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
    }
    return y;
  }

  // Pitch marks: one per period in voiced stretches, each on the peak of a
  // low-passed copy so every grain is cut at the same point in the cycle (on
  // the raw signal the peak hops between harmonics; autotune.js measured the
  // result as an octave error). Unvoiced stretches get a mark every 10 ms.
  function marks(mono, sr, track) {
    var voiced = track.frames.filter(function (f) { return f.hz; }).map(function (f) { return f.hz; }).sort(function (a, b) { return a - b; });
    var med = voiced.length ? voiced[voiced.length >> 1] : 150;
    var guide = filter(filter(mono, biquad('lp', Math.min(sr / 4, med * 1.5), sr)), biquad('lp', Math.min(sr / 4, med * 1.5), sr));
    // The low-pass delays the guide by a near-constant phase, so every mark is
    // offset by about the same fraction of a cycle. That is harmless: PSOLA
    // needs grains cut at the same point in each cycle, not at the peak.
    var unv = Math.round(sr * 0.01);
    var out = [];
    var hop = track.hop, half = track.win >> 1;
    function periodAt(i) {
      var k = Math.round((i - half) / hop);
      var f = track.frames[Math.max(0, Math.min(track.frames.length - 1, k))];
      return f && f.hz ? sr / f.hz : 0;
    }
    var i = 0;
    while (i < mono.length) {
      var p = periodAt(i);
      if (p) {
        var w = Math.max(2, Math.round(p * 0.25));
        var lo = Math.max(0, i - w), hi = Math.min(mono.length - 1, i + w), best = i, bv = -Infinity;
        for (var j = lo; j <= hi; j++) if (guide[j] > bv) { bv = guide[j]; best = j; }
        if (out.length && best <= out[out.length - 1].pos) best = out[out.length - 1].pos + Math.max(1, Math.round(p * 0.5));
        out.push({ pos: best, p: p, voiced: true });
        i = best + Math.round(p);
      } else {
        out.push({ pos: i, p: unv, voiced: false });
        i += unv;
      }
    }
    return out;
  }

  /* ------------------------------------------------------------- PSOLA */

  var hannCache = {};
  function hann(n) {
    if (hannCache[n]) return hannCache[n];
    var w = new Float32Array(n);
    for (var i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / n);
    return (hannCache[n] = w);
  }

  // channels: Float32Array[]; mk: marks on their mono mix.
  // ratio(mark) → output/input pitch ratio for a voiced grain.
  // stretch: output length / input length.
  function psola(channels, mk, ratio, stretch) {
    var n = channels[0].length, outLen = Math.round(n * stretch);
    var out = channels.map(function () { return new Float32Array(outLen); });
    var norm = new Float32Array(outLen);
    if (!mk.length) {
      return channels.map(function (c) { var o = new Float32Array(outLen); o.set(c.subarray(0, Math.min(outLen, c.length))); return o; });
    }
    var k = 0, t = 0, guard = 0;
    while (t < outLen && guard++ < 1e7) {
      var tin = t / stretch;
      while (k + 1 < mk.length && Math.abs(mk[k + 1].pos - tin) <= Math.abs(mk[k].pos - tin)) k++;
      while (k > 0 && Math.abs(mk[k - 1].pos - tin) < Math.abs(mk[k].pos - tin)) k--;
      var m = mk[k];
      var P = m.p, half = Math.max(2, Math.round(P)), len = half * 2;
      var win = hann(len);
      var src0 = Math.round(m.pos) - half, dst0 = Math.round(t) - half;
      for (var c = 0; c < channels.length; c++) {
        var x = channels[c], y = out[c];
        for (var q = 0; q < len; q++) {
          var si = src0 + q, di = dst0 + q;
          if (si < 0 || si >= n || di < 0 || di >= outLen) continue;
          y[di] += x[si] * win[q];
        }
      }
      for (var q2 = 0; q2 < len; q2++) {
        var d2 = dst0 + q2;
        if (d2 >= 0 && d2 < outLen) norm[d2] += win[q2];
      }
      var r = m.voiced ? ratio(m) : 1;
      t += Math.max(1, P / r);
    }
    // Window-sum normalisation: where grains overlap more than at rest the
    // sum would swell, and at the edges it would dip. Divide it out, but not
    // where almost nothing landed (that would amplify a lone grain's tail).
    for (var c2 = 0; c2 < out.length; c2++) {
      var o = out[c2];
      for (var i = 0; i < outLen; i++) o[i] = norm[i] > 0.25 ? o[i] / norm[i] : o[i] * 4 * norm[i];
    }
    return out;
  }

  function mono(channels) {
    if (channels.length === 1) return channels[0];
    var n = channels[0].length, m = new Float32Array(n);
    channels.forEach(function (c) { for (var i = 0; i < n; i++) m[i] += c[i] / channels.length; });
    return m;
  }

  /*
   * shift(channels, sr, { pitch: semitones, formant: ratio, monotone: Hz })
   * Same length out as in. formant 1 and pitch 0 return copies.
   */
  function shift(channels, sr, o) {
    var p = Math.pow(2, (o.pitch || 0) / 12), f = o.formant || 1;
    if (Math.abs(p - 1) < 1e-4 && Math.abs(f - 1) < 1e-4 && !o.monotone) return channels.map(function (c) { return c.slice(); });
    var n = channels[0].length;
    var src = channels;
    if (Math.abs(f - 1) > 1e-4) {
      // Treat the samples as if recorded at sr·f and convert them to sr:
      // everything moves up by f and the length shrinks by f.
      var R = resampler();
      var inRate = Math.round(sr * f);
      src = channels.map(function (c) { return R.channel(c, inRate, sr); });
    }
    var tr = f0Track(mono(src), sr);
    var mk = marks(mono(src), sr, tr);
    var ratio = o.monotone
      ? function (m) { return o.monotone / (sr / m.p); }
      : function () { return p / f; };
    var out = psola(src, mk, ratio, n / src[0].length);
    return out.map(function (c) { return c.length === n ? c : c.subarray(0, n); });
  }

  /* ------------------------------------------------------------- colour */

  function ringMod(channels, sr, hz, mix) {
    return channels.map(function (c) {
      var y = new Float32Array(c.length), w = 2 * Math.PI * hz / sr;
      for (var i = 0; i < c.length; i++) y[i] = c[i] * (1 - mix + mix * Math.sin(w * i));
      return y;
    });
  }

  function band(channels, sr, lo, hi) {
    return channels.map(function (c) {
      var y = c;
      if (lo) { y = filter(y, biquad('hp', lo, sr)); y = filter(y, biquad('hp', lo, sr)); }
      if (hi) { y = filter(y, biquad('lp', hi, sr)); y = filter(y, biquad('lp', hi, sr)); }
      return y;
    });
  }

  // tanh saturation, gain-compensated so drive changes the colour rather
  // than the level.
  function drive(channels, amount) {
    var k = Math.max(1, amount), comp = 1 / Math.tanh(k);
    return channels.map(function (c) {
      var y = new Float32Array(c.length);
      for (var i = 0; i < c.length; i++) y[i] = Math.tanh(c[i] * k) * comp;
      return y;
    });
  }

  // Sample-and-hold down to `rate` after a low-pass at its Nyquist: the
  // narrow, slightly gritty sound of an 8 kHz phone line.
  function lofi(channels, sr, rate) {
    var step = sr / rate;
    return band(channels, sr, 0, rate * 0.45).map(function (c) {
      var y = new Float32Array(c.length), next = 0, hold = 0;
      for (var i = 0; i < c.length; i++) { if (i >= next) { hold = c[i]; next += step; } y[i] = hold; }
      return y;
    });
  }

  // A small Schroeder reverb (four combs, two all-passes per channel), with
  // a tail added to the length so the decay is not cut off.
  function reverb(channels, sr, size, mix) {
    var tail = Math.round(sr * (0.6 + size * 1.8));
    var combs = [1557, 1617, 1491, 1422].map(function (d) { return Math.round(d * sr / 44100 * (0.6 + size)); });
    var aps = [225, 556].map(function (d) { return Math.round(d * sr / 44100); });
    var fb = 0.7 + size * 0.22;
    return channels.map(function (c, ci) {
      var n = c.length + tail, wet = new Float32Array(n);
      combs.forEach(function (d0) {
        var d = d0 + ci * 23, buf = new Float32Array(d), j = 0, lp = 0;
        for (var i = 0; i < n; i++) {
          var o = buf[j];
          lp = o * 0.8 + lp * 0.2;
          buf[j] = (i < c.length ? c[i] : 0) + lp * fb;
          wet[i] += o * 0.25;
          if (++j >= d) j = 0;
        }
      });
      aps.forEach(function (d) {
        var buf = new Float32Array(d), j = 0;
        for (var i = 0; i < n; i++) {
          var b = buf[j], v = wet[i];
          buf[j] = v + b * 0.5;
          wet[i] = b - v * 0.5;
          if (++j >= d) j = 0;
        }
      });
      var y = new Float32Array(n);
      for (var i2 = 0; i2 < n; i2++) y[i2] = (i2 < c.length ? c[i2] : 0) * (1 - mix * 0.5) + wet[i2] * mix;
      return y;
    });
  }

  function peak(channels) {
    var p = 0;
    channels.forEach(function (c) { for (var i = 0; i < c.length; i++) { var a = Math.abs(c[i]); if (a > p) p = a; } });
    return p;
  }
  function gain(channels, g) {
    channels.forEach(function (c) { for (var i = 0; i < c.length; i++) c[i] *= g; });
    return channels;
  }

  /* ------------------------------------------------------------- presets */

  // Each value was set by ear on speech and then checked by check-voice.js
  // for pitch landing, length and level.
  var PRESETS = {
    deeper:    { label: 'Deeper', pitch: -4, formant: 0.92 },
    higher:    { label: 'Higher', pitch: 4, formant: 1.06 },
    male:      { label: 'More masculine', pitch: -5, formant: 0.87 },
    female:    { label: 'More feminine', pitch: 5, formant: 1.14 },
    chipmunk:  { label: 'Chipmunk', pitch: 9, formant: 1.35 },
    monster:   { label: 'Monster', pitch: -10, formant: 0.72, drive: 1.6, reverb: [0.5, 0.25] },
    robot:     { label: 'Robot', monotone: 110, ring: [50, 0.5] },
    alien:     { label: 'Alien', pitch: 3, formant: 1.18, ring: [180, 0.35] },
    radio:     { label: 'Old radio', band: [450, 3000], drive: 2.2 },
    telephone: { label: 'Telephone', band: [300, 3400], lofi: 8000, drive: 1.3 },
    cave:      { label: 'Cave', reverb: [0.9, 0.5] },
    custom:    { label: 'Custom' }
  };

  // Settings → processed channels, same length as the input plus any reverb
  // tail. Level: brought back to the input's peak, never above -1 dBFS; the
  // page runs ASLoudness.limit afterwards for true peak.
  function apply(channels, sr, s) {
    var inPeak = peak(channels) || 1;
    var x = channels;
    if (s.pitch || (s.formant && s.formant !== 1) || s.monotone) x = shift(x, sr, s);
    if (s.ring) x = ringMod(x, sr, s.ring[0], s.ring[1]);
    if (s.band) x = band(x, sr, s.band[0], s.band[1]);
    if (s.lofi) x = lofi(x, sr, s.lofi);
    if (s.drive) x = drive(x, s.drive);
    if (s.reverb) x = reverb(x, sr, s.reverb[0], s.reverb[1]);
    var pk = peak(x);
    if (pk > 0) gain(x, Math.min(inPeak, 0.891) / pk);
    return x;
  }

  return {
    PRESETS: PRESETS, apply: apply, shift: shift, f0Track: f0Track, marks: marks, psola: psola,
    ringMod: ringMod, band: band, drive: drive, lofi: lofi, reverb: reverb, peak: peak
  };
}));
