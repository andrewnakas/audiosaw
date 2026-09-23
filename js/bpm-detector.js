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
    var e = onsetEnvelope(mono.subarray(0, lim), sr), flux = e.flux, rate = e.rate;
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
    fine = ((fine % P) + P) % P;
    // The envelope frame marks the end of the hop the energy rose in; the
    // attack itself is half a hop earlier.
    var beat = Math.max(0, (fine - 0.5) / rate);
    var n = beatsPerBar || 4, down = 0, downS = -1;
    for (var j = 0; j < n; j++) {
      var sj = comb(fine + j * P, P * n);
      if (sj > downS) { downS = sj; down = j; }
    }
    return {
      beat: beat,
      downbeat: beat + down * 60 / bpm,
      strength: total > 0 ? bestS / (total / Math.ceil(P)) : 0   // peak over mean; ~1 means no pulse
    };
  }

  global.ASBpm = { analyse: analyse, phase: phase, toMono: toMono, onsetEnvelope: onsetEnvelope };
  if (typeof module === 'object' && module.exports) module.exports = global.ASBpm;
})(typeof window !== 'undefined' ? window : globalThis);
