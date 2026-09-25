/*
 * ITU-R BS.1770-4 loudness measurement, and the gain needed to hit a target.
 *
 * This is what "normalize for Spotify" actually means. Peak normalization —
 * what /normalize-audio does — sets the loudest sample to a known ceiling and
 * says nothing about how loud the track *sounds*; two files peak-normalized to
 * the same value routinely differ by 10 LU. Streaming services all measure
 * perceived loudness instead and turn tracks down to their own target, so the
 * only way to know what they will do is to measure the same way they do.
 *
 * The measurement is fully specified, which means it can be checked rather than
 * trusted: every number here is validated against ffmpeg's ebur128 filter, the
 * reference implementation, to within 0.1 LU. If you change anything in this
 * file, re-run that comparison (tools/check-loudness.js).
 *
 * The chain, per the spec:
 *   K-weighting (a high-shelf then a high-pass, modelling head and ear)
 *     -> mean square over 400 ms blocks, overlapping by 75%
 *     -> absolute gate at -70 LUFS, discarding silence
 *     -> relative gate 10 LU below the ungated mean, discarding quiet passages
 *   Integrated loudness is the mean square of what survives both gates.
 *
 * The gates are the part people get wrong. Without them a track with long quiet
 * intros measures far quieter than it sounds, because the silence is averaged
 * in.
 */
(function (global) {
  'use strict';

  // The spec defines its filter coefficients at 48 kHz. Rather than redesign
  // the filters per rate, callers resample to 48 kHz first — which is what the
  // reference implementations do, and keeps this file comparable to them.
  var SPEC_RATE = 48000;

  // Stage 1: high-shelf, modelling the acoustic effect of a head.
  var PRE = {
    b: [1.53512485958697, -2.69169618940638, 1.19839281085285],
    a: [1, -1.69065929318241, 0.73248077421585]
  };
  // Stage 2: RLB high-pass, modelling low-frequency insensitivity.
  var RLB = {
    b: [1.0, -2.0, 1.0],
    a: [1, -1.99004745483398, 0.99007225036621]
  };

  function biquad(x, f) {
    var y = new Float32Array(x.length);
    var b0 = f.b[0], b1 = f.b[1], b2 = f.b[2], a1 = f.a[1], a2 = f.a[2];
    var x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (var i = 0; i < x.length; i++) {
      var x0 = x[i];
      var y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x0; y2 = y1; y1 = y0;
      y[i] = y0;
    }
    return y;
  }

  function kWeight(channel) {
    return biquad(biquad(channel, PRE), RLB);
  }

  // Channel weights from the spec. Surround channels count for more; the two
  // front channels and centre count as one each.
  function weightFor(index, channelCount) {
    if (channelCount <= 2) return 1.0;
    // 5.x order: L R C LFE Ls Rs. LFE is excluded from the measurement.
    if (index === 3) return 0.0;
    return (index === 4 || index === 5) ? 1.41 : 1.0;
  }

  /*
   * channels: array of Float32Array, all the same length, sampled at 48 kHz.
   * Returns { integrated, blocks } with loudness in LUFS.
   */
  function integratedLoudness(channels, sampleRate) {
    var blockSec = 0.400;
    var stepSec = 0.100;                       // 75% overlap
    var blockLen = Math.round(blockSec * sampleRate);
    var stepLen = Math.round(stepSec * sampleRate);
    var n = channels[0].length;
    if (n < blockLen) return { integrated: -Infinity, blocks: 0 };

    var weighted = channels.map(kWeight);
    var nBlocks = Math.floor((n - blockLen) / stepLen) + 1;

    // Mean square per channel per block.
    var msq = [];
    for (var c = 0; c < weighted.length; c++) msq.push(new Float64Array(nBlocks));
    for (var ch = 0; ch < weighted.length; ch++) {
      var d = weighted[ch];
      var acc = msq[ch];
      for (var b = 0; b < nBlocks; b++) {
        var start = b * stepLen;
        var s = 0;
        for (var i = start; i < start + blockLen; i++) s += d[i] * d[i];
        acc[b] = s / blockLen;
      }
    }

    // Loudness of each block, summed across weighted channels.
    var blockLoud = new Float64Array(nBlocks);
    for (var j = 0; j < nBlocks; j++) {
      var sum = 0;
      for (var k = 0; k < msq.length; k++) sum += weightFor(k, msq.length) * msq[k][j];
      blockLoud[j] = sum > 0 ? -0.691 + 10 * Math.log10(sum) : -Infinity;
    }

    function gatedMean(threshold) {
      var sums = new Float64Array(msq.length);
      var count = 0;
      for (var j2 = 0; j2 < nBlocks; j2++) {
        if (blockLoud[j2] <= threshold) continue;
        for (var k2 = 0; k2 < msq.length; k2++) sums[k2] += msq[k2][j2];
        count++;
      }
      if (!count) return null;
      var total = 0;
      for (var k3 = 0; k3 < sums.length; k3++) {
        total += weightFor(k3, sums.length) * (sums[k3] / count);
      }
      return { power: total, count: count };
    }

    // Absolute gate: anything below -70 LUFS is silence, not quiet content.
    var abs = gatedMean(-70);
    if (!abs || abs.power <= 0) return { integrated: -Infinity, blocks: 0 };

    // Relative gate: 10 LU below the ungated mean, so a quiet intro does not
    // drag the measurement down.
    var relThreshold = -0.691 + 10 * Math.log10(abs.power) - 10;
    var rel = gatedMean(Math.max(relThreshold, -70));
    if (!rel || rel.power <= 0) return { integrated: -Infinity, blocks: 0 };

    return {
      integrated: -0.691 + 10 * Math.log10(rel.power),
      blocks: rel.count
    };
  }

  // True peak: the reconstructed waveform between samples can exceed every
  // sample in the file, and a D/A converter or a lossy encoder will clip on
  // that even though no stored sample was over. The spec asks for at least 4x
  // oversampling before measuring.
  //
  // The interpolation is a windowed sinc. The window has to be centred on the
  // point being interpolated, not on the start of the tap range — getting that
  // wrong reads about 1 dB low on transient material, which was measured
  // against the reference before it was fixed.
  function truePeak(channels) {
    var OS = 4, T = 24;
    var peak = 0;
    var c, i;

    // Sample peak first: it is the floor for the true peak and sets the
    // threshold below which interpolating cannot change the answer.
    for (c = 0; c < channels.length; c++) {
      var dd = channels[c];
      for (i = 0; i < dd.length; i++) {
        var a0 = dd[i] < 0 ? -dd[i] : dd[i];
        if (a0 > peak) peak = a0;
      }
    }
    if (peak === 0) return 0;

    // Precompute the kernel for each sub-sample position; it does not change.
    var kernels = [];
    for (var p = 1; p < OS; p++) {
      var t = p / OS;
      var kern = new Float64Array(2 * T);
      for (var k = -T + 1, idx = 0; k <= T; k++, idx++) {
        var x = t - k;
        var sinc = (x < 1e-9 && x > -1e-9) ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        // Hann window centred on the interpolation point.
        var dist = (k - t) / T;
        var w = (dist <= 1 && dist >= -1) ? 0.5 * (1 + Math.cos(Math.PI * dist)) : 0;
        kern[idx] = sinc * w;
      }
      kernels.push(kern);
    }

    // Only look near loud samples: an inter-sample peak sits between samples
    // that are themselves close to the maximum, so scanning quiet regions at 4x
    // costs four times the work for a number they cannot set.
    var thresh = peak * 0.5;
    for (c = 0; c < channels.length; c++) {
      var d = channels[c];
      for (var j = T; j < d.length - T; j++) {
        var av0 = d[j] < 0 ? -d[j] : d[j];
        if (av0 < thresh) continue;
        for (var q = 0; q < kernels.length; q++) {
          var kk = kernels[q], sum = 0;
          for (var m = 0, kj = j - T + 1; m < kk.length; m++, kj++) sum += d[kj] * kk[m];
          var av = sum < 0 ? -sum : sum;
          if (av > peak) peak = av;
        }
      }
    }
    return peak;
  }

  function toDb(x) { return x > 0 ? 20 * Math.log10(x) : -Infinity; }

  // A true-peak limiter for whole files: gain, then this, and no sample or
  // inter-sample peak passes `ceiling` (linear). Used by /amplify-audio and
  // as the clip guard on the EQ and vocal remover. Checked in
  // tools/check-fidelity.js: +12 dB into a full-scale mix measures at or
  // under the ceiling, and audio that never nears it is not touched at all.
  //
  //  - Detection is the 4x interpolation truePeak() uses, per sample, taking
  //    the loudest of the sample and its three in-between points, across all
  //    channels (the gain is linked, so the stereo image does not move).
  //  - Look-ahead: the gain needed at a peak is reached `lookahead` seconds
  //    before it, by a moving minimum then a moving average of that length.
  //    The average of values that are each at most the need at the peak is
  //    itself at most that need, so the peak is always under.
  //  - Release is a straight line back up to exactly 1, over `release`
  //    seconds for a full swing, never above the attack curve. A region the
  //    limiter never touches keeps gain 1.0 exactly: bit-for-bit untouched.
  function limit(channels, sampleRate, ceiling, opts) {
    // Heavy limiting moves the gain within the span an inter-sample peak is
    // interpolated from, and the first pass can leave a hundredth of a dB
    // over; a second pass over what is left is tiny and clears it.
    var total = 0;
    for (var pass = 0; pass < 3; pass++) {
      var res = limitOnce(channels, sampleRate, ceiling, opts);
      total += res.reduced;
      if (!res.reduced) break;
    }
    return { reduced: total };
  }

  function limitOnce(channels, sampleRate, ceiling, opts) {
    opts = opts || {};
    var n = channels[0].length, nch = channels.length;
    var W = Math.max(1, Math.round((opts.lookahead || 0.0015) * sampleRate));
    var step = 1 / Math.max(1, (opts.release || 0.08) * sampleRate);
    var OS = 4, T = 24, kernels = [];
    for (var p = 1; p < OS; p++) {
      var t = p / OS, kern = new Float64Array(2 * T);
      for (var k = -T + 1, idx = 0; k <= T; k++, idx++) {
        var x = t - k;
        var sinc = (x < 1e-9 && x > -1e-9) ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        var dist = (k - t) / T;
        kern[idx] = sinc * ((dist <= 1 && dist >= -1) ? 0.5 * (1 + Math.cos(Math.PI * dist)) : 0);
      }
      kernels.push(kern);
    }
    // The gain moves a little between the samples an inter-sample peak is
    // built from, which measured up to 0.005 dB over; aim 0.02 dB under.
    var aim = ceiling * Math.pow(10, -0.02 / 20);
    // Needed gain per sample. Interpolation only near loud samples: an
    // inter-sample peak cannot reach the ceiling between samples that are
    // both far under it.
    var need = new Float32Array(n), any = false, thresh = ceiling * 0.5;
    for (var i = 0; i < n; i++) {
      var pk = 0;
      for (var c = 0; c < nch; c++) {
        var d = channels[c], v = d[i] < 0 ? -d[i] : d[i];
        if (v > pk) pk = v;
        if (v >= thresh && i >= T - 1 && i + T < n) {
          for (var q = 0; q < kernels.length; q++) {
            var kk = kernels[q], sum = 0;
            for (var m = 0, kj = i - T + 1; m < kk.length; m++, kj++) sum += d[kj] * kk[m];
            if (sum < 0) sum = -sum;
            if (sum > pk) pk = sum;
          }
        }
      }
      need[i] = pk > aim ? aim / pk : 1;
      if (need[i] < 1) any = true;
    }
    if (!any) return { reduced: 0 };
    // Moving minimum over the past W samples, then the average of the next W.
    var M = new Float32Array(n), dq = new Int32Array(n), h = 0, tl = 0;
    for (var j = 0; j < n; j++) {
      while (tl > h && need[dq[tl - 1]] >= need[j]) tl--;
      dq[tl++] = j;
      if (dq[h] <= j - W) h++;
      M[j] = need[dq[h]];
    }
    var g = new Float32Array(n), acc = 0;
    for (var a2 = 0; a2 < W && a2 < n; a2++) acc += M[a2];
    for (var j2 = 0; j2 < n; j2++) {
      var cnt = Math.min(W, n - j2);
      g[j2] = acc / cnt;
      acc -= M[j2];
      if (j2 + W < n) acc += M[j2 + W];
    }
    // Release, and apply.
    var r = 1, most = 1;
    for (var j3 = 0; j3 < n; j3++) {
      r = Math.min(g[j3], r + step, 1);
      if (r < most) most = r;
      if (r !== 1) for (var c2 = 0; c2 < nch; c2++) channels[c2][j3] *= r;
    }
    return { reduced: -20 * Math.log10(most) };
  }

  global.ASLoudness = {
    integratedLoudness: integratedLoudness,
    truePeak: truePeak,
    limit: limit,
    toDb: toDb,
    SPEC_RATE: SPEC_RATE
  };
})(typeof window !== 'undefined' ? window : globalThis);
