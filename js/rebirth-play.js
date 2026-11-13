/*
 * ASRebirth: ReBirth RB-338 songs (.rbs) rendered to PCM, offline.
 *
 * The engine is OpenRB-338 (github.com/pingw33n/OpenRB-338, GPL-3.0-only), a
 * reimplementation whose output matches the original program's sample for
 * sample. Its engine crates are compiled into one standalone WebAssembly
 * file, vendor/openrb/<version>/openrb.wasm (see the README beside it).
 *
 * What is rendered: what the original's "Export Loop as Audio File" writes,
 * which is also what upstream's `orb render` writes. That is the song's
 * LOOP (the two loop markers saved in the file), not the song from bar 1 to
 * its end: an .rbs has no length field, and the original plays on to bar
 * 1000. `range` asks for other bars instead: [startBar, endBar] counted from
 * 0 with the end exclusive (upstream's --range), or 'song' for bar 0 to the
 * bar of the file's last track event. 'song' is this file's guess at "the
 * whole song", not something upstream has; a pattern-mode song has no track
 * events and falls back to the loop.
 *
 * The length is the engine's own sum: the export runs in chunks of 2048
 * frames, each advancing the position by tempo * frames * 192 / 2646000000
 * ticks, until the loop end is reached. `info().frames` is that sum.
 *
 * The rate is 44100 Hz and the engine's output is 16-bit, as the original's
 * is. The floats returned are those integers over 32768, nothing more, so
 * the peak never passes 1 and a WAV written at 16 bits is the original's
 * export bit for bit.
 *
 * Before the first chunk the engine runs 9088 idle blocks (13.2 s of
 * stopped transport). That is upstream's default and its reference
 * captures' protocol: the delay line and the filters start from the state
 * they have then. It is why a render has a short wait before any progress.
 *
 * The drum samples are not in the wasm. ReBirth's own kit and any mod are
 * Propellerhead's or their authors' material and come in as bytes: `kit`
 * for the standard kit, `mod` for the mod a song names. Each is either a
 * recrypted .rbm, which also needs `key` (2047 bytes, upstream's
 * rb20ful_window.bin), or a "clear kit" made by clearKit(), which needs no
 * key. Without samples a song still renders: the TB-303s and the effects
 * play, and the drum machines are silent (`drumsSilent`).
 *
 * A damaged file is refused with an ordinary Error. If the engine itself
 * gives up on one (a Rust panic is a WebAssembly trap) that is caught here
 * too. Each call runs in its own instance, as js/module-play.js does.
 *
 * UMD: the page, a Worker, and Node (tools/check-rebirth.js).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ASRebirth = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var RATE = 44100;
  var TICKS_PER_BAR = 768;
  var IDLE_BLOCKS = 9088;        // upstream's default (orb render --idle-blocks)
  var DEFAULT_MAX_SECONDS = 1200;
  var CHUNK = 2048;              // the export's own chunk, in frames
  var CHUNKS_PER_CALL = 32;      // 1.5 s of sound between progress reports
  var LOOP = 0xffffffff;         // both range arguments: the song's own loop
  var KEY_BYTES = 2047;
  var BAD_FILE = 'This file is not a ReBirth song (.rbs) the player can read, or it is damaged.';

  var compiled = null;    // WebAssembly.Module, kept to make new instances from
  var inst = null;        // exports of the newest instance, or null after a trap
  var restarting = null;

  function isNode() {
    return typeof process !== 'undefined' && process.versions && process.versions.node &&
      typeof require === 'function';
  }

  function toBytes(x) {
    if (x instanceof Uint8Array) return x;
    if (x instanceof ArrayBuffer) return new Uint8Array(x);
    if (x && x.buffer instanceof ArrayBuffer) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    return null;
  }

  function fetchBytes(src) {
    var bytes = toBytes(src);
    if (bytes) return Promise.resolve(bytes);
    if (typeof src !== 'string') return Promise.reject(new Error('ASRebirth.load needs the wasm bytes, a URL or a path.'));
    if (isNode() && !/^https?:/.test(src)) {
      return new Promise(function (resolve, reject) {
        require('fs').readFile(src, function (err, buf) { if (err) reject(err); else resolve(new Uint8Array(buf)); });
      });
    }
    return fetch(src).then(function (res) {
      if (!res.ok) throw new Error('Could not load the ReBirth player (' + res.status + ').');
      return res.arrayBuffer();
    }).then(function (buf) { return new Uint8Array(buf); });
  }

  // The wasm imports nothing, so there is no import object to keep in step.
  function load(src) {
    if (inst) return Promise.resolve(api);
    return fetchBytes(src).then(function (bytes) {
      return WebAssembly.compile(bytes);
    }).then(function (mod) {
      compiled = mod;
      return WebAssembly.instantiate(mod, {});
    }).then(function (instance) {
      inst = instance.exports;
      return api;
    });
  }

  // Every call gets a new instance: whatever a refused file left behind is
  // gone with it, and a trap cannot spoil the next song. Where a browser
  // will not instantiate synchronously, the previous instance is reused,
  // unless a trap has condemned it.
  function fresh() {
    if (!compiled) throw new Error('ASRebirth.load() has not finished.');
    try {
      inst = new WebAssembly.Instance(compiled, {}).exports;
    } catch (e) {
      if (inst) return;
      if (!restarting) {
        restarting = WebAssembly.instantiate(compiled, {}).then(function (instance) {
          inst = instance.exports;
          restarting = null;
        }, function () { restarting = null; });
      }
      throw new Error('The ReBirth player is restarting. Try again.');
    }
  }

  function text(x, ptr) {
    var mem = new Uint8Array(x.memory.buffer);
    var end = ptr;
    while (mem[end] !== 0) end++;
    var slice = mem.subarray(ptr, end);
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(slice);
    var s = '';
    for (var i = 0; i < slice.length; i++) s += String.fromCharCode(slice[i]);
    return decodeURIComponent(escape(s));
  }

  // Copies bytes into the wasm heap, hands (ptr, len) to fn, frees them.
  function withBytes(x, bytes, fn) {
    var ptr = x.orb_alloc(bytes.length);
    if (!ptr) throw new Error('Not enough memory to load this file.');
    try {
      new Uint8Array(x.memory.buffer).set(bytes, ptr);
      return fn(ptr, bytes.length);
    } finally {
      x.orb_free(ptr, bytes.length);
    }
  }

  // Runs fn against a new instance and turns a trap into an Error.
  function guarded(fn) {
    fresh();
    var x = inst;
    try {
      return fn(x);
    } catch (e) {
      // RuntimeError is a wasm trap; RangeError is memory that would not grow.
      if (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.RuntimeError) {
        inst = null;
        var why = '';
        // the panic text is still in the dead instance's memory
        try { why = text(x, x.orb_panic_text()); } catch (e2) { why = ''; }
        var err = new Error(BAD_FILE);
        err.detail = why || String(e.message || e);
        throw err;
      }
      if (e instanceof RangeError) {
        inst = null;
        throw new Error('Not enough memory to render this song.');
      }
      throw e;
    }
  }

  function loadSong(x, input) {
    var bytes = toBytes(input);
    if (!bytes) throw new Error('Expected the file as an ArrayBuffer or Uint8Array.');
    if (bytes.length === 0) throw new Error('That file is empty.');
    var code = withBytes(x, bytes, function (ptr, len) { return x.orb_load_song(ptr, len); });
    if (!code) {
      var err = new Error(BAD_FILE);
      err.detail = text(x, x.orb_message());
      throw err;
    }
  }

  function describe(x) {
    var o = JSON.parse(text(x, x.orb_info()));
    o.bpm = o.tempo / 1000;
    o.loopStartBar = Math.floor(o.loopStartTick / TICKS_PER_BAR);
    o.loopEndBar = Math.floor(o.loopEndTick / TICKS_PER_BAR);
    o.loopBars = Math.max(0, o.loopEndBar - o.loopStartBar);
    // 1-based, as the original's display counts; null for a song with no track events
    o.lastEventBar = o.lastEventTick === null ? null : Math.floor(o.lastEventTick / TICKS_PER_BAR) + 1;
    o.sampleRate = RATE;
    return o;
  }

  // -> [startTick, endTick] for the wasm, and the bars for the caller.
  function rangeOf(opts, facts) {
    var r = opts && opts.range;
    if (r === 'song' && facts.lastEventBar !== null) r = [0, facts.lastEventBar];
    if (r && typeof r === 'object' && r.length === 2) {
      var a = Math.floor(r[0]), b = Math.floor(r[1]);
      if (!(a >= 0 && b > a && b <= facts.maxBars)) {
        throw new Error('The range must be bars [start, end) between 0 and ' + facts.maxBars + '.');
      }
      return { ticks: [a * TICKS_PER_BAR, b * TICKS_PER_BAR], bars: [a, b], loop: false };
    }
    return { ticks: [LOOP, LOOP], bars: [facts.loopStartBar, facts.loopEndBar], loop: true };
  }

  function capOf(opts) {
    var secs = (opts && opts.maxSeconds > 0) ? opts.maxSeconds : DEFAULT_MAX_SECONDS;
    return Math.min(Math.floor(secs * RATE), 0x7fffffff);
  }

  // The export's frame count, and whether the time limit cuts it. The wasm
  // counts no further than the limit: a file can name a tempo and a loop
  // that are billions of chunks long.
  function measure(x, range, cap, facts) {
    var counted = x.orb_frames(range.ticks[0], range.ticks[1], cap + 1);
    facts.range = range.bars;
    facts.rangeIsLoop = range.loop;
    facts.truncated = counted > cap;
    facts.frames = Math.min(counted, cap);
    facts.duration = facts.frames / RATE;
    return facts.frames;
  }

  function info(input, opts) {
    var cap = capOf(opts);
    return guarded(function (x) {
      loadSong(x, input);
      var facts = describe(x);
      measure(x, rangeOf(opts, facts), cap, facts);
      return facts;
    });
  }

  function give(x, what, bytes, key, call) {
    var b = toBytes(bytes);
    if (!b) throw new Error('Expected the ' + what + ' as an ArrayBuffer or Uint8Array.');
    if (key) {
      var k = toBytes(key);
      if (!k || k.length !== KEY_BYTES) throw new Error('The key must be ' + KEY_BYTES + ' bytes.');
      withBytes(x, k, function (ptr, len) { return x.orb_set_key(ptr, len); });
    }
    var ok = withBytes(x, b, function (ptr, len) { return call(ptr, len); });
    if (!ok) throw new Error('Could not read the ' + what + ': ' + text(x, x.orb_message()));
  }

  function render(input, opts) {
    opts = opts || {};
    var cap = capOf(opts);
    var onProgress = opts.onProgress;
    var idle = opts.idleBlocks >= 0 ? Math.floor(opts.idleBlocks) : IDLE_BLOCKS;

    return guarded(function (x) {
      loadSong(x, input);
      var facts = describe(x);
      var range = rangeOf(opts, facts);
      var total = measure(x, range, cap, facts);

      if (opts.kit) give(x, 'drum kit', opts.kit, opts.key, x.orb_set_kit);
      if (opts.mod) give(x, 'mod', opts.mod, opts.key, x.orb_set_mod);

      // Allocated once at the final size, before the engine starts.
      var left = new Float32Array(total);
      var right = new Float32Array(total);

      var flags = x.orb_begin(range.ticks[0], range.ticks[1], idle);
      if (flags < 0) throw new Error('This song cannot be rendered: ' + text(x, x.orb_message()));

      var block = CHUNK * CHUNKS_PER_CALL;
      var buf = x.orb_alloc(block * 4);
      if (!buf) throw new Error('Not enough memory to render this song.');

      var done = 0, peak = 0;
      try {
        while (done < total) {
          var got = x.orb_render(buf, block);
          if (got <= 0) break;
          // the view is re-made each time: growing wasm memory detaches it
          var pcm = new Int16Array(x.memory.buffer, buf, got * 2);
          var n = Math.min(got, total - done);
          for (var i = 0; i < n; i++) {
            var l = pcm[2 * i], r = pcm[2 * i + 1];
            left[done + i] = l / 32768;
            right[done + i] = r / 32768;
            if (l < 0) l = -l;
            if (r < 0) r = -r;
            if (l > peak) peak = l;
            if (r > peak) peak = r;
          }
          done += n;
          if (onProgress) onProgress(done / total);
        }
      } finally {
        x.orb_free(buf, block * 4);
      }

      // Calls the original would have faulted in and left unwritten (its
      // PCF can divide by zero); the audio is what it writes all the same.
      var faults = x.orb_end();
      var faultText = faults ? text(x, x.orb_message()) : '';

      if (done < total) {   // cannot happen while both passes share one sum
        left = left.subarray(0, done);
        right = right.subarray(0, done);
      }

      return {
        sampleRate: RATE,
        channels: [left, right],
        duration: done / RATE,
        peak: peak / 32768,
        truncated: facts.truncated,
        info: facts,
        kitUsed: !!(flags & 1),
        modUsed: !!(flags & 2),
        modName: opts.mod ? text(x, x.orb_kit_name(1)) : '',
        // a drum machine plays in the song and there were no samples for it
        drumsSilent: !!(flags & 4),
        // the song names a mod and none was passed (the kit played instead, if there was one)
        modMissing: !!(flags & 8),
        // the mod leaves slots to the standard kit and no kit was passed
        modIncomplete: !!(flags & 16),
        // the mod passed is not the one the song names
        modMismatch: !!(flags & 32),
        faults: faults,
        faultText: faultText
      };
    });
  }

  // A recrypted .rbm with its key -> the same samples as a clear kit, which
  // loads without the key. Samples only: the panel pictures are left out.
  function clearKit(rbm, key) {
    return guarded(function (x) {
      give(x, 'mod', rbm, key, x.orb_set_kit);
      var len = x.orb_export_kit(0);
      if (!len) throw new Error('Could not read the mod: ' + text(x, x.orb_message()));
      var ptr = x.orb_out();
      return new Uint8Array(x.memory.buffer.slice(ptr, ptr + len));
    });
  }

  // An empty RBS 4.2 song (upstream's rbs::Song::empty, written out): four
  // silent bars. tools/check-rebirth.js runs on it where it has no song.
  function blankSong() {
    return guarded(function (x) {
      var len = x.orb_blank_song();
      var ptr = x.orb_out();
      return new Uint8Array(x.memory.buffer.slice(ptr, ptr + len));
    });
  }

  var api = {
    load: load,
    info: info,
    render: render,
    clearKit: clearKit,
    blankSong: blankSong,
    sampleRate: RATE,
    formats: ['rbs']
  };
  return api;
});
