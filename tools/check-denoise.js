#!/usr/bin/env node
/*
 * Checks /noise-reduction's two methods on noise that is NOT steady: speech
 * with pauses, under pink-noise bursts gated on and off and random clicks
 * (a keyboard, traffic). Spectral gating is built for steady noise and is
 * expected to do little here; the AI method (RNNoise, rnnoise-worker.js) is
 * the one that has to work:
 *
 *   - in the pauses, the noise comes down at least 15 dB;
 *   - the speech survives. At a realistic level (about +3 dB SNR while
 *     talking) the result correlates >= 0.85 with the clean speech; at an
 *     extreme one (noise 3x louder than the voice, -10.6 dB) it must at least
 *     improve on the noisy input by 0.3;
 *   - it lines up with the original within 1 ms (the worker removes
 *     RNNoise's 20 ms of delay), and the length is exact.
 *
 * Both methods run through the real page with float WAV out. Needs Chrome
 * and macOS say.
 */
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
let failed = 0;
function ok(c, m) { console.log((c ? '  ok  ' : '  FAIL ') + m); if (!c) failed++; }

const SR = 44100;
function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296); }

async function main() {
  const { withPage, findChrome } = require('./chrome-harness');
  try { execFileSync('say', ['-v', '?'], { stdio: 'ignore' }); } catch (e) { console.log('  skip: needs macOS say'); return; }
  if (!findChrome()) { console.log('  skip: no Chrome'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-dn-'));
  // Clean speech: three phrases with 1.5 s pauses between them.
  const parts = ['The harbour lights came on one by one.', 'A ferry crossed the bay before the storm.', 'Then the town went quiet for the night.'].map((t, i) => {
    const f = path.join(dir, i + '.aiff'); execFileSync('say', ['-v', 'Daniel', '-o', f, t]);
    const b = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', f, '-ar', String(SR), '-ac', '1', '-f', 'f32le', '-']);
    return new Float32Array(b.buffer, b.byteOffset, b.length >> 2);
  });
  const gap = Math.round(1.5 * SR), lead = Math.round(0.8 * SR);
  const n = lead + parts.reduce((a, p) => a + p.length + gap, 0);
  const clean = new Float32Array(n), speaking = new Uint8Array(n);
  let o = lead;
  parts.forEach((p) => { clean.set(p.map((v) => v * 0.7), o); speaking.fill(1, o, o + p.length); o += p.length + gap; });
  // Non-steady noise: pink-ish bursts gated every 0.3 s, and clicks.
  const r = rng(7), noise = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < n; i++) {
    const w = r() * 2 - 1; b0 = 0.997 * b0 + 0.029 * w; b1 = 0.985 * b1 + 0.032 * w; b2 = 0.95 * b2 + 0.048 * w;
    const on = Math.floor(i / (0.3 * SR)) % 3 !== 0;
    noise[i] = (on ? 1 : 0.15) * (b0 + b1 + b2) * 0.9;
  }
  for (let k = 0; k < n / SR * 6; k++) { const at = Math.floor(r() * (n - 200)); for (let j = 0; j < 120; j++) noise[at + j] += (r() * 2 - 1) * 0.25 * Math.exp(-j / 25); }
  const rmsOn = (x, want) => { let q = 0, c = 0; for (let i = lead; i < n; i++) if (speaking[i] === want) { q += x[i] * x[i]; c++; } return Math.sqrt(q / c); };
  const db = (a) => 20 * Math.log10(a);
  const corrWith = (y) => { let xy = 0, xx = 0, yy = 0; for (let i = lead; i < n; i++) if (speaking[i]) { xy += clean[i] * y[i]; xx += clean[i] * clean[i]; yy += y[i] * y[i]; } return xy / Math.sqrt(xx * yy); };
  const levels = [['realistic', 0.2], ['extreme', 1]].map(([name, k]) => {
    const noisy = clean.map((v, i) => v + k * noise[i]);
    let xx = 0, ns = 0; for (let i = lead; i < n; i++) if (speaking[i]) { xx += clean[i] * clean[i]; ns += k * k * noise[i] * noise[i]; }
    const f32 = path.join(dir, name + '.f32'), wav = path.join(dir, name + '.wav');
    fs.writeFileSync(f32, Buffer.from(noisy.buffer));
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'f32le', '-ar', String(SR), '-ac', '1', '-i', f32, '-c:a', 'pcm_f32le', wav]);
    return { name, noisy, wav, snr: 10 * Math.log10(xx / ns), base: corrWith(noisy) };
  });
  const routes = {}; levels.forEach((L) => { routes['/__' + L.name + '.wav'] = () => fs.readFileSync(L.wav); });
  await withPage({ routes }, async (page) => {
    for (const L of levels) {
      console.log('  ' + L.name + ': SNR while talking ' + L.snr.toFixed(1) + ' dB, input correlation ' + L.base.toFixed(3));
      for (const method of ['spectral', 'ai']) {
        await page.goto('/noise-reduction', 1500);
        const res = await page.eval(`(async () => {
          const f = new File([await (await fetch('/__${L.name}.wav')).blob()], 'noisy.wav', { type: 'audio/wav' });
          const dt = new DataTransfer(); dt.items.add(f);
          const inp = document.querySelector('#fileInput'); inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true }));
          document.querySelector('#method').value = '${method}';
          document.querySelector('#strength').value = 'strong';
          document.querySelector('#outFmt').value = 'wav32f';
          let got = null; const o = CV.downloadBlob; CV.downloadBlob = (b) => { got = b; };
          const t0 = performance.now();
          document.querySelector('#convertBtn').click();
          for (let i = 0; i < 1200 && !got && !/Could not/.test(document.querySelector('#status').textContent); i++) await new Promise((r) => setTimeout(r, 100));
          CV.downloadBlob = o;
          if (!got) return { err: document.querySelector('#status').textContent };
          const ab = await AudioSaw.decodeToAudioBuffer(new File([got], 'o.wav'), null, { quiet: true });
          return { ms: performance.now() - t0, x: Array.from(ab.getChannelData(0)) };
        })()`, 600000);
        if (res.err) { ok(false, L.name + ' ' + method + ': ' + res.err); continue; }
        const y = Float32Array.from(res.x);
        let best = 0, bv = -Infinity;
        for (let lag = -441; lag <= 441; lag++) { let v = 0; for (let i = lead; i < n - 500; i += 3) if (speaking[i]) v += clean[i] * (y[i + lag] || 0); if (v > bv) { bv = v; best = lag; } }
        const corr = corrWith(y), drop = db(rmsOn(L.noisy, 0)) - db(rmsOn(y, 0));
        const line = L.name + ' ' + method + ': pauses ' + drop.toFixed(1) + ' dB quieter, speech correlation ' + corr.toFixed(3) + ', offset ' + (best / SR * 1000).toFixed(2) + ' ms, length ' + (y.length === n ? 'exact' : y.length + ' vs ' + n) + ', ' + (res.ms / 1000).toFixed(1) + ' s for ' + (n / SR).toFixed(1) + ' s';
        if (method === 'ai') {
          const speechOk = L.name === 'realistic' ? corr >= 0.85 : corr >= L.base + 0.3;
          ok(drop >= 15 && speechOk && Math.abs(best) <= SR / 1000 && y.length === n, line);
        } else console.log('       ' + line + ' (reported: the steady-noise method on unsteady noise)');
      }
    }
    // The same AI method from the editor's Process menu (ASEditFx denoiseAI):
    // same length, same place, so the clip does not move on the timeline.
    {
      const L = levels[0];
      await page.goto('/audio-editor', 1500);
      const res = await page.eval(`(async () => {
        const ab = await AudioSaw.decodeToAudioBuffer(new File([await (await fetch('/__${L.name}.wav')).blob()], 'n.wav'), null, { quiet: true });
        const out = await ASEditFx.apply('denoiseAI', ab, '1');
        return { x: Array.from(out.getChannelData(0)), note: out._note || '' };
      })()`, 600000);
      const y = Float32Array.from(res.x);
      let best = 0, bv = -Infinity;
      for (let lag = -441; lag <= 441; lag++) { let v = 0; for (let i = lead; i < n - 500; i += 3) if (speaking[i]) v += clean[i] * (y[i + lag] || 0); if (v > bv) { bv = v; best = lag; } }
      const corr = corrWith(y), drop = db(rmsOn(L.noisy, 0)) - db(rmsOn(y, 0));
      ok(drop >= 15 && corr >= 0.85 && Math.abs(best) <= SR / 1000 && y.length === n, 'editor Process > Remove noise (AI): pauses ' + drop.toFixed(1) + ' dB quieter, speech correlation ' + corr.toFixed(3) + ', offset ' + (best / SR * 1000).toFixed(2) + ' ms, length ' + (y.length === n ? 'exact' : y.length));
    }
    if (page.logs.length) console.log('    console: ' + page.logs.slice(0, 4).join(' | '));
  });
}

main().catch((e) => ok(false, e.stack || e)).then(() => {
  if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
  console.log('\ncheck-denoise: all good');
});
