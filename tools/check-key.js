#!/usr/bin/env node
/*
 * Checks js/key-detect.js against synthesized music in all 24 keys.
 *
 * Each fixture is eight seconds: a bass line, triads and a melody built from
 * harmonic tones (eight partials falling off as 1/n, so the fifth and the
 * major third are present in every note, as they are in real instruments).
 * Major keys play I-IV-V-I-vi-IV-V-I. Minor keys play i-iv-V-i-VI-iv-V-i,
 * with the raised seventh on V, as most minor-key music has it.
 *
 * Three versions of every key:
 *   clean    as above
 *   band     plus a kick drum on every beat, a hi-hat of white noise on the
 *            off-beats and a noise floor 30 dB down
 *   sharp    the clean version tuned 30 cents sharp
 *
 * Every one of the 72 must come out as the right key. The check also prints
 * how the two key profiles compare, which is how the default was chosen.
 *
 *   node tools/check-key.js
 */
const K = require('../js/key-detect.js');

const SR = 44100;
const MAJOR = [0, 2, 4, 5, 7, 9, 11], HMINOR = [0, 2, 3, 5, 7, 8, 11];

function tone(out, start, dur, midi, amp, cents) {
  const hz = 440 * Math.pow(2, (midi - 69 + (cents || 0) / 100) / 12);
  const i0 = Math.round(start * SR), n = Math.min(Math.round(dur * SR), out.length - i0);
  const decay = Math.exp(-1 / (SR * dur * 0.7));
  for (let h = 1; h <= 8; h++) {
    if (hz * h > SR / 2 - 1000) break;
    // sin(w i) by the two-term recurrence, far cheaper than Math.sin per sample.
    const w = 2 * Math.PI * hz * h / SR, c2 = 2 * Math.cos(w);
    let y = 0, prev = -Math.sin(w), env = 1;           // sin(0), sin(-w)
    for (let i = 0; i < n; i++) {
      out[i0 + i] += (amp / h) * Math.min(1, i / 400) * env * y;
      const next = c2 * y - prev; prev = y; y = next;
      env *= decay;
    }
  }
}

// Scale degree (0-based, may exceed 6) -> MIDI note in a key.
function deg(tonicMidi, scale, d) {
  const o = Math.floor(d / 7), k = ((d % 7) + 7) % 7;
  return tonicMidi + 12 * o + scale[k];
}

let seed = 1;
function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }

function fixture(pc, mode, variant) {
  const out = new Float32Array(SR * 8);
  const scale = mode === 'major' ? MAJOR : HMINOR;
  const cents = variant === 'sharp' ? 30 : 0;
  const tonic = 48 + pc;                                    // C3..B3
  const prog = mode === 'major' ? [0, 3, 4, 0, 5, 3, 4, 0] : [0, 3, 4, 0, 5, 3, 4, 0];
  prog.forEach((root, i) => {
    const t = i;
    tone(out, t, 1, deg(tonic - 12, scale, root), 0.25, cents);             // bass
    [0, 2, 4].forEach((s) => tone(out, t, 1, deg(tonic, scale, root + s), 0.12, cents));   // triad
    // Melody: two notes per chord, a chord tone then a step above it.
    tone(out, t, 0.5, deg(tonic + 12, scale, root + 2), 0.1, cents);
    tone(out, t + 0.5, 0.5, deg(tonic + 12, scale, root + 3), 0.1, cents);
  });
  if (variant === 'band') {
    for (let b = 0; b < 16; b++) {
      const i0 = b * SR / 2;
      for (let i = 0; i < SR * 0.15; i++) {                // kick: a falling sine
        const t = i / SR, f = 50 + 100 * Math.exp(-t / 0.03);
        out[i0 + i] += 0.6 * Math.exp(-t / 0.05) * Math.sin(2 * Math.PI * f * t);
      }
      const h0 = i0 + SR / 4;
      for (let i = 0; i < SR * 0.04 && h0 + i < out.length; i++) out[h0 + i] += 0.15 * (rnd() * 2 - 1) * Math.exp(-i / (SR * 0.01));
    }
    for (let i = 0; i < out.length; i++) out[i] += 0.01 * (rnd() * 2 - 1);
  }
  return out;
}

const fails = [];
const tally = {};
let relative = 0;
const PROFILES = ['temperley', 'krumhansl'];
PROFILES.forEach((p) => { tally[p] = { right: 0, total: 0, margins: [] }; });
for (const variant of ['clean', 'band', 'sharp']) {
  for (const mode of ['major', 'minor']) {
    for (let pc = 0; pc < 12; pc++) {
      const audio = [fixture(pc, mode, variant)];
      for (const profile of PROFILES) {
        const res = K.analyse(audio, SR, { profile });
        const right = res && res.pc === pc && res.mode === mode;
        tally[profile].total++;
        if (right) { tally[profile].right++; tally[profile].margins.push(res.margin); }
        if (profile !== 'temperley') continue;
        if (!right) {
          fails.push(variant + ' ' + K.keyName(pc, mode) + ' read as ' + (res ? res.name + ' (runner-up ' + res.runnerUp.name + ')' : 'nothing'));
          if (res && res.camelot.slice(0, -1) === K.camelot(pc, mode).slice(0, -1)) relative++;
        }
        if (variant === 'sharp' && res && Math.abs(res.tuningCents - 30) > 5) fails.push('sharp ' + K.keyName(pc, mode) + ': tuning read as ' + res.tuningCents + ' cents, not 30');
        if (variant === 'clean' && res && Math.abs(res.tuningCents) > 5) fails.push('clean ' + K.keyName(pc, mode) + ': tuning read as ' + res.tuningCents + ' cents, not 0');
      }
    }
  }
}

// Reported, not required: the natural-minor pop loop i-VI-III-VII (Am F C G)
// with the tonic in the bass on beat one. It uses exactly the notes of the
// relative major, so only the weighting towards the tonic can separate them.
const NMINOR = [0, 2, 3, 5, 7, 8, 10];
const popTally = { right: 0, relative: 0, runnerUp: 0, total: 0 };
for (let pc = 0; pc < 12; pc++) {
  const out = new Float32Array(SR * 8), tonic = 48 + pc;
  [0, 5, 2, 6, 0, 5, 2, 6].forEach((root, i) => {
    tone(out, i, 1, deg(tonic - 12, NMINOR, root), 0.25);
    [0, 2, 4].forEach((st) => tone(out, i, 1, deg(tonic, NMINOR, root + st), 0.12));
    tone(out, i, 1, deg(tonic + 12, NMINOR, i % 2 ? 4 : 2), 0.1);
  });
  const res = K.analyse([out], SR);
  popTally.total++;
  if (res && res.pc === pc && res.mode === 'minor') popTally.right++;
  else if (res && res.pc === (pc + 3) % 12 && res.mode === 'major') {
    popTally.relative++;
    if (res.runnerUp.pc === pc && res.runnerUp.mode === 'minor') popTally.runnerUp++;
  }
}
console.log('  natural-minor pop loop (reported, not required): ' + popTally.right + '/12 right, ' + popTally.relative + ' read as the relative major, with the minor key as runner-up in ' + popTally.runnerUp);

// The small helpers the pages use.
const eq = (a, b, msg) => { if (a !== b) fails.push(msg + ': got ' + a + ', want ' + b); };
eq(K.camelot(0, 'major'), '8B', 'C major is 8B');
eq(K.camelot(9, 'minor'), '8A', 'A minor is 8A');
eq(K.camelot(7, 'major'), '9B', 'G major is 9B');
eq(K.camelot(5, 'minor'), '4A', 'F minor is 4A');
eq(K.camelot(6, 'major'), '2B', 'F# major is 2B');
eq(K.keyName(1, 'major'), 'Db major', 'spelling');
eq(K.keyName(1, 'minor'), 'C# minor', 'spelling');
eq(K.shiftBetween({ pc: 0, mode: 'major' }, { pc: 2, mode: 'major' }), 2, 'C -> D is up 2');
eq(K.shiftBetween({ pc: 0, mode: 'major' }, { pc: 10, mode: 'major' }), -2, 'C -> Bb is down 2');
eq(K.shiftBetween({ pc: 9, mode: 'minor' }, { pc: 0, mode: 'major' }), 0, 'A minor -> C major needs no shift');
eq(K.shiftBetween({ pc: 9, mode: 'minor' }, { pc: 2, mode: 'major' }), 2, 'A minor -> D major is up 2 (via C major)');
eq(K.transpose({ pc: 11, mode: 'minor' }, 2).name, 'C# minor', 'B minor up 2');

const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
Object.keys(tally).forEach((p) => {
  const t = tally[p];
  console.log('  ' + p + ': ' + t.right + '/' + t.total + ' right, median margin ' + median(t.margins).toFixed(3));
});
if (fails.length) {
  fails.forEach((f) => console.error('  FAIL ' + f));
  console.error('check-key: ' + fails.length + ' failure(s)' + (relative ? ', ' + relative + ' of them the relative major/minor' : '') + '.');
  process.exit(1);
}
console.log('check-key: all 24 keys read right, clean, with a band over them and tuned 30 cents sharp; tuning measured within 5 cents.');
