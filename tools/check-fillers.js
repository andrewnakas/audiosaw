#!/usr/bin/env node
/*
 * Checks /remove-filler-words (js/fillers.js + js/fillers-page.js).
 *
 * Node: ASFillers.cut removes exactly the ranges asked, with no click at a
 * join (no sample step larger than the input's own), and keeps stereo
 * channels cut at identical places.
 *
 * Browser (timestamped Whisper base from the local mirror, ffmpeg core from
 * the cache): three `say` voices speaking sentences with "um", "uh" and
 * "umm" laid at known times between the phrases, run through the real page.
 *   - found (ticked or offered) >= 8 of 9 fillers, ticked >= 6 of 9
 *     (measured 10 Oct: 8 and 6; Whisper folded one "uh" into the word
 *     before it, and heard two "umm"s as "bum", which the pitch test offers);
 *   - no find that is not a filler;
 *   - no cut reaches into a phrase (more than 20 ms of one);
 *   - the downloaded WAV is exactly as much shorter as the page said;
 *   - a video comes back with the picture cut to the sound's length.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const F = require('../js/fillers.js');

let failed = 0;
const ok = (c, m) => { console.log((c ? '  ok  ' : '  FAIL ') + m); if (!c) failed++; };

console.log('cut');
{
  const R = 48000, n = 3 * R;
  const L = new Float32Array(n), Rr = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = 0.4 * Math.sin(2 * Math.PI * 200 * i / R); Rr[i] = 0.3 * Math.sin(2 * Math.PI * 310 * i / R + 1); }
  const res = F.cut([L, Rr], R, [[0.5, 0.9], [2.0, 2.25]]);
  const want = n - Math.round(0.4 * R) - Math.round(0.25 * R) - 2 * Math.round(0.01 * R);
  ok(Math.abs(res.channels[0].length - want) <= 2 * Math.round(0.005 * R) + 2, 'removes the ranges asked (' + (res.removed).toFixed(3) + ' s, 0.65 s of ranges plus two 10 ms crossfades)');
  let inStep = 0, outStep = 0;
  for (let i = 1; i < n; i++) inStep = Math.max(inStep, Math.abs(L[i] - L[i - 1]));
  for (let i = 1; i < res.channels[0].length; i++) outStep = Math.max(outStep, Math.abs(res.channels[0][i] - res.channels[0][i - 1]));
  ok(outStep <= inStep * 1.5, 'no click at a join: an equal-power fade between two phases can reach √2 of a step, a click is the whole amplitude (largest step ' + outStep.toFixed(4) + ', the input\'s ' + inStep.toFixed(4) + ')');
  ok(res.channels[1].length === res.channels[0].length, 'both channels cut at the same places');
}

async function browser() {
  const { withPage, findChrome } = require('./chrome-harness');
  const mirror = require('./model-mirror'), M = 'onnx-community/whisper-base_timestamped';
  try { execFileSync('say', ['-v', '?'], { stdio: 'ignore' }); execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch (e) { console.log('  skip: needs say and ffmpeg'); return; }
  if (!findChrome() || !mirror.has(M, mirror.WHISPER_BASE)) { console.log('  skip: whisper-base_timestamped is not in the mirror'); return; }
  const CORE = path.join(os.homedir(), '.cache', 'audiosaw', 'ffmpeg-core-0.12.6.wasm');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-fill-'));
  const FILL = 'FILL', FILLS = ['um', 'uh', 'umm'];
  const script = [
    ['Samantha', ['So', FILL, 'I was thinking we could leave a little early', FILL, 'and get to the station before nine.', 'The tickets are', FILL, 'already on my phone.']],
    ['Daniel', ['Well', FILL, 'the results were better than we expected.', 'We had', FILL, 'about forty people sign up', FILL, 'in the first week.']],
    ['Karen', ['I think', FILL, 'the main problem is the schedule.', 'If we move the meeting to', FILL, 'Thursday', FILL, 'everyone can come.']]
  ];
  const R = 48000;
  function clip(voice, text, name) {
    const a = path.join(dir, name + '.aiff'), b = path.join(dir, name + '.raw');
    execFileSync('say', ['-v', voice, '-o', a, text]);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', a, '-af', 'silenceremove=start_periods=1:start_threshold=-45dB:stop_periods=-1:stop_threshold=-45dB:stop_duration=0.05,aresample=' + R, '-ac', '1', '-f', 'f32le', b]);
    const buf = fs.readFileSync(b);
    return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4).slice();
  }
  const cases = script.map(([voice, parts]) => {
    const pieces = [], fillers = [], phrases = []; let t = 0.5, fi = 0;
    parts.forEach((p, k) => {
      const isF = p === FILL, x = clip(voice, isF ? FILLS[fi++ % 3] : p, voice + k);
      (isF ? fillers : phrases).push([t, t + x.length / R]);
      pieces.push([Math.round(t * R), x]);
      t += x.length / R + 0.18;
    });
    const a = new Float32Array(Math.round((t + 0.5) * R));
    pieces.forEach(([o, x]) => a.set(x, o));
    const wav = path.join(dir, voice + '.wav');
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'f32le', '-ar', String(R), '-ac', '1', '-i', '-', '-c:a', 'pcm_s16le', wav], { input: Buffer.from(a.buffer) });
    return { voice, wav, fillers, phrases, length: a.length / R };
  });

  const routes = Object.assign(mirror.routes([M]), fs.existsSync(CORE) ? { '/__core.wasm': () => fs.readFileSync(CORE) } : {});
  let found = 0, ticked = 0, total = 0, wrong = 0, intrude = 0;
  await withPage({ routes }, async (page) => {
    await mirror.attach(page, [M]);
    if (fs.existsSync(CORE)) {
      page.listen('Fetch.requestPaused', (p) => { if (/ffmpeg-core\.wasm/.test(p.request.url)) page.send('Fetch.continueRequest', { requestId: p.requestId, url: page.url('/__core.wasm') }); });
    }
    await page.goto('/remove-filler-words', 1500);
    for (const c of cases) {
      const b64 = fs.readFileSync(c.wav).toString('base64');
      const r = await page.eval(`(async () => {
        const bin = atob('${b64}'); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        window.__fillers.use(new File([u], '${c.voice}.wav', { type: 'audio/wav' }));
        await window.__fillers.analyse();
        const finds = window.__fillers.finds().map((f) => ({ kind: f.kind, on: f.on, cut: f.cut, text: f.text }));
        let out = null; const orig = CV.downloadBlob; CV.downloadBlob = (b, n) => { out = { b, n }; };
        await window.__fillers.cut();
        CV.downloadBlob = orig;
        const status = document.querySelector('#status').textContent;
        if (!out) return { finds, err: status };
        const ab = await out.b.arrayBuffer();
        const buf = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(ab);
        return { finds, status, seconds: buf.length / buf.sampleRate, name: out.n };
      })()`, 900000);
      if (r.err && !r.finds.length) { ok(false, c.voice + ': ' + r.err); continue; }
      const fl = r.finds.filter((f) => f.kind !== 'pause');
      c.fillers.forEach(([a, b]) => {
        total++;
        const hit = fl.find((f) => f.cut[0] < b && f.cut[1] > a && (Math.min(b, f.cut[1]) - Math.max(a, f.cut[0])) / (b - a) > 0.7);
        if (hit) { found++; if (hit.on) ticked++; }
      });
      fl.forEach((f) => {
        if (!c.fillers.some(([a, b]) => f.cut[0] < b && f.cut[1] > a)) wrong++;
        c.phrases.forEach(([a, b]) => { if (Math.min(b, f.cut[1]) - Math.max(a, f.cut[0]) > 0.02) intrude++; });
      });
      const removed = r.finds.filter((f) => f.on).reduce((s, f) => s + f.cut[1] - f.cut[0], 0);
      ok(r.seconds && Math.abs((c.length - r.seconds) - removed) < 0.06,
        c.voice + ': the WAV is ' + (c.length - (r.seconds || 0)).toFixed(2) + ' s shorter (cuts ticked: ' + removed.toFixed(2) + ' s)');
    }
    ok(found >= 8 && ticked >= 6, 'fillers found ' + found + ' of ' + total + ', ticked ' + ticked);
    ok(wrong === 0, 'no find that is not a filler (' + wrong + ')');
    ok(intrude === 0, 'no cut reaches into a phrase (' + intrude + ')');

    if (fs.existsSync(CORE)) {
      const vid = path.join(dir, 'talk.mp4');
      execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25:duration=' + cases[0].length.toFixed(2),
        '-i', cases[0].wav, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', vid]);
      const b64 = fs.readFileSync(vid).toString('base64');
      const v = await page.eval(`(async () => {
        const bin = atob('${b64}'); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        window.__fillers.use(new File([u], 'talk.mp4', { type: 'video/mp4' }));
        await window.__fillers.analyse();
        let out = null; const orig = CV.downloadBlob; CV.downloadBlob = (b, n) => { out = { b, n }; };
        await window.__fillers.cut();
        CV.downloadBlob = orig;
        if (!out) return { err: document.querySelector('#status').textContent };
        const u8 = new Uint8Array(await out.b.arrayBuffer());
        let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
        return { b64: btoa(s), name: out.n };
      })()`, 900000);
      if (v.err) ok(false, 'video: ' + v.err);
      else {
        const out = path.join(dir, 'out.mp4');
        fs.writeFileSync(out, Buffer.from(v.b64, 'base64'));
        const d = (sel) => +execFileSync('ffprobe', ['-v', 'error', '-select_streams', sel, '-show_entries', 'stream=duration', '-of', 'csv=p=0', out]).toString().trim();
        const vd = d('v:0'), ad = d('a:0');
        ok(Math.abs(vd - ad) < 0.06 && vd < cases[0].length - 0.5, 'video: the picture cut with the sound (' + vd.toFixed(2) + ' s picture, ' + ad.toFixed(2) + ' s sound, from ' + cases[0].length.toFixed(2) + ' s)');
      }
    } else console.log('  skip: video (no ffmpeg core in the cache)');
    if (page.logs.length) console.log('    console: ' + page.logs.slice(0, 4).join(' | '));
  });
}

browser().then(() => {
  console.log(failed ? '\n' + failed + ' check(s) failed' : '\ncheck-fillers: all good');
  process.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
