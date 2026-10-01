#!/usr/bin/env node
/*
 * Checks js/dub-plan.js, the timing behind /video-dubbing, in Node.
 *
 *   - Whisper fragments are joined into lines, but never across a pause or
 *     a sentence end, and never past 12 s;
 *   - a line that fits is read at 1x; one that does not is sped up just
 *     enough, never past 1.3x, and anything left over is reported, not cut;
 *   - the duck curve is exactly 1 away from the lines (the original is
 *     untouched there), at the requested depth under them, and ramps
 *     without a step;
 *   - mix() keeps the original's length and channel count.
 */
const D = require('../js/dub-plan.js');
let failed = 0;
function ok(c, m) { console.log((c ? '  ok  ' : '  FAIL ') + m); if (!c) failed++; }

const segs = [
  { text: ' So today we', start: 0.5, end: 1.4 },
  { text: 'are going to look', start: 1.5, end: 2.6 },
  { text: 'at bread.', start: 2.7, end: 3.4 },
  { text: 'First, the flour', start: 3.5, end: 4.8 },
  { text: 'goes in.', start: 6.0, end: 6.8 },
  { text: '', start: 7, end: 8 }
];
const lines = D.merge(segs);
ok(lines.length === 3 && lines[0].text === 'So today we are going to look at bread.' && lines[0].start === 0.5 && lines[0].end === 3.4,
  'fragments join into a line (' + JSON.stringify(lines.map((l) => l.text)) + ')');
ok(lines[1].text === 'First, the flour' && lines[2].text === 'goes in.', 'a sentence end and a 1.2 s pause both start a new line');
{
  const long = Array.from({ length: 10 }, (_, i) => ({ text: 'word' + i, start: i * 1.5, end: i * 1.5 + 1.4 }));
  ok(D.merge(long).every((l) => l.end - l.start <= 12), 'no line longer than 12 s');
}
{
  const L = [{ start: 1, end: 3 }, { start: 4, end: 5 }];
  const a = D.fit(L, 0, 2.5, 10);
  ok(a.speed === 1 && a.overflow === 0, 'a line that fits its slot is read at 1x');
  const b = D.fit(L, 0, 3.6, 10);
  ok(b.speed > 1 && b.speed < 1.3 && b.overflow === 0 && Math.abs(b.seconds - b.slot / 1.02) < 1e-9, 'a slightly long line is sped up just enough (' + b.speed.toFixed(3) + 'x)');
  const c = D.fit(L, 0, 6, 10);
  ok(c.speed === 1.3 && c.overflow > 0, 'a much longer line stops at 1.3x and reports ' + c.overflow.toFixed(2) + ' s over');
  const d = D.fit(L, 1, 1, 5.2);
  ok(Math.abs(d.slot - 1.15) < 1e-9, 'the last line\'s slot stops at the end of the video (' + d.slot.toFixed(2) + ' s)');
}
{
  const rate = 1000, n = 5000;
  const g = D.duck(n, rate, [{ start: 1, seconds: 1 }, { start: 3.5, seconds: 0.5 }], 18, 0.1);
  const low = Math.pow(10, -18 / 20);
  ok(g[0] === 1 && g[899] === 1 && g[2101] === 1 && g[4999] === 1, 'gain is exactly 1 away from the lines');
  ok(Math.abs(g[1500] - low) < 1e-6 && Math.abs(g[3700] - low) < 1e-6, 'gain is -18 dB under a line');
  let step = 0; for (let i = 1; i < n; i++) step = Math.max(step, Math.abs(g[i] - g[i - 1]));
  ok(step < 0.02, 'ramps have no step (largest change per ms ' + step.toFixed(4) + ')');
}
{
  const o = [new Float32Array(100).fill(0.5), new Float32Array(100).fill(-0.5)];
  const m = D.mix(o, new Float32Array(100).fill(0.5), new Float32Array(60).fill(0.1));
  ok(m.length === 2 && m[0].length === 100 && Math.abs(m[0][10] - 0.35) < 1e-6 && Math.abs(m[1][80] + 0.25) < 1e-6, 'mix keeps length and channels and adds the dub to each');
}
// The page end to end, with DUBBING_BROWSER=1: a 9 s test video (a blue
// frame and a sentence from macOS `say`), Whisper base from the local mirror
// (model-mirror.js, fetched once), Kokoro q8 and the ffmpeg core from
// ~/.cache/audiosaw. The output is read back with ffprobe: the video stream
// must be copied (same codec, size and frame count), the length kept, and
// each line placed at its phrase's start.
async function browser() {
  if (!process.env.DUBBING_BROWSER) { console.log('  skip: page test (DUBBING_BROWSER=1 runs it)'); return; }
  const fs = require('fs'), os = require('os'), path = require('path');
  const { execFileSync } = require('child_process');
  const { withPage } = require('./chrome-harness');
  const cache = path.join(os.homedir(), '.cache', 'audiosaw');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-dub-'));
  execFileSync('say', ['-o', path.join(dir, 's.aiff'), 'Welcome to the kitchen. Today we are making fresh bread. First, mix the flour with warm water.']);
  const vid = path.join(dir, 'in.mp4');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=25:d=10', '-i', path.join(dir, 's.aiff'),
    '-filter_complex', '[1:a]adelay=1000|1000,apad=whole_dur=10[a]', '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-t', '10', vid]);
  const probe = (f) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-count_frames', '-of', 'json', f], { encoding: 'utf8' }));
  const before = probe(vid);
  const mirror = require('./model-mirror');
  mirror.fetch('onnx-community/whisper-base', mirror.WHISPER_BASE);
  await withPage({
    headers: true,
    routes: Object.assign(mirror.routes(['onnx-community/whisper-base']), {
      '/__in.mp4': () => fs.readFileSync(vid),
      '/__kokoro/model_quantized.onnx': () => fs.readFileSync(path.join(cache, 'kokoro', 'model_quantized.onnx')),
      '/__kokoro/am_michael.bin': () => fs.readFileSync(path.join(cache, 'kokoro', 'am_michael.bin')),
      '/__core.wasm': () => fs.readFileSync(path.join(cache, 'ffmpeg-core-0.12.6.wasm'))
    })
  }, async (page) => {
    page.listen('Fetch.requestPaused', (p) => {
      const u = p.request.url;
      const wb = /onnx-community\/whisper-base\/resolve\/[^/]+\/([^?]+)/.exec(u);
      const to = wb ? '/__hf/onnx-community/whisper-base/' + wb[1] : /ffmpeg-core\.wasm/.test(u) ? '/__core.wasm' : '/__kokoro/' + u.split('?')[0].split('/').pop();
      page.send('Fetch.continueRequest', { requestId: p.requestId, url: page.url(to) });
    });
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*huggingface.co/onnx-community/Kokoro*' }, { urlPattern: '*unpkg.com*ffmpeg-core.wasm*' }, { urlPattern: '*huggingface.co/onnx-community/whisper-base/*' }] });
    await page.goto('/video-dubbing?backend=wasm', 1500);
    const r = await page.eval(`(async () => {
      const f = new File([await (await fetch('/__in.mp4')).blob()], 'kitchen.mp4', { type: 'video/mp4' });
      const dt = new DataTransfer(); dt.items.add(f);
      const inp = document.querySelector('#fileInput'); inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#task').value = 'transcribe';
      document.querySelector('#language').value = 'en';
      document.querySelector('#voice').value = 'am_michael';
      await window.__dubPage.transcribe();
      const n = window.__dubPage.state().lines;
      if (!n) return { err: 'transcribe: ' + document.querySelector('#status').textContent };
      await window.__dubPage.dub();
      const d = window.__dub;
      if (!d || !d.outputs.video) return { err: 'dub: ' + document.querySelector('#status').textContent };
      const u = new Uint8Array(await d.outputs.video.arrayBuffer());
      let bin = ''; for (let i = 0; i < u.length; i += 8192) bin += String.fromCharCode.apply(null, u.subarray(i, i + 8192));
      return { b64: btoa(bin), lines: d.lines, placed: d.placed, srt: d.outputs.srt };
    })()`, 1800000);
    ok(!r.err, 'the page transcribes and dubs a video' + (r.err ? ' — ' + r.err : ': ' + JSON.stringify(r.lines.map((l) => l.text))));
    if (r.err) return;
    const words = r.lines.map((l) => l.text).join(' ').toLowerCase();
    ok(['kitchen', 'bread', 'flour'].every((w) => words.includes(w)), 'Whisper heard the sentence');
    const out = path.join(dir, 'out.mp4');
    fs.writeFileSync(out, Buffer.from(r.b64, 'base64'));
    const after = probe(out);
    const vb = before.streams.find((s) => s.codec_type === 'video'), va = after.streams.find((s) => s.codec_type === 'video');
    ok(va && va.codec_name === vb.codec_name && va.width === vb.width && va.nb_read_frames === vb.nb_read_frames, 'the video stream is copied (' + (va && va.codec_name) + ', ' + (va && va.nb_read_frames) + ' frames)');
    ok(after.streams.some((s) => s.codec_type === 'audio' && s.codec_name === 'aac'), 'the new soundtrack is AAC');
    ok(Math.abs(parseFloat(after.format.duration) - parseFloat(before.format.duration)) < 0.2, 'length kept (' + parseFloat(after.format.duration).toFixed(2) + ' s)');
    ok(r.placed.every((p, i) => Math.abs(p.start - r.lines[i].start) < 1e-6) && r.placed[0].start > 0.8 && r.placed[0].start < 1.4, 'each line starts at its phrase (first at ' + r.placed[0].start.toFixed(2) + ' s; speech began at 1.0)');
    ok(/^1\n00:00:0\d,\d{3} --> /.test(r.srt), 'English SRT written');
    if (page.logs.length) console.log('    console: ' + page.logs.slice(0, 4).join(' | '));
  });
}

browser().catch((e) => ok(false, 'page test: ' + (e.stack || e))).then(() => {
  if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
  console.log('\ncheck-dubbing: all good');
});
