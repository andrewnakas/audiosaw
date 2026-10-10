/*
 * ASSheet: a melody (notes in seconds) into notation, for /audio-to-sheet-music.
 * UMD, so tools/check-sheet.js runs it in Node and reads the MusicXML back
 * with a reader of its own.
 *
 *   ASSheet.quantize(notes, { bpm, firstBeat, grid }) -> [{ midi, at, len }]
 *       notes are pitch-track.js's [{ midi, start, duration }]; at and len
 *       are in grid steps (16ths by default) from the first beat.
 *   ASSheet.toMusicXML(q, { bpm, sig, fifths, mode, title, clef, transpose })
 *       -> a MusicXML 4.0 partwise score, one part, one voice.
 *   ASSheet.fifthsOf(pc, mode) -> key signature as a count of sharps (+)
 *       or flats (-), from key-detect.js's pc and mode.
 *
 * One line only: overlapping notes are cut where the next one starts, which
 * is the monophonic model pitch-track.js already assumes. Durations are
 * written as the plain and dotted values that fit inside the bar from where
 * the note is, and anything else is tied, so every measure sums exactly.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ASSheet = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Major-key tonic pitch class -> fifths. F# is spelled as Gb (6 flats)
  // only by choice of the table; 6 sharps is equally right.
  var MAJOR_FIFTHS = { 0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 1: -5, 8: -4, 3: -3, 10: -2, 5: -1 };
  function fifthsOf(pc, mode) {
    var tonic = mode === 'minor' ? (pc + 3) % 12 : pc;
    return MAJOR_FIFTHS[((tonic % 12) + 12) % 12];
  }

  var SHARP = [['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0], ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0]];
  var FLAT = [['C', 0], ['D', -1], ['D', 0], ['E', -1], ['E', 0], ['F', 0], ['G', -1], ['G', 0], ['A', -1], ['A', 0], ['B', -1], ['B', 0]];
  function spell(midi, fifths) {
    var pc = ((midi % 12) + 12) % 12, oct = Math.floor(midi / 12) - 1;
    var s = (fifths < 0 ? FLAT : SHARP)[pc];
    return { step: s[0], alter: s[1], octave: oct };
  }

  function quantize(notes, o) {
    var grid = o.grid || 4, beat = 60 / o.bpm, t0 = o.firstBeat || 0;
    var q = notes.map(function (n) {
      var at = Math.round((n.start - t0) / beat * grid);
      var end = Math.round((n.start + n.duration - t0) / beat * grid);
      return { midi: n.midi, at: at, len: Math.max(1, end - at), vel: n.velocity };
    }).sort(function (a, b) { return a.at - b.at; });
    // A note may not start before the first beat; one line, no overlaps.
    var out = [];
    q.forEach(function (n) {
      if (n.at < 0) { n.len += n.at; n.at = 0; }
      if (n.len < 1) return;
      var prev = out[out.length - 1];
      if (prev && prev.at === n.at) { if (n.len > prev.len) out[out.length - 1] = n; return; }
      if (prev && prev.at + prev.len > n.at) prev.len = n.at - prev.at;
      out.push(n);
    });
    return out;
  }

  // Plain and dotted values in 16ths, largest first.
  var VALUES = [[16, 'whole', 0], [12, 'half', 1], [8, 'half', 0], [6, 'quarter', 1], [4, 'quarter', 0], [3, 'eighth', 1], [2, 'eighth', 0], [1, '16th', 0]];

  // Split `len` steps starting at `pos` within a bar of `bar` steps into
  // writable values. A value must fit what is left of the bar, and a value
  // longer than a beat starts on a beat, so syncopations read as ties.
  function pieces(pos, len, bar, beatSteps) {
    var out = [];
    while (len > 0) {
      for (var i = 0; i < VALUES.length; i++) {
        var v = VALUES[i][0];
        if (v > len) continue;
        if (v > beatSteps && pos % beatSteps) continue;
        if ((pos % bar) + v > bar) continue;
        out.push(VALUES[i]);
        pos += v; len -= v;
        break;
      }
    }
    return out;
  }

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function toMusicXML(q, o) {
    o = o || {};
    var sig = o.sig || [4, 4], fifths = o.fifths || 0, tr = o.transpose || 0;
    var bar = sig[0] * 16 / sig[1];
    var beatSteps = sig[1] === 8 && sig[0] % 3 === 0 ? 6 : 16 / sig[1];
    var notes = q.map(function (n) { return { midi: n.midi + tr, at: n.at, len: n.len }; });
    var end = notes.length ? notes[notes.length - 1].at + notes[notes.length - 1].len : bar;
    var bars = Math.max(1, Math.ceil(end / bar));
    var clef = o.clef && o.clef !== 'auto' ? o.clef : (function () {
      var m = notes.map(function (n) { return n.midi; }).sort(function (a, b) { return a - b; });
      return m.length && m[m.length >> 1] < 57 ? 'bass' : 'treble';
    })();

    // Events laid on the timeline: notes and the rests between them.
    var ev = [], pos = 0;
    notes.forEach(function (n) {
      if (n.at > pos) ev.push({ rest: true, at: pos, len: n.at - pos });
      ev.push({ midi: n.midi, at: n.at, len: n.len });
      pos = n.at + n.len;
    });
    if (pos < bars * bar) ev.push({ rest: true, at: pos, len: bars * bar - pos });

    // Each event cut at bar lines, then into writable values.
    var measures = [];
    for (var b = 0; b < bars; b++) measures.push([]);
    ev.forEach(function (e) {
      var at = e.at, left = e.len, first = true;
      while (left > 0) {
        var m = Math.floor(at / bar), room = (m + 1) * bar - at, take = Math.min(left, room);
        var ps = pieces(at, take, bar, beatSteps);
        ps.forEach(function (p, i) {
          var last = left - take === 0 && i === ps.length - 1;
          measures[m].push({ rest: e.rest, midi: e.midi, dur: p[0], type: p[1], dot: p[2], tieStart: !e.rest && !last, tieStop: !e.rest && !first });
          first = false;
        });
        at += take; left -= take;
      }
    });

    var x = [];
    x.push('<?xml version="1.0" encoding="UTF-8" standalone="no"?>');
    x.push('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">');
    x.push('<score-partwise version="4.0">');
    x.push('  <work><work-title>' + esc(o.title || 'Melody') + '</work-title></work>');
    x.push('  <identification><encoding><software>AudioSaw audio to sheet music (audiosaw.com)</software></encoding></identification>');
    x.push('  <part-list><score-part id="P1"><part-name>' + esc(o.part || 'Melody') + '</part-name></score-part></part-list>');
    x.push('  <part id="P1">');
    measures.forEach(function (ms, i) {
      x.push('    <measure number="' + (i + 1) + '">');
      if (i === 0) {
        x.push('      <attributes><divisions>4</divisions><key><fifths>' + fifths + '</fifths>' + (o.mode ? '<mode>' + o.mode + '</mode>' : '') + '</key>' +
          '<time><beats>' + sig[0] + '</beats><beat-type>' + sig[1] + '</beat-type></time>' +
          (clef === 'bass' ? '<clef><sign>F</sign><line>4</line></clef>' : '<clef><sign>G</sign><line>2</line></clef>') + '</attributes>');
        if (o.bpm) x.push('      <direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>' + Math.round(o.bpm) + '</per-minute></metronome></direction-type><sound tempo="' + Math.round(o.bpm) + '"/></direction>');
      }
      ms.forEach(function (n) {
        var s = '      <note>';
        if (n.rest) s += '<rest/>';
        else {
          var p = spell(n.midi, fifths);
          s += '<pitch><step>' + p.step + '</step>' + (p.alter ? '<alter>' + p.alter + '</alter>' : '') + '<octave>' + p.octave + '</octave></pitch>';
        }
        s += '<duration>' + n.dur + '</duration>';
        if (n.tieStop) s += '<tie type="stop"/>';
        if (n.tieStart) s += '<tie type="start"/>';
        s += '<voice>1</voice><type>' + n.type + '</type>' + (n.dot ? '<dot/>' : '');
        if (n.tieStop || n.tieStart) s += '<notations>' + (n.tieStop ? '<tied type="stop"/>' : '') + (n.tieStart ? '<tied type="start"/>' : '') + '</notations>';
        x.push(s + '</note>');
      });
      if (i === measures.length - 1) x.push('      <barline location="right"><bar-style>light-heavy</bar-style></barline>');
      x.push('    </measure>');
    });
    x.push('  </part>');
    x.push('</score-partwise>');
    return x.join('\n');
  }

  // Tempo and the first beat from the note onsets themselves. The site's
  // BPM finder listens for drums and read a bare melody at 75 or 91 BPM where
  // it was 96 or 108. Here every candidate beat period is scored by how well
  // the onsets line up on it (the length of the mean of exp(2πi·t/P)); a
  // melody's onsets sit on eighths or sixteenths, so the fastest grids score
  // best too, and the slowest period within 3% of the best score is taken,
  // then folded into 70-140 BPM. The phase of that sum is the first beat.
  function tempo(notes, o) {
    o = o || {};
    var t = notes.map(function (n) { return n.start; });
    if (t.length < 4) return null;
    var lo = o.lo || 70, hi = o.hi || 140, best = 0, scores = [];
    for (var bpm = 40; bpm <= 320; bpm += 0.25) {
      var P = 60 / bpm, re = 0, im = 0;
      for (var i = 0; i < t.length; i++) { var a = 2 * Math.PI * t[i] / P; re += Math.cos(a); im += Math.sin(a); }
      var r = Math.sqrt(re * re + im * im) / t.length;
      scores.push({ bpm: bpm, r: r, ph: Math.atan2(im, re) });
      if (r > best) best = r;
    }
    var pick = null;
    for (var k = 0; k < scores.length; k++) if (scores[k].r >= best * 0.97) { pick = scores[k]; break; }
    var b = pick.bpm;
    while (b < lo) b *= 2;
    while (b > hi) b /= 2;
    // Refine to 0.01 BPM on the folded tempo's own sixteenth grid: a quarter
    // of a BPM out drifts a whole sixteenth over a long tune.
    function fit(bp) {
      var P = 15 / bp, re = 0, im = 0;
      for (var i = 0; i < t.length; i++) { var a = 2 * Math.PI * t[i] / P; re += Math.cos(a); im += Math.sin(a); }
      return re * re + im * im;
    }
    var bestB = b, bestF = fit(b);
    for (var d = -0.5; d <= 0.5; d += 0.01) { var f = fit(b + d); if (f > bestF) { bestF = f; bestB = b + d; } }
    b = Math.round(bestB * 100) / 100;
    var P2 = 60 / b, rr = 0, ii = 0;
    for (var j = 0; j < t.length; j++) { var a2 = 2 * Math.PI * t[j] / P2; rr += Math.cos(a2); ii += Math.sin(a2); }
    var ph = Math.atan2(ii, rr);
    var first = ((ph / (2 * Math.PI)) * P2) % P2;
    if (first < 0) first += P2;
    // The beat at or before the first note.
    while (first > t[0] + 0.05) first -= P2;
    while (first + P2 <= t[0] + 0.05) first += P2;
    return { bpm: b, firstBeat: first, fit: Math.sqrt(rr * rr + ii * ii) / t.length };
  }

  // A note played twice at the same pitch comes out of pitch-track.js as one
  // long note: the pitch never moves, and the gap between the two is shorter
  // than its frames. The energy shows it: split a note where its level dips
  // under 60% of the note's peak and comes back over 80% of it.
  function rearticulate(notes, frames) {
    var out = [];
    notes.forEach(function (n) {
      var fr = frames.filter(function (f) { return f.time >= n.start && f.time < n.start + n.duration; });
      var peak = 0;
      fr.forEach(function (f) { if (f.rms > peak) peak = f.rms; });
      var cuts = [], low = false, lowAt = 0;
      for (var i = 2; i < fr.length; i++) {
        if (!low && fr[i].rms < peak * 0.6 && fr[i].rms < fr[i - 2].rms * 0.8) { low = true; lowAt = i; }
        else if (low && fr[i].rms > peak * 0.8) {
          if (fr[i].time - n.start > 0.06 && n.start + n.duration - fr[i].time > 0.06) cuts.push(fr[lowAt].time);
          low = false;
        }
      }
      if (!cuts.length) { out.push(n); return; }
      var s = n.start;
      cuts.concat([n.start + n.duration]).forEach(function (c) {
        out.push({ midi: n.midi, start: s, duration: c - s, velocity: n.velocity });
        s = c;
      });
    });
    return out;
  }

  return { tempo: tempo, rearticulate: rearticulate, quantize: quantize, toMusicXML: toMusicXML, fifthsOf: fifthsOf, spell: spell, pieces: pieces };
});
