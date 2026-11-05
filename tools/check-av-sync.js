#!/usr/bin/env node
/*
 * Checks /fix-audio-sync (js/av-sync.js + js/sync-page.js).
 *
 * Node:
 *   - shift(): clicks land exactly where the setting puts them, late and
 *     early, the output is exactly the asked length, and a drift setting
 *     puts the first and last click on their marks (within one sample);
 *   - align(): a `say` voice recorded "twice", once as a dull, noisy camera
 *     track and once as a clean separate microphone that started earlier and
 *     whose clock runs 50 ppm slow, over three minutes. The start offset and
 *     the drift must both come out within 1 ms. Two unrelated recordings must
 *     be refused (confidence under the page's 1.5).
 *
 * Browser (ffmpeg core from the cache): a 25 fps test video whose sound is
 * 120 ms late, fixed through the real page, must come back with the sound in
 * place (GCC against the original within 1 ms), the picture byte-identical
 * (ffmpeg md5 of the copied packets) and the same length. Then the same
 * video with a separate recording, lined up by the page.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const S = require('../js/av-sync.js');

let failed = 0;
const ok = (c, m) => { console.log((c ? '  ok  ' : '  FAIL ') + m); if (!c) failed++; };
const R = 48000;

console.log('shift');
{
  const len = 10 * R, x = new Float32Array(len);
  [1, 3.5, 7, 9.5].forEach((t) => { x[Math.round(t * R)] = 0.9; });
  const hits = (y) => { const h = []; for (let i = 0; i < y.length; i++) if (Math.abs(y[i]) > 0.45 && (!h.length || i - h[h.length - 1] > 100)) h.push(i); return h; };
  const late = hits(S.shift([x], R, { late: 0.12, length: len })[0]);
  ok(late.length === 4 && late.every((h, k) => h === Math.round([1, 3.5, 7, 9.5][k] * R) - Math.round(0.12 * R)), 'late by 120 ms: every click 5760 samples earlier');
  const early = S.shift([x], R, { late: -0.6, length: len })[0], he = hits(early);
  ok(early.length === len && he.length === 3 && he[0] === R + 28800, 'early by 600 ms: clicks 28800 samples later, the one pushed past the end gone, length exact');
  const d = S.shift([x], R, { late: 0.1, lateEnd: 0.4, length: len, resample: require('../js/resample.js') })[0], hd = hits(d);
  // Click at t heard at t + 0.1 + 0.3 t / 10, so it goes to t' with t' + 0.1 + 0.03 t' = t.
  const want = [1, 3.5, 7, 9.5].map((t) => (t - 0.1) / 1.03 * R).filter((s) => s < len);
  const err = Math.max.apply(null, want.map((w, k) => Math.abs((hd[k] || 0) - w)));
  ok(hd.length === want.length && err <= 1, 'drift 100 -> 400 ms over 10 s: each click on its mark (worst ' + err.toFixed(2) + ' samples)');
  const n = new Float32Array(len).fill(0.5);
  const cut = S.shift([n], R, { late: 0.05, length: len })[0];
  ok(cut[0] === 0 && Math.abs(cut[120] - 0.25) < 0.01 && cut[len - 1] === 0, 'a cut into sound fades in 5 ms; the silence it leaves at the end is silence');
}

function sayVoice(dir, voice, text) {
  const a = path.join(dir, voice + '.aiff'), b = path.join(dir, voice + '.raw');
  execFileSync('say', ['-v', voice, '-o', a, text]);
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', a, '-ar', String(R), '-ac', '1', '-f', 'f32le', b]);
  const buf = fs.readFileSync(b);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4).slice();
}
const TEXT = 'The committee met on Tuesday to discuss the harbour project. Funding was approved for the first phase, which covers dredging the northern channel and repairing the old sea wall. ' +
  'Several residents spoke about the noise from night work, and the contractor agreed to stop at ten each evening. The second phase, a new ferry terminal, will be put to a public vote in the spring. ' +
  'In other business, the library will open on Sundays from March, the football pitches behind the school are to be drained, and a new crossing will be painted outside the bakery on Mill Street. ' +
  'Questions about the budget went on for some time. The treasurer explained that the reserves would cover the shortfall for two years, after which either the rates would rise or the ferry would need a private partner. ';

function rnd(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; }; }

// A "camera" track (dull, noisy, a little room) and a "mic" track of the same
// speech, which starts `lead` seconds earlier and runs (1 + ppm) slow.
function pair(speech, seconds, lead, ppm, seed) {
  const r = rnd(seed), n = Math.round(seconds * R), cam = new Float32Array(n);
  const src = (i) => speech[((i % speech.length) + speech.length) % speech.length];
  let lp = 0, lp2 = 0;
  for (let i = 0; i < n; i++) {
    const s = src(i) + 0.3 * src(i - 1700);           // a reflection 35 ms later
    lp += 0.12 * (s - lp); lp2 += 0.12 * (lp - lp2);  // a dull camera mic
    cam[i] = 1.4 * lp2 + 0.03 * r();
  }
  const m = Math.round((seconds + lead + 5) * R), mic = new Float32Array(m);
  for (let i = 0; i < m; i++) {
    // mic time t = lead + (1 + ppm) * camera time.
    const tc = (i / R - lead) / (1 + ppm * 1e-6), j = tc * R, j0 = Math.floor(j);
    if (j0 >= 0) mic[i] = src(j0) + (src(j0 + 1) - src(j0)) * (j - j0) + 0.003 * r();
  }
  return { cam, mic };
}

async function main() {
  let speech = null, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-sync-'));
  try {
    execFileSync('say', ['-v', '?'], { stdio: 'ignore' }); execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    // Four voices back to back: three minutes that never repeat, so there
    // is one right answer to find.
    const parts = ['Daniel', 'Samantha', 'Fred', 'Albert'].map((v) => sayVoice(dir, v, TEXT));
    speech = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    parts.reduce((o, p) => { speech.set(p, o); return o + p.length; }, 0);
  }
  catch (e) { console.log('  skip: align and page need say and ffmpeg'); return; }

  console.log('align');
  {
    console.log('       (' + (speech.length / R).toFixed(0) + ' s of speech)');
    const p = pair(speech, Math.min(240, speech.length / R - 10), 2.5, 50, 1);
    const t0 = Date.now(), al = S.align([p.cam], [p.mic], R, { maxLag: 30 });
    const wantEnd = 2.5 + p.cam.length / R * 50e-6;
    const e0 = Math.abs(al.offset - 2.5) * 1000, e1 = Math.abs(al.offsetEnd - wantEnd) * 1000;
    ok(e0 < 1 && e1 < 1, 'a separate mic 2.5 s ahead, 50 ppm slow, ' + (p.cam.length / R).toFixed(0) + ' s: start ' + al.offset.toFixed(5) + ' s (' + e0.toFixed(2) + ' ms off), end ' + al.offsetEnd.toFixed(5) + ' s (' + e1.toFixed(2) + ' ms off), ' + Math.round(al.drift * 1e6) + ' ppm, ' + (Date.now() - t0) + ' ms');
    const q = pair(speech, 60, -1.75, 0, 2), b = S.align([q.cam], [q.mic], R, { maxLag: 30 });
    ok(Math.abs(b.offset + 1.75) < 0.001 && b.drift === 0, 'a mic started 1.75 s late, one minute: ' + b.offset.toFixed(5) + ' s, no drift claimed');
    const other = sayVoice(dir, 'Samantha', 'Nothing in this recording matches the other one at all, it is a different talk entirely about gardening and the weather in late autumn. '.repeat(4));
    const c = S.align([p.cam.subarray(0, 60 * R)], [other], R, { maxLag: 30 });
    ok(c.confidence < 1.5, 'two unrelated recordings are refused (confidence ' + c.confidence.toFixed(2) + ', the page needs 1.5)');
    console.log('       (confidence on the real pairs: ' + al.confidence.toFixed(2) + ', ' + b.confidence.toFixed(2) + ')');
  }

  const { withPage, findChrome } = require('./chrome-harness');
  const CORE = path.join(os.homedir(), '.cache', 'audiosaw', 'ffmpeg-core-0.12.6.wasm');
  if (!findChrome() || !fs.existsSync(CORE)) { console.log('  skip: page (needs Chrome and the ffmpeg core in the cache)'); return; }
  console.log('page');
  // 30 s of speech, the sound 120 ms late against a 25 fps picture.
  const sp = speech.subarray(0, 30 * R), lateWav = path.join(dir, 'late.wav'), mp4 = path.join(dir, 'late.mp4');
  const delayed = new Float32Array(sp.length); delayed.set(sp.subarray(0, sp.length - 5760), 5760);
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'f32le', '-ar', String(R), '-ac', '1', '-i', '-', '-c:a', 'pcm_s16le', lateWav], { input: Buffer.from(delayed.buffer, delayed.byteOffset, delayed.byteLength) });
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=30', '-i', lateWav, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '256k', '-shortest', mp4]);
  const b64 = (f) => fs.readFileSync(f).toString('base64');
  const md5 = (f) => execFileSync('ffmpeg', ['-loglevel', 'error', '-i', f, '-map', '0:v', '-c', 'copy', '-f', 'md5', '-']).toString().trim();
  const dur = (f, s) => +execFileSync('ffprobe', ['-v', 'error', '-select_streams', s, '-show_entries', 'stream=duration', '-of', 'csv=p=0', f]).toString().trim();
  const frames = (f) => +execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', f]).toString().trim();
  const audioOf = (f) => { const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', f, '-map', '0:a:0', '-ar', String(R), '-ac', '1', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 }); return new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4).slice(); };
  // Where the speech sits in a file's sound, against the clean original.
  const lagMs = (y) => { const g = S.gcc(Float64Array.from(sp.subarray(2 * R, 12 * R)), Float64Array.from(y.subarray(2 * R - 9600, 12 * R + 9600)), 20000); return (g.lag - 9600) / R * 1000; };

  const routes = { '/__core.wasm': () => fs.readFileSync(CORE) };
  await withPage({ routes }, async (page) => {
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*ffmpeg-core.wasm*' }] });
    page.listen('Fetch.requestPaused', (p) => page.send('Fetch.continueRequest', { requestId: p.requestId, url: page.url('/__core.wasm') }));
    await page.goto('/fix-audio-sync', 1500);
    const drive = (files, set, find) => page.eval(`(async () => {
      const mk = (b64, name, type) => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new File([u], name, { type }); };
      const fs = ${JSON.stringify(files)}.map((f) => mk(f[0], f[1], f[2]));
      await window.__sync.use(fs[0], fs[1]);
      window.__sync.set(${JSON.stringify(set)});
      ${find ? 'await window.__sync.find();' : ''}
      let out = null, name = null; const orig = CV.downloadBlob; CV.downloadBlob = (b, n) => { out = b; name = n; };
      await window.__sync.run();
      CV.downloadBlob = orig;
      if (!out) return { err: document.getElementById('status').textContent };
      const ab = new Uint8Array(await out.arrayBuffer()); let s = ''; for (let i = 0; i < ab.length; i += 0x8000) s += String.fromCharCode.apply(null, ab.subarray(i, i + 0x8000));
      return { name, b64: btoa(s), found: (document.getElementById('found') || {}).textContent || '' };
    })()`, 900000);
    const before = lagMs(audioOf(mp4));
    const r = await drive([[b64(mp4), 'late.mp4', 'video/mp4']], { mode: 'shift', late: 0.12 });
    if (r.err) ok(false, 'shift: ' + r.err);
    else {
      const out = path.join(dir, 'fixed.mp4'); fs.writeFileSync(out, Buffer.from(r.b64, 'base64'));
      const after = lagMs(audioOf(out));
      ok(Math.abs(after) < 1, 'sound 120 ms late fixed: the speech was ' + before.toFixed(1) + ' ms late (the AAC encode included), now ' + after.toFixed(2) + ' ms (' + r.name + ')');
      ok(md5(out) === md5(mp4) && frames(out) === frames(mp4) && Math.abs(dur(out, 'v:0') - dur(mp4, 'v:0')) < 0.001,
        'picture byte-identical, ' + frames(out) + ' frames, ' + dur(out, 'v:0').toFixed(2) + ' s; sound ' + dur(out, 'a:0').toFixed(3) + ' s');
    }
    // A separate "mic" 1.2 s ahead of the camera, for the same 30 s video.
    const pr = pair(speech, 30, 1.2, 0, 5), micWav = path.join(dir, 'mic.wav'), camWav = path.join(dir, 'cam.wav'), camMp4 = path.join(dir, 'cam.mp4');
    const w = (x, f) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'f32le', '-ar', String(R), '-ac', '1', '-i', '-', '-c:a', 'pcm_s16le', f], { input: Buffer.from(x.buffer, x.byteOffset, x.byteLength) });
    w(pr.mic, micWav); w(pr.cam, camWav);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=30', '-i', camWav, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', camMp4]);
    const r2 = await drive([[b64(camMp4), 'cam.mp4', 'video/mp4'], [b64(micWav), 'mic.wav', 'audio/wav']], { mode: 'rec' }, true);
    if (r2.err) ok(false, 'separate recording: ' + r2.err);
    else {
      const out = path.join(dir, 'rec.mp4'); fs.writeFileSync(out, Buffer.from(r2.b64, 'base64'));
      const lag = lagMs(audioOf(out));
      ok(Math.abs(lag) < 1 && md5(out) === md5(camMp4), 'separate recording lined up: ' + lag.toFixed(2) + ' ms from the picture, picture byte-identical ("' + r2.found + '")');
    }
    const errs = page.logs.filter((l) => !/scriptwrapper|ERR_CONNECTION_REFUSED|favicon/.test(l));
    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ').slice(0, 300) : ''));
  });
}

main().then(() => {
  if (failed) { console.log('\ncheck-av-sync: ' + failed + ' failed'); process.exit(1); }
  console.log('\ncheck-av-sync: all good');
}).catch((e) => { console.error(e); process.exit(1); });
