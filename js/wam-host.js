/*
 * Web Audio Modules 2 (WAM2) hosting: the community's web plugins, used by
 * the editor's mixer and by /audio-plugins.
 *
 * A WAM is an ES module whose default export has
 * createInstance(groupId, context, state). The host side of the SDK is five
 * small files in vendor/wam/ (initializeWamHost and what it imports); each
 * plugin brings its own copy of the rest. The host is initialised once per
 * BaseAudioContext, so an OfflineAudioContext for an export gets its own
 * group and its own instances, rebuilt from the saved state.
 *
 * A plugin runs as first-party script on this origin. So a plugin URL comes
 * only from the community index or from what the user typed into "add by
 * URL" (behind a warning). Never from the query string or a shared link:
 * that would be cross-site scripting by design. isCatalogUrl() is the test.
 *
 * State: getState() may return typed arrays. Projects, undo and autosave are
 * JSON, so encodeState() tags binary data as base64 and decodeState()
 * restores it.
 *
 * Runs in Node for the state encoding (tools/check-editor.js) and in the
 * browser.
 */
(function (global) {
  'use strict';

  var SDK = '/vendor/wam/0.0.12/initializeWamHost.js';
  var INDEX = 'https://www.webaudiomodules.com/community/plugins.json';
  var BASE = 'https://www.webaudiomodules.com/community/plugins/';
  var CACHE_KEY = 'as_wam_index';
  var CACHE_MS = 24 * 3600 * 1000;
  var LOAD_MS = 45000;

  // Entries that are not audio processors: video, MIDI hardware editors and
  // MIDI utilities, modulators that drive other plugins' parameters, the
  // live input (a microphone, not a file) and a player for its own files.
  var HIDE_CATS = { 'Video': 1, 'External Device': 1, 'MIDI': 1, 'Modulation': 1 };
  var HIDE_IDS = { 'com.sequencerParty.audioInput': 1, 'com.sequencerParty.audioTrack': 1 };

  function status() { return (global.ASWamStatus && global.ASWamStatus.plugins) || {}; }

  function shape(p) {
    var cat = p.category || [];
    return {
      id: p.identifier, name: p.name, vendor: p.vendor, website: p.website || '',
      url: BASE + p.path, thumb: p.thumbnail ? BASE + p.thumbnail : '',
      category: cat, kind: cat[0] === 'Instrument' ? 'instrument' : 'effect',
      sub: cat[1] || cat[0] || '', description: p.description || '',
      keywords: p.keywords || []
    };
  }
  function visible(p) {
    if (HIDE_IDS[p.identifier]) return false;
    return !(p.category || []).some(function (c) { return HIDE_CATS[c]; });
  }

  var indexP = null;
  // The index, filtered and shaped. One request a day per browser; a failed
  // fetch is retried on the next call.
  function catalog() {
    if (indexP) return indexP;
    var cached = null;
    try { cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (e) {}
    if (cached && cached.t > Date.now() - CACHE_MS && Array.isArray(cached.list)) {
      indexP = Promise.resolve(build(cached.list));
      return indexP;
    }
    indexP = fetch(INDEX, { mode: 'cors' }).then(function (r) {
      if (!r.ok) throw new Error('The plugin list did not load (HTTP ' + r.status + ')');
      return r.json();
    }).then(function (list) {
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), list: list })); } catch (e) {}
      return build(list);
    }).catch(function (e) {
      indexP = null;
      if (cached && Array.isArray(cached.list)) return build(cached.list);
      throw e;
    });
    return indexP;
  }
  function build(list) {
    var st = status();
    return list.filter(visible).map(shape).map(function (p) {
      p.status = st[p.id] || null;
      return p;
    }).filter(function (p) { return !(p.status && p.status.hide); })
      .sort(function (a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1; });
  }
  function byUrl(url) {
    return catalog().then(function (list) {
      for (var i = 0; i < list.length; i++) if (list[i].url === url) return list[i];
      return null;
    });
  }
  function byId(id) {
    return catalog().then(function (list) {
      for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
      return null;
    });
  }
  function isCatalogUrl(url) { return typeof url === 'string' && url.indexOf(BASE) === 0 && !/[?#]/.test(url); }
  function isPluginUrl(url) { return /^https:\/\/[^\s]+\.m?js$/i.test(url || ''); }

  var hosts = typeof WeakMap === 'function' ? new WeakMap() : null;
  // One WAM host group per context. initializeWamHost adds two worklet
  // modules (the WAM environment and the group) to that context.
  function host(ctx) {
    var p = hosts.get(ctx);
    if (!p) {
      p = import(SDK).then(function (m) { return m.default(ctx); }).then(function (r) { return r[0]; });
      p.catch(function () { hosts.delete(ctx); });
      hosts.set(ctx, p);
    }
    return p;
  }

  var modules = {};
  function importModule(url) {
    if (!modules[url]) {
      modules[url] = import(url);
      modules[url].catch(function () { delete modules[url]; });
    }
    return modules[url];
  }

  function timeout(p, ms, what) {
    return new Promise(function (res, rej) {
      var t = setTimeout(function () { rej(new Error(what + ' did not answer')); }, ms);
      p.then(function (v) { clearTimeout(t); res(v); }, function (e) { clearTimeout(t); rej(e); });
    });
  }

  // A live instance: { url, name, vendor, kind, wam, node, latency (samples),
  // getState() -> JSON-safe, setState(json), midi(bytes, time), gui(),
  // dispose() }. state is the JSON-safe form (decodeState is applied here).
  function load(ctx, url, state, meta) {
    meta = meta || {};
    if (!isPluginUrl(url)) return Promise.reject(new Error('That is not a plugin address'));
    return timeout(Promise.all([host(ctx), importModule(url)]), LOAD_MS, 'The plugin').then(function (r) {
      var groupId = r[0], mod = r[1];
      var WAM = mod && mod.default;
      if (!WAM || typeof WAM.createInstance !== 'function') throw new Error('That address is not a Web Audio Module');
      return timeout(WAM.createInstance(groupId, ctx, state == null ? undefined : decodeState(state)), LOAD_MS, 'The plugin');
    }).then(function (wam) {
      // createInstance takes an initial state, but plugins do not wait for
      // it to reach their processor: an offline render started straight
      // after rendered the defaults (check-wam, Big Muff). setState does
      // wait for the processor's answer.
      var node = wam.audioNode;
      if (state == null || !node || typeof node.setState !== 'function') return wam;
      return timeout(Promise.resolve(node.setState(decodeState(state))), 5000, 'The plugin').then(function () { return wam; });
    }).then(function (wam) {
      var d = wam.descriptor || {};
      var node = wam.audioNode;
      var inst = {
        url: url, wam: wam, node: node,
        name: d.name || meta.name || 'Plugin', vendor: d.vendor || meta.vendor || '',
        kind: (d.isInstrument || meta.kind === 'instrument') ? 'instrument' : 'effect',
        latency: 0,
        getState: function () {
          return Promise.resolve(node.getState ? node.getState() : null).then(encodeState);
        },
        setState: function (s) {
          return node.setState ? Promise.resolve(node.setState(decodeState(s))) : Promise.resolve();
        },
        midi: function (bytes, time) {
          if (!node.scheduleEvents) return;
          node.scheduleEvents({ type: 'wam-midi', time: time == null ? ctx.currentTime : time, data: { bytes: bytes } });
        },
        // Resolves once the processor has handled everything sent before it:
        // a request on the same port, answered in order.
        flush: function () {
          if (typeof node.getParameterValues !== 'function') return Promise.resolve();
          return timeout(Promise.resolve(node.getParameterValues(false)), 2000, 'The plugin').catch(function () {});
        },
        gui: function () { return wam.createGui ? wam.createGui() : Promise.resolve(null); },
        closeGui: function (el) { try { if (el && wam.destroyGui) wam.destroyGui(el); } catch (e) {} },
        dispose: function () {
          try { node.disconnect(); } catch (e) {}
          try { if (node.destroy) node.destroy(); } catch (e) {}
        }
      };
      // The delay is what check-wam measured with an impulse, not what the
      // plugin reports: getCompensationDelay answered 128 samples for nearly
      // every community plugin while an impulse came out on the same sample
      // (Big Muff, Grey Hole, Simple Delay). Trimming 128 would have moved
      // the audio early.
      var st = meta.id ? status()[meta.id] : null;
      inst.latency = st && st.delay > 0 ? st.delay : 0;
      return inst;
    });
  }

  // ---- MIDI into an OfflineAudioContext --------------------------------------
  //
  // Events reach a plugin by message, and an offline render runs far ahead of
  // the main thread, so scheduling them all up front plays nothing (measured:
  // every instrument silent). The render is suspended a block before each
  // event, the event is sent and confirmed by a round trip on the port, and
  // only then does it go on. A plugin whose processor only echoes the event
  // to the main thread, which then starts the sound (a composite node, not
  // an AudioWorkletNode), gets the event one block early and a second
  // suspend at its time, so the main thread can act while the render waits.
  //
  // events: [{ t, bytes }] in context seconds. Returns { time: step } to
  // merge into the caller's suspend points (one suspend per time: a second
  // at the same time throws); step(ctx) returns a promise to wait on before
  // resuming.
  function offlineSteps(inst, events, sr) {
    var Q = 128 / sr, worklet = typeof AudioWorkletNode === 'function' && inst.node instanceof AudioWorkletNode;
    var at = {};
    function slot(t) { var k = (Math.round(t / Q) * Q).toFixed(9); return at[k] = at[k] || { send: [], wait: false }; }
    events.forEach(function (e) {
      var k = Math.floor(e.t / Q);
      slot(Math.max(0, k - 1) * Q).send.push({ t: worklet ? e.t : Math.max(0, (k - 1) * Q), bytes: e.bytes });
      if (!worklet) slot(k * Q).wait = true;
    });
    var steps = {};
    Object.keys(at).forEach(function (k) {
      var a = at[k];
      steps[k] = function () {
        var p = a.wait ? inst.flush().then(function () { return new Promise(function (r) { setTimeout(r, 25); }); }) : Promise.resolve();
        return p.then(function () {
          a.send.forEach(function (e) { inst.midi(e.bytes, e.t); });
          return a.send.length ? inst.flush() : null;
        });
      };
    });
    return steps;
  }

  // ---- JSON-safe state ----------------------------------------------------
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function toB64(u8) {
    if (typeof Buffer !== 'undefined') return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');
    var s = '', i;
    for (i = 0; i + 2 < u8.length; i += 3) {
      var n = (u8[i] << 16) | (u8[i + 1] << 8) | u8[i + 2];
      s += B64[n >> 18 & 63] + B64[n >> 12 & 63] + B64[n >> 6 & 63] + B64[n & 63];
    }
    if (i < u8.length) {
      var m = u8[i] << 16 | (i + 1 < u8.length ? u8[i + 1] << 8 : 0);
      s += B64[m >> 18 & 63] + B64[m >> 12 & 63] + (i + 1 < u8.length ? B64[m >> 6 & 63] : '=') + '=';
    }
    return s;
  }
  function fromB64(s) {
    if (typeof Buffer !== 'undefined') { var b = Buffer.from(s, 'base64'); return new Uint8Array(b.buffer, b.byteOffset, b.length).slice(); }
    var bin = atob(s), u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  var VIEWS = ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array',
    'Uint32Array', 'Float32Array', 'Float64Array'];
  function encodeState(v) {
    if (v == null || typeof v === 'boolean' || typeof v === 'string') return v;
    if (typeof v === 'number') return isFinite(v) ? v : { $wam: 'num', v: String(v) };
    if (typeof ArrayBuffer !== 'undefined' && v instanceof ArrayBuffer) return { $wam: 'ArrayBuffer', b64: toB64(new Uint8Array(v)) };
    if (ArrayBuffer.isView && ArrayBuffer.isView(v)) {
      var name = v.constructor && v.constructor.name;
      if (VIEWS.indexOf(name) < 0) name = 'Uint8Array';
      return { $wam: name, b64: toB64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
    }
    if (Array.isArray(v)) return v.map(encodeState);
    if (typeof v === 'object') {
      var o = {};
      Object.keys(v).forEach(function (k) { if (typeof v[k] !== 'function' && v[k] !== undefined) o[k] = encodeState(v[k]); });
      return o;
    }
    return null;
  }
  function decodeState(v) {
    if (v == null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(decodeState);
    if (typeof v.$wam === 'string') {
      if (v.$wam === 'num') return Number(v.v);
      var u8 = fromB64(v.b64 || '');
      if (v.$wam === 'ArrayBuffer') return u8.buffer;
      var C = global[v.$wam] || (typeof globalThis !== 'undefined' && globalThis[v.$wam]);
      if (VIEWS.indexOf(v.$wam) < 0 || !C) return u8;
      return new C(u8.buffer, 0, u8.byteLength / C.BYTES_PER_ELEMENT);
    }
    var o = {};
    Object.keys(v).forEach(function (k) { o[k] = decodeState(v[k]); });
    return o;
  }

  var api = global.ASWam = {
    INDEX: INDEX, BASE: BASE, SDK: SDK,
    catalog: catalog, byUrl: byUrl, byId: byId, isCatalogUrl: isCatalogUrl, isPluginUrl: isPluginUrl,
    host: host, load: load, offlineSteps: offlineSteps, flush: function (inst) { return inst && inst.flush ? inst.flush() : Promise.resolve(); }, encodeState: encodeState, decodeState: decodeState,
    status: function (id) { return status()[id] || null; }
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
