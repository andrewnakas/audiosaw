#!/usr/bin/env node
/*
 * How intelligible is each non-English Kokoro voice, and which phoneme
 * encoding does the model read best? Not in check-all: it needs the network
 * (Whisper) and a few minutes.
 *
 * Each sentence is spoken by /text-to-speech with ?ph=<mode>, transcribed back
 * by Whisper (base, the language given) in the same page, and scored by word
 * error rate against the text, after lower-casing and stripping punctuation
 * and accents. Modes (ASTTS.fixPhonemes):
 *   plain   espeak's IPA, ties dropped
 *   misaki  tied pairs folded to Kokoro's single symbols (a͡ɪ → I, t͡ʃ → ʧ),
 *           as misaki, Kokoro's own G2P, does
 *   en      kokoro-js's English rules applied anyway (r → ɹ, x → k)
 *
 *   node tools/measure-tts-langs.js [mode,mode] [lang,lang]
 */
const fs = require('fs'), os = require('os'), path = require('path');
const { withPage } = require('./chrome-harness');
const CACHE = path.join(os.homedir(), '.cache', 'audiosaw', 'kokoro');

const SETS = {
  es: ['ef_dora', ['El tren de las ocho llega siempre tarde a la estación.', 'Mi hermana trabaja en un hospital cerca del río.', 'Mañana vamos a comprar pan, queso y tomates en el mercado.']],
  'fr-fr': ['ff_siwis', ['Le train de huit heures arrive toujours en retard à la gare.', 'Ma sœur travaille dans un hôpital près de la rivière.', 'Demain nous allons acheter du pain et du fromage au marché.']],
  it: ['if_sara', ['Il treno delle otto arriva sempre in ritardo alla stazione.', 'Mia sorella lavora in un ospedale vicino al fiume.', 'Domani andiamo a comprare pane e formaggio al mercato.']],
  'pt-br': ['pf_dora', ['O trem das oito sempre chega atrasado na estação.', 'Minha irmã trabalha em um hospital perto do rio.', 'Amanhã vamos comprar pão e queijo na feira.']],
  hi: ['hf_alpha', ['आज मौसम बहुत अच्छा है।', 'मेरी बहन अस्पताल में काम करती है।', 'कल हम बाज़ार से रोटी और फल खरीदेंगे।']]
};
const WL = { es: 'es', 'fr-fr': 'fr', it: 'it', 'pt-br': 'pt', hi: 'hi' };
const modes = (process.argv[2] || 'plain,misaki,en').split(',');
const langs = (process.argv[3] || Object.keys(SETS).join(',')).split(',');

function norm(s) { return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean); }
function wer(ref, hyp) {
  const r = norm(ref), h = norm(hyp), d = Array.from({ length: r.length + 1 }, (_, i) => [i].concat(Array(h.length).fill(0)));
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return d[r.length][h.length] / r.length;
}

(async () => {
  const routes = {};
  fs.readdirSync(CACHE).forEach((f) => { routes['/__kokoro/' + f] = () => fs.readFileSync(path.join(CACHE, f)); });
  const table = {};
  await withPage({ headers: true, routes, profile: path.join(os.homedir(), '.cache', 'audiosaw', 'chrome-dictation'), port: 8771,
    args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--ignore-gpu-blocklist'] }, async (page) => {
    page.listen('Fetch.requestPaused', (p) => {
      const name = p.request.url.split('?')[0].split('/').pop();
      page.send('Fetch.continueRequest', { requestId: p.requestId, url: page.url('/__kokoro/' + name) });
    });
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*huggingface.co/onnx-community/Kokoro*' }] });
    for (const mode of modes) {
      await page.goto('/text-to-speech?ph=' + mode, 1500);
      await page.eval(`window.__asr = new Worker('/js/transcribe-worker.js', { type: 'module' });
        window.__hear = (audio, language) => new Promise((res, rej) => {
          window.__asr.onmessage = (e) => { if (e.data.type === 'done') res(e.data.text); else if (e.data.type === 'error') rej(new Error(e.data.message)); };
          window.__asr.postMessage({ type: 'run', model: 'onnx-community/whisper-base', audio, language, task: 'transcribe' }, [audio.buffer]);
        }); 1`);
      for (const lang of langs) {
        const [voice, sents] = SETS[lang];
        let tot = 0;
        for (const s of sents) {
          const r = await page.eval(`(async () => {
            window.__tts.speak(${JSON.stringify(s)}, { play: false, mix: [{ id: '${voice}', w: 1 }] });
            for (;;) { await new Promise((r) => setTimeout(r, 100)); if (!window.__tts.state().pending) break; }
            const x = window.__tts.samples();
            if (!x) return { err: document.querySelector('#status').textContent };
            const b = await AudioSaw.resampleBuffer(AudioSaw.makeBuffer([x], 24000), 16000);
            const a = Float32Array.from(b.getChannelData(0));
            return { text: await window.__hear(a, '${WL[lang]}'), secs: x.length / 24000 };
          })()`, 900000);
          const w = r.err ? 1 : wer(s, r.text);
          tot += w;
          console.log(`${mode.padEnd(6)} ${lang.padEnd(5)} WER ${(w * 100).toFixed(0).padStart(3)}%  "${r.err || r.text}"`);
        }
        (table[lang] = table[lang] || {})[mode] = tot / sents.length;
      }
    }
  });
  console.log('\nmean WER (lower is better)');
  for (const lang of langs) console.log(lang.padEnd(6) + modes.map((m) => m + ' ' + (table[lang][m] * 100).toFixed(0).padStart(3) + '%').join('   '));
})();
