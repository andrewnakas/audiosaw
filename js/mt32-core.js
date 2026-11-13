/*
 * ASMt32: a Roland MT-32 / CM-32L rendered from MIDI events, offline.
 *
 * The synth is Munt's libmt32emu (LGPL-2.1-or-later) compiled to a standalone
 * WebAssembly file, /vendor/mt32emu/<version>/mt32emu.wasm. That file is kept
 * separate and is handed in as bytes on every call, so a visitor can swap in
 * their own build of the library (see the README beside it). Nothing here
 * fetches anything.
 *
 * The emulator plays nothing without Roland's two ROMs (control and PCM). They
 * are Roland's copyright and are not on this site: the visitor supplies their
 * own, and the library decides by SHA-1 whether it knows them. `identify`
 * says what a file is before a render is tried.
 *
 * Everything is a Promise: a browser's main thread refuses to compile or
 * instantiate a module this size synchronously.
 *
 *   ASMt32.identify(wasm, romBytes)  -> Promise<info | null>
 *     info = { kind: 'control'|'pcm', machine: 'MT-32'|'CM-32L'|'CM-32LN',
 *              version: '1.07'|'BlueRidge'|'' (PCM ROMs carry none),
 *              id: 'ctrl_mt32_1_07', name, sha1,
 *              part: 'whole'|'first'|'second'|'even'|'odd' }
 *     A part other than 'whole' is half of a ROM dumped as two chips.
 *   ASMt32.known(wasm)               -> Promise<info[]>  every ROM it knows
 *   ASMt32.render(wasm, { control, pcm }, events, opts) -> Promise<result>
 *     control / pcm: bytes, or [half, half] in either order.
 *     events: [{ t: seconds, data: Uint8Array | [status, d1, d2] }], sorted.
 *     opts: maxSeconds 1800, tail 3, onProgress(fraction), and
 *           analog 'coarse' (default) | 'digital', renderer 'int' | 'float'.
 *     result: { sampleRate: 32000, channels: [L, R], duration, skipped,
 *               roms: { control: info, pcm: info } }
 *   `wasm` is the file's bytes (ArrayBuffer or typed array) or a compiled
 *   WebAssembly.Module.
 *
 * Output is at the machine's own 32 kHz; the caller resamples. Parts 1-8
 * listen on MIDI channels 2-9 and rhythm on 10, as on the hardware. Two
 * renders of the same input are identical: each one starts a fresh instance.
 *
 * UMD: the page, a Worker, and Node (tools/check-mt32.js).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ASMt32 = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var BLOCK = 4096;              // frames per call into the module
  var PROGRESS_EVERY = 32000;    // frames between onProgress calls: once a second of music
  var PARTS = ['whole', 'first', 'second', 'even', 'odd'];   // ROMInfo::PairType order

  // Compiling is the slow part of start-up, so it is done once per set of
  // bytes. Keyed by the object handed in, which callers keep and reuse.
  var compiled = typeof WeakMap === 'function' ? new WeakMap() : null;

  function fail(message, code) {
    var e = new Error(message);
    e.code = code;
    return e;
  }

  function bytesOf(x) {
    if (x instanceof Uint8Array) return x;
    if (x instanceof ArrayBuffer) return new Uint8Array(x);
    if (x && x.buffer instanceof ArrayBuffer) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    return null;
  }

  function compile(wasm) {
    if (typeof WebAssembly !== 'object') {
      return Promise.reject(fail('This browser has no WebAssembly, which the MT-32 emulator needs.', 'unsupported'));
    }
    if (wasm instanceof WebAssembly.Module) return Promise.resolve(wasm);
    var key = wasm && typeof wasm === 'object' ? wasm : null;
    if (key && compiled && compiled.has(key)) return compiled.get(key);
    var bytes = bytesOf(wasm);
    if (!bytes || !bytes.length) {
      return Promise.reject(fail('The MT-32 emulator file (mt32emu.wasm) is missing.', 'no_wasm'));
    }
    var p = WebAssembly.compile(bytes).catch(function () {
      throw fail('The MT-32 emulator file (mt32emu.wasm) could not be loaded.', 'bad_wasm');
    });
    if (key && compiled) compiled.set(key, p);
    return p;
  }

  // The module's whole import list. Neither does any work: the library can
  // print diagnostics, and there is nowhere for them to go.
  function imports(state) {
    return {
      env: { emscripten_notify_memory_growth: function () {} },
      wasi_snapshot_preview1: {
        fd_write: function (fd, iov, iovcnt, pnum) {
          var v = new DataView(state.x.memory.buffer), n = 0;
          for (var i = 0; i < iovcnt; i++) n += v.getUint32(iov + 8 * i + 4, true);
          v.setUint32(pnum, n, true);   // "all written", or libc would retry
          return 0;
        }
      }
    };
  }

  function start(wasm) {
    return compile(wasm).then(function (mod) {
      var state = { x: null };
      return WebAssembly.instantiate(mod, imports(state)).then(function (inst) {
        var x = state.x = inst.exports;
        if (typeof x.mt32_render !== 'function' || typeof x.malloc !== 'function') {
          throw fail('The MT-32 emulator file (mt32emu.wasm) is not the build this page expects.', 'bad_wasm');
        }
        if (x._initialize) x._initialize();
        return x;
      });
    });
  }

  function cstr(x, ptr) {
    var m = new Uint8Array(x.memory.buffer), s = '';
    while (m[ptr]) s += String.fromCharCode(m[ptr++]);
    return s;
  }

  // Copies bytes into the module. The view is made after malloc because
  // growing the memory replaces its ArrayBuffer.
  function put(x, bytes) {
    var ptr = x.malloc(Math.max(1, bytes.length));
    if (!ptr) throw fail('Out of memory in the MT-32 emulator.', 'memory');
    new Uint8Array(x.memory.buffer).set(bytes, ptr);
    return ptr;
  }

  // Reads the ROM the module last looked at.
  function info(x) {
    var id = cstr(x, x.mt32_info_id());
    var name = cstr(x, x.mt32_info_desc());
    var v = /v(\d+\.\d+)/.exec(name);
    return {
      kind: x.mt32_info_type() === 1 ? 'control' : 'pcm',   // ROMInfo::Type is {PCM, Control}
      machine: /cm32ln/.test(id) ? 'CM-32LN' : /cm32l/.test(id) ? 'CM-32L' : 'MT-32',
      version: v ? v[1] : /bluer/.test(id) ? 'BlueRidge' : '',
      id: id,
      name: name,
      sha1: cstr(x, x.mt32_info_sha1()),
      part: PARTS[x.mt32_info_pair()] || 'whole'
    };
  }

  function identifyIn(x, bytes) {
    // Every known ROM is 32 KB to 1 MB. Anything else is not copied in at
    // all, so a 2 GB file dropped by mistake costs nothing.
    if (!bytes || bytes.length < 32768 || bytes.length > 1048576) return null;
    var ptr = put(x, bytes);
    var found = x.mt32_identify(ptr, bytes.length) ? info(x) : null;
    x.free(ptr);
    return found;
  }

  function identify(wasm, rom) {
    return start(wasm).then(function (x) { return identifyIn(x, bytesOf(rom)); });
  }

  function known(wasm) {
    return start(wasm).then(function (x) {
      var list = [];
      for (var i = 0; x.mt32_known(i); i++) list.push(info(x));
      return list;
    });
  }

  var LABEL = { control: 'control ROM', pcm: 'PCM ROM' };

  function describe(i) {
    return i.machine + (i.version ? ' ' + (/^\d/.test(i.version) ? 'v' : '') + i.version : '');
  }

  // Gives the module one ROM (or its two halves) and returns what it was.
  // The bytes stay allocated: the library keeps a pointer, not a copy, and
  // the whole instance is dropped after the render.
  function addRom(x, ctx, want, given) {
    var files = Array.isArray(given) ? given : [given];
    files = files.map(bytesOf).filter(function (b) { return b && b.length; });
    if (!files.length) {
      throw fail('The ' + LABEL[want] + ' is missing. The MT-32 needs two ROM files, a control ROM and a PCM ROM.', 'missing_rom');
    }
    if (files.length > 2) throw fail('Too many files for the ' + LABEL[want] + ': it is one file, or two halves.', 'bad_rom');
    var found = null, rc = 0;
    for (var i = 0; i < files.length; i++) {
      var id = identifyIn(x, files[i]);
      if (!id) {
        throw fail('That ' + LABEL[want] + ' is not a ROM this emulator knows. It has to be an unmodified dump from an MT-32, CM-32L, CM-64 or LAPC-I.', 'unknown_rom');
      }
      if (id.kind !== want) {
        throw fail('The file given as the ' + LABEL[want] + ' is a ' + LABEL[id.kind] + ' (' + id.name + ').', 'wrong_rom');
      }
      rc = x.mt32_add_rom(ctx, put(x, files[i]), files[i].length);
      if (rc === -7) throw fail('Those two ' + LABEL[want] + ' halves do not belong together.', 'mismatch');
      if (rc < 0) throw fail('That ' + LABEL[want] + ' was refused by the emulator.', 'unknown_rom');
      found = id;
    }
    if (rc === 3 || rc === 4) {
      throw fail('Only half of the ' + LABEL[want] + ' was given (' + found.id + '). Add the other half.', 'half_rom');
    }
    if (files.length === 2) {
      // Two halves: name the whole thing. The low half of a CM-32L PCM ROM
      // is the MT-32's, so the machine comes from whichever half says CM-32L.
      var other = identifyIn(x, files[0]);
      if (other.machine !== 'MT-32') found.machine = other.machine;
      found.part = 'whole';
      found.id = found.id.replace(/_(a|b|l|h)$/, '');
      if (want === 'pcm' && found.machine !== 'MT-32') found.id = 'pcm_cm32l';
    }
    return found;
  }

  function render(wasm, roms, events, opts) {
    opts = opts || {};
    roms = roms || {};
    events = events || [];
    var maxSeconds = opts.maxSeconds > 0 ? opts.maxSeconds : 1800;
    var tail = opts.tail >= 0 ? opts.tail : 3;
    var onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;

    return start(wasm).then(function (x) {
      var ctx = x.mt32_create();
      var control = addRom(x, ctx, 'control', roms.control);
      var pcm = addRom(x, ctx, 'pcm', roms.pcm);

      var rc = x.mt32_open(ctx, opts.analog === 'digital' ? 0 : 1, opts.renderer === 'float' ? 1 : 0);
      if (rc === -7) {
        throw fail('The control ROM is from ' + (/^[AEIOU]/.test(describe(control)) ? 'an ' : 'a ') + describe(control) +
          ' and the PCM ROM from ' + (pcm.machine === 'MT-32' ? 'an MT-32' : 'a CM-32L') +
          '. Both have to come from the same kind of machine.', 'mismatch');
      }
      if (rc !== 0) throw fail('The emulator could not start with those ROMs.', 'open');

      var rate = x.mt32_rate(ctx);
      var last = 0, i;
      for (i = 0; i < events.length; i++) {
        var t = events[i] && events[i].t;
        if (typeof t !== 'number' || !(t >= 0) || !isFinite(t)) throw fail('An event has no valid time.', 'bad_events');
        if (t < last) throw fail('The events are not sorted by time.', 'bad_events');
        last = t;
      }
      if (last > maxSeconds) {
        throw fail('The music is ' + Math.ceil(last / 60) + ' minutes long. The limit is ' + Math.floor(maxSeconds / 60) + ' minutes.', 'too_long');
      }
      var lastFrame = Math.round(last * rate);
      var total = Math.min(Math.round(maxSeconds * rate), lastFrame + Math.round(tail * rate));
      total = Math.max(total, 1);

      var L, R;
      try { L = new Float32Array(total); R = new Float32Array(total); }
      catch (e) { throw fail('Not enough memory for ' + Math.ceil(total / rate / 60) + ' minutes of audio.', 'memory'); }

      var out = x.malloc(BLOCK * 2 * 4);
      var scratchLen = 1024;
      var scratch = x.malloc(scratchLen);
      if (!out || !scratch) throw fail('Out of memory in the MT-32 emulator.', 'memory');

      var pos = 0, skipped = 0, nextReport = PROGRESS_EVERY;

      function pull(frames) {
        x.mt32_render(ctx, out, frames);
        // A fresh view each time: sysex or new voices can grow the memory.
        var f = new Float32Array(x.memory.buffer, out, frames * 2);
        for (var k = 0, j = pos; k < frames; k++, j++) { L[j] = f[2 * k]; R[j] = f[2 * k + 1]; }
        pos += frames;
      }

      // Returns false once the queue stays full with no room left to render
      // into, which only a flood of events at the very end could cause.
      function send(d) {
        var isSysex = d[0] === 0xF0;
        if (isSysex) {
          if (d.length > scratchLen) {
            x.free(scratch);
            scratchLen = d.length;
            scratch = x.malloc(scratchLen);
            if (!scratch) throw fail('Out of memory in the MT-32 emulator.', 'memory');
          }
          new Uint8Array(x.memory.buffer).set(d, scratch);
        }
        var msg = isSysex ? 0 : (d[0] | ((d[1] & 0x7F) << 8) | ((d[2] & 0x7F) << 16));
        for (;;) {
          var r = isSysex ? x.mt32_play_sysex(ctx, scratch, d.length, pos) : x.mt32_play_msg(ctx, msg, pos);
          if (r === 1) return true;
          if (r < 0 || pos >= total) return false;
          // Queue full: play what is queued, then try again. The event lands
          // 2 ms late at most, which beats dropping it.
          pull(Math.min(64, total - pos));
        }
      }

      function usable(d) {
        if (!d || !d.length) return false;
        if (d[0] === 0xF0) return d[d.length - 1] === 0xF7 && d.length >= 3;
        // Channel messages only. System common and realtime mean nothing to
        // a file render, and a data byte first is a broken event.
        return d[0] >= 0x80 && d[0] < 0xF0;
      }

      var ev = 0;

      function step() {
        // One second of music per turn, so a caller that returns a Promise
        // from onProgress can let the page breathe or stop the job.
        var until = Math.min(total, pos + PROGRESS_EVERY);
        while (pos < until) {
          while (ev < events.length && Math.round(events[ev].t * rate) <= pos) {
            var d = events[ev++].data;
            if (!usable(d) || !send(d)) skipped++;
          }
          var stop = until;
          if (ev < events.length) stop = Math.min(stop, Math.round(events[ev].t * rate));
          else if (pos >= lastFrame && pos > 0 && !x.mt32_active(ctx)) { total = pos; break; }
          if (stop > pos) pull(Math.min(BLOCK, stop - pos));
        }
      }

      function finish() {
        x.mt32_close(ctx);
        if (total < L.length) { L = L.subarray(0, total); R = R.subarray(0, total); }
        return {
          sampleRate: rate,
          channels: [L, R],
          duration: total / rate,
          skipped: skipped,
          roms: { control: control, pcm: pcm }
        };
      }

      function loop() {
        for (;;) {
          step();
          if (pos >= total) {
            // Events stamped exactly at the end still count as handled.
            while (ev < events.length) { if (!usable(events[ev++].data)) skipped++; }
            if (onProgress) onProgress(1);
            return finish();
          }
          if (onProgress && pos >= nextReport) {
            nextReport = pos + PROGRESS_EVERY;
            var wait = onProgress(pos / total);
            if (wait && typeof wait.then === 'function') return wait.then(loop);
          }
        }
      }

      return loop();
    });
  }

  return {
    identify: identify,
    known: known,
    render: render,
    SAMPLE_RATE: 32000
  };
});
