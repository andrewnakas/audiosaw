/*
 * Speech-to-text worker for /audio-to-text: OpenAI's Whisper, run through
 * transformers.js on ONNX Runtime Web. A module worker, because the library is
 * an ES module.
 *
 * The version is pinned, and the pin is the whole lesson of the spike
 * (docs/growth-playbook.md §11):
 *
 *   - transformers.js 4.2.0, not 4.3.0. 4.3.0 needs an ORT asyncify wasm of
 *     26.9 MB, over Cloudflare Pages' 25 MiB file limit, and it does not fall
 *     back to a smaller build. It cannot come from a CDN either: this page is
 *     cross-origin isolated and jsDelivr's response is refused.
 *   - q4 weights. q8, int8 and fp16 fail on the CPU path on ORT 1.26 with
 *     "TransposeDQWeightsForMatMulNBits Missing required scale". WebGPU uses
 *     q4 too, so both backends share one set of files (see DTYPE).
 *
 * Re-test both backends before moving either version.
 *
 * Protocol
 *   in : { type: 'load', model }
 *        { type: 'run', audio: Float32Array (16 kHz mono), language, task }
 *   out: { type: 'status', phase: 'model'|'session'|'run', pct, detail }
 *        { type: 'ready', backend, threads, model }
 *        { type: 'partial', text }
 *        { type: 'done', segments: [{ text, start, end }], text, language,
 *          words: [{ text, start, end }] (only with msg.words: a
 *          _timestamped model, whose cross-attentions give word times) }
 *        { type: 'error', message }
 */

import { pipeline, env, WhisperTextStreamer } from '/vendor/transformers/transformers.min.js?v=4.2.0';

var VENDOR = '/vendor/transformers/';
var SR = 16000;
var CHUNK_S = 30;
var STRIDE_S = 5;

env.allowLocalModels = false;
env.useBrowserCache = true;

// The page spawns this as transcribe-worker.js?v=<token>[&backend=wasm][&safe=1].
//   backend=wasm  skip WebGPU (the URL switch /audio-to-text?backend=wasm);
//   safe=1        the page's one retry after a model failed to load for a
//                 reason other than the network: the plain wasm build on one
//                 thread, no WebGPU. It has to be a new worker, because ORT
//                 remembers a failed initWasm() and refuses every later one.
var QS = new URLSearchParams(self.location.search);
var SAFE = QS.get('safe') === '1';
var FORCE_WASM = SAFE || QS.get('backend') === 'wasm';

// The asyncify build does not run on WebKit. Every browser on iOS is WebKit,
// whatever its name: Chrome (CriOS) and Firefox (FxiOS) on an iPhone used to
// slip past a Safari-only test and get the asyncify build.
var UA = self.navigator.userAgent || '';
var isWebKit = /^((?!chrome|android|crios|fxios).)*safari/i.test(UA) || /iPhone|iPad|iPod|CriOS|FxiOS|EdgiOS/.test(UA);
env.backends.onnx.wasm.wasmPaths = isWebKit || SAFE
  ? { mjs: VENDOR + 'ort-wasm-simd-threaded.mjs?v=1.26.0-dev.20260416', wasm: VENDOR + 'ort-wasm-simd-threaded.wasm?v=1.26.0-dev.20260416' }
  : { mjs: VENDOR + 'ort-wasm-simd-threaded.asyncify.mjs?v=1.26.0-dev.20260416', wasm: VENDOR + 'ort-wasm-simd-threaded.asyncify.wasm?v=1.26.0-dev.20260416' };

// Model files are 80-220 MB, and a download that drops near the end used to
// start again from zero: measured on a slow link, the base decoder failed at
// 67 of 117 MB, twice. This fetch hands transformers.js a stream that, when the
// connection breaks, asks for the rest with a Range request and carries on, so
// the library (and its cache) only ever sees one complete response.
var plainFetch = self.fetch.bind(self);
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function resumableFetch(url, init) {
  return plainFetch(url, init).then(function (res) {
    var total = +res.headers.get('content-length') || 0;
    if (!res.ok || !res.body || res.status !== 200 || total < 4 * 1048576) return res;
    var resumeUrl = res.url || url;     // the signed CDN URL after redirects
    var reader = res.body.getReader();
    var got = 0, fails = 0;
    var stream = new ReadableStream({
      pull: async function (ctrl) {
        for (;;) {
          try {
            var r = await reader.read();
            if (r.done) {
              if (got < total) throw new Error('connection closed at ' + got + ' of ' + total);
              ctrl.close();
              return;
            }
            got += r.value.byteLength;
            fails = 0;
            ctrl.enqueue(r.value);
            return;
          } catch (e) {
            if (++fails > 6) { ctrl.error(e); return; }
            await sleep(1000 * fails);
            try {
              var rr = await plainFetch(fails > 3 ? url : resumeUrl, { headers: { Range: 'bytes=' + got + '-' } });
              if (rr.status === 206 && rr.body) reader = rr.body.getReader();
              // A 200 would restart from byte 0 and corrupt the file; let the
              // next failure count against the limit instead.
            } catch (e2) { /* try again */ }
          }
        }
      },
      cancel: function (why) { try { reader.cancel(why); } catch (e) {} }
    });
    return new Response(stream, { status: res.status, statusText: res.statusText, headers: res.headers });
  });
}
env.fetch = resumableFetch;

// Threads need SharedArrayBuffer, which needs the page to be cross-origin
// isolated. Leave one core for the page.
var THREADS = self.crossOriginIsolated && !SAFE
  ? Math.max(1, Math.min(8, (self.navigator.hardwareConcurrency || 4) - 1))
  : 1;
env.backends.onnx.wasm.numThreads = THREADS;

// Same weights on both backends, so a WebGPU session that fails falls back to
// the CPU without downloading anything again. See the measurement in CLAUDE.md.
var DTYPE = { webgpu: 'q4', wasm: 'q4' };

var transcriber = null;
var loaded = { model: null, backend: null };

function post(type, payload) {
  var m = payload || {};
  m.type = type;
  self.postMessage(m);
}

async function gpuOK() {
  if (FORCE_WASM) return false;
  try {
    if (!self.navigator.gpu) return false;
    var a = await self.navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    return !!a;
  } catch (e) { return false; }
}

// One byte-weighted bar across every file the model needs, rather than a bar
// that runs to 100% once per file.
function makeProgress() {
  var files = {};
  return function (p) {
    if (!p || !p.file) return;
    if (p.status === 'progress' || p.status === 'download') {
      if (!files[p.file]) post('file', { file: p.file, total: p.total || 0 });
      files[p.file] = { loaded: p.loaded || 0, total: p.total || files[p.file] && files[p.file].total || 0 };
    } else if (p.status === 'done' && files[p.file]) {
      files[p.file].loaded = files[p.file].total;
    } else return;
    var l = 0, t = 0;
    for (var k in files) { l += files[k].loaded; t += files[k].total; }
    if (!t) return;
    post('status', {
      phase: 'model',
      pct: Math.min(100, l / t * 100),
      detail: 'Downloading the speech model… ' + (l / 1048576).toFixed(0) + ' of ' + (t / 1048576).toFixed(0) + ' MB (once, then cached)'
    });
  };
}

// 'load' (sent while the page decodes) and 'run' both ask for the model, and
// messages are handled concurrently, so share one in-flight load.
var loading = null;
function load(model) {
  if (loading && loading.model === model) return loading.p;
  loading = { model: model, p: doLoad(model) };
  loading.p.catch(function () { loading = null; });
  return loading.p;
}

async function doLoad(model) {
  if (transcriber && loaded.model === model) return;
  if (transcriber) { try { await transcriber.dispose(); } catch (e) {} transcriber = null; }

  var useGpu = await gpuOK();
  var progress = makeProgress();
  post('status', { phase: 'model', pct: 0, detail: 'Fetching the speech model…' });

  function isNetwork(e) {
    return /network|fetch|Load failed|ERR_|timed? ?out/i.test(String(e && e.message || e));
  }

  // A download that drops is not a GPU problem. Completed files are already
  // in the browser cache, so retrying on the same device only fetches what
  // was missing. Treating it as a GPU failure, as the first version did, sent
  // a slow connection on to download a second encoder for the CPU.
  async function make(device) {
    var opts = { progress_callback: progress, device: device };
    opts.dtype = DTYPE[device];
    for (var attempt = 0; ; attempt++) {
      try {
        return await pipeline('automatic-speech-recognition', model, opts);
      } catch (e) {
        if (!isNetwork(e) || attempt >= 2) throw e;
        post('status', { phase: 'model', pct: 0, detail: 'The download was interrupted — resuming…' });
        await new Promise(function (r) { setTimeout(r, 2000 * (attempt + 1)); });
      }
    }
  }

  if (useGpu) {
    try {
      transcriber = await make('webgpu');
      loaded.backend = 'webgpu';
    } catch (e) {
      if (isNetwork(e)) {
        throw new Error('The model download kept failing. Check the connection and press Transcribe again — the parts that finished are saved, so it picks up from there.');
      }
      // A browser can hand back an adapter and still fail to build the
      // session (driver blocklist, out of GPU memory). The CPU path is slower
      // but gives the same words.
      post('note', { message: 'WebGPU failed (' + (e && e.message || e) + '); using the CPU.' });
      transcriber = null;
    }
  }
  if (!transcriber) {
    try {
      transcriber = await make('wasm');
    } catch (e) {
      if (isNetwork(e)) {
        throw new Error('The model download kept failing. Check the connection and press Transcribe again — the parts that finished are saved, so it picks up from there.');
      }
      throw e;
    }
    loaded.backend = 'wasm';
  }
  loaded.model = model;
  post('ready', { backend: loaded.backend, threads: loaded.backend === 'wasm' ? THREADS : 0, model: model });
}

function chunkCount(n) {
  var win = SR * CHUNK_S, jump = win - 2 * SR * STRIDE_S;
  if (n <= win) return 1;
  return Math.ceil((n - win) / jump) + 1;
}

async function run(msg) {
  var audio = msg.audio;
  var total = chunkCount(audio.length);
  var done = 0;
  var started = Date.now();
  post('status', { phase: 'run', pct: 0, detail: 'Listening… part 1 of ' + total });

  // The pipeline runs one generate() per 30-second window and calls the
  // streamer's end() after each, which is the only progress signal it gives.
  var streamer = new WhisperTextStreamer(transcriber.tokenizer, {
    skip_prompt: true,
    callback_function: function (text) { if (text) post('partial', { text: text }); },
    on_finalize: function () {
      done = Math.min(total, done + 1);
      var pct = done / total * 100;
      var el = (Date.now() - started) / 1000;
      var eta = done ? el / done * (total - done) : 0;
      post('status', {
        phase: 'run', pct: pct,
        detail: done < total
          ? 'Listening… part ' + (done + 1) + ' of ' + total + (done ? ' — about ' + fmt(eta) + ' left' : '')
          : 'Finishing…'
      });
    }
  });

  var opts = {
    chunk_length_s: CHUNK_S,
    stride_length_s: STRIDE_S,
    return_timestamps: msg.words ? 'word' : true,
    streamer: streamer
  };
  if (msg.language && msg.language !== 'auto') opts.language = msg.language;
  if (msg.task === 'translate') opts.task = 'translate';

  var out = await transcriber(audio, opts);
  var chunks = (out.chunks || []).map(function (c) {
    return { text: c.text, start: c.timestamp ? c.timestamp[0] : null, end: c.timestamp ? c.timestamp[1] : null };
  });
  if (!msg.words) { post('done', { segments: chunks, text: out.text || '', seconds: (Date.now() - started) / 1000 }); return; }
  // Word mode: the chunks are words. Phrases are rebuilt from them, cut at a
  // sentence end, a pause over 0.6 s, or about two subtitle lines of text.
  // Whisper's cross-attention word times run late: measured on 18 words at
  // known positions (two voices, check-subtitles), every start 120-340 ms
  // after the truth, median 280-300. Moving them all 0.26 s earlier leaves
  // each within about 0.15 s.
  var WORD_LEAD = 0.26;
  var words = chunks.filter(function (w) { return w.text && w.text.trim(); }).map(function (w) {
    var s = w.start == null ? null : Math.max(0, w.start - WORD_LEAD), e = w.end == null ? null : Math.max(0, w.end - WORD_LEAD);
    if (s != null && e != null && e < s + 0.05) e = s + 0.05;
    return { text: w.text, start: s, end: e };
  });
  var segs = [], cur = null;
  words.forEach(function (w, i) {
    var gap = cur && w.start != null && cur.end != null ? w.start - cur.end : 0;
    if (!cur || gap > 0.6 || cur.text.length > 80) { cur = { text: '', start: w.start, end: w.end }; segs.push(cur); }
    cur.text += w.text; cur.end = w.end;
    if (/[.!?…]["'”’)]*\s*$/.test(w.text)) cur = null;
  });
  segs.forEach(function (s) { s.text = s.text.trim(); });
  post('done', { segments: segs, words: words, text: out.text || '', seconds: (Date.now() - started) / 1000 });
}

function fmt(s) {
  if (s < 90) return Math.round(s) + ' s';
  return Math.round(s / 60) + ' min';
}

// A failed 'load' is not reported: the 'run' that follows waits on the same
// load and reports it. Reporting both counted every failure twice.
// stage says whether the model never loaded ('load') or the run itself
// failed ('run'); the page retries a non-network 'load' failure once in a
// safe worker.
self.onmessage = async function (e) {
  var m = e.data || {};
  var stage = 'load';
  try {
    if (m.type === 'load') await load(m.model).catch(function () {});
    else if (m.type === 'run') {
      await load(m.model);
      stage = 'run';
      await run(m);
    }
  } catch (err) {
    var message = (err && err.message) || String(err);
    post('error', { message: message, name: err && err.name, stage: stage, network: /download kept failing/.test(message), safe: SAFE });
  }
};
