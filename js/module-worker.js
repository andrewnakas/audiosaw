/*
 * Worker for /module-player: renders a tracker module with ASModule
 * (js/module-play.js) off the main thread, since a long song holds a thread
 * for several seconds. The version token on this file's own URL is passed
 * on to the script and the wasm, so one bump reaches all three.
 *
 *   in:  { id, bytes: ArrayBuffer, sampleRate, stereoSeparation }
 *   out: { id, progress } ... then { id, result } or { id, error }
 */
/* global ASModule */
var Q = (self.location.search || '');
importScripts('/js/module-play.js' + Q);
var ready = ASModule.load('/vendor/modplay/1.0.0/modplay.wasm' + Q);

self.onmessage = function (e) {
  var m = e.data;
  ready.then(function () {
    var last = 0;
    var r = ASModule.render(new Uint8Array(m.bytes), {
      sampleRate: m.sampleRate,
      stereoSeparation: m.stereoSeparation,
      onProgress: function (p) {
        // A message per block would be thousands; one per percent is enough.
        if (p - last >= 0.01) { last = p; self.postMessage({ id: m.id, progress: p }); }
      }
    });
    var L = r.channels[0], R = r.channels[1];
    self.postMessage({ id: m.id, result: { sampleRate: r.sampleRate, left: L.buffer, right: R.buffer, frames: L.length, duration: r.duration, peak: r.peak, truncated: r.truncated, info: r.info } },
      [L.buffer, R.buffer]);
  }).catch(function (err) {
    self.postMessage({ id: m.id, error: (err && err.message) || String(err) });
  });
};
