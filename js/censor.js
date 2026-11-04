/*
 * ASCensor: find swear words in a transcript and bleep or mute them, for
 * /censor-audio. UMD, so tools/check-censor.js runs it in Node.
 *
 *   ASCensor.match(text, opts)            -> 'strong' | 'mild' | 'slur' | 'custom' | null
 *   ASCensor.find(words, mono, rate, opts) -> [{ at, text, kind, start, end, on }]
 *   ASCensor.apply(channels, rate, spans, opts) -> channels (new arrays)
 *
 * `words` come from the timestamped Whisper base (transcribe-worker.js with
 * words: true). The spike of 4 Nov 2026 (two `say` voices, 12 swear words in
 * running speech): Whisper writes every one of them out in full, never as
 * "f***", with starts close to the sound. Its word ends run early, as on
 * /remove-filler-words, so where a span ends is found on the audio.
 *
 * The length never changes: a word is replaced in place, so a video's
 * picture is copied untouched and stays in sync.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ASCensor = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Stems: matched anywhere in the word, so "fucking", "bullshit" and
  // "motherfucker" are caught by one entry each.
  var STRONG_STEMS = ['fuck', 'shit', 'cunt', 'motherf'];
  // Words a stem would wrongly catch.
  var NOT = ['scunthorpe', 'shiitake', 'shitake'];
  // Whole words only: "hell" must not catch "hello" or "shell", "ass" not
  // "class" or "assume".
  var STRONG = ['fuk', 'fuking', 'fukin', 'fck', 'fcking', 'twat', 'wanker', 'wank', 'bollocks', 'cocksucker', 'dickhead', 'jackass', 'dumbass', 'asshole', 'assholes', 'arsehole', 'bitch', 'bitches', 'bitching', 'bastard', 'bastards', 'prick', 'pussy', 'dick', 'dicks', 'cock', 'cocks', 'slut', 'whore', 'tits', 'titties'];
  // Off by default, as in a radio edit. Words with an everyday meaning
  // (bloody, screw, Jesus) are not listed: a sermon or a DIY video would be
  // bleeped throughout. Anything can be added as a custom word.
  var MILD = ['damn', 'damned', 'dammit', 'goddamn', 'goddamned', 'goddammit', 'hell', 'ass', 'asses', 'arse', 'crap', 'crappy', 'piss', 'pissed', 'pissing', 'bugger'];
  // The usual slurs. Listed so they can be bleeped, which is the point of
  // the tool; they are never shown on the page, only matched.
  var SLUR = ['nigger', 'niggers', 'nigga', 'niggas', 'faggot', 'faggots', 'retard', 'retards', 'retarded', 'fag', 'fags', 'dyke', 'tranny', 'spic', 'chink', 'kike', 'wetback', 'gook', 'coon'];

  function clean(t) { return String(t || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z*]/g, ''); }

  function match(text, opts) {
    opts = opts || {};
    var w = clean(text);
    if (!w) return null;
    if (opts.custom && opts.custom.indexOf(w) >= 0) return 'custom';
    // A word Whisper starred out itself ("f***").
    if (/^[a-z]\*+[a-z]*$/.test(w) || /\*{2,}/.test(w)) return 'strong';
    w = w.replace(/\*/g, '');
    var i;
    if (SLUR.indexOf(w) >= 0) return 'slur';
    if (NOT.indexOf(w) >= 0) return null;
    for (i = 0; i < STRONG_STEMS.length; i++) if (w.indexOf(STRONG_STEMS[i]) >= 0) return 'strong';
    if (STRONG.indexOf(w) >= 0) return 'strong';
    if (MILD.indexOf(w) >= 0) return 'mild';
    return null;
  }

  // 10 ms frame levels and a threshold 9 dB over the file's own floor (the
  // 10th percentile), the rule silence-gaps.js and fillers.js use.
  var FRAME = 0.01;
  function levels(mono, rate) {
    var F = Math.max(1, Math.round(FRAME * rate)), n = Math.floor(mono.length / F), lv = new Float32Array(n);
    for (var f = 0; f < n; f++) {
      var s = 0;
      for (var i = f * F; i < (f + 1) * F; i++) s += mono[i] * mono[i];
      lv[f] = Math.sqrt(s / F);
    }
    var sorted = Array.prototype.slice.call(lv).sort(function (a, b) { return a - b; });
    var floor = sorted[Math.floor(sorted.length * 0.1)] || 0, loud = sorted[Math.floor(sorted.length * 0.95)] || 0;
    return { lv: lv, thr: Math.max(floor * 2.82, loud * 0.01, 1e-5) };
  }
  function fr(t, L) { return Math.max(0, Math.min(L.lv.length - 1, Math.round(t / FRAME))); }

  // Where to bleep a word. Erring wide is the right mistake here: a syllable
  // of the word left audible defeats the tool, some of the neighbouring word
  // bleeped does not. Whisper's word times were off by -0.06..+0.23 s at the
  // start and up to 0.27 s at the end (check-censor's fixture), so each edge
  // is moved to the nearest quiet frame (9 dB over the file's floor) in a
  // window around Whisper's time, and falls back to a margin when there is
  // none. The constants were chosen by sweeping them against that fixture:
  // the least spill into the next word (measured 289 ms worst) that leaves
  // every swear word at least 20 dB down (measured -28).
  var PRE = 0.06, BACK = 0.3, AHEAD = 0.2, POST = 0.1, LIMIT = 0.05;
  function span(words, i, L, dur) {
    var w = words[i], next = words[i + 1];
    var s = w.start - PRE, f, g;
    // Back from the word's start to the last quiet frame: the sound began
    // after it.
    for (f = fr(w.start + 0.05, L); f >= fr(w.start - BACK, L); f--) if (L.lv[f] <= L.thr) { s = Math.min(s, (f + 1) * FRAME - 0.01); break; }
    // Forward from just before Whisper's end to the first quiet frame.
    var e = -1;
    for (g = fr(w.end - 0.05, L); g <= fr(w.end + AHEAD, L); g++) if (L.lv[g] <= L.thr) { e = g * FRAME + 0.01; break; }
    if (e < 0) e = w.end + POST;
    e = Math.max(e, w.end + 0.02);
    if (next) e = Math.min(e, next.start + LIMIT);
    return [Math.max(0, s), Math.min(dur, e)];
  }

  function find(words, mono, rate, opts) {
    opts = opts || {};
    var L = levels(mono, rate), dur = mono.length / rate, out = [];
    var kinds = opts.kinds || { strong: true, mild: false, slur: true, custom: true };
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (w.start == null || w.end == null) continue;
      var k = match(w.text, opts);
      if (!k) continue;
      var sp = span(words, i, L, dur);
      out.push({ at: i, text: String(w.text).trim().replace(/[,.!?;:"]+$/, ''), kind: k, start: sp[0], end: sp[1], on: !!kinds[k] });
    }
    return out;
  }
  // The span for any word, for a word the user clicks to add.
  function spanOf(words, i, mono, rate) { return span(words, i, levels(mono, rate), mono.length / rate); }

  // Replace each span with a 1 kHz tone (or silence), 5 ms raised-cosine
  // crossfades at each edge so neither end clicks. The tone is set to the
  // replaced word's own peak level, never above -6 dBFS: a bleep much louder
  // than the voice is the thing people complain about in broadcast edits.
  function apply(channels, rate, spans, opts) {
    opts = opts || {};
    var mode = opts.mode || 'bleep', hz = opts.hz || 1000, XF = Math.max(1, Math.round(0.005 * rate));
    var out = channels.map(function (c) { return new Float32Array(c); });
    spans.forEach(function (sp) {
      var a = Math.max(0, Math.round(sp[0] * rate)), b = Math.min(out[0].length, Math.round(sp[1] * rate));
      if (b - a < 2) return;
      var pk = 0;
      for (var c = 0; c < channels.length; c++) for (var i = a; i < b; i++) pk = Math.max(pk, Math.abs(channels[c][i]));
      var amp = mode === 'bleep' ? Math.min(0.5, Math.max(0.03, pk * 0.8)) : 0;
      for (var j = a; j < b; j++) {
        var k = j - a, r = b - 1 - j, wgt = 1;
        if (k < XF) wgt = 0.5 - 0.5 * Math.cos(Math.PI * k / XF);
        else if (r < XF) wgt = 0.5 - 0.5 * Math.cos(Math.PI * r / XF);
        var tone = amp * Math.sin(2 * Math.PI * hz * k / rate);
        for (var c2 = 0; c2 < out.length; c2++) out[c2][j] = channels[c2][j] * (1 - wgt) + tone * wgt;
      }
    });
    return out;
  }

  return { match: match, find: find, spanOf: spanOf, apply: apply, levels: levels };
});
