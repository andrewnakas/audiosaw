/*
 * Source separation worker.
 *
 * Runs UVR-MDX-NET through onnxruntime-web to pull the vocal out of a mix; the
 * instrumental is what is left after subtracting it.
 *
 * Why this model and not Demucs: Demucs is the better-known name and its ONNX
 * export is 158 MB, which onnxruntime-web cannot load — session creation runs
 * for two minutes and then aborts inside the WASM heap. MDX-Net is 64 MB, loads
 * in about two seconds, and runs a six-second chunk in under three. It is the
 * same family of tool (it is what Ultimate Vocal Remover uses) and it is the
 * one that actually works in a browser.
 *
 * The model is spectral rather than waveform, so the audio has to be turned
 * into an STFT first:
 *
 *   input/output  float32 [1, 4, 3072, 256]
 *     4    = [left real, left imag, right real, right imag]
 *     3072 = frequency bins kept (of 3073 produced by a 6144-point FFT)
 *     256  = time frames at hop 1024
 *
 * That is 261,120 samples per chunk, just under six seconds at 44.1 kHz.
 */

/* global ort, ASSpectral */

// The worker is spawned as /js/stem-worker.js?v=<token>, so its own query
// string carries the site's asset version. Pass it on: /js/* is served
// immutable for a year, and an unversioned import here would pin a returning
// visitor's worker to whatever spectral.js it first cached.
var AS_V = (self.location.search || '').replace(/^\?/, '');
self.importScripts('/vendor/ort/ort.webgpu.min.js', '/js/spectral.js' + (AS_V ? '?' + AS_V : ''));

var MODEL_URL = 'https://huggingface.co/Politrees/UVR_resources/resolve/main/models/MDXNet/UVR-MDX-NET-Voc_FT.onnx';
var CACHE_NAME = 'audiosaw-models-v2';

var N_FFT = 6144;
var HOP = 1024;
var DIM_F = 3072;
var DIM_T = 256;
var CHUNK = HOP * (DIM_T - 1);      // 261120 samples
var BINS = N_FFT / 2 + 1;           // 3073
var SR = 44100;
// UVR applies a small make-up gain to this model's output; without it the
// subtracted instrumental keeps a faint vocal ghost.
var COMPENSATE = 1.021;

var session = null;
var spectral = null;

function post(type, payload) {
  var m = payload || {};
  m.type = type;
  self.postMessage(m);
}
function status(phase, pct, detail) { post('status', { phase: phase, pct: pct, detail: detail }); }

/* ------------------------------------------------------------ model fetch */

async function fetchModel() {
  var cache = null;
  try { cache = await caches.open(CACHE_NAME); } catch (e) { /* private browsing */ }

  if (cache) {
    var hit = await cache.match(MODEL_URL);
    if (hit) {
      status('model', 100, 'Model already downloaded');
      return new Uint8Array(await hit.arrayBuffer());
    }
  }

  status('model', 0, 'Downloading the model (64 MB, first time only)…');
  var res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error('Could not download the model (HTTP ' + res.status + ')');

  var total = parseInt(res.headers.get('content-length') || '0', 10);
  var reader = res.body.getReader();
  var chunks = [], received = 0;
  for (;;) {
    var r = await reader.read();
    if (r.done) break;
    chunks.push(r.value);
    received += r.value.length;
    status('model', total ? (received / total) * 100 : 0,
      'Downloading the model — ' + (received / 1048576).toFixed(0) +
      (total ? ' of ' + (total / 1048576).toFixed(0) : '') + ' MB');
  }
  var bytes = new Uint8Array(received);
  var off = 0;
  for (var i = 0; i < chunks.length; i++) { bytes.set(chunks[i], off); off += chunks[i].length; }

  if (cache) {
    try { await cache.put(MODEL_URL, new Response(bytes)); } catch (e) { /* quota */ }
  }
  return bytes;
}

async function ensureSession() {
  if (session) return session;

  ort.env.wasm.wasmPaths = '/vendor/ort/';
  ort.env.wasm.simd = true;
  ort.env.logLevel = 'error';

  var bytes = await fetchModel();
  status('session', 0, 'Starting the model…');

  // Prefer the GPU; fall back to WASM where WebGPU is missing or refuses.
  //
  // Threads are set per-path deliberately. On the WebGPU path the compute is on
  // the GPU, so a WASM thread pool buys nothing — and spinning one up inside an
  // already-nested worker stalls session creation for minutes. Only the CPU
  // fallback asks for threads.
  var used = 'wasm';
  if (navigator.gpu) {
    try {
      ort.env.wasm.numThreads = 1;
      session = await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu'] });
      used = 'webgpu';
    } catch (e) {
      session = null;
      post('note', { message: 'WebGPU unavailable (' + ((e && e.message) || e) + '), falling back to CPU' });
    }
  }
  if (!session) {
    // Threads matter enormously on this path: measured on the same machine, one
    // chunk takes ~140 s single-threaded and ~45 s on seven. They only work if
    // the page is cross-origin isolated AND /vendor/ort/* carries a COEP header,
    // because ORT spawns its pthread workers from those files.
    ort.env.wasm.numThreads = self.crossOriginIsolated
      ? Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1)) : 1;
    session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
  }

  spectral = new ASSpectral.Spectral(N_FFT, HOP);
  var threads = used === 'wasm' ? ort.env.wasm.numThreads : 0;
  post('ready', {
    backend: used,
    threads: threads,
    isolated: !!self.crossOriginIsolated,
    // Measured wall-clock cost per second of audio, so the page can warn about
    // a long wait before someone commits to one.
    costPerSecond: used === 'webgpu' ? 1.1 : (threads > 1 ? 10 : 31)
  });
  return session;
}

/* -------------------------------------------------------------- one chunk */

// Returns the vocal for this chunk, as [left, right].
async function runChunk(left, right) {
  var spec = spectral.forwardPair(left, right, DIM_T);

  // [1, 4, 3072, 256], channel order [L re, L im, R re, R im].
  var x = new Float32Array(4 * DIM_F * DIM_T);
  for (var b = 0; b < DIM_F; b++) {
    var o0 = (0 * DIM_F + b) * DIM_T;
    var o1 = (1 * DIM_F + b) * DIM_T;
    var o2 = (2 * DIM_F + b) * DIM_T;
    var o3 = (3 * DIM_F + b) * DIM_T;
    for (var f = 0; f < DIM_T; f++) {
      var s = f * BINS + b;
      x[o0 + f] = spec.lr[s];
      x[o1 + f] = spec.li[s];
      x[o2 + f] = spec.rr[s];
      x[o3 + f] = spec.ri[s];
    }
  }

  var out = await session.run({ input: new ort.Tensor('float32', x, [1, 4, DIM_F, DIM_T]) });
  var y = out.output.data;

  // Back to full-height spectra; the bin above DIM_F is left at zero, which is
  // what the model was trained against.
  var reL = new Float32Array(DIM_T * BINS), imL = new Float32Array(DIM_T * BINS);
  var reR = new Float32Array(DIM_T * BINS), imR = new Float32Array(DIM_T * BINS);
  for (var b2 = 0; b2 < DIM_F; b2++) {
    var p0 = (0 * DIM_F + b2) * DIM_T;
    var p1 = (1 * DIM_F + b2) * DIM_T;
    var p2 = (2 * DIM_F + b2) * DIM_T;
    var p3 = (3 * DIM_F + b2) * DIM_T;
    for (var f2 = 0; f2 < DIM_T; f2++) {
      var d = f2 * BINS + b2;
      reL[d] = y[p0 + f2] * COMPENSATE;
      imL[d] = y[p1 + f2] * COMPENSATE;
      reR[d] = y[p2 + f2] * COMPENSATE;
      imR[d] = y[p3 + f2] * COMPENSATE;
    }
  }

  return spectral.inversePair(reL, imL, reR, imR, DIM_T, CHUNK);
}

/* ------------------------------------------------------------- full track */

function ramp(len, edge) {
  var w = new Float32Array(len);
  for (var i = 0; i < len; i++) {
    var v = 1;
    if (i < edge) v = i / edge;
    else if (i >= len - edge) v = (len - 1 - i) / edge;
    w[i] = v;
  }
  return w;
}

async function separate(left, right) {
  await ensureSession();
  var n = left.length;
  var overlap = 0.25;
  var hop = Math.floor(CHUNK * (1 - overlap));
  var edge = Math.floor((CHUNK - hop) / 2) || 1;
  var win = ramp(CHUNK, edge);

  var vocL = new Float32Array(n), vocR = new Float32Array(n);
  var wsum = new Float32Array(n);

  var starts = [];
  for (var p = 0; p < n; p += hop) { starts.push(p); if (p + CHUNK >= n) break; }

  var inL = new Float32Array(CHUNK), inR = new Float32Array(CHUNK);
  var t0 = Date.now();

  for (var si = 0; si < starts.length; si++) {
    var start = starts[si];
    var count = Math.min(CHUNK, n - start);
    inL.fill(0); inR.fill(0);
    for (var i = 0; i < count; i++) { inL[i] = left[start + i]; inR[i] = right[start + i]; }

    var done = si / starts.length;
    var eta = si > 0 ? Math.round(((Date.now() - t0) / si) * (starts.length - si) / 1000) : null;
    status('separate', done * 100,
      'Separating — part ' + (si + 1) + ' of ' + starts.length +
      (eta !== null ? ' (about ' + (eta > 60 ? Math.ceil(eta / 60) + ' min' : eta + ' s') + ' left)' : ''));

    var voc = await runChunk(inL, inR);
    for (var k = 0; k < count; k++) {
      vocL[start + k] += voc[0][k] * win[k];
      vocR[start + k] += voc[1][k] * win[k];
      wsum[start + k] += win[k];
    }
    await new Promise(function (r) { setTimeout(r, 0); });
  }

  for (var j = 0; j < n; j++) {
    if (wsum[j] > 0.0001) { vocL[j] /= wsum[j]; vocR[j] /= wsum[j]; }
  }

  // Instrumental is the residual, which keeps the two exactly complementary.
  var insL = new Float32Array(n), insR = new Float32Array(n);
  for (var m2 = 0; m2 < n; m2++) {
    insL[m2] = left[m2] - vocL[m2];
    insR[m2] = right[m2] - vocR[m2];
  }

  return { vocals: [vocL, vocR], instrumental: [insL, insR] };
}

/* ---------------------------------------------------------------- routing */

self.onmessage = async function (e) {
  var msg = e.data || {};
  try {
    if (msg.type === 'warmup') {
      await ensureSession();
    } else if (msg.type === 'separate') {
      var r = await separate(msg.left, msg.right);
      self.postMessage({
        type: 'done', sampleRate: SR,
        vocals: r.vocals, instrumental: r.instrumental
      }, [
        r.vocals[0].buffer, r.vocals[1].buffer,
        r.instrumental[0].buffer, r.instrumental[1].buffer
      ]);
    }
  } catch (err) {
    post('error', { message: (err && err.message) || String(err) });
  }
};
