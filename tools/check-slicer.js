#!/usr/bin/env node
/*
 * Checks js/slicer.js, which chops samples for /sample-slicer and the
 * editor.
 *
 * Fixtures are drum breaks synthesized hit by hit at known sample positions:
 * kick, snare, closed hat, clap and rim. Levels run from 0 dB down to -24 dB
 * (a ghost hat has to be found as well as a kick). A reverb tail runs under
 * everything, some hits are only 60 ms apart, and there is a noise floor.
 * Required, at the default sensitivity:
 *
 *   - at least 90% of hits found. A hit counts when its cut is at most 5 ms
 *     before the true start and at most 1 ms after it; later loses the
 *     attack. The misses are almost all quiet hits (around -20 dB) landing
 *     60 ms after a loud one, still ringing over them;
 *   - at most 5% of cuts not a hit;
 *   - a sustained chord, fading in from silence, is cut at most where it
 *     begins;
 *   - every slice starts and ends at exactly zero (no click on a pad), and
 *     the slices together are exactly as long as the input.
 *
 *   node tools/check-slicer.js
 */
const S = require('../js/slicer.js');

const SR = 44100;
let seed = 3;
function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647 * 2 - 1; }

const VOICES = {
  kick: (x) => Math.exp(-x / 0.08) * Math.sin(2 * Math.PI * (48 + 110 * Math.exp(-x / 0.025)) * x),
  snare: (x) => Math.exp(-x / 0.06) * (0.6 * rnd() + 0.4 * Math.sin(2 * Math.PI * 190 * x)),
  hat: (x) => Math.exp(-x / 0.015) * rnd(),
  clap: (x) => (x < 0.03 ? (Math.floor(x / 0.01) % 2 ? 0.4 : 1) : 1) * Math.exp(-x / 0.05) * rnd(),
  rim: (x) => Math.exp(-x / 0.01) * Math.sin(2 * Math.PI * 1700 * x)
};

function breakbeat(k) {
  const dur = 6, n = SR * dur, d = new Float32Array(n), truth = [];
  let t = 0.2 + 0.05 * k;
  const names = Object.keys(VOICES);
  while (t < dur - 0.4) {
    const v = names[Math.floor((rnd() + 1) / 2 * names.length) % names.length];
    const db = -24 * (rnd() + 1) / 2, g = Math.pow(10, db / 20);
    const i0 = Math.round(t * SR);
    for (let i = 0; i < SR * 0.35 && i0 + i < n; i++) d[i0 + i] += 0.8 * g * VOICES[v](i / SR);
    truth.push({ t: i0 / SR, v, db });
    t += [0.06, 0.125, 0.18, 0.25, 0.375][Math.floor((rnd() + 1) / 2 * 5) % 5];
  }
  // A reverb-ish tail under everything (noise that follows the level with a
  // quarter-second decay, settling around -34 dB under a busy break), and a
  // noise floor at -60 dB.
  let tail = 0;
  for (let i = 0; i < n; i++) { tail = tail * 0.9999 + 0.00002 * Math.abs(d[i]); d[i] += tail * rnd() + 0.001 * rnd(); }
  return { d, truth };
}

const fails = [];
let hits = 0, found = 0, extra = 0, cuts = 0, worstEarly = 0;
const misses = [];
for (let k = 0; k < 8; k++) {
  const { d, truth } = breakbeat(k);
  const got = S.onsets([d], SR);
  truth.forEach((h) => {
    hits++;
    const m = got.filter((c) => c <= h.t + 0.001 && c >= h.t - 0.005)[0];
    if (m != null) { found++; worstEarly = Math.max(worstEarly, h.t - m); }
    else misses.push('break ' + k + ': ' + h.v + ' at ' + h.t.toFixed(3) + ' s (' + h.db.toFixed(0) + ' dB) not cut within 5 ms before it' +
      ' (nearest cut ' + (got.reduce((a, c) => Math.abs(c - h.t) < Math.abs(a - h.t) ? c : a, 1e9)).toFixed(3) + ')');
  });
  got.forEach((c) => { cuts++; if (!truth.some((h) => c <= h.t + 0.001 && c >= h.t - 0.005)) extra++; });

  // Cutting: zero ends, total length exact.
  const sl = S.cut([d], SR, got.length ? [0].concat(got) : [0]);
  const total = sl.reduce((a, s) => a + s.channels[0].length, 0);
  if (total !== d.length) fails.push('break ' + k + ': slices total ' + total + ' samples, input ' + d.length);
  sl.forEach((s, i) => {
    const c = s.channels[0];
    if (c[0] !== 0 || c[c.length - 1] !== 0) fails.push('break ' + k + ' slice ' + i + ' does not start and end on zero');
  });
}

if (found / hits < 0.9) { fails.push('only ' + found + ' of ' + hits + ' hits cut, needs 90%'); misses.slice(0, 10).forEach((m) => fails.push('  ' + m)); }
if (extra / Math.max(1, cuts) > 0.05) fails.push(extra + ' of ' + cuts + ' cuts are not hits, allowed 5%');

// A sustained pad: a chord that swells in over a second and holds.
{
  const n = SR * 4, d = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR, env = Math.min(1, t / 1.0);
    d[i] = 0.2 * env * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 277.2 * t) + Math.sin(2 * Math.PI * 329.6 * t));
  }
  // It may be cut where it starts sounding, and nowhere after.
  const got = S.onsets([d], SR).filter((t) => t > 0.2);
  if (got.length) fails.push('a sustained pad gave ' + got.length + ' cuts after it began');
}

// Equal slices and the grid.
{
  const e = S.equal(4, 16);
  if (e.length !== 16 || Math.abs(e[1] - 0.25) > 1e-12) fails.push('equal slices wrong');
  const g = S.grid(8, 120, 1, 0.1);
  if (g.length !== 16 || Math.abs(g[3] - 1.6) > 1e-9) fails.push('grid slices wrong: ' + g.slice(0, 4).join(', '));
}

console.log('  ' + found + '/' + hits + ' hits cut, ' + extra + ' false cuts, worst cut ' + (worstEarly * 1000).toFixed(1) + ' ms before its hit');
if (fails.length) {
  fails.slice(0, 20).forEach((f) => console.error('  FAIL ' + f));
  console.error('check-slicer: ' + fails.length + ' failure(s).');
  process.exit(1);
}
console.log('check-slicer: ' + (found / hits * 100).toFixed(1) + '% of hits from 0 to -24 dB cut within 5 ms before their start, ' + (extra / Math.max(1, cuts) * 100).toFixed(1) + '% false cuts, a pad left whole, and every slice starts and ends on zero.');
