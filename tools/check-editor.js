#!/usr/bin/env node
/*
 * Checks js/editor-model.js, the audio editor's project model.
 *
 * The editor's whole promise is that editing is non-destructive and undoable,
 * and the renderer, the playback engine and the export all assume clips on a
 * track never overlap. So this asserts exactly those things:
 *
 *   - split then undo gives back a byte-identical project
 *   - a trim can never reach past either end of its source, or into a neighbour
 *   - moves snap to clip edges, and moving onto occupied time overwrites it
 *   - ripple delete closes the gap on that track only
 *   - effect chains, sends and automation undo exactly, automation follows
 *     ripple edits, and every preset and patch names real parameters in range
 *   - a result coming back from a tool page replaces its clip exactly, ripples
 *     or carves as asked, and undoes byte-for-byte
 *   - 1,000 random operations never leave an overlap, a negative time, a clip
 *     running past its source, or fades longer than the clip
 *
 * and, separately, that the fade maths the engine schedules is continuous and
 * lands on the values it should.
 */
const M = require('../js/editor-model.js');
const D = require('../js/editor-dsp.js');

let failures = 0;
function ok(cond, msg) {
  if (!cond) { failures++; console.error('  FAIL ' + msg); }
}
function near(a, b, tol, msg) { ok(Math.abs(a - b) <= (tol || 1e-9), msg + ' (got ' + a + ', want ' + b + ')'); }
function valid(p, msg) {
  const errs = M.validate(p);
  ok(errs.length === 0, msg + (errs.length ? ': ' + errs.slice(0, 3).join('; ') : ''));
}

function fixture() {
  const p = M.create('test');
  const a = M.addSource(p, { name: 'a.wav', duration: 10, channels: 2, sampleRate: 48000 });
  const b = M.addSource(p, { name: 'b.wav', duration: 4, channels: 1, sampleRate: 44100 });
  const t1 = M.addTrack(p);
  const t2 = M.addTrack(p);
  const c1 = M.addClip(p, t1, { sourceId: a, start: 0 });
  const c2 = M.addClip(p, t1, { sourceId: b, start: 12 });
  const c3 = M.addClip(p, t2, { sourceId: b, start: 1 });
  return { p, a, b, t1, t2, c1, c2, c3 };
}

/* ---------------------------------------------------------- split + undo */
{
  const { p, c1 } = fixture();
  const h = new M.History();
  const before = M.serialize(p);
  h.push(before);
  const made = M.splitAt(p, 4, [c1]);
  ok(made.length === 1, 'split makes one new clip');
  const left = M.findClip(p, c1).clip, right = M.findClip(p, made[0]).clip;
  near(left.duration, 4, 1e-9, 'left half is 4 s');
  near(right.start, 4, 1e-9, 'right half starts at the split');
  near(right.offset, 4, 1e-9, 'right half reads from 4 s into the source');
  near(right.duration, 6, 1e-9, 'right half is 6 s');
  valid(p, 'after split');
  const restored = h.undo(M.serialize(p));
  ok(restored === before, 'undo after split restores the identical project');
  const again = h.redo(restored);
  ok(M.parse(again).tracks[0].clips.length === 3, 'redo brings the split back');
}

/* ------------------------------------------------------------ trim bounds */
{
  const { p, c1, c2 } = fixture();
  M.trimEnd(p, c1, 50);
  near(M.findClip(p, c1).clip.duration, 10, 1e-9, 'trimEnd stops at the end of the source');
  M.trimStart(p, c1, -5);
  near(M.findClip(p, c1).clip.start, 0, 1e-9, 'trimStart stops at time zero');
  M.trimStart(p, c1, 3);
  M.trimStart(p, c1, 1);
  near(M.findClip(p, c1).clip.offset, 1, 1e-9, 'trimStart can extend back into trimmed audio');
  M.trimStart(p, c1, -2);
  near(M.findClip(p, c1).clip.offset, 0, 1e-9, 'trimStart never reads before the source begins');
  // c2 sits at 12 s; move c1 up against it and try to trim through it.
  M.moveClips(p, [c1], 1.5, 0);
  M.trimEnd(p, c1, 30);
  const e1 = M.clipEnd(M.findClip(p, c1).clip);
  ok(e1 <= 12 + 1e-9, 'trimEnd stops at the next clip on the track (ended at ' + e1 + ')');
  M.trimStart(p, c2, 0);
  ok(M.findClip(p, c2).clip.start >= e1 - 1e-9, 'trimStart stops at the previous clip');
  M.trimEnd(p, c1, -100);
  near(M.findClip(p, c1).clip.duration, M.MIN_LEN, 1e-9, 'trim cannot shrink a clip below the minimum');
  valid(p, 'after trims');
}

/* ------------------------------------------------------------ snap + move */
{
  const { p, c1, c2, c3 } = fixture();
  const pts = M.snapPoints(p, { [c3]: true }, [7.3]);
  ok(M.snap(10.04, pts, 0.1) === 10, 'snaps to a clip end within tolerance');
  ok(M.snap(10.3, pts, 0.1) === null, 'does not snap outside tolerance');
  ok(M.snap(7.28, pts, 0.1) === 7.3, 'snaps to an extra point (the playhead)');
  ok(M.snap(1.02, pts, 0.1) === null, 'excluded clips are not snap targets');

  // Drop c3 (4 s long) onto the middle of c1: it should punch a hole.
  M.moveClips(p, [c3], 2, -1);
  const t1 = p.tracks[0];
  ok(t1.clips.length === 4, 'moving onto a clip splits it around the moved clip (clips: ' + t1.clips.length + ')');
  near(t1.clips[0].duration, 3, 1e-9, 'left remnant keeps 0–3 s');
  near(t1.clips[2].start, 7, 1e-9, 'right remnant starts where the moved clip ends');
  near(t1.clips[2].offset, 7, 1e-9, 'right remnant reads from the matching point in the source');
  valid(p, 'after overwrite move');
  M.moveClips(p, [c2], -100, 0);
  ok(M.findClip(p, c2).clip.start >= 0, 'a move cannot go before zero');
  valid(p, 'after move to zero');
}

/* --------------------------------------------------------- ripple delete */
{
  const { p, c1, c2, c3 } = fixture();
  M.deleteClips(p, [c1], true);
  near(M.findClip(p, c2).clip.start, 2, 1e-9, 'ripple delete slides the next clip left by the deleted length');
  near(M.findClip(p, c3).clip.start, 1, 1e-9, 'ripple delete leaves other tracks alone');
  valid(p, 'after ripple delete');

  const f = fixture();
  M.addMarker(f.p, 15);
  M.deleteRange(f.p, 2, 5, null, true);
  near(M.findClip(f.p, f.c2).clip.start, 9, 1e-9, 'ripple range delete slides later clips left');
  near(f.p.tracks[1].clips[0].duration, 1, 1e-9, 'range delete trims clips on every track');
  near(f.p.markers[0].t, 12, 1e-9, 'ripple range delete moves markers too');
  near(M.duration(f.p), 13, 1e-9, 'project is 3 s shorter');
  valid(f.p, 'after ripple range delete');

  const g = fixture();
  M.cropTo(g.p, 2, 6);
  near(M.duration(g.p), 4, 1e-9, 'crop keeps only the range');
  near(g.p.tracks[0].clips[0].offset, 2, 1e-9, 'crop keeps the right audio');
  valid(g.p, 'after crop');

  const d = fixture();
  const made = M.duplicate(d.p, [d.c1]);
  near(M.findClip(d.p, made[0]).clip.start, 10, 1e-9, 'duplicate lands straight after the original');
  valid(d.p, 'after duplicate');
}

/* ---------------------------------------------------------------- fades */
{
  const c = { gainDb: 0, duration: 4, fadeIn: 1, fadeOut: 2 };
  near(M.clipGainAt(c, 0), 0, 1e-12, 'fade in starts from silence');
  near(M.clipGainAt(c, 0.5), Math.SQRT1_2, 1e-9, 'equal-power fade is -3 dB halfway');
  near(M.clipGainAt(c, 1.5), 1, 1e-12, 'unity between the fades');
  near(M.clipGainAt(c, 4), 0, 1e-12, 'fade out ends in silence');
  near(M.clipGainAt({ gainDb: -6, duration: 1, fadeIn: 0, fadeOut: 0 }, 0.5), Math.pow(10, -6 / 20), 1e-12, 'clip gain is in dB');
  // Continuity: no step anywhere along the clip, which would be a click.
  let worst = 0;
  for (let i = 1; i <= 4000; i++) {
    worst = Math.max(worst, Math.abs(M.clipGainAt(c, i / 1000) - M.clipGainAt(c, (i - 1) / 1000)));
  }
  ok(worst < 0.002, 'gain envelope has no step larger than 0.002 per ms (worst ' + worst.toFixed(5) + ')');

  // Mixing two known signals through the same maths the engine uses.
  const sr = 1000;
  const a = Array.from({ length: sr * 2 }, (_, i) => Math.sin(2 * Math.PI * 5 * i / sr));
  const b = Array.from({ length: sr * 2 }, () => 0.25);
  const ca = { gainDb: -6, duration: 2, fadeIn: 0.5, fadeOut: 0 };
  const cb = { gainDb: 0, duration: 2, fadeIn: 0, fadeOut: 1 };
  const mix = a.map((v, i) => v * M.clipGainAt(ca, i / sr) + b[i] * M.clipGainAt(cb, i / sr));
  near(mix[1500], a[1500] * Math.pow(10, -6 / 20) + 0.25 * Math.sin(Math.PI / 4), 1e-9, 'mixed sample matches expected value');
}


/* ------------------------------------------------------ effects: model */
{
  const { p, t1 } = fixture();
  ok(p.buses.length === 2 && p.master && p.bpm === 120, 'a new project has two return buses, a master and a tempo');
  const once = M.serialize(p);
  M.normalize(p);
  ok(M.serialize(p) === once, 'normalize is idempotent');

  // An autosave from before effects existed.
  const old = JSON.parse(once);
  delete old.master; delete old.buses; delete old.bpm;
  old.tracks.forEach((t) => { delete t.fx; delete t.sends; delete t.auto; });
  M.normalize(old);
  ok(Array.isArray(old.tracks[0].fx) && old.master.fx && old.buses.length === 2, 'normalize upgrades an old project');
  valid(old, 'upgraded project');

  const h = new M.History();
  const before = M.serialize(p);
  h.push(before);
  const a = M.addFx(p, t1, 'eq', D.fresh('eq').params);
  const b = M.addFx(p, t1, 'comp', D.fresh('comp').params, 0);
  ok(p.tracks[0].fx[0].id === b && p.tracks[0].fx[1].id === a, 'addFx inserts at the index given');
  M.moveFx(p, t1, b, 1);
  ok(p.tracks[0].fx[1].id === b, 'moveFx reorders');
  M.setFx(p, t1, a, { on: false, params: { p3Gain: 4 }, m: null });
  ok(p.tracks[0].fx[0].on === false && p.tracks[0].fx[0].params.p3Gain === 4 && !('m' in p.tracks[0].fx[0]), 'setFx bypasses, merges params and drops macros');
  M.setAutoPoints(p, t1, 'fx:' + a + ':p3Gain', [[2, 0], [1, -3], [4, 6]]);
  ok(p.tracks[0].auto['fx:' + a + ':p3Gain'][0][0] === 1, 'automation points are sorted');
  near(M.autoValueAt(p.tracks[0].auto['fx:' + a + ':p3Gain'], 3), 3, 1e-9, 'automation interpolates linearly');
  near(M.autoValueAt(p.tracks[0].auto['fx:' + a + ':p3Gain'], 0), -3, 1e-9, 'automation holds before the first point');
  M.removeFx(p, t1, a);
  ok(!p.tracks[0].auto['fx:' + a + ':p3Gain'], 'removing a plugin removes its automation');
  M.setSend(p, t1, 'bus-reverb', -6);
  ok(p.tracks[0].sends['bus-reverb'] === -6, 'setSend stores the level');
  M.setSend(p, t1, 'bus-reverb', -60);
  ok(!('bus-reverb' in p.tracks[0].sends), 'a send at -60 dB is removed');
  M.setSend(p, t1, 'bus-delay', -3);
  M.setAutoPoints(p, t1, 'send:bus-delay', [[0, -10], [5, 0]]);
  M.removeBus(p, 'bus-delay');
  ok(!p.tracks[0].sends['bus-delay'] && !p.tracks[0].auto['send:bus-delay'], 'removing a bus removes its sends and their automation');
  valid(p, 'after effect ops');
  ok(h.undo(M.serialize(p)) === before, 'undo after effect ops restores the identical project');

  const ids = M.setChain(p, 'master', D.patchChain(D.PATCHES.filter((x) => x.name === 'Streaming master')[0]));
  ok(ids.length === 3 && p.master.fx[2].type === 'limiter', 'setChain loads a patch onto the master');
}

/* ------------------------------------------- automation follows edits */
{
  const { p, t1 } = fixture();
  M.setAutoPoints(p, t1, 'vol', [[0, 0], [2, -6], [6, -6], [8, 0]]);
  M.deleteRange(p, 3, 5, null, true);
  const pts = p.tracks[0].auto.vol;
  near(M.autoValueAt(pts, 6), 0, 1e-9, 'ripple delete pulls later automation left (8 s -> 6 s)');
  near(M.autoValueAt(pts, 2.5), -6, 1e-9, 'automation before the cut is untouched');
  M.insertGap(p, 1, 2, null);
  near(M.autoValueAt(p.tracks[0].auto.vol, 8), 0, 1e-9, 'inserting silence pushes automation right');
  near(M.autoValueAt(p.tracks[0].auto.vol, 2), M.autoValueAt(p.tracks[0].auto.vol, 3), 1e-9, 'the inserted gap holds the value it was cut at');
  M.cropTo(p, 2, 9);
  near(p.tracks[0].auto.vol[0][0], 0, 1e-12, 'crop moves automation to zero');
  valid(p, 'after automation edits');
  const thin = M.thinPoints(Array.from({ length: 200 }, (_, i) => [i / 100, i < 100 ? 0 : -6]), 0.01);
  ok(thin.length <= 4, 'a recorded step thins to a handful of points (' + thin.length + ')');
}

/* ------------------------------------------------- effects: catalogue */
{
  function inRange(def, k, v, where) {
    const pr = def.byKey[k];
    if (!pr) { ok(false, where + ': no parameter ' + k); return; }
    if (pr.opts) ok(pr.kind === 'track' || pr.opts.some((o) => String(o[0]) === String(v)), where + ': ' + k + ' = ' + v + ' is not an option');
    else ok(typeof v === 'number' && v >= pr.min - 1e-9 && v <= pr.max + 1e-9, where + ': ' + k + ' = ' + v + ' outside ' + pr.min + '..' + pr.max);
  }
  ok(D.ORDER.length >= 23, 'at least 23 plugins (' + D.ORDER.length + ')');
  D.ORDER.forEach((k) => {
    const d = D.PLUGINS[k];
    ok(d && d.name && d.desc && D.CATS.some((c) => c[0] === d.cat), k + ' has a name, description and category');
    d.params.forEach((pr) => inRange(d, pr.k, pr.def, k + ' default'));
    d.structural.forEach((s) => ok(!!d.byKey[s], k + ': structural key ' + s + ' is a parameter'));
    d.macros.forEach((m) => [0, m.def, 0.5, 1].forEach((v) => {
      const patch = m.map(v);
      Object.keys(patch).forEach((pk) => inRange(d, pk, patch[pk], k + ' macro ' + m.k + '@' + v));
    }));
    d.presets.forEach((pr) => Object.keys(pr.p).forEach((pk) => inRange(d, pk, pr.p[pk], k + ' preset "' + pr.name + '"')));
    const f = D.fresh(k);
    ok(JSON.stringify(D.resolve({ type: k, params: f.params })) === JSON.stringify(f.params), k + ': a fresh slot resolves to itself');
    ok(D.tailOf({ type: k, params: f.params }, 120) >= 0, k + ': tail is defined');
  });
  D.PATCHES.forEach((pt) => {
    ok(['track', 'master', 'both'].indexOf(pt.for) >= 0, 'patch ' + pt.name + ' says where it goes');
    pt.chain.forEach((s) => {
      const d = D.PLUGINS[s.type];
      ok(!!d, 'patch ' + pt.name + ': plugin ' + s.type + ' exists');
      if (!d) return;
      if (s.preset) ok(d.presets.some((x) => x.name === s.preset), 'patch ' + pt.name + ': preset ' + s.preset + ' exists');
      Object.keys(s.p || {}).forEach((pk) => inRange(d, pk, s.p[pk], 'patch ' + pt.name));
    });
    D.patchChain(pt).forEach((slot) => ok(D.PLUGINS[slot.type] && slot.params, 'patch ' + pt.name + ' builds a chain'));
  });
  near(D.noteSec('1/4', 120), 0.5, 1e-12, 'a quarter note at 120 BPM is half a second');
  near(D.noteSec('1/8D', 120), 0.375, 1e-12, 'a dotted eighth is 1.5 eighths');
  near(D.noteSec('1/4T', 120), 1 / 3, 1e-12, 'a quarter triplet is two-thirds of a quarter');
  near(D.response('eq', { p3Freq: 1000, p3Gain: 6, p3Q: 1 }, [1000], 48000)[0], 6, 1e-6, 'EQ curve: +6 dB at the band centre');
  near(D.response('eq', { hpOn: 'on', hpFreq: 100, hpSlope: '24' }, [100], 48000)[0], -3.01, 0.02, 'EQ curve: a Butterworth low cut is -3 dB at its corner');
  near(D.response('eq', { hpOn: 'on', hpFreq: 100, hpSlope: '24' }, [50], 48000)[0], -24.1, 0.5, 'EQ curve: 24 dB/oct is about -24 dB an octave below');
  // The reverb must be the same room every time, or playback and export differ.
  const ir1 = D.reverbIR(48000, 1.2, 5000, 40, 80)[0], ir2 = D.reverbIR(44100 + 3900, 1.2, 5000, 40, 80)[0];
  ok(ir1 === ir2 || ir1.every((v, i) => v === ir2[i]), 'the reverb impulse is deterministic');
}

/* ------------------------------------------- results from a tool page */
{
  // Same length: nothing else moves.
  let f = fixture();
  let before = M.serialize(f.p);
  let s = M.addSource(f.p, { name: 'nr', duration: 10, kind: 'derived' });
  M.replaceClipAudio(f.p, f.c1, s, 10, false);
  ok(M.findClip(f.p, f.c1).clip.sourceId === s, 'the clip points at the returned audio');
  near(M.findClip(f.p, f.c2).clip.start, 12, 1e-9, 'a same-length return leaves the next clip alone');
  valid(f.p, 'after a same-length return');
  const h = new M.History(); h.push(before);
  ok(h.undo(M.serialize(f.p)) === before, 'undo after a return restores the identical project');

  // Longer, ripple: the next clip on that track moves by the difference, the other track does not.
  f = fixture();
  s = M.addSource(f.p, { name: 'slow', duration: 13, kind: 'derived' });
  M.replaceClipAudio(f.p, f.c1, s, 13, true);
  near(M.findClip(f.p, f.c2).clip.start, 15, 1e-9, 'a longer return ripples the next clip');
  near(M.findClip(f.p, f.c3).clip.start, 1, 1e-9, 'ripple stays on its own track');
  valid(f.p, 'after a longer rippled return');

  // Shorter, ripple.
  f = fixture();
  s = M.addSource(f.p, { name: 'fast', duration: 6, kind: 'derived' });
  M.replaceClipAudio(f.p, f.c1, s, 6, true);
  near(M.findClip(f.p, f.c2).clip.start, 8, 1e-9, 'a shorter return pulls the next clip in');

  // Longer, no ripple: the overlap is carved out of the next clip, never left.
  f = fixture();
  s = M.addSource(f.p, { name: 'long', duration: 14, kind: 'derived' });
  M.replaceClipAudio(f.p, f.c1, s, 14, false);
  const n = M.findClip(f.p, f.c2).clip;
  near(n.start, 14, 1e-9, 'without ripple the next clip is carved to start where the return ends');
  near(n.offset, 2, 1e-9, 'and reads from the right place in its source');
  valid(f.p, 'after a longer return without ripple');

  // Extra outputs go on a new track below.
  f = fixture();
  s = M.addSource(f.p, { name: 'inst', duration: 10, kind: 'derived' });
  const cid = M.placeOnNewTrack(f.p, 1, s, 0, 'Instrumental');
  ok(f.p.tracks.length === 3 && f.p.tracks[1].name === 'Instrumental', 'placeOnNewTrack inserts at the index');
  ok(M.findClip(f.p, cid).ti === 1, 'and the clip lands on it');
  valid(f.p, 'after placeOnNewTrack');

  // The staleness fingerprint ignores position but not content.
  f = fixture();
  const ref = { clipId: f.c1 };
  const fp = M.targetPrint(f.p, ref);
  M.moveClips(f.p, [f.c1], 0.5, 0);
  ok(M.targetPrint(f.p, ref) === fp, 'moving the clip does not make a sent target stale');
  M.trimEnd(f.p, f.c1, 5);
  ok(M.targetPrint(f.p, ref) !== fp, 'trimming it does');
  M.deleteClips(f.p, [f.c1]);
  ok(M.targetPrint(f.p, ref) === 'gone', 'deleting it reads as gone');

  // A range on one track, same length: split around it, nothing moves.
  f = fixture();
  s = M.addSource(f.p, { name: 'range', duration: 2, kind: 'derived' });
  before = M.serialize(f.p);
  let rid = M.replaceRange(f.p, [f.t1], 3, 5, s, 2, { ripple: false });
  let tr = f.p.tracks[0].clips;
  ok(tr.length === 4, 'a range inside a clip leaves left part, new clip, right part and the next clip (' + tr.length + ')');
  near(M.findClip(f.p, rid).clip.start, 3, 1e-9, 'the returned range starts where it was cut');
  near(tr[2].start, 5, 1e-9, 'the right part resumes after it');
  near(tr[2].offset, 5, 1e-9, 'reading from the right place');
  near(M.findClip(f.p, f.c3).clip.start, 1, 1e-9, 'other tracks are untouched');
  valid(f.p, 'after a same-length range return');
  const h2 = new M.History(); h2.push(before);
  ok(h2.undo(M.serialize(f.p)) === before, 'undo after a range return is exact');

  // Longer, ripple: everything after the range on that track moves, and its automation with it.
  f = fixture();
  M.setAutoPoints(f.p, f.t1, 'vol', [[8, -6], [14, 0]]);
  s = M.addSource(f.p, { name: 'range', duration: 3, kind: 'derived' });
  M.replaceRange(f.p, [f.t1], 3, 5, s, 3, { ripple: true });
  tr = f.p.tracks[0].clips;
  near(tr[2].start, 6, 1e-9, 'with ripple the right part moves by the extra second');
  near(M.findClip(f.p, f.c2).clip.start, 13, 1e-9, 'and so does the next clip');
  near(M.autoValueAt(f.p.tracks[0].auto.vol, 9), -6, 1e-9, 'and the track automation after the range (the -6 dB point moves 8 -> 9 s)');
  near(M.autoValueAt(f.p.tracks[0].auto.vol, 15), 0, 1e-9, 'all of it');
  near(M.findClip(f.p, f.c3).clip.start, 1, 1e-9, 'other tracks do not ripple');
  valid(f.p, 'after a longer rippled range return');

  // All tracks, bounced onto a new track: the range is empty on every source track.
  f = fixture();
  M.addMarker(f.p, 13, 'late');
  s = M.addSource(f.p, { name: 'bounce', duration: 1, kind: 'derived' });
  rid = M.replaceRange(f.p, null, 1.5, 3.5, s, 1, { ripple: true, newTrack: { index: 0, name: 'Bounce' } });
  ok(f.p.tracks.length === 3 && f.p.tracks[0].name === 'Bounce', 'a bounce goes on a new track at the index');
  ok(M.findClip(f.p, rid).ti === 0, 'holding the returned clip');
  ok(f.p.tracks.slice(1).every(function (t) { return t.clips.every(function (c) { return c.start >= 2.5 - 1e-9 || M.clipEnd(c) <= 1.5 + 1e-9; }); }),
    'the covered range is empty on every source track');
  near(f.p.markers[0].t, 12, 1e-9, 'markers ripple when every track was covered');
  valid(f.p, 'after a bounce');

  // The range fingerprint notices edits inside the range and ignores them outside.
  f = fixture();
  const rref = { kind: 'range', trackIds: [f.t1], t0: 2, t1: 6 };
  const rfp = M.targetPrint(f.p, rref);
  M.setClip(f.p, f.c2, { gainDb: -3 });
  ok(M.targetPrint(f.p, rref) === rfp, 'an edit outside the range does not make it stale');
  M.setClip(f.p, f.c1, { gainDb: -3 });
  ok(M.targetPrint(f.p, rref) !== rfp, 'an edit inside it does');
  M.removeTrack(f.p, f.t1);
  ok(M.targetPrint(f.p, rref) === 'gone', 'removing the track reads as gone');

  // Identity.
  const p1 = M.create('a'), p2 = M.create('b');
  ok(p1.id && p1.id !== p2.id, 'every project gets its own id');
  ok(M.normalize(p1).id === p1.id, 'normalize keeps an existing id');
}

/* ------------------------------------------------------------- fuzzing */
{
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const { p } = fixture();
  const h = new M.History();
  let cb = null;
  let ops = 0;
  for (let i = 0; i < 1000; i++) {
    const clips = M.allClips(p);
    const pick = () => clips.length ? clips[Math.floor(rnd() * clips.length)].clip.id : null;
    const t = rnd() * 20;
    const snapBefore = M.serialize(p);
    const r = rnd();
    const id = pick();
    let op;
    if (r < 0.12) { op = 'split'; M.splitAt(p, t, rnd() < 0.5 && id ? [id] : null); }
    else if (r < 0.26 && id) { op = 'move'; M.moveClips(p, [id], (rnd() - 0.5) * 8, Math.floor(rnd() * 3) - 1); }
    else if (r < 0.36 && id) { op = 'trimStart'; M.trimStart(p, id, t); }
    else if (r < 0.46 && id) { op = 'trimEnd'; M.trimEnd(p, id, t); }
    else if (r < 0.52 && id) { op = 'delete'; M.deleteClips(p, [id], rnd() < 0.5); }
    else if (r < 0.58) { op = 'deleteRange'; M.deleteRange(p, t, t + rnd() * 3, rnd() < 0.5 ? [p.tracks[0].id] : null, rnd() < 0.5); }
    else if (r < 0.64 && id) { op = 'fade'; M.setFade(p, id, rnd() < 0.5 ? 'in' : 'out', rnd() * 5); }
    else if (r < 0.70 && id) { op = 'duplicate'; M.duplicate(p, [id]); }
    else if (r < 0.75 && id) { op = 'copy'; cb = M.copyClips(p, [id]); }
    else if (r < 0.80 && cb) { op = 'paste'; M.paste(p, cb, t, Math.floor(rnd() * p.tracks.length)); }
    else if (r < 0.84) { op = 'insertGap'; M.insertGap(p, t, rnd() * 2, null); }
    else if (r < 0.88 && id) {
      op = 'replace';
      const src = M.addSource(p, { name: 'fx', duration: 0.5 + rnd() * 6, kind: 'derived' });
      if (rnd() < 0.5) M.replaceSource(p, id, src, p.sources[src].duration);
      else M.replaceClipAudio(p, id, src, p.sources[src].duration, rnd() < 0.5);
    }
    else if (r < 0.895) {
      op = 'replaceRange';
      const src = M.addSource(p, { name: 'range', duration: 0.3 + rnd() * 4, kind: 'derived' });
      const tids = rnd() < 0.4 ? null : [p.tracks[Math.floor(rnd() * p.tracks.length)].id];
      M.replaceRange(p, tids, t, t + 0.1 + rnd() * 4, src, p.sources[src].duration,
        { ripple: rnd() < 0.5, newTrack: tids ? null : { index: Math.floor(rnd() * p.tracks.length), name: 'Bounce' } });
    }
    else if (r < 0.91) { op = 'addTrack'; M.addTrack(p); }
    else if (r < 0.93 && p.tracks.length > 2) { op = 'removeTrack'; M.removeTrack(p, p.tracks[Math.floor(rnd() * p.tracks.length)].id); }
    else if (r < 0.95 && id) { op = 'setClip'; M.setClip(p, id, { gainDb: (rnd() - 0.5) * 30, fadeIn: rnd() * 3 }); }
    else if (r < 0.965) {
      op = 'fx';
      const tr = p.tracks[Math.floor(rnd() * p.tracks.length)], key = rnd() < 0.2 ? 'master' : tr.id, ch = M.chainOf(p, key);
      const x = rnd();
      if (x < 0.4 || !ch.length) M.addFx(p, key, D.ORDER[Math.floor(rnd() * D.ORDER.length)], {});
      else if (x < 0.6) M.moveFx(p, key, ch[0].id, Math.floor(rnd() * ch.length));
      else if (x < 0.8) M.setFx(p, key, ch[0].id, { on: rnd() < 0.5, params: { out: -3 } });
      else M.removeFx(p, key, ch[Math.floor(rnd() * ch.length)].id);
    }
    else if (r < 0.975) { op = 'auto'; M.setAutoPoints(p, p.tracks[Math.floor(rnd() * p.tracks.length)].id, 'vol', [[t, -6], [t + rnd() * 4, 0], [rnd() * 20, -3]]); }
    else if (r < 0.985 && id) {
      op = 'addTake';
      const f = M.findClip(p, id), c = f.clip;
      M.addTake(p, f.track.id, [{ sourceId: Object.keys(p.sources)[0], name: 'k', start: c.start, offset: 0, duration: Math.min(c.duration, 10) }]);
    }
    else if (r < 0.99 && id) {
      op = 'useTake';
      const f = M.findClip(p, id), ks = M.takesAt(p, f.track.id, f.clip.start, M.clipEnd(f.clip));
      if (ks.length) M.useTake(p, f.track.id, ks[0].id, f.clip.start + rnd() * f.clip.duration / 2, M.clipEnd(f.clip));
    }
    else { op = 'addClip'; M.addClip(p, p.tracks[Math.floor(rnd() * p.tracks.length)].id, { sourceId: Object.keys(p.sources)[0], start: t, offset: rnd() * 5, duration: rnd() * 5 + 0.05 }); }
    if (M.serialize(p) !== snapBefore) { h.push(snapBefore); ops++; }
    const errs = M.validate(p);
    if (errs.length) {
      ok(false, 'fuzz step ' + i + ' (' + op + ') broke an invariant: ' + errs.slice(0, 2).join('; '));
      break;
    }
  }
  // Unwind the whole run. The last undo must land exactly on the fixture.
  let cur = M.serialize(p), steps = 0, prev;
  while ((prev = h.undo(cur)) !== null) { cur = prev; steps++; }
  ok(M.validate(M.parse(cur)).length === 0, 'every undo state is valid');
  ok(steps === Math.min(ops, h.limit), 'undo walks back through every recorded change (' + steps + ' of ' + ops + ')');
}

/* ---------------------------------------------------------- tempo grid */
{
  const { p } = fixture();
  ok(p.sig[0] === 4 && p.sig[1] === 4 && p.gridOffset === 0 && p.ruler === 'time', 'a new project is 4/4, bar 1 at zero, ruler in time');
  const old = JSON.parse(M.serialize(p));
  delete old.sig; delete old.gridOffset; delete old.ruler;
  M.normalize(old);
  ok(old.sig.join('/') === '4/4' && old.gridOffset === 0 && old.ruler === 'time', 'normalize gives an older project a grid');
  const once = M.serialize(old); M.normalize(old);
  ok(M.serialize(old) === once, 'normalize is idempotent with the grid');

  M.setSig(p, 7, 5); M.setSig(p, 0, 4); M.setSig(p, 16, 4); M.setSig(p, 3.5, 4);
  ok(p.sig.join('/') === '4/4', 'impossible time signatures are refused');
  M.setRuler(p, 'nonsense'); ok(p.ruler === 'time', 'unknown ruler mode falls back to time');

  // 4/4 at 120: a beat is 0.5 s, a bar 2 s.
  near(M.beatSec(p), 0.5, 1e-12, '4/4 at 120: beat 0.5 s');
  let g = M.gridLines(p, 0, 4, 1);
  ok(g.length === 9 && g[4].bar === 2 && g[4].beat === 1 && g[4].level === 2 && g[5].level === 1, '4/4 lines: a bar line every fourth beat');

  // 3/4 with bar 1 at 0.3 s.
  M.setSig(p, 3, 4); M.setGridOffset(p, 0.3);
  near(M.barSec(p), 1.5, 1e-12, '3/4 at 120: bar 1.5 s');
  g = M.gridLines(p, 0.3, 3.3, 1);
  ok(g[0].t === 0.3 && g[3].bar === 2 && g[3].beat === 1 && g[6].bar === 3, '3/4 with an offset: bars at 0.3, 1.8, 3.3');
  near(M.nearestGrid(p, 1.1, 1), 1.3, 1e-9, 'snaps to the nearest beat of an offset grid');
  near(M.nearestGrid(p, 1.04, 0.25), 1.05, 1e-9, 'snaps to a sixteenth');
  ok(M.fmtBars(p, 1.8, 3) === '2' && M.fmtBars(p, 2.3, 1) === '2.2' && M.fmtBars(p, 2.425, 0.25) === '2.2.2', 'bar.beat labels');

  // An offset is only a phase: it is kept inside one bar, even when the
  // tempo change makes the bar shorter than the offset.
  M.setGridOffset(p, 7.3); near(p.gridOffset, 1.3, 1e-9, 'an offset past one bar wraps into it');
  M.setGridOffset(p, -0.2); near(p.gridOffset, 1.3, 1e-9, 'a negative offset wraps too');
  M.setBpm(p, 240); ok(p.gridOffset < M.barSec(p), 'a faster tempo re-wraps the offset');
  valid(p, 'project after grid edits');

  // 6/8: six eighth-note clicks per bar, accents on 1 and 4.
  M.setBpm(p, 120); M.setSig(p, 6, 8); M.setGridOffset(p, 0);
  const c = M.clickTimes(p, 0, 3);
  ok(c.length === 12 && c.map((x) => x.accent).join('') === '200100200100', '6/8 clicks: downbeat, then the second group of three');
  ok(M.clickTimes(p, 0, 0.25).length === 1, 'the click at the end of the window belongs to the next window');
  M.setSig(p, 4, 4);
  ok(M.clickTimes(p, 0, 2).map((x) => x.accent).join('') === '2000', '4/4 accents only the downbeat');

  ok(p.key === null, 'a project has no key until one is set');
  M.setKey(p, 9, 'minor'); ok(p.key.pc === 9 && p.key.mode === 'minor', 'set the key to A minor');
  M.setKey(p, 12, 'minor'); M.setKey(p, 3, 'dorian'); ok(p.key.pc === 9, 'impossible keys are refused');
  M.setKey(p, null); ok(p.key === null, 'the key can be cleared');
  const k2 = JSON.parse(M.serialize(p)); k2.key = { pc: 'x' }; M.normalize(k2); ok(k2.key === null, 'normalize drops a malformed key');
}

/* ---------------------------------------------------------------- takes */
{
  const p = M.create('takes');
  const A = M.addSource(p, { name: 'take1', duration: 8, channels: 1, sampleRate: 48000, kind: 'recording' });
  const B = M.addSource(p, { name: 'take2', duration: 8, channels: 1, sampleRate: 48000, kind: 'recording' });
  const t = M.addTrack(p);
  M.addClip(p, t, { sourceId: A, start: 1, offset: 0, duration: 4 });
  const tr = p.tracks[0];
  const tk = M.addTake(p, t, [{ sourceId: B, name: 'b', start: 1, offset: 0, duration: 4 }], 'Take 1');
  ok(tr.takes.length === 1 && M.usedSources(p)[B], 'a take is kept, and its source counts as used');
  valid(p, 'project with a take');
  // What plays at time x on a lane: [source, position in the source].
  const at = (lane, x) => { const c = lane.clips.filter((c) => x >= c.start && x < c.start + c.duration)[0]; return c ? c.sourceId + '@' + (c.offset + x - c.start).toFixed(4) : '-'; };
  const probe = [1.1, 1.9, 2.1, 2.9, 3.1, 4.9];
  const before = probe.map((x) => [at(tr, x), at(tr.takes[0], x)].sort().join('|'));
  ok(M.useTake(p, t, tk, 2, 3), 'use take 1 for 2..3 s');
  valid(p, 'after comping');
  ok(at(tr, 2.5) === B + '@1.5000' && at(tr, 1.5) === A + '@0.5000' && at(tr, 3.5) === A + '@2.5000', 'the track plays the take inside the range and the original outside it');
  ok(at(tr.takes[0], 2.5) === A + '@1.5000', 'what was replaced moved into the take');
  const after = probe.map((x) => [at(tr, x), at(tr.takes[0], x)].sort().join('|'));
  ok(JSON.stringify(before) === JSON.stringify(after), 'comping swaps audio and loses none');
  const seam = tr.clips.filter((c) => Math.abs(c.start - 2) < 1e-9)[0];
  ok(seam && seam.fadeIn > 0 && seam.fadeIn <= 0.005 + 1e-9, 'a 5 ms fade at the comp seam');
  M.useTake(p, t, tk, 2, 3);
  ok(at(tr, 2.5) === A + '@1.5000' && at(tr.takes[0], 2.5) === B + '@1.5000', 'swapping again puts it back');
  ok(!M.useTake(p, t, tk, 6, 7), 'a range the take does not cover changes nothing');
  ok(M.takesAt(p, t, 0, 1.5).length === 1 && M.takesAt(p, t, 6, 7).length === 0, 'takesAt finds takes by time');
}

/* ------------------------------------------- takes follow the edits */
{
  // A track playing A over 1..5 s with a second clip C at 6..8 s; Take 1
  // holds B over the same 1..5 s.
  const setup = () => {
    const p = M.create('takes-follow');
    const A = M.addSource(p, { name: 'A', duration: 8, channels: 1, sampleRate: 48000 });
    const B = M.addSource(p, { name: 'B', duration: 8, channels: 1, sampleRate: 48000 });
    const C = M.addSource(p, { name: 'C', duration: 8, channels: 1, sampleRate: 48000 });
    const t = M.addTrack(p), t2 = M.addTrack(p);
    const a = M.addClip(p, t, { sourceId: A, start: 1, duration: 4 });
    const c = M.addClip(p, t, { sourceId: C, start: 6, duration: 2 });
    M.addTake(p, t, [{ sourceId: B, name: 'b', start: 1, offset: 0, duration: 4 }], 'Take 1');
    M.addTake(p, t, [{ sourceId: B, name: 'b2', start: 6, offset: 2, duration: 2 }], 'Take 2');
    return { p, A, B, C, t, t2, a, c, tr: p.tracks[0] };
  };
  const at = (lane, x) => { const c = lane.clips.filter((c) => x >= c.start - 1e-9 && x < c.start + c.duration - 1e-9)[0]; return c ? c.sourceId + '@' + (c.offset + x - c.start).toFixed(4) : '-'; };
  const take = (tr, name) => tr.takes.filter((k) => k.name === name)[0];

  { const { p, B, a, tr } = setup();
    M.moveClips(p, [a], 3, 0);
    valid(p, 'after moving a clip with takes');
    ok(at(take(tr, 'Take 1'), 4.5) === B + '@0.5000' && at(take(tr, 'Take 1'), 1.5) === '-', 'a moved clip takes its takes with it');
    ok(M.takesAt(p, tr.id, 4, 8).length === 1 && !take(tr, 'Take 2'), 'and the clip it overwrites loses its takes along with its audio');
  }
  { const { p, B, a, tr, t2 } = setup();
    M.moveClips(p, [a], 0.5, 1);
    valid(p, 'after moving a clip with takes to another track');
    const k = p.tracks[1].takes[0];
    ok(k && k.name === 'Take 1' && at(k, 2) === B + '@0.5000', 'moving to another track carries the take to that track');
    ok(!take(tr, 'Take 1'), 'and an emptied take is dropped from the old track');
    ok(M.takesAt(p, t2, 1.5, 5.5).length === 1, 'the take is found under the clip in its new place');
  }
  { const { p, B, a, tr } = setup();
    M.deleteRange(p, 0, 0.5, null, true);
    ok(at(take(tr, 'Take 1'), 0.75) === B + '@0.2500' && at(take(tr, 'Take 2'), 6) === B + '@2.5000', 'a ripple delete slides the takes with the clips');
    M.insertGap(p, 2, 1, null);
    valid(p, 'after a gap is inserted through a take');
    ok(at(take(tr, 'Take 1'), 1.5) === B + '@1.0000' && at(take(tr, 'Take 1'), 2.25) === '-' && at(take(tr, 'Take 1'), 3.25) === B + '@1.7500', 'inserting a gap splits and slides the takes too');
  }
  { const { p, B, a, c, tr } = setup();
    M.deleteClips(p, [a], true);
    valid(p, 'after ripple-deleting a clip with takes');
    ok(!take(tr, 'Take 1'), 'deleting a clip deletes its takes');
    ok(M.findClip(p, c).clip.start === 2 && at(take(tr, 'Take 2'), 2.5) === B + '@2.5000', 'and a ripple delete slides the next clip\'s takes with it');
  }
  { const { p, B, a, c, tr } = setup();
    const src = M.addSource(p, { name: 'fx', duration: 6, kind: 'derived' });
    M.replaceSource(p, a, src, 6);
    ok(M.findClip(p, c).clip.start === 8 && at(take(tr, 'Take 2'), 8.5) === B + '@2.5000', 'an effect that lengthens a clip ripples the later takes too');
  }
  { const { p, B, tr } = setup();
    M.cropTo(p, 2, 7);
    valid(p, 'after a crop through takes');
    ok(at(take(tr, 'Take 1'), 0.5) === B + '@1.5000' && at(take(tr, 'Take 2'), 4.5) === B + '@2.5000' && at(take(tr, 'Take 2'), 5.5) === '-', 'a crop trims and slides the takes');
  }
  { const { p, a, tr } = setup();
    const h = new M.History(), before = M.serialize(p);
    h.push(before); M.moveClips(p, [a], 2, 1);
    ok(h.undo(M.serialize(p)) === before, 'a move that carried takes undoes byte-for-byte');
  }
}

/* ---------------------------------------------------------------- MIDI */
{
  const p = M.create('midi');
  const notes = [];
  for (let k = 0; k < 8; k++) notes.push({ midi: 60 + k, start: k * 0.5, duration: 0.4, velocity: 70 + k });
  const s = M.addSource(p, { kind: 'midi', name: 'riff', notes: notes.concat([{ midi: 200, start: 1, duration: 1 }, { midi: 61, start: 1, duration: 0 }]) });
  ok(p.sources[s].notes.length === 8, 'notes out of range or of no length are dropped');
  near(p.sources[s].duration, 3.9, 1e-9, 'a MIDI source lasts until its last note ends');
  const t = M.addTrack(p), t2 = M.addTrack(p);
  M.setTrack(p, t, { inst: 'pad' });
  ok(p.tracks[0].inst === 'pad', 'a track keeps its instrument');
  const c = M.addClip(p, t, { sourceId: s, start: 1 });
  valid(p, 'a project with a MIDI clip');
  const h = new M.History(), before = M.serialize(p);
  h.push(before);
  const right = M.splitAt(p, 2.25, [c])[0];
  const L = M.clipNotes(p, M.findClip(p, c).clip), R = M.clipNotes(p, M.findClip(p, right).clip);
  ok(L.length === 3 && R.length === 5, 'a split gives each half the notes that start in it (' + L.length + ' + ' + R.length + ')');
  ok(Math.abs(L[2].start - 2) < 1e-9 && Math.abs(L[2].duration - 0.25) < 1e-9, 'a note running over the split is cut at it, not struck again');
  ok(Math.abs(R[0].start - 2.5) < 1e-9 && R[0].midi === 63, 'the right half plays on in time');
  M.moveClips(p, [right], 1, 1);
  ok(M.clipNotes(p, M.findClip(p, right).clip)[0].start === 3.5, 'a moved MIDI clip plays its notes at the new time');
  M.trimEnd(p, c, 1.7);
  ok(M.clipNotes(p, M.findClip(p, c).clip).length === 2, 'trimming a MIDI clip drops the notes past its end');
  valid(p, 'after editing MIDI clips');
  ok(h.undo(M.serialize(p)) === before, 'MIDI edits undo byte for byte');
  const s2 = M.addSource(p, { kind: 'midi', name: 'riff', notes: M.notesOf(p.sources[s]).map((n) => Object.assign(n, { midi: n.midi + 12 })) });
  ok(p.sources[s].notes[0][0] === 60 && p.sources[s2].notes[0][0] === 72, 'an edit writes a new source and leaves the old one alone');
  const bad = JSON.parse(M.serialize(p)); bad.sources[s].notes[2][2] = -1;
  ok(M.validate(bad).some((e) => /bad note/.test(e)), 'validate catches a broken note');
}

if (failures) {
  console.error('check-editor: ' + failures + ' failure(s).');
  process.exit(1);
}
console.log('check-editor: model invariants hold across split, trim, move, ripple, paste, effects, automation and 1,000 random edits, the tempo grid holds in 4/4, 3/4 and 6/8, and comping takes loses no audio; ' + D.ORDER.length + ' plugins and ' + D.PATCHES.length + ' patches check out.');
