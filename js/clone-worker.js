/*
 * Voice-cloning worker: Chatterbox Turbo (Resemble AI, MIT, 350M) through
 * ONNX Runtime Web 1.22 on WebGPU. A JavaScript port of the reference loop on
 * the model card (ResembleAI/chatterbox-turbo-ONNX):
 *
 *   speech_encoder(reference 24 kHz)  → conditioning embeddings, the
 *                                       reference's own speech tokens, and a
 *                                       speaker embedding + features
 *   embed_tokens(text)                → text embeddings, after the
 *                                       conditioning, into…
 *   language_model                    → one speech token per step (greedy,
 *                                       repetition penalty 1.2) until 6562
 *   conditional_decoder(prompt tokens + new tokens + 3 silence, speaker)
 *                                     → 24 kHz waveform, in one step
 *
 * q4f16 weights (about 560 MB, fetched once and cached). WebGPU only: the
 * language model runs one step per speech token (25 a second of audio), and
 * on the CPU that is far too slow to be useful.
 *
 * The attention cache (24 layers, keys and values, fp16) stays on the GPU
 * between steps (preferredOutputLocation 'gpu-buffer'): copied back each
 * step it would be tens of MB per token by the end of a sentence.
 *
 * The reference is encoded once and reused for every sentence.
 *
 * Protocol
 *   in : { type: 'load' }
 *        { type: 'reference', audio: Float32Array (24 kHz mono) }
 *        { type: 'synth', seq, text }
 *        { type: 'cancel' }
 *   out: { type: 'status', phase, pct, detail }
 *        { type: 'ready', backend }
 *        { type: 'referenced', seconds }
 *        { type: 'progress', seq, tokens }
 *        { type: 'audio', seq, samples, tokens, ms }
 *        { type: 'error', seq, message }
 */

/* global ort, ASTTS */

var AS_V = (/[?&]v=([^&]+)/.exec(self.location.search || '') || [])[1] || '';
self.importScripts('/vendor/ort/ort.webgpu.min.js', '/js/tts-engine.js' + (AS_V ? '?v=' + AS_V : ''));

var REV = 'd21799bd0354adb85e348b8a0442a8405110a2cf';
var REPO = 'https://huggingface.co/ResembleAI/chatterbox-turbo-ONNX/resolve/' + REV + '/';
var PARTS = [
  { key: 'enc', name: 'speech_encoder_q4f16', mb: 177 },
  { key: 'emb', name: 'embed_tokens_q4f16', mb: 34 },
  { key: 'lm', name: 'language_model_q4f16', mb: 184 },
  { key: 'dec', name: 'conditional_decoder_q4f16', mb: 163 }
];
var CACHE_NAME = 'audiosaw-models-v2';
var SR = 24000;
var START = 6561, STOP = 6562, SILENCE = 4299;
var HEADS = 16, HEAD_DIM = 64;
var PENALTY = 1.2;
var MAX_TOKENS = 1000;      // 40 s of speech; a chunk is a sentence or two

var S = {}, tokenizer = null, ref = null, cancelled = false;

function post(type, m, transfer) { m = m || {}; m.type = type; self.postMessage(m, transfer || []); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* ------------------------------------------------------------ downloads */

// The same resumable read as tts-worker.js: a dropped connection asks for
// the rest with Range rather than starting a 180 MB file again.
async function readAll(url, onBytes) {
  var res = await fetch(url);
  if (!res.ok) throw new Error('Could not download the cloning model (HTTP ' + res.status + ')');
  var total = +res.headers.get('content-length') || 0, resumeUrl = res.url || url;
  var reader = res.body.getReader(), chunks = [], got = 0, fails = 0;
  for (;;) {
    try {
      var r = await reader.read();
      if (r.done) { if (total && got < total) throw new Error('short'); break; }
      chunks.push(r.value); got += r.value.byteLength; fails = 0;
      if (onBytes) onBytes(got, total);
    } catch (e) {
      if (!total || ++fails > 6) throw new Error('The model download kept failing. Check the connection and try again — it resumes where it stopped.');
      await sleep(1000 * fails);
      try {
        var rr = await fetch(fails > 3 ? url : resumeUrl, { headers: { Range: 'bytes=' + got + '-' } });
        if (rr.status === 206 && rr.body) reader = rr.body.getReader();
      } catch (e2) { /* next attempt */ }
    }
  }
  var out = new Uint8Array(got), off = 0;
  chunks.forEach(function (c) { out.set(c, off); off += c.byteLength; });
  return out;
}
async function cached(url, onBytes) {
  var cache = null;
  try { cache = await caches.open(CACHE_NAME); } catch (e) {}
  if (cache) { var hit = await cache.match(url); if (hit) return new Uint8Array(await hit.arrayBuffer()); }
  var b = await readAll(url, onBytes);
  if (cache) { try { await cache.put(url, new Response(b)); } catch (e) { /* quota */ } }
  return b;
}

/* --------------------------------------------------------------- load */

var loading = null;
function load() {
  if (!loading) { loading = doLoad(); loading.catch(function () { loading = null; }); }
  return loading;
}

async function doLoad() {
  if (!self.navigator.gpu || !(await self.navigator.gpu.requestAdapter())) {
    throw new Error('Voice cloning needs WebGPU (current Chrome or Edge on a desktop or laptop). This browser does not offer it.');
  }
  ort.env.wasm.wasmPaths = '/vendor/ort/';
  ort.env.wasm.numThreads = 1;
  ort.env.logLevel = 'error';

  var tokP = import('/vendor/transformers/transformers.min.js?v=4.2.0').then(function (T) {
    T.env.allowLocalModels = false;
    return T.AutoTokenizer.from_pretrained('ResembleAI/chatterbox-turbo-ONNX', { revision: REV });
  });

  var totalMb = PARTS.reduce(function (a, p) { return a + p.mb; }, 0), doneMb = 0;
  for (var i = 0; i < PARTS.length; i++) {
    var p = PARTS[i];
    var graph = await cached(REPO + 'onnx/' + p.name + '.onnx');
    var data = await cached(REPO + 'onnx/' + p.name + '.onnx_data', function (got, total) {
      var mb = doneMb + got / 1048576;
      post('status', { phase: 'model', pct: Math.min(99, mb / totalMb * 100), detail: 'Downloading the cloning model — ' + mb.toFixed(0) + ' of ' + totalMb + ' MB (once, then cached)' });
    });
    doneMb += p.mb;
    post('status', { phase: 'session', pct: doneMb / totalMb * 100, detail: 'Starting the cloning model (' + (i + 1) + ' of 4)…' });
    var opts = { executionProviders: ['webgpu'], externalData: [{ path: p.name + '.onnx_data', data: data }] };
    if (p.key === 'lm') {
      // Keep the attention cache on the GPU; only the logits come back.
      var loc = { logits: 'cpu' };
      for (var l = 0; l < 24; l++) { loc['present.' + l + '.key'] = 'gpu-buffer'; loc['present.' + l + '.value'] = 'gpu-buffer'; }
      opts.preferredOutputLocation = loc;
    }
    S[p.key] = await ort.InferenceSession.create(graph, opts);
  }
  tokenizer = await tokP;
  post('ready', { backend: 'webgpu' });
}

/* ---------------------------------------------------------- reference */

async function reference(audio) {
  await load();
  var out = await S.enc.run({ audio_values: new ort.Tensor('float32', audio, [1, audio.length]) });
  ref = {
    cond: out.audio_features,             // [1, c, 1024]
    prompt: out.audio_tokens,             // [1, p] int64
    spk: out.speaker_embeddings,          // [1, 192]
    feat: out.speaker_features            // [1, f, 80]
  };
  post('referenced', { seconds: audio.length / SR });
}

/* ------------------------------------------------------------- synth */

function concatEmbeds(a, b) {
  var D = 1024, na = a.dims[1], nb = b.dims[1];
  var out = new Float32Array((na + nb) * D);
  out.set(a.data, 0); out.set(b.data, na * D);
  return new ort.Tensor('float32', out, [1, na + nb, D]);
}

async function synth(m) {
  await load();
  if (!ref) throw new Error('Record or choose a reference voice first.');
  var t0 = Date.now();
  var ids = tokenizer(m.text).input_ids;      // Tensor, int64 [1, n]
  var idsData = ids.data instanceof BigInt64Array ? ids.data : BigInt64Array.from(Array.from(ids.data, BigInt));
  var embeds = (await S.emb.run({ input_ids: new ort.Tensor('int64', idsData, [1, idsData.length]) })).inputs_embeds;
  embeds = concatEmbeds(ref.cond, embeds);

  var seqLen = embeds.dims[1];
  var past = {};
  S.lm.inputNames.forEach(function (n) {
    if (n.indexOf('past_key_values') === 0) past[n] = new ort.Tensor('float16', new Uint16Array(0), [1, HEADS, 0, HEAD_DIM]);
  });
  var maskLen = seqLen;
  var positions = BigInt64Array.from({ length: seqLen }, function (_, i) { return BigInt(i); });
  var gen = [START];
  var seen = {};
  seen[START] = true;

  try {
    for (var step = 0; step < MAX_TOKENS; step++) {
      if (cancelled) throw new Error('cancelled');
      var feeds = {
        inputs_embeds: embeds,
        attention_mask: new ort.Tensor('int64', new BigInt64Array(maskLen).fill(1n), [1, maskLen]),
        position_ids: new ort.Tensor('int64', positions, [1, positions.length])
      };
      for (var k in past) feeds[k] = past[k];
      var out = await S.lm.run(feeds);

      // The previous step's cache is now superseded by `present`.
      for (var k2 in past) { if (past[k2].location === 'gpu-buffer') past[k2].dispose(); }
      for (var k3 in past) past[k3] = out[k3.replace('past_key_values', 'present')];

      var V = out.logits.dims[2], L = out.logits.dims[1], lg = out.logits.data, base = (L - 1) * V;
      var best = -1, bv = -Infinity;
      for (var v = 0; v < V; v++) {
        var s = lg[base + v];
        if (seen[v]) s = s < 0 ? s * PENALTY : s / PENALTY;
        if (s > bv) { bv = s; best = v; }
      }
      gen.push(best);
      seen[best] = true;
      if (best === STOP) break;
      if (step % 25 === 0) post('progress', { seq: m.seq, tokens: gen.length });

      embeds = (await S.emb.run({ input_ids: new ort.Tensor('int64', BigInt64Array.of(BigInt(best)), [1, 1]) })).inputs_embeds;
      maskLen += 1;
      positions = BigInt64Array.of(BigInt(maskLen - 1));
    }
  } finally {
    for (var k4 in past) { if (past[k4] && past[k4].location === 'gpu-buffer') past[k4].dispose(); }
  }

  // Decode: the reference's own tokens, then the new ones (without START and
  // STOP), then three silence tokens, exactly as the reference code does.
  var body = gen.slice(1, gen[gen.length - 1] === STOP ? -1 : gen.length);
  var p = ref.prompt.data, n = p.length + body.length + 3;
  var toks = new BigInt64Array(n);
  toks.set(p, 0);
  body.forEach(function (t, i) { toks[p.length + i] = BigInt(t); });
  for (var j = 0; j < 3; j++) toks[p.length + body.length + j] = BigInt(SILENCE);
  var wav = (await S.dec.run({ speech_tokens: new ort.Tensor('int64', toks, [1, n]), speaker_embeddings: ref.spk, speaker_features: ref.feat })).waveform.data;

  // The reference code keeps the decoder's whole output: the prompt tokens
  // condition it but are not rendered. check-clone holds that (the length
  // must match the new tokens at 25 a second, not prompt + new).
  var samples = new Float32Array(wav.length);
  samples.set(wav);
  return { samples: samples, tokens: body.length, ms: Date.now() - t0 };
}

self.onmessage = async function (e) {
  var m = e.data || {};
  try {
    if (m.type === 'load') await load();
    else if (m.type === 'reference') await reference(m.audio);
    else if (m.type === 'cancel') cancelled = true;
    else if (m.type === 'synth') {
      cancelled = false;
      var r = await synth(m);
      post('audio', { seq: m.seq, samples: r.samples, tokens: r.tokens, ms: r.ms }, [r.samples.buffer]);
    }
  } catch (err) {
    post('error', { seq: m.seq, message: (err && err.message) || String(err) });
  }
};
