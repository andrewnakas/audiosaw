#!/usr/bin/env node
/*
 * Checks js/mt32-core.js and vendor/mt32emu/<version>/mt32emu.wasm
 * (Munt's libmt32emu, an MT-32 / CM-32L).
 *
 * Always, with no ROMs at all:
 *   - the wasm compiles, is under Pages' 25 MiB, and imports only the two
 *     do-nothing functions the core supplies (anything else would mean the
 *     build picked up a filesystem or a clock);
 *   - identify() is null for random bytes, for a wrong-size file, and for
 *     random bytes of each real ROM size (the SHA-1 path);
 *   - the list of known ROMs is the one the page prints;
 *   - render() with no ROMs, half the pair, or junk for a ROM rejects with a
 *     plain message and never traps or hangs.
 *
 * The synth makes no sound without Roland's ROMs, which are not in the repo
 * and are never downloaded. With MT32_ROMS=/dir (a control ROM and a PCM ROM,
 * any file names; halves are paired up):
 *   - both files are identified;
 *   - middle C on part 1 (MIDI channel 2) with Acou Piano 1 is silent before
 *     the note and within 30 cents of 261.6 Hz after it (the machine powers
 *     up tuned to A = 442.4, +9 cents);
 *   - two renders are bit-identical;
 *   - "all notes off" ends a held organ note: 2 s later it is 40 dB or more
 *     under the same note left held;
 *   - swapped ROMs and a missing PCM ROM give their own messages.
 * Without MT32_ROMS those lines print "skip" and the check passes.
 */
const fs = require('fs');
const path = require('path');
const M = require('../js/mt32-core.js');

const VERSION = '2.8.6';
const WASM = path.join(__dirname, '..', 'vendor', 'mt32emu', VERSION, 'mt32emu.wasm');

let failed = 0;
const ok = (c, m) => { console.log((c ? '  ok  ' : '  FAIL ') + m); if (!c) failed++; };
const skip = (m) => console.log('  skip ' + m);
function rnd(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function noise(n, seed) { const r = rnd(seed), b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = r() * 256; return b; }

// A promise that must settle: a hang in the module would otherwise look like
// a check that never prints.
function within(p, ms, what) {
  let timer;
  const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timed out: ' + what)), ms); });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}
async function rejects(p, what) {
  try { await within(p, 20000, what); return null; } catch (e) { return e; }
}
const plain = (e) => !!e && e instanceof Error && !(e instanceof WebAssembly.RuntimeError) &&
  !/timed out|unreachable|out of bounds|is not a function|undefined/i.test(e.message);

function rms(x, a, b) {
  a = Math.max(0, a | 0); b = Math.min(x.length, b | 0);
  if (b <= a) return 0;
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / (b - a));
}
const db = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity);

// Period by normalised autocorrelation, searched only around the expected
// note so a strong second harmonic cannot win, then refined between lags.
function pitch(x, rate, lo, hi) {
  const n = x.length, minLag = Math.floor(rate / hi), maxLag = Math.ceil(rate / lo);
  const score = (lag) => {
    let c = 0, e0 = 0, e1 = 0;
    for (let i = 0; i + lag < n; i++) { c += x[i] * x[i + lag]; e0 += x[i] * x[i]; e1 += x[i + lag] * x[i + lag]; }
    return c / Math.sqrt(e0 * e1 + 1e-30);
  };
  let best = -2, at = 0;
  for (let lag = minLag; lag <= maxLag; lag++) { const s = score(lag); if (s > best) { best = s; at = lag; } }
  const a = score(at - 1), b = best, c = score(at + 1);
  const d = (a - 2 * b + c) !== 0 ? 0.5 * (a - c) / (a - 2 * b + c) : 0;
  return { hz: rate / (at + d), strength: best };
}

(async () => {
  console.log('module');
  const wasm = new Uint8Array(fs.readFileSync(WASM));
  ok(wasm.length < 25 * 1024 * 1024, 'mt32emu.wasm is ' + wasm.length + ' bytes, under the 25 MiB file limit');
  let mod = null;
  try { mod = new WebAssembly.Module(wasm); } catch (e) { /* reported below */ }
  ok(!!mod, 'the wasm compiles');
  if (!mod) process.exit(1);
  const imports = WebAssembly.Module.imports(mod).map((i) => i.module + '.' + i.name).sort().join(' ');
  ok(imports === 'env.emscripten_notify_memory_growth wasi_snapshot_preview1.fd_write',
    'imports are only the two stubs: ' + imports);

  console.log('identify, no ROMs');
  ok(await within(M.identify(wasm, noise(1000, 1)), 20000, 'identify') === null, 'random bytes: null');
  ok(await within(M.identify(wasm, noise(65537, 2)), 20000, 'identify') === null, 'a file one byte over a ROM size: null');
  ok(await within(M.identify(wasm, new Uint8Array(0)), 20000, 'identify') === null, 'an empty file: null');
  ok(await within(M.identify(wasm, noise(3 * 1048576, 3)), 20000, 'identify') === null, 'a 3 MB file: null');
  let sized = true;
  for (const n of [32768, 65536, 131072, 262144, 524288, 1048576]) {
    if (await within(M.identify(wasm, noise(n, n)), 20000, 'identify') !== null) sized = false;
  }
  ok(sized, 'random bytes of all six real ROM sizes: null');
  ok(await within(M.identify(wasm.buffer, noise(65536, 9)), 20000, 'identify') === null, 'the wasm given as an ArrayBuffer works too');

  const known = await within(M.known(wasm), 20000, 'known');
  const ids = known.map((k) => k.id);
  ok(known.length === 28 && known.filter((k) => k.part === 'whole').length === 14,
    'the library lists ' + known.length + ' ROMs: 14 whole files and 14 halves');
  ok(['ctrl_mt32_1_07', 'ctrl_mt32_2_07', 'ctrl_cm32l_1_02', 'ctrl_cm32ln_1_00', 'pcm_mt32', 'pcm_cm32l'].every((i) => ids.includes(i)),
    'among them MT-32 1.07 and 2.07, CM-32L 1.02, CM-32LN 1.00 and both PCM ROMs');
  const k107 = known.find((k) => k.id === 'ctrl_mt32_1_07') || {};
  const kcm = known.find((k) => k.id === 'pcm_cm32l') || {};
  ok(k107.kind === 'control' && k107.machine === 'MT-32' && k107.version === '1.07' && k107.part === 'whole' && /^[0-9a-f]{40}$/.test(k107.sha1),
    'ctrl_mt32_1_07 reads as control / MT-32 / 1.07 / whole, with a SHA-1');
  ok(kcm.kind === 'pcm' && kcm.machine === 'CM-32L' && kcm.version === '', 'pcm_cm32l reads as pcm / CM-32L, no version');

  console.log('render, no ROMs');
  const note = [{ t: 0.5, data: [0x91, 60, 100] }];
  let e = await rejects(M.render(wasm, {}, note), 'render without ROMs');
  ok(plain(e) && e.code === 'missing_rom' && /control ROM is missing/.test(e.message), 'no ROMs: "' + (e && e.message) + '"');
  e = await rejects(M.render(wasm, { control: noise(65536, 5), pcm: noise(524288, 6) }, note), 'render with junk');
  ok(plain(e) && e.code === 'unknown_rom', 'junk of the right sizes: "' + (e && e.message) + '"');
  e = await rejects(M.render(wasm, { control: new Uint8Array(10), pcm: null }, note), 'render with a tiny file');
  ok(plain(e) && e.code === 'unknown_rom', 'a 10-byte "ROM": refused, no trap');
  e = await rejects(M.render(new Uint8Array(0), {}, note), 'render without the wasm');
  ok(plain(e) && e.code === 'no_wasm', 'no wasm bytes: "' + (e && e.message) + '"');
  e = await rejects(M.render(noise(4000, 7), {}, note), 'render with a broken wasm');
  ok(plain(e) && e.code === 'bad_wasm', 'a broken wasm: "' + (e && e.message) + '"');

  console.log('with ROMs');
  const dir = process.env.MT32_ROMS;
  const gated = [
    'identify the control ROM and the PCM ROM',
    'silence before the note',
    'middle C within 30 cents of 261.6 Hz',
    'two renders identical',
    'all notes off ends the sound',
    'swapped and missing ROMs are named',
    'render speed'
  ];
  if (!dir) {
    gated.forEach((g) => skip(g + ' (set MT32_ROMS=/dir with your own control and PCM ROM)'));
  } else {
    const found = { control: [], pcm: [] };
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (!st.isFile() || st.size < 32768 || st.size > 1048576) continue;
      const bytes = new Uint8Array(fs.readFileSync(p));
      const id = await M.identify(wasm, bytes);
      if (id) found[id.kind].push({ name, bytes, id });
    }
    // One whole file if there is one, else the first two halves that fit.
    const pick = (list) => {
      const whole = list.find((f) => f.id.part === 'whole' && !(f.id.kind === 'pcm' && list.some((g) => g.id.id === 'pcm_cm32l_h')));
      if (whole) return whole.bytes;
      return list.length >= 2 ? [list[0].bytes, list[1].bytes] : (list[0] ? list[0].bytes : null);
    };
    ok(found.control.length > 0 && found.pcm.length > 0,
      'identified: ' + found.control.concat(found.pcm).map((f) => f.name + ' = ' + f.id.name + ' [' + f.id.id + ']').join('; '));
    if (!found.control.length || !found.pcm.length) {
      console.log('\nFAILED: ' + (failed) + ' (no usable ROM pair in ' + dir + ')');
      process.exit(1);
    }
    const roms = { control: pick(found.control), pcm: pick(found.pcm) };

    // Program change 0 on channel 2 is Acou Piano 1; part 1 powers up on
    // Slap Bass 1.
    const piano = [
      { t: 0, data: [0xC1, 0] },
      { t: 0.5, data: new Uint8Array([0x91, 60, 100]) },
      { t: 2.0, data: [0x81, 60, 0] }
    ];
    const t0 = Date.now();
    const a = await within(M.render(wasm, roms, piano, { tail: 3 }), 120000, 'render');
    const took = (Date.now() - t0) / 1000;
    const rate = a.sampleRate, L = a.channels[0], R = a.channels[1];
    ok(rate === 32000 && L.length === R.length && L.length > 2 * rate, 'rendered ' + a.duration.toFixed(2) + ' s at ' + rate + ' Hz, stereo, with ' + a.roms.control.name);

    let before = 0;
    for (let i = 0; i < Math.floor(0.5 * rate); i++) before = Math.max(before, Math.abs(L[i]), Math.abs(R[i]));
    ok(before < 1e-4, 'silence before the note: peak ' + before.toExponential(2) + ' in the first 0.5 s');

    const lvl = rms(L, 0.6 * rate, 1.4 * rate);
    ok(lvl > 0.003, 'the note sounds: ' + db(lvl).toFixed(1) + ' dBFS RMS over 0.6-1.4 s');
    const mono = new Float32Array(Math.floor(0.4 * rate));
    for (let i = 0; i < mono.length; i++) mono[i] = L[Math.floor(0.7 * rate) + i] + R[Math.floor(0.7 * rate) + i];
    const p = pitch(mono, rate, 180, 380);
    const cents = 1200 * Math.log2(p.hz / 261.626);
    ok(Math.abs(cents) <= 30 && p.strength > 0.5, 'middle C reads ' + p.hz.toFixed(2) + ' Hz, ' + (cents >= 0 ? '+' : '') + cents.toFixed(1) + ' cents (periodicity ' + p.strength.toFixed(2) + ')');

    const b = await within(M.render(wasm, roms, piano, { tail: 3 }), 120000, 'render');
    let same = b.channels[0].length === L.length;
    for (let i = 0; same && i < L.length; i++) same = L[i] === b.channels[0][i] && R[i] === b.channels[1][i];
    ok(same, 'two renders identical, sample for sample');

    // An organ holds for ever, so only the controller can end it.
    const organ = [{ t: 0, data: [0xC1, 8] }, { t: 0.5, data: [0x91, 60, 100] }];
    const held = await within(M.render(wasm, roms, organ.concat([{ t: 1.0, data: [0xB1, 7, 100] }]), { tail: 4 }), 120000, 'render');
    const off = await within(M.render(wasm, roms, organ.concat([{ t: 1.0, data: [0xB1, 123, 0] }]), { tail: 4 }), 120000, 'render');
    const hl = rms(held.channels[0], 3.0 * rate, 3.5 * rate), ol = rms(off.channels[0], 3.0 * rate, 3.5 * rate);
    ok(hl > 0.001 && db(hl) - db(ol) >= 40,
      'all notes off: 2 s later ' + (ol > 0 ? db(ol).toFixed(1) + ' dBFS' : 'digital silence') + ' against ' + db(hl).toFixed(1) + ' dBFS held' +
      (off.duration < 5 ? ' (the render stopped itself at ' + off.duration.toFixed(2) + ' s)' : ''));

    e = await rejects(M.render(wasm, { control: roms.pcm, pcm: roms.control }, piano), 'swapped');
    const e2 = await rejects(M.render(wasm, { control: roms.control }, piano), 'no pcm');
    ok(plain(e) && e.code === 'wrong_rom' && plain(e2) && e2.code === 'missing_rom',
      'swapped: "' + (e && e.message) + '"; no PCM: "' + (e2 && e2.message) + '"');

    // Sixteen notes at once is a busier case than one piano note; this is a
    // reading, not a pass mark, because it depends on the machine's load.
    const busy = [];
    for (let ch = 1; ch <= 8; ch++) for (let k = 0; k < 2; k++) busy.push({ t: 0, data: [0x90 | ch, 48 + ch * 3 + k * 7, 100] });
    busy.push({ t: 20, data: [0xB1, 123, 0] });
    const t1 = Date.now();
    const big = await within(M.render(wasm, roms, busy, { tail: 0 }), 300000, 'render');
    const took2 = (Date.now() - t1) / 1000;
    ok(big.duration >= 19.9, 'render speed: one note ' + (a.duration / took).toFixed(0) + 'x real time, sixteen held notes ' + (big.duration / took2).toFixed(0) + 'x');
  }

  console.log(failed ? '\nFAILED: ' + failed : '\nall ok');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('  FAIL threw: ' + (e && e.stack || e)); process.exit(1); });
