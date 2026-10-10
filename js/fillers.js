/*
 * ASFillers: find the "um"s and "uh"s in a recording and cut them out, for
 * /remove-filler-words. UMD, so tools/check-fillers.js runs it in Node.
 *
 *   ASFillers.find(words, mono, rate, opts) -> [{ text, start, end, kind, on }]
 *   ASFillers.pauses(words, mono, rate, opts) -> [{ start, end, kind: 'pause', on }]
 *   ASFillers.cut(channels, rate, cuts) -> { channels, removed }
 *
 * `words` come from the timestamped Whisper base (transcribe-worker.js with
 * words: true). Measured on `say` voices with fillers at known places (the
 * spike of 10 Oct 2026, kept as check-fillers): Whisper writes most fillers
 * as words ("um", "uh", "ah") with starts within ~0.1 s, sometimes mishears
 * one ("bum"), and occasionally folds one into the word before it.
 *
 * Two kinds of find:
 *   'filler' - a word on the filler list. Ticked by default.
 *   'maybe'  - a short word set apart by pauses or commas whose pitch holds
 *              flat, the sound of a held "mmm" or "uhhh" that Whisper heard as
 *              a word. Shown, not ticked: "so," and "well," can sound the
 *              same, and cutting a real word is the worse mistake.
 *
 * Word times are only a guide to where a filler is; where the cut goes is
 * decided on the audio. Word ends run early (an "um" read as ending at
 * 1.38 s ran to 1.54), so a cut ends where the filler's sound has died away,
 * found on 10 ms frames against a threshold 9 dB over the file's own floor
 * (the silence-gaps.js rule). The pause left across a cut is held to what a
 * speaker would leave, so removing an "um" does not leave a hole.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { require('./pitch-track.js'); module.exports = factory(globalThis.ASPitch); }
  else root.ASFillers = factory(root.ASPitch);
})(typeof self !== 'undefined' ? self : this, function (ASPitch) {
  'use strict';

  var FILLER = /^(u+h*m+|u+h+|a+h+|e+r+m*|e+h+|h+m+|m+h*m+|h+u+h+)$/;
  var FRAME = 0.01;
  var JOIN_PAUSE = 0.25;     // the most silence left where a filler was
  var XFADE = 0.01;

  function clean(t) { return String(t || '').toLowerCase().replace(/[^a-z']/g, ''); }

  // One pass per file: find, span and pauses all read the same levels.
  var memo = { mono: null, rate: 0, L: null };
  function levels(mono, rate) {
    if (memo.mono === mono && memo.rate === rate) return memo.L;
    memo.L = levelsOf(mono, rate); memo.mono = mono; memo.rate = rate;
    return memo.L;
  }
  function levelsOf(mono, rate) {
    var F = Math.max(1, Math.round(FRAME * rate)), n = Math.floor(mono.length / F);
    var lv = new Float32Array(n);
    for (var f = 0; f < n; f++) {
      var s = 0;
      for (var i = f * F; i < (f + 1) * F; i++) s += mono[i] * mono[i];
      lv[f] = Math.sqrt(s / F);
    }
    var sorted = Array.prototype.slice.call(lv).sort(function (a, b) { return a - b; });
    var floor = sorted[Math.floor(sorted.length * 0.1)] || 0;
    var loud = sorted[Math.floor(sorted.length * 0.95)] || 0;
    // 9 dB over the floor, but never within 40 dB of the loud frames' level
    // in a file with no quiet at all.
    var thr = Math.max(floor * 2.82, loud * 0.01, 1e-5);
    return { lv: lv, thr: thr, F: F };
  }

  function frameAt(L, t) { return Math.max(0, Math.min(L.lv.length - 1, Math.round(t / FRAME))); }

  // Where the sound around [a, b] (seconds) begins and ends, within [lo, hi].
  function soundSpan(L, a, b, lo, hi) {
    var f0 = frameAt(L, Math.max(lo, a - 0.15)), f1 = frameAt(L, Math.min(hi, b + 0.35));
    var on = -1, off = -1, f = f0;
    // Skip the tail of the word before, if the search starts inside it.
    while (f < frameAt(L, a) && L.lv[f] > L.thr) f++;
    for (; f <= f1; f++) if (L.lv[f] > L.thr) { on = f; break; }
    if (on < 0) return null;
    // The end: the first 60 ms run of quiet after the onset.
    var quiet = 0;
    for (var g = on; g <= frameAt(L, hi); g++) {
      if (L.lv[g] <= L.thr) { if (++quiet >= 6) { off = g - quiet + 1; break; } } else quiet = 0;
    }
    if (off < 0) off = frameAt(L, hi);
    return [on * FRAME, off * FRAME];
  }

  function flatPitch(mono, rate, a, b) {
    if (!ASPitch || b - a < 0.15) return false;
    var seg = mono.subarray(Math.max(0, Math.round(a * rate)), Math.min(mono.length, Math.round(b * rate)));
    var fr = ASPitch.track(seg, rate, { hopSec: 0.01 }).filter(function (x) { return x.hz > 60 && x.hz < 500 && x.clarity > 0.8; });
    if (fr.length * 0.01 < 0.15) return false;
    var m = fr.map(function (x) { return x.midi; }).sort(function (p, q) { return p - q; });
    return m[Math.floor(m.length * 0.9)] - m[Math.floor(m.length * 0.1)] < 3;
  }

  function find(words, mono, rate, opts) {
    opts = opts || {};
    var L = levels(mono, rate), dur = mono.length / rate, out = [];
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (w.start == null) continue;
      var c = clean(w.text), raw = String(w.text || '').trim();
      var prev = words[i - 1], next = words[i + 1];
      var lo = prev && prev.end != null ? prev.end : 0, hi = next && next.start != null ? next.start + 0.15 : dur;
      var kind = null;
      if (FILLER.test(c)) kind = 'filler';
      else if (c.length && c.length <= 4) {
        var apart = (/,$/.test(raw) || !next || next.start - w.end > 0.15) &&
          (!prev || /[,.!?]$/.test(String(prev.text).trim()) || w.start - prev.end > 0.15);
        if (apart) {
          var sp0 = soundSpan(L, w.start, w.end, lo, hi);
          if (sp0 && flatPitch(mono, rate, sp0[0], sp0[1])) kind = 'maybe';
        }
      }
      if (!kind) continue;
      var sp = soundSpan(L, w.start, w.end, lo, hi) || [w.start, w.end];
      out.push({ text: raw.replace(/[,.]+$/, ''), start: sp[0], end: sp[1], kind: kind, on: kind === 'filler', at: i });
    }
    return out;
  }

  // Pauses between words longer than `longer` seconds, shortened to `keep`.
  // Only where the gap really is quiet: a word Whisper missed must not go.
  function pauses(words, mono, rate, opts) {
    opts = opts || {};
    var longer = opts.longer || 1.0, keep = opts.keep || 0.5;
    var L = levels(mono, rate), out = [];
    for (var i = 1; i < words.length; i++) {
      var a = words[i - 1].end, b = words[i].start;
      if (a == null || b == null || b - a < longer) continue;
      var s = a + keep / 2 + 0.1, e = b - keep / 2;
      var loud = false;
      for (var f = frameAt(L, s); f <= frameAt(L, e); f++) if (L.lv[f] > L.thr) { loud = true; break; }
      if (!loud && e - s > 0.1) out.push({ text: '', start: s, end: e, kind: 'pause', on: true });
    }
    return out;
  }

  // The cut for a found filler: its sound, plus enough of the silence around
  // it that the speaker's pause across the join is at most JOIN_PAUSE.
  function span(f, words, mono, rate) {
    var L = levels(mono, rate);
    var prev = words[f.at - 1], next = words[f.at + 1];
    var before = prev ? lastSound(L, prev.end, f.start - 0.02) : 0;
    var after = next ? firstSound(L, f.end, next.start + 0.3) : mono.length / rate;
    var gap = (f.start - before) + (after - f.end);
    var s = f.start, e = f.end;
    if (gap > JOIN_PAUSE) {
      var extra = gap - JOIN_PAUSE;
      var take = Math.min(extra / 2, f.start - before - 0.04);
      s -= Math.max(0, take);
      e += Math.max(0, Math.min(extra - Math.max(0, take), after - f.end - 0.04));
    }
    return [s, e];
  }
  function lastSound(L, from, to) {
    for (var f = frameAt(L, to); f >= frameAt(L, from - 0.3); f--) if (L.lv[f] > L.thr) return (f + 1) * FRAME;
    return from;
  }
  function firstSound(L, from, to) {
    for (var f = frameAt(L, from); f <= frameAt(L, to); f++) if (L.lv[f] > L.thr) return f * FRAME;
    return to;
  }

  // Remove the ranges (seconds), joining with a 10 ms equal-power crossfade,
  // each edge moved to the quietest sample within 5 ms so a join lands where
  // the waveform is near zero.
  function cut(channels, rate, ranges) {
    var n = channels[0].length;
    var rs = ranges.map(function (r) { return [Math.max(0, Math.round(r[0] * rate)), Math.min(n, Math.round(r[1] * rate))]; })
      .filter(function (r) { return r[1] > r[0]; }).sort(function (a, b) { return a[0] - b[0]; });
    var merged = [];
    rs.forEach(function (r) { var l = merged[merged.length - 1]; if (l && r[0] <= l[1]) l[1] = Math.max(l[1], r[1]); else merged.push(r.slice()); });
    var W = Math.round(0.005 * rate);
    function quiet(x) {
      var best = x, bv = Infinity;
      for (var k = Math.max(1, x - W); k < Math.min(n - 1, x + W); k++) {
        var v = 0; for (var c = 0; c < channels.length; c++) v += Math.abs(channels[c][k]);
        if (v < bv) { bv = v; best = k; }
      }
      return best;
    }
    merged.forEach(function (r) { r[0] = quiet(r[0]); r[1] = quiet(r[1]); });
    var keep = [], at = 0;
    merged.forEach(function (r) { if (r[0] > at) keep.push([at, r[0]]); at = Math.max(at, r[1]); });
    if (at < n) keep.push([at, n]);
    var xf = Math.round(XFADE * rate), total = 0;
    keep.forEach(function (k, i) { total += k[1] - k[0] - (i ? Math.min(xf, k[1] - k[0]) : 0); });
    var out = channels.map(function () { return new Float32Array(Math.max(1, total)); });
    var pos = 0;
    keep.forEach(function (k, i) {
      var len = k[1] - k[0], x = i ? Math.min(xf, len, pos) : 0;
      for (var c = 0; c < channels.length; c++) {
        var src = channels[c], dst = out[c];
        for (var j = 0; j < x; j++) {
          var t = (j + 1) / (x + 1);
          dst[pos - x + j] = dst[pos - x + j] * Math.sqrt(1 - t) + src[k[0] + j] * Math.sqrt(t);
        }
        for (var j2 = x; j2 < len; j2++) dst[pos - x + j2] = src[k[0] + j2];
      }
      pos += len - x;
    });
    return { channels: out, removed: (n - total) / rate, keep: keep };
  }

  return { find: find, pauses: pauses, span: span, cut: cut, FILLER: FILLER };
});
