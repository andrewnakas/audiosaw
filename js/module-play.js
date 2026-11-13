/*
 * ASModule: tracker modules (MOD, XM, S3M, IT) rendered to PCM, offline.
 *
 * The replayers are 8bitbubsy's C ports of the original trackers' own code,
 * all BSD-3-Clause, compiled into one standalone WebAssembly file,
 * vendor/modplay/<version>/modplay.wasm (see the README beside it):
 *   pt2-clone  ProTracker 2.3D and its Paula emulation: MODs of up to 4 channels
 *   ft2play    Fasttracker 2.09: XM, and MODs of 6 channels and more
 *   it2play    Impulse Tracker 2.15: IT, and S3M the way IT2 imports it
 * `info().player` says which one a file went to.
 *
 * Why a song "ends": a module has no length. Most loop for ever, by a jump
 * effect or by wrapping to the top of the order list. The wasm stops the
 * first time the song comes back to somewhere it has been (an order for XM,
 * S3M and IT; a row for MOD, which is pt2-clone's own MOD2WAV rule), so a
 * looping song is rendered once through. Pattern loops are part of the song
 * and are played. A loop that never leaves one pattern cannot be told from
 * a long pattern loop, and that case is what maxSeconds is for; the result
 * then has `truncated: true`.
 *
 * Why the output can pass full scale: the mix is taken as float before the
 * trackers' own 16-bit clip, so loud modules keep their peaks instead of
 * being flattened. `peak` is returned so the caller can turn it down.
 *
 * A damaged file can make a replayer read out of bounds. In WebAssembly that
 * is a trap, not a crash: it is caught here and reported as an ordinary
 * Error. Each call runs in its own instance, so nothing a bad file did to
 * the wasm memory outlives it.
 *
 * UMD: the page, a Worker, and Node (tools/check-module.js).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ASModule = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FORMATS = [null, 'MOD', 'XM', 'S3M', 'IT'];
  var PLAYERS = [null, 'pt2-clone', 'ft2play', 'it2play'];
  var MIN_RATE = 44100;   // it2play's mixer needs more than 32768 Hz
  var MAX_RATE = 96000;   // ft2play's ceiling
  var DEFAULT_RATE = 48000;
  var DEFAULT_MAX_SECONDS = 1200;
  var BAD_FILE = 'This file is not a MOD, XM, S3M or IT module the player can read, or it is damaged.';

  var compiled = null;    // WebAssembly.Module, kept to make new instances from
  var inst = null;        // exports of the newest instance, or null after a trap
  var restarting = null;

  var imports = { env: { emscripten_notify_memory_growth: function () {} } };

  function adopt(instance) {
    inst = instance.exports;
    if (inst._initialize) inst._initialize();
  }

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
    if (typeof src !== 'string') return Promise.reject(new Error('ASModule.load needs the wasm bytes, a URL or a path.'));
    if (isNode() && !/^https?:/.test(src)) {
      return new Promise(function (resolve, reject) {
        require('fs').readFile(src, function (err, buf) { if (err) reject(err); else resolve(new Uint8Array(buf)); });
      });
    }
    return fetch(src).then(function (res) {
      if (!res.ok) throw new Error('Could not load the module player (' + res.status + ').');
      return res.arrayBuffer();
    }).then(function (buf) { return new Uint8Array(buf); });
  }

  function load(src) {
    if (inst) return Promise.resolve(api);
    return fetchBytes(src).then(function (bytes) {
      return WebAssembly.compile(bytes);
    }).then(function (mod) {
      compiled = mod;
      return WebAssembly.instantiate(mod, imports);
    }).then(function (instance) {
      adopt(instance);
      return api;
    });
  }

  // Every call gets a new instance. These replayers were written for files
  // their own trackers saved; a damaged one can write past a buffer without
  // trapping, and whatever it spoiled would still be there for the next
  // song. Instantiating a compiled module takes about a millisecond. Where a
  // browser refuses to do it synchronously, the previous instance is reused,
  // unless a trap has already condemned it.
  function fresh() {
    if (!compiled) throw new Error('ASModule.load() has not finished.');
    try {
      adopt(new WebAssembly.Instance(compiled, imports));
    } catch (e) {
      if (inst) return;
      if (!restarting) {
        restarting = WebAssembly.instantiate(compiled, imports).then(function (instance) {
          adopt(instance);
          restarting = null;
        }, function () { restarting = null; });
      }
      throw new Error('The module player is restarting. Try again.');
    }
  }

  function text(ptr) {
    var mem = new Uint8Array(inst.memory.buffer);
    var s = '';
    for (var i = ptr; mem[i] !== 0; i++) {
      // Module text is DOS code page 437. Its letters above 127 are not
      // Latin-1's, so only ASCII is kept rather than showing the wrong ones.
      s += (mem[i] >= 32 && mem[i] < 127) ? String.fromCharCode(mem[i]) : ' ';
    }
    return s.replace(/\s+$/, '');
  }

  // Runs fn with the file loaded at `rate`, and always unloads it again.
  function withSong(input, rate, fn) {
    var bytes = toBytes(input);
    if (!bytes) throw new Error('Expected the file as an ArrayBuffer or Uint8Array.');
    if (bytes.length === 0) throw new Error('That file is empty.');
    fresh();

    var x = inst;
    try {
      var ptr = x.mp_alloc(bytes.length);
      if (!ptr) throw new Error('Not enough memory to load this module.');
      new Uint8Array(x.memory.buffer).set(bytes, ptr);
      var code = x.mp_load(ptr, bytes.length, rate);
      try {
        if (!code) throw new Error(BAD_FILE);
        return fn(x, FORMATS[code]);
      } finally {
        x.mp_unload();
        x.mp_free(ptr);
      }
    } catch (e) {
      // RuntimeError is a wasm trap; RangeError is memory that would not grow.
      if (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.RuntimeError) {
        inst = null;
        throw new Error(BAD_FILE);
      }
      if (e instanceof RangeError) {
        inst = null;
        throw new Error('Not enough memory to load this module.');
      }
      throw e;
    }
  }

  function describe(x, format) {
    var count = x.mp_info(3);
    var names = [];
    for (var i = 1; i <= count; i++) names.push(text(x.mp_name(i)));
    return {
      format: format,
      player: PLAYERS[x.mp_engine()],
      title: text(x.mp_name(0)),
      channels: x.mp_info(0),
      patterns: x.mp_info(1),
      orders: x.mp_info(2),
      instruments: names
    };
  }

  function rateOf(opts) {
    var rate = Math.round((opts && opts.sampleRate) || DEFAULT_RATE);
    if (!(rate >= MIN_RATE && rate <= MAX_RATE)) {
      throw new Error('The sample rate must be between ' + MIN_RATE + ' and ' + MAX_RATE + ' Hz.');
    }
    return rate;
  }

  function capOf(opts, rate) {
    var secs = (opts && opts.maxSeconds > 0) ? opts.maxSeconds : DEFAULT_MAX_SECONDS;
    return Math.min(Math.floor(secs * rate), 0x7fffffff);
  }

  function info(input, opts) {
    var rate = rateOf(opts);
    var cap = capOf(opts, rate);
    return withSong(input, rate, function (x, format) {
      var out = describe(x, format);
      var frames = x.mp_scan(cap) >>> 0;
      out.duration = frames / rate;
      out.truncated = frames >= cap;   // still playing at maxSeconds
      return out;
    });
  }

  function render(input, opts) {
    var rate = rateOf(opts);
    var cap = capOf(opts, rate);
    var onProgress = opts && opts.onProgress;

    return withSong(input, rate, function (x, format) {
      var out = describe(x, format);

      // Timing pass first (no mixing), so the result is allocated once at
      // its final size: 20 minutes of stereo float is 460 MB, and growing
      // into it would briefly need that twice.
      var total = x.mp_scan(cap) >>> 0;
      var left = new Float32Array(total);
      var right = new Float32Array(total);

      var block = Math.min(rate, 65536);
      var buf = x.mp_alloc(block * 8);
      if (!buf) throw new Error('Not enough memory to render this module.');

      var done = 0, peak = 0;
      try {
        // 4-channel MODs only: 100 is the Amiga's hard left/right, which is
        // tiring on headphones; pt2-clone's own default of 20 is kept.
        if (opts && opts.stereoSeparation >= 0) x.mp_separation(Math.min(100, Math.round(opts.stereoSeparation)));
        x.mp_start();
        while (done < total) {
          var want = Math.min(block, total - done);
          var got = x.mp_render(buf, buf + block * 4, want);
          if (got <= 0) break;
          // the buffer is re-read each time: growing wasm memory detaches it
          var mem = x.memory.buffer;
          var l = new Float32Array(mem, buf, got);
          var r = new Float32Array(mem, buf + block * 4, got);
          left.set(l, done);
          right.set(r, done);
          for (var i = 0; i < got; i++) {
            var a = l[i] < 0 ? -l[i] : l[i], b = r[i] < 0 ? -r[i] : r[i];
            if (a > peak) peak = a;
            if (b > peak) peak = b;
          }
          done += got;
          if (onProgress) onProgress(done / total);
          if (got < want) break;
        }
      } finally {
        x.mp_free(buf);
      }

      if (done < total) {   // cannot happen while both passes share one clock
        left = left.subarray(0, done);
        right = right.subarray(0, done);
      }

      return {
        sampleRate: rate,
        channels: [left, right],
        duration: done / rate,
        format: format,
        title: out.title,
        peak: peak,
        truncated: total >= cap,
        info: out
      };
    });
  }

  var api = {
    load: load,
    info: info,
    render: render,
    // Only what tools/check-module.js loads and renders.
    formats: ['mod', 'xm', 's3m', 'it']
  };
  return api;
});
