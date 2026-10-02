#!/usr/bin/env node
/*
 * Checks the translation behind /video-dubbing's "Into Spanish/French/
 * Italian/Brazilian Portuguese/Hindi" (js/marian.js, js/translate-worker.js).
 *
 *   - in Node: the sentence splitter;
 *   - in headless Chrome, with each OPUS-MT model served from the local
 *     mirror (~/.cache/audiosaw/hf/Xenova/…, TRANSLATE_DOWNLOAD=1 fetches the
 *     ~620 MB once; a language whose model is missing is skipped): a short
 *     how-to script goes through the real worker on /video-dubbing, which is
 *     not cross-origin isolated, so this is the one-thread speed users get.
 *     Every line must come back in the target language (its key words, and
 *     none of the French that the multi-language model slipped into
 *     Italian), with no sentence dropped.
 */
const fs = require('fs'), path = require('path');
const M = require('../js/marian.js');
let failed = 0;
function ok(c, m) { console.log((c ? '  ok  ' : '  FAIL ') + m); if (!c) failed++; }

console.log('sentences');
ok(JSON.stringify(M.sentences('Welcome back.  Today we fix a tap! Ready? Go')) === JSON.stringify(['Welcome back.', 'Today we fix a tap!', 'Ready?', 'Go']), 'splits on . ! ? and keeps a trailing fragment');
ok(JSON.stringify(M.sentences('He said "stop." Then left…')) === JSON.stringify(['He said "stop."', 'Then left…']), 'a closing quote stays with its sentence');
ok(M.sentences('   ').length === 0 && M.sentences('one line').length === 1, 'blank gives nothing, no punctuation gives one');

// Each sentence of LINES is keyed by a word every sane translation keeps.
const LINES = [
  'Welcome back to the channel. Today we are going to fix a leaking kitchen tap.',
  'First, turn off the water under the sink, then remove the handle with a screwdriver.',
  'It takes about ten minutes and costs less than five dollars.',
  'My grandmother taught me this trick when I was nine years old.'
];
const LANGS = {
  'es': { repo: 'Xenova/opus-mt-en-es', rev: '4b002a4c7edd54a7ced58877258b87f7efd3f892', keys: [['canal'], ['agua'], ['minutos', 'dólares'], ['abuela']] },
  'fr-fr': { repo: 'Xenova/opus-mt-en-fr', rev: '28726206f80896b90035bd99cccd5cc1e151f916', keys: [['chaîne'], ['eau'], ['minutes', 'dollars'], ['grand-mère']] },
  'it': { repo: 'Xenova/opus-mt-en-it', rev: '075406e3c8c2c30634d4a1bd8f00c21d9e162011', keys: [['canale'], ['acqua'], ['minuti', 'dollari'], ['nonna']], not: /\b(l'eau|tournevis|éteignez|poignée)\b/ },
  'pt-br': { repo: 'Xenova/opus-mt-en-ROMANCE', rev: '9d2ba69ac80c8e8453c3d9a1e2323a0e7b8ca3cd', keys: [['canal'], ['água'], ['minutos', 'dólares'], ['avó']], not: /\b(el agua|l'eau|del|lavabo)\b/ },
  'hi': { repo: 'Xenova/opus-mt-en-hi', rev: '7aad72006a1588a9c3485ed6203aed99eebbc872', keys: [['चैनल'], ['पानी'], ['मिनट', 'डॉलर'], ['दादी']] }
};
const FILES = ['config.json', 'generation_config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx'];

async function browser() {
  const { withPage, findChrome } = require('./chrome-harness');
  const mirror = require('./model-mirror');
  if (!findChrome()) { console.log('  skip: needs Chrome'); return; }
  const want = Object.keys(LANGS).filter((l) => {
    const L = LANGS[l];
    if (process.env.TRANSLATE_DOWNLOAD && !mirror.has(L.repo, FILES)) mirror.fetch(L.repo, FILES, L.rev);
    return mirror.has(L.repo, FILES);
  });
  Object.keys(LANGS).filter((l) => !want.includes(l)).forEach((l) => console.log('  skip: ' + l + ' (model not mirrored; TRANSLATE_DOWNLOAD=1 fetches it)'));
  if (!want.length) return;
  const repos = [...new Set(want.map((l) => LANGS[l].repo))];
  console.log('translation in the browser');
  await withPage({ routes: mirror.routes(repos) }, async (page) => {
    await mirror.attach(page, repos);
    await page.goto('/video-dubbing', 1500);
    for (const lang of want) {
      const r = await page.eval(`(async () => {
        const w = new Worker('/js/translate-worker.js?v=' + Date.now());
        const call = () => new Promise((res) => { w.onmessage = (e) => { if (e.data.type === 'done') res(e.data.lines); if (e.data.type === 'error') res('ERR ' + e.data.message); };
          w.postMessage({ type: 'run', lang: ${JSON.stringify(lang)}, lines: ${JSON.stringify(LINES)} }); });
        const t0 = performance.now(); const first = await call(); const t1 = performance.now();
        const again = await call(); const t2 = performance.now();
        w.terminate();
        return { lines: first, again, cold: t1 - t0, warm: t2 - t1, iso: self.crossOriginIsolated };
      })()`, 900000);
      if (typeof r.lines === 'string') { ok(false, lang + ': ' + r.lines); continue; }
      const L = LANGS[lang], low = r.lines.map((t) => t.toLowerCase());
      const miss = [];
      L.keys.forEach((ks, i) => ks.forEach((k) => { if (!low[i].includes(k)) miss.push(k); }));
      ok(!miss.length, lang + ': every line in the target language' + (miss.length ? ' — missing ' + miss.join(', ') : ''));
      ok(!L.not || !r.lines.some((t) => L.not.test(t)), lang + ': no other language mixed in');
      // Two sentences in, two out: line 1 must keep its greeting and its tap.
      ok(/[.!?।]\s*\S/.test(r.lines[0].trim().replace(/[.!?।]+$/, '')), lang + ': the two-sentence line kept both sentences');
      ok(JSON.stringify(r.again) === JSON.stringify(r.lines), lang + ': the same text twice gives the same translation');
      const words = LINES.join(' ').split(/\s+/).length;
      console.log('       ' + (r.warm / LINES.length / 1000).toFixed(2) + ' s a line warm, ' + (r.cold / 1000).toFixed(1) + ' s cold incl. load (' + words + ' words, isolated: ' + r.iso + ')');
      r.lines.forEach((t) => console.log('       | ' + t));
    }
    if (page.logs.length) console.log('    console: ' + page.logs.slice(0, 3).join(' | '));
  });
}

browser().catch((e) => ok(false, 'browser: ' + (e.stack || e))).then(() => {
  if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
  console.log('\ncheck-translate: all good');
});
