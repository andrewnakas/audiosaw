#!/usr/bin/env node
/*
 * Checks the pitch corrector actually corrects pitch, and does not wreck
 * anything else on the way.
 *
 * Four properties, because "it produced audio" is not evidence:
 *   1. An off-pitch note lands on the target note.
 *   2. Duration is unchanged — PSOLA must not act as a time stretcher.
 *   3. A note already in tune is left essentially alone.
 *   4. Nothing clips, and the level does not pump.
 *
 * Run: node tools/check-autotune.js
 */
const path = require('path');
require(path.join(__dirname, '..', 'js', 'pitch-track.js'));
require(path.join(__dirname, '..', 'js', 'autotune.js'));
const P = globalThis.ASPitch, A = globalThis.ASAutotune;
const SR = 44100;

function tone(hz, sec, amp) {
  const n = Math.round(SR * sec);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / (SR * 0.02)) * Math.min(1, (n - i) / (SR * 0.02));
    let v = 0;
    for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * hz * h * i / SR) / h;
    b[i] = (amp === undefined ? 0.4 : amp) * env * v;
  }
  return b;
}

// Median measured pitch over the steady middle of a signal.
function measure(x) {
  const frames = P.track(x, SR).filter((f) => f.clarity > 0.6 && f.hz > 0);
  const mid = frames.slice(Math.floor(frames.length * 0.25), Math.floor(frames.length * 0.75));
  if (!mid.length) return 0;
  const hz = mid.map((f) => f.hz).sort((a, b) => a - b);
  return hz[Math.floor(hz.length / 2)];
}

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

console.log('scale snapping (pure logic)');
const cMajor = A.SCALES.major;
check('A4 + 40 cents snaps to A4', A.snapMidi(69.4, 0, cMajor) === 69);
check('A#4 in C major snaps to A4 or B4', [69, 71].includes(A.snapMidi(70, 0, cMajor)));
check('C4 stays C4', A.snapMidi(60, 0, cMajor) === 60);
check('chromatic keeps every semitone', A.snapMidi(70, 0, A.SCALES.chromatic) === 70);

console.log('\ncorrecting a flat note (A4 sung 45 cents flat -> 440 Hz)');
const flatHz = 440 * Math.pow(2, -45 / 1200);          // ~428.6 Hz
const flat = tone(flatHz, 1.2);
const beforeHz = measure(flat);
const r1 = A.correct([flat], SR, P.track(flat, SR), { rootPc: 9, scale: 'major', strength: 1, retuneSec: 0.005 });
const afterHz = measure(r1.channels[0]);
const centsBefore = 1200 * Math.log2(beforeHz / 440);
const centsAfter = 1200 * Math.log2(afterHz / 440);
console.log(`    before ${beforeHz.toFixed(2)} Hz (${centsBefore.toFixed(1)} cents), after ${afterHz.toFixed(2)} Hz (${centsAfter.toFixed(1)} cents)`);
check('pulled onto the target note (within 15 cents)', Math.abs(centsAfter) < 15, `${centsAfter.toFixed(1)} cents off`);
check('moved in the right direction', Math.abs(centsAfter) < Math.abs(centsBefore));
check('duration unchanged', r1.channels[0].length === flat.length,
  `${r1.channels[0].length} vs ${flat.length} samples`);

console.log('\ncorrecting a sharp note (E4 sung 40 cents sharp)');
const sharpHz = 329.63 * Math.pow(2, 40 / 1200);
const sharp = tone(sharpHz, 1.2);
const r2 = A.correct([sharp], SR, P.track(sharp, SR), { rootPc: 0, scale: 'major', strength: 1, retuneSec: 0.005 });
const after2 = measure(r2.channels[0]);
const cents2 = 1200 * Math.log2(after2 / 329.63);
console.log(`    before ${measure(sharp).toFixed(2)} Hz, after ${after2.toFixed(2)} Hz (${cents2.toFixed(1)} cents)`);
check('pulled onto E4 (within 15 cents)', Math.abs(cents2) < 15, `${cents2.toFixed(1)} cents off`);

console.log('\na note already in tune is left alone');
const inTune = tone(440, 1.0);
const r3 = A.correct([inTune], SR, P.track(inTune, SR), { rootPc: 9, scale: 'major', strength: 1, retuneSec: 0.005 });
const after3 = measure(r3.channels[0]);
const cents3 = 1200 * Math.log2(after3 / 440);
check('pitch unmoved (within 8 cents)', Math.abs(cents3) < 8, `${cents3.toFixed(1)} cents`);

console.log('\nlevel and clipping');
for (const [label, res, src] of [['flat note', r1, flat], ['sharp note', r2, sharp], ['in tune', r3, inTune]]) {
  const out = res.channels[0];
  let peak = 0, sumIn = 0, sumOut = 0;
  for (let i = 0; i < out.length; i++) { const a = Math.abs(out[i]); if (a > peak) peak = a; }
  const q0 = Math.floor(out.length * 0.3), q1 = Math.floor(out.length * 0.7);
  for (let i = q0; i < q1; i++) { sumIn += src[i] * src[i]; sumOut += out[i] * out[i]; }
  const rmsRatioDb = 20 * Math.log10(Math.sqrt(sumOut / (q1 - q0)) / Math.sqrt(sumIn / (q1 - q0)));
  check(`${label}: does not clip`, peak <= 1.0, `peak ${peak.toFixed(3)}`);
  check(`${label}: level held within 3 dB`, Math.abs(rmsRatioDb) < 3, `${rmsRatioDb >= 0 ? '+' : ''}${rmsRatioDb.toFixed(2)} dB`);
}

console.log('\nstrength at 50% moves only half way');
const r4 = A.correct([flat], SR, P.track(flat, SR), { rootPc: 9, scale: 'major', strength: 0.5, retuneSec: 0.005 });
const cents4 = 1200 * Math.log2(measure(r4.channels[0]) / 440);
console.log(`    fully corrected ${centsAfter.toFixed(1)} cents, half strength ${cents4.toFixed(1)} cents, uncorrected ${centsBefore.toFixed(1)} cents`);
check('lands between corrected and original', cents4 < -8 && cents4 > centsBefore + 5,
  `${cents4.toFixed(1)} cents`);

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
