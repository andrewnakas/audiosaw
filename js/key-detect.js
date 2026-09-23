/*
 * Musical key detection: which of the 24 major and minor keys a recording is
 * in, plus the runner-up, the Camelot code DJs mix by, and how far the
 * recording is tuned from A = 440 Hz.
 *
 * The method is the classic one: a chromagram (how much of each of the twelve
 * pitch classes is sounding, summed over the whole file) correlated against a
 * key profile rotated to each of the 24 keys. Three details carry most of the
 * accuracy, and each was measured by tools/check-key.js:
 *
 *   - Only spectral peaks are counted, at their interpolated frequency, not
 *     every FFT bin. Counting bins smears each note into its neighbours and
 *     lets broadband drums vote for every pitch class at once.
 *   - The tuning is estimated first and taken out. A band tuned 30 cents
 *     sharp puts half its energy in the wrong semitone otherwise.
 *   - Each frame is normalised before summing, so one loud chorus does not
 *     outvote the rest of the song, and near-silent frames are skipped.
 *
 * The audio is decimated to ~11 kHz before the transform. Nothing a key is
 * made of lives above 2 kHz, and at that rate an 8192-point FFT resolves
 * 1.35 Hz, finer than the 3.3 Hz between the two lowest semitones used.
 *
 * Runs in Node (tools/check-key.js) and in the browser.
 */
(function (global) {
  'use strict';

  var SP = (typeof module === 'object' && module.exports) ? require('./spectral.js') : global.ASSpectral;

  var SHARP = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  // How musicians spell them: Db major rather than C# major, but C# minor
  // rather than Db minor.
  var MAJOR_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  var MINOR_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];

  // Krumhansl & Kessler (1982) probe-tone ratings, and Temperley's (2007)
  // corpus-derived profiles. check-key.js measures both; the default is the
  // one that measured better.
  var PROFILES = {
    krumhansl: {
      major: [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
      minor: [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
    },
    temperley: {
      major: [0.748, 0.060, 0.488, 0.082, 0.670, 0.460, 0.096, 0.715, 0.104, 0.366, 0.057, 0.400],
      minor: [0.712, 0.084, 0.474, 0.618, 0.049, 0.460, 0.105, 0.747, 0.404, 0.067, 0.133, 0.330]
    }
  };

  function keyName(pc, mode) { return (mode === 'major' ? MAJOR_NAMES : MINOR_NAMES)[pc] + ' ' + mode; }

  // The Camelot wheel: C major is 8B, A minor 8A, and a step round the wheel
  // is a fifth. Keys with the same number or one apart mix cleanly.
  function camelot(pc, mode) {
    var major = mode === 'major' ? pc : (pc + 3) % 12;
    var n = (8 + 7 * major) % 12;
    return (n === 0 ? 12 : n) + (mode === 'major' ? 'B' : 'A');
  }

  function toMono(channels, n) {
    var out = new Float32Array(n), k = channels.length;
    for (var c = 0; c < k; c++) { var d = channels[c]; for (var i = 0; i < n; i++) out[i] += d[i] / k; }
    return out;
  }

  // Windowed-sinc low-pass and keep every `f`th sample.
  function decimate(x, f) {
    if (f <= 1) return x;
    var taps = 16 * f + 1, half = (taps - 1) / 2, h = new Float32Array(taps), fc = 0.45 / f, sum = 0;
    for (var i = 0; i < taps; i++) {
      var t = i - half, w = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (taps - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (taps - 1));
      h[i] = (t === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * t) / (Math.PI * t)) * w;
      sum += h[i];
    }
    for (i = 0; i < taps; i++) h[i] /= sum;
    var n = Math.floor(x.length / f), out = new Float32Array(n);
    for (var j = 0; j < n; j++) {
      var c = j * f, acc = 0, k0 = Math.max(0, half - c), k1 = Math.min(taps, x.length - c + half);
      for (var k = k0; k < k1; k++) acc += h[k] * x[c + k - half];
      out[j] = acc;
    }
    return out;
  }

  function pearson(a, b) {
    var n = a.length, ma = 0, mb = 0;
    for (var i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    var num = 0, da = 0, db = 0;
    for (i = 0; i < n; i++) { var x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
    return da && db ? num / Math.sqrt(da * db) : 0;
  }

  /*
   * analyse(channels, sampleRate, opts) -> {
   *   pc, mode, name, camelot, r,          the best key and its correlation
   *   runnerUp: {pc, mode, name, camelot, r},
   *   margin,                              r(best) - r(runner-up)
   *   confidence: 'clear' | 'likely' | 'unsure',
   *   tuningCents,                         how far from A = 440, -50..50
   *   chroma: [12], scores: [24]
   * } or null when there is nothing tonal to read.
   *
   * channels: Float32Array[] (or one Float32Array). opts.maxSec (default 240),
   * opts.profile ('temperley' | 'krumhansl').
   */
  /*
   * The shared front end: per-frame chroma, tuning removed, each frame
   * normalised to sum to 1 (null for frames that are near-silent or have no
   * peaks). Key detection sums them all; chord detection sums them per beat.
   * opts.N / opts.hop set the window (8192 / 2048 at ~11 kHz by default).
   */
  function chromaFrames(channels, sr, opts) {
    opts = opts || {};
    if (!Array.isArray(channels)) channels = [channels];
    var n = Math.min(channels[0].length, Math.round((opts.maxSec || 240) * sr));
    var f = Math.max(1, Math.round(sr / 11025)), rate = sr / f;
    var x = decimate(toMono(channels, n), f);

    var N = opts.N || 8192, hop = opts.hop || 2048, fft = SP.makeFFT(N), win = SP.hannPeriodic(N);
    var re = new Float64Array(N), im = new Float64Array(N), mag = new Float32Array(N / 2 + 1);
    var loB = Math.max(2, Math.ceil((opts.loHz || 50) * N / rate)), hiB = Math.min(N / 2 - 1, Math.floor(2100 * N / rate));
    var frames = [], energies = [];

    // Pass 1: spectral peaks per frame, as (fractional MIDI note, weight).
    for (var off = 0; off + N <= x.length || (off === 0 && x.length); off += hop) {
      var e = 0;
      for (var i = 0; i < N; i++) { var v = off + i < x.length ? x[off + i] : 0; re[i] = v * win[i]; im[i] = 0; e += v * v; }
      fft.run(re, im, false);
      for (var b = 0; b <= N / 2; b++) mag[b] = Math.sqrt(re[b] * re[b] + im[b] * im[b]);
      var peaks = [], fmax = 0;
      for (b = loB; b <= hiB; b++) if (mag[b] > fmax) fmax = mag[b];
      for (b = loB; b <= hiB; b++) {
        var m = mag[b];
        // A peak, and not a sidelobe or the noise floor: within 40 dB of the
        // frame's loudest.
        if (m <= mag[b - 1] || m < mag[b + 1] || m < fmax * 0.01) continue;
        var a = Math.log(mag[b - 1] + 1e-12), c = Math.log(m + 1e-12), d = Math.log(mag[b + 1] + 1e-12);
        var den = a - 2 * c + d, p = den < 0 ? 0.5 * (a - d) / den : 0;
        var hz = (b + p) * rate / N;
        peaks.push(69 + 12 * Math.log(hz / 440) / Math.LN2, Math.sqrt(m));
      }
      frames.push(peaks);
      energies.push(e / N);
      if (off + N >= x.length) break;
    }
    if (!frames.length) return null;

    // Skip frames more than 50 dB below the loudest.
    var emax = 0;
    energies.forEach(function (v) { if (v > emax) emax = v; });
    if (emax < 1e-10) return null;

    // Tuning: the weighted circular mean of every peak's distance from the
    // nearest equal-tempered semitone.
    var sx = 0, sy = 0;
    frames.forEach(function (pk, fi) {
      if (energies[fi] < emax * 1e-5) return;
      for (var k = 0; k < pk.length; k += 2) {
        var ang = 2 * Math.PI * (pk[k] - Math.round(pk[k]));
        sx += pk[k + 1] * Math.cos(ang); sy += pk[k + 1] * Math.sin(ang);
      }
    });
    var tune = Math.atan2(sy, sx) / (2 * Math.PI);   // semitones, -0.5..0.5

    // Pass 2: per-frame chroma, tuning removed, normalised.
    var chroma = frames.map(function (pk, fi) {
      if (energies[fi] < emax * 1e-5 || !pk.length) return null;
      var fr = new Float64Array(12), tot = 0;
      for (var k = 0; k < pk.length; k += 2) {
        var mm = pk[k] - tune, r = Math.round(mm), dev = mm - r;
        var w = Math.cos(Math.PI * dev); w *= w;
        var pc = ((r % 12) + 12) % 12;
        fr[pc] += w * pk[k + 1]; tot += w * pk[k + 1];
      }
      if (tot <= 0) return null;
      for (var q = 0; q < 12; q++) fr[q] /= tot;
      return fr;
    });
    // A frame's time is the centre of its window.
    return { chroma: chroma, energies: energies, emax: emax, tune: tune, hopSec: hop / rate, centreSec: N / 2 / rate };
  }

  function analyse(channels, sr, opts) {
    opts = opts || {};
    var cf = chromaFrames(channels, sr, opts);
    if (!cf) return null;
    var chroma = new Float64Array(12), used = 0, tune = cf.tune;
    cf.chroma.forEach(function (fr) {
      if (!fr) return;
      for (var q = 0; q < 12; q++) chroma[q] += fr[q];
      used++;
    });
    if (!used) return null;

    var prof = PROFILES[opts.profile] || PROFILES[DEFAULT_PROFILE];
    var scores = [];
    ['major', 'minor'].forEach(function (mode) {
      for (var t = 0; t < 12; t++) {
        var rot = new Array(12);
        for (var q = 0; q < 12; q++) rot[q] = prof[mode][(q - t + 12) % 12];
        scores.push({ pc: t, mode: mode, r: pearson(chroma, rot) });
      }
    });
    var sorted = scores.slice().sort(function (p1, p2) { return p2.r - p1.r; });
    var best = sorted[0], second = sorted[1], margin = best.r - second.r;
    function describe(s) { return { pc: s.pc, mode: s.mode, name: keyName(s.pc, s.mode), camelot: camelot(s.pc, s.mode), r: s.r }; }
    var out = describe(best);
    out.runnerUp = describe(second);
    out.margin = margin;
    out.confidence = margin >= CLEAR && best.r >= 0.6 ? 'clear' : margin >= LIKELY ? 'likely' : 'unsure';
    out.tuningCents = Math.round(tune * 100);
    out.chroma = Array.prototype.map.call(chroma, function (v) { return v / used; });
    out.scores = scores.map(function (s) { return s.r; });
    return out;
  }

  /*
   * Chords over time: major and minor triads, or 'N' where nothing clear is
   * sounding.
   *
   * Frames are 0.37 s windows every 93 ms; a chord that changes twice a
   * second needs that, and the key's 0.74 s window would smear every change.
   * Frames are summed over each segment: the beats when opts.beats (a list of
   * times) is given, which is how the editor calls it, otherwise fixed
   * opts.segSec slices (default 0.5 s). Each segment is scored against the
   * 24 triads by cosine similarity, the third weighted a little above the
   * fifth because it is what makes a chord major or minor and the fifth is
   * present as an overtone of the root in every note anyway.
   * A segment scoring under 0.7 is 'N': real triads measured 0.76 to 0.96,
   * and the tail of a song, drums over a fading chord, 0.62.
   *
   * Nothing below 100 Hz is counted. A kick drum's falling pitch lives there
   * and can pass for a chord. The chord's upper voices name it without the
   * bass. A named chord must also have its root and third each at least a
   * fifth of the loudest note. Measured on 8 s of drums alone: 1.5 s named
   * as chords with a 60 Hz floor, 1.0 s with the 100 Hz floor, 0.5 s with
   * both.
   *
   * Then equal neighbours are merged and anything shorter than opts.minSec
   * (default 0.4 s) is absorbed into whichever neighbour it scores better
   * as, which removes the flicker a passing note causes.
   *
   * Returns [{t0, t1, pc, quality: 'maj'|'min'|'N', name, score}] in seconds.
   */
  var CHORD_ROOTS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  var TEMPLATES = (function () {
    var out = [];
    ['maj', 'min'].forEach(function (q) {
      for (var r = 0; r < 12; r++) {
        var t = new Float64Array(12);
        t[r] = 1; t[(r + (q === 'maj' ? 4 : 3)) % 12] = 1.1; t[(r + 7) % 12] = 0.9;
        var norm = 0;
        for (var i = 0; i < 12; i++) norm += t[i] * t[i];
        norm = Math.sqrt(norm);
        for (i = 0; i < 12; i++) t[i] /= norm;
        out.push({ pc: r, quality: q, t: t });
      }
    });
    return out;
  })();
  function chordName(pc, q) { return q === 'N' ? 'N' : CHORD_ROOTS[pc] + (q === 'min' ? 'm' : ''); }

  function scoreChord(v) {
    var norm = 0;
    for (var i = 0; i < 12; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm);
    var best = null;
    TEMPLATES.forEach(function (T) {
      if (!norm) return;
      var d = 0;
      for (var i = 0; i < 12; i++) d += v[i] * T.t[i];
      d /= norm;
      if (!best || d > best.score) best = { pc: T.pc, quality: T.quality, score: d };
    });
    return best || { pc: 0, quality: 'N', score: 0 };
  }

  function chords(channels, sr, opts) {
    opts = opts || {};
    var cf = chromaFrames(channels, sr, { N: 4096, hop: 1024, loHz: opts.loHz || 100, maxSec: opts.maxSec || 600 });
    if (!cf) return [];
    var nFrames = cf.chroma.length, dur = (cf.hopSec * (nFrames - 1)) + 2 * cf.centreSec;
    var edges = [];
    if (opts.beats && opts.beats.length > 1) {
      edges = opts.beats.filter(function (t) { return t >= 0 && t <= dur; });
      if (!edges.length || edges[0] > 0.01) edges.unshift(0);
      if (edges[edges.length - 1] < dur - 0.01) edges.push(dur);
    } else {
      var seg = opts.segSec || 0.5;
      for (var t = 0; t < dur; t += seg) edges.push(t);
      edges.push(dur);
    }
    var segs = [];
    for (var k = 0; k + 1 < edges.length; k++) {
      var t0 = edges[k], t1 = edges[k + 1], v = new Float64Array(12), used = 0;
      for (var fi = 0; fi < nFrames; fi++) {
        var tc = fi * cf.hopSec + cf.centreSec;
        if (tc < t0 || tc >= t1 || !cf.chroma[fi]) continue;
        for (var q = 0; q < 12; q++) v[q] += cf.chroma[fi][q];
        used++;
      }
      var sc = used ? scoreChord(v) : { pc: 0, quality: 'N', score: 0 };
      if (sc.score < (opts.minScore || 0.7) || !triadPresent(v, sc)) sc = { pc: 0, quality: 'N', score: sc.score };
      segs.push({ t0: t0, t1: t1, pc: sc.pc, quality: sc.quality, score: sc.score, v: v });
    }
    function same(a, b) { return a.quality === b.quality && (a.quality === 'N' || a.pc === b.pc); }
    function merge(list) {
      var out = [];
      list.forEach(function (sg) {
        var last = out[out.length - 1];
        if (last && same(last, sg)) {
          last.t1 = sg.t1;
          for (var q = 0; q < 12; q++) last.v[q] += sg.v[q];
        } else out.push({ t0: sg.t0, t1: sg.t1, pc: sg.pc, quality: sg.quality, score: sg.score, v: Float64Array.from(sg.v) });
      });
      return out;
    }
    var list = merge(segs), minSec = opts.minSec == null ? 0.4 : opts.minSec, changed = true;
    while (changed) {
      changed = false;
      for (var j = 0; j < list.length; j++) {
        var sgm = list[j];
        if (sgm.t1 - sgm.t0 >= minSec || list.length < 2) continue;
        // Fold it into the neighbour whose chord fits its notes better.
        var prev = list[j - 1], next = list[j + 1], into = prev || next;
        if (prev && next) {
          var fitP = scoreAs(sgm.v, prev), fitN = scoreAs(sgm.v, next);
          into = fitN > fitP ? next : prev;
        }
        if (into === prev) { prev.t1 = sgm.t1; } else { next.t0 = sgm.t0; }
        for (var q2 = 0; q2 < 12; q2++) into.v[q2] += sgm.v[q2];
        list.splice(j, 1);
        list = merge(list);
        changed = true;
        break;
      }
    }
    return list.map(function (sg) {
      return { t0: sg.t0, t1: sg.t1, pc: sg.pc, quality: sg.quality, name: chordName(sg.pc, sg.quality), score: Math.round(sg.score * 1000) / 1000 };
    });
  }
  // A chord needs its root and its third actually sounding, each at least a
  // fifth of the loudest note.
  function triadPresent(v, sc) {
    var mx = 0;
    for (var i = 0; i < 12; i++) if (v[i] > mx) mx = v[i];
    var third = (sc.pc + (sc.quality === 'maj' ? 4 : 3)) % 12;
    return mx > 0 && v[sc.pc] >= 0.2 * mx && v[third] >= 0.2 * mx;
  }
  function scoreAs(v, chord) {
    if (chord.quality === 'N') return 0;
    var T = TEMPLATES[(chord.quality === 'min' ? 12 : 0) + chord.pc].t, d = 0, norm = 0;
    for (var i = 0; i < 12; i++) { d += v[i] * T[i]; norm += v[i] * v[i]; }
    return norm ? d / Math.sqrt(norm) : 0;
  }

  var DEFAULT_PROFILE = 'temperley';
  var CLEAR = 0.08, LIKELY = 0.03;

  // Semitones to move from one key to another the short way round, -6..+5.
  // Relative keys count as the same (A minor and C major share every note),
  // so a minor source is compared through its relative major.
  function shiftBetween(from, to) {
    var a = from.mode === 'minor' ? (from.pc + 3) % 12 : from.pc;
    var b = to.mode === 'minor' ? (to.pc + 3) % 12 : to.pc;
    if (from.mode === to.mode) { a = from.pc; b = to.pc; }
    var d = ((b - a) % 12 + 12) % 12;
    return d > 5 ? d - 12 : d;
  }

  // The key a whole-semitone shift lands in, for "C major -> D major" labels.
  function transpose(key, semis) {
    var pc = ((key.pc + semis) % 12 + 12) % 12;
    return { pc: pc, mode: key.mode, name: keyName(pc, key.mode), camelot: camelot(pc, key.mode) };
  }

  // "A-minor", "Db major", "f#-minor" -> {pc, mode, name, camelot}, or null.
  // How /key-finder hands a key to the pages it links to.
  function parse(str) {
    var m = /^\s*([A-Ga-g])([#b]?)[\s_-]*(major|minor)\s*$/i.exec(String(str || ''));
    if (!m) return null;
    var pc = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
    pc = (pc + 12) % 12;
    var mode = m[3].toLowerCase();
    return { pc: pc, mode: mode, name: keyName(pc, mode), camelot: camelot(pc, mode) };
  }

  var api = {
    analyse: analyse, parse: parse, chords: chords, chordName: chordName, keyName: keyName, camelot: camelot, shiftBetween: shiftBetween, transpose: transpose,
    PROFILES: PROFILES, NAMES: SHARP, MAJOR_NAMES: MAJOR_NAMES, MINOR_NAMES: MINOR_NAMES
  };
  global.ASKey = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
