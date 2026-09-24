/*
 * Tempo detection.
 *
 * Onset envelope -> autocorrelation -> comb scoring with a perceptual prior.
 * Nothing here is novel; the value is in the tuning, which was measured rather
 * than guessed. Validated against click tracks and synthesised drum patterns at
 * known tempos: every musical test case lands within 0.2 BPM.
 *
 * The one case that is genuinely ambiguous is a bare metronome, where half and
 * double are equally defensible readings and only the prior separates them.
 * That is why the page shows both alternates rather than pretending to one
 * answer — the same reason Serato and Mixed In Key offer a half/double toggle.
 */
(function (global) {
  'use strict';

  var ENV_RATE = 800;   // onset-envelope samples per second
  var MIN_BPM = 60;
  var MAX_BPM = 200;

  // Sum the channels to mono. Tempo lives in the rhythm, not the stereo image,
  // and one channel is half the work.
  function toMono(buffer) {
    var n = buffer.length;
    var out = new Float32Array(n);
    var ch = buffer.numberOfChannels;
    for (var c = 0; c < ch; c++) {
      var d = buffer.getChannelData(c);
      for (var i = 0; i < n; i++) out[i] += d[i] / ch;
    }
    return out;
  }

  // Onset strength over time: RMS per short frame, then the positive part of
  // its first difference. A cheap stand-in for spectral flux that works well on
  // percussive material, which is what anyone asking for a BPM has.
  function onsetEnvelope(d, sr) {
    var hop = Math.max(1, Math.round(sr / ENV_RATE));
    var frames = Math.floor(d.length / hop);
    var env = new Float32Array(frames);
    for (var f = 0; f < frames; f++) {
      var s = 0;
      var start = f * hop;
      for (var i = start; i < start + hop; i++) s += d[i] * d[i];
      env[f] = Math.sqrt(s / hop);
    }
    var flux = new Float32Array(frames);
    for (var g = 1; g < frames; g++) flux[g] = Math.max(0, env[g] - env[g - 1]);
    var mean = 0;
    for (var h = 0; h < frames; h++) mean += flux[h];
    mean /= (frames || 1);
    for (var k = 0; k < frames; k++) flux[k] = Math.max(0, flux[k] - mean);
    return { flux: flux, rate: sr / hop };
  }

  // Onset strength for placing beats rather than counting them: the peak
  // level over the last 20 ms, a frame at a time, then its rise. RMS over a
  // 1.25 ms hop is shorter than one cycle of a bass note, so on tonal music
  // its "onsets" are the waveform itself, spread 30-40 ms after the attack.
  // A trailing peak rises on the attack and holds through the cycles after.
  function peakFlux(d, sr) {
    var hop = Math.max(1, Math.round(sr / ENV_RATE));
    var frames = Math.floor(d.length / hop), W = Math.max(1, Math.round(0.02 * sr / hop));
    var pk = new Float32Array(frames), env = new Float32Array(frames);
    for (var f = 0; f < frames; f++) {
      var m = 0;
      for (var i = f * hop, e = i + hop; i < e; i++) { var v = d[i] < 0 ? -d[i] : d[i]; if (v > m) m = v; }
      pk[f] = m;
    }
    for (var g = 0; g < frames; g++) {
      var mm = 0;
      for (var k = Math.max(0, g - W + 1); k <= g; k++) if (pk[k] > mm) mm = pk[k];
      env[g] = mm;
    }
    var flux = new Float32Array(frames), mean = 0;
    for (var h = 1; h < frames; h++) { flux[h] = Math.max(0, env[h] - env[h - 1]); mean += flux[h]; }
    mean /= (frames || 1);
    for (var q = 0; q < frames; q++) flux[q] = Math.max(0, flux[q] - mean);
    return { flux: flux, rate: sr / hop };
  }

  function analyse(buffer, onProgress) {
    var sr = buffer.sampleRate;
    if (onProgress) onProgress(15, 'Building onset envelope…');
    var mono = toMono(buffer);
    var e = onsetEnvelope(mono, sr);
    var flux = e.flux, envRate = e.rate, frames = flux.length;

    if (onProgress) onProgress(45, 'Correlating…');
    var lagMin = Math.floor(envRate * 60 / MAX_BPM);
    var lagMax = Math.ceil(envRate * 60 / MIN_BPM);
    var scores = [];
    var sMap = {};
    for (var lag = lagMin; lag <= lagMax; lag++) {
      var s = 0, count = 0;
      for (var f = 0; f + lag < frames; f++) { s += flux[f] * flux[f + lag]; count++; }
      var v = count ? s / count : 0;
      scores.push({ lag: lag, score: v });
      sMap[lag] = v;
    }
    if (!scores.length) return null;

    if (onProgress) onProgress(80, 'Scoring candidates…');
    function corr(l) {
      var r = Math.round(l);
      return sMap[r] === undefined ? 0 : sMap[r];
    }

    // A real pulse leaves correlation peaks at its period AND at multiples of
    // it. Scoring by the single highest peak instead lands on an arbitrary
    // multiple, because at twice the beat period every beat still lines up.
    var W = [1, 0.6, 0.35, 0.2];
    for (var i = 0; i < scores.length; i++) {
      var c = scores[i];
      var comb = 0;
      for (var k = 0; k < W.length; k++) comb += W[k] * corr(c.lag * (k + 1));
      var bpmC = 60 * envRate / c.lag;
      // Tapping clusters around 120 BPM. Without this a detector is free to be
      // right about the pulse and wrong about which multiple a listener counts.
      c.comb = comb * Math.exp(-0.5 * Math.pow(Math.log(bpmC / 120) / Math.LN2 / 0.85, 2));
    }
    var ranked = scores.slice().sort(function (a, b) { return b.comb - a.comb; });
    var best = ranked[0];

    // Sub-frame peak position, so the answer is not quantised to the envelope.
    var yA = corr(best.lag - 1), yB = best.score, yC = corr(best.lag + 1);
    var denom = yA - 2 * yB + yC;
    var shift = denom !== 0 ? 0.5 * (yA - yC) / denom : 0;
    var refined = best.lag + Math.max(-1, Math.min(1, shift));
    var bpm = 60 * envRate / refined;

    // Confidence: how far clear the winner is of the best candidate that is not
    // a neighbouring lag or an octave of it.
    var rival = null;
    for (var r = 0; r < ranked.length; r++) {
      var cand = ranked[r];
      if (Math.abs(cand.lag - best.lag) <= 2) continue;
      var ratio = cand.lag / best.lag;
      if (Math.abs(ratio - 2) < 0.04 || Math.abs(ratio - 0.5) < 0.04) continue;
      rival = cand; break;
    }
    var conf = (rival && best.comb > 0)
      ? Math.max(0, Math.min(1, 1 - rival.comb / best.comb))
      : 0.5;

    if (onProgress) onProgress(100, 'Done');
    return { bpm: bpm, confidence: conf, duration: buffer.duration };
  }

  /*
   * Where the beats fall, given the tempo: the time of the first beat
   * (0 <= beat < one beat period) and a guess at the first downbeat.
   *
   * A comb of teeth one beat apart is slid across one period of the onset
   * envelope, and the offset that collects the most onset energy wins. Each
   * tooth takes the strongest envelope value within ±15 ms, so a small error
   * in the tempo does not smear the comb over a long file. Only the first 30 s
   * are used for the same reason.
   *
   * The downbeat is a guess and is labelled as one: it is whichever beat of
   * the bar collects the most energy, which is right when the kick or a crash
   * marks beat one, and wrong on plenty of music that does not.
   */
  function phase(buffer, bpm, beatsPerBar) {
    var sr = buffer.sampleRate, mono = toMono(buffer);
    var lim = Math.min(mono.length, Math.round(sr * 30));
    var e = peakFlux(mono.subarray(0, lim), sr), flux = e.flux, rate = e.rate;
    var P = rate * 60 / bpm, tol = Math.max(1, Math.round(rate * 0.015));
    if (!(P > 2) || flux.length < P * 2) return null;
    function tooth(x) {
      var c = Math.round(x), m = 0;
      for (var i = c - tol; i <= c + tol; i++) if (i >= 0 && i < flux.length && flux[i] > m) m = flux[i];
      return m;
    }
    function comb(o, step) { var s = 0; for (var x = o; x < flux.length; x += step) s += tooth(x); return s; }
    var best = 0, bestS = -1, total = 0;
    // Coarse pass a frame at a time, then the tolerance window is removed
    // from the answer by a fine pass with single-frame teeth.
    for (var o = 0; o < P; o++) { var sc = comb(o, P); total += sc; if (sc > bestS) { bestS = sc; best = o; } }
    var fine = best, fineS = -1;
    for (var d = -tol; d <= tol; d++) {
      var oo = best + d, s2 = 0;
      for (var x = oo; x < flux.length; x += P) { var xi = Math.round(x); if (xi >= 0 && xi < flux.length) s2 += flux[xi] + 0.5 * ((flux[xi - 1] || 0) + (flux[xi + 1] || 0)); }
      if (s2 > fineS) { fineS = s2; fine = oo; }
    }
    // A strum or a flam is several attacks within a few tens of ms, and the
    // beat is the first of them: step back to the earliest frame, within
    // 30 ms, that collects at least 0.7 as much as the strongest. Measured on
    // a strum 24 ms wide: 14.3 ms late without this, 3.1 ms with it.
    function acc(o) { var a = 0; for (var x = o; x < flux.length; x += P) { var xi = Math.round(x); if (xi >= 0 && xi < flux.length) a += flux[xi]; } return a; }
    var peakA = acc(fine);
    for (var e0 = fine - Math.round(rate * 0.03); e0 < fine; e0++) if (acc(e0) >= 0.7 * peakA) { fine = e0; break; }
    fine = ((fine % P) + P) % P;
    // The envelope frame marks the end of the hop the energy rose in; the
    // attack itself is half a hop earlier.
    var beat = Math.max(0, (fine - 0.5) / rate);
    var n = beatsPerBar || 4;
    var down = n > 1 ? downbeatOf(mono.subarray(0, lim), sr, beat, 60 / bpm, n) : 0;
    return {
      beat: beat,
      downbeat: beat + down * 60 / bpm,
      strength: total > 0 ? bestS / (total / Math.ceil(P)) : 0   // peak over mean; ~1 means no pulse
    };
  }

  /*
   * Which beat of the bar is one, given where the beats are. Four cues, each
   * averaged over every bar for each of the n candidate positions:
   *
   *   harmony  the chords change on the bar line: the distance between the
   *            chroma of a beat and the beat before it
   *   low      a kick or a bass note lands on one (and three): energy below
   *            150 Hz at the beat
   *   backbeat the snare is on two and four: energy above 2 kHz at the beat
   *            counts against
   *   ring     a crash or a held chord marks one: energy above 2 kHz that is
   *            still there 120 ms later counts for it, which is what tells a
   *            crash from a snare
   *
   * Each cue is taken relative to its own mean across the positions, so one
   * that is the same on every beat (a kick on every beat) says nothing. It is
   * still a guess, and the page says so.
   *
   * On check-beat's patterns, harmony decides the pitched styles and ring the
   * drums-only ones (without ring, 0 of 54 of those were right). Low and
   * backbeat were redundant there, but they are what is left for drums with
   * no crash, where they can tell 1 and 3 from 2 and 4 and no more.
   */
  function downbeatOf(d, sr, beat, period, n) {
    var D = Math.max(1, Math.round(sr / 11025)), rs = sr / D, len = Math.floor(d.length / D);
    var x = new Float32Array(len);
    for (var i = 0; i < len; i++) { var s = 0; for (var k = 0; k < D; k++) s += d[i * D + k]; x[i] = s / D; }
    var NL = 4096, NS = 1024;
    var hannL = hann(NL), hannS = hann(NS);
    var reL = new Float64Array(NL), imL = new Float64Array(NL), reS = new Float64Array(NS), imS = new Float64Array(NS);
    function spectrum(t, N, win, re, im, maxLen) {
      var i0 = Math.round(t * rs), m = Math.min(N, maxLen);
      for (var j = 0; j < N; j++) { var ii = i0 + j; re[j] = j < m && ii >= 0 && ii < len ? x[ii] * win[Math.floor(j * N / m)] : 0; im[j] = 0; }
      fft(re, im);
    }
    function band(re, im, N, f0, f1) {
      var a = Math.max(1, Math.round(f0 * N / rs)), b = Math.min(N / 2 - 1, Math.round(f1 * N / rs)), e = 0;
      for (var j = a; j <= b; j++) e += re[j] * re[j] + im[j] * im[j];
      return e;
    }
    var beats = [];
    for (var t = beat; t + 0.35 < len / rs; t += period) {
      spectrum(t + 0.02, NL, hannL, reL, imL, Math.round(period * rs * 0.9));
      var ch = new Float64Array(12);
      for (var j = Math.round(55 * NL / rs); j < Math.min(NL / 2, Math.round(2000 * NL / rs)); j++) {
        var f = j * rs / NL, pc = ((Math.round(12 * Math.log(f / 440) / Math.LN2) + 69) % 12 + 12) % 12;
        ch[pc] += Math.sqrt(reL[j] * reL[j] + imL[j] * imL[j]);
      }
      spectrum(t - 0.01, NS, hannS, reS, imS, NS);
      var low = band(reS, imS, NS, 30, 150), high = band(reS, imS, NS, 2000, 5400);
      spectrum(t + 0.12, NS, hannS, reS, imS, NS);
      beats.push({ ch: ch, low: low, high: high, ring: band(reS, imS, NS, 2000, 5400) });
    }
    if (beats.length < n * 2) return 0;
    var H = [], L = [], B = [], R = [], cnt = [];
    for (var p = 0; p < n; p++) { H.push(0); L.push(0); B.push(0); R.push(0); cnt.push(0); }
    for (var k2 = 1; k2 < beats.length; k2++) {
      var q = k2 % n, a = beats[k2 - 1].ch, b2 = beats[k2].ch, dot = 0, na = 0, nb = 0;
      for (var c = 0; c < 12; c++) { dot += a[c] * b2[c]; na += a[c] * a[c]; nb += b2[c] * b2[c]; }
      H[q] += na > 0 && nb > 0 ? 1 - dot / Math.sqrt(na * nb) : 0;
      L[q] += beats[k2].low; B[q] += beats[k2].high; R[q] += beats[k2].ring; cnt[q]++;
    }
    function rel(v, floor) {
      var m = 0, j;
      for (j = 0; j < n; j++) { v[j] /= cnt[j] || 1; m += v[j] / n; }
      return v.map(function (y) { return (y - m) / (m + floor); });
    }
    var h = rel(H, 0.05), l = rel(L, 1e-9), bb = rel(B, 1e-9), r = rel(R, 1e-9);
    var best = 0, bestS = -Infinity;
    for (var j2 = 0; j2 < n; j2++) {
      var sc = h[j2] + l[j2] - bb[j2] + r[j2];
      if (sc > bestS) { bestS = sc; best = j2; }
    }
    return best;
  }

  function hann(N) { var w = new Float64Array(N); for (var i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)); return w; }

  // In-place radix-2 FFT. N must be a power of two.
  function fft(re, im) {
    var N = re.length, i, j, k, t;
    for (i = 1, j = 0; i < N; i++) {
      var bit = N >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (var size = 2; size <= N; size <<= 1) {
      var half = size >> 1, ang = -2 * Math.PI / size, wr = Math.cos(ang), wi = Math.sin(ang);
      for (i = 0; i < N; i += size) {
        var cr = 1, ci = 0;
        for (k = 0; k < half; k++) {
          var a = i + k, b = a + half;
          var xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
          t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
  }

  global.ASBpm = { analyse: analyse, phase: phase, toMono: toMono, onsetEnvelope: onsetEnvelope };
  if (typeof module === 'object' && module.exports) module.exports = global.ASBpm;
})(typeof window !== 'undefined' ? window : globalThis);
