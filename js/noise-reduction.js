/*
 * Noise reduction by spectral gating.
 *
 * The approach is the same one Audacity's noise reduction uses. Take a short-
 * time Fourier transform of the signal; estimate, per frequency bin, how loud
 * the noise floor is; then attenuate any bin that is close to that floor while
 * leaving louder bins alone. Steady broadband noise — fan hum, air
 * conditioning, tape hiss, preamp noise — sits at a constant level in every
 * frame, so it is exactly what this removes well.
 *
 * The noise profile is estimated automatically by taking a low percentile of
 * each bin's magnitude across the whole file, which assumes the noise is
 * present throughout and that no single frequency is loud in every frame. That
 * holds for room tone. It does not hold for a sustained organ note, so the
 * page is explicit about what this does and does not fix.
 *
 * Irregular noise — a door slam, a cough, traffic, another person talking —
 * is not stationary and cannot be removed this way. No amount of parameter
 * tweaking changes that; it needs source separation, which is a different
 * problem.
 */
(function () {
  'use strict';

  var ASSET_V = (function () {
    var m = document.currentScript && /[?&]v=([^&]+)/.exec(document.currentScript.src);
    return m ? m[1] : '1';
  })();

  var FFT_SIZE = 2048;
  var HOP = FFT_SIZE / 4;   // 75% overlap — enough that Hann analysis/synthesis sums flat

  /* ------------------------------------------------------------------ FFT */
  // Iterative in-place radix-2 Cooley-Tukey. Real input, complex output held as
  // two parallel arrays. Small enough to be worth having rather than pulling in
  // a dependency for one tool.
  function makeFFT(n) {
    var levels = Math.log2(n) | 0;
    if (Math.pow(2, levels) !== n) throw new Error('FFT size must be a power of two');
    var cosT = new Float32Array(n / 2);
    var sinT = new Float32Array(n / 2);
    for (var i = 0; i < n / 2; i++) {
      cosT[i] = Math.cos(2 * Math.PI * i / n);
      sinT[i] = Math.sin(2 * Math.PI * i / n);
    }
    // Bit-reversal permutation table
    var rev = new Uint32Array(n);
    for (var j = 0; j < n; j++) {
      var x = j, r = 0;
      for (var b = 0; b < levels; b++) { r = (r << 1) | (x & 1); x >>= 1; }
      rev[j] = r;
    }

    function transform(re, im, inverse) {
      var k, l, m, p, q;
      for (k = 0; k < n; k++) {
        var r2 = rev[k];
        if (r2 > k) {
          var tr = re[k]; re[k] = re[r2]; re[r2] = tr;
          var ti = im[k]; im[k] = im[r2]; im[r2] = ti;
        }
      }
      for (var size = 2; size <= n; size *= 2) {
        var half = size / 2;
        var step = n / size;
        for (m = 0; m < n; m += size) {
          for (p = m, q = 0; p < m + half; p++, q += step) {
            var l2 = p + half;
            var c = cosT[q];
            var s = inverse ? sinT[q] : -sinT[q];
            var tre = re[l2] * c - im[l2] * s;
            var tim = re[l2] * s + im[l2] * c;
            re[l2] = re[p] - tre; im[l2] = im[p] - tim;
            re[p] += tre;         im[p] += tim;
          }
        }
      }
      if (inverse) {
        for (l = 0; l < n; l++) { re[l] /= n; im[l] /= n; }
      }
    }
    return transform;
  }

  var fft = makeFFT(FFT_SIZE);

  var hann = new Float32Array(FFT_SIZE);
  for (var w = 0; w < FFT_SIZE; w++) {
    hann[w] = 0.5 - 0.5 * Math.cos(2 * Math.PI * w / FFT_SIZE);
  }

  /* --------------------------------------------------------- spectral gate */

  function denoiseChannel(input, opts, onProgress) {
    var n = input.length;
    var frames = Math.max(1, Math.ceil((n - FFT_SIZE) / HOP) + 1);
    var bins = FFT_SIZE / 2 + 1;

    // Pass 1: collect per-bin magnitudes so the noise floor can be estimated.
    var mags = new Float32Array(frames * bins);
    var re = new Float32Array(FFT_SIZE);
    var im = new Float32Array(FFT_SIZE);

    for (var f = 0; f < frames; f++) {
      var off = f * HOP;
      for (var i = 0; i < FFT_SIZE; i++) {
        var s = off + i < n ? input[off + i] : 0;
        re[i] = s * hann[i];
        im[i] = 0;
      }
      fft(re, im, false);
      for (var b = 0; b < bins; b++) {
        mags[f * bins + b] = Math.sqrt(re[b] * re[b] + im[b] * im[b]);
      }
      if (onProgress && (f & 31) === 0) onProgress((f / frames) * 45);
    }

    // Noise profile: a low percentile of each bin across time. Using a
    // percentile rather than the minimum makes it robust to one unusually quiet
    // frame, and rather than the mean makes it ignore the signal itself.
    var profile = new Float32Array(bins);
    var col = new Float32Array(frames);
    for (var b2 = 0; b2 < bins; b2++) {
      for (var f2 = 0; f2 < frames; f2++) col[f2] = mags[f2 * bins + b2];
      var sorted = Array.prototype.slice.call(col).sort(function (x, y) { return x - y; });
      profile[b2] = sorted[Math.floor(sorted.length * 0.20)] || 0;
    }

    // Pass 2: resynthesise, attenuating bins near the floor.
    var out = new Float32Array(n);
    var norm = new Float32Array(n);
    var threshold = Math.pow(10, opts.sensitivity / 20);   // dB above the profile
    var floorGain = Math.pow(10, -opts.reduction / 20);    // how far to pull them down

    for (var f3 = 0; f3 < frames; f3++) {
      var off3 = f3 * HOP;
      for (var i3 = 0; i3 < FFT_SIZE; i3++) {
        var s3 = off3 + i3 < n ? input[off3 + i3] : 0;
        re[i3] = s3 * hann[i3];
        im[i3] = 0;
      }
      fft(re, im, false);

      for (var b3 = 0; b3 < bins; b3++) {
        var mag = Math.sqrt(re[b3] * re[b3] + im[b3] * im[b3]);
        var limit = profile[b3] * threshold;
        var gain;
        if (mag <= limit) {
          gain = floorGain;
        } else {
          // Soft knee: ease between fully attenuated and untouched across the
          // range above the threshold. A hard gate produces the warbling
          // "underwater" artefact people associate with bad noise removal.
          // The knee is deliberately wide (up to 3x the threshold) because a
          // narrow one still flickers on noise bins sitting near the boundary.
          var over = mag / (limit + 1e-12);
          gain = over >= 3 ? 1 : floorGain + (1 - floorGain) * ((over - 1) / 2);
        }
        re[b3] *= gain; im[b3] *= gain;
        // Mirror into the negative frequencies to keep the signal real.
        if (b3 > 0 && b3 < FFT_SIZE / 2) {
          re[FFT_SIZE - b3] = re[b3];
          im[FFT_SIZE - b3] = -im[b3];
        }
      }

      fft(re, im, true);
      for (var i4 = 0; i4 < FFT_SIZE; i4++) {
        var pos = off3 + i4;
        if (pos >= n) break;
        out[pos] += re[i4] * hann[i4];
        norm[pos] += hann[i4] * hann[i4];
      }
      if (onProgress && (f3 & 31) === 0) onProgress(45 + (f3 / frames) * 45);
    }

    for (var p = 0; p < n; p++) {
      if (norm[p] > 1e-8) out[p] /= norm[p];
    }
    return out;
  }

  /*
   * The AI method: RNNoise (rnnoise-worker.js), a small recurrent network
   * trained to keep a voice and drop everything else, including the
   * irregular noise spectral gating cannot touch: keyboards, traffic, a dog,
   * a room full of people. It runs at 48 kHz, so each channel goes there and
   * back through the site's sinc resampler; the worker removes its 20 ms of
   * delay, so the result lines up with the original to the sample.
   * `mix` blends the cleaned voice with the original (the strength presets),
   * which keeps a little room sound and hides the network's artefacts.
   */
  function aiDenoise(buf, mix, onProgress) {
    var sr = buf.sampleRate, n = buf.length, chans = CV.channelsOf(buf);
    var up = sr === 48000 ? Promise.resolve(buf) : AudioSaw.resampleBuffer(buf, 48000);
    return up.then(function (b48) {
      var c48 = CV.channelsOf(b48).map(function (c) { return Float32Array.from(c); });
      return new Promise(function (resolve, reject) {
        var w = new Worker('/js/rnnoise-worker.js?v=' + ASSET_V, { type: 'module' });
        w.onmessage = function (e) {
          var m = e.data || {};
          if (m.type === 'progress') onProgress(8 + m.pct * 0.75, 'Removing noise (AI)…');
          else if (m.type === 'done') { w.terminate(); resolve(m.channels); }
          else if (m.type === 'error') { w.terminate(); reject(new Error(m.message)); }
        };
        w.onerror = function (e) { w.terminate(); reject(new Error('The AI denoiser could not start' + (e && e.message ? ' (' + e.message + ')' : ''))); };
        w.postMessage({ type: 'run', channels: c48 }, c48.map(function (c) { return c.buffer; }));
      });
    }).then(function (den48) {
      var back = sr === 48000 ? Promise.resolve(AudioSaw.makeBuffer(den48, 48000)) : AudioSaw.resampleBuffer(AudioSaw.makeBuffer(den48, 48000), sr);
      return back.then(function (b) {
        return CV.channelsOf(b).map(function (c, ch) {
          var o = new Float32Array(n), d = chans[ch];
          for (var i = 0; i < n; i++) o[i] = mix * (i < c.length ? c[i] : 0) + (1 - mix) * d[i];
          return o;
        });
      });
    });
  }

  function process(file, opts, onProgress) {
    onProgress(2, 'Decoding…');
    return AudioSaw.decodeToAudioBuffer(file).then(function (buf) {
      if (opts.method === 'ai') {
        return aiDenoise(buf, opts.mix, onProgress).then(function (outChans) {
          var b = CV.bufferFrom(outChans, buf.sampleRate);
          b.srcInfo = buf.srcInfo;
          onProgress(92, 'Encoding…');
          return CV.encodeBuffer(b, opts.fmt, opts.bitrate, function (pct) { onProgress(92 + pct * 0.08); });
        }).then(function (blob) {
          return { name: AudioSaw.rename(file.name, opts.fmt).replace(/\.([^.]+)$/, '-denoised.$1'), blob: blob };
        });
      }
      var chans = CV.channelsOf(buf);
      var outChans = [];
      for (var c = 0; c < chans.length; c++) {
        onProgress(5, chans.length > 1 ? 'Analysing channel ' + (c + 1) + '…' : 'Analysing noise floor…');
        /* eslint-disable no-loop-func */
        outChans.push(denoiseChannel(chans[c], opts, function (pct) {
          onProgress(5 + (c + pct / 100) / chans.length * 85, 'Removing noise…');
        }));
        /* eslint-enable no-loop-func */
      }
      var outBuf = CV.bufferFrom(outChans, buf.sampleRate);
      onProgress(92, 'Encoding…');
      return CV.encodeBuffer(outBuf, opts.fmt, opts.bitrate, function (pct) {
        onProgress(92 + pct * 0.08);
      }).then(function (blob) {
        return { name: AudioSaw.rename(file.name, opts.fmt).replace(/\.([^.]+)$/, '-denoised.$1'), blob: blob };
      });
    });
  }

  // The editor (/audio-editor) runs the same gate on a clip, so the effect there
  // sounds exactly like this page.
  window.ASDenoise = { channel: denoiseChannel };

  // Only drive a page that is actually the noise-reduction tool.
  if (!CV.$('#strength')) return;

  CV.shell({
    accept: null,
    video: true,   // same length out as in: a video comes back as a video
    zipName: 'audiosaw-denoised.zip',
    failMessage: 'Could not clean that file. ',
    readOpts: function () {
      var strength = CV.$('#strength').value;
      // Presets, because "sensitivity in dB above the noise floor" is not a
      // thing anyone wants to reason about.
      // Sensitivity is how far above the estimated noise floor a bin has to sit
      // before it is treated as signal. The profile is a low percentile, and
      // per-bin noise magnitudes are Rayleigh-distributed around it, so a small
      // margin leaves most noise bins above the threshold and barely reduces
      // anything — measured, 5 dB gave only 4.6 dB of actual reduction. These
      // values were tuned against a known-noise fixture.
      var map = {
        gentle: { sensitivity: 9, reduction: 10 },
        medium: { sensitivity: 13, reduction: 18 },
        strong: { sensitivity: 17, reduction: 26 }
      };
      var s = map[strength] || map.medium;
      return {
        method: CV.$('#method') ? CV.$('#method').value : 'spectral',
        // The AI method's strength is how much of the cleaned voice replaces
        // the original: gentle keeps some room sound.
        mix: { gentle: 0.7, medium: 0.9, strong: 1 }[strength] || 0.9,
        sensitivity: s.sensitivity,
        reduction: s.reduction,
        fmt: (CV.$('#outFmt').value || 'mp3').toLowerCase(),
        bitrate: CV.$('#bitrate').value
      };
    },
    process: process
  });
})();
