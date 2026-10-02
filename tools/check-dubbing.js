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
  const m = D.merge([{ text: 'So we', start: 0, end: 1, speaker: 1 }, { text: 'went home', start: 1.1, end: 2, speaker: 2 }]);
  ok(m.length === 2, 'fragments of different speakers are never joined into one line');
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
  const rate = 16000, x = new Float32Array(rate * 4);
  for (let i = 0; i < x.length; i++) x[i] = (i > rate * 1.0 && i < rate * 2.5 ? 0.3 * Math.sin(i * 0.1) : 0) + 0.001 * Math.sin(i * 7.3);
  const s = D.snapStarts([{ text: 'a', start: 0, end: 2.6 }, { text: 'b', start: 3.0, end: 3.5 }], x, rate);
  ok(Math.abs(s[0].start - 0.96) < 0.03 && s[1].start === 3.0, 'a line stamped from 0 moves to its speech (' + s[0].start.toFixed(2) + ' s); one with no speech stays');
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

// Same-language re-voicing in Spanish: a Spanish say voice, transcribed in
// Spanish, re-voiced by Kokoro's Spanish voice (through the full espeak-ng),
// and the dub's own soundtrack transcribed again: the words must survive.
async function browserEs() {
  if (!process.env.DUBBING_BROWSER) return;
  const fs = require('fs'), os = require('os'), path = require('path');
  const { execFileSync } = require('child_process');
  const { withPage } = require('./chrome-harness');
  const mirror = require('./model-mirror');
  const cache = path.join(os.homedir(), '.cache', 'audiosaw');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-dub-es-'));
  const SENT = 'El tren de las ocho llega tarde a la estación. Mi hermana trabaja en el hospital.';
  execFileSync('say', ['-v', 'Eddy (Spanish (Spain))', '-o', path.join(dir, 's.aiff'), SENT]);
  const vid = path.join(dir, 'in.mp4');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=green:s=320x240:r=25:d=9', '-i', path.join(dir, 's.aiff'),
    '-filter_complex', '[1:a]adelay=800|800,apad=whole_dur=9[a]', '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-t', '9', vid]);
  await withPage({
    headers: true,
    routes: Object.assign(mirror.routes(['onnx-community/whisper-base']), {
      '/__in.mp4': () => fs.readFileSync(vid),
      '/__kokoro/model_quantized.onnx': () => fs.readFileSync(path.join(cache, 'kokoro', 'model_quantized.onnx')),
      '/__kokoro/ef_dora.bin': () => fs.readFileSync(path.join(cache, 'kokoro', 'ef_dora.bin')),
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
      const f = new File([await (await fetch('/__in.mp4')).blob()], 'tren.mp4', { type: 'video/mp4' });
      const dt = new DataTransfer(); dt.items.add(f);
      const inp = document.querySelector('#fileInput'); inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#task').value = 'transcribe';
      document.querySelector('#language').value = 'es';
      document.querySelector('#voice').value = 'ef_dora';
      await window.__dubPage.transcribe();
      if (!window.__dubPage.state().lines) return { err: 'transcribe: ' + document.querySelector('#status').textContent };
      await window.__dubPage.dub();
      const d = window.__dub;
      if (!d || !d.outputs.audio) return { err: 'dub: ' + document.querySelector('#status').textContent };
      const ab = await AudioSaw.decodeToAudioBuffer(new File([d.outputs.audio], 'dub.mp3'), null, { quiet: true });
      const mono = ab.numberOfChannels > 1 ? await AudioSaw.mixToMono(ab) : ab;
      const a = Float32Array.from((await AudioSaw.resampleBuffer(mono, 16000)).getChannelData(0));
      const w = new Worker('/js/transcribe-worker.js', { type: 'module' });
      const heard = await new Promise((res) => { w.onmessage = (e) => { if (e.data.type === 'done') res(e.data.text); if (e.data.type === 'error') res('ERR ' + e.data.message); };
        w.postMessage({ type: 'run', model: 'onnx-community/whisper-base', audio: a, language: 'es', task: 'transcribe' }, [a.buffer]); });
      return { lines: d.lines.map((l) => l.text), heard, video: !!d.outputs.video };
    })()`, 1800000);
    ok(!r.err, 'Spanish: transcribed and re-voiced' + (r.err ? ' — ' + r.err : ': ' + JSON.stringify(r.lines)));
    if (r.err) return;
    const norm = (t) => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const keys = ['tren', 'ocho', 'estacion', 'hermana', 'hospital'];
    const hit = keys.filter((k) => norm(r.heard).includes(k)).length;
    ok(hit >= 4 && r.video, 'Spanish: the Spanish dub says it back: "' + r.heard.trim() + '" (' + hit + '/' + keys.length + ' key words)');
  });
}

// Into Spanish: an English video, Whisper (translate → English), OPUS-MT
// into Spanish, Kokoro's Spanish voice; the dub transcribed in Spanish must
// carry the sentence's words. Needs the en-es model in the local mirror.
async function browserTo() {
  if (!process.env.DUBBING_BROWSER) return;
  const fs = require('fs'), os = require('os'), path = require('path');
  const { execFileSync } = require('child_process');
  const { withPage } = require('./chrome-harness');
  const mirror = require('./model-mirror');
  const ES = 'Xenova/opus-mt-en-es', WB = 'onnx-community/whisper-base';
  if (!mirror.has(ES, ['onnx/decoder_model_merged_quantized.onnx'])) { console.log('  skip: into Spanish (run check-translate with TRANSLATE_DOWNLOAD=1 first)'); return; }
  const cache = path.join(os.homedir(), '.cache', 'audiosaw');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-dub-to-'));
  execFileSync('say', ['-v', 'Daniel', '-o', path.join(dir, 's.aiff'), 'The train leaves the station at eight o\'clock. My sister works at the hospital.']);
  const vid = path.join(dir, 'in.mp4');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=purple:s=320x240:r=25:d=9', '-i', path.join(dir, 's.aiff'),
    '-filter_complex', '[1:a]adelay=800|800,apad=whole_dur=9[a]', '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-t', '9', vid]);
  await withPage({
    headers: true,
    routes: Object.assign(mirror.routes([WB, ES]), {
      '/__in.mp4': () => fs.readFileSync(vid),
      '/__kokoro/model_quantized.onnx': () => fs.readFileSync(path.join(cache, 'kokoro', 'model_quantized.onnx')),
      '/__kokoro/em_alex.bin': () => fs.readFileSync(path.join(cache, 'kokoro', 'em_alex.bin')),
      '/__core.wasm': () => fs.readFileSync(path.join(cache, 'ffmpeg-core-0.12.6.wasm'))
    })
  }, async (page) => {
    page.listen('Fetch.requestPaused', (p) => {
      const u = p.request.url;
      const hf = /huggingface\.co\/(onnx-community\/whisper-base|Xenova\/opus-mt-en-es)\/resolve\/[^/]+\/([^?]+)/.exec(u);
      const to = hf ? '/__hf/' + hf[1] + '/' + hf[2] : /ffmpeg-core\.wasm/.test(u) ? '/__core.wasm' : '/__kokoro/' + u.split('?')[0].split('/').pop();
      page.send('Fetch.continueRequest', { requestId: p.requestId, url: page.url(to) });
    });
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*huggingface.co/onnx-community/*' }, { urlPattern: '*huggingface.co/Xenova/*' }, { urlPattern: '*unpkg.com*ffmpeg-core.wasm*' }] });
    await page.goto('/video-dubbing?backend=wasm', 1500);
    const r = await page.eval(`(async () => {
      const f = new File([await (await fetch('/__in.mp4')).blob()], 'train.mp4', { type: 'video/mp4' });
      const dt = new DataTransfer(); dt.items.add(f);
      const inp = document.querySelector('#fileInput'); inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#task').value = 'to:es';
      document.querySelector('#language').value = 'en';
      await window.__dubPage.transcribe();
      if (!window.__dubPage.state().lines) return { err: 'transcribe: ' + document.querySelector('#status').textContent };
      const shown = Array.from(document.querySelectorAll('#lines .dub-en')).map((e) => e.textContent);
      const voice = document.querySelector('#voice').value;
      await window.__dubPage.dub();
      const d = window.__dub;
      if (!d || !d.outputs.audio) return { err: 'dub: ' + document.querySelector('#status').textContent };
      const ab = await AudioSaw.decodeToAudioBuffer(new File([d.outputs.audio], 'dub.mp3'), null, { quiet: true });
      const mono = ab.numberOfChannels > 1 ? await AudioSaw.mixToMono(ab) : ab;
      const a = Float32Array.from((await AudioSaw.resampleBuffer(mono, 16000)).getChannelData(0));
      const w = new Worker('/js/transcribe-worker.js', { type: 'module' });
      const heard = await new Promise((res) => { w.onmessage = (e) => { if (e.data.type === 'done') res(e.data.text); if (e.data.type === 'error') res('ERR ' + e.data.message); };
        w.postMessage({ type: 'run', model: 'onnx-community/whisper-base', audio: a, language: 'es', task: 'transcribe' }, [a.buffer]); });
      return { lines: d.lines.map((l) => l.text), shown, voice, heard, srt: d.outputs.srt, video: !!d.outputs.video };
    })()`, 1800000);
    ok(!r.err, 'into Spanish: transcribed and translated' + (r.err ? ' — ' + r.err : ': ' + JSON.stringify(r.lines)));
    if (r.err) return;
    ok(r.voice === 'em_alex' && r.shown.length === r.lines.length && /train/i.test(r.shown.join(' ')), 'the Spanish voice is picked and each line shows its English (' + JSON.stringify(r.shown) + ')');
    const norm = (t) => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    ok(/tren/.test(norm(r.srt)) && /hermana/.test(norm(r.srt)), 'the subtitles are in Spanish');
    const keys = ['tren', 'estacion', 'ocho', 'hermana', 'hospital'];
    const hit = keys.filter((k) => norm(r.heard).includes(k)).length;
    ok(hit >= 4 && r.video, 'into Spanish: the dub says it in Spanish: "' + r.heard.trim() + '" (' + hit + '/' + keys.length + ' key words)');
  });
}

// Two speakers, one voice each: a Daniel/Samantha conversation dubbed with
// "a different voice for each speaker" — two speakers found, voices
// alternating with them, and the man's lines lower than the woman's.
async function browserTwo() {
  if (!process.env.DUBBING_BROWSER) return;
  const fs = require('fs'), os = require('os'), path = require('path');
  const { execFileSync } = require('child_process');
  const { withPage } = require('./chrome-harness');
  const mirror = require('./model-mirror');
  require('../js/pitch-track.js');
  const cache = path.join(os.homedir(), '.cache', 'audiosaw');
  const SEG = 'onnx-community/pyannote-segmentation-3.0', EMB = 'onnx-community/wespeaker-voxceleb-resnet34-LM', WB = 'onnx-community/whisper-base';
  mirror.fetch(SEG, ['config.json', 'preprocessor_config.json', 'onnx/model.onnx'], '733a93b6473d019a773298e08cefa686894b1854');
  mirror.fetch(EMB, ['config.json', 'preprocessor_config.json', 'onnx/model.onnx'], '6a61a1833ff2583aabeba044f5c8221f00b67ceb');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-dub2-'));
  const said = [['Daniel', 'Good morning, thanks for coming in today.'], ['Samantha', 'Happy to be here, it has been a busy week.'], ['Daniel', 'Tell me about the new bridge.'], ['Samantha', 'We widened the footpath and added lights.']];
  const parts = [];
  said.forEach(([v, t], i) => { const f = path.join(dir, i + '.aiff'); execFileSync('say', ['-v', v, '-o', f, t]); parts.push(f); });
  const vid = path.join(dir, 'in.mp4');
  const inputs = [].concat(...parts.map((p) => ['-i', p]));
  const filt = parts.map((_, i) => '[' + (i + 1) + ':a]apad=pad_dur=0.6[a' + i + ']').join(';') + ';' + parts.map((_, i) => '[a' + i + ']').join('') + 'concat=n=' + parts.length + ':v=0:a=1,adelay=600|600[a]';
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=320x240:r=25:d=16'].concat(inputs, ['-filter_complex', filt, '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-shortest', vid]));
  await withPage({
    headers: true,
    routes: Object.assign(mirror.routes([WB, SEG, EMB]), {
      '/__in.mp4': () => fs.readFileSync(vid),
      '/__kokoro/model_quantized.onnx': () => fs.readFileSync(path.join(cache, 'kokoro', 'model_quantized.onnx')),
      '/__kokoro/am_michael.bin': () => fs.readFileSync(path.join(cache, 'kokoro', 'am_michael.bin')),
      '/__kokoro/af_heart.bin': () => fs.readFileSync(path.join(cache, 'kokoro', 'af_heart.bin')),
      '/__core.wasm': () => fs.readFileSync(path.join(cache, 'ffmpeg-core-0.12.6.wasm'))
    })
  }, async (page) => {
    page.listen('Fetch.requestPaused', (p) => {
      const u = p.request.url;
      const hf = /huggingface\.co\/(onnx-community\/(?:whisper-base|pyannote-segmentation-3\.0|wespeaker-voxceleb-resnet34-LM))\/resolve\/[^/]+\/([^?]+)/.exec(u);
      const to = hf ? '/__hf/' + hf[1] + '/' + hf[2] : /ffmpeg-core\.wasm/.test(u) ? '/__core.wasm' : '/__kokoro/' + u.split('?')[0].split('/').pop();
      page.send('Fetch.continueRequest', { requestId: p.requestId, url: page.url(to) });
    });
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*huggingface.co/onnx-community/*' }, { urlPattern: '*unpkg.com*ffmpeg-core.wasm*' }] });
    await page.goto('/video-dubbing?backend=wasm', 1500);
    const r = await page.eval(`(async () => {
      const f = new File([await (await fetch('/__in.mp4')).blob()], 'talk.mp4', { type: 'video/mp4' });
      const dt = new DataTransfer(); dt.items.add(f);
      const inp = document.querySelector('#fileInput'); inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#task').value = 'transcribe'; document.querySelector('#language').value = 'en';
      document.querySelector('#perSpeaker').checked = true;
      await window.__dubPage.transcribe();
      if (!window.__dubPage.state().lines) return { err: document.querySelector('#status').textContent };
      const boxes = document.querySelectorAll('#speakerVoices select').length;
      await window.__dubPage.dub();
      const d = window.__dub;
      if (!d || !d.outputs.audio) return { err: 'dub: ' + document.querySelector('#status').textContent };
      const ab = await AudioSaw.decodeToAudioBuffer(new File([d.outputs.audio], 'd.mp3'), null, { quiet: true });
      const ch = Array.from(ab.getChannelData(0));
      return { boxes, lines: d.lines, placed: d.placed, rate: ab.sampleRate, ch };
    })()`, 1800000);
    ok(!r.err, 'two speakers: transcribed, labelled and dubbed' + (r.err ? ' — ' + r.err : ''));
    if (r.err) return;
    const spk = [...new Set(r.lines.map((l) => l.speaker))];
    ok(spk.length === 2 && r.boxes === 2, 'two speakers found, with a voice picker each (' + JSON.stringify(r.lines.map((l) => l.speaker + ':' + l.voice)) + ')');
    const alt = r.lines.every((l, i) => i === 0 || l.speaker !== r.lines[i - 1].speaker);
    ok(alt && new Set(r.lines.map((l) => l.voice)).size === 2, 'the voices alternate with the speakers');
    const x = Float32Array.from(r.ch), f0 = (a, b) => { const fr = ASPitch.track(x.subarray(Math.floor(a * r.rate), Math.floor(b * r.rate)), r.rate, { minHz: 60, maxHz: 400 }).filter((q) => q.clarity > 0.8).map((q) => q.hz).sort((p, q) => p - q); return fr.length ? fr[fr.length >> 1] : 0; };
    const by = {}; r.placed.forEach((p, i) => { const v = r.lines[i].voice; (by[v] = by[v] || []).push(f0(p.start, p.start + p.seconds)); });
    const med = (a) => a.filter(Boolean).sort((p, q) => p - q)[a.length >> 1] || 0;
    ok(med(by.am_michael || []) > 0 && med(by.am_michael) < med(by.af_heart || []), 'the man\'s lines are lower than the woman\'s (' + med(by.am_michael || []).toFixed(0) + ' Hz vs ' + med(by.af_heart || []).toFixed(0) + ' Hz)');
  });
}

browser().then(browserEs).then(browserTo).then(browserTwo).catch((e) => ok(false, 'page test: ' + (e.stack || e))).then(() => {
  if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
  console.log('\ncheck-dubbing: all good');
});
