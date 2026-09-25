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

/* ------------------------------------------- js/midi-read.js, for the editor */
// The editor's reader has to take files other programs wrote, so it is fed a
// type 1 file built by hand here, byte by byte, with the things real files do.
const R = require(path.join(__dirname, '..', 'js', 'midi-read.js'));
console.log('\nmidi-read.js: our own files');
const back = R.parse(bytes);
check('reads what midi-write.js writes, note for note', back.parts.length === 1 && back.parts[0].notes.length === parsed.notes.length &&
  back.parts[0].notes.every((n, k) => n.midi === parsed.notes[k].midi && Math.abs(n.start - parsed.notes[k].start) < 1e-6 && Math.abs(n.duration - parsed.notes[k].duration) < 1e-6));

console.log('\nmidi-read.js: a type 1 file from elsewhere');
{
  const v = (n) => M.vlq(n);
  const chunk = (id, body) => [...id].map((c) => c.charCodeAt(0)).concat([(body.length >>> 24) & 255, (body.length >>> 16) & 255, (body.length >>> 8) & 255, body.length & 255], body);
  // Track 0: 120 BPM, 4/4... then 60 BPM from beat 2 (tick 960 at 480 ppq).
  const t0 = [].concat(v(0), [0xff, 0x51, 3, 0x07, 0xa1, 0x20], v(0), [0xff, 0x58, 4, 3, 2, 24, 8],
    v(960), [0xff, 0x51, 3, 0x0f, 0x42, 0x40], v(0), [0xff, 0x2f, 0]);
  // Track 1, "Piano": program change, a sysex, running status, note-on with
  // velocity 0 as the off, the same pitch struck again while sounding, and
  // a note left on at the end.
  const t1 = [].concat(v(0), [0xff, 0x03, 5], [...'Piano'].map((c) => c.charCodeAt(0)),
    v(0), [0xc0, 0], v(0), [0xf0, 3, 0x7e, 0x09, 0xf7],
    v(0), [0x90, 60, 100], v(480), [60, 0],            // C4: beat 0-1 at 120 = 0-0.5 s
    v(0), [64, 90], v(960), [64, 0],                   // E4: tick 480-1440, across the tempo change: 0.5-2.0 s
    v(0), [67, 80], v(240), [67, 70], v(240), [0x80, 67, 0],   // G4 struck twice; the second ends the first
    v(0), [0x90, 72, 64], v(480), [0xff, 0x2f, 0]);    // C5 never turned off
  // Track 2: drums on channel 10.
  const t2 = [].concat(v(0), [0x99, 36, 110], v(120), [0x89, 36, 0], v(0), [0xff, 0x2f, 0]);
  const file = new Uint8Array([].concat(chunk('MThd', [0, 1, 0, 3, 0x01, 0xe0]), chunk('MTrk', t0), chunk('MTrk', t1), chunk('MTrk', t2)));
  const r = R.parse(file);
  const piano = r.parts.find((p) => p.name === 'Piano'), drums = r.parts.find((p) => p.drums);
  check('tempo and time signature read', Math.abs(r.bpm - 120) < 1e-9 && r.sig && r.sig.join('/') === '3/4', r.bpm + ' BPM, ' + (r.sig && r.sig.join('/')));
  check('the named track and the drum channel are separate parts', !!piano && !!drums && r.parts.length === 2, r.parts.map((p) => p.name).join(', '));
  const want = [[60, 0, 0.5], [64, 0.5, 1.5], [67, 2, 0.5], [67, 2.5, 0.5], [72, 3, 1]];   // 480 ticks = 0.5 s before tick 960, 1 s after
  const got = piano ? piano.notes.map((n) => [n.midi, +n.start.toFixed(6), +n.duration.toFixed(6)]) : [];
  check('ticks become seconds through the tempo change', JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
  check('running status, velocity-0 offs and a sysex are read', piano && piano.notes[0].velocity === 100 && piano.program === 0);
  check('drums on channel 10 are marked', drums && drums.notes.length === 1 && drums.notes[0].midi === 36 && Math.abs(drums.notes[0].duration - 0.125) < 1e-9);
  // The sustain pedal: C4 released under the pedal sounds until it lifts.
  const t3 = [].concat(v(0), [0xb0, 64, 127], v(0), [0x90, 60, 90], v(240), [0x80, 60, 0], v(720), [0xb0, 64, 0], v(0), [0xff, 0x2f, 0]);
  const ped = R.parse(new Uint8Array([].concat(chunk('MThd', [0, 1, 0, 1, 0x01, 0xe0]), chunk('MTrk', t3))));
  check('a note released under the sustain pedal lasts until the pedal lifts', ped.parts[0].notes.length === 1 && Math.abs(ped.parts[0].notes[0].duration - 1) < 1e-9, ped.parts[0].notes[0].duration + ' s');
  let threw = false; try { R.parse(new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1])); } catch (e) { threw = true; }
  check('a file cut short is refused, not half read', threw);
  threw = false; try { R.parse(new TextEncoder().encode('RIFF....WAVE')); } catch (e) { threw = /not a MIDI/.test(e.message); }
  check('a WAV is refused as not MIDI', threw);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
