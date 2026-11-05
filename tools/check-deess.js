#!/usr/bin/env node
/*
 * Checks /de-esser (js/deess.js + js/deess-page.js).
 *
 * Fixture: two `say` voices (Daniel, Samantha) reading a sentence full of
 * "s" and "sh". Frames are classed on the original, with a split of our own
 * at 5 kHz: "s" frames have over 70% of their energy above it, vowel frames
 * under 5%.
 *   - at 6 dB, the energy above the crossover in "s" frames comes down
 *     6 dB +-1;
 *     at 12 dB, 12 +-1.5;
 *   - vowel frames move by at most 0.2 dB;
 *   - wherever no reduction applies, the output is the input, sample for
 *     sample, and the length is exact;
 *   - "only what is removed" plus the de-essed output is the input.
 * Browser: the real page on a WAV (float out) and on a video (picture
 * byte-identical).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const D = require('../js/deess.js');

let failed = 0;
const ok = (c, m) => { console.log((c ? '  ok  ' : '  FAIL ') + m); if (!c) failed++; };
const R = 48000;
const TEXT = 'She sells sea shells by the sea shore. Six slick sausages sizzle. Sam\'s sister sits still and sips sweet cider.';

function sayVoice(dir, v) {
  const a = path.join(dir, v + '.aiff');
  execFileSync('say', ['-v', v, '-o', a, TEXT]);
  const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', a, '-ar', String(R), '-ac', '1', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  return new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4).slice();
}
// fc: the band the de-esser turns down is above its crossover; frames are
// classed on a 5 kHz split of the original.
function measure(x, y, fc) {
  const cls = D.butterLP(x, 5000, R), low = D.butterLP(x, fc, R), lowY = D.butterLP(y, fc, R), F = 240;
  let sIn = 0, sOut = 0, vIn = 0, vOut = 0;
  for (let f = 0; f + F <= x.length; f += F) {
    let e = 0, h = 0, hy = 0, ey = 0;
    let c = 0;
    for (let i = f; i < f + F; i++) { e += x[i] * x[i]; const k = x[i] - cls[i]; c += k * k; const a = x[i] - low[i]; h += a * a; const b = y[i] - lowY[i]; hy += b * b; ey += y[i] * y[i]; }
    if (e < 1e-5 * F) continue;
    if (c / e > 0.7) { sIn += h; sOut += hy; }
    if (c / e < 0.05) { vIn += e; vOut += ey; }
  }
  return { s: 10 * Math.log10(sOut / sIn), v: 10 * Math.log10(vOut / vIn) };
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-deess-'));
  let voices;
  try { voices = { Daniel: sayVoice(dir, 'Daniel'), Samantha: sayVoice(dir, 'Samantha') }; } catch (e) { console.log('  skip: needs say and ffmpeg'); return; }
  console.log('core');
  for (const [v, x] of Object.entries(voices)) {
    const r6 = D.process([x], R, { amount: 6 }), m6 = measure(x, r6.channels[0], r6.crossover);
    const r12 = D.process([x], R, { amount: 12 }), m12 = measure(x, r12.channels[0], r12.crossover);
    ok(Math.abs(m6.s + 6) <= 1 && Math.abs(m12.s + 12) <= 1.5, v + ': "s" frames above the crossover down ' + (-m6.s).toFixed(2) + ' dB at 6, ' + (-m12.s).toFixed(2) + ' dB at 12 (crossover ' + Math.round(r6.crossover) + ' Hz)');
    ok(Math.abs(m6.v) <= 0.2 && Math.abs(m12.v) <= 0.2, v + ': vowel frames move ' + m6.v.toFixed(3) + ' / ' + m12.v.toFixed(3) + ' dB');
    const y = r6.channels[0]; let same = 0, bad = 0;
    for (let i = 0; i < x.length; i++) { if (r6.gain[i] === 1) { if (y[i] === x[i]) same++; else bad++; } }
    ok(y.length === x.length && bad === 0, v + ': where nothing is turned down (' + (100 * same / x.length).toFixed(1) + '% of samples) the output is the input exactly; length exact');
    const cut = D.process([x], R, { amount: 6, listen: true }).channels[0]; let worst = 0;
    for (let i = 0; i < x.length; i++) worst = Math.max(worst, Math.abs(y[i] + cut[i] - x[i]));
    ok(worst < 1e-6, v + ': "only what is removed" plus the output is the input (worst ' + worst.toExponential(1) + ')');
  }

  const { withPage, findChrome } = require('./chrome-harness');
  if (!findChrome()) { console.log('  skip: page (no Chrome)'); return; }
  console.log('page');
  const CORE = path.join(os.homedir(), '.cache', 'audiosaw', 'ffmpeg-core-0.12.6.wasm');
  const x = voices.Samantha, wav = path.join(dir, 's.wav');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'f32le', '-ar', String(R), '-ac', '1', '-i', '-', '-c:a', 'pcm_f32le', wav], { input: Buffer.from(x.buffer) });
  const routes = fs.existsSync(CORE) ? { '/__core.wasm': () => fs.readFileSync(CORE) } : {};
  await withPage({ routes }, async (page) => {
    if (fs.existsSync(CORE)) {
      await page.send('Fetch.enable', { patterns: [{ urlPattern: '*ffmpeg-core.wasm*' }] });
      page.listen('Fetch.requestPaused', (p) => page.send('Fetch.continueRequest', { requestId: p.requestId, url: page.url('/__core.wasm') }));
    }
    await page.goto('/de-esser', 1500);
    const drive = (file, name, type, fmt) => page.eval(`(async () => {
      const bin = atob('${fs.readFileSync(file).toString('base64')}'); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const dt = new DataTransfer(); dt.items.add(new File([u], '${name}', { type: '${type}' }));
      const input = document.getElementById('fileInput'); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('outFmt').value = '${fmt}'; document.getElementById('amount').value = '6';
      let out = null, oname = null; const orig = CV.downloadBlob; CV.downloadBlob = (b, n) => { out = b; oname = n; };
      document.getElementById('convertBtn').click();
      for (let i = 0; i < 1200 && !out && !/error/.test(document.getElementById('status').className); i++) await new Promise((r) => setTimeout(r, 250));
      CV.downloadBlob = orig;
      const report = (document.getElementById('rCross') || {}).textContent;
      document.getElementById('resetBtn').click();
      if (!out) return { err: document.getElementById('status').textContent };
      const ab = new Uint8Array(await out.arrayBuffer()); let s = ''; for (let i = 0; i < ab.length; i += 0x8000) s += String.fromCharCode.apply(null, ab.subarray(i, i + 0x8000));
      return { name: oname, b64: btoa(s), report };
    })()`, 600000);
    const r = await drive(wav, 's.wav', 'audio/wav', 'wav32f');
    if (r.err) ok(false, 'page: ' + r.err);
    else {
      const out = path.join(dir, 'out.wav'); fs.writeFileSync(out, Buffer.from(r.b64, 'base64'));
      const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', out, '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
      const y = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4), m = measure(x, y, D.process([x], R, { amount: 6 }).crossover);
      ok(y.length === x.length && Math.abs(m.s + 6) <= 1 && Math.abs(m.v) <= 0.2, 'page: ' + r.name + ', ' + y.length + ' samples, "s" ' + m.s.toFixed(2) + ' dB, vowels ' + m.v.toFixed(3) + ' dB; crossover ' + r.report);
    }
    if (fs.existsSync(CORE)) {
      const mp4 = path.join(dir, 'v.mp4');
      execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=8', '-i', wav, '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '256k', mp4]);
      const v = await drive(mp4, 'v.mp4', 'video/mp4', 'mp3');
      if (v.err) ok(false, 'video: ' + v.err);
      else {
        const out = path.join(dir, 'out.mp4'); fs.writeFileSync(out, Buffer.from(v.b64, 'base64'));
        const md5 = (f) => execFileSync('ffmpeg', ['-loglevel', 'error', '-i', f, '-map', '0:v', '-c', 'copy', '-f', 'md5', '-']).toString().trim();
        ok(md5(out) === md5(mp4), 'video: ' + v.name + ', picture byte-identical');
      }
    } else console.log('  skip: video (no ffmpeg core in the cache)');
    const errs = page.logs.filter((l) => !/scriptwrapper|ERR_CONNECTION_REFUSED|favicon/.test(l));
    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ').slice(0, 300) : ''));
  });
}

main().then(() => {
  if (failed) { console.log('\ncheck-deess: ' + failed + ' failed'); process.exit(1); }
  console.log('\ncheck-deess: all good');
}).catch((e) => { console.error(e); process.exit(1); });
