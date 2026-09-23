/*
 * The audio editor's project model. Pure data and pure functions: no DOM, no
 * Web Audio, so tools/check-editor.js can run every operation in Node.
 *
 * Non-destructive by construction. A clip never holds samples; it is a window
 * onto a source ({sourceId, offset, duration}) placed at `start` on a track.
 * Splitting, trimming, moving and deleting only ever rewrite those four
 * numbers, which is why undo can be a stack of JSON snapshots — a project with
 * two hundred clips serialises to a few tens of kilobytes, while the audio it
 * points at (held outside, in a Map keyed by sourceId) is never copied.
 *
 * One invariant everything else leans on: clips on a track never overlap.
 * Anything that lands on occupied time — a move, a paste, a recording — carves
 * the space out of whatever was there first, the way "overwrite" works in every
 * video editor. The playback engine, the waveform renderer and the export all
 * assume it, and check-editor.js throws a thousand random edits at it.
 *
 * Times are seconds. Gains are dB.
 */
(function (global) {
  'use strict';

  var EPS = 1e-6;
  var MIN_LEN = 0.01;      // the shortest clip a trim or split may leave behind

  var seq = 0;
  function uid(prefix) {
    seq++;
    return prefix + Date.now().toString(36).slice(-5) + seq.toString(36) +
      Math.floor(Math.random() * 1296).toString(36);
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function clipEnd(c) { return c.start + c.duration; }
  function dbToGain(db) { return db <= -60 ? 0 : Math.pow(10, db / 20); }

  function create(name) {
    return { v: 1, name: name || 'Untitled project', tracks: [], sources: {}, markers: [] };
  }

  function serialize(p) { return JSON.stringify(p); }
  function parse(s) { return JSON.parse(s); }
  function copy(p) { return JSON.parse(JSON.stringify(p)); }

  /* ------------------------------------------------------------- lookups */

  function trackIndex(p, trackId) {
    for (var i = 0; i < p.tracks.length; i++) if (p.tracks[i].id === trackId) return i;
    return -1;
  }

  function findClip(p, clipId) {
    for (var t = 0; t < p.tracks.length; t++) {
      var clips = p.tracks[t].clips;
      for (var c = 0; c < clips.length; c++) {
        if (clips[c].id === clipId) return { track: p.tracks[t], ti: t, clip: clips[c], ci: c };
      }
    }
    return null;
  }

  function allClips(p) {
    var out = [];
    p.tracks.forEach(function (t, ti) {
      t.clips.forEach(function (c) { out.push({ clip: c, track: t, ti: ti }); });
    });
    return out;
  }

  function duration(p) {
    var d = 0;
    p.tracks.forEach(function (t) {
      t.clips.forEach(function (c) { var e = clipEnd(c); if (e > d) d = e; });
    });
    return d;
  }

  function sortTrack(t) { t.clips.sort(function (a, b) { return a.start - b.start; }); }

  function sourceLen(p, c) {
    var s = p.sources[c.sourceId];
    return s ? s.duration : Infinity;
  }

  function fixFades(c) {
    c.fadeIn = clamp(c.fadeIn || 0, 0, c.duration);
    c.fadeOut = clamp(c.fadeOut || 0, 0, c.duration - c.fadeIn);
  }

  /* ------------------------------------------------------ sources, tracks */

  function addSource(p, meta) {
    var id = meta.id || uid('s');
    p.sources[id] = {
      id: id,
      name: meta.name || 'audio',
      duration: meta.duration,
      channels: meta.channels || 1,
      sampleRate: meta.sampleRate || 48000,
      kind: meta.kind || 'file'      // 'file' | 'derived' | 'recording'
    };
    return id;
  }

  function addTrack(p, opts) {
    opts = opts || {};
    var t = {
      id: uid('t'),
      name: opts.name || ('Track ' + (p.tracks.length + 1)),
      volDb: 0, pan: 0, mute: false, solo: false,
      clips: []
    };
    if (opts.index != null && opts.index < p.tracks.length) p.tracks.splice(Math.max(0, opts.index), 0, t);
    else p.tracks.push(t);
    return t.id;
  }

  function removeTrack(p, trackId) {
    var i = trackIndex(p, trackId);
    if (i >= 0) p.tracks.splice(i, 1);
  }

  function moveTrack(p, trackId, delta) {
    var i = trackIndex(p, trackId);
    var j = clamp(i + delta, 0, p.tracks.length - 1);
    if (i < 0 || i === j) return;
    var t = p.tracks.splice(i, 1)[0];
    p.tracks.splice(j, 0, t);
  }

  function setTrack(p, trackId, patch) {
    var i = trackIndex(p, trackId);
    if (i < 0) return;
    var t = p.tracks[i];
    ['name', 'volDb', 'pan', 'mute', 'solo'].forEach(function (k) {
      if (patch[k] !== undefined) t[k] = patch[k];
    });
    t.volDb = clamp(+t.volDb || 0, -60, 12);
    t.pan = clamp(+t.pan || 0, -1, 1);
  }

  /* ---------------------------------------------------------------- carve */

  // Remove [t0, t1) from every clip on the track except those in `keep`,
  // trimming, splitting or deleting as needed.
  function carve(track, t0, t1, keep) {
    if (t1 - t0 < EPS) return;
    var out = [];
    track.clips.forEach(function (c) {
      var e = clipEnd(c);
      if ((keep && keep[c.id]) || c.start >= t1 - EPS || e <= t0 + EPS) { out.push(c); return; }
      if (c.start >= t0 - EPS && e <= t1 + EPS) return;               // swallowed
      if (c.start < t0 && e > t1) {                                     // straddles: split
        var right = cloneClip(c);
        right.start = t1;
        right.offset = c.offset + (t1 - c.start);
        right.duration = e - t1;
        right.fadeIn = 0;
        c.duration = t0 - c.start;
        c.fadeOut = 0;
        fixFades(c); fixFades(right);
        if (c.duration >= 0.001) out.push(c);
        if (right.duration >= 0.001) out.push(right);
        return;
      }
      if (c.start < t0) {                                               // tail overlaps
        c.duration = t0 - c.start;
      } else {                                                          // head overlaps
        var d = t1 - c.start;
        c.start = t1; c.offset += d; c.duration -= d;
      }
      fixFades(c);
      if (c.duration >= 0.001) out.push(c);
    });
    track.clips = out;
    sortTrack(track);
  }

  function cloneClip(c) {
    return {
      id: uid('c'), sourceId: c.sourceId, name: c.name,
      start: c.start, offset: c.offset, duration: c.duration,
      gainDb: c.gainDb || 0, fadeIn: c.fadeIn || 0, fadeOut: c.fadeOut || 0
    };
  }

  /* ---------------------------------------------------------------- clips */

  // Place a clip, overwriting whatever it lands on. Returns the clip id.
  function addClip(p, trackId, spec) {
    var ti = trackIndex(p, trackId);
    if (ti < 0) throw new Error('No such track');
    var src = p.sources[spec.sourceId];
    var c = {
      id: uid('c'),
      sourceId: spec.sourceId,
      name: spec.name || (src ? src.name : 'clip'),
      start: Math.max(0, spec.start || 0),
      offset: Math.max(0, spec.offset || 0),
      duration: spec.duration != null ? spec.duration : (src ? src.duration - (spec.offset || 0) : 1),
      gainDb: spec.gainDb || 0,
      fadeIn: spec.fadeIn || 0,
      fadeOut: spec.fadeOut || 0
    };
    if (src) c.duration = Math.min(c.duration, src.duration - c.offset);
    fixFades(c);
    var t = p.tracks[ti];
    carve(t, c.start, clipEnd(c));
    t.clips.push(c);
    sortTrack(t);
    return c.id;
  }

  function setClip(p, clipId, patch) {
    var f = findClip(p, clipId);
    if (!f) return;
    if (patch.name !== undefined) f.clip.name = String(patch.name);
    if (patch.gainDb !== undefined) f.clip.gainDb = clamp(+patch.gainDb || 0, -60, 24);
    if (patch.fadeIn !== undefined) f.clip.fadeIn = Math.max(0, +patch.fadeIn || 0);
    if (patch.fadeOut !== undefined) f.clip.fadeOut = Math.max(0, +patch.fadeOut || 0);
    if (patch.fadeIn !== undefined && patch.fadeOut === undefined) {
      f.clip.fadeIn = Math.min(f.clip.fadeIn, f.clip.duration);
      f.clip.fadeOut = Math.min(f.clip.fadeOut, f.clip.duration - f.clip.fadeIn);
    } else if (patch.fadeOut !== undefined && patch.fadeIn === undefined) {
      f.clip.fadeOut = Math.min(f.clip.fadeOut, f.clip.duration);
      f.clip.fadeIn = Math.min(f.clip.fadeIn, f.clip.duration - f.clip.fadeOut);
    } else {
      fixFades(f.clip);
    }
  }

  function neighbours(track, clip) {
    var prevEnd = 0, nextStart = Infinity;
    track.clips.forEach(function (o) {
      if (o === clip) return;
      if (clipEnd(o) <= clip.start + EPS && clipEnd(o) > prevEnd) prevEnd = clipEnd(o);
      if (o.start >= clipEnd(clip) - EPS && o.start < nextStart) nextStart = o.start;
    });
    return { prevEnd: prevEnd, nextStart: nextStart };
  }

  // Drag the left edge to time t. Bounded by the start of the source, the
  // previous clip on the track, and a minimum length.
  function trimStart(p, clipId, t) {
    var f = findClip(p, clipId);
    if (!f) return;
    var c = f.clip, nb = neighbours(f.track, c);
    var lo = Math.max(c.start - c.offset, nb.prevEnd, 0);
    var hi = clipEnd(c) - MIN_LEN;
    t = clamp(t, lo, hi);
    var d = t - c.start;
    c.start = t; c.offset += d; c.duration -= d;
    if (c.offset < 0) c.offset = 0;
    fixFadesKeeping(c, 'in');
  }

  function trimEnd(p, clipId, t) {
    var f = findClip(p, clipId);
    if (!f) return;
    var c = f.clip, nb = neighbours(f.track, c);
    var hi = Math.min(c.start + (sourceLen(p, c) - c.offset), nb.nextStart);
    var lo = c.start + MIN_LEN;
    c.duration = clamp(t, lo, hi) - c.start;
    fixFadesKeeping(c, 'out');
  }

  // Shrink the fade on the side being trimmed before touching the other one.
  function fixFadesKeeping(c, side) {
    if (side === 'in') {
      c.fadeOut = clamp(c.fadeOut || 0, 0, c.duration);
      c.fadeIn = clamp(c.fadeIn || 0, 0, c.duration - c.fadeOut);
    } else {
      c.fadeIn = clamp(c.fadeIn || 0, 0, c.duration);
      c.fadeOut = clamp(c.fadeOut || 0, 0, c.duration - c.fadeIn);
    }
  }

  function setFade(p, clipId, which, secs) {
    var f = findClip(p, clipId);
    if (!f) return;
    var c = f.clip;
    if (which === 'in') c.fadeIn = clamp(secs, 0, c.duration - (c.fadeOut || 0));
    else c.fadeOut = clamp(secs, 0, c.duration - (c.fadeIn || 0));
  }

  // Move a group of clips by dt seconds and dTrack lanes, keeping their
  // arrangement relative to each other. Whatever they land on is overwritten.
  // The UI previews a drag without calling this and applies it once on release,
  // so a clip dragged across another does not leave a trail of carved gaps.
  function moveClips(p, ids, dt, dTrack) {
    var found = ids.map(function (id) { return findClip(p, id); }).filter(Boolean);
    if (!found.length) return;
    var minStart = Infinity, minTi = Infinity, maxTi = -Infinity;
    found.forEach(function (f) {
      if (f.clip.start < minStart) minStart = f.clip.start;
      if (f.ti < minTi) minTi = f.ti;
      if (f.ti > maxTi) maxTi = f.ti;
    });
    dt = Math.max(dt, -minStart);
    dTrack = clamp(dTrack | 0, -minTi, p.tracks.length - 1 - maxTi);
    if (Math.abs(dt) < EPS && !dTrack) return;

    var moving = {};
    found.forEach(function (f) { moving[f.clip.id] = true; });
    p.tracks.forEach(function (t) {
      t.clips = t.clips.filter(function (c) { return !moving[c.id]; });
    });
    found.forEach(function (f) {
      f.clip.start = Math.max(0, f.clip.start + dt);
      var dest = p.tracks[f.ti + dTrack];
      carve(dest, f.clip.start, clipEnd(f.clip), moving);
      dest.clips.push(f.clip);
    });
    p.tracks.forEach(sortTrack);
  }

  // Split at t. `ids` limits it to those clips; otherwise every clip under t.
  // Returns the ids of the new right-hand halves.
  function splitAt(p, t, ids) {
    var only = null;
    if (ids && ids.length) { only = {}; ids.forEach(function (id) { only[id] = true; }); }
    var made = [];
    p.tracks.forEach(function (track) {
      var add = [];
      track.clips.forEach(function (c) {
        if (only && !only[c.id]) return;
        if (t <= c.start + MIN_LEN || t >= clipEnd(c) - MIN_LEN) return;
        var right = cloneClip(c);
        right.start = t;
        right.offset = c.offset + (t - c.start);
        right.duration = clipEnd(c) - t;
        right.fadeIn = 0;
        right.fadeOut = c.fadeOut;
        c.duration = t - c.start;
        c.fadeOut = 0;
        fixFades(c); fixFades(right);
        add.push(right);
        made.push(right.id);
      });
      track.clips = track.clips.concat(add);
      sortTrack(track);
    });
    return made;
  }

  // Delete clips. With ripple, everything after each deleted clip on the same
  // track slides left to close the gap it leaves.
  function deleteClips(p, ids, ripple) {
    var del = {};
    ids.forEach(function (id) { del[id] = true; });
    p.tracks.forEach(function (track) {
      var gone = track.clips.filter(function (c) { return del[c.id]; })
        .sort(function (a, b) { return b.start - a.start; });
      track.clips = track.clips.filter(function (c) { return !del[c.id]; });
      if (!ripple) return;
      gone.forEach(function (g) {
        var e = clipEnd(g);
        track.clips.forEach(function (c) {
          if (c.start >= e - EPS) c.start = Math.max(0, c.start - g.duration);
        });
      });
      sortTrack(track);
    });
  }

  // Delete a time range on the given tracks (all when omitted). With ripple the
  // later audio slides left; markers move with it when every track rippled.
  function deleteRange(p, t0, t1, trackIds, ripple) {
    if (t1 < t0) { var x = t0; t0 = t1; t1 = x; }
    var len = t1 - t0;
    if (len < EPS) return;
    var all = !trackIds || !trackIds.length || trackIds.length === p.tracks.length;
    p.tracks.forEach(function (track) {
      if (!all && trackIds.indexOf(track.id) === -1) return;
      carve(track, t0, t1);
      if (ripple) {
        track.clips.forEach(function (c) { if (c.start >= t1 - EPS) c.start -= len; });
        sortTrack(track);
      }
    });
    if (ripple && all) {
      p.markers = p.markers.filter(function (m) { return m.t < t0 || m.t >= t1; });
      p.markers.forEach(function (m) { if (m.t >= t1) m.t -= len; });
    }
  }

  // Keep only [t0, t1) and slide it to zero.
  function cropTo(p, t0, t1) {
    if (t1 < t0) { var x = t0; t0 = t1; t1 = x; }
    p.tracks.forEach(function (track) {
      carve(track, t1, Infinity);
      carve(track, 0, t0);
      track.clips.forEach(function (c) { c.start -= t0; });
    });
    p.markers = p.markers.filter(function (m) { return m.t >= t0 && m.t <= t1; });
    p.markers.forEach(function (m) { m.t -= t0; });
  }

  // Insert silence at t on the given tracks (all when omitted): everything at
  // or after t slides right, and a clip straddling t is split first.
  function insertGap(p, t, len, trackIds) {
    var all = !trackIds || !trackIds.length;
    p.tracks.forEach(function (track) {
      if (!all && trackIds.indexOf(track.id) === -1) return;
      var ids = track.clips.map(function (c) { return c.id; });
      splitAt(p, t, ids);
      track.clips.forEach(function (c) { if (c.start >= t - EPS) c.start += len; });
    });
    if (all) p.markers.forEach(function (m) { if (m.t >= t) m.t += len; });
  }

  // Copies placed straight after the group they duplicate, on the same tracks.
  function duplicate(p, ids) {
    var cb = copyClips(p, ids);
    if (!cb) return [];
    return paste(p, cb, cb.origin + cb.span, cb.originTrack);
  }

  function copyClips(p, ids) {
    var found = ids.map(function (id) { return findClip(p, id); }).filter(Boolean);
    if (!found.length) return null;
    var minStart = Infinity, maxEnd = 0, minTi = Infinity;
    found.forEach(function (f) {
      minStart = Math.min(minStart, f.clip.start);
      maxEnd = Math.max(maxEnd, clipEnd(f.clip));
      minTi = Math.min(minTi, f.ti);
    });
    var sources = {};
    return {
      origin: minStart,
      originTrack: minTi,
      span: maxEnd - minStart,
      clips: found.map(function (f) {
        sources[f.clip.sourceId] = p.sources[f.clip.sourceId];
        var c = cloneClip(f.clip);
        c.rel = f.clip.start - minStart;
        c.trackOffset = f.ti - minTi;
        return c;
      }),
      sources: sources
    };
  }

  // Paste at time t, first clip on track index ti. Adds tracks when the
  // clipboard is taller than what is below ti.
  function paste(p, cb, t, ti) {
    if (!cb) return [];
    Object.keys(cb.sources || {}).forEach(function (k) {
      if (!p.sources[k] && cb.sources[k]) p.sources[k] = cb.sources[k];
    });
    ti = Math.max(0, ti | 0);
    var made = [];
    cb.clips.forEach(function (c) {
      while (p.tracks.length <= ti + c.trackOffset) addTrack(p);
      var track = p.tracks[ti + c.trackOffset];
      var n = cloneClip(c);
      n.start = Math.max(0, t + c.rel);
      carve(track, n.start, clipEnd(n));
      track.clips.push(n);
      sortTrack(track);
      made.push(n.id);
    });
    return made;
  }

  // Point a clip at new audio (an effect's output). If the length changed,
  // later clips on the same track slide by the difference so nothing overlaps
  // and no gap opens up.
  // Pass ripple === false when the caller has already made sure the new length
  // fits (an effect tail cut to the gap before the next clip).
  function replaceSource(p, clipId, sourceId, newDuration, ripple) {
    var f = findClip(p, clipId);
    if (!f) return;
    var c = f.clip, oldEnd = clipEnd(c);
    var delta = newDuration - c.duration;
    c.sourceId = sourceId;
    c.offset = 0;
    c.duration = newDuration;
    fixFades(c);
    if (Math.abs(delta) > EPS && ripple !== false) {
      f.track.clips.forEach(function (o) {
        if (o !== c && o.start >= oldEnd - EPS) o.start += delta;
      });
      sortTrack(f.track);
    }
  }

  // Unused sources are dropped when the project is stored, not here: an undo
  // snapshot may still point at one.
  function usedSources(p) {
    var used = {};
    p.tracks.forEach(function (t) { t.clips.forEach(function (c) { used[c.sourceId] = true; }); });
    return used;
  }

  /* -------------------------------------------------------------- markers */

  function addMarker(p, t, label) {
    var m = { id: uid('m'), t: Math.max(0, t), label: label || ('Marker ' + (p.markers.length + 1)) };
    p.markers.push(m);
    p.markers.sort(function (a, b) { return a.t - b.t; });
    return m.id;
  }
  function removeMarker(p, id) {
    p.markers = p.markers.filter(function (m) { return m.id !== id; });
  }

  /* ----------------------------------------------------------------- snap */

  // Nearest snap target within `tol` seconds of t: time zero, the playhead,
  // markers, and the edges of clips not in `exclude`.
  function snapPoints(p, exclude, extra) {
    var pts = [0];
    p.tracks.forEach(function (t) {
      t.clips.forEach(function (c) {
        if (exclude && exclude[c.id]) return;
        pts.push(c.start, clipEnd(c));
      });
    });
    p.markers.forEach(function (m) { pts.push(m.t); });
    (extra || []).forEach(function (x) { if (x != null) pts.push(x); });
    return pts;
  }

  function snap(t, pts, tol) {
    var best = null, bd = tol;
    for (var i = 0; i < pts.length; i++) {
      var d = Math.abs(pts[i] - t);
      if (d <= bd) { bd = d; best = pts[i]; }
    }
    return best;
  }

  /* ------------------------------------------------------------ gain maths */

  // Equal-power fade shape. Shared by the live engine, the offline export and
  // the waveform drawing, so what is drawn is what is heard.
  function fadeShape(x) { return Math.sin(clamp(x, 0, 1) * Math.PI / 2); }

  // Linear gain of a clip at local time tl (seconds from the clip's start).
  function clipGainAt(c, tl) {
    var g = dbToGain(c.gainDb || 0);
    if (c.fadeIn > 0 && tl < c.fadeIn) g *= fadeShape(tl / c.fadeIn);
    var fo = c.duration - (c.fadeOut || 0);
    if (c.fadeOut > 0 && tl > fo) g *= fadeShape((c.duration - tl) / c.fadeOut);
    return g;
  }

  function audibleTracks(p) {
    var anySolo = p.tracks.some(function (t) { return t.solo; });
    var out = {};
    p.tracks.forEach(function (t) { out[t.id] = !t.mute && (!anySolo || t.solo); });
    return out;
  }

  /* ------------------------------------------------------------- validate */

  function validate(p) {
    var errs = [];
    p.tracks.forEach(function (t, ti) {
      for (var i = 0; i < t.clips.length; i++) {
        var c = t.clips[i], where = 'track ' + ti + ' clip ' + i + ': ';
        if (c.start < -EPS) errs.push(where + 'negative start ' + c.start);
        if (c.offset < -EPS) errs.push(where + 'negative offset ' + c.offset);
        if (c.duration < 0.0009) errs.push(where + 'degenerate duration ' + c.duration);
        var sl = sourceLen(p, c);
        if (c.offset + c.duration > sl + 1e-4) errs.push(where + 'runs past its source (' + (c.offset + c.duration) + ' > ' + sl + ')');
        if (c.fadeIn < -EPS || c.fadeOut < -EPS || c.fadeIn + c.fadeOut > c.duration + 1e-4) errs.push(where + 'fades out of range');
        if (!p.sources[c.sourceId]) errs.push(where + 'missing source ' + c.sourceId);
        if (i > 0) {
          var prev = t.clips[i - 1];
          if (prev.start > c.start + EPS) errs.push(where + 'not sorted');
          if (clipEnd(prev) > c.start + 1e-4) errs.push(where + 'overlaps the clip before it by ' + (clipEnd(prev) - c.start));
        }
      }
    });
    return errs;
  }

  /* -------------------------------------------------------------- history */

  // Undo stack of serialised snapshots. One gesture is one entry: the caller
  // takes a snapshot on pointerdown and commits it on pointerup only if the
  // project actually changed.
  function History(limit) {
    this.undoStack = [];
    this.redoStack = [];
    this.limit = limit || 200;
  }
  History.prototype.push = function (snapshot) {
    this.undoStack.push(snapshot);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  };
  History.prototype.undo = function (current) {
    if (!this.undoStack.length) return null;
    this.redoStack.push(current);
    return this.undoStack.pop();
  };
  History.prototype.redo = function (current) {
    if (!this.redoStack.length) return null;
    this.undoStack.push(current);
    return this.redoStack.pop();
  };
  History.prototype.canUndo = function () { return this.undoStack.length > 0; };
  History.prototype.canRedo = function () { return this.redoStack.length > 0; };

  var api = {
    EPS: EPS, MIN_LEN: MIN_LEN,
    uid: uid, create: create, serialize: serialize, parse: parse, copy: copy,
    trackIndex: trackIndex, findClip: findClip, allClips: allClips, duration: duration,
    clipEnd: clipEnd, dbToGain: dbToGain,
    addSource: addSource, addTrack: addTrack, removeTrack: removeTrack, moveTrack: moveTrack, setTrack: setTrack,
    addClip: addClip, setClip: setClip, trimStart: trimStart, trimEnd: trimEnd, setFade: setFade,
    moveClips: moveClips, splitAt: splitAt, deleteClips: deleteClips, deleteRange: deleteRange,
    cropTo: cropTo, insertGap: insertGap, duplicate: duplicate, copyClips: copyClips, paste: paste,
    replaceSource: replaceSource, usedSources: usedSources, carve: carve,
    addMarker: addMarker, removeMarker: removeMarker,
    snapPoints: snapPoints, snap: snap,
    fadeShape: fadeShape, clipGainAt: clipGainAt, audibleTracks: audibleTracks,
    validate: validate, History: History
  };

  global.ASEditModel = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
