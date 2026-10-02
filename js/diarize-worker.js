/*
 * Speaker diarization worker: pyannote segmentation-3.0 (MIT, 6 MB) and
 * WeSpeaker ResNet34 (CC-BY-4.0, 26.5 MB), both through transformers.js 4.2.0
 * on the CPU (they are small; the whole of a three-minute file takes about
 * 19 s, nearly all of it embeddings). A module worker on the same vendored
 * runtime as transcribe-worker.js. The clustering is ASDiar (diarize.js).
 *
 * Protocol
 *   in : { type: 'run', audio: Float32Array (16 kHz mono), speakers: 0 | n }
 *   out: { type: 'status', pct, detail }
 *        { type: 'done', turns: [{ start, end, speaker }], speakers }
 *        { type: 'error', message }
 */

import { AutoProcessor, AutoModelForAudioFrameClassification, AutoFeatureExtractor, AutoModel, env } from '/vendor/transformers/transformers.min.js?v=4.2.0';

var AS_V = (/[?&]v=([^&]+)/.exec(self.location.search || '') || [])[1] || '';
var DIAR = import('/js/diarize.js' + (AS_V ? '?v=' + AS_V : '')).then(function () { return self.ASDiar; });

var VENDOR = '/vendor/transformers/';
var SEG = { id: 'onnx-community/pyannote-segmentation-3.0', rev: '733a93b6473d019a773298e08cefa686894b1854' };
var EMB = { id: 'onnx-community/wespeaker-voxceleb-resnet34-LM', rev: '6a61a1833ff2583aabeba044f5c8221f00b67ceb' };
var SR = 16000, MAX_EMB_S = 10;

env.allowLocalModels = false;
env.useBrowserCache = true;
var isSafari = /^((?!chrome|android|crios|fxios).)*safari/i.test(self.navigator.userAgent || '');
env.backends.onnx.wasm.wasmPaths = isSafari
  ? { mjs: VENDOR + 'ort-wasm-simd-threaded.mjs?v=1.26.0-dev.20260416', wasm: VENDOR + 'ort-wasm-simd-threaded.wasm?v=1.26.0-dev.20260416' }
  : { mjs: VENDOR + 'ort-wasm-simd-threaded.asyncify.mjs?v=1.26.0-dev.20260416', wasm: VENDOR + 'ort-wasm-simd-threaded.asyncify.wasm?v=1.26.0-dev.20260416' };
env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(8, (self.navigator.hardwareConcurrency || 4) - 1)) : 1;

function post(type, m) { m = m || {}; m.type = type; self.postMessage(m); }

var models = null;
function load() {
  if (!models) {
    post('status', { pct: 0, detail: 'Loading the speaker models (33 MB, once)…' });
    models = Promise.all([
      AutoProcessor.from_pretrained(SEG.id, { revision: SEG.rev }),
      AutoModelForAudioFrameClassification.from_pretrained(SEG.id, { revision: SEG.rev, dtype: 'fp32', device: 'wasm' }),
      AutoFeatureExtractor.from_pretrained(EMB.id, { revision: EMB.rev }),
      AutoModel.from_pretrained(EMB.id, { revision: EMB.rev, dtype: 'fp32', device: 'wasm' })
    ]).then(function (r) { return { segProc: r[0], seg: r[1], fe: r[2], emb: r[3] }; });
    models.catch(function () { models = null; });
  }
  return models;
}

async function run(m) {
  var M = await load(), D = await DIAR, audio = m.audio;
  post('status', { pct: 5, detail: 'Finding where each person speaks…' });
  var inputs = await M.segProc(audio);
  var logits = (await M.seg(inputs)).logits;
  var segs = M.segProc.post_process_speaker_diarization(logits, audio.length)[0];
  var all = D.turns(segs);
  var long = all.filter(function (t) { return t.end - t.start >= D.MIN_TURN; });
  if (!long.length) { post('done', { turns: all.map(function (t) { return { start: t.start, end: t.end, speaker: 1 }; }), speakers: all.length ? 1 : 0 }); return; }
  for (var i = 0; i < long.length; i++) {
    var t = long[i];
    var a = audio.subarray(Math.floor(t.start * SR), Math.min(audio.length, Math.floor(Math.min(t.end, t.start + MAX_EMB_S) * SR)));
    var out = await M.emb(await M.fe(a));
    t.emb = Float32Array.from(Object.values(out)[0].data);
    if (i % 5 === 0) post('status', { pct: 10 + 85 * i / long.length, detail: 'Telling the voices apart… ' + (i + 1) + ' of ' + long.length + ' turns' });
  }
  var labels = D.cluster(long, { speakers: m.speakers || 0 });
  var labelled = D.labelTurns(all, long, labels);
  post('done', { turns: labelled, speakers: Math.max.apply(null, labels) });
}

self.onmessage = async function (e) {
  var m = e.data || {};
  try { if (m.type === 'run') await run(m); }
  catch (err) { post('error', { message: (err && err.message) || String(err) }); }
};
