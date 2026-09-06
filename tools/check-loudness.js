#!/usr/bin/env node
/*
 * Validates js/loudness.js against ffmpeg's ebur128 filter, which is the
 * reference implementation of ITU-R BS.1770.
 *
 * The measurement is fully specified, so it can be checked rather than
 * trusted. Run this after touching loudness.js:
 *
 *   node tools/check-loudness.js <file.wav> [more.wav ...]
 *
 * With no arguments it generates its own 48 kHz fixtures and checks those, so
 * the validation is reproducible without committing binary test files. Pass
 * paths to check your own material instead.
 *
 * Files must be 48 kHz — the spec's filter coefficients are defined there, and
 * the browser resamples before measuring for the same reason.
 *
 * Needs ffmpeg on PATH.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

require(path.join(__dirname, '..', 'js', 'loudness.js'));
const L = globalThis.ASLoudness;

function readWav(p) {
  const b = fs.readFileSync(p);
  let off = 12, sr = 48000, ch = 1, bits = 16, data = null;
  while (off < b.length - 8) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') { ch = b.readUInt16LE(off + 10); sr = b.readUInt32LE(off + 12); bits = b.readUInt16LE(off + 22); }
    if (id === 'data') { data = b.subarray(off + 8, off + 8 + size); break; }
    off += 8 + size + (size % 2);
  }
  const bytes = bits / 8;
  const n = Math.floor(data.length / bytes / ch);
  const chans = [];
  for (let c = 0; c < ch; c++) chans.push(new Float32Array(n));
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const o = (i * ch + c) * bytes;
      chans[c][i] = bits === 16 ? data.readInt16LE(o) / 32768 : data.readFloatLE(o);
    }
  }
  return { sr, chans };
}

function reference(file) {
  // ffmpeg writes the ebur128 summary to stderr and exits 0, so execFileSync
  // (which returns stdout and only exposes stderr when the command throws)
  // silently produced nothing. An earlier version of this script did exactly
  // that, compared against NaN, and reported a pass having checked nothing.
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file,
    '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-'],
    { encoding: 'utf8' });
  const out = (r.stderr || '') + (r.stdout || '');
  const i = out.match(/I:\s*(-?[\d.]+)\s*LUFS/);
  const pk = out.match(/Peak:\s*(-?[\d.]+)\s*dBFS/);
  return { i: i ? parseFloat(i[1]) : NaN, peak: pk ? parseFloat(pk[1]) : NaN };
}

// --- fixtures ------------------------------------------------------------
// Chosen to exercise the parts of the spec that are easy to get wrong: the two
// gates (silent intro, speech with pauses), mono vs stereo weighting, and
// broadband content for the true-peak interpolation.
function writeWav(file, gen, seconds, channels) {
  const sr = 48000, n = Math.floor(sr * seconds);
  const bytes = 2, size = n * channels * bytes;
  const b = Buffer.alloc(44 + size);
  b.write('RIFF', 0); b.writeUInt32LE(36 + size, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22); b.writeUInt32LE(sr, 24);
  b.writeUInt32LE(sr * channels * bytes, 28); b.writeUInt16LE(channels * bytes, 32);
  b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(size, 40);
  let o = 44;
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, gen(i, sr)));
    for (let c = 0; c < channels; c++) { b.writeInt16LE(Math.round(v * 32000), o); o += 2; }
  }
  fs.writeFileSync(file, b);
  return file;
}

function makeFixtures(dir) {
  fs.mkdirSync(dir, { recursive: true });
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x3fffffff - 1; };
  const f = [];
  f.push(writeWav(path.join(dir, 'tone1k.wav'), (i, sr) => 0.5 * Math.sin(2 * Math.PI * 1000 * i / sr), 8, 2));
  f.push(writeWav(path.join(dir, 'quiet.wav'), (i, sr) => 0.05 * Math.sin(2 * Math.PI * 440 * i / sr), 8, 2));
  f.push(writeWav(path.join(dir, 'mono.wav'), (i, sr) => 0.6 * Math.sin(2 * Math.PI * 997 * i / sr), 6, 1));
  f.push(writeWav(path.join(dir, 'noise.wav'), () => 0.4 * rnd(), 6, 2));
  f.push(writeWav(path.join(dir, 'speech.wav'), (i, sr) => {
    const t = i / sr, phase = t % 2.0;
    if (phase > 1.1) return 0;
    return 0.5 * Math.exp(-((phase - 0.4) ** 2) / 0.05) * (Math.sin(2 * Math.PI * 180 * t) + 0.3 * rnd());
  }, 16, 2));
  f.push(writeWav(path.join(dir, 'silentintro.wav'), (i, sr) => {
    const t = i / sr;
    return t < 6 ? 0 : 0.5 * Math.sin(2 * Math.PI * 500 * t);
  }, 14, 2));
  return f;
}

let files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!files.length) {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'as-lufs-'));
  files = makeFixtures(dir);
  console.log(`generated ${files.length} fixtures in ${dir}\n`);
}

let worst = 0, worstUnder = 0, worstOver = 0, rows = [];
for (const file of files) {
  const { sr, chans } = readWav(file);
  const mine = L.integratedLoudness(chans, sr);
  const minePeak = L.toDb(L.truePeak(chans));

  const ref = reference(file);
  const refI = ref.i, refPeak = ref.peak;
  if (isNaN(refI)) {
    console.error(`FAIL: no reference loudness parsed for ${file} — cannot compare.`);
    process.exit(1);
  }

  const dI = Math.abs(mine.integrated - refI);
  // Signed, because the direction matters. Reading the true peak LOW is
  // dangerous — it would let a file clip. Reading it high only costs a little
  // extra headroom, so the tolerances are deliberately asymmetric.
  const dP = isNaN(refPeak) ? NaN : (minePeak - refPeak);
  if (dI > worst) worst = dI;
  if (!isNaN(dP)) {
    if (dP < worstUnder) worstUnder = dP;
    if (dP > worstOver) worstOver = dP;
  }
  rows.push([path.basename(file), sr, chans.length, mine.integrated, refI, dI, minePeak, refPeak, dP]);
}

console.log('file'.padEnd(22) + 'sr'.padStart(6) + 'ch'.padStart(3)
  + 'mine'.padStart(9) + 'ffmpeg'.padStart(9) + 'delta'.padStart(7)
  + 'tpMine'.padStart(9) + 'tpRef'.padStart(8) + 'delta'.padStart(7));
for (const r of rows) {
  console.log(r[0].padEnd(22) + String(r[1]).padStart(6) + String(r[2]).padStart(3)
    + r[3].toFixed(2).padStart(9) + (isNaN(r[4]) ? 'n/a' : r[4].toFixed(2)).padStart(9)
    + r[5].toFixed(2).padStart(7)
    + r[6].toFixed(2).padStart(9) + (isNaN(r[7]) ? 'n/a' : r[7].toFixed(2)).padStart(8)
    + (isNaN(r[8]) ? 'n/a' : (r[8] >= 0 ? '+' : '') + r[8].toFixed(2)).padStart(7));
}
console.log(`\nworst integrated-loudness error: ${worst.toFixed(3)} LU`);
console.log(`true peak, most under reference:  ${worstUnder.toFixed(3)} dB  (must be > -0.15)`);
console.log(`true peak, most over reference:   +${worstOver.toFixed(3)} dB  (must be < 0.60)`);
let bad = false;
if (worst > 0.1) { console.error('FAIL: loudness over the 0.1 LU tolerance'); bad = true; }
if (worstUnder < -0.15) { console.error('FAIL: true peak reads low — that would let a file clip'); bad = true; }
if (worstOver > 0.6) { console.error('FAIL: true peak reads far too high'); bad = true; }
if (bad) process.exit(1);
console.log('PASS: matches the reference implementation within tolerance');
