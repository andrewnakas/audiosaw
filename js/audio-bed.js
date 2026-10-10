/*
 * ASBed: a music or voice-over track laid under (or over) a video's own sound,
 * for /add-audio-to-video. Pure arrays in, arrays out (UMD), so
 * tools/check-add-audio-video.js runs it in Node.
 *
 *   ASBed.mix({
 *     rate, length,                 // the output: the video's length in frames
 *     orig: [L, R] | null,          // the video's own sound at `rate`, or none
 *     music: [L, R],                // the new track, already at `rate`
 *     mode: 'replace' | 'mix' | 'duck',
 *     origDb, musicDb,              // levels, dB (0 = as is)
 *     duckDb,                       // how far the music drops under speech (duck)
 *     offset,                       // seconds into the video the music starts
 *     skip,                         // seconds into the music it starts from
 *     loop, fadeOut                 // repeat a short track; fade at the end (s)
 *   }) -> { channels: [L, R], ducked: fraction of the video with music ducked }
 *
 * Ducking follows the speech band of the original (two 2nd-order filters,
 * 250 Hz-3.5 kHz), in 10 ms frames. A frame is speech when it is 10 dB over
 * the file's own floor (10th percentile) and within 30 dB of its loud frames
 * (95th), the same reasoning as silence-gaps.js: an absolute dBFS threshold
 * is wrong by tens of dB between a booth and a street. 150 ms of hold bridges
 * the gaps between words, the gain falls in 60 ms and recovers over 450 ms.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ASBed = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FRAME_S = 0.01, HOLD_S = 0.15, ATTACK_S = 0.06, RELEASE_S = 0.45;
  var XFADE_S = 1.5;       // where a looped track meets its own start
  var EDGE_S = 0.02;       // a fade-in where the music begins, against a click

  function db(x) { return Math.pow(10, x / 20); }

  // RBJ biquad, applied in place on a copy.
  function biquad(x, rate, type, f0, q) {
    var w = 2 * Math.PI * f0 / rate, cs = Math.cos(w), al = Math.sin(w) / (2 * q);
    var b0, b1, b2, a0 = 1 + al, a1 = -2 * cs, a2 = 1 - al;
    if (type === 'hp') { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = (1 + cs) / 2; }
    else { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = (1 - cs) / 2; }
    var y = new Float32Array(x.length), x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (var i = 0; i < x.length; i++) {
      var v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
    }
    return y;
  }

  function pct(sorted, p) { return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]; }

  // Per-frame speech activity of the original: Uint8Array, 1 = speech.
  function speechFrames(orig, rate) {
    var n = orig[0].length, mono = new Float32Array(n);
    for (var c = 0; c < orig.length; c++) for (var i = 0; i < n; i++) mono[i] += orig[c][i] / orig.length;
    var band = biquad(biquad(mono, rate, 'hp', 250, 0.707), rate, 'lp', 3500, 0.707);
    var F = Math.max(1, Math.round(FRAME_S * rate)), nf = Math.ceil(n / F);
    var lev = new Float32Array(nf);
    for (var f = 0; f < nf; f++) {
      var s = 0, e = Math.min(n, (f + 1) * F);
      for (var j = f * F; j < e; j++) s += band[j] * band[j];
      lev[f] = 10 * Math.log10(s / Math.max(1, e - f * F) + 1e-12);
    }
    var sorted = Array.prototype.slice.call(lev).sort(function (a, b) { return a - b; });
    var floor = pct(sorted, 0.1), loud = pct(sorted, 0.95);
    var thr = Math.max(floor + 10, loud - 30, -70);
    var act = new Uint8Array(nf), hold = Math.round(HOLD_S / FRAME_S), last = -1e9;
    for (var k = 0; k < nf; k++) {
      if (lev[k] > thr) last = k;
      act[k] = k - last <= hold ? 1 : 0;
    }
    return { act: act, frame: F };
  }

  // The music's samples laid along the output, with offset, skip, loop and
  // the crossfade at each loop seam. Returns channel arrays of `length`.
  function lay(music, rate, length, offset, skip, loop) {
    var nch = music.length, src = music[0].length;
    var start = Math.max(0, Math.round(offset * rate));
    var from = Math.min(src, Math.max(0, Math.round(skip * rate)));
    var body = src - from;
    var out = [];
    for (var c = 0; c < nch; c++) out.push(new Float32Array(length));
    if (body <= 0) return out;
    var X = loop ? Math.min(Math.round(XFADE_S * rate), Math.floor(body / 4)) : 0;
    var period = body - X;              // each repeat starts X before the last one ends
    var edge = Math.round(EDGE_S * rate);
    for (var c2 = 0; c2 < nch; c2++) {
      var m = music[c2], o = out[c2];
      for (var t = start, rep = 0; t < length; rep++) {
        for (var i = 0; i < body && t + i < length; i++) {
          var g = 1;
          if (rep === 0 && i < edge) g = i / edge;
          if (loop && rep > 0 && i < X) g = Math.sin(0.5 * Math.PI * i / X);          // fade in over the seam
          if (loop && i >= period) g *= Math.cos(0.5 * Math.PI * (i - period) / X);   // fade out under the next
          o[t + i] += m[from + i] * g;
        }
        if (!loop) break;
        t += period;
      }
    }
    return out;
  }

  function mix(o) {
    var rate = o.rate, length = o.length;
    var mode = o.orig ? (o.mode || 'duck') : 'replace';
    var lay2 = lay(o.music, rate, length, o.offset || 0, o.skip || 0, !!o.loop);
    if (lay2.length === 1) lay2.push(lay2[0]);
    var mg = db(o.musicDb || 0);

    // Gain curve on the music: ducking and the fade at the end.
    var gain = new Float32Array(length).fill(1), duckedFrames = 0, nfr = 1;
    if (mode === 'duck') {
      var sp = speechFrames(o.orig, rate), act = sp.act, F = sp.frame;
      nfr = act.length;
      var low = db(-(Math.abs(o.duckDb == null ? 12 : o.duckDb)));
      var down = 1 / Math.max(1, ATTACK_S * rate), up = 1 / Math.max(1, RELEASE_S * rate);
      var g = act[0] ? low : 1;
      for (var i = 0; i < length; i++) {
        var target = act[Math.min(act.length - 1, Math.floor(i / F))] ? low : 1;
        // Linear in dB-ish terms is overkill here: a straight ramp per sample
        // in the linear domain, fast down and slow up.
        if (g > target) g = Math.max(target, g - down * (1 - low));
        else if (g < target) g = Math.min(target, g + up * (1 - low));
        gain[i] = g;
      }
      for (var k = 0; k < act.length; k++) duckedFrames += act[k];
    }
    var fade = Math.round((o.fadeOut || 0) * rate);
    if (fade > 0) for (var j = Math.max(0, length - fade); j < length; j++) gain[j] *= (length - j) / fade;

    var og = mode === 'replace' ? 0 : db(o.origDb || 0);
    var out = [new Float32Array(length), new Float32Array(length)];
    for (var c = 0; c < 2; c++) {
      var oc = o.orig ? o.orig[Math.min(c, o.orig.length - 1)] : null;
      var mc = lay2[c], dst = out[c];
      for (var n = 0; n < length; n++) {
        var v = mc[n] * mg * gain[n];
        if (oc && og && n < oc.length) v += oc[n] * og;
        dst[n] = v;
      }
    }
    return { channels: out, ducked: mode === 'duck' ? duckedFrames / nfr : 0 };
  }

  return { mix: mix, speechFrames: speechFrames, lay: lay, XFADE_S: XFADE_S };
});
