/*
 * Pitch correction: snap a sung or played line to a scale.
 *
 * Time-domain PSOLA (pitch-synchronous overlap-add). The signal is cut into
 * grains centred on successive pitch periods and reassembled with the spacing
 * changed; spacing them closer raises the pitch, further apart lowers it, and
 * because the grains themselves are unaltered the formants — the resonances
 * that make a voice sound like that person — largely stay put. Plain
 * resampling moves them, which is the chipmunk effect.
 *
 * Duration is preserved by construction: grains are repeated or dropped to
 * keep the output timeline aligned with the input.
 *
 * Two knobs decide whether this sounds like correction or like the effect:
 * strength (how far toward the target note) and retune speed (how quickly the
 * correction is allowed to move). Instant, full-strength correction is the
 * hard-tuned sound; slower and partial is transparent tuning.
 */
(function (global) {
  'use strict';

  var SCALES = {
    chromatic: [0,1,2,3,4,5,6,7,8,9,10,11],
    major:     [0,2,4,5,7,9,11],
    minor:     [0,2,3,5,7,8,10],
    harmonicMinor: [0,2,3,5,7,8,11],
    pentatonicMajor: [0,2,4,7,9],
    pentatonicMinor: [0,3,5,7,10],
    blues:     [0,3,5,6,7,10]
  };

  // Nearest allowed note, searching outward so a tie goes to the lower note
  // (which is what a singer sliding up into a note expects).
  function snapMidi(midi, rootPc, scale) {
    var best = null, bestDist = Infinity;
    var base = Math.floor(midi) - 13;
    for (var m = base; m <= base + 26; m++) {
      var pc = ((m - rootPc) % 12 + 12) % 12;
      if (scale.indexOf(pc) === -1) continue;
      var d = Math.abs(m - midi);
      if (d < bestDist - 1e-9) { bestDist = d; best = m; }
    }
    return best === null ? midi : best;
  }

  // Two-pole low-pass, used only to find pitch marks. Harmonics are the enemy
  // here: on a bright waveform there are several local maxima inside one
  // period, so peak-picking the raw signal lands on a different feature each
  // cycle. That jitter was measured at +/-15% of a period, and it makes the
  // overlap-add incoherent — grains cancel and a subharmonic appears two
  // octaves down. Filtering to roughly the fundamental leaves one clear peak
  // per cycle.
  function lowpass(x, sampleRate, cutoffHz) {
    var w0 = 2 * Math.PI * cutoffHz / sampleRate;
    var cos0 = Math.cos(w0), alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
    var b0 = (1 - cos0) / 2, b1 = 1 - cos0, b2 = (1 - cos0) / 2;
    var a0 = 1 + alpha, a1 = -2 * cos0, a2 = 1 - alpha;
    b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
    var y = new Float32Array(x.length);
    var x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (var i = 0; i < x.length; i++) {
      var x0 = x[i];
      var y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x0; y2 = y1; y1 = y0;
      y[i] = y0;
    }
    return y;
  }

  /*
   * Find pitch marks: one per period, anchored to a peak of the low-passed
   * signal so every grain is cut at the same point in the cycle. Marks that
   * are not phase-coherent are what make naive PSOLA buzz.
   */
  function pitchMarks(x, periods, sampleRate, guideHz) {
    var guide = lowpass(x, sampleRate, Math.max(60, Math.min(sampleRate / 4, (guideHz || 200) * 1.4)));
    var marks = [];
    var i = 0;
    while (i < x.length - 2) {
      var p = periods(i);
      if (!p || p < 2) { i += Math.round(sampleRate * 0.005); continue; }
      // Search only a narrow window so the mark cannot slip a whole cycle.
      var search = Math.max(2, Math.round(p * 0.2));
      var lo = Math.max(0, i - search), hi = Math.min(x.length - 1, i + search);
      var bestIdx = i, bestVal = -Infinity;
      for (var k = lo; k <= hi; k++) {
        if (guide[k] > bestVal) { bestVal = guide[k]; bestIdx = k; }
      }
      marks.push({ pos: bestIdx, period: p });
      i = bestIdx + Math.round(p);
    }
    return marks;
  }

  function hann(n) {
    var w = new Float32Array(n);
    for (var i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1)));
    return w;
  }

  /*
   * channels: array of Float32Array
   * ratioAt(sampleIndex) -> desired output/input frequency ratio at that point
   */
  function psola(channels, sampleRate, marks, ratioAt) {
    if (!marks.length) return channels.map(function (c) { return c.slice(); });
    var out = channels.map(function (c) { return new Float32Array(c.length); });
    var norm = new Float32Array(channels[0].length);

    // Walk the OUTPUT timeline. For each output grain, take the input grain
    // whose position matches in time — that is what preserves duration — and
    // step forward by the corrected period.
    var t = marks[0].pos;
    var guard = 0;
    while (t < channels[0].length && guard++ < 4000000) {
      // Nearest input mark to this output position.
      var lo = 0, hi = marks.length - 1, mi = 0;
      while (lo <= hi) {
        mi = (lo + hi) >> 1;
        if (marks[mi].pos < t) lo = mi + 1; else hi = mi - 1;
      }
      var idx = Math.max(0, Math.min(marks.length - 1, lo));
      if (idx > 0 && Math.abs(marks[idx - 1].pos - t) < Math.abs(marks[idx].pos - t)) idx--;
      var m = marks[idx];

      var ratio = ratioAt(m.pos) || 1;
      if (!isFinite(ratio) || ratio <= 0) ratio = 1;

      var grainLen = Math.round(m.period * 2);
      if (grainLen < 8) { t += Math.max(1, Math.round(m.period / ratio)); continue; }
      var w = hann(grainLen);
      var half = Math.floor(grainLen / 2);

      for (var c = 0; c < channels.length; c++) {
        var src = channels[c], dst = out[c];
        for (var j = 0; j < grainLen; j++) {
          var si = m.pos - half + j;
          var di = t - half + j;
          if (si < 0 || si >= src.length || di < 0 || di >= dst.length) continue;
          dst[di] += src[si] * w[j];
        }
      }
      for (var j2 = 0; j2 < grainLen; j2++) {
        var di2 = t - half + j2;
        if (di2 >= 0 && di2 < norm.length) norm[di2] += w[j2];
      }

      t += Math.max(1, Math.round(m.period / ratio));
    }

    // Overlapping Hann grains do not sum to unity at arbitrary spacing, so
    // divide it back out. Without this the output level pumps with the pitch.
    for (var c2 = 0; c2 < out.length; c2++) {
      var d = out[c2];
      for (var n = 0; n < d.length; n++) {
        if (norm[n] > 1e-4) d[n] /= norm[n];
      }
    }
    return out;
  }

  /*
   * The whole job.
   * opts: { rootPc, scale, strength (0..1), retuneSec, minClarity }
   */
  function correct(channels, sampleRate, frames, opts) {
    opts = opts || {};
    var scale = SCALES[opts.scale] || SCALES.chromatic;
    var rootPc = opts.rootPc || 0;
    var strength = opts.strength === undefined ? 1 : Math.max(0, Math.min(1, opts.strength));
    var retune = opts.retuneSec === undefined ? 0.02 : Math.max(0.001, opts.retuneSec);
    var minClarity = opts.minClarity === undefined ? 0.55 : opts.minClarity;

    if (!frames.length) return { channels: channels, corrected: 0, medianCents: 0 };

    var hopSec = frames.length > 1 ? (frames[1].time - frames[0].time) : 0.01;

    // Target pitch per frame, then smoothed. The smoothing IS the retune speed:
    // a one-pole filter whose time constant decides how quickly the correction
    // is allowed to move. Instant is the hard-tuned sound; slower reads as a
    // singer simply being in tune.
    var alpha = 1 - Math.exp(-hopSec / retune);
    var shiftSemis = new Float32Array(frames.length);
    var smoothed = 0, started = false;
    var offsets = [];
    var correctedFrames = 0;

    for (var i = 0; i < frames.length; i++) {
      var f = frames[i];
      var want = 0;
      if (f.clarity >= minClarity && f.hz > 0) {
        var target = snapMidi(f.midi, rootPc, scale);
        var err = target - f.midi;                 // semitones to move
        offsets.push(err * 100);                   // cents, for reporting
        want = err * strength;
        correctedFrames++;
      }
      if (!started) { smoothed = want; started = true; }
      else smoothed += alpha * (want - smoothed);
      shiftSemis[i] = smoothed;
    }

    // Ratio lookup by sample position.
    var hopSamples = Math.max(1, Math.round(hopSec * sampleRate));
    function ratioAt(pos) {
      var fi = Math.max(0, Math.min(frames.length - 1, Math.round(pos / hopSamples)));
      return Math.pow(2, shiftSemis[fi] / 12);
    }
    function periodAt(pos) {
      var fi = Math.max(0, Math.min(frames.length - 1, Math.round(pos / hopSamples)));
      var hz = frames[fi].hz;
      if (!hz || frames[fi].clarity < 0.35) return 0;
      return sampleRate / hz;
    }

    var mono = channels.length === 1 ? channels[0] : (function () {
      var m = new Float32Array(channels[0].length);
      for (var c = 0; c < channels.length; c++) {
        var d = channels[c];
        for (var k = 0; k < m.length; k++) m[k] += d[k] / channels.length;
      }
      return m;
    })();

    // Median voiced f0 sets the low-pass cutoff used to place pitch marks.
    var voiced = [];
    for (var vi = 0; vi < frames.length; vi++) {
      if (frames[vi].clarity >= 0.5 && frames[vi].hz > 0) voiced.push(frames[vi].hz);
    }
    voiced.sort(function (a, b) { return a - b; });
    var guideHz = voiced.length ? voiced[Math.floor(voiced.length / 2)] : 200;

    var marks = pitchMarks(mono, periodAt, sampleRate, guideHz);
    var outCh = psola(channels, sampleRate, marks, ratioAt);

    offsets.sort(function (a, b) { return Math.abs(a) - Math.abs(b); });
    var medianCents = offsets.length ? offsets[Math.floor(offsets.length / 2)] : 0;

    return {
      channels: outCh,
      corrected: correctedFrames,
      totalFrames: frames.length,
      medianCents: medianCents,
      marks: marks.length
    };
  }

  global.ASAutotune = { correct: correct, snapMidi: snapMidi, psola: psola, pitchMarks: pitchMarks, SCALES: SCALES };
})(typeof window !== 'undefined' ? window : globalThis);
