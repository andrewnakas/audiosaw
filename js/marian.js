/*
 * ASMarian — MarianMT (OPUS-MT) generation on raw ONNX Runtime sessions.
 * UMD; translate-worker.js runs it with the vendored ORT 1.22.
 *
 * Why not transformers.js's own pipeline: its runtime (ORT 1.26) refuses
 * every 8-bit OPUS-MT export ("TransposeDQWeightsForMatMulNBits Missing
 * required scale"), the regression that pinned Whisper to q4, and the q4
 * files are 300 MB a language pair against 113. ORT 1.22 loads the 8-bit
 * ones, so this is the decode loop transformers.js would have run: an
 * encoder pass, then the merged decoder with its key/value cache.
 *
 * Measured on a how-to script: given two sentences at once, the model dropped
 * one, so text goes in a sentence at a time (`sentences`). Beam search (4,
 * the models' own default) against greedy was a wash on wording and 2-4x
 * the time; the worker uses 4 because the models were tuned with it. Run
 * by tools/check-translate.js.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ASMarian = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Sentences, so a long line is never one long input: Marian drops or
  // merges sentences when given several at once. Keeps the punctuation.
  function sentences(text) {
    var s = String(text || '').replace(/\s+/g, ' ').trim();
    if (!s) return [];
    var out = s.match(/[^.!?…]+(?:[.!?…]+["'”’)\]]*|$)\s*/g) || [s];
    return out.map(function (x) { return x.trim(); }).filter(Boolean);
  }

  function logSoftmax(lg, off, V, skip) {
    var m = -Infinity, k;
    for (k = 0; k < V; k++) if (k !== skip && lg[off + k] > m) m = lg[off + k];
    var s = 0;
    for (k = 0; k < V; k++) if (k !== skip) s += Math.exp(lg[off + k] - m);
    return m + Math.log(s);
  }

  // cfg: { ort, enc, dec, layers, heads, headDim, start, eos, pad }
  // ids: the source token ids (the target tag first, then the text, then
  // </s>). Returns the output ids, without start or end.
  async function generate(cfg, ids, opts) {
    opts = opts || {};
    var ort = cfg.ort, beams = opts.beams || 4, maxNew = opts.maxNew || Math.min(256, ids.length * 3 + 10);
    var i64 = function (a) { return new ort.Tensor('int64', BigInt64Array.from(a.map(function (x) { return BigInt(x); })), [1, a.length]); };
    var mask = i64(ids.map(function () { return 1; }));
    var hidden = (await cfg.enc.run({ input_ids: i64(ids), attention_mask: mask })).last_hidden_state;
    var empty = new ort.Tensor('float32', new Float32Array(0), [1, cfg.heads, 0, cfg.headDim]);
    var encPast = null;

    function feeds(tok, past, first) {
      var f = { input_ids: i64([tok]), encoder_attention_mask: mask, encoder_hidden_states: hidden, use_cache_branch: new ort.Tensor('bool', [!first], [1]) };
      for (var l = 0; l < cfg.layers; l++) ['key', 'value'].forEach(function (kv) {
        f['past_key_values.' + l + '.decoder.' + kv] = past ? past[l][kv] : empty;
        f['past_key_values.' + l + '.encoder.' + kv] = encPast ? encPast[l][kv] : empty;
      });
      return f;
    }
    function presents(o) {
      var p = [], e = [];
      for (var l = 0; l < cfg.layers; l++) {
        p.push({ key: o['present.' + l + '.decoder.key'], value: o['present.' + l + '.decoder.value'] });
        e.push({ key: o['present.' + l + '.encoder.key'], value: o['present.' + l + '.encoder.value'] });
      }
      return { dec: p, enc: e };
    }

    var live = [{ toks: [], score: 0, past: null, last: cfg.start }], done = [];
    for (var step = 0; step < maxNew && live.length; step++) {
      var cand = [];
      for (var b = 0; b < live.length; b++) {
        var bm = live[b];
        var o = await cfg.dec.run(feeds(bm.last, bm.past, step === 0));
        var pr = presents(o);
        if (step === 0) encPast = pr.enc;
        var lg = o.logits.data, V = o.logits.dims[2], z = logSoftmax(lg, 0, V, cfg.pad);
        // The top `beams` tokens of this beam.
        var top = [];
        for (var k = 0; k < V; k++) {
          if (k === cfg.pad) continue;
          var v = lg[k];
          if (top.length < beams) { top.push([k, v]); top.sort(function (x, y) { return y[1] - x[1]; }); }
          else if (v > top[beams - 1][1]) { top[beams - 1] = [k, v]; top.sort(function (x, y) { return y[1] - x[1]; }); }
        }
        top.forEach(function (t) { cand.push({ parent: bm, tok: t[0], score: bm.score + t[1] - z, past: pr.dec }); });
        if (step === 0) break;   // every beam starts identical
      }
      cand.sort(function (x, y) { return y.score - x.score; });
      live = [];
      for (var c = 0; c < cand.length && live.length < beams; c++) {
        var x = cand[c], toks = x.parent.toks.concat(x.tok === cfg.eos ? [] : [x.tok]);
        if (x.tok === cfg.eos) done.push({ toks: toks, score: x.score / Math.max(1, toks.length + 1) });
        else live.push({ toks: toks, score: x.score, past: x.past, last: x.tok });
      }
      // Stop once the best finished hypothesis beats anything still running
      // could reach (scores only fall as tokens are added).
      if (done.length >= beams) break;
      if (done.length && live.length) {
        var bestDone = Math.max.apply(null, done.map(function (d) { return d.score; }));
        if (live.every(function (l) { return l.score / (l.toks.length + 1) < bestDone && l.score / maxNew < bestDone; })) break;
      }
    }
    live.forEach(function (l) { done.push({ toks: l.toks, score: l.score / Math.max(1, l.toks.length + 1) }); });
    done.sort(function (x, y) { return y.score - x.score; });
    return done.length ? done[0].toks : [];
  }

  return { sentences: sentences, generate: generate };
}));
