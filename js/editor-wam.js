/*
 * The editor's web plugins (WAM2): one live instance per plugin slot per
 * AudioContext, created asynchronously, kept across stop and play.
 *
 * editor-dsp.js builds chains synchronously, and a WAM cannot be created
 * that way. So the pool works like the effect worklets: get() returns the
 * instance if it is ready, else starts loading it and returns null (the
 * builder passes the sound through with a "Loading…" note), and when the
 * load finishes the engine rebuilds what is playing. An export calls
 * prepare() first, which loads every plugin the project uses into the
 * OfflineAudioContext from its saved state and fails the export, by name,
 * if one cannot load: exporting it dry would be silently wrong.
 *
 * A slot is { id, type: 'wam', params: { mix, out }, wam: { url, name,
 * vendor, state, latency } }. state is ASWam's JSON-safe form.
 */
(function (global) {
  'use strict';

  var pools = typeof WeakMap === 'function' ? new WeakMap() : null;
  var onReady = null;

  function poolOf(ctx) {
    var p = pools.get(ctx);
    if (!p) { p = new Map(); pools.set(ctx, p); }
    return p;
  }
  function stateJson(w) { return JSON.stringify(w && w.state != null ? w.state : null); }

  function start(ctx, slot) {
    var pool = poolOf(ctx), w = slot.wam;
    var e = { url: w.url, state: stateJson(w), inst: null, err: null, p: null, name: w.name || 'the plugin' };
    e.p = global.ASWam.load(ctx, w.url, w.state, { id: w.id, name: w.name, vendor: w.vendor }).then(function (inst) {
      if (pool.get(slot.id) !== e) { inst.dispose(); return null; }
      e.inst = inst;
      if (onReady && !(ctx instanceof (global.OfflineAudioContext || Object))) onReady(slot.id, inst);
      return inst;
    }, function (err) {
      e.err = err;
      console.warn('[audio-editor] web plugin failed to load', w.url, err);
      if (onReady) onReady(slot.id, null);
      return null;
    });
    pool.set(slot.id, e);
    return e;
  }

  // The ready instance for this slot, or null (and a load started). A slot
  // pointed at another plugin replaces its instance.
  function get(ctx, slot) {
    if (!pools || !slot || !slot.wam || !slot.wam.url || !global.ASWam) return null;
    var pool = poolOf(ctx), e = pool.get(slot.id);
    if (e && e.url !== slot.wam.url) { drop(ctx, slot.id); e = null; }
    if (!e) e = start(ctx, slot);
    return e.inst;
  }
  function whenReady(ctx, id) { var e = entry(ctx, id); return e ? e.p : Promise.resolve(null); }
  function isReady(ctx, id) { var e = entry(ctx, id); return !!(e && e.inst); }
  function has(ctx, id) { return !!entry(ctx, id); }
  function entry(ctx, id) { return pools && pools.has(ctx) ? pools.get(ctx).get(id) || null : null; }
  function error(ctx, id) { var e = entry(ctx, id); return e && e.err ? e.err : null; }

  // Bring a live instance's state in line with the slot (undo, redo, a
  // project restore). The plugin window's own edits arrive here already
  // matching, so nothing is sent back to the plugin.
  function sync(ctx, slot) {
    var e = entry(ctx, slot.id);
    if (!e || !e.inst) return;
    var js = stateJson(slot.wam);
    if (js === e.state) return;
    e.state = js;
    if (slot.wam.state != null) e.inst.setState(slot.wam.state).catch(function () {});
  }
  // Called by the plugin window after reading the plugin's state, so the
  // following sync() knows the instance already holds it.
  function noteState(ctx, id, state) {
    var e = entry(ctx, id);
    if (e) e.state = JSON.stringify(state != null ? state : null);
  }

  function drop(ctx, id) {
    var pool = pools && pools.get(ctx), e = pool && pool.get(id);
    if (!e) return;
    pool.delete(id);
    if (e.inst) e.inst.dispose();
  }
  // Dispose the instances whose slot is no longer in the project.
  function prune(ctx, project) {
    var pool = pools && pools.get(ctx);
    if (!pool) return;
    var keep = {};
    slotsOf(project).forEach(function (s) { keep[s.id] = 1; });
    Array.from(pool.keys()).forEach(function (id) { if (!keep[id]) drop(ctx, id); });
  }
  function syncAll(ctx, project) {
    prune(ctx, project);
    slotsOf(project).forEach(function (s) { sync(ctx, s); });
  }
  function dropAll(ctx) {
    var pool = pools && pools.get(ctx);
    if (!pool) return;
    Array.from(pool.keys()).forEach(function (id) { drop(ctx, id); });
    pools.delete(ctx);
  }

  // Every web plugin slot in the project (on or off), including track
  // instruments (Phase B: track.instWam).
  function slotsOf(project) {
    var out = [];
    function add(fx) { (fx || []).forEach(function (s) { if (s.type === 'wam' && s.wam) out.push(s); }); }
    (project.tracks || []).forEach(function (t) { add(t.fx); if (t.instWam) out.push(t.instWam); });
    (project.buses || []).forEach(function (b) { add(b.fx); });
    if (project.master) add(project.master.fx);
    return out;
  }
  function uses(project) { return slotsOf(project).length > 0; }

  // Load every plugin the render will use into ctx, from saved state.
  function prepare(ctx, project) {
    var slots = slotsOf(project).filter(function (s) { return s.on !== false; });
    if (!slots.length) return Promise.resolve();
    if (!global.ASWam) return Promise.reject(new Error('The web plugins did not load, so this project cannot be exported yet.'));
    return Promise.all(slots.map(function (s) {
      var e = entry(ctx, s.id) || start(ctx, s);
      return e.p.then(function (inst) {
        if (!inst) throw new Error('The web plugin "' + (s.wam.name || 'plugin') + '" could not be loaded' +
          (e.err && e.err.message ? ' (' + e.err.message + ')' : '') + ', so the export was stopped rather than leave it out.');
      });
    }));
  }

  var api = {
    get: get, error: error, whenReady: whenReady, isReady: isReady, has: has, sync: sync, noteState: noteState, drop: drop, prune: prune, syncAll: syncAll, dropAll: dropAll,
    prepare: prepare, uses: uses, slotsOf: slotsOf,
    onReady: function (fn) { onReady = fn; }
  };
  global.ASEditWam = api;
})(typeof window !== 'undefined' ? window : globalThis);
