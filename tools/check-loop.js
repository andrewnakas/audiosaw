#!/usr/bin/env node
/*
 * Checks /seamless-loop-maker (js/loop-find.js + js/loop-page.js).
 *
 * Node, on a pattern that repeats every 1.2345 s (four decaying notes over a
 * faint noise floor):
 *   - from a rough end 80 ms past three periods, the found loop is three
 *     periods long within 1 ms;
 *   - played on repeat, the step across the seam is no bigger than the
 *     largest step anywhere in the input (no click), where a plain cut at
 *     the rough end steps by more;
 *   - with a tempo, the length is whole bars to the sample;
 *   - repeat() makes exact multiples.
 * Browser: a 120 BPM drum and bass loop, eight bars. The page must find the
 * tempo, select whole bars from a beat, keep exact bars with "whole bars"
 * on, and download a float WAV of the loop twice over whose second copy
 * starts with no step.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const L = require('../js/loop-find.js');

let failed = 0;
const ok = (c, m) => { console.log((c ? '  ok  ' : '  FAIL ') + m); if (!c) failed++; };
const R = 48000;
function rnd(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; }; }
function maxStep(x) { let m = 0; for (let i = 1; i < x.length; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1])); return m; }
function seamStep(loop) { return Math.abs(loop[0] - loop[loop.length - 1]); }

console.log('core');
{
  const P = Math.round(1.2345 * R), n = 8 * R, x = new Float32Array(n), r = rnd(3);
  const notes = [[0, 220], [0.3, 330], [0.62, 277], [0.9, 440]];
  for (let i = 0; i < n; i++) { const ph = (i % P) / R; let v = 0; for (const [t0, f] of notes) if (ph >= t0) { const t = ph - t0; v += 0.2 * Math.exp(-t * 4) * Math.sin(2 * Math.PI * f * t); } x[i] = v + 0.002 * r(); }
  const start = Math.round(1.1 * R), rough = start + 3 * P + Math.round(0.08 * R);
  const f = L.find([x], R, { start, end: rough }), err = (f.end - f.start - 3 * P) / R * 1000;
  ok(Math.abs(err) < 1, 'from a rough end 80 ms out, the loop is three periods within ' + Math.abs(err).toFixed(3) + ' ms (match ' + f.score.toFixed(4) + ')');
  const loop = L.make([x], R, f.start, f.end)[0], naive = x.subarray(start, rough), ms = maxStep(x);
  ok(seamStep(loop) <= ms && seamStep(naive) > ms, 'on repeat the seam steps ' + seamStep(loop).toFixed(4) + ' (largest step in the input ' + ms.toFixed(4) + '); a plain cut at the rough end steps ' + seamStep(naive).toFixed(4));
  const b = L.find([x], R, { start, end: start + 4 * R + 700, bpm: 120, beatsPerBar: 4 });
  ok(b.end - b.start === 2 * 2 * R && b.bars === 2, 'with a tempo of 120 in 4/4: ' + b.bars + ' bars, ' + (b.end - b.start) + ' samples (2 x 96000)');
  const b2 = L.find([x], R, { start, end: start + 3 * R, bpm: 93, beatsPerBar: 3 });
  ok(b2.end - b2.start === Math.round(b2.bars * 60 / 93 * 3 * R), '93 BPM in 3/4: ' + b2.bars + ' bars to the sample (' + (b2.end - b2.start) + ')');
  const rep = L.repeat([loop], 3)[0];
  ok(rep.length === 3 * loop.length && rep[loop.length] === loop[0], 'repeat x3 is exactly three copies');
}

async function main() {
  const { withPage, findChrome } = require('./chrome-harness');
  if (!findChrome()) { console.log('  skip: page (no Chrome)'); return; }
  console.log('page');
  const SR = 44100, beat = 0.5, n = Math.round(16 * 2 * beat * SR + SR), x = new Float32Array(n), r = rnd(7);
  for (let b = 0; b < 32; b++) {
    const s0 = Math.round((0.25 + b * beat) * SR);
    if (b % 2 === 0) { let ph = 0; for (let i = 0; i < 0.3 * SR && s0 + i < n; i++) { const t = i / SR; ph += 2 * Math.PI * (50 + 90 * Math.exp(-t * 30)) / SR; x[s0 + i] += 0.7 * Math.exp(-t * 10) * Math.min(1, (0.3 * SR - i) / (0.1 * SR)) * Math.sin(ph); } }
    else { for (let i = 0; i < 0.15 * SR && s0 + i < n; i++) x[s0 + i] += 0.35 * Math.exp(-i / SR * 25) * Math.min(1, (0.15 * SR - i) / (0.05 * SR)) * r(); }
    const fb = [55, 55, 73.4, 65.4][Math.floor(b / 4) % 4];
    for (let i = 0; i < beat * SR && s0 + i < n; i++) { const t = i / SR; x[s0 + i] += 0.25 * Math.min(1, t / 0.01, (beat * SR - i) / (0.05 * SR)) * Math.sin(2 * Math.PI * fb * t); }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-loop-')), wav = path.join(dir, 'groove.wav');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'f32le', '-ar', String(SR), '-ac', '1', '-i', '-', '-c:a', 'pcm_s16le', wav], { input: Buffer.from(x.buffer) });
  await withPage({}, async (page) => {
    await page.goto('/seamless-loop-maker', 1000);
    const r2 = await page.eval(`(async () => {
      const bin = atob('${fs.readFileSync(wav).toString('base64')}'); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const dt = new DataTransfer(); dt.items.add(new File([u], 'groove.wav', { type: 'audio/wav' }));
      const input = document.getElementById('fileInput'); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
      for (let i = 0; i < 100 && !(window.__loop.sel().e > 0); i++) await new Promise((r) => setTimeout(r, 100));
      const first = window.__loop.sel();
      document.getElementById('lpBars').checked = true;
      window.__loop.refine();
      const after = window.__loop.sel();
      document.getElementById('outFmt').value = 'wav32f'; document.getElementById('lpTimes').value = '2';
      let blob = null, name = null; const orig = CV.downloadBlob; CV.downloadBlob = (b, n) => { blob = b; name = n; };
      await window.__loop.save();
      CV.downloadBlob = orig;
      const ab = blob ? await blob.arrayBuffer() : null; let data = null;
      if (ab) { const dv = new DataView(ab); let off = 12; while (off < ab.byteLength - 8) { const id = String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3)); const sz = dv.getUint32(off + 4, true); if (id === 'data') { data = new Float32Array(ab.slice(off + 8, off + 8 + sz)); break; } off += 8 + sz + (sz & 1); } }
      let step = 0, seam = 0; if (data) { const half = data.length / 2; for (let i = 1; i < data.length; i++) { const d = Math.abs(data[i] - data[i - 1]); if (i === half) seam = d; else step = Math.max(step, d); } }
      return { first, after, name, len: data && data.length, seam, step, note: document.getElementById('lpNote').textContent };
    })()`, 120000);
    const bar = 2 * SR;
    ok(Math.abs(r2.first.bpm - 120) < 0.5, 'the page finds the tempo: ' + r2.first.bpm + ' BPM');
    ok(Math.abs((r2.first.e - r2.first.s) / bar - Math.round((r2.first.e - r2.first.s) / bar)) < 0.01 && Math.abs(((r2.first.s / SR) - 0.25) / 0.5 - Math.round(((r2.first.s / SR) - 0.25) / 0.5)) < 0.04, 'it selects whole bars starting on a beat (' + (r2.first.s / SR).toFixed(3) + ' s, ' + ((r2.first.e - r2.first.s) / bar).toFixed(2) + ' bars)');
    const exact = Math.round(Math.round((r2.after.e - r2.after.s) / (60 / r2.after.bpm * 4 * SR)) * 60 / r2.after.bpm * 4 * SR);
    ok(r2.after.e - r2.after.s === exact, '"whole bars" keeps exact bars at the found tempo (' + (r2.after.e - r2.after.s) + ' samples): ' + r2.note);
    ok(r2.len === 2 * (r2.after.e - r2.after.s) && r2.seam <= r2.step, 'download ' + r2.name + ': the loop twice, ' + r2.len + ' samples; the step into the second copy ' + r2.seam.toFixed(4) + ', the largest elsewhere ' + r2.step.toFixed(4));
    const errs = page.logs.filter((l) => !/scriptwrapper|ERR_CONNECTION_REFUSED|favicon/.test(l));
    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ').slice(0, 300) : ''));
  });
}

main().then(() => {
  if (failed) { console.log('\ncheck-loop: ' + failed + ' failed'); process.exit(1); }
  console.log('\ncheck-loop: all good');
}).catch((e) => { console.error(e); process.exit(1); });
