#!/usr/bin/env node
/*
 * End-to-end check for the audio-to-MIDI path.
 *
 *   synthesised melody -> pitch tracking -> note segmentation -> MIDI bytes
 *   -> parsed back by an independent reader written here -> compared to the
 *      notes we started from.
 *
 * The parser is deliberately written from the spec rather than sharing code
 * with the writer, so a mistake in variable-length quantities or chunk lengths
 * shows up as a mismatch instead of cancelling out.
 *
 * Run: node tools/check-midi.js
 */
const path = require('path');
require(path.join(__dirname, '..', 'js', 'pitch-track.js'));
require(path.join(__dirname, '..', 'js', 'midi-write.js'));
const P = globalThis.ASPitch, M = globalThis.ASMidi;
const SR = 44100;

/* ----------------------------------------------------- independent reader */
function parseMidi(bytes) {
  let i = 0;
  const str4 = () => String.fromCharCode(bytes[i++], bytes[i++], bytes[i++], bytes[i++]);
  const u32 = () => ((bytes[i++] << 24) | (bytes[i++] << 16) | (bytes[i++] << 8) | bytes[i++]) >>> 0;
  const u16 = () => (bytes[i++] << 8) | bytes[i++];

  if (str4() !== 'MThd') throw new Error('missing MThd');
  const headerLen = u32();
  if (headerLen !== 6) throw new Error(`MThd length ${headerLen}, expected 6`);
  const format = u16(), tracks = u16(), ppq = u16();

  if (str4() !== 'MTrk') throw new Error('missing MTrk');
  const trackLen = u32();
  const trackStart = i;

  const readVlq = () => {
    let v = 0, b;
    do { b = bytes[i++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80);
    return v;
  };

  let tick = 0, running = 0, tempo = 500000;
  const on = new Map(), notes = [];
  while (i < trackStart + trackLen) {
    tick += readVlq();
    let status = bytes[i];
    if (status & 0x80) { i++; running = status; } else { status = running; }
    const type = status & 0xf0;
    if (status === 0xff) {
      const meta = bytes[i++];
      const len = readVlq();
      if (meta === 0x51) tempo = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      if (meta === 0x2f) { i += len; break; }
      i += len;
    } else if (type === 0x90 || type === 0x80) {
      const key = bytes[i++], vel = bytes[i++];
      if (type === 0x90 && vel > 0) {
        on.set(key, { tick, vel });
      } else {
        const s = on.get(key);
        if (s) { notes.push({ midi: key, startTick: s.tick, durTicks: tick - s.tick, velocity: s.vel }); on.delete(key); }
      }
    } else if (type === 0xc0 || type === 0xd0) { i += 1; } else { i += 2; }
  }
  if (i !== trackStart + trackLen) {
    throw new Error(`track length mismatch: declared ${trackLen}, consumed ${i - trackStart}`);
  }
  if (on.size) throw new Error(`${on.size} note(s) never turned off`);
  const secPerTick = tempo / 1e6 / ppq;
  return {
    format, tracks, ppq, bpm: 60e6 / tempo,
    notes: notes.map((n) => ({
      midi: n.midi, velocity: n.velocity,
      start: n.startTick * secPerTick, duration: n.durTicks * secPerTick,
    })).sort((a, b) => a.start - b.start),
  };
}

/* --------------------------------------------------------------- fixture */
function synth(melody, gap) {
  const total = Math.round(SR * (0.05 + melody.reduce((a, m) => a + m[2] + gap, 0)));
  const sig = new Float32Array(total);
  let pos = Math.round(SR * 0.05);
  const expected = [];
  for (const [name, hz, dur] of melody) {
    const n = Math.round(SR * dur);
    expected.push({ name, midi: Math.round(P.hzToMidi(hz)), start: pos / SR, duration: dur });
    for (let k = 0; k < n && pos + k < total; k++) {
      const env = Math.min(1, k / (SR * 0.01)) * Math.min(1, (n - k) / (SR * 0.02));
      let v = 0;
      for (let h = 1; h <= 8; h++) v += Math.sin(2 * Math.PI * hz * h * k / SR) / h;
      sig[pos + k] = 0.35 * env * v;
    }
    pos += n + Math.round(SR * gap);
  }
  return { sig, expected };
}

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

console.log('variable-length quantity encoding (spec examples)');
const vlqCases = [[0, [0x00]], [0x40, [0x40]], [0x7f, [0x7f]], [0x80, [0x81, 0x00]],
  [0x2000, [0xc0, 0x00]], [0x3fff, [0xff, 0x7f]], [0x100000, [0xc0, 0x80, 0x00]],
  [0x0fffffff, [0xff, 0xff, 0xff, 0x7f]]];
for (const [v, want] of vlqCases) {
  const got = M.vlq(v);
  check(`vlq(0x${v.toString(16)})`, JSON.stringify(got) === JSON.stringify(want),
    `[${got.map((b) => '0x' + b.toString(16)).join(' ')}]`);
}

console.log('\nmelody round trip at 96 BPM');
const melody = [['C4', 261.63, 0.45], ['D4', 293.66, 0.45], ['E4', 329.63, 0.45],
  ['G4', 392.00, 0.6], ['E4', 329.63, 0.45], ['C4', 261.63, 0.7]];
const { sig, expected } = synth(melody, 0.08);
const notes = P.segment(P.track(sig, SR), {});
const bytes = M.build(notes, { bpm: 96, trackName: 'AudioSaw' });
const parsed = parseMidi(bytes);

check('header is SMF type 0, one track', parsed.format === 0 && parsed.tracks === 1);
check('tempo survives the round trip', Math.abs(parsed.bpm - 96) < 0.1, `${parsed.bpm.toFixed(2)} BPM`);
check('note count matches', parsed.notes.length === expected.length,
  `${parsed.notes.length} of ${expected.length}`);

let pitchBad = 0, timeBad = 0, durBad = 0;
for (let k = 0; k < Math.min(parsed.notes.length, expected.length); k++) {
  const g = parsed.notes[k], e = expected[k];
  if (g.midi !== e.midi) pitchBad++;
  if (Math.abs(g.start - e.start) > 0.07) timeBad++;
  if (Math.abs(g.duration - e.duration) > 0.12) durBad++;
  console.log(`    ${e.name} -> ${P.midiName(g.midi).padEnd(4)} start ${g.start.toFixed(3)}s (want ${e.start.toFixed(3)})  `
    + `dur ${g.duration.toFixed(3)}s (want ${e.duration.toFixed(3)})  vel ${g.velocity}`);
}
check('every pitch correct', pitchBad === 0, `${pitchBad} wrong`);
check('every start within 70 ms', timeBad === 0, `${timeBad} off`);
check('every duration within 120 ms', durBad === 0, `${durBad} off`);
check('velocities in range', parsed.notes.every((n) => n.velocity >= 1 && n.velocity <= 127));

console.log('\nrepeated note at the same pitch (off must precede on)');
const rep = M.build([
  { midi: 60, start: 0, duration: 0.5, velocity: 90 },
  { midi: 60, start: 0.5, duration: 0.5, velocity: 90 },
], { bpm: 120 });
const rp = parseMidi(rep);
check('both repeats survive as separate notes', rp.notes.length === 2, `${rp.notes.length} notes`);
check('they do not overlap', rp.notes.length === 2
  && rp.notes[0].start + rp.notes[0].duration <= rp.notes[1].start + 1e-6);

console.log('\nempty input');
const emptyParsed = parseMidi(M.build([], { bpm: 120 }));
check('valid file with no notes', emptyParsed.notes.length === 0);

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
