/*
 * ASDub — the timing side of /video-dubbing: which lines to speak, how fast,
 * where, and how far to turn the original down underneath. No audio
 * decoding, no models; UMD so tools/check-dubbing.js runs it in Node.
 *
 * The page gets Whisper's phrase segments ({ text, start, end }), merges the
 * fragments into speakable lines, has Kokoro read each line, and then:
 *
 *   fit()    a line longer than its slot (its start to the next line's
 *            start) is read again faster, up to 1.3x; past that it is
 *            allowed to run on and is flagged, rather than sped into
 *            gibberish or cut off mid-word. Kokoro's own speed input does
 *            the speeding, so the voice keeps its pitch.
 *   duck()   a gain curve for the original: down by `depth` dB wherever a
 *            dubbed line plays, with short ramps, so the music and effects
 *            stay but the original voice sits under the new one.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ASDub = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MAX_SPEED = 1.3;

  // Whisper splits at its own phrase boundaries, which can leave two-word
  // fragments; Kokoro reads those flatly. Join neighbours that are close in
  // time and short together, but never across a real pause.
  function merge(segs, o) {
    o = o || {};
    var maxGap = o.maxGap != null ? o.maxGap : 0.35, maxLen = o.maxLen || 12;
    var out = [];
    (segs || []).forEach(function (s) {
      var text = String(s.text || '').replace(/\s+/g, ' ').trim();
      if (!text || s.start == null) return;
      var end = s.end != null ? s.end : s.start + Math.max(1, text.split(' ').length / 2.6);
      var last = out[out.length - 1];
      if (last && s.start - last.end <= maxGap && end - last.start <= maxLen && !/[.!?]["')\]]?$/.test(last.text)) {
        last.text += ' ' + text;
        last.end = end;
      } else out.push({ text: text, start: s.start, end: end });
    });
    return out;
  }

  // lines: [{ start, end }] in order; seconds: the line's spoken length at
  // speed 1. The slot runs to the next line's start (or 1.5 s past this
  // line's end for the last one, never past `total`).
  function fit(lines, i, seconds, total) {
    var ln = lines[i];
    var next = lines[i + 1] ? lines[i + 1].start : Math.min(total || Infinity, ln.end + 1.5);
    var slot = Math.max(0.3, next - ln.start - 0.05);
    var speed = 1;
    if (seconds > slot) speed = Math.min(MAX_SPEED, seconds / slot * 1.02);
    var spoken = seconds / speed;
    return { start: ln.start, slot: slot, speed: speed, seconds: spoken, overflow: Math.max(0, spoken - slot) };
  }

  // placed: [{ start, seconds }]. Returns a Float32Array of linear gain at
  // `rate`, `depthDb` down under each line (ramps of `ramp` s either side).
  function duck(n, rate, placed, depthDb, ramp) {
    ramp = ramp == null ? 0.15 : ramp;
    var g = new Float32Array(n).fill(1);
    var low = Math.pow(10, -Math.abs(depthDb) / 20);
    var r = Math.max(1, Math.round(ramp * rate));
    placed.forEach(function (p) {
      var a = Math.round(p.start * rate), b = Math.round((p.start + p.seconds) * rate);
      for (var i = Math.max(0, a - r); i < Math.min(n, b + r); i++) {
        var w = i < a ? (a - i) / r : i > b ? (i - b) / r : 0;   // 0 inside, 1 at the ramp's outer end
        var v = low + (1 - low) * (0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, w)));
        if (v < g[i]) g[i] = v;
      }
    });
    return g;
  }

  // Original channels × gain, plus the dub (mono, same rate) on every
  // channel. Peak-limited by the page afterwards.
  function mix(orig, gain, dub, origLevel) {
    var lv = origLevel == null ? 1 : origLevel;
    return orig.map(function (c) {
      var y = new Float32Array(c.length);
      for (var i = 0; i < c.length; i++) y[i] = c[i] * gain[i] * lv + (i < dub.length ? dub[i] : 0);
      return y;
    });
  }

  // Whisper often stamps a line from the end of the previous one, or from
  // 0 after a silent opening (measured: a sentence starting at 1.0 s came
  // back at 0.00), which would start the dub early. Each start is moved to
  // the first 20 ms frame of real speech inside the line: above three times
  // the file's own floor (its 10th-percentile level) and -45 dBFS.
  function snapStarts(lines, mono, rate) {
    var F = Math.round(rate * 0.02), n = Math.floor(mono.length / F), lv = new Float32Array(n);
    for (var k = 0; k < n; k++) { var e = 0; for (var i = k * F; i < (k + 1) * F; i++) e += mono[i] * mono[i]; lv[k] = Math.sqrt(e / F); }
    var sorted = Array.from(lv).sort(function (a, b) { return a - b; });
    var thr = Math.max(Math.pow(10, -45 / 20), (sorted[Math.floor(n * 0.1)] || 0) * 3);
    return lines.map(function (ln) {
      var a = Math.floor(ln.start / 0.02), b = Math.min(n, Math.ceil(ln.end / 0.02));
      for (var j = a; j < b; j++) if (lv[j] > thr) return Object.assign({}, ln, { start: Math.max(ln.start, j * 0.02 - 0.04) });
      return ln;
    });
  }

  return { merge: merge, fit: fit, duck: duck, mix: mix, snapStarts: snapStarts, MAX_SPEED: MAX_SPEED };
}));
