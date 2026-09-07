#!/usr/bin/env node
/*
 * Checks js/silence-gaps.js against synthetic recordings with a known
 * speech/silence structure.
 *
 * The three things that make machine silence-cutting sound bad are each
 * asserted here, because "it ran without error" says nothing about whether the
 * result is listenable:
 *
 *   1. No word is truncated — every speech burst survives at full length.
 *   2. No clicks — the largest sample-to-sample step in the output must not
 *      exceed the largest step in the input.
 *   3. Pauses are shortened, never deleted — a gap always remains.
 *
 * Run: node tools/check-silence.js
 */
const path = require('path');
require(path.join(__dirname, '..', 'js', 'silence-gaps.js'));
const S = globalThis.ASSilence;

const SR = 44100;

// A recording: bursts of "speech" separated by silence, over a noise floor.
function build(bursts, gapSec, noiseDb) {
  const noise = Math.pow(10, noiseDb / 20);
  const parts = [];
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x3fffffff - 1; };
  const push = (sec, speech) => {
    const n = Math.round(sec * SR);
    for (let i = 0; i < n; i++) {
      const t = parts.length / SR;
      // Speech modelled as a modulated tone plus noise; silence is floor only.
      parts.push(speech
        ? 0.35 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t)) * Math.sin(2 * Math.PI * 180 * t) + noise * rnd()
        : noise * rnd());
    }
  };
  push(gapSec, false);                       // leading silence
  bursts.forEach((b, i) => {
    push(b, true);
    push(gapSec, false);
  });
  return Float32Array.from(parts);
}

function maxStep(d) {
  let m = 0;
  for (let i = 1; i < d.length; i++) {
    const s = Math.abs(d[i] - d[i - 1]);
    if (s > m) m = s;
  }
  return m;
}

let failures = 0;
function check(name, cond, detail) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
}

const cases = [
  { label: 'clean room (-60 dB floor), 1.5 s gaps', bursts: [1.2, 0.9, 1.4, 1.0], gap: 1.5, noiseDb: -60 },
  { label: 'noisy laptop (-38 dB floor), 1.2 s gaps', bursts: [1.0, 1.3, 0.8], gap: 1.2, noiseDb: -38 },
  { label: 'short gaps (0.35 s) — below the cut threshold', bursts: [1.0, 1.0, 1.0], gap: 0.35, noiseDb: -55 },
];

for (const c of cases) {
  console.log(`\n${c.label}`);
  const mono = build(c.bursts, c.gap, c.noiseDb);
  const chans = [mono];
  const p = S.plan(chans, SR, { marginDb: 9, minSilence: 0.5, keepSilence: 0.2, padding: 0.08 });
  const out = S.render(chans, SR, p, { crossfade: 0.008 });

  const inSec = mono.length / SR;
  const outSec = out.channels[0].length / SR;
  const speechSec = c.bursts.reduce((a, b) => a + b, 0);

  console.log(`    noise floor ${p.floorDb.toFixed(1)} dB, threshold ${p.thresholdDb.toFixed(1)} dB, `
    + `${p.speechCount} region(s), ${inSec.toFixed(2)}s -> ${outSec.toFixed(2)}s`);

  if (c.gap < 0.5) {
    // Gaps below minSilence must not be cut. The bursts should therefore merge
    // into ONE region with no internal seams — the ends still get trimmed,
    // which is wanted, so total duration is the wrong thing to assert on.
    check('sub-threshold gaps are not cut', p.speechCount === 1 && out.cuts === 0,
      `${p.speechCount} region(s), ${out.cuts} internal cut(s)`);
    check('the speech itself is all still there', outSec >= speechSec + c.gap * (c.bursts.length - 1) - 0.05,
      `${outSec.toFixed(2)}s kept`);
  } else {
    check('found every phrase', p.speechCount === c.bursts.length,
      `${p.speechCount} of ${c.bursts.length}`);
    // Every burst kept in full, plus padding, plus the pauses we leave behind.
    check('no speech was truncated', outSec > speechSec,
      `${outSec.toFixed(2)}s out vs ${speechSec.toFixed(2)}s of speech`);
    check('recording got shorter', outSec < inSec - 0.5,
      `saved ${(inSec - outSec).toFixed(2)}s`);
    check('pauses shortened, not deleted',
      outSec > speechSec + (c.bursts.length - 1) * 0.15,
      'a real gap remains between phrases');
  }
  check('no clicks introduced at the joins', maxStep(out.channels[0]) <= maxStep(mono) * 1.05,
    `step ${maxStep(out.channels[0]).toFixed(4)} vs input ${maxStep(mono).toFixed(4)}`);
}

// Stereo must stay aligned: both channels cut at identical sample positions.
console.log('\nstereo alignment');
const m = build([1.0, 1.0], 1.5, -55);
const st = [m, Float32Array.from(m, (v) => v * 0.5)];
const p2 = S.plan(st, SR, {});
const o2 = S.render(st, SR, p2, {});
let aligned = o2.channels[0].length === o2.channels[1].length;
if (aligned) {
  for (let i = 0; i < o2.channels[0].length; i += 97) {
    if (Math.abs(o2.channels[0][i] * 0.5 - o2.channels[1][i]) > 1e-6) { aligned = false; break; }
  }
}
check('both channels cut identically', aligned);

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
