/*
 * STFT/iSTFT for the separation model.
 *
 * The MDX-Net models take a spectrogram computed with n_fft = 6144, which is
 * 3 x 2048 — not a power of two, so a plain radix-2 FFT cannot do it. Rather
 * than fall back on Bluestein (correct but roughly eight times the work), this
 * decimates by three and combines the three 2048-point radix-2 transforms with
 * a radix-3 butterfly. Same result, a fraction of the cost.
 *
 * The transform has to match torch.stft(center=True, window=hann(periodic),
 * onesided=True, normalized=False) exactly, because the model was trained on
 * that. Off-by-one in the padding or the wrong window flavour produces
 * plausible-looking output that separates badly, which is the worst kind of
 * bug — so this file is validated against a numpy reference.
 */
(function (global) {
  'use strict';

  /* ------------------------------------------------------- radix-2 kernel */

  function makeRadix2(n) {
    var levels = Math.round(Math.log2(n));
    if ((1 << levels) !== n) throw new Error('radix-2 needs a power of two, got ' + n);
    var cos = new Float64Array(n / 2);
    var sin = new Float64Array(n / 2);
    for (var i = 0; i < n / 2; i++) {
      cos[i] = Math.cos(2 * Math.PI * i / n);
      sin[i] = Math.sin(2 * Math.PI * i / n);
    }
    var rev = new Uint32Array(n);
    for (var j = 0; j < n; j++) {
      var x = j, r = 0;
      for (var b = 0; b < levels; b++) { r = (r << 1) | (x & 1); x >>= 1; }
      rev[j] = r;
    }
    return function (re, im, inverse) {
      var i, j2;
      for (i = 0; i < n; i++) {
        var ri = rev[i];
        if (ri > i) {
          var tr = re[i]; re[i] = re[ri]; re[ri] = tr;
          var ti = im[i]; im[i] = im[ri]; im[ri] = ti;
        }
      }
      for (var size = 2; size <= n; size *= 2) {
        var half = size / 2, step = n / size;
        for (var m = 0; m < n; m += size) {
          for (var p = m, q = 0; p < m + half; p++, q += step) {
            var l = p + half;
            var c = cos[q];
            var s = inverse ? sin[q] : -sin[q];
            var xr = re[l] * c - im[l] * s;
            var xi = re[l] * s + im[l] * c;
            re[l] = re[p] - xr; im[l] = im[p] - xi;
            re[p] += xr;        im[p] += xi;
          }
        }
      }
      if (inverse) for (j2 = 0; j2 < n; j2++) { re[j2] /= n; im[j2] /= n; }
    };
  }

  /* ------------------------------------- radix-3 wrapper for n = 3 * 2^k */

  function makeFFT(n) {
    if ((n & (n - 1)) === 0) {
      var r2 = makeRadix2(n);
      return { n: n, run: r2 };
    }
    if (n % 3 !== 0) throw new Error('unsupported FFT size ' + n);
    var m = n / 3;
    if ((m & (m - 1)) !== 0) throw new Error('unsupported FFT size ' + n);
    var sub = makeRadix2(m);

    // Twiddles w^k and w^2k for k < m, with w = exp(-2*pi*i/n).
    var w1r = new Float64Array(m), w1i = new Float64Array(m);
    var w2r = new Float64Array(m), w2i = new Float64Array(m);
    for (var k = 0; k < m; k++) {
      var a = -2 * Math.PI * k / n;
      w1r[k] = Math.cos(a);      w1i[k] = Math.sin(a);
      w2r[k] = Math.cos(2 * a);  w2i[k] = Math.sin(2 * a);
    }
    // Primitive cube root of unity, exp(-2*pi*i/3).
    var ur = -0.5, ui = -Math.sqrt(3) / 2;

    var ar = new Float64Array(m), ai = new Float64Array(m);
    var br = new Float64Array(m), bi = new Float64Array(m);
    var cr = new Float64Array(m), ci = new Float64Array(m);

    function run(re, im, inverse) {
      var i, k2;
      // Decimate in time by three.
      for (i = 0; i < m; i++) {
        ar[i] = re[3 * i];     ai[i] = im[3 * i];
        br[i] = re[3 * i + 1]; bi[i] = im[3 * i + 1];
        cr[i] = re[3 * i + 2]; ci[i] = im[3 * i + 2];
      }
      sub(ar, ai, inverse);
      sub(br, bi, inverse);
      sub(cr, ci, inverse);

      // The tables already hold exp(-2*pi*i*k/n), i.e. the forward twiddle, so
      // the forward pass uses them as-is and only the inverse conjugates.
      var s = inverse ? -1 : 1;
      var uir = ui * s;
      for (k2 = 0; k2 < m; k2++) {
        var t1r = w1r[k2], t1i = w1i[k2] * s;
        var t2r = w2r[k2], t2i = w2i[k2] * s;

        var Br = br[k2] * t1r - bi[k2] * t1i;
        var Bi = br[k2] * t1i + bi[k2] * t1r;
        var Cr = cr[k2] * t2r - ci[k2] * t2i;
        var Ci = cr[k2] * t2i + ci[k2] * t2r;

        // u * B and u^2 * C, then the three outputs.
        var uBr = ur * Br - uir * Bi, uBi = ur * Bi + uir * Br;
        var uCr = ur * Cr - uir * Ci, uCi = ur * Ci + uir * Cr;
        var u2Br = ur * uBr - uir * uBi, u2Bi = ur * uBi + uir * uBr;
        var u2Cr = ur * uCr - uir * uCi, u2Ci = ur * uCi + uir * uCr;

        re[k2]           = ar[k2] + Br + Cr;
        im[k2]           = ai[k2] + Bi + Ci;
        re[k2 + m]       = ar[k2] + uBr + u2Cr;
        im[k2 + m]       = ai[k2] + uBi + u2Ci;
        re[k2 + 2 * m]   = ar[k2] + u2Br + uCr;
        im[k2 + 2 * m]   = ai[k2] + u2Bi + uCi;
      }
      // The sub-transforms already divided by m; finish the 1/n scaling.
      if (inverse) for (i = 0; i < n; i++) { re[i] /= 3; im[i] /= 3; }
    }
    return { n: n, run: run };
  }

  /* ------------------------------------------------------------ windowing */

  // torch.hann_window(periodic=True): denominator is N, not N-1.
  function hannPeriodic(n) {
    var w = new Float64Array(n);
    for (var i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
    return w;
  }

  /* ----------------------------------------------------------------- STFT */

  function Spectral(nFft, hop) {
    this.nFft = nFft;
    this.hop = hop;
    this.bins = nFft / 2 + 1;
    this.fft = makeFFT(nFft);
    this.win = hannPeriodic(nFft);
    this._re = new Float64Array(nFft);
    this._im = new Float64Array(nFft);
  }

  // center=True pads by nFft/2 each side, reflecting about the edge samples.
  Spectral.prototype.padReflect = function (x) {
    var p = this.nFft >> 1;
    var out = new Float64Array(x.length + 2 * p);
    out.set(x, p);
    for (var i = 0; i < p; i++) {
      out[p - 1 - i] = x[Math.min(i + 1, x.length - 1)];
      out[p + x.length + i] = x[Math.max(x.length - 2 - i, 0)];
    }
    return out;
  };

  // Returns interleaved [frame][bin] real and imag in two flat arrays.
  Spectral.prototype.forward = function (signal, frames) {
    var padded = this.padReflect(signal);
    var bins = this.bins, nFft = this.nFft, hop = this.hop;
    var re = new Float32Array(frames * bins);
    var im = new Float32Array(frames * bins);
    for (var f = 0; f < frames; f++) {
      var off = f * hop;
      for (var i = 0; i < nFft; i++) {
        this._re[i] = (off + i < padded.length ? padded[off + i] : 0) * this.win[i];
        this._im[i] = 0;
      }
      this.fft.run(this._re, this._im, false);
      var base = f * bins;
      for (var b = 0; b < bins; b++) {
        re[base + b] = this._re[b];
        im[base + b] = this._im[b];
      }
    }
    return { re: re, im: im, frames: frames, bins: bins };
  };

  // Inverse with the standard weighted overlap-add normalisation, matching
  // torch.istft(center=True).
  Spectral.prototype.inverse = function (re, im, frames, outLength) {
    var bins = this.bins, nFft = this.nFft, hop = this.hop;
    var p = nFft >> 1;
    var full = outLength + 2 * p;
    var acc = new Float64Array(full);
    var wsum = new Float64Array(full);

    for (var f = 0; f < frames; f++) {
      var base = f * bins;
      // Rebuild the full spectrum from the half we carry (Hermitian symmetry).
      for (var b = 0; b < bins; b++) {
        this._re[b] = re[base + b];
        this._im[b] = im[base + b];
      }
      for (var b2 = 1; b2 < nFft - bins + 1; b2++) {
        this._re[nFft - b2] = re[base + b2];
        this._im[nFft - b2] = -im[base + b2];
      }
      this.fft.run(this._re, this._im, true);

      var off = f * hop;
      for (var i = 0; i < nFft; i++) {
        if (off + i >= full) break;
        acc[off + i] += this._re[i] * this.win[i];
        wsum[off + i] += this.win[i] * this.win[i];
      }
    }

    var out = new Float32Array(outLength);
    for (var j = 0; j < outLength; j++) {
      var w = wsum[j + p];
      out[j] = w > 1e-9 ? acc[j + p] / w : 0;
    }
    return out;
  };

  /* ------------------------------------------- two channels, one transform */

  // Both channels go through a single complex FFT per frame by packing left in
  // the real part and right in the imaginary part, then untangling the two
  // spectra with Hermitian symmetry. Exactly the same numbers as transforming
  // them separately, for half the transforms — and the transforms are the
  // bottleneck in this pipeline, not the model.
  Spectral.prototype.forwardPair = function (left, right, frames) {
    var padL = this.padReflect(left);
    var padR = this.padReflect(right);
    var bins = this.bins, nFft = this.nFft, hop = this.hop;
    var lr = new Float32Array(frames * bins), li = new Float32Array(frames * bins);
    var rr = new Float32Array(frames * bins), ri = new Float32Array(frames * bins);

    for (var f = 0; f < frames; f++) {
      var off = f * hop;
      for (var i = 0; i < nFft; i++) {
        this._re[i] = (off + i < padL.length ? padL[off + i] : 0) * this.win[i];
        this._im[i] = (off + i < padR.length ? padR[off + i] : 0) * this.win[i];
      }
      this.fft.run(this._re, this._im, false);

      var base = f * bins;
      for (var k = 0; k < bins; k++) {
        var j = (nFft - k) % nFft;
        var ar = this._re[k], ai = this._im[k];
        var br = this._re[j], bi = this._im[j];
        // L = (Z[k] + conj(Z[N-k])) / 2
        lr[base + k] = (ar + br) * 0.5;
        li[base + k] = (ai - bi) * 0.5;
        // R = (Z[k] - conj(Z[N-k])) / 2i
        rr[base + k] = (ai + bi) * 0.5;
        ri[base + k] = (br - ar) * 0.5;
      }
    }
    return { lr: lr, li: li, rr: rr, ri: ri, frames: frames, bins: bins };
  };

  // The mirror image: pack the two output spectra into one inverse transform
  // and read the channels back out of the real and imaginary parts.
  Spectral.prototype.inversePair = function (lr, li, rr, ri, frames, outLength) {
    var bins = this.bins, nFft = this.nFft, hop = this.hop;
    var p = nFft >> 1;
    var full = outLength + 2 * p;
    var accL = new Float64Array(full), accR = new Float64Array(full);
    var wsum = new Float64Array(full);

    for (var f = 0; f < frames; f++) {
      var base = f * bins;
      for (var k = 0; k < nFft; k++) { this._re[k] = 0; this._im[k] = 0; }
      for (var b = 0; b < bins; b++) {
        // Z = L + i*R, so that one inverse transform yields both channels.
        var Lr = lr[base + b], Li = li[base + b];
        var Rr = rr[base + b], Ri = ri[base + b];
        this._re[b] = Lr - Ri;
        this._im[b] = Li + Rr;
      }
      // Fill the negative frequencies so each channel stays real after the
      // inverse: conj-symmetric for L, and likewise for R in the imaginary part.
      for (var b2 = 1; b2 < nFft - bins + 1; b2++) {
        var Lr2 = lr[base + b2], Li2 = li[base + b2];
        var Rr2 = rr[base + b2], Ri2 = ri[base + b2];
        this._re[nFft - b2] = Lr2 + Ri2;
        this._im[nFft - b2] = -Li2 + Rr2;
      }
      this.fft.run(this._re, this._im, true);

      var off = f * hop;
      for (var i = 0; i < nFft; i++) {
        if (off + i >= full) break;
        accL[off + i] += this._re[i] * this.win[i];
        accR[off + i] += this._im[i] * this.win[i];
        wsum[off + i] += this.win[i] * this.win[i];
      }
    }

    var outL = new Float32Array(outLength), outR = new Float32Array(outLength);
    for (var j = 0; j < outLength; j++) {
      var w = wsum[j + p];
      if (w > 1e-9) { outL[j] = accL[j + p] / w; outR[j] = accR[j + p] / w; }
    }
    return [outL, outR];
  };

  var api = { makeFFT: makeFFT, hannPeriodic: hannPeriodic, Spectral: Spectral };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else global.ASSpectral = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
