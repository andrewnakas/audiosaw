#!/usr/bin/env node
/*
 * Writes /assets/voices/<id>.mp3: a short sample of every Kokoro voice, so
 * "hear this voice" on /text-to-speech plays at once instead of after the
 * 92-326 MB model download it used to need (9 Oct 2026).
 *
 *   node tools/build-voice-samples.js        (TTS_DOWNLOAD=1 fetches files)
 *
 * The samples are made by the page itself (q8 on the CPU, the same model a
 * first-time visitor now gets), one sentence in each voice's own language,
 * mono 64 kbps MP3: about 25 KB each.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('../js/tts-engine.js');
const { withPage } = require('./chrome-harness');

const CACHE = path.join(os.homedir(), '.cache', 'audiosaw', 'kokoro');
const REPO = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/';
const OUT = path.join(__dirname, '..', 'assets', 'voices');

const LINE = {
  'en-us': (n) => 'Hi, I\'m ' + n + '. This is how I sound reading your text.',
  'en-gb': (n) => 'Hello, I\'m ' + n + '. This is how I sound reading your text.',
  es: (n) => 'Hola, soy ' + n + '. Así sueno leyendo tu texto.',
  'fr-fr': (n) => 'Bonjour, je suis ' + n + '. Voici ma voix quand je lis votre texte.',
  it: (n) => 'Ciao, sono ' + n + '. Ecco come suono leggendo il tuo testo.',
  'pt-br': (n) => 'Olá, eu sou ' + n + '. É assim que eu soo lendo o seu texto.',
  hi: (n) => 'नमस्ते, मैं ' + n + ' हूँ। आपका पाठ पढ़ते हुए मेरी आवाज़ ऐसी लगती है।'
};

async function fetchOnce(rel) {
  const dest = path.join(CACHE, path.basename(rel));
  if (fs.existsSync(dest)) return dest;
  if (!process.env.TTS_DOWNLOAD) throw new Error(rel + ' is not in ' + CACHE + ' (TTS_DOWNLOAD=1 fetches it)');
  fs.mkdirSync(CACHE, { recursive: true });
  const res = await fetch(REPO + rel);
  if (!res.ok) throw new Error('download ' + rel + ': HTTP ' + res.status);
  fs.writeFileSync(dest + '.part', Buffer.from(await res.arrayBuffer()));
  fs.renameSync(dest + '.part', dest);
  return dest;
}

(async () => {
  const files = ['onnx/model_quantized.onnx'].concat(T.VOICES.map((v) => 'voices/' + v.id + '.bin'));
  for (const f of files) await fetchOnce(f);
  const routes = {};
  for (const f of files) routes['/__kokoro/' + path.basename(f)] = () => fs.readFileSync(path.join(CACHE, path.basename(f)));
  fs.mkdirSync(OUT, { recursive: true });

  await withPage({ routes, headers: true }, async (page) => {
    page.listen('Fetch.requestPaused', (p) => page.send('Fetch.continueRequest', {
      requestId: p.requestId, url: page.url('/__kokoro/' + p.request.url.split('?')[0].split('/').pop())
    }));
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*huggingface.co/onnx-community/Kokoro*' }] });
    await page.goto('/text-to-speech?backend=wasm', 1500);
    let total = 0;
    for (const v of T.VOICES) {
      const text = LINE[v.lang](v.name);
      const b64 = await page.eval(`(async () => {
        window.__tts.speak(${JSON.stringify(text)}, { play: false, mix: [{ id: ${JSON.stringify(v.id)}, w: 1 }] });
        const t0 = performance.now();
        for (;;) {
          await new Promise((r) => setTimeout(r, 100));
          if (!window.__tts.state().pending) break;
          if (performance.now() - t0 > 240000) throw new Error('timed out');
        }
        const x = window.__tts.samples();
        if (!x) throw new Error(document.querySelector('#status').textContent || 'no result');
        const blob = await AudioSaw.encode(AudioSaw.makeBuffer([x], 24000), 'mp3', { bitrate: 64 });
        const u8 = new Uint8Array(await blob.arrayBuffer());
        let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
        return btoa(s);
      })()`);
      const buf = Buffer.from(b64, 'base64');
      fs.writeFileSync(path.join(OUT, v.id + '.mp3'), buf);
      total += buf.length;
      console.log('  ' + v.id + '.mp3  ' + (buf.length / 1024).toFixed(0) + ' KB');
    }
    console.log('build-voice-samples: ' + T.VOICES.length + ' voices, ' + (total / 1024).toFixed(0) + ' KB');
  });
})().catch((e) => { console.error(e); process.exit(1); });
