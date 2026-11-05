/*
 * ASInspect: what a decoded file really contains, as opposed to what its
 * header says. Behind /fake-lossless-detector and /audio-file-info.
 *
 * spectrum(): the long-term average spectrum, up to 400 Hann-windowed frames
 * spread evenly over the file (4096 points at 44.1/48 kHz, scaled with the
 * rate so a bin stays ~11 Hz), power-averaged over frames and channels and
 * gathered into ~86 Hz bands, in dB.
 *
 * cutoff(): where the content stops. Lossy encoders low-pass before they
 * encode, and the edge is a cliff: LAME and AAC drop 30 dB or more within a
 * few hundred hertz and leave nothing above. Real recordings fade into their
 * noise floor gradually, or stop at the converter's anti-alias filter just
 * under Nyquist (about 20-22 kHz at 44.1). From the top band down, a cliff
 * is the highest band whose level stands at least 25 dB over everything from
 * 300 Hz above it to Nyquist; the edge is where the slope crosses the middle
 * of that drop.
 *
 * verdict(): a cliff well under the CD band is the signature of a lossy
 * source; which encoder settings leave it where was measured with LAME and
 * ffmpeg's AAC on a full-band fixture (tools/check-inspect.js prints them).
 * A cliff near 20 kHz is shared by a 320 kbps MP3 and some studio filters,
 * so that is called "can't tell", never "fake".
 *
 * bitsUsed(): the depth the samples really use. A 24-bit file made from a
 * 16-bit one has its bottom 8 bits zero in every sample.
 *
 * stats(): peak, DC offset, clipped runs (3+ samples at full scale), and
 * whether two channels are the same (mono in stereo).
 *
 * UMD: runs in Node for the check and in the page.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./spectral.js'));
  else root.ASInspect = factory(root.ASSpectral);
})(typeof self !== 'undefined' ? self : this, function (Spectral) {
  'use strict';

  var BAND_HZ = 86;

  function spectrum(chans, rate, opts) {
    opts = opts || {};
    var N = 4096 * Math.max(1, Math.round(rate / 48000 + 0.01));
    var p2 = 1; while (p2 < N) p2 *= 2; N = p2;
    var n = chans[0].length, frames = Math.min(opts.frames || 400, Math.max(1, Math.floor((n - N) / (N / 2)) + 1));
    var fft = Spectral.makeFFT(N), win = new Float64Array(N), wsum = 0;
    for (var i = 0; i < N; i++) { win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N); wsum += win[i] * win[i]; }
    var bins = N / 2 + 1, acc = new Float64Array(bins), re = new Float64Array(N), im = new Float64Array(N), used = 0;
    var step = frames > 1 ? (n - N) / (frames - 1) : 0;
    for (var f = 0; f < frames; f++) {
      var o = Math.max(0, Math.round(f * step));
      for (var c = 0; c < chans.length; c++) {
        var x = chans[c];
        var e = 0;
        for (var j = 0; j < N; j++) { var v = o + j < n ? x[o + j] : 0; re[j] = v * win[j]; im[j] = 0; e += v * v; }
        if (e === 0) continue; // digital silence says nothing about the band
        fft.run(re, im, false);
        for (var k = 0; k < bins; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
        used++;
      }
    }
    var per = Math.max(1, Math.round(BAND_HZ / (rate / N))), nb = Math.floor(bins / per), db = new Float64Array(nb), hz = new Float64Array(nb);
    for (var b = 0; b < nb; b++) {
      var s = 0;
      for (var q = b * per; q < (b + 1) * per; q++) s += acc[q];
      // Power per bin relative to a full-scale sine (0 dBFS).
      var p = s / per / Math.max(1, used) / (wsum * wsum / (N * N)) / (N * N / 4);
      db[b] = 10 * Math.log10(p + 1e-30);
      hz[b] = (b + 0.5) * per * rate / N;
    }
    return { db: db, hz: hz, rate: rate, bandHz: per * rate / N, frames: used };
  }

  function cutoff(sp) {
    var db = sp.db, hz = sp.hz, nb = db.length, gap = Math.max(1, Math.round(300 / sp.bandHz));
    // Highest level from band i to the top, for each i.
    var maxAbove = new Float64Array(nb + 1); maxAbove[nb] = -Infinity;
    for (var i = nb - 1; i >= 0; i--) maxAbove[i] = Math.max(maxAbove[i + 1], db[i]);
    // Ignore the last ~2% under Nyquist: some decoders roll off there.
    var top = Math.floor(nb * 0.985);
    var floor = sorted(db.subarray(Math.floor(nb * 0.1)))[0];
    for (var b = top - gap - 1; b > nb * 0.1; b--) {
      var above = maxAbove[Math.min(top, b + gap)];
      if (b + gap >= top) above = Math.max(above, floor);
      var drop = db[b] - above;
      if (drop >= 25 && db[b] - floor >= 25) {
        // The edge: where the level crosses halfway down the drop.
        var mid = (db[b] + above) / 2, e = b;
        while (e < nb - 1 && db[e + 1] > mid) e++;
        var f = hz[e] + sp.bandHz * (db[e] - mid) / Math.max(1e-9, db[e] - db[Math.min(nb - 1, e + 1)]);
        // A resampler's filter rolls off over a couple of kilohertz before
        // the cliff at its bottom: walk back up the slope to where it
        // flattens and call that the edge. An encoder's slope is a few
        // hundred hertz (LAME's is 4-5 bands), so only one over ~900 Hz
        // counts; the encoders keep the midpoint the signatures were
        // measured on.
        var k = b;
        while (k > 1 && db[k - 1] - db[k] > 1.5) k--;
        if (b - k >= 10) return { hz: hz[k], drop: db[k] - above, sharp: true, band: k, gradual: true };
        return { hz: f, drop: drop, sharp: true, band: e };
      }
    }
    // No cliff: the content (or its noise) goes up to the highest band over
    // -120 dB, which is under a 16-bit file's dither in every band.
    for (var t = nb - 1; t >= 0; t--) if (db[t] > -120) return { hz: t >= top - 1 ? sp.rate / 2 : hz[t], drop: 0, sharp: false, band: t, full: t >= top - 1 };
    return { hz: 0, drop: 0, sharp: false, band: 0 };
  }

  function sorted(a) { return Array.prototype.slice.call(a).sort(function (x, y) { return x - y; }); }

  // Where each encoder leaves its edge, measured by encoding the check's
  // full-band fixture at 44.1 kHz with LAME (through ffmpeg 9) and ffmpeg's
  // AAC: 96 kbps 15.5 kHz, 128 kbps 16.9, 160 kbps 17.5, 192 kbps 18.9, V2
  // 19.0, 256 kbps 19.6, 320 kbps 20.3; AAC 128 kbps 17.3. LAME V0 and AAC
  // 256 kept the whole band and leave no edge to find. Older encoders
  // (Fraunhofer, early iTunes) cut lower for the same bitrate, so these name
  // the likeliest source, not the only one.
  var SIGNATURES = [
    { lo: 0, hi: 15000, like: 'an MP3 or AAC under 96 kbps' },
    { lo: 15000, hi: 16200, like: 'a 96 kbps MP3, or an older encoder at 128' },
    { lo: 16200, hi: 17200, like: 'a 128 kbps MP3' },
    { lo: 17200, hi: 18200, like: 'a 160 kbps MP3 or a 128 kbps AAC' },
    { lo: 18200, hi: 19300, like: 'a 192 kbps or V2 MP3' },
    { lo: 19300, hi: 19900, like: 'a 256 kbps MP3' }
  ];

  // info: the header (AudioSaw.sniffFormat), sp/cut from above, bits from
  // bitsUsed(). Returns { grade: 'genuine' | 'unclear' | 'lossy-source' |
  // 'upsampled' | 'padded', title, detail }.
  function verdict(info, sp, cut, bits) {
    info = info || {};
    var rate = sp.rate, nyq = rate / 2, lossless = info.lossless !== false;
    var name = lossless ? (info.container ? String(info.container).toUpperCase() : 'This file') : 'This file';
    var kHz = function (f) { return (f / 1000).toFixed(1) + ' kHz'; };
    var out = [];
    if (bits && bits.declared && bits.used < bits.declared) {
      out.push({ grade: 'padded', title: 'Padded: ' + bits.used + '-bit audio in a ' + bits.declared + '-bit file',
        detail: 'Every sample has its bottom ' + (bits.declared - bits.used) + ' bits at zero. The extra depth was added after the fact and holds nothing.' });
    }
    if (cut.sharp && rate > 50000 && cut.hz < 24500) {
      out.push({ grade: 'upsampled', title: 'Upsampled: nothing above ' + kHz(cut.hz) + ' in a ' + (rate / 1000) + ' kHz file',
        detail: 'A real ' + (rate / 1000) + ' kHz recording has content or noise up to ' + kHz(nyq) + '. This one stops at a sharp edge at ' + kHz(cut.hz) + ', the mark of a 44.1 or 48 kHz source' + (cut.hz < 19900 ? ' that was itself a lossy file' : '') + '.' });
    } else if (cut.sharp && cut.hz < 19900) {
      var sig = SIGNATURES.filter(function (s) { return cut.hz >= s.lo && cut.hz < s.hi; })[0];
      out.push({ grade: 'lossy-source', title: (lossless ? 'Transcoded: ' : 'Upscaled: ') + 'a sharp cutoff at ' + kHz(cut.hz),
        detail: 'The content stops dead at ' + kHz(cut.hz) + ', ' + Math.round(cut.drop) + ' dB down within a few hundred hertz, with nothing above. That is how a lossy encoder leaves a file, most like ' + (sig ? sig.like : 'a lossy source') + '. ' +
          (lossless ? 'Converting it to ' + name + ' does not bring the lost top end back.' : 'Its own bitrate is higher than the file it was made from.') +
          ' (A recording made at a lower sample rate, such as 32 kHz, can leave a similar edge.)' });
    } else if (cut.sharp && cut.hz < 20600) {
      out.push({ grade: 'unclear', title: 'Can\'t tell: an edge at ' + kHz(cut.hz),
        detail: 'A sharp edge near 20 kHz is what a 320 kbps MP3 leaves, and also what some studio and mastering filters leave. Nothing below it is missing.' });
    } else {
      out.push({ grade: 'genuine', title: cut.sharp ? 'No sign of a lossy source' : cut.full ? 'No sign of a lossy source: content all the way to ' + kHz(nyq) : 'No sign of a lossy source: the content fades out naturally',
        detail: cut.sharp ? 'The content runs to ' + kHz(cut.hz) + ', where a converter\'s anti-alias filter normally sits, just under ' + kHz(nyq) + '.'
          : cut.full ? 'There is no cliff anywhere: the content, or its noise, carries on all the way to ' + kHz(nyq) + '.'
          : 'There is no cliff: the sound fades away gradually by ' + kHz(cut.hz) + ', the way a real recording does.' });
      out[out.length - 1].detail += ' A V0 MP3 or a 256 kbps AAC can also keep the whole band, so a clean result rules out the low-bitrate files most fakes come from, not every lossy one.';
    }
    return out;
  }

  // The depth actually used: the lowest set bit across every sample. Chrome
  // decodes 16-bit PCM as positive / 32767 and negative / 32768 (24-bit and
  // other browsers divide by 2^(n-1) both ways), so a positive sample is
  // tried on both grids. Float32 cannot hold n / 32767 exactly, hence the
  // tolerance.
  function bitsUsed(chans, declared) {
    if (!declared || declared > 24) return null;
    var scale = Math.pow(2, declared - 1), lowest = declared, nonzero = false, tol = declared <= 16 ? 0.01 : 0.001;
    for (var c = 0; c < chans.length; c++) {
      var x = chans[c];
      for (var i = 0; i < x.length; i++) {
        var v = x[i];
        if (v === 0) continue;
        nonzero = true;
        var q = Math.round(v * scale);
        if (Math.abs(v * scale - q) > tol) {
          if (v > 0 && Math.abs(v * (scale - 1) - Math.round(v * (scale - 1))) <= tol) q = Math.round(v * (scale - 1));
          else return { declared: declared, used: declared, offGrid: true };
        }
        var z = 0; while (z < lowest && (q & (1 << z)) === 0) z++;
        if (z < lowest) lowest = z;
        if (lowest === 0) return { declared: declared, used: declared };
      }
    }
    return nonzero ? { declared: declared, used: declared - lowest } : { declared: declared, used: 0 };
  }

  // MP3 details the header-sniffer does not give: CBR or VBR (the Xing/Info
  // frame), the encoder string LAME writes, the first frame's bitrate and
  // channel mode. bytes: the start of the file (64 kB is plenty).
  function mp3Info(u) {
    var o = 0;
    if (u[0] === 0x49 && u[1] === 0x44 && u[2] === 0x33) o = 10 + ((u[6] & 0x7f) << 21 | (u[7] & 0x7f) << 14 | (u[8] & 0x7f) << 7 | (u[9] & 0x7f));
    while (o + 4 < u.length && !(u[o] === 0xFF && (u[o + 1] & 0xE0) === 0xE0 && (u[o + 2] & 0xF0) !== 0xF0)) o++;
    if (o + 4 >= u.length) return null;
    var ver = (u[o + 1] >> 3) & 3, layer = (u[o + 1] >> 1) & 3, bi = u[o + 2] >> 4, mode = u[o + 3] >> 6;
    if (layer !== 1) return null; // layer III only
    var V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    var kbps = (ver === 3 ? V1 : V2)[bi] || 0;
    var side = ver === 3 ? (mode === 3 ? 17 : 32) : (mode === 3 ? 9 : 17), t = o + 4 + side;
    var tag = String.fromCharCode(u[t], u[t + 1], u[t + 2], u[t + 3]), vbr = null, encoder = null;
    if (tag === 'Xing' || tag === 'Info') {
      vbr = tag === 'Xing';
      // The LAME tag sits 120 bytes into the Xing frame when present.
      for (var k = t + 8; k < Math.min(u.length - 9, t + 200); k++) {
        var w = String.fromCharCode(u[k], u[k + 1], u[k + 2], u[k + 3]);
        // LAME writes "LAME3.100"; LAME inside ffmpeg writes "Lavc61.19".
        if (w === 'LAME' || w === 'Lavc' || w === 'Lavf' || w === 'GOGO') {
          encoder = String.fromCharCode.apply(null, u.subarray(k, k + 9)).replace(/[^\x20-\x7e]/g, '').trim();
          encoder = encoder.replace(/[^0-9a-z]+$/i, '');
          if (w !== 'LAME' && w !== 'GOGO') encoder = 'LAME (via ffmpeg ' + encoder + ')';
          break;
        }
      }
    } else if (String.fromCharCode(u[o + 36], u[o + 37], u[o + 38], u[o + 39]) === 'VBRI') { vbr = true; encoder = 'Fraunhofer (VBRI)'; }
    return { kbps: kbps, mode: ['stereo', 'joint stereo', 'dual channel', 'mono'][mode], vbr: vbr, encoder: encoder };
  }

  function stats(chans, rate) {
    var peak = 0, clips = 0, clipped = 0, dc = [], same = chans.length > 1, maxDiff = 0;
    chans.forEach(function (x, ci) {
      var s = 0, run = 0;
      for (var i = 0; i < x.length; i++) {
        var a = Math.abs(x[i]);
        if (a > peak) peak = a;
        s += x[i];
        if (a >= 0.99997) run++;
        else { if (run >= 3) { clips++; clipped += run; } run = 0; }
        if (ci > 0) { var d = Math.abs(x[i] - chans[0][i]); if (d > maxDiff) maxDiff = d; }
      }
      if (run >= 3) { clips++; clipped += run; }
      dc.push(s / Math.max(1, x.length));
    });
    return { peak: peak, clips: clips, clippedSamples: clipped, dc: dc, monoInStereo: same && maxDiff < 1e-6, channelDiff: maxDiff };
  }

  // Silence at each end (below -60 dBFS), in seconds.
  function edges(chans, rate) {
    var n = chans[0].length, thr = 0.001, a = 0, b = n;
    function loud(i) { for (var c = 0; c < chans.length; c++) if (Math.abs(chans[c][i]) > thr) return true; return false; }
    while (a < n && !loud(a)) a++;
    while (b > a && !loud(b - 1)) b--;
    return { lead: a / rate, tail: (n - b) / rate };
  }

  return { spectrum: spectrum, cutoff: cutoff, verdict: verdict, bitsUsed: bitsUsed, mp3Info: mp3Info, stats: stats, edges: edges, SIGNATURES: SIGNATURES };
});
