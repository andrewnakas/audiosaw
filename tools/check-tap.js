#!/usr/bin/env node
/*
 * Checks /tap-bpm (js/tap-tempo.js + js/tap-page.js).
 *
 * Node, 1,000 runs of taps at 120 BPM with +-15 ms of random jitter:
 *   - after 8 taps the fitted line is within 0.5 BPM in at least 85% of
 *     runs and never more than 1.2 BPM out; after 16, always within 0.5;
 *   - the line is at least as good as the average gap it replaces;
 *   - a tap 180 ms off, a double tap and a skipped beat are ignored or
 *     absorbed without moving the tempo; a pause of 5 s starts again.
 * Browser: 16 key presses 500 ms apart through CDP (the page reads each
 * event's own timeStamp) must read 120 within 1 BPM, offer the metronome at
 * that tempo, and fire convert_success once; a 128 BPM drum loop dropped as
 * the song to tap along to must measure 128.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const T = require('../js/tap-tempo.js');

let failed = 0;
const ok = (c, m) => { console.log((c ? '  ok  ' : '  FAIL ') + m); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function rnd(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

console.log('tempo');
{
  const stats = (n) => {
    let line = 0, gap = 0, worst = 0;
    for (let k = 0; k < 1000; k++) {
      const r = rnd(k + 1), tp = new T.Tapper(), times = []; let st;
      for (let i = 0; i < n; i++) { const t = 1000 + i * 500 + (r() - 0.5) * 30; times.push(t); st = tp.tap(t); }
      if (Math.abs(st.bpm - 120) <= 0.5) line++;
      if (Math.abs(T.averageGap(times) - 120) <= 0.5) gap++;
      worst = Math.max(worst, Math.abs(st.bpm - 120));
    }
    return { line: line / 10, gap: gap / 10, worst };
  };
  const s8 = stats(8), s16 = stats(16);
  ok(s8.line >= 85 && s8.worst <= 1.2, '8 taps, +-15 ms jitter: within 0.5 BPM in ' + s8.line.toFixed(1) + '% of 1,000 runs, worst ' + s8.worst.toFixed(2) + ' BPM');
  ok(s16.line === 100, '16 taps: within 0.5 BPM in ' + s16.line.toFixed(1) + '%, worst ' + s16.worst.toFixed(2) + ' BPM');
  ok(s8.line >= s8.gap, 'the fitted line beats the average gap at 8 taps (' + s8.line.toFixed(1) + '% against ' + s8.gap.toFixed(1) + '%)');
  let tp = new T.Tapper(), s;
  for (let i = 0; i < 12; i++) s = tp.tap(1000 + i * 500 + (i === 6 ? 180 : 0));
  ok(Math.abs(s.bpm - 120) < 0.01 && s.ignored === 1, 'a tap 180 ms off is ignored (' + s.bpm.toFixed(2) + ' BPM, ' + s.ignored + ' ignored)');
  tp = new T.Tapper(); for (let i = 0; i < 10; i++) tp.tap(i * 500); tp.tap(4590); s = tp.tap(5000); s = tp.tap(5500);
  ok(Math.abs(s.bpm - 120) < 0.01, 'a double tap is ignored (' + s.bpm.toFixed(2) + ')');
  tp = new T.Tapper(); for (let i = 0; i < 10; i++) tp.tap(i * 500); tp.tap(5500); s = tp.tap(6000);
  ok(Math.abs(s.bpm - 120) < 0.01 && s.taps === 12, 'a skipped beat is absorbed (' + s.bpm.toFixed(2) + ', ' + s.taps + ' taps)');
  tp = new T.Tapper(); for (let i = 0; i < 8; i++) tp.tap(i * 500); s = tp.tap(3500 + 5000);
  ok(s.taps === 1, 'a 5 s pause starts a new count');
}

async function main() {
  const { withPage, findChrome } = require('./chrome-harness');
  if (!findChrome()) { console.log('  skip: page (no Chrome)'); return; }
  console.log('page');
  await withPage({}, async (page) => {
    await page.goto('/tap-bpm', 1000);
    await page.eval('window.__ev = []; (function () { var o = CV.track; CV.track = function (n, p) { window.__ev.push([n, p]); return o.apply(this, arguments); }; })()');
    const t0 = Date.now();
    for (let i = 0; i < 16; i++) {
      const due = t0 + i * 500 - Date.now();
      if (due > 0) await sleep(due);
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'j', code: 'KeyJ', text: 'j', windowsVirtualKeyCode: 74 });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'j', code: 'KeyJ', windowsVirtualKeyCode: 74 });
    }
    const s = await page.eval('({ st: window.__tap.state(), metro: window.__tap.metro(), text: document.getElementById("tBpm").textContent, ev: window.__ev.map((e) => e[0] + ":" + e[1].target_format) })');
    ok(s.st && Math.abs(s.st.bpm - 120) <= 1, '16 key presses 500 ms apart read ' + s.text + ' BPM (' + (s.st && s.st.taps) + ' taps)');
    ok(s.metro === '/metronome?bpm=' + Math.round(s.st.bpm * 10) / 10, 'the metronome is offered at that tempo (' + s.metro + ')');
    ok(s.ev.filter((e) => e === 'convert_success:bpm').length === 1 && s.ev.filter((e) => e === 'convert_start:bpm').length === 1, 'convert_start and convert_success once each (' + s.ev.join(', ') + ')');
    // A 128 BPM drum loop to tap along to.
    const R = 44100, beat = 60 / 128, n = Math.round(16 * beat * R), x = new Float32Array(n);
    for (let b = 0; b < 16; b++) { const s0 = Math.round(b * beat * R); let ph = 0; for (let i = 0; i < 0.2 * R && s0 + i < n; i++) { const t = i / R; ph += 2 * Math.PI * (55 + 90 * Math.exp(-t * 30)) / R; x[s0 + i] += 0.8 * Math.exp(-t * 15) * Math.sin(ph); } if (b % 2) { for (let i = 0; i < 0.1 * R && s0 + i < n; i++) x[s0 + i] += 0.3 * Math.exp(-i / R * 30) * (Math.random() - 0.5); } }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-tap-')), wav = path.join(dir, 'loop.wav');
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'f32le', '-ar', String(R), '-ac', '1', '-i', '-', '-c:a', 'pcm_s16le', wav], { input: Buffer.from(x.buffer) });
    const f = await page.eval(`(async () => {
      const bin = atob('${fs.readFileSync(wav).toString('base64')}'); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const dt = new DataTransfer(); dt.items.add(new File([u], 'loop.wav', { type: 'audio/wav' }));
      const input = document.getElementById('fileInput'); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
      for (let i = 0; i < 100 && !/measures|tap along/.test(window.__tap.file()); i++) await new Promise((r) => setTimeout(r, 100));
      return window.__tap.file();
    })()`);
    const m = /measures ([\d.]+) BPM/.exec(f);
    ok(m && Math.abs(+m[1] - 128) <= 0.5, 'a 128 BPM loop to tap along to: "' + f + '"');
    const errs = page.logs.filter((l) => !/scriptwrapper|ERR_CONNECTION_REFUSED|favicon/.test(l));
    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ').slice(0, 300) : ''));
  });
}

main().then(() => {
  if (failed) { console.log('\ncheck-tap: ' + failed + ' failed'); process.exit(1); }
  console.log('\ncheck-tap: all good');
}).catch((e) => { console.error(e); process.exit(1); });
