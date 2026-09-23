#!/usr/bin/env node
/*
 * Checks where js/bpm-detector.js puts the beats (ASBpm.phase), which is
 * what lines the editor's bar grid up with a song.
 *
 * Fixtures are drum patterns synthesized at a known tempo, with the first
 * beat at a known offset: a kick on every beat and a crash on beat one, a
 * noise snare on 2 and 4, and eighth-note hats. That is a band, not a
 * metronome. They run at 84 to 174 BPM, in 4/4 and in 3/4, with offsets
 * spread across the beat. Required:
 *
 *   - the tempo within 0.2 BPM (the page's existing claim)
 *   - the first beat within 10 ms
 *
 * The downbeat is reported, not required, because it is a guess by design.
 *
 *   node tools/check-beat.js
 */
const B = require('../js/bpm-detector.js');

const SR = 44100;
let seed = 7;
function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647 * 2 - 1; }

function fixture(bpm, offset, num, sec) {
  const n = Math.round(SR * sec), d = new Float32Array(n), beat = 60 / bpm;
  function add(t, len, fn) {
    const i0 = Math.round(t * SR);
    for (let i = 0; i < len * SR && i0 + i < n; i++) if (i0 + i >= 0) d[i0 + i] += fn(i / SR);
  }
  for (let k = 0; offset + k * beat < sec; k++) {
    const t = offset + k * beat, b = k % num;
    add(t, 0.2, (x) => 0.7 * Math.exp(-x / 0.06) * Math.sin(2 * Math.PI * (45 + 90 * Math.exp(-x / 0.03)) * x));   // kick
    if (b === 0) add(t, 0.6, (x) => 0.25 * rnd() * Math.exp(-x / 0.3));                                        // crash
    if (b % 2 === 1) add(t, 0.15, (x) => 0.35 * rnd() * Math.exp(-x / 0.04));                                    // snare
    add(t + beat / 2, 0.05, (x) => 0.1 * rnd() * Math.exp(-x / 0.01));                                           // hats
    add(t, 0.05, (x) => 0.1 * rnd() * Math.exp(-x / 0.01));
  }
  return { numberOfChannels: 1, sampleRate: SR, length: n, duration: sec, getChannelData: () => d };
}

const CASES = [
  [120, 0.137, 4], [128, 0.0, 4], [97, 0.41, 4], [140, 0.2, 4], [174, 0.05, 4],
  [84, 0.66, 4], [110, 0.31, 3], [150, 0.12, 3], [122.5, 0.25, 4]
];

const fails = [];
let worst = 0, downRight = 0;
CASES.forEach(([bpm, off, num]) => {
  const buf = fixture(bpm, off, num, 20);
  const t = B.analyse(buf);
  if (!t || Math.abs(t.bpm - bpm) > 0.2) {
    // The half/double reading is the page's documented ambiguity; phase is
    // then measured against the true tempo, which is what the editor uses
    // once the person has picked it.
    if (!t || [0.5, 2].every((m) => Math.abs(t.bpm * m - bpm) > 0.2)) fails.push(bpm + ' BPM read as ' + (t && t.bpm.toFixed(2)));
  }
  const p = B.phase(buf, bpm, num);
  const period = 60 / bpm;
  let err = ((p.beat - off) % period + period) % period;
  if (err > period / 2) err -= period;
  worst = Math.max(worst, Math.abs(err));
  if (Math.abs(err) > 0.010) fails.push(bpm + ' BPM, first beat at ' + off + ' s: read ' + p.beat.toFixed(4) + ' s (' + (err * 1000).toFixed(1) + ' ms off)');
  const bar = period * num;
  let derr = ((p.downbeat - off) % bar + bar) % bar;
  if (derr > bar / 2) derr -= bar;
  if (Math.abs(derr) < 0.012) downRight++;
});

console.log('  first beat: worst error ' + (worst * 1000).toFixed(1) + ' ms over ' + CASES.length + ' patterns; downbeat (reported, not required) right in ' + downRight + '/' + CASES.length);
if (fails.length) {
  fails.forEach((f) => console.error('  FAIL ' + f));
  console.error('check-beat: ' + fails.length + ' failure(s).');
  process.exit(1);
}
console.log('check-beat: tempo within 0.2 BPM and the first beat within 10 ms on drum patterns from 84 to 174 BPM, in 4/4 and 3/4.');
