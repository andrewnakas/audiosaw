/*
 * English → Spanish, French, Italian, Brazilian Portuguese or Hindi, for
 * /video-dubbing. Helsinki-NLP's OPUS-MT (MarianMT, CC-BY-4.0), the 8-bit
 * ONNX exports by Xenova, about 110-130 MB a language: a dedicated model for
 * es, fr, it and hi, and the multi-target en-ROMANCE for Portuguese (there is
 * no en-pt export), steered with a ">>pt_BR<<" tag. ROMANCE was tried for all
 * four and drifted into French in an Italian sentence; one language per model
 * is the same download for a user who picks one language.
 *
 * The sessions run on the vendored ORT 1.22 (/vendor/ort), not
 * transformers.js's 1.26, which refuses these files; the decode loop is
 * ASMarian (marian.js). transformers.js is used only for the tokenizer, which
 * is plain JS. Whisper's own translation goes only into English, so a dub
 * into Spanish is Whisper → English → this.
 *
 * Protocol
 *   in : { type: 'run', lang: 'es'|'fr-fr'|'it'|'pt-br'|'hi', lines: [text] }
 *   out: { type: 'status', pct, detail }
 *        { type: 'done', lines: [text] }
 *        { type: 'error', message }
 */

var AS_V = (/[?&]v=([^&]+)/.exec(self.location.search || '') || [])[1] || '';
self.importScripts('/vendor/ort/ort.min.js', '/js/marian.js' + (AS_V ? '?v=' + AS_V : ''));

var TARGETS = {
  'es': { id: 'Xenova/opus-mt-en-es', rev: '4b002a4c7edd54a7ced58877258b87f7efd3f892' },
  'fr-fr': { id: 'Xenova/opus-mt-en-fr', rev: '28726206f80896b90035bd99cccd5cc1e151f916' },
  'it': { id: 'Xenova/opus-mt-en-it', rev: '075406e3c8c2c30634d4a1bd8f00c21d9e162011' },
  'pt-br': { id: 'Xenova/opus-mt-en-ROMANCE', rev: '9d2ba69ac80c8e8453c3d9a1e2323a0e7b8ca3cd', tag: '>>pt_BR<<' },
  'hi': { id: 'Xenova/opus-mt-en-hi', rev: '7aad72006a1588a9c3485ed6203aed99eebbc872' }
};
var CACHE = 'audiosaw-models-v2';

ort.env.wasm.wasmPaths = '/vendor/ort/';
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(8, (self.navigator.hardwareConcurrency || 4) - 1)) : 1;

function post(type, m) { m = m || {}; m.type = type; self.postMessage(m); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function hf(t, f) { return 'https://huggingface.co/' + t.id + '/resolve/' + t.rev + '/' + f; }

// A model file, from Cache Storage or the network with byte progress. A
// dropped connection asks for the rest with a Range request (Hugging Face's
// CDN answers 206) instead of starting the file again; the same approach as
// transcribe-worker.js, which tools/check-model-fetch.js tests.
async function fetchBytes(url, onBytes) {
  var cache = null;
  try { cache = await caches.open(CACHE); var hit = await cache.match(url); if (hit) return new Uint8Array(await hit.arrayBuffer()); } catch (e) { cache = null; }
  var parts = [], got = 0, total = 0, fails = 0, res = await fetch(url);
  if (!res.ok) throw new Error('The translation model could not be downloaded (HTTP ' + res.status + ').');
  total = +res.headers.get('content-length') || 0;
  var reader = res.body.getReader(), resumeUrl = res.url || url;
  for (;;) {
    try {
      var r = await reader.read();
      if (r.done) { if (total && got < total) throw new Error('closed early'); break; }
      parts.push(r.value); got += r.value.byteLength; fails = 0;
      onBytes(got, total);
    } catch (e) {
      if (++fails > 6 || !total) throw new Error('The translation model download kept failing. Check the connection and try again.');
      await sleep(1000 * fails);
      try {
        var rr = await fetch(fails > 3 ? url : resumeUrl, { headers: { Range: 'bytes=' + got + '-' } });
        if (rr.status === 206 && rr.body) reader = rr.body.getReader();
      } catch (e2) { /* try again */ }
    }
  }
  var out = new Uint8Array(got), o = 0;
  parts.forEach(function (p) { out.set(p, o); o += p.byteLength; });
  if (cache) { try { await cache.put(url, new Response(out)); } catch (e) { /* quota: just not cached */ } }
  return out;
}

var Tok = null;
function transformers() {
  if (!Tok) {
    Tok = import('/vendor/transformers/transformers.min.js?v=4.2.0').then(function (T) {
      T.env.allowLocalModels = false;
      T.env.useBrowserCache = true;
      return T;
    });
    Tok.catch(function () { Tok = null; });
  }
  return Tok;
}

var loaded = {};
function load(t) {
  if (!loaded[t.id]) {
    loaded[t.id] = (async function () {
      var have = {};
      function bytes(name, a, b) {
        have[name] = [a, b || a];
        var x = 0, y = 0;
        Object.keys(have).forEach(function (k) { x += have[k][0]; y += have[k][1]; });
        post('status', { pct: 60 * x / Math.max(y, 1), detail: 'Downloading the translation model… ' + Math.round(x / 1048576) + ' of ' + Math.round(y / 1048576) + ' MB (once)' });
      }
      var T = await transformers();
      var cfgP = fetch(hf(t, 'config.json')).then(function (r) { return r.json(); });
      var tokP = T.AutoTokenizer.from_pretrained(t.id, { revision: t.rev });
      var files = await Promise.all([
        fetchBytes(hf(t, 'onnx/encoder_model_quantized.onnx'), function (a, b) { bytes('e', a, b); }),
        fetchBytes(hf(t, 'onnx/decoder_model_merged_quantized.onnx'), function (a, b) { bytes('d', a, b); })
      ]);
      post('status', { pct: 60, detail: 'Starting the translation model…' });
      var C = await cfgP, opt = { executionProviders: ['wasm'] };
      var enc = await ort.InferenceSession.create(files[0], opt);
      var dec = await ort.InferenceSession.create(files[1], opt);
      return {
        tok: await tokP,
        cfg: { ort: ort, enc: enc, dec: dec, layers: C.decoder_layers, heads: C.decoder_attention_heads, headDim: C.d_model / C.decoder_attention_heads,
          start: C.decoder_start_token_id, eos: C.eos_token_id, pad: C.pad_token_id }
      };
    })();
    loaded[t.id].catch(function () { delete loaded[t.id]; });
  }
  return loaded[t.id];
}

async function run(m) {
  var t = TARGETS[m.lang];
  if (!t) throw new Error('No translation into ' + m.lang);
  var M = await load(t), out = [];
  var tagId = t.tag ? M.tok.convert_tokens_to_ids(t.tag) : null;
  for (var i = 0; i < m.lines.length; i++) {
    post('status', { pct: 60 + 40 * i / m.lines.length, detail: 'Translating line ' + (i + 1) + ' of ' + m.lines.length + '…' });
    // One sentence at a time: given several, Marian drops or merges them.
    var said = [], ss = ASMarian.sentences(m.lines[i]);
    for (var s = 0; s < ss.length; s++) {
      var ids = Array.from(M.tok(ss[s]).input_ids.data, Number);
      if (tagId != null) ids.unshift(tagId);
      var outIds = await ASMarian.generate(M.cfg, ids, { beams: m.beams || BEAMS });
      said.push(M.tok.decode(outIds, { skip_special_tokens: true }).trim());
    }
    out.push(said.join(' ').replace(/\s+/g, ' ').trim());
  }
  post('done', { lines: out });
}

var BEAMS = 4;

self.onmessage = async function (e) {
  var m = e.data || {};
  try { if (m.type === 'run') await run(m); }
  catch (err) { post('error', { message: (err && err.message) || String(err) }); }
};
