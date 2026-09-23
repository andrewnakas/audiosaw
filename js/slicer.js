/*
 * Chopping a sample: where to cut, and cutting cleanly. Behind /sample-slicer
 * and the editor's "Slice at transients". Runs in Node for
 * tools/check-slicer.js.
 *
 * Transients are found by spectral flux: how much louder each frequency got
 * since the frame before, summed, on a log scale so a quiet hi-hat counts as
 * well as a kick. A hit is a peak in that curve that clears a moving median
 * by a margin set by the sensitivity. The peak itself lands a few
 * milliseconds into the attack, so each one is walked back to where the
 * energy started rising, and the cut is moved to the nearest zero crossing
 * before that. A slice that starts mid-waveform clicks on a pad, and one
 * that starts after the attack loses the snap that made it worth sampling.
 *
 * Every slice gets a short fade at its end (and a very short one at its
 * start, in case no zero crossing was near), which is what hardware
 * samplers expect of a chop.
 */
(function (global) {
  'use strict';

  var SP = (typeof module === 'object' && module.exports) ? require('./spectral.js') : global.ASSpectral;

  // 2048-point frames every 512 samples. At 1024 points, the notes of an
  // ordinary chord sit under 3 bins apart, and their leakage beats inside
  // a bin: a steady pad got 27 cuts. Where the cut lands is set by a fine
  // envelope afterwards, so the coarser hop costs no precision.
  var N = 2048, HOP = 512;

  function toMono(channels) {
    if (channels.length === 1) return channels[0];
    var n = channels[0].length, out = new Float32Array(n);
    for (var c = 0; c < channels.length; c++) for (var i = 0; i < n; i++) out[i] += channels[c][i] / channels.length;
    return out;
  }

  // The latest zero crossing at or before sample i, looking back at most
  // `max` samples; i itself if there is none.
  function zeroBefore(x, i, max) {
    for (var k = i; k > Math.max(0, i - max); k--) {
      if (x[k] === 0 || (x[k - 1] <= 0) !== (x[k] <= 0)) return Math.abs(x[k - 1]) < Math.abs(x[k]) ? k - 1 : k;
    }
    return i;
  }

  /*
   * onsets(channels, sr, {sensitivity 0..1 (0.5), minGap s (0.05)}) -> [seconds]
   */
  function onsets(channels, sr, opts) {
    opts = opts || {};
    var x = toMono(Array.isArray(channels) ? channels : [channels]);
    var sens = opts.sensitivity == null ? 0.5 : Math.max(0, Math.min(1, opts.sensitivity));
    var minGap = Math.round((opts.minGap || 0.05) * sr / HOP);
    var fft = SP.makeFFT(N), win = SP.hannPeriodic(N);
    var re = new Float64Array(N), im = new Float64Array(N);
    // 24 bands, log-spaced from 40 Hz to 16 kHz, so a kick (a few low bins)
    // counts as much as a hat (hundreds of high ones). Summed per bin, the
    // noise in the high bins drowned a kick at 0 dB.
    var NB = opts.bands || 24, bands = [], bins = N / 2;
    for (var bb = 0; bb < NB; bb++) {
      var f0 = 40 * Math.pow(400, bb / NB), f1 = 40 * Math.pow(400, (bb + 1) / NB);
      bands.push([Math.max(1, Math.floor(f0 * N / sr)), Math.max(Math.floor(f0 * N / sr) + 1, Math.min(bins, Math.floor(f1 * N / sr)))]);
    }
    var prev = new Float64Array(NB), cur = new Float64Array(NB);
    var frames = Math.max(0, Math.floor((x.length - N) / HOP) + 1);
    var flux = new Float64Array(frames), rms = new Float64Array(frames);

    for (var f = 0; f < frames; f++) {
      var off = f * HOP, e = 0;
      for (var i = 0; i < N; i++) { var v = x[off + i]; re[i] = v * win[i]; im[i] = 0; e += v * v; }
      rms[f] = Math.sqrt(e / N);
      fft.run(re, im, false);
      // Bands more than 40 dB under the frame's loudest are left out. There
      // the log scale turns leakage between a chord's notes into swings of
      // several units a frame: a steady three-note pad measured a median flux
      // of 1.9 and peaks of 13, and got 31 cuts.
      var s = 0, mags = [], mmax = 0;
      for (var b = 0; b < NB; b++) {
        var E = 0, w0 = bands[b][1] - bands[b][0];
        for (var k0 = bands[b][0]; k0 < bands[b][1]; k0++) E += re[k0] * re[k0] + im[k0] * im[k0];
        var mg = w0 > 0 ? Math.sqrt(E / w0) : 0;
        mags.push(mg); if (mg > mmax) mmax = mg;
      }
      for (b = 0; b < NB; b++) {
        cur[b] = Math.log(1 + 100 * mags[b]);
        var d = cur[b] - prev[b];
        if (d > 0 && mags[b] > mmax * 0.01) s += d;
      }
      flux[f] = f ? s : 0;
      var t = prev; prev = cur; cur = t;
    }
    if (frames < 3) return [];

    // Adaptive threshold: a multiple of the median over ±0.15 s, set by the
    // sensitivity, plus a floor so near-silence never triggers. A margin from
    // the file's overall mean was tried first and missed a kick at -2 dB
    // (flux 190 over a local median of 100, against a threshold of 305),
    // because the loud snares and hats of a break drag the mean up.
    var half = Math.max(2, Math.round(0.15 * sr / HOP)), peak = 0;
    for (f = 0; f < frames; f++) if (flux[f] > peak) peak = flux[f];
    // At the default sensitivity (0.5): 1.8x the local median and 8% of
    // the loudest onset. Swept on tools/check-slicer.js's breaks, this found
    // 194 of 211 hits with 3 false cuts; 2.0x and 10% found 192 with 2.
    var ratio = opts.ratio || (1.2 + 1.2 * (1 - sens));
    var floor = peak * (opts.floor == null ? 0.02 + 0.12 * (1 - sens) : opts.floor);
    var out = [], last = -1e9, win2 = [];
    for (f = 1; f + 1 < frames; f++) {
      if (flux[f] < flux[f - 1] || flux[f] < flux[f + 1]) continue;
      var lo = Math.max(0, f - half), hi = Math.min(frames, f + half + 1);
      win2.length = 0;
      for (var k = lo; k < hi; k++) win2.push(flux[k]);
      win2.sort(function (a, c) { return a - c; });
      var thr = win2[win2.length >> 1] * ratio;
      // And an absolute floor: an onset raises some band several-fold within
      // a frame, which a slow swell never does. Without it, a pad fading in
      // over a second, whose flux is tiny but steady, got 31 cuts.
      if (flux[f] < thr || flux[f] < floor || flux[f] < (opts.absFloor || 1)) continue;
      if (f - last < minGap) {
        // Two peaks too close together: keep the stronger.
        if (out.length && flux[f] > flux[last]) { out.pop(); } else continue;
      }
      out.push(f); last = f;
    }

    // Walk each back to where its energy starts rising, then to a zero
    // crossing, so the slice keeps the whole attack.
    return out.map(function (fr) {
      // Inside the stretch the onset frame covers, a fine envelope (0.7 ms
      // windows every 8 samples) and its steepest rise, which sits a
      // millisecond or two into any percussive attack; the cut goes 1.5 ms
      // before that, then back to a zero crossing. Two earlier ways were
      // measured and dropped: "the first sample above a level" landed on the
      // previous hit's decay (20-25 ms early), and "the quiet point before the
      // peak" wandered back through noise (often ~14 ms early).
      var a = Math.max(0, fr * HOP - 256), bEnd = Math.min(x.length - 48, fr * HOP + N);
      var W = 32, STEP = 8, env = [];
      for (var j = a; j < bEnd; j += STEP) {
        var sum = 0;
        for (var q = 0; q < W; q++) sum += x[j + q] * x[j + q];
        env.push(Math.sqrt(sum / W));
      }
      var best = 0, bestI = 0;
      for (j = 0; j + 2 < env.length; j++) {
        var rise = env[j + 2] - env[j];
        if (rise > best) { best = rise; bestI = j; }
      }
      var at = Math.max(0, a + bestI * STEP + W / 2 - Math.round(0.0015 * sr));
      return zeroBefore(x, at, Math.round(0.002 * sr)) / sr;
    }).filter(function (t, i, arr) { return i === 0 || t - arr[i - 1] > 0.005; });
  }

  // n equal slices across [0, dur).
  function equal(dur, n) {
    var out = [];
    for (var i = 0; i < n; i++) out.push(dur * i / n);
    return out;
  }

  // A slice every `beats` beats at `bpm`, from `offset`.
  function grid(dur, bpm, beats, offset) {
    var step = 60 / bpm * beats, out = [];
    for (var t = offset || 0; t < dur - 0.01; t += step) out.push(t);
    return out;
  }

  /*
   * cut(channels, sr, starts, {fadeInMs 0.5, fadeOutMs 3, snap true})
   *   -> [{start, end, channels: [Float32Array]}]
   * Each slice runs to the next start. With snap, equal or grid cuts are
   * moved to a zero crossing at most 2 ms earlier.
   */
  function cut(channels, sr, starts, opts) {
    opts = opts || {};
    var x = toMono(channels), n = channels[0].length;
    var idx = starts.map(function (t) {
      var i = Math.max(0, Math.min(n - 1, Math.round(t * sr)));
      return opts.snap === false ? i : zeroBefore(x, i, Math.round(0.002 * sr));
    }).sort(function (a, b) { return a - b; }).filter(function (v, i, a) { return i === 0 || v > a[i - 1]; });
    var fi = Math.round((opts.fadeInMs == null ? 0.5 : opts.fadeInMs) * sr / 1000);
    var fo = Math.round((opts.fadeOutMs == null ? 3 : opts.fadeOutMs) * sr / 1000);
    return idx.map(function (a, k) {
      var b = k + 1 < idx.length ? idx[k + 1] : n, len = b - a;
      var chans = channels.map(function (d) {
        var s = new Float32Array(d.subarray(a, b));
        var fin = Math.min(fi, len >> 2), fout = Math.min(fo, len >> 2);
        for (var i = 0; i < fin; i++) s[i] *= i / fin;
        for (i = 0; i < fout; i++) s[len - 1 - i] *= i / fout;
        return s;
      });
      return { start: a / sr, end: b / sr, channels: chans };
    });
  }

  var api = { onsets: onsets, equal: equal, grid: grid, cut: cut, zeroBefore: zeroBefore };
  global.ASSlicer = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
