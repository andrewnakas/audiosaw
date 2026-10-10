/*
 * Subtitle and transcript writers (and a reader) for /audio-to-text and
 * /add-subtitles-to-video.
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

  // LRC, the synced-lyrics format karaoke players, music apps and lyric-video
  // makers read: one line per cue as [mm:ss.xx]text, centiseconds rounded,
  // minutes past 99 kept as they are (the format has no hours). A blank
  // timed line after a cue that ends well before the next one starts, so the
  // last words do not hang on screen through an instrumental.
  function toLRC(segs, opts) {
    opts = opts || {};
    function ts(t) {
      var cs = Math.max(0, Math.round(t * 100)), m = Math.floor(cs / 6000), r = cs - m * 6000;
      return '[' + pad(m, 2) + ':' + pad(Math.floor(r / 100), 2) + '.' + pad(r % 100, 2) + ']';
    }
    var cues = normalise(segs, opts.duration), out = [];
    if (opts.title) out.push('[ti:' + cleanText(opts.title) + ']');
    if (opts.artist) out.push('[ar:' + cleanText(opts.artist) + ']');
    out.push('[re:AudioSaw lyrics from a song (audiosaw.com)]');
    cues.forEach(function (c, i) {
      out.push(ts(c.start) + c.text.replace(/\s*\n\s*/g, ' '));
      var next = cues[i + 1];
      if (!next || next.start - c.end > 2) out.push(ts(c.end));
    });
    return out.join('\n') + '\n';
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

  // SRT or WebVTT text → [{ text, start, end }]. Lenient the way players are:
  // cue numbers optional, comma or dot before the milliseconds, hours
  // optional, VTT settings after the times ignored, tags stripped.
  function parseTime(t) {
    var m = /(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})/.exec(t);
    if (!m) return NaN;
    return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (+(m[4] + '00').slice(0, 3)) / 1000;
  }
  function parse(text) {
    var blocks = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n\s*\n/);
    var out = [];
    blocks.forEach(function (b) {
      var lines = b.split('\n').filter(function (l) { return l.trim() !== ''; });
      var k = 0;
      while (k < lines.length && lines[k].indexOf('-->') < 0) k++;
      if (k >= lines.length) return;   // WEBVTT header, NOTE, STYLE, numbering only
      var tm = lines[k].split('-->');
      var start = parseTime(tm[0]), end = parseTime(tm[1] || '');
      var body = lines.slice(k + 1).join('\n').replace(/<[^>]+>/g, '').replace(/\{\\[^}]*\}/g, '').trim();
      if (isFinite(start) && body) out.push({ text: body, start: start, end: isFinite(end) ? end : NaN });
    });
    return out;
  }

  // Short captions for social video: each cue cut into pieces of at most
  // `maxWords` words (breaking after punctuation when it can), each timed in
  // proportion to its share of the cue's characters. Whisper gives no word
  // times, so this is an even spread, not word-accurate.
  function split(segs, maxWords) {
    maxWords = maxWords || 4;
    var out = [];
    normalise(segs).forEach(function (c) {
      var words = c.text.replace(/\n/g, ' ').split(/\s+/).filter(Boolean);
      if (words.length <= maxWords) { out.push(c); return; }
      var parts = [], cur = [];
      words.forEach(function (w, i) {
        cur.push(w);
        var room = words.length - i - 1;
        if (cur.length >= maxWords || (cur.length >= 2 && /[,.;:!?]$/.test(w) && room >= 2)) { parts.push(cur.join(' ')); cur = []; }
      });
      if (cur.length) {
        if (cur.length === 1 && parts.length) parts[parts.length - 1] += ' ' + cur[0];
        else parts.push(cur.join(' '));
      }
      var total = parts.reduce(function (a, p) { return a + p.length; }, 0), t = c.start, span = c.end - c.start;
      parts.forEach(function (p, i) {
        var e = i === parts.length - 1 ? c.end : t + span * p.length / total;
        out.push({ text: p, start: t, end: e });
        t = e;
      });
    });
    return out;
  }

  // Short captions from word times: up to maxWords words each (breaking after
  // punctuation when it can), from the first word's start to the last
  // word's end, held until the next caption when the gap is under 0.3 s.
  function fromWords(words, maxWords) {
    maxWords = maxWords || 4;
    var out = [], cur = [];
    var flush = function () {
      if (!cur.length) return;
      var last = out[out.length - 1];
      // A lone word close behind a caption joins it rather than flashing up
      // on its own.
      if (cur.length === 1 && last && cur[0].start - last.end < 0.3 && last.text.split(' ').length <= maxWords) {
        last.text += ' ' + cur[0].text.trim(); last.end = cur[0].end; cur = []; return;
      }
      out.push({ text: cur.map(function (w) { return w.text.trim(); }).join(' '), start: cur[0].start, end: cur[cur.length - 1].end });
      cur = [];
    };
    (words || []).forEach(function (w, i) {
      if (!String(w.text || '').trim() || w.start == null) return;
      var prev = cur[cur.length - 1];
      if (prev && w.start - prev.end > 0.6) flush();
      cur.push(w);
      var rest = words.length - i - 1;
      if (cur.length >= maxWords || (cur.length >= 2 && /[,.;:!?…]["'”’)]*$/.test(w.text.trim()) && rest >= 2)) flush();
    });
    flush();
    for (var j = 0; j + 1 < out.length; j++) if (out[j + 1].start - out[j].end < 0.3) out[j].end = out[j + 1].start;
    return out;
  }

  return { toSRT: toSRT, toVTT: toVTT, toLRC: toLRC, toText: toText, normalise: normalise, stamp: stamp, parse: parse, split: split, fromWords: fromWords };
});
