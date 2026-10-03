#!/usr/bin/env node
/*
 * Checks /enhance-speech (js/speech-enhance.js + enhance-page.js) through the
 * real page, on a rough recording: three phrases of speech with the middle
 * one 12 dB quieter, unsteady noise under it (bursts and clicks, as in
 * check-denoise) and a 40 Hz rumble.
 *
 *   - loudness lands on the -16 LUFS target within 0.3 LU and the true peak
 *     is at or under -1 dBTP (both read by ffmpeg's ebur128);
 *   - the quiet phrase comes up: the loud/quiet gap shrinks by >= 3 dB;
 *   - the pauses come down >= 15 dB relative to the speech, and the 40 Hz
 *     rumble >= 15 dB;
 *   - the length is exact and the voice lines up with the original within
 *     1 ms (so a video stays in sync).
 *
 * Also Node: ASEnhance.chain at 48 kHz hits the target and the ceiling.
 * Needs Chrome, macOS say and ffmpeg for the page part.
 */
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const E = require('../js/speech-enhance.js');
const L = globalThis.ASLoudness;
let failed = 0;
function ok(c, m) { console.log((c ? '  ok  ' : '  FAIL ') + m); if (!c) failed++; }

console.log('chain (Node, 48 kHz)');
{
  const sr = 48000, n = sr * 6, x = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / sr, on = Math.floor(t / 1.5) % 2 === 0; x[i] = on ? 0.1 * (Math.sin(2 * Math.PI * 140 * t) + 0.5 * Math.sin(2 * Math.PI * 1800 * t)) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 5 * t)) : 0; }
  const r = E.chain([x], sr, { target: -16 });
  const I = L.integratedLoudness(r.channels, sr).integrated, TP = L.toDb(L.truePeak(r.channels));
  ok(Math.abs(I + 16) < 0.3 && TP <= -0.99 && r.channels[0].length === n, 'reaches -16 LUFS (' + I.toFixed(2) + ') under -1 dBTP (' + TP.toFixed(2) + '), same length');
}

const SR = 44100;
function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296); }
function goertzelDb(x, s, e, f, sr) {
  const k = 2 * Math.cos(2 * Math.PI * f / sr); let a = 0, b = 0;
  for (let i = s; i < e; i++) { const c = x[i] + k * a - b; b = a; a = c; }
  const p = a * a + b * b - k * a * b;
  return 10 * Math.log10(p / ((e - s) * (e - s)) + 1e-20);
}

async function page() {
  const { withPage, findChrome } = require('./chrome-harness');
  try { execFileSync('say', ['-v', '?'], { stdio: 'ignore' }); execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch (e) { console.log('  skip: page (needs say and ffmpeg)'); return; }
  if (!findChrome()) { console.log('  skip: no Chrome'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-enh-'));
  const parts = ['Welcome back to the show, it is good to have you here.', 'This sentence was recorded much further from the microphone.', 'And now we are close again, so it is loud.'].map((t, i) => {
    const f = path.join(dir, i + '.aiff'); execFileSync('say', ['-v', 'Daniel', '-o', f, t]);
    const b = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', f, '-ar', String(SR), '-ac', '1', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
    return new Float32Array(b.buffer, b.byteOffset, b.length >> 2);
  });
  const gap = Math.round(1.2 * SR), lead = Math.round(0.6 * SR), gains = [0.5, 0.5 * Math.pow(10, -12 / 20), 0.5];
  const n = lead + parts.reduce((a, p) => a + p.length + gap, 0);
  const clean = new Float32Array(n), which = new Int8Array(n).fill(-1);
  let o = lead;
  parts.forEach((p, k) => { for (let i = 0; i < p.length; i++) clean[o + i] = p[i] * gains[k]; which.fill(k, o, o + p.length); o += p.length + gap; });
  const r = rng(11), noise = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < n; i++) {
    const w = r() * 2 - 1; b0 = 0.997 * b0 + 0.029 * w; b1 = 0.985 * b1 + 0.032 * w; b2 = 0.95 * b2 + 0.048 * w;
    noise[i] = (Math.floor(i / (0.3 * SR)) % 3 !== 0 ? 1 : 0.15) * (b0 + b1 + b2) * 0.18 + 0.05 * Math.sin(2 * Math.PI * 40 * i / SR);
  }
  for (let k = 0; k < n / SR * 5; k++) { const at = Math.floor(r() * (n - 200)); for (let j = 0; j < 120; j++) noise[at + j] += (r() * 2 - 1) * 0.05 * Math.exp(-j / 25); }
  const noisy = clean.map((v, i) => v + noise[i]);
  const f32 = path.join(dir, 'in.f32'), wav = path.join(dir, 'in.wav');
  fs.writeFileSync(f32, Buffer.from(noisy.buffer));
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'f32le', '-ar', String(SR), '-ac', '1', '-i', f32, '-c:a', 'pcm_f32le', wav]);
  console.log('page');
  await withPage({ routes: { '/__in.wav': () => fs.readFileSync(wav) } }, async (pg) => {
    await pg.goto('/enhance-speech', 1500);
    const res = await pg.eval(`(async () => {
      const f = new File([await (await fetch('/__in.wav')).blob()], 'rough.wav', { type: 'audio/wav' });
      const dt = new DataTransfer(); dt.items.add(f);
      const inp = document.querySelector('#fileInput'); inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#target').value = '-16';
      document.querySelector('#outFmt').value = 'wav';
      let got = null; const o = CV.downloadBlob; CV.downloadBlob = (b, nm) => { got = { b, nm }; };
      const t0 = performance.now();
      document.querySelector('#convertBtn').click();
      for (let i = 0; i < 1200 && !got && !/Could not/.test(document.querySelector('#status').textContent); i++) await new Promise((r) => setTimeout(r, 100));
      CV.downloadBlob = o;
      if (!got) return { err: document.querySelector('#status').textContent };
      const u = new Uint8Array(await got.b.arrayBuffer()); let bin = ''; for (let i = 0; i < u.length; i += 8192) bin += String.fromCharCode.apply(null, u.subarray(i, i + 8192));
      return { nm: got.nm, b64: btoa(bin), ms: performance.now() - t0, report: document.querySelector('#report').innerText };
    })()`, 600000);
    if (res.err) { ok(false, 'page: ' + res.err); return; }
    const out = path.join(dir, 'out.wav');
    fs.writeFileSync(out, Buffer.from(res.b64, 'base64'));
    const log = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', out, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    const I = parseFloat((/Summary:[\s\S]*?I:\s+(-?[\d.]+) LUFS/.exec(log) || [])[1]);
    const TP = parseFloat((/True peak:\s*\n\s*Peak:\s+(-?[\d.]+) dBFS/.exec(log) || [])[1]);
    const yb = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', out, '-f', 'f32le', '-ac', '1', '-ar', String(SR), '-'], { maxBuffer: 1 << 28 });
    const y = new Float32Array(yb.buffer, yb.byteOffset, yb.length >> 2);
    ok(/-enhanced\.wav$/.test(res.nm) && Math.abs(I + 16) <= 0.3 && TP <= -1 + 0.05, 'loudness ' + I.toFixed(1) + ' LUFS (target -16), true peak ' + TP.toFixed(2) + ' dBTP, ' + (res.ms / 1000).toFixed(1) + ' s for ' + (n / SR).toFixed(1) + ' s');
    const rms = (x, k) => { let s = 0, c = 0; for (let i = 0; i < n; i++) if (which[i] === k) { s += x[i] * x[i]; c++; } return 10 * Math.log10(s / c); };
    // The speaker's own level difference is in the clean signal (12 dB); in
    // the noisy input the noise fills the quiet phrase and hides it.
    const gapIn = rms(clean, 0) - rms(clean, 1), gapOut = rms(y, 0) - rms(y, 1);
    ok(gapIn - gapOut >= 3, 'the quiet phrase comes up: loud/quiet gap ' + gapIn.toFixed(1) + ' dB in, ' + gapOut.toFixed(1) + ' dB out');
    const speechIn = rms(noisy, 0), speechOut = rms(y, 0), pauseIn = rms(noisy, -1), pauseOut = rms(y, -1);
    const pauseDrop = (speechOut - pauseOut) - (speechIn - pauseIn);
    // 40 Hz in the last pause, relative to the loud phrase's level.
    const s0 = n - gap + Math.round(0.1 * SR), s1 = n - Math.round(0.1 * SR);
    const rumbleDrop = (goertzelDb(noisy, s0, s1, 40, SR) - speechIn) - (goertzelDb(y, s0, s1, 40, SR) - speechOut);
    ok(pauseDrop >= 15 && rumbleDrop >= 15, 'pauses ' + pauseDrop.toFixed(1) + ' dB quieter against the speech, 40 Hz rumble ' + rumbleDrop.toFixed(1) + ' dB lower');
    let best = 0, bv = -Infinity;
    for (let lag = -441; lag <= 441; lag++) { let v = 0; for (let i = lead; i < n - 500; i += 3) if (which[i] === 0) v += clean[i] * (y[i + lag] || 0); if (v > bv) { bv = v; best = lag; } }
    ok(y.length === n && Math.abs(best) <= SR / 1000, 'same length (' + (y.length === n ? 'exact' : y.length + ' vs ' + n) + '), voice offset ' + (best / SR * 1000).toFixed(2) + ' ms');
    console.log('       report: ' + res.report.replace(/\s*\n\s*/g, ' | '));
    if (pg.logs.length) console.log('    console: ' + pg.logs.slice(0, 4).join(' | '));
  });
}

page().catch((e) => ok(false, e.stack || e)).then(() => {
  if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
  console.log('\ncheck-enhance: all good');
});
