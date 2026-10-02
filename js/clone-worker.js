/*
 * Voice-cloning worker: Chatterbox Turbo (Resemble AI, MIT, 350M parameters)
 * through transformers.js 4.2.0, which implements Chatterbox's whole pipeline
 * (ChatterboxModel), on WebGPU. A module worker, like transcribe-worker.js,
 * and on the same vendored runtime.
 *
 * Not on /vendor/ort (ORT 1.22) like Kokoro: a hand port of the model card's
 * loop was written first, and ORT 1.22 cannot create the speech encoder's
 * session (it throws a bare wasm exception pointer). ORT 1.26, bundled in
 * transformers.js, loads all four.
 *
 *   speech_encoder(reference, 24 kHz)  conditioning, the reference's own
 *                                      speech tokens, speaker embedding and
 *                                      features. Run ONCE per reference and
 *                                      passed to every generate().
 *   embed_tokens + language_model      one speech token per 40 ms of audio,
 *                                      greedy, repetition penalty 1.2
 *   conditional_decoder                the waveform, in one step
 *
 * q4f16 weights, about 560 MB, cached by transformers.js. WebGPU only: one
 * language-model pass per token is too slow on a CPU to be useful.
 *
 * Protocol
 *   in : { type: 'load' }
 *        { type: 'reference', audio: Float32Array (24 kHz mono) }
 *        { type: 'synth', seq, text }
 *   out: { type: 'status', phase, pct, detail }
 *        { type: 'ready' }
 *        { type: 'referenced', seconds }
 *        { type: 'audio', seq, samples, ms }
 *        { type: 'error', seq, message }
 */

import { ChatterboxModel, AutoProcessor, Tensor, env } from '/vendor/transformers/transformers.min.js?v=4.2.0';

var VENDOR = '/vendor/transformers/';
var ID = 'ResembleAI/chatterbox-turbo-ONNX';
var REV = 'd21799bd0354adb85e348b8a0442a8405110a2cf';
var SR = 24000;

env.allowLocalModels = false;
env.useBrowserCache = true;
var isSafari = /^((?!chrome|android|crios|fxios).)*safari/i.test(self.navigator.userAgent || '');
env.backends.onnx.wasm.wasmPaths = isSafari
  ? { mjs: VENDOR + 'ort-wasm-simd-threaded.mjs?v=1.26.0-dev.20260416', wasm: VENDOR + 'ort-wasm-simd-threaded.wasm?v=1.26.0-dev.20260416' }
  : { mjs: VENDOR + 'ort-wasm-simd-threaded.asyncify.mjs?v=1.26.0-dev.20260416', wasm: VENDOR + 'ort-wasm-simd-threaded.asyncify.wasm?v=1.26.0-dev.20260416' };
env.backends.onnx.wasm.numThreads = 1;

// Resume a dropped download with Range, as transcribe-worker.js does: the
// language model's weights are 184 MB.
var plainFetch = self.fetch.bind(self);
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
env.fetch = function (url, init) {
  return plainFetch(url, init).then(function (res) {
    var total = +res.headers.get('content-length') || 0;
    if (!res.ok || !res.body || res.status !== 200 || total < 4 * 1048576) return res;
    var resumeUrl = res.url || url, reader = res.body.getReader(), got = 0, fails = 0;
    var stream = new ReadableStream({
      pull: async function (ctrl) {
        for (;;) {
          try {
            var r = await reader.read();
            if (r.done) { if (got < total) throw new Error('short'); ctrl.close(); return; }
            got += r.value.byteLength; fails = 0; ctrl.enqueue(r.value); return;
          } catch (e) {
            if (++fails > 6) { ctrl.error(e); return; }
            await sleep(1000 * fails);
            try {
              var rr = await plainFetch(fails > 3 ? url : resumeUrl, { headers: { Range: 'bytes=' + got + '-' } });
              if (rr.status === 206 && rr.body) reader = rr.body.getReader();
            } catch (e2) { /* again */ }
          }
        }
      },
      cancel: function (why) { try { reader.cancel(why); } catch (e) {} }
    });
    return new Response(stream, { status: res.status, statusText: res.statusText, headers: res.headers });
  });
};

var model = null, processor = null, ref = null;

function post(type, m, transfer) { m = m || {}; m.type = type; self.postMessage(m, transfer || []); }

function progress() {
  var files = {};
  return function (p) {
    if (!p || !p.file || (p.status !== 'progress' && p.status !== 'done')) return;
    var f = files[p.file] || (files[p.file] = { loaded: 0, total: 0 });
    if (p.status === 'progress') { f.loaded = p.loaded || 0; f.total = p.total || f.total; } else f.loaded = f.total;
    var l = 0, t = 0;
    for (var k in files) { l += files[k].loaded; t += files[k].total; }
    if (t) post('status', { phase: 'model', pct: Math.min(99, l / t * 100), detail: 'Downloading the cloning model — ' + (l / 1048576).toFixed(0) + ' of ' + (t / 1048576).toFixed(0) + ' MB (once, then cached)' });
  };
}

// embed_tokens holds two lookup tables and routes by POSITION, not by id:
// input_ids[:, :-2] go to the text table and the last two to the speech table
// (50256 there becomes the speech start token). On a generation step the input
// is one speech token, so the text table is asked for zero rows, and ORT's
// WebGPU backend rejects that dispatch ("Invalid dispatch group size (0, 1,
// 1)" in GatherBlockQuantized). The CPU is no way round it: the wasm build has
// no GatherBlockQuantized kernel at all. A lookup depends only on its id, so a
// single id is sent as [text pad, id, id] and the last row is kept.
var PAD_TEXT_ID = 13;   // "." in the GPT-2 vocabulary
function padEmbeddings(sess) {
  var run = sess.run.bind(sess);
  sess.run = async function (feeds, opts) {
    var ids = feeds.input_ids;
    if (!ids || ids.dims[1] !== 1 || ids.dims[0] !== 1) return run(feeds, opts);
    var three = new ids.constructor('int64', BigInt64Array.of(BigInt(PAD_TEXT_ID), ids.data[0], ids.data[0]), [1, 3]);
    var out = await run(Object.assign({}, feeds, { input_ids: three }), opts);
    var e = out.inputs_embeds, D = e.dims[2];
    var row = new Float32Array(D);
    row.set(e.data.subarray(2 * D, 3 * D));
    var res = {};
    for (var k in out) res[k] = out[k];
    res.inputs_embeds = new e.constructor('float32', row, [1, 1, D]);
    return res;
  };
}

var loading = null;
function load() {
  if (!loading) { loading = doLoad(); loading.catch(function () { loading = null; }); }
  return loading;
}
async function doLoad() {
  var a = self.navigator.gpu && await self.navigator.gpu.requestAdapter().catch(function () { return null; });
  if (!a) throw new Error('Voice cloning needs WebGPU (current Chrome or Edge on a desktop or laptop). This browser does not offer it.');
  post('status', { phase: 'model', pct: 0, detail: 'Fetching the cloning model…' });
  var cb = progress();
  var r = await Promise.all([
    ChatterboxModel.from_pretrained(ID, { revision: REV, device: 'webgpu', dtype: 'q4f16', progress_callback: cb }),
    AutoProcessor.from_pretrained(ID, { revision: REV })
  ]);
  model = r[0]; processor = r[1];
  padEmbeddings(model.sessions.embed_tokens);
  post('ready', {});
}

async function reference(audio) {
  await load();
  post('status', { phase: 'session', pct: 100, detail: 'Listening to the reference voice…' });
  ref = await model.encode_speech(new Tensor('float32', audio, [1, audio.length]));
  post('referenced', { seconds: audio.length / SR });
}

// The generation loop of the model card's reference code, run on the four
// sessions transformers.js created. Not model.generate(): through it the
// same 27-word sentence stopped at 3.2 s, where this loop (and the Python
// reference on the same files) gives 5.8 s.
var lastTiming = null;
var START = 6561, STOP = 6562, SILENCE = 4299, PENALTY = 1.2, MAX_TOKENS = 1000;

async function synth(m) {
  await load();
  if (!ref) throw new Error('Record or choose a reference voice first.');
  var t0 = Date.now();
  var T = ref.audio_features.ort_tensor.constructor;   // onnxruntime's Tensor
  var S = model.sessions;
  // The reference tokenizer ends every text with two <|endoftext|> (50256);
  // embed_tokens sends the last two ids to the speech table, where 50256
  // becomes the speech start token.
  var ids = Array.from(processor.tokenizer(m.text, { add_special_tokens: false }).input_ids.data, Number);
  while (ids.length && ids[ids.length - 1] === 50256) ids.pop();
  ids.push(50256, 50256);

  var emb = (await S.embed_tokens.run({ input_ids: new T('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]) })).inputs_embeds;
  var cond = ref.audio_features.ort_tensor, D = cond.dims[2];
  var cat = new Float32Array((cond.dims[1] + emb.dims[1]) * D);
  cat.set(cond.data, 0); cat.set(emb.data, cond.dims[1] * D);
  var embeds = new T('float32', cat, [1, cond.dims[1] + emb.dims[1], D]);

  var past = {};
  S.model.inputNames.forEach(function (n) {
    if (n.indexOf('past_key_values') === 0) past[n] = new T('float16', new Uint16Array(0), [1, 16, 0, 64]);
  });
  var len = embeds.dims[1];
  var pos = BigInt64Array.from({ length: len }, function (_, i) { return BigInt(i); });
  var gen = [START], seen = {}; seen[START] = true;

  for (var step = 0; step < MAX_TOKENS; step++) {
    var feeds = { inputs_embeds: embeds, attention_mask: new T('int64', new BigInt64Array(len).fill(1n), [1, len]), position_ids: new T('int64', pos, [1, pos.length]) };
    for (var k in past) feeds[k] = past[k];
    var out = await S.model.run(feeds);
    for (var k2 in past) { var old = past[k2]; past[k2] = out[k2.replace('past_key_values', 'present')]; if (old.location === 'gpu-buffer') old.dispose(); }
    var lg = out.logits, V = lg.dims[2], base = (lg.dims[1] - 1) * V;
    var data = lg.location === 'gpu-buffer' ? await lg.getData(true) : lg.data;
    var best = 0, bv = -Infinity;
    for (var v = 0; v < V; v++) {
      var sc = data[base + v];
      if (seen[v]) sc = sc < 0 ? sc * PENALTY : sc / PENALTY;
      if (sc > bv) { bv = sc; best = v; }
    }
    gen.push(best); seen[best] = true;
    if (best === STOP) break;
    // [text pad, id, id]: see padEmbeddings.
    embeds = (await S.embed_tokens.run({ input_ids: new T('int64', BigInt64Array.of(BigInt(best)), [1, 1]) })).inputs_embeds;
    len += 1;
    pos = BigInt64Array.of(BigInt(len - 1));
  }
  for (var k3 in past) { if (past[k3].location === 'gpu-buffer') past[k3].dispose(); }

  var body = gen.slice(1, gen[gen.length - 1] === STOP ? -1 : gen.length);
  var tLm = Date.now() - t0;
  var samples = await decode(T, S, body);
  lastTiming = { lm: tLm, dec: Date.now() - t0 - tLm, tokens: body.length };
  return { samples: samples, tokens: body.length, ms: Date.now() - t0 };
}

// The decoder renders 960 samples (40 ms) per speech token. On WebGPU it
// cannot be given a whole sentence's tokens at once. Two faults, both
// measured by decoding tokens the browser generated (which the Python
// decoder turns into word-perfect speech) and transcribing with Whisper:
//   - past 65,535 output samples (2.73 s) the waveform is exact zeros, the
//     per-dimension workgroup limit;
//   - well before that, the words degrade with the number of new tokens in
//     one call: 12 or 16 tokens transcribe perfectly, 18-20 drop words, 25
//     changes them, 50 is gibberish. It does not depend on the reference
//     length (a 3 s reference behaved the same), so it is not total size.
// So the tokens are decoded in windows of WIN, each with the same reference
// prompt and speaker, overlapping by LAP tokens that are crossfaded. The
// browser's CPU build cannot run the decoder at all (no kernel for its
// quantised gather), so this is the way through.
var WIN = 12, LAP = 4, SPT = 960;
// Each window carries only the last PROMPT_KEEP reference tokens (and the
// matching speaker-feature frames, two per token): the decoder's cost grows
// with the prompt, every window pays it, and the speaker embedding carries
// the timbre either way. Measured in Python on the same tokens: 142, 60 and
// 30 prompt tokens all transcribe word for word, and 30 decodes 2.6x faster.
var PROMPT_KEEP = 30;
var promptCut = null;
function cutPrompt(T) {
  if (promptCut && promptCut.src === ref) return promptCut;
  var p = ref.audio_tokens.ort_tensor.data, f = ref.speaker_features.ort_tensor;
  var n = Math.min(PROMPT_KEEP, p.length), frames = Math.min(f.dims[1], 2 * n - 1), F = f.dims[2];
  var fd = f.data.slice((f.dims[1] - frames) * F);
  promptCut = { src: ref, tokens: p.slice(p.length - n), feat: new T('float32', fd, [1, frames, F]) };
  return promptCut;
}

async function decodeWindow(T, S, toks, last) {
  var cut = cutPrompt(T);
  var prompt = cut.tokens, n = prompt.length + toks.length + (last ? 3 : 0);
  var all = new BigInt64Array(n);
  all.set(prompt, 0);
  toks.forEach(function (t, i) { all[prompt.length + i] = BigInt(t); });
  if (last) for (var j = 0; j < 3; j++) all[prompt.length + toks.length + j] = BigInt(SILENCE);
  var wav = (await S.conditional_decoder.run({
    speech_tokens: new T('int64', all, [1, n]),
    speaker_embeddings: ref.speaker_embeddings.ort_tensor, speaker_features: cut.feat
  })).waveform;
  var w = wav.location === 'gpu-buffer' ? await wav.getData(true) : wav.data;
  return new Float32Array(w);
}
async function decode(T, S, body) {
  if (body.length <= WIN) return decodeWindow(T, S, body, true);
  var out = new Float32Array((body.length + 3) * SPT + SPT), filled = 0;
  for (var a = 0; a < body.length; a += WIN - LAP) {
    var b = Math.min(body.length, a + WIN), last = b === body.length;
    var w = await decodeWindow(T, S, body.slice(a, b), last);
    var at = a * SPT, fade = a === 0 ? 0 : LAP * SPT;
    for (var i = 0; i < w.length && at + i < out.length; i++) {
      if (i < fade) { var g = i / fade; out[at + i] = out[at + i] * (1 - g) + w[i] * g; }
      else out[at + i] = w[i];
    }
    filled = Math.max(filled, at + w.length);
    if (last) break;
  }
  return out.subarray(0, Math.min(filled, out.length)).slice();
}

self.onmessage = async function (e) {
  var m = e.data || {};
  try {
    if (m.type === 'load') await load();
    else if (m.type === 'reference') await reference(m.audio);
    else if (m.type === 'synth') {
      var r = await synth(m);
      post('audio', { seq: m.seq, samples: r.samples, tokens: r.tokens, ms: r.ms, timing: lastTiming }, [r.samples.buffer]);
    }
  } catch (err) {
    post('error', { seq: m.seq, message: (err && err.message) || String(err) });
  }
};
