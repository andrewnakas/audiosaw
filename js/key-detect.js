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
      var fr = new Float64Array(12), tot = 0, raw = 0, onGrid = 0;
      // opts.bassDuck: also make fr.alt, the same chroma with the lowest
      // strong note's non-octave overtones counted this much, and keep that
      // note's pitch class as fr.bass. See chords() for why.
      var bassM = null, duck = opts.bassDuck, alt = new Float64Array(12), altTot = 0;
      if (duck != null) {
        var wmax = 0;
        for (var k0 = 1; k0 < pk.length; k0 += 2) if (pk[k0] > wmax) wmax = pk[k0];
        for (k0 = 0; k0 < pk.length; k0 += 2) if (pk[k0 + 1] >= 0.5 * wmax) { bassM = pk[k0]; break; }
        if (bassM != null) { var bm = bassM - tune; fr.bass = ((Math.round(bm) % 12) + 12) % 12; }
      }
      for (var k = 0; k < pk.length; k += 2) {
        var mm = pk[k] - tune, r = Math.round(mm), dev = mm - r;
        var w = Math.cos(Math.PI * dev); w *= w;
        var pc = ((r % 12) + 12) % 12;
        raw += pk[k + 1]; onGrid += w * pk[k + 1];
        fr[pc] += w * pk[k + 1]; tot += w * pk[k + 1];
        if (bassM != null) {
          // Harmonic h of the bass sits 12*log2(h) semitones above it.
          var up = pk[k] - bassM, wa = w;
          for (var hi = 0; hi < BASS_H.length; hi++) if (Math.abs(up - 12 * Math.log(BASS_H[hi]) / Math.LN2) < 0.3) { wa *= duck; break; }
          alt[pc] += wa * pk[k + 1]; altTot += wa * pk[k + 1];
        }
      }
      if (bassM != null && altTot > 0) { for (var q1 = 0; q1 < 12; q1++) alt[q1] /= altTot; fr.alt = alt; }
      if (tot <= 0) return null;
      for (var q = 0; q < 12; q++) fr[q] /= tot;
      // How much of the frame's peak weight sits on the semitone grid:
      // near 1 for notes, about 0.5 for noise, whose peaks fall anywhere.
      fr.inTune = onGrid / raw;
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
   * A segment must also be mostly notes: see IN_TUNE.
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
   * Returns [{t0, t1, pc, quality: 'maj'|'min'|'N', ext: ''|'7'|'maj7'|'m7',
   * bass (pitch class, or -1 unless it is the third or fifth), name ('C',
   * 'Am7', 'C/E'), score}] in seconds.
   */
  // Notes sit on the semitone grid; the peaks of noise (a snare, cymbals, a
  // kick's sweep) fall anywhere on it. Measured as the share of a segment's
  // peak weight near a semitone: real chords 0.82 and up at the 5th
  // percentile (clean, band, melody, sevenths, slash), drums alone at most
  // 0.63 over eight seeds. Drum segments that scored as chords (0.70-0.76)
  // overlapped real triads (from 0.76), so the score alone could not tell.
  var IN_TUNE = 0.7, BASS_DUCK = 0.3, BASS_H = [3, 5, 6];
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
  function chordName(pc, q, ext) {
    if (q === 'N') return 'N';
    return CHORD_ROOTS[pc] + (ext === 'maj7' ? 'maj7' : q === 'min' ? (ext ? 'm7' : 'm') : (ext ? '7' : ''));
  }

  /*
   * A seventh on top of a triad that has already been named: the dominant 7
   * or major 7 on a major chord, the minor 7 on a minor one. It is decided on
   * the whole merged segment, after the triad, so it can never change which
   * triad is named. The seventh has to be a real voice, not an overtone or
   * a passing note.
   *
   * Overtones: the third harmonic of a note is a fifth above it (plus an
   * octave). So a major third feeds the major seventh, a minor third the
   * minor seventh, and the fifth feeds the ninth: every triad carries some
   * of its own seventh. SEV_LEAK of the note a fifth below is taken off each
   * pitch class before it is compared.
   *
   * Level: the seventh is compared with the third, the one voice of the
   * chord that the bass note and the root's overtones do not also feed. On
   * the check's harmonic tones, plain triads measured up to 0.51 of the
   * third (0.37 at the 90th percentile, under a melody), real sevenths from
   * 0.26 (0.45 at the 10th percentile).
   *
   * Clear: a melody walking the scale passes through the seventh as often
   * as through the sixth or the second, so the seventh must also be
   * SEV_CLEAR times the loudest other note outside the chord. Real sevenths
   * measured at least 1.55.
   */
  var SEV_LEVEL = 0.4, SEV_LEAK = 0.3, SEV_CLEAR = 1.5;
  function seventhOf(v, pc, q) {
    var third = (pc + (q === 'maj' ? 4 : 3)) % 12, fifth = (pc + 7) % 12;
    var cands = q === 'maj' ? [[10, '7'], [11, 'maj7']] : [[10, 'm7']];
    var skip = {}; skip[pc] = skip[third] = skip[fifth] = true;
    cands.forEach(function (c) { skip[(pc + c[0]) % 12] = true; });
    function own(i) { return v[i] - SEV_LEAK * v[(i + 5) % 12]; }
    var other = 0;
    for (var i = 0; i < 12; i++) if (!skip[i]) other = Math.max(other, own(i));
    var best = null, bestV = 0, bestRaw = 0;
    cands.forEach(function (c) {
      var k = (pc + c[0]) % 12, e = own(k);
      if (e > bestV) { bestV = e; bestRaw = v[k]; best = c[1]; }
    });
    if (!best || !(v[third] > 0)) return '';
    return bestV >= SEV_LEVEL * v[third] && bestRaw >= SEV_CLEAR * other ? best : '';
  }

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
    var cf = chromaFrames(channels, sr, { N: 4096, hop: 1024, loHz: opts.loHz || 100, maxSec: opts.maxSec || 600, bassDuck: opts.bassDuck != null ? opts.bassDuck : BASS_DUCK });
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
      var t0 = edges[k], t1 = edges[k + 1], v = new Float64Array(12), va = new Float64Array(12), bass = new Float64Array(12), used = 0, inTune = 0;
      for (var fi = 0; fi < nFrames; fi++) {
        var tc = fi * cf.hopSec + cf.centreSec, fr = cf.chroma[fi];
        if (tc < t0 || tc >= t1 || !fr) continue;
        for (var q = 0; q < 12; q++) { v[q] += fr[q]; va[q] += fr.alt ? fr.alt[q] : fr[q]; }
        if (fr.bass != null) bass[fr.bass]++;
        inTune += fr.inTune;
        used++;
      }
      var sc = used ? scoreChord(v) : { pc: 0, quality: 'N', score: 0 };
      if (sc.score < (opts.minScore || 0.7) || !triadPresent(v, sc) || inTune / used < IN_TUNE) sc = { pc: 0, quality: 'N', score: sc.score };
      segs.push({ t0: t0, t1: t1, pc: sc.pc, quality: sc.quality, score: sc.score, v: v, va: va, b: bass, n: used });
    }
    function same(a, b) { return a.quality === b.quality && (a.quality === 'N' || a.pc === b.pc); }
    function merge(list) {
      var out = [];
      list.forEach(function (sg) {
        var last = out[out.length - 1];
        if (last && same(last, sg)) {
          last.t1 = sg.t1;
          for (var q = 0; q < 12; q++) { last.v[q] += sg.v[q]; last.va[q] += sg.va[q]; last.b[q] += sg.b[q]; }
          last.n += sg.n;
        } else out.push({ t0: sg.t0, t1: sg.t1, pc: sg.pc, quality: sg.quality, score: sg.score, v: Float64Array.from(sg.v), va: Float64Array.from(sg.va), b: Float64Array.from(sg.b), n: sg.n });
      });
      return out;
    }
    // An inversion. A bass note's overtones spell a chord of their own: an
    // E bass under C major brings B (its 3rd harmonic) and G# (its 5th), and
    // reads as E minor. So each chord, once merged, is scored again with the
    // bass's non-octave overtones turned down, and that reading is taken if
    // it differs and has the bass as its third or fifth. It is decided on
    // the whole chord, not per beat: a melody's passing notes can make one
    // beat of a root-position C read as Am over its C bass, but they do not
    // last, and on single beats no measure separated those from real
    // inversions. Over five seeds of check-chords, 161 switches were right
    // and 6 wrong (all under a melody); no score margin separated those 6.
    var pre = merge(segs);
    pre.forEach(function (sg) {
      if (sg.quality === 'N') return;
      var bpc = -1, bn = 0;
      for (var q = 0; q < 12; q++) if (sg.b[q] > bn) { bn = sg.b[q]; bpc = q; }
      if (bn < sg.n * 0.5) return;
      var al = scoreChord(sg.va);
      if (al.pc === sg.pc && al.quality === sg.quality) return;
      var third = (al.pc + (al.quality === 'maj' ? 4 : 3)) % 12;
      if (bpc !== third && bpc !== (al.pc + 7) % 12) return;
      if (al.score < (opts.minScore || 0.7) || !triadPresent(sg.v, al)) return;
      sg.pc = al.pc; sg.quality = al.quality; sg.score = al.score;
    });
    var list = merge(pre), minSec = opts.minSec == null ? 0.4 : opts.minSec, changed = true;
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
        for (var q2 = 0; q2 < 12; q2++) { into.v[q2] += sgm.v[q2]; into.va[q2] += sgm.va[q2]; into.b[q2] += sgm.b[q2]; }
        into.n += sgm.n;
        list.splice(j, 1);
        list = merge(list);
        changed = true;
        break;
      }
    }
    return list.map(function (sg) {
      var ext = sg.quality === 'N' ? '' : seventhOf(sg.v, sg.pc, sg.quality);
      // The bass under it, when that is the third or the fifth: C/E, C/G.
      var bass = -1, bn = 0;
      for (var q4 = 0; q4 < 12; q4++) if (sg.b[q4] > bn) { bn = sg.b[q4]; bass = q4; }
      if (sg.quality === 'N' || bn < sg.n * 0.5 || (bass !== (sg.pc + (sg.quality === 'maj' ? 4 : 3)) % 12 && bass !== (sg.pc + 7) % 12)) bass = -1;
      return { t0: sg.t0, t1: sg.t1, pc: sg.pc, quality: sg.quality, ext: ext, bass: bass, name: chordName(sg.pc, sg.quality, ext) + (bass >= 0 ? '/' + CHORD_ROOTS[bass] : ''), score: Math.round(sg.score * 1000) / 1000 };
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
