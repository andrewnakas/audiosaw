/*
 * Text-to-speech worker: Kokoro-82M (hexgrad, Apache-2.0) through ONNX
 * Runtime Web 1.22, the copy the stem splitter already vendors.
 *
 * Not transformers.js, deliberately. Its pinned 4.2.0 brings ORT 1.26, whose
 * CPU path rejects q8 and fp16 weights (playbook §11), and Kokoro's q4 export
 * is 305 MB because only the matmuls are quantised. Kokoro is a single ONNX
 * graph with three inputs, so the runtime alone is enough.
 *
 * Which weights, measured on 1 Oct 2026 (headless Chrome, Apple GPU, 8 cores):
 *
 *   WebGPU + fp32 (326 MB)   correct; 0.7x the speech's length on an idle
 *                            machine, 1.1x with other work running
 *   WebGPU + fp16 (163 MB)   WRONG inside a worker: speech of the wrong length,
 *                            one voice silent, the speed input ignored. It
 *                            looked fine on the main thread, which is how the
 *                            spike missed it; kokoro-js also uses fp32 on GPU.
 *   WebGPU + q8              correct, but no faster than WASM: its quantised
 *                            ops run on the CPU
 *   WASM, 7 threads + q8 (92 MB)   ~2.6x idle, ~6x under load
 *
 * So the GPU gets fp32 and the CPU gets q8, and a GPU session that fails to
 * build falls back to the CPU file. ?backend=wasm (the page's "smaller
 * download" choice) skips the GPU and its 326 MB entirely.
 *
 * Phonemes come from espeak-ng compiled to wasm: the `phonemizer` package
 * (Apache-2.0, 1.3 MB, English only) for the English voices, and the full
 * build (espeak-ng 1.0.2 npm, GPL-3.0, 17.6 MB, every language) only when a
 * Spanish, French, Italian, Portuguese or Hindi voice is used. Both are ES
 * modules, loaded with import() into this classic worker because ORT's build
 * here is a classic script.
 *
 * The full build runs espeak's command line once per text run. Its wasm is
 * compiled once and each run instantiates it afresh (about 50 ms). The text
 * goes in as a UTF-8 file with -f: passed as an argument, every accented
 * character came out as Latin-1 garbage ("cómo" read as "circumflex").
 *
 * Protocol
 *   in : { type: 'load' }
 *        { type: 'synth', job, seq, text, lang, mix: [{ id, w }], speed }
 *        { type: 'cancel', job }
 *   out: { type: 'status', phase: 'model'|'session', pct, detail }
 *        { type: 'ready', backend, threads, isolated }
 *        { type: 'audio', job, seq, samples: Float32Array, phonemes, ms }
 *        { type: 'error', job, seq, message }
 */

/* global ort, ASTTS */

// The page spawns this as /js/tts-worker.js?v=<token>[&backend=wasm]. The
// token versions the engine import (/js/* is immutable for a year); backend
// forces the CPU path for tools/check-tts.js and for anyone whose GPU path
// misbehaves (/text-to-speech?backend=wasm).
var Q = self.location.search || '';
var AS_V = (/[?&]v=([^&]+)/.exec(Q) || [])[1] || '';
var FORCE = (/[?&]backend=(wasm|webgpu)/.exec(Q) || [])[1] || '';
var PHMODE = (/[?&]ph=(en|misaki|plain)\b/.exec(Q) || [])[1] || '';   // measurement only
self.importScripts('/vendor/ort/ort.webgpu.min.js', '/js/tts-engine.js' + (AS_V ? '?v=' + AS_V : ''));

var REPO = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/';
var MODELS = {
  webgpu: { url: REPO + 'onnx/model.onnx', mb: 326 },
  wasm: { url: REPO + 'onnx/model_quantized.onnx', mb: 92 }
};
var CACHE_NAME = 'audiosaw-models-v2';

var session = null;
var backend = null;
var phon = null;
var voices = {};
var cancelled = {};

function post(type, payload, transfer) {
  var m = payload || {};
  m.type = type;
  self.postMessage(m, transfer || []);
}
function status(phase, pct, detail) { post('status', { phase: phase, pct: pct, detail: detail }); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* ------------------------------------------------------------ downloads */

// Reads a response to the end, and when the connection drops part-way asks
// for the rest with a Range request (Hugging Face's CDN answers 206 with
// CORS). The same approach as transcribe-worker.js's resumableFetch: a slow
// link used to fail a 100 MB model near the end and start over from zero.
async function readAll(url, onBytes) {
  var res = await fetch(url);
  if (!res.ok) throw new Error('Could not download the voice model (HTTP ' + res.status + ')');
  var total = +res.headers.get('content-length') || 0;
  var resumeUrl = res.url || url;
  var reader = res.body.getReader();
  var chunks = [], got = 0, fails = 0;
  for (;;) {
    try {
      var r = await reader.read();
      if (r.done) {
        if (total && got < total) throw new Error('connection closed at ' + got + ' of ' + total);
        break;
      }
      chunks.push(r.value);
      got += r.value.byteLength;
      fails = 0;
      if (onBytes) onBytes(got, total);
    } catch (e) {
      if (!total || ++fails > 6) throw new Error('The model download kept failing. Check the connection and try again — it resumes where it stopped.');
      await sleep(1000 * fails);
      try {
        var rr = await fetch(fails > 3 ? url : resumeUrl, { headers: { Range: 'bytes=' + got + '-' } });
        // A 200 would restart from byte 0 and corrupt the file; only a 206
        // continues, anything else counts as another failure.
        if (rr.status === 206 && rr.body) reader = rr.body.getReader();
      } catch (e2) { /* next attempt */ }
    }
  }
  var bytes = new Uint8Array(got), off = 0;
  for (var i = 0; i < chunks.length; i++) { bytes.set(chunks[i], off); off += chunks[i].byteLength; }
  return bytes;
}

async function cached(url, onBytes) {
  var cache = null;
  try { cache = await caches.open(CACHE_NAME); } catch (e) { /* private browsing */ }
  if (cache) {
    var hit = await cache.match(url);
    if (hit) return new Uint8Array(await hit.arrayBuffer());
  }
  var bytes = await readAll(url, onBytes);
  if (cache) { try { await cache.put(url, new Response(bytes)); } catch (e) { /* quota */ } }
  return bytes;
}

function fetchModel(which) {
  var m = MODELS[which];
  status('model', 0, 'Downloading the voice model (' + m.mb + ' MB, first time only)…');
  return cached(m.url, function (got, total) {
    status('model', total ? got / total * 100 : 0,
      'Downloading the voice model — ' + (got / 1048576).toFixed(0) + ' of ' + (total ? (total / 1048576).toFixed(0) : m.mb) + ' MB (once, then cached)');
  });
}

async function voiceTable(id) {
  if (voices[id]) return voices[id];
  if (!ASTTS.voice(id)) throw new Error('Unknown voice ' + id);
  var bytes = await cached(REPO + 'voices/' + id + '.bin');
  var t = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  if (t.length !== ASTTS.STYLE_ROWS * ASTTS.STYLE_DIM) throw new Error('Voice file ' + id + ' is the wrong size');
  voices[id] = t;
  return t;
}

/* ------------------------------------------------------------- session */

async function gpuOK() {
  try {
    if (!self.navigator.gpu) return false;
    return !!(await self.navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }));
  } catch (e) { return false; }
}

var loading = null;
function load() {
  if (!loading) {
    loading = doLoad();
    loading.catch(function () { loading = null; });
  }
  return loading;
}

async function doLoad() {
  ort.env.wasm.wasmPaths = '/vendor/ort/';
  ort.env.logLevel = 'error';

  var phonP = import('/vendor/phonemizer/phonemizer.js?v=1.2.1').then(function (m) { phon = m; });

  if (FORCE !== 'wasm' && await gpuOK()) {
    try {
      var gbytes = await fetchModel('webgpu');
      status('session', 0, 'Starting the voice model on your GPU…');
      // A WASM thread pool buys nothing when the GPU does the work, and
      // starting one inside a nested worker stalls session creation (the
      // stem splitter found this first).
      ort.env.wasm.numThreads = 1;
      session = await ort.InferenceSession.create(gbytes, { executionProviders: ['webgpu'] });
      backend = 'webgpu';
    } catch (e) {
      if (/download/i.test(String(e && e.message))) throw e;
      session = null;
      post('note', { message: 'WebGPU unavailable (' + ((e && e.message) || e) + '); using the CPU.' });
    }
  }
  if (!session) {
    var cbytes = await fetchModel('wasm');
    status('session', 0, 'Starting the voice model…');
    // Threads need the page to be cross-origin isolated and /vendor/ort/* to
    // carry COEP (see _headers); without either, one thread.
    ort.env.wasm.numThreads = self.crossOriginIsolated
      ? Math.max(1, Math.min(8, (self.navigator.hardwareConcurrency || 4) - 1)) : 1;
    session = await ort.InferenceSession.create(cbytes, { executionProviders: ['wasm'] });
    backend = 'wasm';
  }
  await phonP;
  post('ready', { backend: backend, threads: backend === 'wasm' ? ort.env.wasm.numThreads : 0, isolated: !!self.crossOriginIsolated });
}

/* ----------------------------------------------------------- synthesis */

var espeak = null;
function fullEspeak() {
  if (!espeak) {
    espeak = Promise.all([
      import('/vendor/espeak/espeak-ng.js?v=1.0.2'),
      WebAssembly.compileStreaming(fetch('/vendor/espeak/espeak-ng.wasm?v=1.0.2'))
    ]).then(function (r) { return { make: r[0].default, mod: r[1] }; });
    espeak.catch(function () { espeak = null; });
  }
  return espeak;
}

async function espeakRun(text, lang) {
  var e = await fullEspeak();
  var m = await e.make({
    // --ipa=1 marks tied phonemes with U+0361, which fixPhonemes folds
    // ('misaki') or drops.
    arguments: ['--phonout', 'out', '-q', '-b', '1', '--ipa=1', '-v', lang, '-f', 'in.txt'],
    preRun: [function (M) { M.FS.writeFile('in.txt', text); }],
    instantiateWasm: function (imports, cb) { WebAssembly.instantiate(e.mod, imports).then(function (i) { cb(i); }); return {}; },
    print: function () {}, printErr: function () {}
  });
  return m.FS.readFile('out', { encoding: 'utf8' }).replace(/\s+/g, ' ').trim();
}

function phonemizeRun(text, lang) {
  if (!/\S/.test(text)) return Promise.resolve(text);
  if (!/^en/.test(lang)) return espeakRun(text, lang);
  return phon.phonemize(text, lang).then(function (a) { return a.join(' '); });
}

async function synth(m) {
  await load();
  var tables = await Promise.all(m.mix.map(function (v) { return voiceTable(v.id); }));
  var table = ASTTS.mixTables(tables, m.mix.map(function (v) { return v.w; }));
  var t0 = Date.now();
  var ph = await ASTTS.phonemize(m.text, m.lang || 'en-us', phonemizeRun, PHMODE);
  var ids = ASTTS.tokenize(ph);
  if (ids.length <= 2) return { samples: new Float32Array(0), phonemes: ph, ms: 0 };
  var feeds = {
    input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    style: new ort.Tensor('float32', ASTTS.styleRow(table, ids.length), [1, ASTTS.STYLE_DIM]),
    speed: new ort.Tensor('float32', new Float32Array([m.speed || 1]), [1])
  };
  var out = await session.run(feeds);
  var w = out[session.outputNames[0]].data;
  var samples = new Float32Array(w.length);
  samples.set(w);
  return { samples: samples, phonemes: ph, ms: Date.now() - t0 };
}

// One sentence at a time, in order. A cancelled job's queued chunks are
// skipped without running.
var queue = Promise.resolve();

self.onmessage = function (e) {
  var m = e.data || {};
  if (m.type === 'load') {
    load().catch(function (err) { post('error', { message: (err && err.message) || String(err) }); });
  } else if (m.type === 'cancel') {
    cancelled[m.job] = true;
  } else if (m.type === 'synth') {
    queue = queue.then(async function () {
      if (cancelled[m.job]) return;
      try {
        var r = await synth(m);
        if (cancelled[m.job]) return;
        post('audio', { job: m.job, seq: m.seq, samples: r.samples, phonemes: r.phonemes, ms: r.ms }, [r.samples.buffer]);
      } catch (err) {
        post('error', { job: m.job, seq: m.seq, message: (err && err.message) || String(err) });
      }
    });
  }
};
