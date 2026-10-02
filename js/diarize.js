/*
 * ASDiar — who spoke when, the pure half. UMD: tools/check-diarize.js runs
 * it in Node; diarize-worker.js runs the models and hands their output here.
 *
 * The pipeline is pyannote's, in the browser:
 *   1. pyannote segmentation-3.0 marks speech and up to three "local"
 *      speakers per frame. On its own it cannot tell similar voices apart:
 *      measured, a three-person conversation with two women came back as two
 *      speakers (68% of the speech labelled right).
 *   2. Each turn (≥ 0.5 s) gets a WeSpeaker ResNet34 embedding.
 *   3. The embeddings are clustered (average linkage, cosine distance):
 *      to a given number of speakers, or, on Auto, until the closest pair is
 *      more than THRESHOLD apart, then any speaker with less than MIN_SHARE
 *      of the speech is folded into its nearest neighbour.
 *
 * THRESHOLD and MIN_SHARE were set on synthetic conversations (check-diarize):
 * at 0.4 a two-person talk split in three, at 0.5 a three-person one merged
 * to two; 0.45 with the 8% fold gets both counts right.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ASDiar = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var THRESHOLD = 0.45, MIN_SHARE = 0.08, MIN_TURN = 0.5, JOIN_GAP = 0.3;

  // pyannote's post-processed segments ({ id, start, end }, id 0 = nobody)
  // → turns: speech only, a local speaker's run joined across short gaps.
  function turns(segs) {
    var out = [];
    (segs || []).forEach(function (s) {
      if (!s.id) return;
      var l = out[out.length - 1];
      if (l && l.local === s.id && s.start - l.end < JOIN_GAP) l.end = s.end;
      else out.push({ local: s.id, start: s.start, end: s.end });
    });
    return out;
  }

  function cosDist(a, b) {
    var d = 0, na = 0, nb = 0;
    for (var i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return 1 - d / (Math.sqrt(na * nb) || 1);
  }

  // items: [{ start, end, emb }] (turns long enough to embed).
  // opts.speakers: a fixed count, or 0 for Auto. Returns a label (1..n) per
  // item, numbered in order of first appearance.
  function cluster(items, opts) {
    opts = opts || {};
    var want = opts.speakers || 0, thr = opts.threshold || THRESHOLD;
    var n = items.length;
    if (!n) return [];
    var D = [];
    for (var i = 0; i < n; i++) { D[i] = []; for (var j = 0; j < n; j++) D[i][j] = i === j ? 0 : (j < i ? D[j][i] : cosDist(items[i].emb, items[j].emb)); }
    var C = items.map(function (_, k) { return [k]; });
    function link(a, b) { var s = 0; a.forEach(function (x) { b.forEach(function (y) { s += D[x][y]; }); }); return s / (a.length * b.length); }
    for (;;) {
      if (C.length < 2 || (want && C.length <= want)) break;
      var bi = -1, bj = -1, bd = Infinity;
      for (var p = 0; p < C.length; p++) for (var q = p + 1; q < C.length; q++) { var d = link(C[p], C[q]); if (d < bd) { bd = d; bi = p; bj = q; } }
      if (!want && bd > thr) break;
      C[bi] = C[bi].concat(C[bj]); C.splice(bj, 1);
    }
    if (!want) {
      var dur = function (c) { return c.reduce(function (a, k) { return a + items[k].end - items[k].start; }, 0); };
      var all = C.reduce(function (a, c) { return a + dur(c); }, 0);
      for (;;) {
        var small = -1;
        for (var s = 0; s < C.length; s++) if (dur(C[s]) < MIN_SHARE * all) { small = s; break; }
        if (small < 0 || C.length < 2) break;
        var tj = -1, td = Infinity;
        for (var t = 0; t < C.length; t++) { if (t === small) continue; var dd = link(C[small], C[t]); if (dd < td) { td = dd; tj = t; } }
        C[tj] = C[tj].concat(C[small]); C.splice(small, 1);
      }
    }
    // Number speakers by when they first speak.
    C.sort(function (a, b) { return Math.min.apply(null, a.map(function (k) { return items[k].start; })) - Math.min.apply(null, b.map(function (k) { return items[k].start; })); });
    var label = new Array(n);
    C.forEach(function (c, k) { c.forEach(function (x) { label[x] = k + 1; }); });
    return label;
  }

  // Full turns (including the short ones that were not embedded) get the
  // label of the nearest embedded turn with the same local pyannote id, or
  // simply the nearest embedded turn.
  function labelTurns(all, embedded, labels) {
    return all.map(function (t) {
      var best = -1, bd = Infinity;
      embedded.forEach(function (e, k) {
        var gap = Math.max(0, Math.max(e.start, t.start) - Math.min(e.end, t.end)) + (e.local === t.local ? 0 : 1000);
        if (gap < bd) { bd = gap; best = k; }
      });
      if (best < 0) embedded.forEach(function (e, k) { var g = Math.abs(e.start - t.start); if (g < bd) { bd = g; best = k; } });
      return { start: t.start, end: t.end, speaker: best >= 0 ? labels[best] : 1 };
    });
  }

  // Whisper segments ({ text, start, end }) → the same with .speaker: the
  // speaker who talks most inside the segment, else the nearest turn's.
  function labelSegments(segs, speakerTurns) {
    return segs.map(function (s) {
      var a = s.start || 0, b = s.end != null ? s.end : a + 2, tally = {}, best = 0, bv = 0;
      speakerTurns.forEach(function (t) {
        var o = Math.min(b, t.end) - Math.max(a, t.start);
        if (o > 0) { tally[t.speaker] = (tally[t.speaker] || 0) + o; if (tally[t.speaker] > bv) { bv = tally[t.speaker]; best = t.speaker; } }
      });
      if (!best) {
        var bd = Infinity;
        speakerTurns.forEach(function (t) { var g = Math.min(Math.abs(t.start - a), Math.abs(t.end - a)); if (g < bd) { bd = g; best = t.speaker; } });
      }
      return Object.assign({}, s, { speaker: best || 1 });
    });
  }

  // "Speaker 2: …" paragraphs, one per change of speaker. names: { 1: 'Ana' }.
  function toText(segs, names) {
    var out = [], cur = null;
    segs.forEach(function (s) {
      var t = String(s.text || '').trim();
      if (!t) return;
      if (!cur || cur.speaker !== s.speaker) { cur = { speaker: s.speaker, text: [] }; out.push(cur); }
      cur.text.push(t);
    });
    return out.map(function (p) { return name(p.speaker, names) + ': ' + p.text.join(' '); }).join('\n\n');
  }
  function name(k, names) { return (names && names[k] && String(names[k]).trim()) || 'Speaker ' + k; }

  // Segments for subtitles: the name in front of a cue whenever the speaker
  // changes, which is the broadcast convention.
  function prefixCues(segs, names) {
    var last = null;
    return segs.map(function (s) {
      var t = String(s.text || '').trim(), p = s.speaker !== last ? name(s.speaker, names) + ': ' : '';
      last = s.speaker;
      return Object.assign({}, s, { text: p + t });
    });
  }

  return { turns: turns, cluster: cluster, labelTurns: labelTurns, labelSegments: labelSegments, toText: toText, prefixCues: prefixCues, name: name,
    THRESHOLD: THRESHOLD, MIN_SHARE: MIN_SHARE, MIN_TURN: MIN_TURN };
}));
