/*
 * ASTTS — the pure parts of text-to-speech: text normalisation, chunking,
 * Kokoro's tokenizer and voice style tables. No audio, no model; UMD so
 * tools/check-tts.js runs it in Node and tts-worker.js runs it in the browser.
 *
 * The model is Kokoro-82M (hexgrad, Apache-2.0), run as ONNX by tts-worker.js.
 * Its interface is small:
 *
 *   input_ids  int64 [1, n]   one id per phoneme character, wrapped in 0 … 0
 *   style      f32   [1, 256] row n-2 of the voice's 510×256 table
 *   speed      f32   [1]
 *   → waveform f32   24 kHz mono
 *
 * The English normalisation and the punctuation-preserving phonemize split
 * are ported from kokoro-js 1.2.1 (Xenova, Apache-2.0). Phonemes themselves
 * come from espeak-ng, in the worker.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ASTTS = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SAMPLE_RATE = 24000;
  var STYLE_DIM = 256;
  var STYLE_ROWS = 510;
  var MAX_TOKENS = 510;

  // tokenizer.json → model.vocab of onnx-community/Kokoro-82M-v1.0-ONNX.
  var VOCAB = {"$":0,";":1,":":2,",":3,".":4,"!":5,"?":6,"—":9,"…":10,"\"":11,"(":12,")":13,"“":14,"”":15," ":16,"̃":17,"ʣ":18,"ʥ":19,"ʦ":20,"ʨ":21,"ᵝ":22,"ꭧ":23,"A":24,"I":25,"O":31,"Q":33,"S":35,"T":36,"W":39,"Y":41,"ᵊ":42,"a":43,"b":44,"c":45,"d":46,"e":47,"f":48,"h":50,"i":51,"j":52,"k":53,"l":54,"m":55,"n":56,"o":57,"p":58,"q":59,"r":60,"s":61,"t":62,"u":63,"v":64,"w":65,"x":66,"y":67,"z":68,"ɑ":69,"ɐ":70,"ɒ":71,"æ":72,"β":75,"ɔ":76,"ɕ":77,"ç":78,"ɖ":80,"ð":81,"ʤ":82,"ə":83,"ɚ":85,"ɛ":86,"ɜ":87,"ɟ":90,"ɡ":92,"ɥ":99,"ɨ":101,"ɪ":102,"ʝ":103,"ɯ":110,"ɰ":111,"ŋ":112,"ɳ":113,"ɲ":114,"ɴ":115,"ø":116,"ɸ":118,"θ":119,"œ":120,"ɹ":123,"ɾ":125,"ɻ":126,"ʁ":128,"ɽ":129,"ʂ":130,"ʃ":131,"ʈ":132,"ʧ":133,"ʊ":135,"ʋ":136,"ʌ":138,"ɣ":139,"ɤ":140,"χ":142,"ʎ":143,"ʒ":147,"ʔ":148,"ˈ":156,"ˌ":157,"ː":158,"ʰ":162,"ʲ":164,"↓":169,"→":171,"↗":172,"↘":173,"ᵻ":177};

  // Grades from the model card (hexgrad/Kokoro-82M VOICES.md): an estimate of
  // how much clean training audio each voice had. Shown in the picker, because
  // the D voices really are noticeably rougher and people should know why.
  // lang is the espeak-ng voice used to phonemize.
  var VOICES = [
    ['af_heart', 'Heart', 'en-us', 'F', 'A'], ['af_bella', 'Bella', 'en-us', 'F', 'A-'],
    ['af_nicole', 'Nicole', 'en-us', 'F', 'B-'], ['af_aoede', 'Aoede', 'en-us', 'F', 'C+'],
    ['af_kore', 'Kore', 'en-us', 'F', 'C+'], ['af_sarah', 'Sarah', 'en-us', 'F', 'C+'],
    ['af_alloy', 'Alloy', 'en-us', 'F', 'C'], ['af_nova', 'Nova', 'en-us', 'F', 'C'],
    ['af_sky', 'Sky', 'en-us', 'F', 'C-'], ['af_jessica', 'Jessica', 'en-us', 'F', 'D'],
    ['af_river', 'River', 'en-us', 'F', 'D'],
    ['am_fenrir', 'Fenrir', 'en-us', 'M', 'C+'], ['am_michael', 'Michael', 'en-us', 'M', 'C+'],
    ['am_puck', 'Puck', 'en-us', 'M', 'C+'], ['am_echo', 'Echo', 'en-us', 'M', 'D'],
    ['am_eric', 'Eric', 'en-us', 'M', 'D'], ['am_liam', 'Liam', 'en-us', 'M', 'D'],
    ['am_onyx', 'Onyx', 'en-us', 'M', 'D'], ['am_santa', 'Santa', 'en-us', 'M', 'D-'],
    ['am_adam', 'Adam', 'en-us', 'M', 'F+'],
    ['bf_emma', 'Emma', 'en-gb', 'F', 'B-'], ['bf_isabella', 'Isabella', 'en-gb', 'F', 'C'],
    ['bf_alice', 'Alice', 'en-gb', 'F', 'D'], ['bf_lily', 'Lily', 'en-gb', 'F', 'D'],
    ['bm_fable', 'Fable', 'en-gb', 'M', 'C'], ['bm_george', 'George', 'en-gb', 'M', 'C'],
    ['bm_lewis', 'Lewis', 'en-gb', 'M', 'D+'], ['bm_daniel', 'Daniel', 'en-gb', 'M', 'D']
  ].map(function (v) { return { id: v[0], name: v[1], lang: v[2], gender: v[3], grade: v[4] }; });

  function voice(id) {
    for (var i = 0; i < VOICES.length; i++) if (VOICES[i].id === id) return VOICES[i];
    return null;
  }

  /* -------------------------------------------------------- normalisation */

  function splitNum(m) {
    if (m.indexOf('.') >= 0) return m;
    if (m.indexOf(':') >= 0) {
      var hm = m.split(':').map(Number), h = hm[0], mi = hm[1];
      return mi === 0 ? h + " o'clock" : mi < 10 ? h + ' oh ' + mi : h + ' ' + mi;
    }
    var year = parseInt(m.slice(0, 4), 10);
    if (year < 1100 || year % 1000 < 10) return m;
    var left = m.slice(0, 2), right = parseInt(m.slice(2, 4), 10), s = /s$/.test(m) ? 's' : '';
    if (year % 1000 >= 100 && year % 1000 <= 999) {
      if (right === 0) return left + ' hundred' + s;
      if (right < 10) return left + ' oh ' + right + s;
    }
    return left + ' ' + right + s;
  }

  function money(m) {
    var unit = m[0] === '$' ? 'dollar' : 'pound';
    if (isNaN(Number(m.slice(1)))) return m.slice(1) + ' ' + unit + 's';
    if (m.indexOf('.') < 0) return m.slice(1) + ' ' + unit + (m.slice(1) === '1' ? '' : 's');
    var p = m.slice(1).split('.'), whole = p[0], cents = parseInt((p[1] + '00').slice(0, 2), 10);
    var small = m[0] === '$' ? (cents === 1 ? 'cent' : 'cents') : (cents === 1 ? 'penny' : 'pence');
    return whole + ' ' + unit + (whole === '1' ? '' : 's') + ' and ' + cents + ' ' + small;
  }

  function decimal(m) {
    var p = m.split('.');
    return p[0] + ' point ' + p[1].split('').join(' ');
  }

  // English only: the rules are about English numbers, titles and spelling.
  function normalize(text) {
    return String(text)
      .replace(/[‘’]/g, "'")
      .replace(/«/g, '“').replace(/»/g, '”')
      .replace(/[“”]/g, '"')
      .replace(/\(/g, '«').replace(/\)/g, '»')
      .replace(/[^\S \n]/g, ' ')
      .replace(/  +/g, ' ')
      .replace(/(?<=\n) +(?=\n)/g, '')
      .replace(/\bD[Rr]\.(?= [A-Z])/g, 'Doctor')
      .replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, 'Mister')
      .replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, 'Miss')
      .replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, 'Mrs')
      .replace(/\betc\.(?! [A-Z])/gi, 'etc')
      .replace(/\b(y)eah?\b/gi, "$1e'a")
      .replace(/\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g, splitNum)
      .replace(/(?<=\d),(?=\d)/g, '')
      .replace(/[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi, money)
      .replace(/\d*\.\d+/g, decimal)
      .replace(/(?<=\d)-(?=\d)/g, ' to ')
      .replace(/(?<=\d)S/g, ' S')
      .replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S")
      .replace(/(?<=X')S\b/g, 's')
      .replace(/(?:[A-Za-z]\.){2,} [a-z]/g, function (m) { return m.replace(/\./g, '-'); })
      .replace(/(?<=[A-Z])\.(?=[A-Z])/gi, '-')
      .trim();
  }

  // Kokoro was trained on espeak's output with a few symbols swapped; these
  // are the same substitutions kokoro-js makes after phonemizing.
  function fixPhonemes(ph, lang) {
    var s = ph
      .replace(/kəkˈoːɹoʊ/g, 'kˈoʊkəɹoʊ').replace(/kəkˈɔːɹəʊ/g, 'kˈəʊkəɹəʊ')
      .replace(/ʲ/g, 'j').replace(/r/g, 'ɹ').replace(/x/g, 'k').replace(/ɬ/g, 'l')
      .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, ' ')
      .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, 'z');
    if (lang === 'en-us') s = s.replace(/(?<=nˈaɪn)ti(?!ː)/g, 'di');
    return s.trim();
  }

  // Punctuation is kept verbatim between phonemized runs: it has its own
  // tokens and is what gives Kokoro its pauses and question intonation.
  var PUNCT = ';:,.!?¡¿—…"«»“”(){}[]';
  var PUNCT_RE = new RegExp('(\\s*[' + PUNCT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ']+\\s*)+', 'g');

  function splitPunct(text) {
    var out = [], last = 0, m;
    PUNCT_RE.lastIndex = 0;
    while ((m = PUNCT_RE.exec(text))) {
      if (last < m.index) out.push({ punct: false, text: text.slice(last, m.index) });
      if (m[0].length) out.push({ punct: true, text: m[0] });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ punct: false, text: text.slice(last) });
    return out;
  }

  // phonemizeRun(text, lang) → Promise<string>, supplied by the caller (the
  // worker passes espeak-ng; the Node check passes a stub).
  async function phonemize(text, lang, phonemizeRun) {
    var en = /^en/.test(lang);
    var src = en ? normalize(text) : String(text).replace(/\s+/g, ' ').trim();
    var parts = splitPunct(src);
    var done = await Promise.all(parts.map(function (p) {
      return p.punct ? p.text : phonemizeRun(p.text, lang);
    }));
    return fixPhonemes(done.join(''), lang);
  }

  function tokenize(ph) {
    var ids = [0];
    for (var ch of ph) {
      if (Object.prototype.hasOwnProperty.call(VOCAB, ch)) ids.push(VOCAB[ch]);
      if (ids.length > MAX_TOKENS) break;
    }
    ids.push(0);
    return ids;
  }

  /* -------------------------------------------------------------- chunking */

  // The model card: voices are best between ~100 and 200 tokens, weak under
  // 10-20 and start to rush past 400. A phoneme string runs close to one token
  // per letter of English text, so chunks are sized in characters: sentences
  // are packed together up to TARGET, and a sentence longer than MAX is broken
  // at its clause punctuation, then at spaces.
  var TARGET = 220;
  var MAX = 380;
  var ABBR = /\b(?:mr|mrs|ms|dr|prof|sr|jr|st|mt|vs|etc|inc|ltd|co|no|fig|e\.g|i\.e)\.$/i;

  function sentences(text) {
    var out = [];
    var paras = String(text).replace(/\r\n?/g, '\n').split(/\n\s*\n|\n(?=\s*[-•*#\d]+[.)]?\s)/);
    paras.forEach(function (p) {
      p = p.replace(/\s*\n\s*/g, ' ').trim();
      if (!p) return;
      var re = /[^.!?…。！？]+(?:[.!?…。！？]+["'”’»)\]]*|$)\s*/g, m, buf = '';
      while ((m = re.exec(p)) && m[0]) {
        buf += m[0];
        // "Dr. Smith" and "3.5" are not sentence ends.
        if (ABBR.test(buf.trim()) || /\d\.$/.test(buf.trim()) && /^\d/.test(p.slice(re.lastIndex))) continue;
        out.push({ text: buf.trim() });
        buf = '';
      }
      if (buf.trim()) out.push({ text: buf.trim() });
      if (out.length) out[out.length - 1].paraEnd = true;
    });
    return out;
  }

  function breakLong(s) {
    if (s.length <= MAX) return [s];
    var parts = s.split(/(?<=[,;:—–])\s+/), out = [], cur = '';
    parts.forEach(function (p) {
      if (p.length > MAX) {
        if (cur) { out.push(cur); cur = ''; }
        var words = p.split(/\s+/), w = '';
        words.forEach(function (x) {
          if ((w + ' ' + x).length > MAX && w) { out.push(w); w = x; } else w = w ? w + ' ' + x : x;
        });
        if (w) cur = w;
        return;
      }
      if (cur && (cur + ' ' + p).length > TARGET) { out.push(cur); cur = p; } else cur = cur ? cur + ' ' + p : p;
    });
    if (cur) out.push(cur);
    return out;
  }

  // → [{ text, pause }] where pause is the silence (s) to put after the chunk:
  // longer at a paragraph end than between sentences.
  function chunk(text, opts) {
    opts = opts || {};
    var target = opts.target || TARGET;
    var out = [], cur = '';
    function flush(pause) {
      if (cur.trim()) out.push({ text: cur.trim(), pause: pause });
      cur = '';
    }
    sentences(text).forEach(function (s) {
      breakLong(s.text).forEach(function (piece, i, all) {
        if (cur && (cur + ' ' + piece).length > target) flush(0.12);
        cur = cur ? cur + ' ' + piece : piece;
        if (all.length > 1 && i < all.length - 1 && cur.length > target * 0.6) flush(0.08);
      });
      if (s.paraEnd) flush(0.45);
    });
    flush(0.45);
    return out;
  }

  /* ------------------------------------------------------- voices & mixes */

  // A voice file is a raw Float32 510×256 table: one style vector per input
  // length. Row n-2 is used for n tokens, as the reference implementation does.
  function styleRow(table, nTokens) {
    var row = Math.min(Math.max(nTokens - 2, 0), STYLE_ROWS - 1);
    return table.slice(row * STYLE_DIM, row * STYLE_DIM + STYLE_DIM);
  }

  // A blend is a weighted average of whole tables. Weights are normalised so
  // they need not sum to 1; a single voice at any weight is returned
  // untouched, so "mix" with one voice is bit-identical to that voice.
  function mixTables(tables, weights) {
    var live = [];
    for (var i = 0; i < tables.length; i++) if (weights[i] > 0) live.push([tables[i], weights[i]]);
    if (!live.length) throw new Error('No voice selected');
    if (live.length === 1) return live[0][0];
    var sum = live.reduce(function (a, x) { return a + x[1]; }, 0);
    var out = new Float32Array(live[0][0].length);
    live.forEach(function (x) {
      var t = x[0], w = x[1] / sum;
      for (var j = 0; j < out.length; j++) out[j] += t[j] * w;
    });
    return out;
  }

  // "af_bella:2,am_michael:1" ⇄ [{ id, w }]
  function parseMix(s) {
    return String(s || '').split(',').map(function (p) {
      var kv = p.trim().split(':');
      return { id: kv[0], w: kv.length > 1 ? parseFloat(kv[1]) : 1 };
    }).filter(function (x) { return voice(x.id) && x.w > 0; });
  }
  function formatMix(list) {
    return list.map(function (x) { return x.id + (x.w === 1 ? '' : ':' + x.w); }).join(',');
  }

  // Silence trimmed from each chunk's ends before they are joined, so the
  // pauses between chunks are the ones chosen above rather than whatever
  // padding the model happened to produce.
  function trimSilence(x, thresh, keep) {
    thresh = thresh || 0.003;
    keep = keep == null ? Math.round(0.03 * SAMPLE_RATE) : keep;
    var a = 0, b = x.length - 1;
    while (a < x.length && Math.abs(x[a]) < thresh) a++;
    while (b > a && Math.abs(x[b]) < thresh) b--;
    if (a >= b) return x.subarray(0, 0);
    return x.subarray(Math.max(0, a - keep), Math.min(x.length, b + 1 + keep));
  }

  /* --------------------------------------------------------- voice picker */

  // Browser only: fills a <select> with the voices, grouped by accent, each
  // labelled with its model-card grade. Shared by /text-to-speech and
  // /text-to-audiobook.
  function voiceLabel(v) {
    return v.name + ' — ' + (v.lang === 'en-gb' ? 'UK' : 'US') + ' ' + (v.gender === 'F' ? 'female' : 'male') + ' · grade ' + v.grade;
  }
  function fillVoiceSelect(sel, withNone) {
    var doc = sel.ownerDocument;
    sel.innerHTML = '';
    if (withNone) {
      var o0 = doc.createElement('option');
      o0.value = '';
      o0.textContent = '— none —';
      sel.appendChild(o0);
    }
    [['en-us', 'American English'], ['en-gb', 'British English']].forEach(function (g) {
      var og = doc.createElement('optgroup');
      og.label = g[1];
      VOICES.filter(function (v) { return v.lang === g[0]; }).forEach(function (v) {
        var o = doc.createElement('option');
        o.value = v.id;
        o.textContent = voiceLabel(v);
        og.appendChild(o);
      });
      sel.appendChild(og);
    });
  }

  /* ------------------------------------------------------------- tagging */

  // Every file this site synthesises says so in its own metadata: a WAV
  // LIST/INFO chunk or an ID3v2.3 tag on an MP3. It is a label, not a
  // watermark — anyone can strip it — and the page says exactly that.
  // fields: { title, artist, comment, software }
  function utf16(s) {
    var out = [0xFF, 0xFE];
    for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); out.push(c & 0xff, c >> 8); }
    return out;
  }
  function id3Frame(id, body) {
    var n = body.length;
    return [id.charCodeAt(0), id.charCodeAt(1), id.charCodeAt(2), id.charCodeAt(3),
      (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff, 0, 0].concat(body);
  }
  function tagMp3(bytes, f) {
    var frames = [];
    if (f.title) frames = frames.concat(id3Frame('TIT2', [1].concat(utf16(f.title))));
    if (f.artist) frames = frames.concat(id3Frame('TPE1', [1].concat(utf16(f.artist))));
    if (f.software) frames = frames.concat(id3Frame('TSSE', [1].concat(utf16(f.software))));
    // COMM: encoding, language, empty description, text.
    if (f.comment) frames = frames.concat(id3Frame('COMM', [1, 0x65, 0x6e, 0x67, 0xFF, 0xFE, 0, 0].concat(utf16(f.comment))));
    var n = frames.length;
    var head = [0x49, 0x44, 0x33, 3, 0, 0, (n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f];
    var out = new Uint8Array(head.length + n + bytes.length);
    out.set(head, 0);
    out.set(frames, head.length);
    out.set(bytes, head.length + n);
    return out;
  }
  function tagWav(bytes, f) {
    var subs = [];
    function sub(id, s) {
      if (!s) return;
      var b = [];
      for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); b.push(c < 128 ? c : 63); }
      b.push(0);
      if (b.length & 1) b.push(0);
      var n = b.length;
      subs = subs.concat([id.charCodeAt(0), id.charCodeAt(1), id.charCodeAt(2), id.charCodeAt(3),
        n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]).concat(b);
    }
    sub('INAM', f.title); sub('IART', f.artist); sub('ISFT', f.software); sub('ICMT', f.comment);
    var n = 4 + subs.length;
    var list = [0x4c, 0x49, 0x53, 0x54, n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff, 0x49, 0x4e, 0x46, 0x4f].concat(subs);
    var out = new Uint8Array(bytes.length + list.length);
    out.set(bytes, 0);
    out.set(list, bytes.length);
    var riff = out.length - 8;
    out[4] = riff & 0xff; out[5] = (riff >>> 8) & 0xff; out[6] = (riff >>> 16) & 0xff; out[7] = (riff >>> 24) & 0xff;
    return out;
  }

  return {
    tagMp3: tagMp3, tagWav: tagWav, fillVoiceSelect: fillVoiceSelect, voiceLabel: voiceLabel,
    SAMPLE_RATE: SAMPLE_RATE, STYLE_DIM: STYLE_DIM, STYLE_ROWS: STYLE_ROWS, MAX_TOKENS: MAX_TOKENS,
    VOCAB: VOCAB, VOICES: VOICES, voice: voice,
    normalize: normalize, fixPhonemes: fixPhonemes, splitPunct: splitPunct, phonemize: phonemize,
    tokenize: tokenize, sentences: sentences, chunk: chunk,
    styleRow: styleRow, mixTables: mixTables, parseMix: parseMix, formatMix: formatMix,
    trimSilence: trimSilence
  };
}));
