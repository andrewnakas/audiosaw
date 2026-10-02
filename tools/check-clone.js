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
const FILES = ['tokenizer.json', 'tokenizer_config.json', 'config.json', 'generation_config.json', 'preprocessor_config.json']
  .concat(...NAMES.map((n) => ['onnx/' + n + '_q4f16.onnx', 'onnx/' + n + '_q4f16.onnx_data']))
  .concat(['onnx/embed_tokens_q4.onnx', 'onnx/embed_tokens_q4.onnx_data']);
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
  if (!fs.existsSync(path.join(__dirname, '..', 'voice-cloning.html'))) { console.log('  skip: /voice-cloning is not in this release'); console.log('\ncheck-clone: skipped'); return; }
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
  // Whisper base, to hear what the clone said, from a local mirror if there
  // is one (~/.cache/audiosaw/hf/onnx-community/whisper-base/...).
  const WB = path.join(os.homedir(), '.cache', 'audiosaw', 'hf', 'onnx-community', 'whisper-base');
  const haveWhisper = ['config.json', 'tokenizer.json', 'onnx/encoder_model_q4.onnx', 'onnx/decoder_model_merged_q4.onnx'].every((f) => fs.existsSync(path.join(WB, f)));
  if (haveWhisper) {
    const walk = (d, pre) => fs.readdirSync(d).forEach((f) => {
      const full = path.join(d, f);
      if (fs.statSync(full).isDirectory()) walk(full, pre + f + '/');
      else routes['/__wb/' + pre + f] = () => fs.readFileSync(full);
    });
    walk(WB, '');
  }
  await withPage({
    headers: true, routes,
    args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--ignore-gpu-blocklist']
  }, async (page) => {
    page.listen('Fetch.requestPaused', (p) => {
      const u = p.request.url.split('?')[0];
      const wb = /whisper-base\/resolve\/[^/]+\/(.+)$/.exec(u);
      const to = wb ? '/__wb/' + wb[1] : '/__cb/' + u.split('/').pop();
      page.send('Fetch.continueRequest', { requestId: p.requestId, url: page.url(to) });
    });
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*huggingface.co/ResembleAI/chatterbox-turbo-ONNX*' }]
      .concat(haveWhisper ? [{ urlPattern: '*huggingface.co/onnx-community/whisper-base/*' }] : []) });
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
      // What it actually said, by Whisper (cached in the profile by the
      // dictation check; skipped if it is not there and the network is slow).
      if (haveWhisper) r.heard = await page.eval(`(async () => {
        const y = Float32Array.from(${JSON.stringify(r.y)});
        const b = await AudioSaw.resampleBuffer(AudioSaw.makeBuffer([y], 24000), 16000);
        const a = Float32Array.from(b.getChannelData(0));
        const w = new Worker('/js/transcribe-worker.js', { type: 'module' });
        return await new Promise((res) => {
          const t = setTimeout(() => res('(no transcript)'), 300000);
          w.onmessage = (e) => { if (e.data.type === 'done') { clearTimeout(t); res(e.data.text); w.terminate(); } if (e.data.type === 'error') res('(error ' + e.data.message + ')'); };
          w.postMessage({ type: 'run', model: 'onnx-community/whisper-base', audio: a, language: 'en', task: 'transcribe' }, [a.buffer]);
        });
      })()`, 400000);
      if (haveWhisper) {
        const norm = (t) => t.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean);
        const want = norm(TEXT), got = new Set(norm(r.heard));
        const hit = want.filter((w) => got.has(w)).length / want.length;
        ok(hit >= 0.8, `${v} clone is intelligible: Whisper heard "${r.heard.trim()}" (${Math.round(hit * 100)}% of the words)`);
      } else console.log('    skip: no local Whisper base to check the words');
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
