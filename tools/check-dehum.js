#!/usr/bin/env node
/*
 * Checks /hum-remover (js/dehum.js + js/dehum-page.js).
 *
 * Fixture: a minute of `say` speech under mains hum at -30 dBFS with eight
 * harmonics (odd ones strong, as from a rectifier), off its nominal frequency
 * (59.97 and 50.04 Hz) and wandering +-0.03 Hz over 40 s, as the grid does.
 * The removal is linear, so the hum and the speech are measured separately
 * through the same filter (the track is measured on the mix).
 *   - the mains is named right and the fundamental measured within 0.02 Hz;
 *   - the hum comes down at least 40 dB;
 *   - the speech level moves by at most 0.3 dB, and what the filter took out
 *     of it is at least 18 dB under it (under 1.6% of its energy: the notches
 *     are each well under 2 Hz wide);
 *   - clean speech with no hum is not called hum;
 *   - the length is exact.
 * Browser: the real page on a WAV (float out) and on a video (the picture
 * byte-identical), the hum measured on the result.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const H = require('../js/dehum.js');

let failed = 0;
const ok = (c, m) => { console.log((c ? '  ok  ' : '  FAIL ') + m); if (!c) failed++; };
const R = 48000;
const db = (a, b) => 20 * Math.log10(a / b);
const rms = (x, a, b) => { a = a || 0; b = b || x.length; let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / (b - a)); };

function hum(n, f, seed) {
  const x = new Float32Array(n), amps = [1, 0.35, 0.8, 0.2, 0.5, 0.12, 0.3, 0.08];
  let ph = 0, norm = 0;
  amps.forEach((a) => { norm += a * a / 2; });
  const g = Math.pow(10, -30 / 20) / Math.sqrt(norm);
  for (let i = 0; i < n; i++) {
    ph += 2 * Math.PI * (f + 0.03 * Math.sin(2 * Math.PI * i / R / 40 + seed)) / R;
    let v = 0; for (let k = 0; k < 8; k++) v += amps[k] * Math.sin((k + 1) * ph + k * 0.7);
    x[i] = g * v;
  }
  return x;
}

function sayVoice(dir, voice, text) {
  const a = path.join(dir, voice + '.aiff'), b = path.join(dir, voice + '.raw');
  execFileSync('say', ['-v', voice, '-o', a, text]);
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', a, '-ar', String(R), '-ac', '1', '-f', 'f32le', b]);
  const buf = fs.readFileSync(b);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4).slice();
}
const TEXT = 'Good evening, and welcome to the show. Tonight we are talking about the old radio sets in the attic, the ones with the glowing valves and the hum that never quite went away. ' +
  'My grandfather built his own amplifier in nineteen fifty eight, and he swore the buzz was the sound of the mains itself, sixty cycles a second, coming through the walls. ' +
  'He was right, of course. A ground loop, a cheap power supply, a guitar pickup too close to a transformer, and there it is under everything you record. ';

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-dehum-'));
  let speech;
  try {
    const a = sayVoice(dir, 'Daniel', TEXT), b = sayVoice(dir, 'Samantha', TEXT);
    speech = new Float32Array(a.length + b.length); speech.set(a); speech.set(b, a.length);
    // Speech peaking near -6 dBFS.
    let pk = 0; for (const v of speech) pk = Math.max(pk, Math.abs(v));
    for (let i = 0; i < speech.length; i++) speech[i] *= 0.5 / pk;
  } catch (e) { console.log('  skip: needs say and ffmpeg'); return; }
  const n = Math.min(speech.length, 60 * R);
  speech = speech.subarray(0, n);
  console.log('core (' + (n / R).toFixed(0) + ' s of speech)');
  for (const [f, mains] of [[59.97, 60], [50.04, 50]]) {
    const h = hum(n, f, mains), mix = new Float32Array(n);
    for (let i = 0; i < n; i++) mix[i] = speech[i] + h[i];
    const t0 = Date.now(), d = H.detect([mix], R), tr = H.track([mix], R, d.f0);
    ok(d.found && d.mains === mains && Math.abs(d.f0 - f) < 0.02, mains + ' Hz: found ' + d.mains + ' Hz mains at ' + d.f0.toFixed(3) + ' Hz (true mean ' + f + '), ' + d.strong + ' harmonics stand out');
    const [oh] = await H.remove([h], R, { f0: d.f0, track: tr, strength: 'hum', sync: true });
    const [os2] = await H.remove([speech], R, { f0: d.f0, track: tr, strength: 'hum', sync: true });
    const down = db(rms(oh), rms(h));
    const diff = new Float32Array(n); for (let i = 0; i < n; i++) diff[i] = os2[i] - speech[i];
    const lv = db(rms(os2), rms(speech)), taken = db(rms(diff), rms(speech));
    ok(down <= -40, '  the hum is ' + down.toFixed(1) + ' dB down (needs 40)');
    ok(Math.abs(lv) <= 0.3 && taken <= -18, '  the speech moved ' + lv.toFixed(2) + ' dB; what the notches took from it is ' + taken.toFixed(1) + ' dB under it');
    ok(oh.length === n && os2.length === n, '  length exact (' + n + ' samples), ' + (Date.now() - t0) + ' ms for detection, track and two passes');
    const [ob] = await H.remove([h], R, { f0: d.f0, track: tr, strength: 'buzz', sync: true });
    console.log('       (buzz setting, up to 4 kHz: ' + db(rms(ob), rms(h)).toFixed(1) + ' dB, ' + H.harmonicsFor(d.f0, R, 'buzz').length + ' notches)');
  }
  const clean = H.detect([speech], R);
  ok(!clean.found, 'clean speech is not called hum (' + clean.strong + ' harmonics over 10 dB, needs 2)');

  const { withPage, findChrome } = require('./chrome-harness');
  if (!findChrome()) { console.log('  skip: page (no Chrome)'); return; }
  console.log('page');
  const CORE = path.join(os.homedir(), '.cache', 'audiosaw', 'ffmpeg-core-0.12.6.wasm');
  const hn = Math.min(n, 30 * R), h = hum(hn, 59.97, 60), mix = new Float32Array(hn);
  for (let i = 0; i < hn; i++) mix[i] = speech[i] + h[i];
  const wav = path.join(dir, 'hum.wav');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'f32le', '-ar', String(R), '-ac', '1', '-i', '-', '-c:a', 'pcm_f32le', wav], { input: Buffer.from(mix.buffer) });
  const routes = fs.existsSync(CORE) ? { '/__core.wasm': () => fs.readFileSync(CORE) } : {};
  await withPage({ routes }, async (page) => {
    if (fs.existsSync(CORE)) {
      await page.send('Fetch.enable', { patterns: [{ urlPattern: '*ffmpeg-core.wasm*' }] });
      page.listen('Fetch.requestPaused', (p) => page.send('Fetch.continueRequest', { requestId: p.requestId, url: page.url('/__core.wasm') }));
    }
    await page.goto('/hum-remover', 1500);
    const drive = (file, name, type, fmt) => page.eval(`(async () => {
      const bin = atob('${fs.readFileSync(file).toString('base64')}'); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const dt = new DataTransfer(); dt.items.add(new File([u], '${name}', { type: '${type}' }));
      const input = document.getElementById('fileInput'); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('outFmt').value = '${fmt}';
      let out = null, oname = null; const orig = CV.downloadBlob; CV.downloadBlob = (b, n) => { out = b; oname = n; };
      document.getElementById('convertBtn').click();
      for (let i = 0; i < 1200 && !out && !/error/.test(document.getElementById('status').className); i++) await new Promise((r) => setTimeout(r, 250));
      CV.downloadBlob = orig;
      const report = document.getElementById('rFound') ? document.getElementById('rFound').textContent : '';
      document.getElementById('resetBtn').click();
      if (!out) return { err: document.getElementById('status').textContent };
      const ab = new Uint8Array(await out.arrayBuffer()); let s = ''; for (let i = 0; i < ab.length; i += 0x8000) s += String.fromCharCode.apply(null, ab.subarray(i, i + 0x8000));
      return { name: oname, b64: btoa(s), report };
    })()`, 600000);
    const r = await drive(wav, 'hum.wav', 'audio/wav', 'wav32f');
    if (r.err) ok(false, 'page: ' + r.err);
    else {
      const out = path.join(dir, 'out.wav'); fs.writeFileSync(out, Buffer.from(r.b64, 'base64'));
      const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', out, '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
      const y = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
      // What is left of the hum: the output minus the speech through the same notches.
      const d = H.detect([mix], R), [sp] = await H.remove([speech.subarray(0, hn)], R, { f0: d.f0, track: H.track([mix], R, d.f0), sync: true });
      const left = new Float32Array(hn); for (let i = 0; i < hn; i++) left[i] = y[i] - sp[i];
      ok(y.length === hn && db(rms(left), rms(h)) <= -40, 'page: ' + r.name + ', ' + y.length + ' samples, hum ' + db(rms(left), rms(h)).toFixed(1) + ' dB down; report: "' + r.report + '"');
    }
    if (fs.existsSync(CORE)) {
      const mp4 = path.join(dir, 'v.mp4');
      execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=10', '-i', wav, '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '256k', mp4]);
      const v = await drive(mp4, 'v.mp4', 'video/mp4', 'mp3');
      if (v.err) ok(false, 'video: ' + v.err);
      else {
        const out = path.join(dir, 'out.mp4'); fs.writeFileSync(out, Buffer.from(v.b64, 'base64'));
        const md5 = (f) => execFileSync('ffmpeg', ['-loglevel', 'error', '-i', f, '-map', '0:v', '-c', 'copy', '-f', 'md5', '-']).toString().trim();
        const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', out, '-map', '0:a', '-ac', '1', '-ar', String(R), '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
        const y = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
        const g = (x, f) => Math.sqrt(H.goertzel(Float64Array.from(x.subarray(R, 9 * R)), f, R));
        const before = g(mix, 59.97 * 3), after = g(y, 59.97 * 3);
        ok(md5(out) === md5(mp4) && db(after, before) < -25, 'video: ' + v.name + ', picture byte-identical, the 180 Hz harmonic ' + db(after, before).toFixed(1) + ' dB down after AAC');
      }
    } else console.log('  skip: video (no ffmpeg core in the cache)');
    const errs = page.logs.filter((l) => !/scriptwrapper|ERR_CONNECTION_REFUSED|favicon/.test(l));
    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ').slice(0, 300) : ''));
  });
}

main().then(() => {
  if (failed) { console.log('\ncheck-dehum: ' + failed + ' failed'); process.exit(1); }
  console.log('\ncheck-dehum: all good');
}).catch((e) => { console.error(e); process.exit(1); });
