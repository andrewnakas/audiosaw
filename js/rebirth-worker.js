/*
 * Worker for /rebirth-player: renders a ReBirth song with ASRebirth
 * (js/rebirth-play.js) off the main thread. The version token on this
 * file's own URL is passed on to the script and the wasm.
 *
 *   in:  { id, song, kit, mod, key, range, maxSeconds }   (ArrayBuffers or null)
 *   out: { id, progress } ... then { id, result } or { id, error }
 */
/* global ASRebirth */
var Q = (self.location.search || '');
importScripts('/js/rebirth-play.js' + Q);
var ready = ASRebirth.load('/vendor/openrb/2026-11-13/openrb.wasm' + Q);

self.onmessage = function (e) {
  var m = e.data;
  ready.then(function () {
    var last = 0;
    var r = ASRebirth.render(new Uint8Array(m.song), {
      kit: m.kit ? new Uint8Array(m.kit) : null,
      mod: m.mod ? new Uint8Array(m.mod) : null,
      key: m.key ? new Uint8Array(m.key) : null,
      range: m.range,
      maxSeconds: m.maxSeconds,
      onProgress: function (p) {
        if (p - last >= 0.01) { last = p; self.postMessage({ id: m.id, progress: p }); }
      }
    });
    var L = r.channels[0], R = r.channels[1];
    // The channels can be views into one larger buffer; a copy of exactly
    // the frames is what gets transferred.
    L = L.slice(); R = R.slice();
    self.postMessage({ id: m.id, result: {
      sampleRate: r.sampleRate, left: L.buffer, right: R.buffer, frames: L.length, duration: r.duration, peak: r.peak,
      truncated: r.truncated, info: r.info, kitUsed: r.kitUsed, modUsed: r.modUsed, drumsSilent: r.drumsSilent,
      modMissing: r.modMissing, modIncomplete: r.modIncomplete, modMismatch: r.modMismatch
    } }, [L.buffer, R.buffer]);
  }).catch(function (err) {
    self.postMessage({ id: m.id, error: (err && err.message) || String(err) });
  });
};
