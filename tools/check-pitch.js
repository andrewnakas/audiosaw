#!/usr/bin/env node
/*
 * Checks the YIN pitch detector in js/pitch-track.js to the accuracy the
 * /tuner page claims: within 1 cent, from a five-string bass's low B (31 Hz)
 * to E6 (1.3 kHz), on tones with six harmonics, tuned exactly and 23 cents
 * either side, at 44.1 and 48 kHz, in the tuner's 4096-sample window.
 *
 * The refinement step used to interpolate the normalised difference curve,
 * which read high notes up to 4.5 cents off; on the raw difference the worst
 * case measured 0.25 cents. That is what this pins.
 *
 *   node tools/check-pitch.js
 */
require('../js/pitch-track.js');
const P = globalThis.ASPitch;

const NOTES = [23, 28, 33, 36, 40, 45, 50, 55, 59, 62, 64, 67, 69, 72, 76, 81, 84, 88];   // B0 .. E6
let worst = 0, where = '';
const fails = [];
for (const sr of [44100, 48000]) {
  for (const m of NOTES) {
    for (const cents of [-23, 0, 23]) {
      const hz = 440 * Math.pow(2, (m - 69 + cents / 100) / 12), N = 4096, b = new Float32Array(N);
      for (let i = 0; i < N; i++) { let v = 0; for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * hz * h * i / sr + h) / h; b[i] = 0.3 * v; }
      const r = P.yin(b, sr, { minHz: 25, maxHz: 1600, threshold: 0.12 });
      const err = r.hz ? 1200 * Math.log2(r.hz / hz) : Infinity;
      if (Math.abs(err) > worst) { worst = Math.abs(err); where = P.midiName(m) + ' ' + cents + 'c @' + sr; }
      if (!(Math.abs(err) <= 1)) fails.push(P.midiName(m) + (cents ? ' ' + cents + ' cents' : '') + ' at ' + sr + ' Hz read ' + (r.hz || 0).toFixed(2) + ' Hz (' + err.toFixed(2) + ' cents off)');
    }
  }
}
if (fails.length) {
  fails.forEach((f) => console.error('  FAIL ' + f));
  console.error('check-pitch: ' + fails.length + ' failure(s).');
  process.exit(1);
}
console.log('check-pitch: YIN within 1 cent from B0 to E6 (worst ' + worst.toFixed(2) + ' cents, ' + where + ').');
