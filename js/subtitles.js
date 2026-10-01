/*
 * Subtitle and transcript writers for /audio-to-text.
 *
 * Input is the segment list Whisper returns: [{ text, start, end }] in seconds.
 * UMD so tools/check-srt.js can run it in Node and parse the output back with
 * a reader written separately from these writers.
 *
 * The rules that make players reject or mangle a file:
 *   - SRT times are HH:MM:SS,mmm (comma), VTT times are HH:MM:SS.mmm (dot).
 *   - VTT must begin with "WEBVTT" and a blank line.
 *   - Cue numbers in SRT start at 1 and run without gaps.
 *   - A cue's end must be after its start, and cues must not run backwards.
 *   - A blank line ends a cue, so text may not contain one.
 *   - "-->" inside VTT cue text ends the timing line early in some parsers.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ASSubs = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MIN_CUE = 0.3;     // seconds; shorter cues flash past unread
  var MAX_LINE = 42;     // characters per line, the Netflix/BBC convention

  function pad(n, w) { n = String(n); while (n.length < w) n = '0' + n; return n; }

  function stamp(t, sep) {
    var ms = Math.max(0, Math.round(t * 1000));
    var h = Math.floor(ms / 3600000); ms -= h * 3600000;
    var m = Math.floor(ms / 60000); ms -= m * 60000;
    var s = Math.floor(ms / 1000); ms -= s * 1000;
    return pad(h, 2) + ':' + pad(m, 2) + ':' + pad(s, 2) + sep + pad(ms, 3);
  }

  function cleanText(t) {
    return String(t || '')
      .replace(/\r\n?/g, '\n')
      .replace(/\n\s*\n+/g, '\n')   // a blank line would end the cue
      .replace(/-->/g, '→')
      .replace(/[ \t]+/g, ' ')
      .trim();
  }

  // Break a cue into at most two lines near the middle, at a space.
  function wrap(text) {
    if (text.length <= MAX_LINE || text.indexOf('\n') >= 0) return text;
    var mid = text.length / 2, best = -1;
    for (var i = 0; i < text.length; i++) {
      if (text[i] === ' ' && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
    }
    if (best < 0) return text;
    return text.slice(0, best) + '\n' + text.slice(best + 1);
  }

  // Make segments safe to write: drop empty ones, fill a missing end (Whisper
  // leaves the last one open when the audio stops mid-sentence), keep times
  // monotonic and give every cue a readable minimum length without letting it
  // run into the next one.
  function normalise(segs, duration) {
    var out = [];
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      var text = cleanText(s.text);
      if (!text) continue;
      var start = +s.start, end = s.end == null ? NaN : +s.end;
      if (!isFinite(start)) start = out.length ? out[out.length - 1].end : 0;
      // Whisper's window merging occasionally hands back a segment that starts
      // before the previous one. Keep cue starts strictly increasing; the
      // second pass then trims each end to the next start.
      if (out.length && start <= out[out.length - 1].start) start = out[out.length - 1].start + 0.01;
      if (!isFinite(end) || end <= start) {
        var next = segs[i + 1];
        end = next && isFinite(+next.start) && +next.start > start ? +next.start
          : (isFinite(duration) && duration > start ? duration : start + 2);
      }
      out.push({ start: start, end: end, text: text });
    }
    for (var j = 0; j < out.length; j++) {
      var limit = j + 1 < out.length ? out[j + 1].start : Infinity;
      if (out[j].end - out[j].start < MIN_CUE) out[j].end = Math.min(out[j].start + MIN_CUE, limit);
      if (out[j].end > limit) out[j].end = limit;
      if (out[j].end <= out[j].start) out[j].end = Math.min(out[j].start + MIN_CUE, limit);
    }
    return out;
  }

  function toSRT(segs, duration) {
    return normalise(segs, duration).map(function (c, i) {
      return (i + 1) + '\n' + stamp(c.start, ',') + ' --> ' + stamp(c.end, ',') + '\n' + wrap(c.text) + '\n';
    }).join('\n');
  }

  function toVTT(segs, duration) {
    var cues = normalise(segs, duration).map(function (c) {
      return stamp(c.start, '.') + ' --> ' + stamp(c.end, '.') + '\n' + wrap(c.text) + '\n';
    });
    return 'WEBVTT\n\n' + cues.join('\n');
  }

  // Plain text with a paragraph break wherever the speaker paused for longer
  // than `gap` seconds — a wall of text is the main complaint about raw
  // Whisper output.
  function toText(segs, opts) {
    opts = opts || {};
    var gap = opts.gap == null ? 1.5 : opts.gap;
    var cues = normalise(segs, opts.duration);
    var out = '', prevEnd = null;
    cues.forEach(function (c) {
      var t = c.text.replace(/\n/g, ' ');
      if (opts.timestamps) t = '[' + stamp(c.start, '.').replace(/^00:/, '').slice(0, -4) + '] ' + t;
      if (prevEnd === null) out = t;
      else if (opts.timestamps || c.start - prevEnd > gap) out += '\n\n' + t;
      else out += (/[\s]$/.test(out) ? '' : ' ') + t;
      prevEnd = c.end;
    });
    return out ? out + '\n' : '';
  }

  return { toSRT: toSRT, toVTT: toVTT, toText: toText, normalise: normalise, stamp: stamp };
});
