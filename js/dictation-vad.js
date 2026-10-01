/*
 * ASVad — splits a live 16 kHz microphone stream into utterances for
 * /dictation, so Whisper gets one phrase at a time rather than a fixed slice
 * that cuts words in half. UMD: tools/check-dictation.js runs it in Node.
 *
 *   var seg = ASVad.segmenter({ onUtterance: fn(Float32Array, info) });
 *   seg.push(samples);      // any block size
 *   seg.flush();            // on stop: whatever is still open
 *
 * Energy-based, on 30 ms frames. The threshold follows the room: the noise
 * floor is a slow average of the frames that are not speech, and speech is
 * anything 10 dB over it (and over an absolute minimum, for a dead-silent
 * input). An utterance closes after 700 ms below the threshold, or at 25 s,
 * where Whisper's 30 s window would start to cut it. 300 ms before the first
 * loud frame is kept, because the start of a word ("s", "f", "h") is quieter
 * than its vowel. Bursts under 250 ms (a click, a cough, a door) are not sent:
 * Whisper given half a second of noise tends to invent a "Thank you."
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ASVad = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function segmenter(o) {
    o = o || {};
    var rate = o.rate || 16000;
    var F = Math.round(rate * 0.03);
    var endFrames = Math.round((o.endSilenceMs || 700) / 30);
    var minFrames = Math.round((o.minSpeechMs || 250) / 30);
    var maxFrames = Math.round((o.maxMs || 25000) / 30);
    var preFrames = Math.round((o.preRollMs || 300) / 30);
    var minLevel = o.minLevel || 0.004;
    var ratio = Math.pow(10, (o.overDb || 10) / 20);

    var pend = new Float32Array(0);
    var floor = 0, seen = 0;
    var pre = [];          // the last few quiet frames, for pre-roll
    var cur = null;        // { frames: [], loud, quiet, t0 }
    var t = 0;             // frames so far
    var level = 0;

    function emit() {
      var c = cur; cur = null;
      // Drop the trailing silence beyond 200 ms; keep a little so the last
      // word is not clipped.
      var keep = c.frames.length - Math.max(0, c.quiet - Math.round(200 / 30));
      var frames = c.frames.slice(0, keep);
      if (c.loud < minFrames) return;
      var n = frames.length * F, out = new Float32Array(n);
      frames.forEach(function (f, i) { out.set(f, i * F); });
      if (o.onUtterance) o.onUtterance(out, { start: c.t0 * 0.03, end: (c.t0 + frames.length) * 0.03, loud: c.loud * 0.03 });
    }

    function frame(f) {
      var e = 0;
      for (var i = 0; i < f.length; i++) e += f[i] * f[i];
      var rms = Math.sqrt(e / f.length);
      level = rms;
      // Prime the floor from the first half-second, then let it drift with
      // the frames that are not speech: up slowly, down quickly.
      if (seen < 16) floor = seen ? Math.min(floor, rms) * 0.5 + floor * 0.5 : rms;
      seen++;
      var thr = Math.max(minLevel, floor * ratio);
      var loud = rms > thr;
      if (!loud && !cur) floor = rms < floor ? floor * 0.8 + rms * 0.2 : floor * 0.98 + rms * 0.02;

      if (cur) {
        cur.frames.push(f);
        if (loud) { cur.loud++; cur.quiet = 0; } else cur.quiet++;
        if (cur.quiet >= endFrames || cur.frames.length >= maxFrames) emit();
      } else if (loud) {
        cur = { frames: pre.slice(), loud: 1, quiet: 0, t0: t - pre.length };
        cur.frames.push(f);
        pre = [];
      } else {
        pre.push(f);
        if (pre.length > preFrames) pre.shift();
      }
      t++;
    }

    return {
      push: function (x) {
        var buf = new Float32Array(pend.length + x.length);
        buf.set(pend); buf.set(x, pend.length);
        var i = 0;
        for (; i + F <= buf.length; i += F) frame(buf.slice(i, i + F));
        pend = buf.slice(i);
      },
      flush: function () { if (cur) { cur.quiet = 0; emit(); } pend = new Float32Array(0); pre = []; },
      speaking: function () { return !!cur && cur.loud >= minFrames; },
      level: function () { return level; },
      floor: function () { return floor; }
    };
  }

  // Whisper's stock lines for silence and noise, which it produces when given
  // audio with no words in it. Dropped only when they are the whole result.
  var PHANTOM = /^\s*(?:thank you\.?|thanks for watching!?|thank you for watching\.?|\[[^\]]*\]|\([^)]*\)|you|\.+|bye\.?)\s*$/i;
  function phantom(text) { return PHANTOM.test(text || ''); }

  return { segmenter: segmenter, phantom: phantom };
}));
