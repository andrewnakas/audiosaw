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
    return normalize({ v: 1, name: name || 'Untitled project', tracks: [], sources: {}, markers: [] });
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
      clips: [], fx: [], sends: {}, auto: {}
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
    // carve() can leave a sliver shorter than MIN_LEN. Such a clip may grow
    // but not shrink; forcing it up to MIN_LEN here used to pull its start
    // back into the clip before it.
    var hi = Math.max(clipEnd(c) - MIN_LEN, c.start);
    if (hi < lo) return;
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
    var lo = Math.min(c.start + MIN_LEN, clipEnd(c));   // see trimStart
    if (lo > hi) return;
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
        autoCut(track.auto, g.start, e);
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
        autoCut(track.auto, t0, t1);
      }
    });
    if (ripple && all) {
      if (p.master) autoCut(p.master.auto, t0, t1);
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
      autoCrop(track.auto, t0, t1);
    });
    if (p.master) autoCrop(p.master.auto, t0, t1);
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
      autoInsert(track.auto, t, len);
    });
    if (all) {
      p.markers.forEach(function (m) { if (m.t >= t) m.t += len; });
      if (p.master) autoInsert(p.master.auto, t, len);
    }
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

  // The same, for audio coming back from a tool page. That result has no
  // fitTail to keep it inside the gap, so when the caller asks not to ripple
  // (a same-length tool whose output ran a few ms long) whatever it now
  // overlaps is carved rather than left overlapping.
  function replaceClipAudio(p, clipId, sourceId, newDuration, ripple) {
    replaceSource(p, clipId, sourceId, newDuration, ripple);
    if (ripple !== false) return;
    var f = findClip(p, clipId);
    if (!f) return;
    var keep = {};
    keep[clipId] = true;
    carve(f.track, f.clip.start, clipEnd(f.clip), keep);
  }

  // Replace [t0, t1) on the given tracks with one clip of `sourceId`, `dur`
  // long. With ripple the range becomes exactly `dur` long on those tracks
  // (later clips, automation, and markers when every track is covered, move
  // by the difference); without it the range is cleared and the new clip
  // overwrites whatever it runs over. opts.newTrack {index, name} puts the
  // clip on a new track instead of the first one covered: a bounce of several
  // tracks into one. Returns the new clip's id.
  function replaceRange(p, trackIds, t0, t1, sourceId, dur, opts) {
    opts = opts || {};
    if (t1 < t0) { var x = t0; t0 = t1; t1 = x; }
    var ids = (trackIds && trackIds.length ? trackIds : p.tracks.map(function (t) { return t.id; }))
      .filter(function (id) { return trackIndex(p, id) >= 0; });
    if (!ids.length && !opts.newTrack) return null;
    var all = ids.length === p.tracks.length;
    if (opts.ripple && Math.abs(dur - (t1 - t0)) > EPS) {
      deleteRange(p, t0, t1, all ? null : ids, true);
      insertGap(p, t0, dur, all ? null : ids);
    } else {
      ids.forEach(function (id) { carve(p.tracks[trackIndex(p, id)], t0, t1); });
    }
    var dest = opts.newTrack ? addTrack(p, { index: opts.newTrack.index, name: opts.newTrack.name }) : ids[0];
    return addClip(p, dest, { sourceId: sourceId, start: t0, duration: dur, name: opts.name });
  }

  // A new track at `index` holding one clip of the whole source. Returns the
  // clip id. Used for the extra outputs of a tool that returns several files.
  function placeOnNewTrack(p, index, sourceId, start, name) {
    var tid = addTrack(p, { index: index, name: name });
    return addClip(p, tid, { sourceId: sourceId, start: start, name: name });
  }

  // What a tool page was handed, reduced to the numbers that decide whether
  // its result still fits. Position is left out on purpose: moving a clip
  // after sending it does not make the result wrong.
  //
  // For a range it is every clip that overlaps it on the tracks it covered,
  // position included, since there the position is the content.
  function targetPrint(p, ref) {
    if (ref && ref.kind === 'range') {
      var parts = [], alive = 0;
      (ref.trackIds || []).forEach(function (id) {
        var i = trackIndex(p, id);
        if (i < 0) return;
        alive++;
        p.tracks[i].clips.forEach(function (c) {
          if (c.start >= ref.t1 - EPS || clipEnd(c) <= ref.t0 + EPS) return;
          parts.push([id, c.id, c.sourceId, c.start.toFixed(6), c.offset.toFixed(6), c.duration.toFixed(6),
            c.gainDb || 0, c.fadeIn || 0, c.fadeOut || 0].join(','));
        });
      });
      return alive ? 'r|' + parts.join(';') : 'gone';
    }
    var f = findClip(p, ref && ref.clipId);
    if (!f) return 'gone';
    var c = f.clip;
    return 'c|' + c.sourceId + '|' + c.offset.toFixed(6) + '|' + c.duration.toFixed(6);
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


  /* ---------------------------------------------------------------- mixer */

  /*
   * Real-time effects, sends and automation. Like everything else here these
   * are plain JSON on the project, so undo, autosave and .audiosaw files carry
   * them without any code of their own.
   *
   * A chain belongs to an "owner": a track id, 'master', or a bus id. Each
   * slot is {id, type, on, params, m} — m holds the smart-control (macro)
   * positions, or is absent when the params have been set by hand and no
   * longer sit on a macro curve. The model does not know what a plugin is;
   * editor-dsp.js owns the catalogue and fills in any missing params.
   *
   * Automation lives on the owner as auto[path] = [[t, v], ...], sorted by t,
   * linear between points and flat before the first and after the last.
   * Paths: 'vol', 'pan', 'send:<busId>', 'fx:<fxId>:<param>'.
   */

  var DEFAULT_BUSES = [
    { id: 'bus-reverb', name: 'Reverb', fx: 'reverb' },
    { id: 'bus-delay', name: 'Delay', fx: 'delay' }
  ];

  // Fill in what an older project (or one from before this code) is missing.
  // Idempotent: normalize(normalize(p)) is normalize(p).
  function normalize(p) {
    // An identity, so a result coming back from a tool page can tell whether
    // the project it was cut from is the one that is open.
    if (!p.id) p.id = uid('p');
    p.tracks = p.tracks || [];
    p.sources = p.sources || {};
    p.markers = p.markers || [];
    p.tracks.forEach(function (t) {
      if (!Array.isArray(t.fx)) t.fx = [];
      if (!t.sends || typeof t.sends !== 'object') t.sends = {};
      if (!t.auto || typeof t.auto !== 'object') t.auto = {};
    });
    if (!p.master || typeof p.master !== 'object') p.master = {};
    if (typeof p.master.volDb !== 'number') p.master.volDb = 0;
    if (!Array.isArray(p.master.fx)) p.master.fx = [];
    if (!p.master.auto || typeof p.master.auto !== 'object') p.master.auto = {};
    if (!Array.isArray(p.buses)) {
      // Two returns ready to use, so a send does something the first time.
      // The reverb and delay on them are 100% wet: the dry sound is already
      // on the track.
      p.buses = DEFAULT_BUSES.map(function (b) {
        return { id: b.id, name: b.name, volDb: 0, fx: [{ id: uid('f'), type: b.fx, on: true, params: { mix: 100 } }] };
      });
    }
    p.buses.forEach(function (b) {
      if (!Array.isArray(b.fx)) b.fx = [];
      if (typeof b.volDb !== 'number') b.volDb = 0;
    });
    if (!(p.bpm > 0)) p.bpm = 120;
    if (!validSig(p.sig)) p.sig = [4, 4];
    if (!(typeof p.gridOffset === 'number' && isFinite(p.gridOffset))) p.gridOffset = 0;
    if (p.ruler !== 'bars') p.ruler = 'time';
    if (!validKey(p.key)) p.key = null;
    return p;
  }

  function owner(p, key) {
    if (key === 'master') return p.master;
    var i = trackIndex(p, key);
    if (i >= 0) return p.tracks[i];
    for (var b = 0; b < (p.buses || []).length; b++) if (p.buses[b].id === key) return p.buses[b];
    return null;
  }
  function chainOf(p, key) { var o = owner(p, key); return o ? o.fx : null; }

  function fxIndex(chain, fxId) {
    for (var i = 0; i < chain.length; i++) if (chain[i].id === fxId) return i;
    return -1;
  }

  function findFx(p, fxId) {
    var keys = ['master'].concat(p.tracks.map(function (t) { return t.id; }), (p.buses || []).map(function (b) { return b.id; }));
    for (var k = 0; k < keys.length; k++) {
      var ch = chainOf(p, keys[k]), i = ch ? fxIndex(ch, fxId) : -1;
      if (i >= 0) return { owner: keys[k], chain: ch, index: i, fx: ch[i] };
    }
    return null;
  }

  function cleanParams(params) {
    var out = {};
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (typeof v === 'number' ? isFinite(v) : typeof v === 'string' || typeof v === 'boolean') out[k] = v;
    });
    return out;
  }

  function addFx(p, key, type, params, index, m) {
    var ch = chainOf(p, key);
    if (!ch) return null;
    var slot = { id: uid('f'), type: String(type), on: true, params: cleanParams(params) };
    if (m) slot.m = cleanParams(m);
    if (index == null || index > ch.length) ch.push(slot);
    else ch.splice(Math.max(0, index), 0, slot);
    return slot.id;
  }

  // Removing a plugin removes its automation too, or a lane would point at nothing.
  function removeFx(p, key, fxId) {
    var o = owner(p, key);
    if (!o) return;
    var i = fxIndex(o.fx, fxId);
    if (i < 0) return;
    o.fx.splice(i, 1);
    if (o.auto) Object.keys(o.auto).forEach(function (path) {
      if (path.indexOf('fx:' + fxId + ':') === 0) delete o.auto[path];
    });
  }

  function moveFx(p, key, fxId, to) {
    var ch = chainOf(p, key);
    if (!ch) return;
    var i = fxIndex(ch, fxId);
    if (i < 0) return;
    to = clamp(to | 0, 0, ch.length - 1);
    if (to === i) return;
    var s = ch.splice(i, 1)[0];
    ch.splice(to, 0, s);
  }

  // patch: {on?, params?, m?}. params merge; m === null drops the macro
  // positions (the params were set by hand), an object merges.
  function setFx(p, key, fxId, patch) {
    var ch = chainOf(p, key);
    if (!ch) return;
    var i = fxIndex(ch, fxId);
    if (i < 0) return;
    var s = ch[i];
    if (patch.on !== undefined) s.on = !!patch.on;
    if (patch.params) {
      var pp = cleanParams(patch.params);
      Object.keys(pp).forEach(function (k) { s.params[k] = pp[k]; });
    }
    if (patch.m === null) delete s.m;
    else if (patch.m) { s.m = s.m || {}; var mm = cleanParams(patch.m); Object.keys(mm).forEach(function (k) { s.m[k] = mm[k]; }); }
  }

  // Replace a whole chain (a patch). Every slot gets a fresh id, and the old
  // chain's automation goes with it.
  function setChain(p, key, list) {
    var o = owner(p, key);
    if (!o) return [];
    if (o.auto) Object.keys(o.auto).forEach(function (path) { if (path.indexOf('fx:') === 0) delete o.auto[path]; });
    o.fx = (list || []).map(function (s) {
      var slot = { id: uid('f'), type: String(s.type), on: s.on !== false, params: cleanParams(s.params) };
      if (s.m) slot.m = cleanParams(s.m);
      return slot;
    });
    return o.fx.map(function (s) { return s.id; });
  }

  // A send level in dB. -60 or below removes it.
  function setSend(p, trackId, busId, db) {
    var i = trackIndex(p, trackId);
    if (i < 0 || !owner(p, busId)) return;
    var t = p.tracks[i];
    db = +db;
    if (!(db > -60)) delete t.sends[busId];
    else t.sends[busId] = clamp(db, -60, 6);
  }

  function addBus(p, name) {
    var id = uid('b');
    p.buses.push({ id: id, name: name || ('Bus ' + (p.buses.length + 1)), volDb: 0, fx: [] });
    return id;
  }

  function removeBus(p, busId) {
    p.buses = p.buses.filter(function (b) { return b.id !== busId; });
    p.tracks.forEach(function (t) {
      delete t.sends[busId];
      delete t.auto['send:' + busId];
    });
  }

  function setBus(p, busId, patch) {
    var b = owner(p, busId);
    if (!b || b === p.master || b.clips) return;
    if (patch.name !== undefined) b.name = String(patch.name).slice(0, 40) || b.name;
    if (patch.volDb !== undefined) b.volDb = clamp(+patch.volDb || 0, -60, 12);
  }

  function setMaster(p, patch) {
    if (patch.volDb !== undefined) p.master.volDb = clamp(+patch.volDb || 0, -60, 12);
  }

  function setBpm(p, bpm) {
    bpm = +bpm;
    if (bpm >= 20 && bpm <= 400) p.bpm = Math.round(bpm * 100) / 100;
    if (validSig(p.sig)) setGridOffset(p, p.gridOffset || 0);
  }

  /* ---------------------------------------------------------- bars, beats */

  // The tempo counts quarter notes whatever the metre, the way every DAW
  // does, so a beat is the denominator's note: in 6/8 at 120 a beat is an
  // eighth, 0.25 s. Bar 1 starts at gridOffset, which is how a grid is lined
  // up with a recording that does not begin on the downbeat at 0:00.
  var DENS = [2, 4, 8, 16];
  function validSig(s) {
    return Array.isArray(s) && s.length === 2 && s[0] === Math.round(s[0]) && s[0] >= 1 && s[0] <= 15 && DENS.indexOf(s[1]) >= 0;
  }
  function setSig(p, num, den) {
    num = Math.round(+num); den = +den;
    if (validSig([num, den])) p.sig = [num, den];
    setGridOffset(p, p.gridOffset || 0);
  }
  function setGridOffset(p, t) {
    t = +t;
    if (!isFinite(t)) return;
    // Only the phase matters, so keep it inside one bar: an offset of 7.3 s
    // and one of 7.3 s less a whole number of bars draw the same grid.
    var bar = barSec(p);
    p.gridOffset = Math.round((((t % bar) + bar) % bar) * 1e6) / 1e6;
    if (p.gridOffset > bar - 1e-6) p.gridOffset = 0;
  }
  // The project's key, {pc: 0-11, mode: 'major'|'minor'}, or null when it
  // has not been set. Nothing is transposed by it; it is a label that the
  // key-aware tools read.
  function validKey(k) {
    return k === null || (!!k && k.pc === Math.round(k.pc) && k.pc >= 0 && k.pc <= 11 && (k.mode === 'major' || k.mode === 'minor'));
  }
  function setKey(p, pc, mode) {
    var k = pc == null ? null : { pc: +pc, mode: mode };
    if (validKey(k)) p.key = k;
  }
  function setRuler(p, mode) { p.ruler = mode === 'bars' ? 'bars' : 'time'; }

  function beatSec(p) { return 60 / p.bpm * 4 / p.sig[1]; }
  function barSec(p) { return beatSec(p) * p.sig[0]; }

  // Where a count of beats from bar 1 falls in the bar. Rounding first keeps
  // 3.9999999 from reading as beat 3 of the previous bar.
  function beatPos(p, beats) {
    var num = p.sig[0], b = Math.round(beats * 1e6) / 1e6;
    var bar = Math.floor(b / num), inBar = b - bar * num, beat = Math.floor(inBar + 1e-6);
    return { bar: bar + 1, beat: beat + 1, sub: Math.max(0, inBar - beat) };
  }

  // Accent a click the way it is counted: the downbeat highest, and in a
  // compound metre (6/8, 9/8, 12/8) the start of each group of three.
  function accentOf(p, beat) {
    if (beat === 1) return 2;
    var num = p.sig[0];
    return p.sig[1] >= 8 && num > 3 && num % 3 === 0 && (beat - 1) % 3 === 0 ? 1 : 0;
  }

  // Grid lines every `div` beats in [t0, t1]: {t, bar, beat, sub, level},
  // level 2 on a bar line, 1 on a beat, 0 between.
  function gridLines(p, t0, t1, div) {
    var step = beatSec(p) * div, off = p.gridOffset, out = [];
    if (!(step > 0) || t1 < t0) return out;
    var k0 = Math.ceil((t0 - off) / step - 1e-9), k1 = Math.floor((t1 - off) / step + 1e-9);
    if (k1 - k0 > 20000) k1 = k0 + 20000;
    for (var k = k0; k <= k1; k++) {
      var pos = beatPos(p, k * div);
      pos.t = off + k * step;
      pos.level = pos.sub > 1e-6 ? 0 : pos.beat === 1 ? 2 : 1;
      out.push(pos);
    }
    return out;
  }

  function nearestGrid(p, t, div) {
    var step = beatSec(p) * div, off = p.gridOffset;
    return off + Math.round((t - off) / step) * step;
  }

  // "5.3" (bar 5, beat 3), with a sixteenth-style third field only when the
  // grid is finer than a beat: "5.3.2".
  function fmtBars(p, t, div) {
    var pos = beatPos(p, (t - p.gridOffset) / beatSec(p));
    if (div != null && div >= p.sig[0] && pos.beat === 1 && pos.sub < 1e-6) return String(pos.bar);
    if (div != null && div >= 1) return pos.bar + '.' + pos.beat;
    return pos.bar + '.' + pos.beat + '.' + (Math.floor(pos.sub * 4 + 1e-6) + 1);
  }

  // Metronome clicks in [from, to): {t, accent}. The engine only turns these
  // into context times, so the maths is here where Node can check it.
  function clickTimes(p, from, to) {
    return gridLines(p, from, to, 1).filter(function (g) { return g.t < to - 1e-9; })
      .map(function (g) { return { t: g.t, accent: accentOf(p, g.beat) }; });
  }

  /* ----------------------------------------------------------- automation */

  function setAutoPoints(p, key, path, points) {
    var o = owner(p, key);
    if (!o || !o.auto) return;
    var pts = (points || []).filter(function (pt) { return pt && isFinite(pt[0]) && isFinite(pt[1]); })
      .map(function (pt) { return [Math.max(0, +pt[0]), +pt[1]]; })
      .sort(function (a, b) { return a[0] - b[0]; });
    if (pts.length) o.auto[path] = pts; else delete o.auto[path];
  }

  function clearAuto(p, key, path) {
    var o = owner(p, key);
    if (o && o.auto) delete o.auto[path];
  }

  // Value of a lane at time t: linear between points, flat outside them.
  function autoValueAt(pts, t) {
    if (!pts || !pts.length) return null;
    if (t <= pts[0][0]) return pts[0][1];
    var n = pts.length;
    if (t >= pts[n - 1][0]) return pts[n - 1][1];
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (pts[mid][0] <= t) lo = mid; else hi = mid; }
    var a = pts[lo], b = pts[hi], span = b[0] - a[0];
    return span < EPS ? b[1] : a[1] + (b[1] - a[1]) * (t - a[0]) / span;
  }

  // Automation follows the audio when time is removed or inserted, so a fade
  // drawn under a chorus is still under it after the verse before is cut.
  // The value at each cut edge is pinned first, so the shape either side is
  // kept rather than re-interpolated across the join.
  function autoCut(auto, t0, t1) {
    var len = t1 - t0;
    Object.keys(auto || {}).forEach(function (path) {
      var pts = auto[path];
      var v0 = autoValueAt(pts, t0), v1 = autoValueAt(pts, t1);
      var out = [];
      pts.forEach(function (pt) { if (pt[0] < t0 - EPS) out.push(pt); });
      out.push([t0, v0]);
      if (Math.abs(v1 - v0) > EPS) out.push([t0 + 1e-4, v1]);
      pts.forEach(function (pt) { if (pt[0] > t1 + EPS) out.push([pt[0] - len, pt[1]]); });
      auto[path] = dedupe(out);
    });
  }

  function autoInsert(auto, t, len) {
    Object.keys(auto || {}).forEach(function (path) {
      var pts = auto[path], v = autoValueAt(pts, t);
      var out = [];
      var before = pts.some(function (pt) { return pt[0] < t - EPS; });
      var after = pts.some(function (pt) { return pt[0] >= t - EPS; });
      pts.forEach(function (pt) { out.push(pt[0] >= t - EPS ? [pt[0] + len, pt[1]] : pt); });
      if (before && after) out.push([t, v], [t + len, v]);
      auto[path] = dedupe(out.sort(function (a, b) { return a[0] - b[0]; }));
    });
  }

  function autoCrop(auto, t0, t1) {
    Object.keys(auto || {}).forEach(function (path) {
      var pts = auto[path];
      var v0 = autoValueAt(pts, t0), v1 = autoValueAt(pts, t1);
      var out = [[0, v0]];
      pts.forEach(function (pt) { if (pt[0] > t0 + EPS && pt[0] < t1 - EPS) out.push([pt[0] - t0, pt[1]]); });
      out.push([t1 - t0, v1]);
      auto[path] = dedupe(out);
    });
  }

  function dedupe(pts) {
    var out = [];
    pts.forEach(function (pt) {
      var last = out[out.length - 1];
      if (last && Math.abs(last[0] - pt[0]) < 1e-5 && Math.abs(last[1] - pt[1]) < 1e-9) return;
      out.push(pt);
    });
    // Three equal values in a row: the middle one says nothing.
    return out.filter(function (pt, i) {
      return !(i > 0 && i < out.length - 1 && Math.abs(out[i - 1][1] - pt[1]) < 1e-9 && Math.abs(out[i + 1][1] - pt[1]) < 1e-9);
    });
  }

  // Thin a recorded lane to the fewest points that stay within `tol` of it
  // (Ramer-Douglas-Peucker on value error).
  function thinPoints(pts, tol) {
    if (pts.length < 3) return pts.slice();
    var keep = new Array(pts.length);
    keep[0] = keep[pts.length - 1] = true;
    var stack = [[0, pts.length - 1]];
    while (stack.length) {
      var seg = stack.pop(), a = seg[0], b = seg[1];
      var worst = -1, wi = -1;
      for (var i = a + 1; i < b; i++) {
        var span = pts[b][0] - pts[a][0];
        var v = span < EPS ? pts[a][1] : pts[a][1] + (pts[b][1] - pts[a][1]) * (pts[i][0] - pts[a][0]) / span;
        var err = Math.abs(v - pts[i][1]);
        if (err > worst) { worst = err; wi = i; }
      }
      if (worst > tol) { keep[wi] = true; stack.push([a, wi], [wi, b]); }
    }
    return pts.filter(function (pt, i) { return keep[i]; });
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
      (t.fx || []).forEach(function (f, i) {
        if (!f || !f.id || !f.type || typeof f.params !== 'object') errs.push('track ' + ti + ' fx ' + i + ': malformed slot');
      });
      Object.keys(t.auto || {}).forEach(function (path) { autoErrs(t.auto[path], 'track ' + ti + ' lane ' + path, errs); });
      Object.keys(t.sends || {}).forEach(function (b) {
        if (!(p.buses || []).some(function (x) { return x.id === b; })) errs.push('track ' + ti + ': send to a missing bus ' + b);
      });
    });
    if (!(p.bpm >= 20 && p.bpm <= 400)) errs.push('tempo out of range: ' + p.bpm);
    if (!validSig(p.sig)) errs.push('bad time signature ' + JSON.stringify(p.sig));
    if (p.key !== undefined && !validKey(p.key)) errs.push('bad key ' + JSON.stringify(p.key));
    else if (!(p.gridOffset >= 0 && p.gridOffset < barSec(p) + EPS)) errs.push('grid offset outside one bar: ' + p.gridOffset);
    if (p.master) Object.keys(p.master.auto || {}).forEach(function (path) { autoErrs(p.master.auto[path], 'master lane ' + path, errs); });
    return errs;
  }

  function autoErrs(pts, where, errs) {
    if (!Array.isArray(pts) || !pts.length) { errs.push(where + ': empty lane'); return; }
    for (var i = 0; i < pts.length; i++) {
      if (pts[i][0] < -EPS) errs.push(where + ': negative time');
      if (!isFinite(pts[i][1])) errs.push(where + ': bad value');
      if (i && pts[i][0] < pts[i - 1][0] - EPS) errs.push(where + ': not sorted');
    }
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
    replaceClipAudio: replaceClipAudio, replaceRange: replaceRange, placeOnNewTrack: placeOnNewTrack, targetPrint: targetPrint,
    addMarker: addMarker, removeMarker: removeMarker,
    snapPoints: snapPoints, snap: snap,
    fadeShape: fadeShape, clipGainAt: clipGainAt, audibleTracks: audibleTracks,
    normalize: normalize, owner: owner, chainOf: chainOf, findFx: findFx,
    addFx: addFx, removeFx: removeFx, moveFx: moveFx, setFx: setFx, setChain: setChain,
    setSend: setSend, addBus: addBus, removeBus: removeBus, setBus: setBus, setMaster: setMaster, setBpm: setBpm,
    setSig: setSig, setGridOffset: setGridOffset, setRuler: setRuler, setKey: setKey, beatSec: beatSec, barSec: barSec,
    gridLines: gridLines, nearestGrid: nearestGrid, fmtBars: fmtBars, clickTimes: clickTimes,
    setAutoPoints: setAutoPoints, clearAuto: clearAuto, autoValueAt: autoValueAt, thinPoints: thinPoints,
    validate: validate, History: History
  };

  global.ASEditModel = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
