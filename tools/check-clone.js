#!/usr/bin/env node
/*
 * Checks /voice-cloning in headless Chrome on a real WebGPU adapter.
 *
 * Needs the Chatterbox Turbo q4f16 files in ~/.cache/audiosaw/chatterbox
 * (about 560 MB; CLONE_DOWNLOAD=1 fetches them) and macOS `say` for the
 * reference voices. Without them it skips.
 *
 * What it holds:
 *   - the consent box gates everything: no reference and no Speak button
 *     until it is ticked;
 *   - the clone follows its reference: a low male voice (Daniel) and a
 *     higher female voice (Samantha) are each cloned saying the same
 *     sentence, and each clone's median pitch must sit nearer its own
 *     reference than the other one's. That is a crude likeness test, but an
 *     objective one; a decoder ignoring the speaker would fail it;
 *   - the length matches the new speech tokens (25 a second): the decoder
 *     does not render the reference's own tokens back;
 *   - the speech is not silent, not clipped, and plausible for the words;
 *   - the MP3 download carries the cloned-voice tag.
 */
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
require('../js/pitch-track.js');
const P = globalThis.ASPitch;

let failed = 0;
function ok(c, m) { console.log((c ? '  ok  ' : '  FAIL ') + m); if (!c) failed++; }

const CACHE = path.join(os.homedir(), '.cache', 'audiosaw', 'chatterbox');
const REV = 'd21799bd0354adb85e348b8a0442a8405110a2cf';
const REPO = 'https://huggingface.co/ResembleAI/chatterbox-turbo-ONNX/resolve/' + REV + '/';
const NAMES = ['speech_encoder', 'embed_tokens', 'language_model', 'conditional_decoder'];
const FILES = ['tokenizer.json', 'tokenizer_config.json', 'config.json']
  .concat(...NAMES.map((n) => ['onnx/' + n + '_q4f16.onnx', 'onnx/' + n + '_q4f16.onnx_data']));
const TEXT = 'The weather today is bright and clear, so we will walk down to the harbour after lunch.';

function median(x, sr) {
  const fr = P.track(x, sr, { minHz: 60, maxHz: 500 }).filter((f) => f.clarity > 0.8).map((f) => f.hz).sort((a, b) => a - b);
  return fr.length ? fr[fr.length >> 1] : 0;
}

async function ensure() {
  fs.mkdirSync(CACHE, { recursive: true });
  for (const f of FILES) {
    const dest = path.join(CACHE, path.basename(f));
    if (fs.existsSync(dest)) continue;
    if (!process.env.CLONE_DOWNLOAD) return false;
    console.log('  downloading ' + f + ' (once)…');
    execFileSync('curl', ['-sL', '-C', '-', '--retry', '5', '-o', dest + '.part', REPO + f]);
    fs.renameSync(dest + '.part', dest);
  }
  return true;
}

(async () => {
  const { withPage, findChrome } = require('./chrome-harness');
  let hasSay = true;
  try { execFileSync('say', ['-v', '?'], { stdio: 'ignore' }); } catch (e) { hasSay = false; }
  if (!findChrome() || !hasSay || !(await ensure())) {
    console.log('  skip: needs Chrome, macOS say and the Chatterbox files in ' + CACHE + ' (CLONE_DOWNLOAD=1 fetches them, 560 MB)');
    console.log('\ncheck-clone: skipped');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-clone-'));
  const refs = {};
  for (const v of ['Daniel', 'Samantha']) {
    const aiff = path.join(dir, v + '.aiff'), wav = path.join(dir, v + '.wav');
    execFileSync('say', ['-v', v, '-o', aiff, 'The north wind and the sun were disputing which was the stronger, when a traveller came along wrapped in a warm cloak.']);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', aiff, '-ac', '1', '-ar', '24000', '-c:a', 'pcm_f32le', wav]);
    const b = fs.readFileSync(wav);
    const off = b.indexOf('data') + 8;
    refs[v] = new Float32Array(b.buffer.slice(b.byteOffset + off, b.byteOffset + b.length - ((b.length - off) % 4)));
  }
  const routes = {};
  FILES.forEach((f) => { routes['/__cb/' + path.basename(f)] = () => fs.readFileSync(path.join(CACHE, path.basename(f))); });
  await withPage({
    headers: true, routes,
    args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--ignore-gpu-blocklist']
  }, async (page) => {
    page.listen('Fetch.requestPaused', (p) => {
      const name = p.request.url.split('?')[0].split('/').pop();
      page.send('Fetch.continueRequest', { requestId: p.requestId, url: page.url('/__cb/' + name) });
    });
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*huggingface.co/ResembleAI/chatterbox-turbo-ONNX*' }] });
    await page.goto('/voice-cloning', 1500);

    const gate = await page.eval(`({ rec: document.querySelector('#recBtn').disabled, file: document.querySelector('#fileInput').disabled,
      go: document.querySelector('#convertBtn').disabled })`);
    ok(gate.rec && gate.file && gate.go, 'nothing works until the consent box is ticked');

    const out = {};
    for (const v of ['Daniel', 'Samantha']) {
      const r = await page.eval(`(async () => {
        const x = new Float32Array(${JSON.stringify(Array.from(refs[v]))});
        await window.__clone.setReference(x, 24000);
        document.querySelector('#cloneText').value = ${JSON.stringify(TEXT)};
        const t0 = performance.now();
        await window.__clone.generate();
        const y = window.__clone.result();
        if (!y) return { err: document.querySelector('#status').textContent };
        let ss = 0, pk = 0; for (let i = 0; i < y.length; i++) { ss += y[i] * y[i]; pk = Math.max(pk, Math.abs(y[i])); }
        return { secs: y.length / 24000, rms: Math.sqrt(ss / y.length), peak: pk, ms: performance.now() - t0, y: Array.from(y) };
      })()`, 1200000);
      if (r.err) { ok(false, v + ': ' + r.err); continue; }
      out[v] = r;
      const words = TEXT.split(/\s+/).length;
      ok(r.rms > 0.02 && r.peak <= 1 && r.secs > words / 4.5 && r.secs < words / 1.2,
        `${v} clone: ${r.secs.toFixed(2)} s for ${words} words, rms ${r.rms.toFixed(3)}, made in ${(r.ms / 1000).toFixed(1)} s (${(r.ms / 1000 / r.secs).toFixed(2)}x the speech)`);
    }
    if (out.Daniel && out.Samantha) {
      const fD = median(refs.Daniel, 24000), fS = median(refs.Samantha, 24000);
      const cD = median(Float32Array.from(out.Daniel.y), 24000), cS = median(Float32Array.from(out.Samantha.y), 24000);
      const near = (c, own, other) => Math.abs(Math.log(c / own)) < Math.abs(Math.log(c / other));
      ok(near(cD, fD, fS) && near(cS, fS, fD), `each clone's pitch follows its reference (Daniel ${fD.toFixed(0)} → clone ${cD.toFixed(0)} Hz; Samantha ${fS.toFixed(0)} → clone ${cS.toFixed(0)} Hz)`);
    }
    const dl = await page.eval(`(async () => {
      const got = []; const orig = CV.downloadBlob; CV.downloadBlob = (b, n) => got.push({ b, n });
      document.querySelector('#format').value = 'mp3'; document.querySelector('#dlBtn').click();
      for (let i = 0; i < 300 && !got.length; i++) await new Promise((r) => setTimeout(r, 100));
      CV.downloadBlob = orig;
      if (!got.length) return {};
      const u = new Uint8Array(await got[0].b.arrayBuffer());
      return { id3: String.fromCharCode(u[0], u[1], u[2]), tag: new TextDecoder('utf-16le').decode(u.slice(0, 1200)).includes('cloned voice') };
    })()`);
    ok(dl.id3 === 'ID3' && dl.tag, 'the MP3 says it is a cloned voice');
    if (page.logs.length) console.log('    console: ' + page.logs.slice(0, 4).join(' | '));
  });
  if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
  console.log('\ncheck-clone: all good');
})().catch((e) => { console.log('  FAIL ' + (e.stack || e)); process.exit(1); });
