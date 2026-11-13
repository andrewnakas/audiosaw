#!/usr/bin/env node
/*
 * check-dx7.js: the FM synth behind /dx7-synth (js/dx7-core.js and
 * vendor/msfa/<date>/dx7.wasm), measured in Node.
 *
 * Pitch is read from zero crossings of a one-carrier sine, level from peaks
 * and RMS, and "which notes are sounding" from single-bin (Goertzel) energy,
 * so nothing here trusts the engine's own account of what it played.
 *
 *   node tools/check-dx7.js          exit 1 on any failure
 *   DX7_SPEED=1 node tools/check-dx7.js   also time 60 s of 16 voices
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const D = require(path.join(ROOT, 'js', 'dx7-core.js'));

// The vendored build lives in a folder named for the pinned commit's date.
const base = path.join(ROOT, 'vendor', 'msfa');
const ver = fs.readdirSync(base).filter((d) => fs.existsSync(path.join(base, d, 'dx7.wasm'))).sort().pop();
const WASM = fs.readFileSync(path.join(base, ver, 'dx7.wasm'));

let failed = 0;
function ok(cond, msg) {
  console.log((cond ? 'ok   ' : 'FAIL ') + msg);
  if (!cond) failed++;
}

const SINE = D.PATCHES[0];

function hzOf(a, rate, from, to) {
  const z = [];
  for (let i = from + 1; i < to; i++) {
    if (a[i - 1] < 0 && a[i] >= 0) z.push(i - 1 - a[i - 1] / (a[i] - a[i - 1]));
  }
  return (z.length - 1) / ((z[z.length - 1] - z[0]) / rate);
}
function cents(hz, ref) { return 1200 * Math.log2(hz / ref); }
function peak(a, from, to) {
  let m = 0;
  for (let i = from || 0; i < (to === undefined ? a.length : to); i++) m = Math.max(m, Math.abs(a[i]));
  return m;
}
function rms(a, from, to) {
  let q = 0;
  for (let i = from; i < to; i++) q += a[i] * a[i];
  return Math.sqrt(q / (to - from));
}
function db(x) { return 20 * Math.log10(x + 1e-30); }
// Amplitude of one frequency in a Hann-windowed stretch.
function tone(a, rate, from, n, hz) {
  const k = 2 * Math.cos(2 * Math.PI * hz / rate);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    const s0 = a[from + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / n)) + k * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - k * s1 * s2)) / (n / 4);
}
function same(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function finite(a) {
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false;
  return true;
}
function midiHz(n) { return 440 * Math.pow(2, (n - 69) / 12); }

/* ---- the module itself ---- */

const mod = new WebAssembly.Module(WASM);
const imports = WebAssembly.Module.imports(mod);
ok(imports.length === 0, 'the wasm has no imports (' + imports.length + '), ' + WASM.length + ' bytes, build ' + ver);

/* ---- pitch ---- */

for (const rate of [44100, 48000, 96000]) {
  const a = D.renderNotes(WASM, SINE.data, [[69, 0, 2, 0.8]], { sampleRate: rate, tail: 0 });
  const c = cents(hzOf(a, rate, rate / 2, rate * 2), 440);
  ok(Math.abs(c) < 2, 'MIDI 69 at ' + rate + ' Hz is 440 Hz within 2 cents (' + c.toFixed(3) + ')');
}
{
  const a = D.renderNotes(WASM, SINE.data, [[57, 0, 2, 0.8]], { sampleRate: 44100, tail: 0 });
  const c = cents(hzOf(a, 44100, 22050, 88200), 220);
  ok(Math.abs(c) < 2, 'MIDI 57 is 220 Hz within 2 cents (' + c.toFixed(3) + ')');
  let worst = 0;
  for (const n of [24, 36, 48, 60, 72, 84, 96, 108]) {
    const b = D.renderNotes(WASM, SINE.data, [[n, 0, 2, 0.8]], { sampleRate: 48000, tail: 0 });
    worst = Math.max(worst, Math.abs(cents(hzOf(b, 48000, 24000, 96000), midiHz(n))));
  }
  ok(worst < 2, 'C1 to C8 are in tune within 2 cents (worst ' + worst.toFixed(3) + ')');
}

/* ---- release ---- */

{
  const rate = 44100;
  const a = D.renderNotes(WASM, SINE.data, [[69, 0, 1, 0.8]], { sampleRate: rate, tail: 2 });
  const held = peak(a, rate / 2, rate);
  let last = 0;
  for (let i = a.length - 1; i >= rate; i--) if (Math.abs(a[i]) >= 1e-4) { last = i; break; }
  const t = (last - rate) / rate;
  // PURE SINE's release rate is 62; it measures about a quarter of a second.
  ok(held > 0.03 && t > 0.02 && t < 0.5,
    'note-off falls below -80 dBFS within 0.5 s of release (' + t.toFixed(3) + ' s, from ' + db(held).toFixed(1) + ' dBFS)');
  ok(peak(a, rate * 2, a.length) === 0, 'and then to digital silence (peak ' + peak(a, rate * 2, a.length) + ')');
}

/* ---- determinism and block size ---- */

const SONG = [[48, 0, 0.9, 0.9], [60, 0.1, 0.5, 0.6], [64, 0.1, 0.5, 0.7], [67, 0.25, 0.6, 1], [60, 0.6, 0.3, 0.4], [72, 0.61, 0.2, 0.8]];
{
  const p = D.PATCHES[1];
  const a = D.renderNotes(WASM, p.data, SONG, { sampleRate: 44100, tail: 1 });
  const b = D.renderNotes(WASM, p.data, SONG, { sampleRate: 44100, tail: 1 });
  ok(same(a, b) && peak(a) > 0.01, 'two renders are identical (' + a.length + ' samples)');

  const total = 44100;
  const ref = D.create(WASM, 44100);
  const play = (eng, block) => {
    eng.loadVoice(D.PATCHES[4].data);   // WARM BRASS: feedback and LFO, the most state
    eng.noteOn(60, 0.8); eng.noteOn(67, 0.5);
    const out = new Float32Array(total);
    for (let pos = 0; pos < total; pos += block) eng.render(out.subarray(pos, Math.min(total, pos + block)));
    return out;
  };
  const want = play(ref, total);
  let all = peak(want) > 0.01;
  for (const block of [1, 64, 128, 1000]) all = all && same(want, play(D.create(WASM, 44100), block));
  ok(all, 'render() in blocks of 1, 64, 128 and 1000 gives the same samples as one call');

  // panic() must leave nothing behind: the same notes after it match a new engine.
  const eng = D.create(WASM, 44100);
  play(eng, 512);
  eng.panic();
  // The LFO is free-running and not part of a voice, so compare a patch without one.
  const dry = (e) => { e.loadVoice(D.PATCHES[1].data); e.panic(); e.noteOn(60, 0.8); return e.render(new Float32Array(8192)); };
  ok(same(dry(eng), dry(D.create(WASM, 44100))), 'after panic() a note matches a new engine sample for sample');
}

/* ---- polyphony ---- */

{
  const rate = 44100;
  const eng = D.create(WASM, rate);
  eng.loadVoice(SINE.data);
  // 16 notes a whole tone apart, then a 17th well above them.
  const notes = [];
  for (let i = 0; i < 16; i++) notes.push(36 + i * 2);
  const buf = new Float32Array(rate);
  for (const n of notes) { eng.noteOn(n, 1); eng.render(buf.subarray(0, 441)); }
  eng.render(buf);
  const pk16 = peak(buf);
  // One carrier at full velocity is 0.066; 16 in phase could reach 1.06, and
  // notes at different pitches never line up that far.
  ok(eng.activeVoices() === 16 && finite(buf) && pk16 > 0.15 && pk16 <= 1,
    '16 notes at full velocity sound together and stay within +-1.0 (peak ' + pk16.toFixed(3) + ', ' + eng.activeVoices() + ' voices)');
  const first16 = tone(buf, rate, 0, 32768, midiHz(notes[0]));

  eng.noteOn(96, 1);
  eng.render(buf);
  const firstAfter = tone(buf, rate, 8192, 32768, midiHz(notes[0]));
  const second = tone(buf, rate, 8192, 32768, midiHz(notes[1]));
  const newest = tone(buf, rate, 8192, 32768, midiHz(96));
  ok(eng.activeVoices() === 16 && finite(buf) && newest > 0.02 && firstAfter < first16 * 0.01 && second > first16 * 0.5,
    'a 17th note takes the oldest voice: 16 still sounding, the new note at ' + db(newest).toFixed(1) +
    ' dBFS, the oldest gone (' + db(firstAfter / first16).toFixed(0) + ' dB), the second oldest kept');

  // Garbage in must not crash or write outside the tables.
  const junk = new Uint8Array(155).fill(255);
  eng.loadVoice(junk);
  for (let n = 0; n < 128; n += 9) eng.noteOn(n, 1);
  eng.noteOn(300, 1); eng.noteOff(-5);
  eng.render(buf);
  ok(finite(buf) && peak(buf) <= 8, 'a voice of all 255s is clamped: renders finite audio (peak ' + peak(buf).toFixed(3) + ')');
}

/* ---- velocity, bend, sustain, mod wheel ---- */

{
  const rate = 44100;
  const lvl = (v) => rms(D.renderNotes(WASM, SINE.data, [[69, 0, 1, v]], { sampleRate: rate, tail: 0 }), rate / 2, rate);
  const soft = lvl(0.2), mid = lvl(0.6), loud = lvl(1);
  ok(soft < mid && mid < loud && loud / soft > 1.5,
    'velocity raises the level: 0.2 -> ' + db(soft).toFixed(1) + ', 0.6 -> ' + db(mid).toFixed(1) + ', 1.0 -> ' + db(loud).toFixed(1) + ' dBFS');

  const bent = (v, range) => {
    const eng = D.create(WASM, rate);
    eng.loadVoice(SINE.data);
    if (range) eng.bendRange(range);
    eng.bend(v);
    eng.noteOn(69, 0.8);
    return cents(hzOf(eng.render(new Float32Array(rate * 2)), rate, rate / 2, rate * 2), 440);
  };
  const up = bent(1), down = bent(-1), up12 = bent(1, 12);
  ok(Math.abs(up - 200) < 2 && Math.abs(down + 200) < 2,
    'pitch bend +1 / -1 moves the pitch by the 2-semitone range (' + up.toFixed(2) + ' / ' + down.toFixed(2) + ' cents)');
  ok(Math.abs(up12 - 1200) < 2, 'bendRange(12) makes +1 an octave (' + up12.toFixed(2) + ' cents)');

  const eng = D.create(WASM, rate);
  eng.loadVoice(SINE.data);
  const buf = new Float32Array(rate);
  eng.sustain(true);
  eng.noteOn(69, 0.8);
  eng.render(buf.subarray(0, 4410));
  eng.noteOff(69);
  eng.render(buf);
  const heldLevel = peak(buf, rate / 2, rate);
  eng.sustain(false);
  eng.render(buf);
  ok(heldLevel > 0.03 && peak(buf, rate / 2, rate) < 1e-4,
    'the pedal holds a released note (' + db(heldLevel).toFixed(1) + ' dBFS) and lets go when lifted');

  // Vibrato from the wheel: the spread of cycle lengths, in cents.
  const wobble = (m) => {
    const e = D.create(WASM, rate);
    e.loadVoice(SINE.data);
    e.mod(m);
    e.noteOn(69, 0.8);
    const a = e.render(new Float32Array(rate * 2));
    const z = [];
    for (let i = rate / 2 + 1; i < a.length; i++) if (a[i - 1] < 0 && a[i] >= 0) z.push(i - 1 - a[i - 1] / (a[i] - a[i - 1]));
    let lo = 1e9, hi = 0;
    for (let i = 8; i < z.length; i += 8) { const p = (z[i] - z[i - 8]) / 8; lo = Math.min(lo, p); hi = Math.max(hi, p); }
    return 1200 * Math.log2(hi / lo);
  };
  const w0 = wobble(0), w1 = wobble(1);
  ok(w0 < 1 && w1 > 50 && w1 < 150, 'the mod wheel brings in vibrato: ' + w0.toFixed(2) + ' cents of swing at 0, ' + w1.toFixed(1) + ' at 1');
}

/* ---- the built-in voices ---- */

{
  const rate = 44100;
  ok(D.PATCHES.length >= 8 && D.PATCHES.length <= 12 && new Set(D.PATCHES.map((p) => p.name)).size === D.PATCHES.length,
    D.PATCHES.length + ' built-in voices, each with its own name');
  for (const p of D.PATCHES) {
    const a = D.renderNotes(WASM, p.data, [[60, 0, 1, 0.8]], { sampleRate: rate, tail: 2 });
    const r = rms(a, 0, rate), pk = peak(a);
    const tailEnd = peak(a, a.length - 2205, a.length);
    ok(p.data.length === 155 && finite(a) && r > 0.005 && pk < 0.5 && tailEnd < 1e-4,
      'voice "' + p.name + '": RMS ' + db(r).toFixed(1) + ' dBFS, peak ' + db(pk).toFixed(1) + ', silent 2 s after release (' + db(tailEnd).toFixed(0) + ')');
  }
}

/* ---- sysex ---- */

{
  const bank = D.packSyx(D.PATCHES);
  ok(bank.length === 4104 && bank[0] === 0xf0 && bank[4103] === 0xf7, 'packSyx writes a 4,104-byte bank');
  const back = D.parseSyx(bank);
  let match = back.length === 32;
  for (let i = 0; i < D.PATCHES.length && match; i++) {
    match = back[i].name === D.PATCHES[i].name && same(back[i].data, D.PATCHES[i].data);
  }
  ok(match, 'parseSyx reads it back: 32 voices, the first ' + D.PATCHES.length + ' byte for byte with their names');

  const one = D.packSyx([D.PATCHES[3]]);
  const oneBack = D.parseSyx(one);
  ok(one.length === 163 && oneBack.length === 1 && same(oneBack[0].data, D.PATCHES[3].data) && oneBack[0].name === D.PATCHES[3].name,
    'a 163-byte single-voice dump round-trips ("' + oneBack[0].name + '")');

  // Two banks, a stray parameter-change message and a single voice in one file.
  const stray = Uint8Array.from([0xf0, 0x43, 0x10, 0x01, 0x10, 0x05, 0xf7]);
  const cat = new Uint8Array(bank.length * 2 + stray.length + one.length);
  cat.set(bank, 0); cat.set(stray, bank.length); cat.set(bank, bank.length + stray.length); cat.set(one, bank.length * 2 + stray.length);
  ok(D.parseSyx(cat).length === 65, 'a file with two banks, another message and a single voice gives 65 voices');

  const throwsWith = (bytes, re) => {
    try { D.parseSyx(bytes); } catch (e) { return e instanceof Error && re.test(e.message) ? e.message : false; }
    return false;
  };
  const bad = bank.slice(); bad[4102] ^= 1;
  ok(throwsWith(bad, /checksum/i), 'a bank with a wrong checksum is refused: "' + throwsWith(bad, /checksum/i) + '"');
  const flipped = bank.slice(); flipped[1000] ^= 0x10;
  ok(throwsWith(flipped, /checksum/i), 'so is one with a changed data byte');
  ok(D.parseSyx(bad, { lax: true }).length === 32, 'and { lax: true } still reads it');
  ok(throwsWith(bank.subarray(0, 3000), /cut short/i), 'a truncated bank is refused: "' + throwsWith(bank.subarray(0, 3000), /cut short/i) + '"');
  ok(throwsWith(one.subarray(0, 100), /cut short/i), 'a truncated single voice is refused');
  ok(throwsWith(new Uint8Array(4104), /not a DX7/i) && throwsWith(Uint8Array.from([0xf0, 0x41, 0x10, 0x00, 0x00, 0x00, 0xf7]), /not a DX7/i),
    'zeros and another maker\'s sysex are refused as not a DX7 file');

  // The module's own unpacker (the C side) must agree with the JS one.
  const x = new WebAssembly.Instance(mod, {}).exports;
  x._initialize();
  x.dx7_init(44100);
  const inPtr = x.malloc(4104), outPtr = x.malloc(32 * 155);
  const heap = new Uint8Array(x.memory.buffer);
  heap.set(bank, inPtr);
  const n = x.dx7_unpack_syx(inPtr, 4104, outPtr);
  let agree = n === 32;
  for (let i = 0; i < 32 && agree; i++) agree = same(heap.subarray(outPtr + i * 155, outPtr + (i + 1) * 155), back[i].data);
  heap.set(one, inPtr);
  const n1 = x.dx7_unpack_syx(inPtr, 163, outPtr);
  agree = agree && n1 === 1 && same(heap.subarray(outPtr, outPtr + 155), D.PATCHES[3].data);
  heap.set(bad, inPtr);
  ok(agree && x.dx7_unpack_syx(inPtr, 4104, outPtr) === -1 && x.dx7_unpack_syx(inPtr, 3000, outPtr) === 0,
    'the wasm unpacker gives the same 32 voices and single voice, -1 for a bad checksum, 0 for a short file');
}

/* ---- renderNotes ---- */

{
  const rate = 48000;
  const a = D.renderNotes(WASM, SINE.data, [[69, 0.5, 0.5, 0.8], [69, 1.0, 0.5, 0.8], [81, 2, 0.25, 0.8]], { sampleRate: rate, tail: 1 });
  ok(a.length === Math.round(3.25 * rate), 'renderNotes is the last note-off plus the tail long (' + a.length + ' samples)');
  ok(peak(a, 0, rate / 2) === 0 && peak(a, rate / 2, rate / 2 + 64) > 0, 'a note starting at 0.5 s starts on its sample');
  // The same pitch struck again on the frame it is released: both must sound.
  const again = rms(a, rate * 1.2, rate * 1.45), firstOne = rms(a, rate * 0.7, rate * 0.95);
  ok(Math.abs(db(again / firstOne)) < 0.5, 'a note repeated at the moment it ends sounds again (' + db(again / firstOne).toFixed(2) + ' dB against the first)');
  const c = cents(hzOf(a, rate, Math.round(rate * 2.05), Math.round(rate * 2.24)), 880);
  ok(Math.abs(c) < 2, 'the last note is 880 Hz (' + c.toFixed(2) + ' cents)');
}

/* ---- the worklet, in a stand-in AudioWorkletGlobalScope ---- */

{
  const rate = 48000;
  const registered = {};
  const posted = [];
  class FakeProcessor {
    constructor() { this.port = { postMessage: (m) => posted.push(m), onmessage: null }; }
  }
  const src = D.workletSource();
  // Only what the real scope has: no fetch, no TextDecoder, no timers.
  const run = new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', 'WebAssembly',
    'fetch', 'TextDecoder', 'setTimeout', 'require', 'process', 'self', 'window', src);
  run(FakeProcessor, (name, cls) => { registered[name] = cls; }, rate, WebAssembly);
  const Cls = registered['as-dx7'];
  ok(typeof Cls === 'function' && Cls.name === 'AsDx7Proc' && !/\b(import|export)\s/.test(src.replace(/exports/g, '')),
    'the worklet source registers "as-dx7" (class ' + (Cls && Cls.name) + ', ' + src.length + ' characters)');

  // Bytes as they arrive after a structured clone: an ArrayBuffer.
  const bytes = WASM.buffer.slice(WASM.byteOffset, WASM.byteOffset + WASM.length);
  const proc = new Cls({ processorOptions: { wasm: bytes, voice: SINE.data } });
  ok(posted.length === 1 && posted[0].t === 'ready', 'it instantiates from processorOptions.wasm and reports ready');
  proc.port.onmessage({ data: { t: 'on', n: 69, v: 0.8 } });
  const L = new Float32Array(rate), R = new Float32Array(rate);
  let alive = true;
  for (let pos = 0; pos + 128 <= rate; pos += 128) {
    alive = proc.process([], [[L.subarray(pos, pos + 128), R.subarray(pos, pos + 128)]]) && alive;
  }
  const upto = Math.floor(rate / 128) * 128;
  const c = cents(hzOf(L, rate, rate / 4, upto), 440);
  ok(alive && Math.abs(c) < 2 && same(L, R) && peak(L) > 0.03,
    'and plays 440 Hz on both channels (' + c.toFixed(3) + ' cents, peak ' + db(peak(L)).toFixed(1) + ' dBFS)');

  for (const m of [{ t: 'bend', v: 1 }, { t: 'mod', v: 0.5 }, { t: 'sus', v: true }, { t: 'voice', data: D.PATCHES[1].data }, { t: 'off', n: 69 }, { t: 'sus', v: false }, { t: 'panic' }]) {
    proc.port.onmessage({ data: m });
  }
  const q = [new Float32Array(128)];
  proc.process([], [q]);
  ok(peak(q[0]) === 0, 'every message type is taken, and panic leaves silence');

  const before = posted.length;
  const broken = new Cls({ processorOptions: { wasm: new Uint8Array([1, 2, 3]).buffer } });
  ok(posted.length === before + 1 && posted[before].t === 'error' && broken.process([], [[new Float32Array(128)]]) === true,
    'bad wasm bytes are reported as an error message and the processor stays silent, not thrown');
}

/* ---- cost ---- */

{
  // Not asserted tightly: a loaded machine can be several times slower. The
  // bound only catches a build that lost its optimisation.
  const rate = 48000;
  const eng = D.create(WASM, rate);
  eng.loadVoice(D.PATCHES[4].data);
  for (let i = 0; i < 16; i++) eng.noteOn(40 + i * 3, 0.9);
  const seconds = process.env.DX7_SPEED ? 60 : 10;
  const buf = new Float32Array(128);
  const t0 = process.hrtime.bigint();
  for (let pos = 0; pos < rate * seconds; pos += 128) eng.render(buf);
  const took = Number(process.hrtime.bigint() - t0) / 1e9;
  ok(eng.activeVoices() === 16 && took < seconds / 4,
    seconds + ' s of 16 six-operator voices at 48 kHz in 128-frame blocks took ' + took.toFixed(2) + ' s (' + (seconds / took).toFixed(0) + 'x realtime)');
}

console.log(failed ? '\n' + failed + ' check(s) failed' : '\nall dx7 checks passed');
process.exit(failed ? 1 : 0);
