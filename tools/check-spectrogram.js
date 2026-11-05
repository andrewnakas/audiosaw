#!/usr/bin/env node
/*
 * Checks /spectrogram (js/spectrogram.js + js/spectrogram-page.js).
 *
 * Node:
 *   - a 1 kHz tone lands on the 1 kHz row, linear and log, at -6 dB for a
 *     0.5 sine (Hann scalloping costs under 1.5 dB off-bin);
 *   - 440 Hz and 3 kHz together are both peaks, nothing between;
 *   - a log chirp from 100 Hz to 10 kHz is on its row at each sampled time,
 *     within one FFT bin or 0.6 semitones;
 *   - zoomed out (60 s over 600 columns), a 2 ms click still lights its
 *     column: a column takes the loudest of the FFTs across it.
 * Browser: the page draws the chirp (the grid's peak row is the chirp's
 * frequency), zooms into a stretch, and saves a 1600 x 900 PNG.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const S = require('../js/spectrogram.js');

let failed = 0;
const ok = (c, m) => { console.log((c ? '  ok  ' : '  FAIL ') + m); if (!c) failed++; };
const R = 48000;

function peakRow(g, cols, rows, c) { let b = 0; for (let r = 1; r < rows; r++) if (g[r * cols + c] > g[b * cols + c]) b = r; return b; }
function chirp(sec) { const n = sec * R, x = new Float32Array(n); let ph = 0; for (let i = 0; i < n; i++) { const f = 100 * Math.pow(100, i / n); ph += 2 * Math.PI * f / R; x[i] = 0.4 * Math.sin(ph); } return x; }

console.log('core');
{
  const n = 2 * R, x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * 1000 * i / R);
  for (const log of [false, true]) {
    const o = { rate: R, cols: 20, rows: 400, fft: 4096, log }, g = S.grid(x, o), r = peakRow(g, 20, 400, 10);
    const hz = S.rowHz(r, 400, { log, minHz: log ? 20 : 0, maxHz: R / 2 }), lv = g[r * 20 + 10];
    ok(Math.abs(hz - 1000) / 1000 < (log ? 0.012 : 0.03) && lv > -7.5 && lv < -5.9, (log ? 'log' : 'linear') + ': 1 kHz on the ' + hz.toFixed(0) + ' Hz row at ' + lv.toFixed(2) + ' dB');
  }
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) y[i] = 0.3 * Math.sin(2 * Math.PI * 440 * i / R) + 0.3 * Math.sin(2 * Math.PI * 3000 * i / R);
  const o = { rate: R, cols: 10, rows: 300, fft: 4096, log: true, minHz: 20, maxHz: R / 2 }, g = S.grid(y, o);
  const r440 = Math.round(S.hzRow(440, 300, o)), r3k = Math.round(S.hzRow(3000, 300, o)), mid = Math.round(S.hzRow(1150, 300, o));
  const v = (r) => Math.max(g[r * 10 + 5], g[(r - 1) * 10 + 5], g[(r + 1) * 10 + 5]);
  ok(v(r440) > -12 && v(r3k) > -12 && g[mid * 10 + 5] < v(r440) - 40, 'two tones: 440 Hz ' + v(r440).toFixed(1) + ' dB, 3 kHz ' + v(r3k).toFixed(1) + ' dB, 1.15 kHz between them ' + g[mid * 10 + 5].toFixed(1) + ' dB');
  const ch = chirp(4), oc = { rate: R, cols: 80, rows: 300, fft: 2048, log: true, minHz: 20, maxHz: R / 2 }, gc = S.grid(ch, oc);
  // Within one FFT bin (23 Hz at 2048 points, wider than a semitone below
  // ~400 Hz) or 0.6 semitones, whichever is wider.
  const misses = [10, 20, 40, 60, 70].map((c) => { const t = (c + 0.5) / 80, want = 100 * Math.pow(100, t), got = S.rowHz(peakRow(gc, 80, 300, c), 300, oc); return { want, got, ok: Math.abs(got - want) <= R / 2048 || Math.abs(Math.log2(got / want) * 12) <= 0.6 }; });
  ok(misses.every((m) => m.ok), 'log chirp 100 Hz-10 kHz: on its row at five times, within a bin or 0.6 semitones (' + misses.map((m) => Math.round(m.want) + '->' + Math.round(m.got)).join(', ') + ' Hz)');
  const long = new Float32Array(60 * R); const at = Math.round(31.337 * R); for (let i = 0; i < 96; i++) long[at + i] = 0.8 * (i % 2 ? -1 : 1) * Math.exp(-i / 20);
  const gl = S.grid(long, { rate: R, cols: 600, rows: 100, fft: 4096 }), col = Math.floor(31.337 / 60 * 600);
  let peakCol = 0, best = -Infinity; for (let c = 0; c < 600; c++) { let m = -Infinity; for (let r = 0; r < 100; r++) m = Math.max(m, gl[r * 600 + c]); if (m > best) { best = m; peakCol = c; } }
  ok(Math.abs(peakCol - col) <= 1 && best > -60, 'zoomed out (60 s in 600 columns), a 2 ms click lights its column (' + peakCol + ', ' + best.toFixed(1) + ' dB)');
}

async function main() {
  const { withPage, findChrome } = require('./chrome-harness');
  if (!findChrome()) { console.log('  skip: page (no Chrome)'); return; }
  console.log('page');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-spectro-')), wav = path.join(dir, 'chirp.wav'), ch = chirp(4);
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'f32le', '-ar', String(R), '-ac', '1', '-i', '-', '-c:a', 'pcm_s16le', wav], { input: Buffer.from(ch.buffer) });
  await withPage({}, async (page) => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.goto('/spectrogram', 1000);
    const r = await page.eval(`(async () => {
      const bin = atob('${fs.readFileSync(wav).toString('base64')}'); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const dt = new DataTransfer(); dt.items.add(new File([u], 'chirp.wav', { type: 'audio/wav' }));
      const input = document.getElementById('fileInput'); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
      for (let i = 0; i < 150 && document.getElementById('sgView').getAttribute('data-ready') !== '1'; i++) await new Promise((r) => setTimeout(r, 100));
      document.getElementById('sgScale').value = 'log'; await window.__spectro.draw();
      const G = window.__spectro.grid(), o = G.opt, out = [];
      for (const t of [0.5, 2, 3.5]) {
        const c = Math.floor(t / 4 * o.cols); let b = 0; for (let r = 1; r < o.rows; r++) if (G.grid[r * o.cols + c] > G.grid[b * o.cols + c]) b = r;
        out.push([t, ASSpectro.rowHz(b, o.rows, o.o)]);
      }
      await window.__spectro.setView(1, 2);
      const v = window.__spectro.view(), G2 = window.__spectro.grid();
      let blob = null; const orig = CV.downloadBlob; CV.downloadBlob = (b) => { blob = b; };
      window.__spectro.png();
      for (let i = 0; i < 50 && !blob; i++) await new Promise((r) => setTimeout(r, 100));
      CV.downloadBlob = orig;
      let w = 0, h = 0, spread = 0;
      if (blob) { const bm = await createImageBitmap(blob); w = bm.width; h = bm.height; const c = new OffscreenCanvas(w, h), g = c.getContext('2d'); g.drawImage(bm, 0, 0); const d = g.getImageData(70, 44, 1400, 800).data; const seen = new Set(); for (let i = 0; i < d.length; i += 4000) seen.add(d[i] + ',' + d[i + 1] + ',' + d[i + 2]); spread = seen.size; }
      return { peaks: out, view: v, cols: G2.opt.cols, type: blob && blob.type, w, h, spread };
    })()`, 120000);
    const good = r.peaks.every(([t, hz]) => { const want = 100 * Math.pow(100, t / 4); return Math.abs(hz - want) <= R / 4096 || Math.abs(Math.log2(hz / want) * 12) <= 0.6; });
    ok(good, 'the page draws the chirp on its rows at 0.5, 2 and 3.5 s (' + r.peaks.map((p) => Math.round(100 * Math.pow(100, p[0] / 4)) + '->' + Math.round(p[1]) + ' Hz').join(', ') + ')');
    ok(r.view.t0 === 1 && r.view.t1 === 2 && r.cols > 500, 'zoomed to 1-2 s, re-analysed at ' + r.cols + ' columns');
    ok(r.type === 'image/png' && r.w === 1600 && r.h === 900 && r.spread > 20, 'Save PNG: ' + r.w + ' x ' + r.h + ' ' + r.type + ', ' + r.spread + ' distinct colours in the plot');
    const errs2 = page.logs.filter((l) => !/scriptwrapper|ERR_CONNECTION_REFUSED|favicon/.test(l));
    ok(!errs2.length, 'no page errors' + (errs2.length ? ': ' + errs2.join(' | ').slice(0, 300) : ''));
  });
}

main().then(() => {
  if (failed) { console.log('\ncheck-spectrogram: ' + failed + ' failed'); process.exit(1); }
  console.log('\ncheck-spectrogram: all good');
}).catch((e) => { console.error(e); process.exit(1); });
