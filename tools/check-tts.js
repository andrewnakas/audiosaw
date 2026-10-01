#!/usr/bin/env node
/*
 * Checks /text-to-speech: the pure engine in Node, then the real page in
 * headless Chrome on both backends.
 *
 *   node tools/check-tts.js
 *
 * The Kokoro files (326 MB fp32, 92 MB q8, a few 0.5 MB voices) are
 * downloaded once into ~/.cache/audiosaw/kokoro/ and served to the page by
 * rewriting its Hugging Face requests with CDP Fetch, the way check-fidelity
 * serves the ffmpeg core. TTS_OFFLINE=1 skips the browser part if they are
 * missing instead of downloading them.
 *
 * What it holds, and why each matters:
 *   - normalisation, chunking, tokenizer and mix maths (Node);
 *   - the ID3 and LIST/INFO tags the page writes parse back with readers
 *     written here, separately from the writers;
 *   - each backend speaks a fixed sentence: not silent, not clipped, and a
 *     plausible length for the words (a wrong tokenizer or style row gives
 *     mumbling of the wrong length, not an error);
 *   - speed 1.5 shortens the speech by about 1/1.5;
 *   - a two-voice mix differs from both voices and is still speech;
 *   - the page's quoted speeds, reported always and enforced with
 *     TTS_SPEED=1 (other work on the machine moves them 2-3x): WebGPU under 1.5x the speech's length ("about as
 *     long as the speech"), threaded CPU under 8x ("several times").
 *   TTS_BACKENDS=wasm runs one backend.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const T = require('../js/tts-engine.js');

let failed = 0;
function ok(cond, msg) {
  if (cond) console.log('  ok  ' + msg);
  else { console.log('  FAIL ' + msg); failed++; }
}

/* ------------------------------------------------------------------ Node */

console.log('engine');
ok(T.normalize('Dr. Lee paid $4.50 at 3:05.') === 'Doctor Lee paid 4 dollars and 50 cents at 3 oh 5.', 'normalises titles, money, times');
ok(T.normalize('In 1984 it cost £1.') === 'In 19 84 it cost 1 pound.', 'normalises years and pounds');
ok(T.normalize('pi is 3.14') === 'pi is 3 point 1 4', 'normalises decimals');
{
  const c = T.chunk('One. Two.\n\nThree four five? Six!');
  ok(c.length === 2 && c[0].text === 'One. Two.' && c[1].text === 'Three four five? Six!', 'packs sentences, breaks at paragraphs');
  ok(c[0].pause === 0.45, 'paragraph end gets the long pause');
}
{
  const long = Array.from({ length: 300 }, (_, i) => 'word' + i).join(' ') + '.';
  const c = T.chunk(long);
  ok(c.every((x) => x.text.length <= 380) && c.map((x) => x.text).join(' ') === long, 'long sentence split at <=380 chars with nothing lost');
  const clauses = Array.from({ length: 12 }, (_, i) => 'this is clause number ' + i + ' of a long sentence').join(', ') + '.';
  const c2 = T.chunk(clauses);
  ok(c2.length > 1 && c2.slice(0, -1).every((x) => /,$/.test(x.text)), 'long sentence breaks at commas first');
}
ok(T.chunk('Dr. Smith arrived. It was 3.5 km away.').length === 1, 'abbreviations and decimals do not end a sentence');
{
  const ids = T.tokenize('həlˈoʊ, wˈɜːld!');
  ok(ids[0] === 0 && ids[ids.length - 1] === 0 && ids.length === 17, 'tokenizer wraps in 0 and maps each phoneme');
  ok(T.tokenize('a\u0000b§c').length === 2 + 3, 'tokenizer drops characters outside the vocabulary');
  const big = T.tokenize('a'.repeat(2000));
  ok(big.length <= T.MAX_TOKENS + 2, 'tokenizer caps at 510 tokens');
}
{
  const a = new Float32Array(T.STYLE_ROWS * T.STYLE_DIM).map((_, i) => i % 7);
  const b = new Float32Array(T.STYLE_ROWS * T.STYLE_DIM).map((_, i) => -(i % 5));
  ok(T.mixTables([a, b], [1, 0]) === a, 'a mix with one live voice is that voice, untouched');
  const m = T.mixTables([a, b], [3, 1]);
  ok(Math.abs(m[10] - (a[10] * 0.75 + b[10] * 0.25)) < 1e-6, 'weights are normalised');
  const r = T.styleRow(a, 12);
  ok(r.length === 256 && r[0] === a[10 * 256], 'style row is n-2');
  ok(T.styleRow(a, 5000)[0] === a[509 * 256], 'style row clamps at 509');
  ok(T.formatMix(T.parseMix('af_bella:2, am_michael ,nope:3')) === 'af_bella:2,am_michael', 'mix strings round-trip and drop unknown voices');
}
{
  // ID3v2.3, read back independently.
  const mp3 = T.tagMp3(new Uint8Array([0xFF, 0xFB, 0x90, 0x00]), { title: 'Héllo', artist: 'AI voice: Heart', software: 'x', comment: 'Synthetic speech' });
  const s = String.fromCharCode(...mp3.slice(0, 3));
  const size = (mp3[6] << 21) | (mp3[7] << 14) | (mp3[8] << 7) | mp3[9];
  const frames = {};
  for (let p = 10; p < 10 + size;) {
    const id = String.fromCharCode(...mp3.slice(p, p + 4));
    const n = (mp3[p + 4] << 24) | (mp3[p + 5] << 16) | (mp3[p + 6] << 8) | mp3[p + 7];
    let body = mp3.slice(p + 10, p + 10 + n);
    if (id === 'COMM') body = body.slice(4 + 4);   // encoding+lang, empty BOM+terminator
    else body = body.slice(1);
    frames[id] = Buffer.from(body.slice(2)).toString('utf16le');
    p += 10 + n;
  }
  ok(s === 'ID3' && mp3[3] === 3 && frames.TIT2 === 'Héllo' && frames.COMM === 'Synthetic speech', 'MP3 tag parses back (title, comment)');
  ok(mp3[10 + size] === 0xFF && mp3.length === 10 + size + 4, 'MP3 audio follows the tag untouched');
}
{
  // RIFF LIST/INFO, read back independently.
  const hdr = Buffer.alloc(44 + 4);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(40, 4); hdr.write('WAVEfmt ', 8); hdr.writeUInt32LE(16, 16);
  hdr.write('data', 36); hdr.writeUInt32LE(4, 40);
  const wav = Buffer.from(T.tagWav(new Uint8Array(hdr), { title: 'Hi', comment: 'Synthetic speech', software: 'AudioSaw' }));
  ok(wav.readUInt32LE(4) === wav.length - 8, 'WAV RIFF size covers the INFO chunk');
  const info = {};
  for (let p = 12; p < wav.length;) {
    const id = wav.toString('latin1', p, p + 4), n = wav.readUInt32LE(p + 4);
    if (id === 'LIST' && wav.toString('latin1', p + 8, p + 12) === 'INFO') {
      for (let q = p + 12; q < p + 8 + n;) {
        const sid = wav.toString('latin1', q, q + 4), sn = wav.readUInt32LE(q + 4);
        info[sid] = wav.toString('latin1', q + 8, q + 8 + sn).replace(/\0+$/, '');
        q += 8 + sn + (sn & 1);
      }
    }
    p += 8 + n + (n & 1);
  }
  ok(info.ICMT === 'Synthetic speech' && info.INAM === 'Hi' && info.ISFT === 'AudioSaw', 'WAV INFO chunk parses back');
}

/* --------------------------------------------------------------- browser */

const CACHE = path.join(os.homedir(), '.cache', 'audiosaw', 'kokoro');
const REPO = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/';
const FILES = ['onnx/model.onnx', 'onnx/model_quantized.onnx', 'voices/af_heart.bin', 'voices/am_michael.bin', 'voices/bf_emma.bin'];

async function ensureFiles() {
  fs.mkdirSync(CACHE, { recursive: true });
  for (const f of FILES) {
    const dest = path.join(CACHE, path.basename(f));
    if (fs.existsSync(dest)) continue;
    if (process.env.TTS_OFFLINE) return false;
    console.log('  downloading ' + f + ' (once)…');
    const res = await fetch(REPO + f);
    if (!res.ok) throw new Error('download ' + f + ': HTTP ' + res.status);
    fs.writeFileSync(dest + '.part', Buffer.from(await res.arrayBuffer()));
    fs.renameSync(dest + '.part', dest);
  }
  return true;
}

const SENTENCE = 'The quick brown fox jumps over the lazy dog, and then it runs back home before the rain starts.';

async function browser() {
  const { withPage, findChrome } = require('./chrome-harness');
  if (!findChrome()) { console.log('  skip: no Chrome'); return; }
  if (!(await ensureFiles())) { console.log('  skip: model not cached and TTS_OFFLINE is set'); return; }
  const routes = {};
  for (const f of FILES) routes['/__kokoro/' + path.basename(f)] = () => fs.readFileSync(path.join(CACHE, path.basename(f)));

  for (const backend of (process.env.TTS_BACKENDS || 'webgpu,wasm').split(',')) {
    console.log('page, ' + backend);
    await withPage({
      routes, headers: true,
      args: backend === 'webgpu' ? ['--enable-unsafe-webgpu', '--use-angle=metal', '--ignore-gpu-blocklist'] : []
    }, async (page) => {
      page.listen('Fetch.requestPaused', (p) => {
        const name = p.request.url.split('?')[0].split('/').pop();
        page.send('Fetch.continueRequest', { requestId: p.requestId, url: page.url('/__kokoro/' + name) });
      });
      await page.send('Fetch.enable', { patterns: [{ urlPattern: '*huggingface.co/onnx-community/Kokoro*' }] });
      await page.goto('/text-to-speech?backend=' + backend, 1500);
      ok(await page.eval('self.crossOriginIsolated'), 'page is cross-origin isolated');

      const run = (text, voiceMix, speed) => page.eval(`(async () => {
        document.querySelector('#speed').value = ${speed || 1};
        const t0 = performance.now();
        window.__tts.speak(${JSON.stringify(text)}, { play: false, mix: ${JSON.stringify(voiceMix)} });
        for (;;) {
          await new Promise((r) => setTimeout(r, 100));
          const s = window.__tts.state();
          if (!s.pending) break;
          if (performance.now() - t0 > 240000) throw new Error('timed out');
        }
        const err = document.querySelector('#status').className.includes('error') ? document.querySelector('#status').textContent : null;
        const x = window.__tts.samples();
        if (!x) return { err: err || 'no result' };
        let ss = 0, pk = 0;
        for (let i = 0; i < x.length; i++) { ss += x[i] * x[i]; pk = Math.max(pk, Math.abs(x[i])); }
        return { err, seconds: x.length / 24000, rms: Math.sqrt(ss / x.length), peak: pk, ready: window.__tts.state().ready,
                 head: Array.from(x.subarray(4000, 4064)) };
      })()`);

      // Warm-up: model load and the first session run.
      const warm = await run('Hello there.', [{ id: 'af_heart', w: 1 }]);
      ok(!warm.err, 'model loads and speaks' + (warm.err ? ' — ' + warm.err : ''));
      if (warm.err) return;
      ok(warm.ready && warm.ready.backend === backend, 'ran on ' + backend + (warm.ready ? ' (got ' + warm.ready.backend + ', ' + warm.ready.threads + ' threads)' : ''));

      const words = SENTENCE.split(/\s+/).length;
      const res = {};
      for (const v of ['af_heart', 'am_michael', 'bf_emma']) {
        const t0 = Date.now();
        const r = await run(SENTENCE, [{ id: v, w: 1 }]);
        r.wall = (Date.now() - t0) / 1000;
        res[v] = r;
        const plaus = r.seconds > words / 4.5 && r.seconds < words / 1.2;
        ok(!r.err && r.rms > 0.02 && r.peak < 1 && plaus,
          v + ': ' + (r.seconds || 0).toFixed(2) + ' s for ' + words + ' words, rms ' + (r.rms || 0).toFixed(3) + ', peak ' + (r.peak || 0).toFixed(2) + ', took ' + r.wall.toFixed(1) + ' s');
      }
      const fast = await run(SENTENCE, [{ id: 'af_heart', w: 1 }], 1.5);
      const ratio = fast.seconds / res.af_heart.seconds;
      ok(ratio > 0.55 && ratio < 0.8, 'speed 1.5 gives ' + ratio.toFixed(2) + 'x the length (expect ~0.67)');

      const mix = await run(SENTENCE, [{ id: 'af_heart', w: 1 }, { id: 'am_michael', w: 1 }]);
      const differs = (a, b) => a.some((x, i) => Math.abs(x - b[i]) > 1e-4) || Math.abs(a.length - b.length) > 0;
      ok(!mix.err && mix.rms > 0.02 && differs(mix.head, res.af_heart.head) && differs(mix.head, res.am_michael.head) &&
        Math.abs(mix.seconds - res.af_heart.seconds) / res.af_heart.seconds < 0.35,
        'a two-voice mix is speech and differs from both voices');
      const again = await run(SENTENCE, [{ id: 'af_heart', w: 1 }]);
      ok(!differs(again.head, res.af_heart.head) && again.seconds === res.af_heart.seconds, 'same text and voice give the same audio');

      // Real-time factor, for the figures the page quotes. Only enforced with
      // TTS_SPEED=1 on an idle machine: under load it moved 2-3x (CPU 2.6x
      // idle, 8x at load average 50), which says nothing about the code.
      const speedOk = (c) => c || !process.env.TTS_SPEED;
      const rtf = ['af_heart', 'am_michael', 'bf_emma'].map((v) => res[v].wall / res[v].seconds).sort()[1];
      if (backend === 'webgpu') ok(speedOk(rtf < 1.5), 'WebGPU takes ' + rtf.toFixed(2) + 'x the speech length (page: "about as long as the speech")');
      else ok(speedOk(rtf < 8), 'CPU takes ' + rtf.toFixed(2) + 'x the speech length (page: "several times as long")');

      // Download: MP3 with the synthetic-speech tag, and the readout.
      const dl = await page.eval(`(async () => {
        const got = [];
        const orig = CV.downloadBlob;
        CV.downloadBlob = (b, name) => { got.push({ b, name }); };
        document.querySelector('#format').value = 'mp3';
        document.querySelector('#dlBtn').click();
        for (let i = 0; i < 600 && !got.length; i++) await new Promise((r) => setTimeout(r, 100));
        CV.downloadBlob = orig;
        if (!got.length) return { err: 'no download' };
        const u = new Uint8Array(await got[0].b.arrayBuffer());
        const ab = await AudioSaw.decodeToAudioBuffer(new File([u], got[0].name), null);
        const sig = document.querySelector('#signalPath');
        return { name: got[0].name, id3: String.fromCharCode(u[0], u[1], u[2]), comm: new TextDecoder('utf-16le').decode(u.slice(0, 600)).includes('Synthetic speech'),
                 seconds: ab.duration, signal: sig && !sig.hidden ? sig.textContent : '' };
      })()`);
      ok(dl.id3 === 'ID3' && dl.comm && /\.mp3$/.test(dl.name), 'MP3 download carries the synthetic-speech tag (' + dl.name + ')');
      ok(Math.abs(dl.seconds - again.seconds) < 0.15, 'the MP3 decodes to the same length (' + (dl.seconds || 0).toFixed(2) + ' s)');
      ok(/Saved as/.test(dl.signal) && /MP3/.test(dl.signal), 'the readout shows what was written');
      if (page.logs.length) console.log('    console: ' + page.logs.slice(0, 5).join(' | '));
    });
  }
}

(async () => {
  try { await browser(); } catch (e) { console.log('  FAIL browser: ' + (e.stack || e)); failed++; }
  if (failed) { console.log('\n' + failed + ' check(s) failed'); process.exit(1); }
  console.log('\ncheck-tts: all good');
})();
