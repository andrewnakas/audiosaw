#!/usr/bin/env node
/*
 * Checks /audio-to-sheet-music: js/sheet-music.js (ASSheet) on its own, then
 * the whole chain the page runs (pitch-track.js notes, bpm-detector.js tempo
 * and first beat, key-detect.js key, ASSheet) on synthesized melodies whose
 * notes are known. The MusicXML is read back by a reader written here, not
 * by the writer, so an error in one cannot cancel the other.
 *
 * Holds:
 *   - every measure's durations sum to exactly one bar, in 4/4, 3/4 and 6/8;
 *   - ties join back into the notes that were written;
 *   - quantizing notes played up to 25 ms off the grid gives back the grid;
 *   - from audio: pitches >= 95% and durations >= 90% right, tempo within
 *     2 BPM, and the key signature right, over several melodies and tempos;
 *   - sharps in sharp keys, flats in flat keys.
 */
const S = require('../js/sheet-music.js');
require('../js/pitch-track.js');
require('../js/bpm-detector.js');
const K = require('../js/key-detect.js');
const P = globalThis.ASPitch, B = globalThis.ASBpm;

let failed = 0;
const ok = (c, m) => { console.log((c ? '  ok  ' : '  FAIL ') + m); if (!c) failed++; };

// ---- a MusicXML reader of its own: measures of {midi|rest, dur, ties}
const STEP = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function read(xml) {
  const div = +(/<divisions>(\d+)<\/divisions>/.exec(xml) || [])[1];
  const beats = +(/<beats>(\d+)<\/beats>/.exec(xml) || [])[1], bt = +(/<beat-type>(\d+)<\/beat-type>/.exec(xml) || [])[1];
  const fifths = +(/<fifths>(-?\d+)<\/fifths>/.exec(xml) || [])[1];
  const measures = [...xml.matchAll(/<measure number="(\d+)">([\s\S]*?)<\/measure>/g)].map((m) =>
    [...m[2].matchAll(/<note>([\s\S]*?)<\/note>/g)].map((n) => {
      const t = n[1], rest = /<rest\/>/.test(t);
      const midi = rest ? null : (STEP[/<step>([A-G])<\/step>/.exec(t)[1]] + +((/<alter>(-?\d+)<\/alter>/.exec(t) || [0, 0])[1]) + 12 * (+/<octave>(\d+)<\/octave>/.exec(t)[1] + 1));
      return { rest, midi, dur: +/<duration>(\d+)<\/duration>/.exec(t)[1], start: /<tie type="start"\/>/.test(t), stop: /<tie type="stop"\/>/.test(t), alter: +((/<alter>(-?\d+)<\/alter>/.exec(t) || [0, 0])[1]) };
    }));
  return { div, beats, bt, fifths, measures, bar: div * 4 * beats / bt };
}
// Notes back from the reader: ties merged, positions in divisions.
function notesOf(r) {
  const out = []; let pos = 0, open = null;
  r.measures.forEach((ms) => ms.forEach((n) => {
    if (n.rest) { pos += n.dur; return; }
    if (n.stop && open && open.midi === n.midi) open.len += n.dur;
    else { open = { midi: n.midi, at: pos, len: n.dur }; out.push(open); }
    if (!n.start) open = null;
    pos += n.dur;
  }));
  return out;
}

console.log('notation');
for (const sig of [[4, 4], [3, 4], [6, 8]]) {
  // Awkward lengths and syncopations: 5, 7, 9 and 13 sixteenths, across bar lines.
  const q = []; let at = 1;
  [5, 7, 3, 9, 13, 2, 11, 6, 1, 15].forEach((len, i) => { q.push({ midi: 60 + (i * 5) % 12, at, len }); at += len + (i % 3 === 0 ? 2 : 0); });
  const r = read(S.toMusicXML(q, { sig, fifths: 0 }));
  const sums = r.measures.map((m) => m.reduce((a, n) => a + n.dur, 0));
  ok(sums.every((s) => s === r.bar), sig.join('/') + ': all ' + sums.length + ' measures sum to one bar (' + r.bar + ' divisions)');
  const back = notesOf(r);
  ok(back.length === q.length && back.every((n, i) => n.midi === q[i].midi && n.at === q[i].at && n.len === q[i].len), sig.join('/') + ': ties join back into the ' + q.length + ' notes written');
}
{
  const r1 = read(S.toMusicXML([{ midi: 66, at: 0, len: 4 }, { midi: 70, at: 4, len: 4 }], { fifths: 2 }));
  const r2 = read(S.toMusicXML([{ midi: 66, at: 0, len: 4 }, { midi: 70, at: 4, len: 4 }], { fifths: -3 }));
  ok(r1.measures[0][0].alter === 1 && r2.measures[0][0].alter === -1 && r2.measures[0][1].alter === -1, 'F#/A# in D major, Gb/Bb in Eb major');
  ok(S.fifthsOf(9, 'minor') === 0 && S.fifthsOf(2, 'major') === 2 && S.fifthsOf(3, 'major') === -3 && S.fifthsOf(4, 'minor') === 1, 'key signatures: A minor 0, D major 2, Eb major -3, E minor 1');
}
{
  let seed = 3; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  const bpm = 100, beat = 60 / bpm, truth = [];
  let at = 0;
  for (let i = 0; i < 40; i++) { const len = [2, 4, 4, 2, 6, 8, 1, 3][i % 8]; truth.push({ midi: 60 + i % 7, at, len }); at += len; }
  const played = truth.map((n) => ({ midi: n.midi, start: n.at / 4 * beat + rnd() * 0.025, duration: n.len / 4 * beat - 0.04 + rnd() * 0.02 }));
  const q = S.quantize(played, { bpm, firstBeat: 0 });
  const right = q.filter((n, i) => truth[i] && n.at === truth[i].at && n.len === truth[i].len).length;
  ok(right === truth.length, 'quantize: ' + right + '/' + truth.length + ' notes back on the grid from up to 25 ms off');
}

// ---- MIDI: chords and a piano grand staff. Read back staff by staff,
// <chord/> notes sharing their position and <backup> rewinding the bar.
function readStaves(xml) {
  const r = read(xml), staves = {};
  [...xml.matchAll(/<measure number="(\d+)">([\s\S]*?)<\/measure>/g)].forEach((m, mi) => {
    let pos = mi * r.bar, last = pos;
    const sums = {};
    for (const t of m[2].matchAll(/<note>([\s\S]*?)<\/note>|<backup><duration>(\d+)<\/duration><\/backup>/g)) {
      if (t[2]) { pos -= +t[2]; continue; }
      const n = t[1], st = +((/<staff>(\d+)<\/staff>/.exec(n) || [0, 1])[1]), dur = +/<duration>(\d+)<\/duration>/.exec(n)[1];
      const chord = /<chord\/>/.test(n);
      const at = chord ? last : pos;
      if (!chord) { sums[st] = (sums[st] || 0) + dur; last = pos; pos += dur; }
      const S2 = staves[st] = staves[st] || { notes: [], sums: [] };
      if (!chord) S2.sums[mi] = sums[st];
      if (/<rest\/>/.test(n)) continue;
      const midi = STEP[/<step>([A-G])<\/step>/.exec(n)[1]] + +((/<alter>(-?\d+)<\/alter>/.exec(n) || [0, 0])[1]) + 12 * (+/<octave>(\d+)<\/octave>/.exec(n)[1] + 1);
      S2.notes.push({ midi, at, dur, start: /<tie type="start"\/>/.test(n), stop: /<tie type="stop"\/>/.test(n) });
    }
  });
  // Ties merged: a stop joins the open note of the same pitch.
  Object.values(staves).forEach((S2) => {
    const out = [], open = {};
    S2.notes.forEach((n) => {
      if (n.stop && open[n.midi]) open[n.midi].len += n.dur;
      else { const o = { midi: n.midi, at: n.at, len: n.dur }; out.push(o); open[n.midi] = o; }
      if (!n.start) delete open[n.midi];
    });
    S2.merged = out;
  });
  return { r, staves };
}
let PIANO = null;
console.log('from MIDI');
{
  const MW = require('../js/midi-write.js') || globalThis.ASMidi;
  const MR = require('../js/midi-read.js');
  const W = MW.build ? MW : globalThis.ASMidi;
  // Eight bars of a two-hand piece, in 16ths: a right-hand tune with some
  // thirds, left-hand bass notes and block chords, syncopations and ties.
  let seed = 11; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const truth = [];
  let at = 0;
  while (at < 128) {
    const len = [2, 4, 3, 1, 6, 4, 8, 2][Math.floor(rnd() * 8)];
    const top = 67 + Math.floor(rnd() * 12);
    truth.push({ midi: top, at, len });
    if (rnd() < 0.3) truth.push({ midi: top - 4, at, len });
    at += len;
  }
  for (let b = 0; b < 8; b++) {
    truth.push({ midi: 36 + (b * 5) % 12, at: b * 16, len: 8 });
    [48, 52, 55].forEach((m) => truth.push({ midi: m + (b * 5) % 12 - 12, at: b * 16 + 8, len: 8 }));
  }
  const bpm = 90, beat = 60 / bpm;
  const bytes = W.build(truth.map((n) => ({ midi: n.midi, start: n.at / 4 * beat, duration: n.len / 4 * beat, velocity: 80 })), { bpm });
  PIANO = { bytes: Buffer.from(bytes), truth };
  const parsed = MR.parse(bytes);
  const ns = [].concat(...parsed.parts.map((p) => p.notes));
  ok(ns.every((n) => n.b0 != null), 'midi-read gives every note a position in beats');
  const up = S.quantizeChords(ns.filter((n) => n.midi >= 60)), low = S.quantizeChords(ns.filter((n) => n.midi < 60));
  const { r, staves } = readStaves(S.toMusicXML(up, { lower: low, sig: [4, 4], bpm }));
  ok(Object.keys(staves).length === 2 && [1, 2].every((k) => staves[k].sums.every((v) => v === r.bar)), 'piano: two staves, every measure of each sums to one bar');
  const back = [].concat(staves[1].merged, staves[2].merged);
  const right = truth.filter((t) => back.some((b) => b.midi === t.midi && b.at === t.at && b.len === t.len)).length;
  ok(right === truth.length, 'piano: ' + right + '/' + truth.length + ' notes back with their pitch, place and length');
  const one = readStaves(S.toMusicXML(S.quantizeChords(ns), { sig: [4, 4] }));
  ok(one.staves[1].sums.every((v) => v === one.r.bar) && one.staves[1].notes.length > 0, 'one staff of chords: every measure sums to one bar');
  const tune = S.topLine(S.quantizeChords(ns.filter((n) => n.midi >= 60)));
  ok(tune.every((n) => truth.some((t) => t.midi === n.midi && t.at === n.at && t.midi >= 60 && !truth.some((u) => u.at === t.at && u.midi > t.midi))), 'the tune only: the top note of each chord');
}
{
  // Hand-made: a tempo change and a held pedal. Positions in beats ignore
  // the tempo, and the written length is the key's, not the pedal's.
  const MR = require('../js/midi-read.js');
  const trk = [
    0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,             // 120 BPM
    0x00, 0xff, 0x59, 0x02, 0xfd, 0x01,                   // key: 3 flats, minor
    0x00, 0xb0, 0x40, 0x7f,                               // pedal down
    0x00, 0x90, 0x3c, 0x50,                               // C4 on at beat 0
    0x83, 0x60, 0x80, 0x3c, 0x00,                         // off at beat 1 (480 ticks), pedal held
    0x00, 0xff, 0x51, 0x03, 0x0f, 0x42, 0x40,             // 60 BPM from beat 1
    0x83, 0x60, 0xb0, 0x40, 0x00,                         // pedal up at beat 2
    0x00, 0x90, 0x3e, 0x50, 0x83, 0x60, 0x80, 0x3e, 0x00, // D4 beat 2 to 3
    0x00, 0xff, 0x2f, 0x00
  ];
  const hdr = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0];
  const bytes = new Uint8Array([...hdr, 0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, trk.length, ...trk]);
  const m = MR.parse(bytes), n = m.parts[0].notes;
  ok(n[0].b0 === 0 && n[0].b1 === 1 && n[0].duration > 1.4 && n[1].b0 === 2 && n[1].b1 === 3, 'a pedalled note is written to its key release (beat 1), and beats ignore the tempo change');
  ok(m.key && m.key.fifths === -3 && m.key.mode === 'minor' && m.tempoChanges === 1, 'the key signature (C minor) and the tempo change are read');
}
{
  const pcs = new Float64Array(12);
  [[0, 4], [2, 2], [4, 3], [5, 1], [7, 4], [9, 1], [11, 1]].forEach(([pc, w]) => { pcs[pc] = w; });
  const k = K.fromChroma(pcs);
  ok(k.pc === 0 && k.mode === 'major', 'a key from note durations: C major (' + k.name + ')');
}

// ---- the page's chain on audio
console.log('from audio');
const SR = 44100;
function synth(notes, bpm, lead) {
  const beat = 60 / bpm, end = notes.reduce((a, n) => Math.max(a, n.at + n.len), 0) / 4 * beat + lead + 1;
  const x = new Float32Array(Math.round(end * SR));
  notes.forEach((n) => {
    const f = 440 * Math.pow(2, (n.midi - 69) / 12), s0 = Math.round((lead + n.at / 4 * beat) * SR), L = Math.round(n.len / 4 * beat * SR * 0.92);
    for (let i = 0; i < L && s0 + i < x.length; i++) {
      const env = Math.min(1, i / (0.005 * SR)) * Math.exp(-i / SR * 1.2) * Math.min(1, (L - i) / (0.01 * SR));
      const t = i / SR;
      x[s0 + i] += env * (0.5 * Math.sin(2 * Math.PI * f * t) + 0.2 * Math.sin(4 * Math.PI * f * t) + 0.1 * Math.sin(6 * Math.PI * f * t));
    }
  });
  return x;
}
function buffer(x) { return { sampleRate: SR, numberOfChannels: 1, length: x.length, duration: x.length / SR, getChannelData: () => x }; }
// The scale degrees of a key (major or natural minor), so the melodies are in it.
function scale(pc, mode) { return (mode === 'major' ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10]).map((s) => (pc + s) % 12); }
function melody(pc, mode, seed, n) {
  let s = seed; const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const deg = scale(pc, mode), out = []; let at = 0;
  for (let i = 0; i < n; i++) {
    const len = [4, 4, 2, 2, 8, 4, 6, 2][Math.floor(rnd() * 8)];
    // Tonic and fifth often, like a tune: the key finder needs a tonal centre.
    const d = i % 4 === 0 ? 0 : i % 4 === 2 ? 4 : Math.floor(rnd() * 7);
    out.push({ midi: 60 + ((deg[d] - 60 % 12 + 12) % 12) + (deg[d] < pc ? 12 : 0), at, len });
    at += len;
  }
  return out;
}
let pitchRight = 0, durRight = 0, total = 0, keyRight = 0, tempoRight = 0;
const SETS = [[0, 'major', 96], [7, 'major', 120], [9, 'minor', 84], [2, 'major', 132], [5, 'major', 108], [4, 'minor', 90]];
SETS.forEach(([pc, mode, bpm], k) => {
  const truth = melody(pc, mode, 11 + k, 32);
  const x = synth(truth, bpm, 0.37);
  const frames = P.track(x, SR, { minHz: 65, maxHz: 1600 });
  const notes = S.rearticulate(P.segment(frames, { minClarity: 0.55, minNoteSec: 0.06 }), frames);
  const tm = S.tempo(notes);
  const b = tm ? tm.bpm : 120, first = tm ? tm.firstBeat : 0;
  const q = S.quantize(notes, { bpm: b, firstBeat: first });
  const key = K.analyse([x], SR);
  const fifths = key ? S.fifthsOf(key.pc, key.mode) : 0;
  const r = read(S.toMusicXML(q, { bpm: b, fifths }));
  const back = notesOf(r);
  // Align by onset: the quantized grid starts at the detected first beat,
  // which can be a beat earlier than the first note.
  const shift = back.length ? back[0].at - truth[0].at : 0;
  let pr = 0, dr = 0;
  truth.forEach((n) => {
    const m = back.find((o) => o.at - shift === n.at);
    if (m && m.midi === n.midi) pr++;
    if (m && Math.abs(m.len - n.len) <= 1) dr++;
  });
  if (process.env.SHEET_DEBUG) {
    console.log('truth ' + truth.map((n) => n.midi + '@' + n.at + '/' + n.len).join(' '));
    console.log('found ' + back.map((n) => n.midi + '@' + (n.at - shift) + '/' + n.len).join(' '));
  }
  pitchRight += pr; durRight += dr; total += truth.length;
  if (Math.abs(b - bpm) <= 2) tempoRight++;
  if (fifths === S.fifthsOf(pc, mode)) keyRight++;
  console.log('       ' + ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'][pc] + ' ' + mode + ' at ' + bpm + ': tempo ' + b + ', key ' + (key ? key.name : '?') + ', pitches ' + pr + '/' + truth.length + ', lengths ' + dr + '/' + truth.length);
});
ok(pitchRight / total >= 0.95, 'pitches right: ' + (100 * pitchRight / total).toFixed(1) + '%');
ok(durRight / total >= 0.9, 'lengths right (within a 16th): ' + (100 * durRight / total).toFixed(1) + '%');
ok(tempoRight === SETS.length, 'tempo within 2 BPM: ' + tempoRight + '/' + SETS.length);
ok(keyRight >= SETS.length - 1, 'key signature right: ' + keyRight + '/' + SETS.length);

// ---- the page in headless Chrome: a WAV of a melody in, a drawn score and
// a MusicXML download out (OpenSheetMusicDisplay from /vendor/osmd).
async function browser() {
  const { withPage, findChrome } = require('./chrome-harness');
  if (!findChrome()) { console.log('  skip: no Chrome'); return; }
  console.log('page');
  const truth = melody(7, 'major', 5, 24);
  const x = synth(truth, 112, 0.4);
  // 16-bit WAV by hand.
  const n = x.length, wav = Buffer.alloc(44 + n * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(SR, 24); wav.writeUInt32LE(SR * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) wav.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(x[i] * 0.8 * 32767))), 44 + i * 2);
  await withPage({ routes: { '/__tune.wav': () => wav } }, async (page) => {
    await page.goto('/audio-to-sheet-music', 1500);
    const r = await page.eval(`(async () => {
      const b = await (await fetch('/__tune.wav')).blob();
      window.__sheet.use(new File([b], 'tune.wav', { type: 'audio/wav' }));
      await window.__sheet.analyse();
      let out = null; const orig = CV.downloadBlob; CV.downloadBlob = (bl, nm) => { out = { bl, nm }; };
      document.querySelector('#xmlBtn').click();
      CV.downloadBlob = orig;
      return { svgs: window.__sheet.rendered(), heads: document.querySelectorAll('#score .vf-stavenote, #score .vf-notehead').length,
        status: document.querySelector('#status').textContent, name: out && out.nm, xml: out ? await out.bl.text() : '' };
    })()`, 300000);
    ok(r.svgs > 0 && r.heads > 0, 'the score is drawn (' + r.svgs + ' SVG, ' + r.heads + ' note elements) — ' + r.status.slice(0, 80));
    const back = r.xml ? notesOf(read(r.xml)) : [];
    const shift = back.length ? back[0].at - truth[0].at : 0;
    const right = truth.filter((t) => back.some((b) => b.at - shift === t.at && b.midi === t.midi)).length;
    ok(/\.musicxml$/.test(r.name || '') && right >= truth.length * 0.95, 'the MusicXML download has ' + right + '/' + truth.length + ' notes right (' + r.name + ')');
    if (page.logs.length) console.log('    console: ' + page.logs.slice(0, 4).join(' | '));
  });
  // /midi-to-sheet-music: a one-track, two-hand file opens as a piano grand
  // staff, and its MusicXML download has every note back.
  await withPage({ routes: { '/__piano.mid': () => PIANO.bytes } }, async (page) => {
    await page.goto('/midi-to-sheet-music', 1500);
    const r = await page.eval(`(async () => {
      const b = await (await fetch('/__piano.mid')).blob();
      window.__sheet.use(new File([b], 'piano.mid', { type: 'audio/midi' }));
      await window.__sheet.analyse();
      let out = null; const orig = CV.downloadBlob; CV.downloadBlob = (bl, nm) => { out = { bl, nm }; };
      document.querySelector('#xmlBtn').click();
      CV.downloadBlob = orig;
      return { layout: document.querySelector('#layout').value, rangeHidden: document.querySelector('#range').closest('label').hidden,
        heads: document.querySelectorAll('#score .vf-stavenote').length, status: document.querySelector('#status').textContent, xml: out ? await out.bl.text() : '' };
    })()`, 120000);
    ok(r.layout === 'piano' && r.rangeHidden && r.heads > 0, '/midi-to-sheet-music: a one-track piano file is drawn on a grand staff (' + r.heads + ' notes drawn) — ' + r.status.slice(0, 70));
    const { staves } = r.xml ? readStaves(r.xml) : { staves: {} };
    const back = [].concat((staves[1] || {}).merged || [], (staves[2] || {}).merged || []);
    const right = PIANO.truth.filter((t) => back.some((b) => b.midi === t.midi && b.at === t.at && b.len === t.len)).length;
    ok(right === PIANO.truth.length, '/midi-to-sheet-music: the MusicXML download has ' + right + '/' + PIANO.truth.length + ' notes right');
    if (page.logs.length) console.log('    console: ' + page.logs.slice(0, 4).join(' | '));
  });
}

browser().then(() => {
  console.log(failed ? '\n' + failed + ' check(s) failed' : '\ncheck-sheet: all good');
  process.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
