/*
 * ASDx7: a six-operator FM synth in the shape of the Yamaha DX7, behind
 * /dx7-synth.
 *
 * The sound comes from vendor/msfa/<date>/dx7.wasm: the MSFA engine
 * (music-synthesizer-for-android, Apache-2.0) as carried in Dexed, with a
 * small C interface of our own around it. See that folder's README for the
 * files compiled and their licences. This file is the JavaScript side: it
 * instantiates the module, reads and writes .syx voice files, holds the
 * built-in voices, renders a note list offline, and carries the source of the
 * AudioWorklet that plays it live.
 *
 * The module has no imports and is built to be instantiated synchronously
 * from bytes, because an AudioWorkletGlobalScope has no fetch. The page
 * fetches the bytes once and hands them to both create() and the worklet.
 *
 * No Yamaha data is in here. PATCHES are written for this site; a DX7 owner's
 * own .syx files load through parseSyx().
 *
 * Checked by tools/check-dx7.js (pitch, release, polyphony, sysex round trip,
 * block-size independence, the worklet in a stand-in scope).
 *
 * UMD: page, worker and Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ASDx7 = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VOICE = 155;          // one voice as a DX7 sends it (single-voice dump)
  var PACKED = 128;         // the same voice inside a 32-voice bulk dump
  var BULK_LEN = 4104;
  var SINGLE_LEN = 163;
  var CHUNK = 4096;         // frames per call into the module from render()

  // The top value of each numeric parameter, per operator and then for the
  // 19 voice-wide ones. The engine indexes tables with some of these, and a
  // file from the wild can hold anything; the module clamps too.
  var OP_MAX = [99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 3, 3, 7, 3, 7, 99, 1, 31, 99, 14];
  var GLOBAL_MAX = [99, 99, 99, 99, 99, 99, 99, 99, 31, 7, 1, 99, 99, 99, 99, 1, 5, 7, 48];

  function clampVoice(v) {
    var op, i;
    for (op = 0; op < 6; op++) {
      for (i = 0; i < 21; i++) if (v[op * 21 + i] > OP_MAX[i]) v[op * 21 + i] = OP_MAX[i];
    }
    for (i = 0; i < 19; i++) if (v[126 + i] > GLOBAL_MAX[i]) v[126 + i] = GLOBAL_MAX[i];
    for (i = 145; i < 155; i++) v[i] &= 0x7f;
    return v;
  }

  function nameOf(v) {
    var s = '', i, c;
    for (i = 145; i < 155; i++) {
      c = v[i];
      // The DX7's character set is ASCII apart from a yen sign and two
      // arrows; anything unprintable would only break the page's list.
      s += (c >= 32 && c < 127) ? String.fromCharCode(c) : ' ';
    }
    return s.replace(/\s+$/, '');
  }

  function checksum(bytes, start, len) {
    var sum = 0, i;
    for (i = 0; i < len; i++) sum += bytes[start + i];
    return (-sum) & 0x7f;
  }

  /* ---- sysex ---- */

  function unpackVoice(b, o) {
    var v = new Uint8Array(VOICE), op, s, d, i;
    for (op = 0; op < 6; op++) {
      s = o + op * 17;
      d = op * 21;
      for (i = 0; i < 11; i++) v[d + i] = b[s + i];
      v[d + 11] = b[s + 11] & 3;
      v[d + 12] = (b[s + 11] >> 2) & 3;
      v[d + 13] = b[s + 12] & 7;
      v[d + 20] = (b[s + 12] >> 3) & 15;
      v[d + 14] = b[s + 13] & 3;
      v[d + 15] = (b[s + 13] >> 2) & 7;
      v[d + 16] = b[s + 14];
      v[d + 17] = b[s + 15] & 1;
      v[d + 18] = (b[s + 15] >> 1) & 31;
      v[d + 19] = b[s + 16];
    }
    for (i = 0; i < 8; i++) v[126 + i] = b[o + 102 + i];
    v[134] = b[o + 110] & 31;
    v[135] = b[o + 111] & 7;
    v[136] = (b[o + 111] >> 3) & 1;
    for (i = 0; i < 4; i++) v[137 + i] = b[o + 112 + i];
    v[141] = b[o + 116] & 1;
    v[142] = (b[o + 116] >> 1) & 7;
    v[143] = (b[o + 116] >> 4) & 7;
    v[144] = b[o + 117];
    for (i = 0; i < 10; i++) v[145 + i] = b[o + 118 + i];
    return clampVoice(v);
  }

  function packVoice(v, b, o) {
    var op, s, d, i;
    for (op = 0; op < 6; op++) {
      s = op * 21;
      d = o + op * 17;
      for (i = 0; i < 11; i++) b[d + i] = v[s + i];
      b[d + 11] = (v[s + 11] & 3) | ((v[s + 12] & 3) << 2);
      b[d + 12] = (v[s + 13] & 7) | ((v[s + 20] & 15) << 3);
      b[d + 13] = (v[s + 14] & 3) | ((v[s + 15] & 7) << 2);
      b[d + 14] = v[s + 16];
      b[d + 15] = (v[s + 17] & 1) | ((v[s + 18] & 31) << 1);
      b[d + 16] = v[s + 19];
    }
    for (i = 0; i < 8; i++) b[o + 102 + i] = v[126 + i];
    b[o + 110] = v[134] & 31;
    b[o + 111] = (v[135] & 7) | ((v[136] & 1) << 3);
    for (i = 0; i < 4; i++) b[o + 112 + i] = v[137 + i];
    b[o + 116] = (v[141] & 1) | ((v[142] & 7) << 1) | ((v[143] & 7) << 4);
    b[o + 117] = v[144];
    for (i = 0; i < 10; i++) b[o + 118 + i] = v[145 + i];
  }

  // Reads every DX7 voice dump in the file: 32-voice bulks and single voices,
  // in any number, back to back. Other sysex messages between them (many
  // librarians save a parameter change or two) are stepped over. opts.lax
  // keeps a dump whose checksum is wrong, which old converters produced.
  function parseSyx(input, opts) {
    var b = input instanceof Uint8Array ? input : new Uint8Array(input);
    var lax = !!(opts && opts.lax);
    var out = [], i = 0, n = b.length, fmt, v, k, end, sawYamaha = false;

    while (i < n) {
      if (b[i] !== 0xf0) { i++; continue; }
      if (i + 6 > n) {
        if (!out.length) throw new Error('This file is cut short: it ends inside the sysex header.');
        break;
      }
      fmt = b[i + 3];
      if (b[i + 1] === 0x43 && (b[i + 2] & 0xf0) === 0 && fmt === 9 && b[i + 4] === 0x20 && b[i + 5] === 0) {
        sawYamaha = true;
        if (i + BULK_LEN > n) {
          throw new Error('This file is cut short: a 32-voice dump is 4,104 bytes and only ' + (n - i) + ' are here.');
        }
        if (!lax && checksum(b, i + 6, 4096) !== b[i + 4102]) {
          throw new Error('The checksum of this voice bank is wrong, so the file is damaged.');
        }
        for (k = 0; k < 32; k++) {
          v = unpackVoice(b, i + 6 + k * PACKED);
          out.push({ name: nameOf(v), data: v });
        }
        i += BULK_LEN;
      } else if (b[i + 1] === 0x43 && (b[i + 2] & 0xf0) === 0 && fmt === 0 && b[i + 4] === 1 && b[i + 5] === 0x1b) {
        sawYamaha = true;
        if (i + SINGLE_LEN > n) {
          throw new Error('This file is cut short: a single-voice dump is 163 bytes and only ' + (n - i) + ' are here.');
        }
        if (!lax && checksum(b, i + 6, VOICE) !== b[i + 161]) {
          throw new Error('The checksum of this voice is wrong, so the file is damaged.');
        }
        v = clampVoice(new Uint8Array(b.subarray(i + 6, i + 6 + VOICE)));
        out.push({ name: nameOf(v), data: v });
        i += SINGLE_LEN;
      } else {
        if (b[i + 1] === 0x43) sawYamaha = true;
        end = i + 1;
        while (end < n && b[end] !== 0xf7 && b[end] !== 0xf0) end++;
        i = end;
      }
    }
    if (!out.length) {
      throw new Error(sawYamaha
        ? 'This is Yamaha sysex, but not a DX7 voice or voice bank.'
        : 'This is not a DX7 sysex file.');
    }
    return out;
  }

  // voices: one -> a 163-byte single-voice dump; up to 32 -> a 4,104-byte
  // bank, the empty slots filled with the first voice so no slot is garbage.
  function packSyx(voices) {
    var list = voices.map(function (v) { return v.data || v; }), b, k;
    if (!list.length || list.length > 32) throw new Error('A DX7 bank holds 1 to 32 voices.');
    for (k = 0; k < list.length; k++) {
      if (list[k].length < VOICE) throw new Error('A voice is 155 bytes.');
    }
    if (list.length === 1) {
      b = new Uint8Array(SINGLE_LEN);
      b.set([0xf0, 0x43, 0x00, 0x00, 0x01, 0x1b]);
      b.set(list[0].subarray(0, VOICE), 6);
      b[161] = checksum(b, 6, VOICE);
      b[162] = 0xf7;
      return b;
    }
    b = new Uint8Array(BULK_LEN);
    b.set([0xf0, 0x43, 0x00, 0x09, 0x20, 0x00]);
    for (k = 0; k < 32; k++) packVoice(list[k < list.length ? k : 0], b, 6 + k * PACKED);
    b[4102] = checksum(b, 6, 4096);
    b[4103] = 0xf7;
    return b;
  }

  /* ---- the built-in voices ---- */

  // An operator, in the order the numbers are easiest to read:
  //   ratio, level, [rates], [levels], then named extras.
  // ratio is coarse + fine/100 the way the DX7 counts it (0.5, 1, 1.41, 3.5).
  function op(ratio, level, rates, levels, x) {
    x = x || {};
    var coarse = Math.floor(ratio), fine;
    if (ratio < 1) { coarse = 0; fine = Math.round((ratio / 0.5 - 1) * 100); }
    else fine = Math.round((ratio / coarse - 1) * 100);
    return [
      rates[0], rates[1], rates[2], rates[3],
      levels[0], levels[1], levels[2], levels[3],
      x.bp === undefined ? 39 : x.bp, x.ld || 0, x.rd || 0, x.lc || 0, x.rc || 0,
      x.rs || 0, x.ams || 0, x.vel || 0, level,
      0, coarse, fine, 7 + (x.det || 0)
    ];
  }

  var OFF = op(1, 0, [99, 99, 99, 99], [99, 99, 99, 0]);

  // ops are given 1..6 as on the panel; the format stores 6 first.
  function voice(name, alg, fb, ops, g) {
    g = g || {};
    var v = new Uint8Array(VOICE), i, k, o;
    // The format has room for ten characters and no more.
    if (name.length > 10) throw new Error('Voice name over 10 characters: ' + name);
    for (i = 0; i < 6; i++) {
      o = ops[5 - i] || OFF;
      for (k = 0; k < 21; k++) v[i * 21 + k] = o[k];
    }
    for (i = 0; i < 4; i++) { v[126 + i] = 99; v[130 + i] = 50; }
    v[134] = alg - 1;
    v[135] = fb;
    v[136] = g.sync === undefined ? 1 : g.sync;
    v[137] = g.lfoSpeed === undefined ? 35 : g.lfoSpeed;
    v[138] = g.lfoDelay || 0;
    v[139] = g.pmd || 0;
    v[140] = g.amd || 0;
    v[141] = g.lfoSync === undefined ? 1 : g.lfoSync;
    v[142] = g.wave === undefined ? 4 : g.wave;   // sine
    // 3 on every voice, so the mod wheel always has vibrato to bring in.
    v[143] = g.pms === undefined ? 3 : g.pms;
    v[144] = 24 + (g.transpose || 0);
    for (i = 0; i < 10; i++) v[145 + i] = i < name.length ? name.charCodeAt(i) : 32;
    return { name: name, data: clampVoice(v) };
  }

  var PATCHES = [
    // One carrier and nothing else: the reference the check measures pitch on.
    voice('PURE SINE', 32, 0, [
      op(1, 99, [99, 99, 99, 62], [99, 99, 99, 0], { vel: 2 })
    ]),

    // Three carrier/modulator pairs: a round body, a detuned twin for
    // width, and a high short "tine" that only speaks when the key is hit hard.
    voice('TINE KEYS', 5, 3, [
      op(1, 99, [96, 28, 22, 52], [99, 92, 0, 0], { vel: 2, rs: 2 }),
      op(1, 76, [96, 40, 28, 55], [99, 80, 0, 0], { vel: 5, rs: 2, rd: 20, bp: 51 }),
      op(1, 93, [96, 28, 22, 52], [99, 92, 0, 0], { vel: 2, rs: 2, det: 3 }),
      op(1, 72, [96, 44, 28, 55], [99, 76, 0, 0], { vel: 5, rs: 2, det: -2 }),
      op(1, 88, [98, 46, 30, 58], [99, 60, 0, 0], { vel: 4, rs: 3 }),
      op(13, 62, [98, 62, 40, 60], [99, 40, 0, 0], { vel: 7, rs: 3, rd: 30, bp: 48 })
    ], { lfoSpeed: 30, pms: 2 }),

    // A carrier with a quickly closing modulator, and a sub an octave down.
    voice('ROUND BASS', 1, 5, [
      op(1, 99, [99, 40, 26, 60], [99, 90, 70, 0], { vel: 2 }),
      op(1, 80, [99, 58, 30, 60], [99, 62, 40, 0], { vel: 5 }),
      op(0.5, 94, [99, 36, 24, 58], [99, 92, 80, 0], { vel: 1 }),
      op(0.5, 64, [99, 52, 30, 58], [99, 55, 30, 0], { vel: 3 }),
      op(1, 52, [99, 66, 30, 58], [99, 30, 0, 0], { vel: 4 }),
      op(3, 44, [99, 72, 30, 58], [99, 0, 0, 0], { vel: 6 })
    ], { transpose: -12, pms: 2 }),

    // Modulators at ratios that are not whole numbers give the clang; the
    // long release lets it ring after the key is up.
    voice('GLASS BELL', 5, 0, [
      op(1, 96, [99, 30, 20, 47], [99, 80, 0, 0], { vel: 2 }),
      op(3.5, 76, [99, 34, 22, 48], [99, 70, 0, 0], { vel: 4 }),
      op(1, 90, [99, 26, 18, 46], [99, 78, 0, 0], { vel: 2, det: 4 }),
      op(7.07, 68, [99, 40, 24, 48], [99, 60, 0, 0], { vel: 4 }),
      op(4, 78, [99, 44, 28, 48], [99, 50, 0, 0], { vel: 3, det: -3 }),
      op(11.44, 60, [99, 50, 30, 50], [99, 30, 0, 0], { vel: 5 })
    ], { lfoSpeed: 28 }),

    // Three slightly detuned carriers share one modulator with full feedback:
    // its level swells a moment after the attack, as a player's breath does.
    voice('WARM BRASS', 22, 7, [
      op(1, 96, [66, 40, 30, 50], [99, 94, 90, 0], { vel: 2 }),
      op(1, 72, [58, 36, 30, 50], [99, 88, 80, 0], { vel: 4, rd: 24, bp: 48 }),
      op(1, 94, [64, 40, 30, 50], [99, 94, 90, 0], { vel: 2, det: 3 }),
      op(1, 92, [64, 40, 30, 50], [99, 94, 90, 0], { vel: 2, det: -3 }),
      op(2, 80, [60, 40, 30, 50], [99, 90, 84, 0], { vel: 3 }),
      op(1, 79, [54, 34, 28, 50], [99, 86, 78, 0], { vel: 5, rd: 30, bp: 48 })
    ], { lfoSpeed: 36, lfoDelay: 40, pmd: 6 }),

    // Six carriers as drawbars: sub, unison, octave, twelfth, two octaves, and
    // a little feedback on the top one for key-click grit.
    voice('DRAWBARS', 32, 4, [
      op(0.5, 92, [99, 99, 99, 78], [99, 99, 99, 0]),
      op(1, 96, [99, 99, 99, 78], [99, 99, 99, 0]),
      op(2, 90, [99, 99, 99, 78], [99, 99, 99, 0]),
      op(3, 86, [99, 99, 99, 78], [99, 99, 99, 0], { det: 2 }),
      op(4, 82, [99, 99, 99, 78], [99, 99, 99, 0], { det: -2 }),
      op(6, 74, [99, 70, 99, 78], [99, 80, 80, 0])
    ], { lfoSpeed: 41, pmd: 4, pms: 2 }),

    // Bright for a few milliseconds, then nearly a sine: a plucked string.
    voice('SOFT PLUCK', 5, 6, [
      op(1, 99, [99, 44, 30, 54], [99, 70, 0, 0], { vel: 3, rs: 3 }),
      op(1, 82, [99, 60, 34, 56], [99, 40, 0, 0], { vel: 5, rs: 4 }),
      op(2, 86, [99, 50, 32, 54], [99, 50, 0, 0], { vel: 3, rs: 3 }),
      op(3, 70, [99, 68, 36, 56], [99, 20, 0, 0], { vel: 6, rs: 4 }),
      op(1, 84, [99, 40, 28, 54], [99, 76, 0, 0], { vel: 2, rs: 2, det: 2 }),
      op(5, 58, [99, 74, 40, 56], [99, 0, 0, 0], { vel: 6, rs: 4 })
    ]),

    // Slow in, slow out, three pairs spread in tune and a slow LFO.
    voice('SLOW PAD', 5, 2, [
      op(1, 94, [38, 30, 30, 46], [99, 96, 92, 0], { vel: 1 }),
      op(1, 64, [30, 28, 30, 46], [99, 90, 82, 0], { vel: 2 }),
      op(1, 92, [36, 30, 30, 46], [99, 96, 92, 0], { vel: 1, det: 6 }),
      op(2, 58, [28, 28, 30, 46], [99, 88, 80, 0], { vel: 2, det: -4 }),
      op(2, 84, [34, 30, 30, 45], [99, 94, 88, 0], { vel: 1, det: -6 }),
      op(1, 60, [26, 28, 30, 46], [99, 86, 76, 0], { vel: 2, det: 5 })
    ], { lfoSpeed: 22, lfoDelay: 30, pmd: 5, lfoSync: 0, wave: 0 }),

    // A wooden bar: a 4x modulator that is gone almost at once.
    voice('WOOD BARS', 5, 0, [
      op(1, 99, [99, 46, 34, 50], [99, 60, 0, 0], { vel: 3, rs: 3 }),
      op(4, 72, [99, 76, 40, 60], [99, 0, 0, 0], { vel: 5, rs: 4 }),
      op(1, 88, [99, 52, 36, 50], [99, 40, 0, 0], { vel: 3, rs: 3, det: 1 }),
      op(10, 56, [99, 84, 40, 60], [99, 0, 0, 0], { vel: 6, rs: 5 }),
      op(2, 70, [99, 58, 40, 52], [99, 0, 0, 0], { vel: 3, rs: 3 })
    ]),

    // One modulator feeding itself is close to a sawtooth; delayed vibrato.
    voice('REED LEAD', 2, 7, [
      op(1, 99, [84, 40, 30, 60], [99, 96, 94, 0], { vel: 2 }),
      op(1, 84, [80, 40, 30, 60], [99, 92, 88, 0], { vel: 4, rd: 30, bp: 51 }),
      op(1, 86, [84, 40, 30, 60], [99, 96, 94, 0], { vel: 2, det: 4 }),
      op(2, 66, [76, 40, 30, 60], [99, 88, 80, 0], { vel: 4 })
    ], { lfoSpeed: 37, lfoDelay: 55, pmd: 9, pms: 3 })
  ];

  /* ---- the engine ---- */

  function toModule(wasm) {
    if (typeof WebAssembly === 'undefined') throw new Error('This browser has no WebAssembly.');
    if (wasm instanceof WebAssembly.Module) return wasm;
    return new WebAssembly.Module(wasm);
  }

  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

  // 0..1 to the 1..127 a key sends. 0 would be a note-off on the wire.
  function vel127(v) {
    return clamp(Math.round((v === undefined ? 0.8 : v) * 127), 1, 127);
  }

  function create(wasm, sampleRate) {
    var x = new WebAssembly.Instance(toModule(wasm), {}).exports;
    // Built as a WASI reactor: _initialize runs the C++ static constructors.
    if (x._initialize) x._initialize();
    var rate = sampleRate || 44100;
    x.dx7_init(rate);
    var voicePtr = x.malloc(156);
    var bufPtr = x.malloc(CHUNK * 4);
    // Memory is fixed-size (no growth), so these views stay valid.
    var heap = new Uint8Array(x.memory.buffer);
    var buf = new Float32Array(x.memory.buffer, bufPtr, CHUNK);

    return {
      sampleRate: rate,
      // 155 bytes, or 156 with Dexed's operator on/off byte last.
      loadVoice: function (data) {
        var d = data && data.data ? data.data : data;
        if (!d || (d.length !== 155 && d.length !== 156)) throw new Error('A voice is 155 bytes.');
        heap.set(d, voicePtr);
        x.dx7_load_voice(voicePtr, d.length);
      },
      noteOn: function (n, vel) { x.dx7_note_on(n | 0, vel127(vel)); },
      noteOff: function (n) { x.dx7_note_off(n | 0); },
      bend: function (v) { x.dx7_pitch_bend(clamp(Math.round(8192 + v * 8191), 0, 16383)); },
      bendRange: function (semitones) { x.dx7_bend_range(semitones | 0); },
      mod: function (v) { x.dx7_mod_wheel(clamp(Math.round(v * 127), 0, 127)); },
      sustain: function (on) { x.dx7_sustain(on ? 1 : 0); },
      panic: function () { x.dx7_all_notes_off(); },
      gain: function (g) { x.dx7_gain(g); },
      activeVoices: function () { return x.dx7_active_voices(); },
      render: function (out) {
        var done = 0, n;
        while (done < out.length) {
          n = Math.min(CHUNK, out.length - done);
          x.dx7_render(bufPtr, n);
          out.set(n === CHUNK ? buf : buf.subarray(0, n), done);
          done += n;
        }
        return out;
      }
    };
  }

  // notes: [[midi, startSeconds, durSeconds, velocity0to1], ...], the format
  // ASMidiRead and the editor's MIDI clips use.
  function renderNotes(wasm, voiceData, notes, opts) {
    opts = opts || {};
    var rate = opts.sampleRate || 44100;
    var tail = opts.tail === undefined ? 2 : opts.tail;
    var eng = create(wasm, rate);
    if (voiceData) eng.loadVoice(voiceData);
    if (opts.gain !== undefined) eng.gain(opts.gain);
    if (opts.bendRange !== undefined) eng.bendRange(opts.bendRange);

    var ev = [], end = 0, i, n, on, off;
    for (i = 0; i < notes.length; i++) {
      n = notes[i];
      on = Math.max(0, Math.round(n[1] * rate));
      // At least one frame long, or the off would sort ahead of its own on.
      off = Math.max(on + 1, Math.round((n[1] + n[2]) * rate));
      ev.push([on, 1, n[0], n[3], i], [off, 0, n[0], 0, i]);
      if (off > end) end = off;
    }
    // Offs before ons on the same frame: a repeated note must release before
    // it is struck again, or the second strike is the one that gets cut.
    ev.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1] || a[4] - b[4]; });

    var total = end + Math.round(tail * rate);
    var out = new Float32Array(total), pos = 0;
    for (i = 0; i < ev.length; i++) {
      if (ev[i][0] > pos) {
        eng.render(out.subarray(pos, ev[i][0]));
        pos = ev[i][0];
      }
      if (ev[i][1]) eng.noteOn(ev[i][2], ev[i][3]);
      else eng.noteOff(ev[i][2]);
    }
    if (pos < total) eng.render(out.subarray(pos, total));
    return out;
  }

  /* ---- the worklet ---- */

  // Runs inside the AudioWorkletGlobalScope, shipped as text. It cannot see
  // anything above, so it talks to the module's exports directly. The class
  // name is deliberately odd: tools/check-includes.js reads a bare name that
  // matches a site global as a missing script.
  function workletBody() {
    class AsDx7Proc extends AudioWorkletProcessor {
      constructor(options) {
        super();
        var o = (options && options.processorOptions) || {};
        this.x = null;
        try {
          var mod = o.wasm instanceof WebAssembly.Module ? o.wasm : new WebAssembly.Module(o.wasm);
          var x = new WebAssembly.Instance(mod, {}).exports;
          if (x._initialize) x._initialize();
          x.dx7_init(sampleRate);
          this.voicePtr = x.malloc(156);
          // 128 today, but the render quantum is allowed to change.
          this.cap = 2048;
          this.bufPtr = x.malloc(this.cap * 4);
          this.heap = new Uint8Array(x.memory.buffer);
          this.buf = new Float32Array(x.memory.buffer, this.bufPtr, this.cap);
          this.x = x;
          if (o.gain !== undefined) x.dx7_gain(o.gain);
          if (o.bendRange !== undefined) x.dx7_bend_range(o.bendRange);
          if (o.voice) this.voice(o.voice);
          this.port.postMessage({ t: 'ready' });
        } catch (e) {
          this.port.postMessage({ t: 'error', message: String((e && e.message) || e) });
        }
        this.port.onmessage = (e) => { this.message(e.data || {}); };
      }

      voice(d) {
        if (!d || (d.length !== 155 && d.length !== 156)) return;
        this.heap.set(d, this.voicePtr);
        this.x.dx7_load_voice(this.voicePtr, d.length);
      }

      message(m) {
        var x = this.x;
        if (!x) return;
        if (m.t === 'on') {
          x.dx7_note_on(m.n | 0, Math.max(1, Math.min(127, Math.round((m.v === undefined ? 0.8 : m.v) * 127))));
        } else if (m.t === 'off') x.dx7_note_off(m.n | 0);
        else if (m.t === 'voice') this.voice(m.data);
        else if (m.t === 'bend') x.dx7_pitch_bend(Math.max(0, Math.min(16383, Math.round(8192 + m.v * 8191))));
        else if (m.t === 'mod') x.dx7_mod_wheel(Math.max(0, Math.min(127, Math.round(m.v * 127))));
        else if (m.t === 'sus') x.dx7_sustain(m.v ? 1 : 0);
        else if (m.t === 'panic') x.dx7_all_notes_off();
        else if (m.t === 'gain') x.dx7_gain(m.v);
        else if (m.t === 'range') x.dx7_bend_range(m.v | 0);
      }

      process(inputs, outputs) {
        var out = outputs[0];
        if (!this.x || !out || !out.length) return true;
        var n = Math.min(out[0].length, this.cap), c;
        this.x.dx7_render(this.bufPtr, n);
        var src = n === this.cap ? this.buf : this.buf.subarray(0, n);
        // The DX7 has one output; every channel gets it.
        for (c = 0; c < out.length; c++) out[c].set(src);
        return true;
      }
    }
    registerProcessor('as-dx7', AsDx7Proc);
  }

  function workletSource() {
    return '(' + workletBody.toString() + ')();';
  }

  return {
    create: create,
    parseSyx: parseSyx,
    packSyx: packSyx,
    PATCHES: PATCHES,
    renderNotes: renderNotes,
    workletSource: workletSource,
    VOICE_BYTES: VOICE
  };
});
