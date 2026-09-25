// AudioSaw core engine. Decodes any browser-supported audio at its own sample rate,
// encodes to MP3/WAV/AIFF/FLAC/OGG/M4A (see FORMATS).
// Pure JS for MP3 (lamejs) and WAV. FFmpeg.wasm loaded lazily for M4A/AAC/OGG/FLAC and video demux.
(function (global) {
  'use strict';

  // These are served from our own origin (see /vendor) rather than a CDN.
  //
  // Not a preference — a requirement. ffmpeg.wasm 0.12 spawns its worker from a
  // chunk sitting next to ffmpeg.js, so loading the library from unpkg means
  // constructing a Worker from a cross-origin URL, which browsers refuse:
  //   "Failed to construct 'Worker': Script at '.../814.ffmpeg.js' cannot be
  //    accessed from origin 'https://audiosaw.com'"
  // That failure took out every ffmpeg-dependent conversion on the site —
  // all video input, and m4a/aac/ogg/flac/aiff output. Serving the loader
  // ourselves puts the worker chunk on our origin and the problem disappears.
  //
  // The 30.6 MB core wasm stays on the CDN: it is over Cloudflare Pages' 25 MiB
  // per-file limit, and it is the one piece that does not need to be
  // same-origin, so coreURL below points the core at it explicitly.
  var LAMEJS_URL = '/vendor/lame/lamejs.min.js?v=1.2.7';
  var FFMPEG_BASE = '/vendor/ffmpeg/ffmpeg.js?v=0.12.10';
  var FFMPEG_UTIL = '/vendor/ffmpeg/util.js?v=0.12.1';
  var FFMPEG_CORE = '/vendor/ffmpeg/ffmpeg-core.js?v=0.12.6';
  var FFMPEG_WASM = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm';

  // unpkg serves the core gzipped and sends no Content-Length, so there is no
  // header to read a total from. This is the decoded size of core@0.12.6 —
  // update it whenever FFMPEG_WASM's version changes, or the progress bar will
  // be scaled against the wrong denominator.
  var FFMPEG_WASM_BYTES = 32129114;

  // Own cache bucket, written here rather than in sw.js: this is the only code
  // that fetches the wasm (the worker gets a blob: URL it never sees), it works
  // before a service worker controls the page, and it keeps a 30 MB clone out
  // of the worker's memory.
  var CORE_CACHE = 'audiosaw-ffmpeg-core';

  var lamejsPromise = null;
  var ffmpegPromise = null;

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[data-src="' + src + '"]')) { resolve(); return; }
      var s = document.createElement('script');
      s.src = src; s.async = true; s.crossOrigin = 'anonymous';
      s.setAttribute('data-src', src);
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Failed to load ' + src)); };
      document.head.appendChild(s);
    });
  }

  function ensureLamejs() {
    if (lamejsPromise) return lamejsPromise;
    lamejsPromise = loadScript(LAMEJS_URL).then(function () {
      if (!global.lamejs) throw new Error('lamejs did not initialize');
      return global.lamejs;
    });
    return lamejsPromise;
  }

  function fmtMb(n) { return (n / (1024 * 1024)).toFixed(1); }

  // Fetch the core wasm with byte-level progress, and keep it in Cache Storage.
  //
  // Before this, the first ffmpeg conversion sat at 55% for a 30 MB download
  // with no feedback at all — which is the first thing most /mp4-to-mp3 users
  // ever see. Cache Storage rather than the HTTP cache because a 30 MB entry is
  // the first thing evicted under pressure, and this is the one download worth
  // keeping.
  async function fetchCoreWasm(onBytes) {
    var cache = null;
    try { if (global.caches) cache = await global.caches.open(CORE_CACHE); } catch (e) { cache = null; }

    if (cache) {
      try {
        var hit = await cache.match(FFMPEG_WASM);
        if (hit) {
          var cached = new Uint8Array(await hit.arrayBuffer());
          if (onBytes) onBytes(cached.length, cached.length, 'cache');
          return cached;
        }
        // Drop cores from a previous library version.
        var keys = await cache.keys();
        for (var k = 0; k < keys.length; k++) {
          if (keys[k].url !== FFMPEG_WASM) await cache.delete(keys[k]);
        }
      } catch (e) { /* a miss is just a download */ }
    }

    var res = await fetch(FFMPEG_WASM, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new Error('Failed to load codec (' + res.status + ')');

    var bytes;
    if (!res.body || !res.body.getReader) {
      bytes = new Uint8Array(await res.arrayBuffer());
      if (onBytes) onBytes(bytes.length, bytes.length, 'network');
    } else {
      // Content-Length, when present, is the *compressed* size while the reader
      // yields decoded bytes, so the ratio can pass 1. Clamp it.
      var total = parseInt(res.headers.get('Content-Length'), 10) || FFMPEG_WASM_BYTES;
      var reader = res.body.getReader();
      var chunks = [];
      var received = 0;
      for (;;) {
        var step = await reader.read();
        if (step.done) break;
        chunks.push(step.value);
        received += step.value.length;
        if (onBytes) onBytes(Math.min(received, total * 0.99), total, 'network');
      }
      bytes = new Uint8Array(received);
      var at = 0;
      for (var i = 0; i < chunks.length; i++) { bytes.set(chunks[i], at); at += chunks[i].length; }
      chunks.length = 0;
      if (onBytes) onBytes(received, received, 'network');
    }

    if (cache) {
      try {
        await cache.put(FFMPEG_WASM, new Response(bytes, {
          headers: { 'Content-Type': 'application/wasm', 'Content-Length': String(bytes.length) }
        }));
      } catch (e) { /* quota or private mode — the conversion still works */ }
    }
    return bytes;
  }

  // Watchers rather than a single callback: several tools can await the same
  // shared load promise, and all of them should see the download progress.
  var loadWatchers = [];
  function notifyLoad(received, total, source) {
    loadWatchers.forEach(function (fn) {
      try { fn(received, total, source); } catch (e) {}
    });
  }

  function ensureFFmpeg(onLog, onLoad) {
    if (onLoad) loadWatchers.push(onLoad);
    if (ffmpegPromise) return ffmpegPromise;
    ffmpegPromise = (async function () {
      await loadScript(FFMPEG_UTIL);
      await loadScript(FFMPEG_BASE);
      var FFmpegNS = global.FFmpegWASM || global.FFmpeg;
      if (!FFmpegNS) throw new Error('ffmpeg.wasm did not initialize');
      var ffmpeg = new FFmpegNS.FFmpeg();
      if (onLog) ffmpeg.on('log', function (e) { onLog(e.message); });

      // wasmURL is mandatory here: the core resolves its .wasm relative to
      // itself, and ours sits on the CDN rather than next to /vendor/ffmpeg.
      // A blob: URL is what @ffmpeg/util's own toBlobURL helper produces, so
      // the core is happy with one — and it lets us do the fetch ourselves.
      var wasmURL = FFMPEG_WASM;
      var blobURL = null;
      try {
        var bytes = await fetchCoreWasm(notifyLoad);
        blobURL = URL.createObjectURL(new Blob([bytes], { type: 'application/wasm' }));
        wasmURL = blobURL;
      } catch (e) {
        // Streaming failed; let the core fetch the URL itself as before.
      }
      try {
        await ffmpeg.load({ coreURL: FFMPEG_CORE, wasmURL: wasmURL });
      } finally {
        if (blobURL) URL.revokeObjectURL(blobURL);
        loadWatchers = [];
      }
      return { ffmpeg: ffmpeg, util: global.FFmpegUtil };
    })();
    // Don't cache a rejected promise — a network blip on the first conversion
    // would otherwise poison every later attempt for the life of the page.
    ffmpegPromise.catch(function () { ffmpegPromise = null; loadWatchers = []; });
    return ffmpegPromise;
  }

  /* ------------------------------------------------------------ sniffing */

  // Read the sample rate, channels and bit depth from a file's header, without
  // decoding it. Returns null when the format is not recognised.
  //
  // Why it matters: decodeAudioData resamples to the rate of the context that
  // calls it. A plain AudioContext runs at the device rate, so a 96 kHz file
  // came back at 48 kHz, and on a 48 kHz Mac every 44.1 kHz file came back at
  // 48 kHz, on every tool. Knowing the rate up front lets decodeToAudioBuffer
  // use an OfflineAudioContext at exactly that rate, which decodes without
  // resampling (24-bit WAV and FLAC come through sample-exact; see
  // tools/check-fidelity.js).
  //
  // `bits` is the stored PCM depth for lossless formats, 0 for lossy ones.
  function sniffFormat(buf) {
    var u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    var n = u.length;
    if (n < 12) return null;
    function tag(o) { return String.fromCharCode(u[o], u[o + 1], u[o + 2], u[o + 3]); }
    function le16(o) { return u[o] | (u[o + 1] << 8); }
    function le32(o) { return (u[o] | (u[o + 1] << 8) | (u[o + 2] << 16) | (u[o + 3] << 24)) >>> 0; }
    function be16(o) { return (u[o] << 8) | u[o + 1]; }
    function be32(o) { return ((u[o] << 24) | (u[o + 1] << 16) | (u[o + 2] << 8) | u[o + 3]) >>> 0; }
    var t0 = tag(0);

    // WAV, RF64, BW64
    if ((t0 === 'RIFF' || t0 === 'RF64' || t0 === 'BW64') && tag(8) === 'WAVE') {
      for (var o = 12; o + 8 <= n;) {
        var id = tag(o), sz = le32(o + 4);
        if (id === 'fmt ' && o + 24 <= n) {
          var fmt = le16(o + 8);
          if (fmt === 0xFFFE && o + 34 <= n) fmt = le16(o + 32);
          var wbits = le16(o + 22);
          return { container: 'wav', codec: fmt === 3 ? 'float' : (fmt === 1 ? 'pcm' : 'other'),
            sampleRate: le32(o + 12), channels: le16(o + 10),
            bits: (fmt === 1 || fmt === 3) ? wbits : 0, float: fmt === 3, lossless: fmt === 1 || fmt === 3 };
        }
        o += 8 + sz + (sz & 1);
      }
      return null;
    }

    // AIFF, AIFF-C
    if (t0 === 'FORM' && (tag(8) === 'AIFF' || tag(8) === 'AIFC')) {
      for (var a = 12; a + 8 <= n;) {
        var aid = tag(a), asz = be32(a + 4);
        if (aid === 'COMM' && a + 26 <= n) {
          var exp = ((u[a + 16] & 0x7f) << 8) | u[a + 17];
          var mant = be32(a + 18);
          var rate = Math.round(mant * Math.pow(2, exp - 16383 - 31));
          var comp = tag(8) === 'AIFC' && a + 30 <= n ? tag(a + 26) : 'NONE';
          var isFloat = /^(fl32|FL32|fl64|FL64)$/.test(comp);
          var pcm = isFloat || comp === 'NONE' || comp === 'sowt' || comp === 'twos';
          return { container: 'aiff', codec: isFloat ? 'float' : (pcm ? 'pcm' : comp),
            sampleRate: rate, channels: be16(a + 8), bits: pcm ? be16(a + 14) : 0, float: isFloat, lossless: pcm };
        }
        a += 8 + asz + (asz & 1);
      }
      return null;
    }

    // FLAC: STREAMINFO is always the first metadata block.
    if (t0 === 'fLaC' && n >= 26) {
      var fr = (u[18] << 12) | (u[19] << 4) | (u[20] >> 4);
      return { container: 'flac', codec: 'flac', sampleRate: fr,
        channels: ((u[20] >> 1) & 7) + 1, bits: (((u[20] & 1) << 4) | (u[21] >> 4)) + 1, lossless: true };
    }

    // Ogg: the first packet names the codec.
    if (t0 === 'OggS' && n >= 28) {
      var p = 27 + u[26];
      if (p + 16 <= n) {
        if (u[p] === 1 && tag(p + 1) === 'vorb') {
          return { container: 'ogg', codec: 'vorbis', sampleRate: le32(p + 12), channels: u[p + 11], bits: 0, lossless: false };
        }
        // Opus always decodes at 48 kHz; the header's rate is only the original's.
        if (tag(p) === 'Opus' && tag(p + 4) === 'Head') {
          return { container: 'ogg', codec: 'opus', sampleRate: 48000, channels: u[p + 9], bits: 0, lossless: false };
        }
        if (u[p] === 0x7f && tag(p + 1) === 'FLAC' && p + 9 + 22 <= n) {
          var q = p + 9 + 4 + 10;   // 'fLaC' then the STREAMINFO block header, then 10 bytes in
          return { container: 'ogg', codec: 'flac', sampleRate: (u[q] << 12) | (u[q + 1] << 4) | (u[q + 2] >> 4),
            channels: ((u[q + 2] >> 1) & 7) + 1, bits: (((u[q + 2] & 1) << 4) | (u[q + 3] >> 4)) + 1, lossless: true };
        }
      }
      return null;
    }

    // Core Audio Format
    if (t0 === 'caff' && n >= 8 + 12 + 32 && tag(8) === 'desc') {
      var dv = new DataView(u.buffer, u.byteOffset + 20, 32);
      var fid = tag(28);
      var cbits = dv.getUint32(28);
      var lpcm = fid === 'lpcm';
      return { container: 'caf', codec: lpcm ? 'pcm' : fid, sampleRate: Math.round(dv.getFloat64(0)),
        channels: dv.getUint32(24), bits: lpcm || fid === 'alac' ? cbits : 0, float: lpcm && (dv.getUint32(12) & 1) === 1,
        lossless: lpcm || fid === 'alac' };
    }

    // WebM / Matroska: MediaRecorder's Opus is the case that matters.
    if (u[0] === 0x1A && u[1] === 0x45 && u[2] === 0xDF && u[3] === 0xA3) {
      var head = String.fromCharCode.apply(null, u.subarray(0, Math.min(n, 4096)));
      if (head.indexOf('A_OPUS') >= 0) return { container: 'webm', codec: 'opus', sampleRate: 48000, channels: 0, bits: 0, lossless: false };
      return null;
    }

    // MP4 / M4A / MOV
    if (tag(4) === 'ftyp' || tag(4) === 'moov' || tag(4) === 'mdat' || tag(4) === 'wide' || tag(4) === 'free') {
      return sniffMp4(u, be16, be32, tag);
    }

    // ADTS AAC
    var s0 = skipId3(u);
    if (u[s0] === 0xFF && (u[s0 + 1] & 0xF6) === 0xF0) {
      var ADTS = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
      var ar = ADTS[(u[s0 + 2] >> 2) & 15];
      if (ar) {
        // HE-AAC signals its base rate here and doubles it in the decoder, so a
        // low rate is decoded at twice that, never below what the decoder makes.
        return { container: 'adts', codec: 'aac', sampleRate: ar <= 24000 ? ar * 2 : ar,
          channels: ((u[s0 + 2] & 1) << 2) | (u[s0 + 3] >> 6), bits: 0, lossless: false };
      }
    }

    // MPEG audio (MP3): the first frame that is followed by another frame.
    return sniffMpeg(u, s0);
  }

  function skipId3(u) {
    var o = 0;
    while (o + 10 <= u.length && u[o] === 0x49 && u[o + 1] === 0x44 && u[o + 2] === 0x33) {
      o += 10 + ((u[o + 6] & 0x7f) << 21 | (u[o + 7] & 0x7f) << 14 | (u[o + 8] & 0x7f) << 7 | (u[o + 9] & 0x7f)) +
        ((u[o + 5] & 0x10) ? 10 : 0);
    }
    return o;
  }

  function sniffMpeg(u, from) {
    var RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
    var BR1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
    var BR2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    function frame(o) {
      if (o + 4 > u.length || u[o] !== 0xFF || (u[o + 1] & 0xE0) !== 0xE0) return null;
      var ver = (u[o + 1] >> 3) & 3, layer = (u[o + 1] >> 1) & 3;
      var bri = u[o + 2] >> 4, sri = (u[o + 2] >> 2) & 3, pad = (u[o + 2] >> 1) & 1;
      if (ver === 1 || layer !== 1 || bri === 0 || bri === 15 || sri === 3) return null;   // Layer III only
      var sr = RATES[ver][sri], br = (ver === 3 ? BR1 : BR2)[bri] * 1000;
      var len = Math.floor((ver === 3 ? 144 : 72) * br / sr) + pad;
      return { sr: sr, len: len, ch: ((u[o + 3] >> 6) === 3) ? 1 : 2 };
    }
    var end = Math.min(u.length - 4, from + 65536);
    for (var o = from; o < end; o++) {
      var f = frame(o);
      if (f && frame(o + f.len)) {
        return { container: 'mp3', codec: 'mp3', sampleRate: f.sr, channels: f.ch, bits: 0, lossless: false };
      }
    }
    return null;
  }

  // Walk the box tree to the first audio sample entry.
  function sniffMp4(u, be16, be32, tag) {
    var CONTAINERS = { moov: 1, trak: 1, mdia: 1, minf: 1, stbl: 1 };
    var AUDIO = { mp4a: 'aac', alac: 'alac', fLaC: 'flac', Opus: 'opus', 'ac-3': 'ac3', 'ec-3': 'eac3', lpcm: 'pcm',
      sowt: 'pcm', twos: 'pcm', fl32: 'float', in24: 'pcm', in32: 'pcm', '.mp3': 'mp3' };
    // The track's timescale is its sample rate for audio, and it is the only
    // place a rate above 65535 fits: the sample entry's 16.16 field cannot hold
    // 96000 (ffmpeg writes 48000 there for a 96 kHz AAC).
    var timescale = 0;
    function walk(start, end) {
      for (var o = start; o + 8 <= end;) {
        var size = be32(o), type = tag(o + 4), hdr = 8;
        if (size === 1 && o + 16 <= end) { size = be32(o + 8) * 4294967296 + be32(o + 12); hdr = 16; }
        else if (size === 0) size = end - o;
        if (size < hdr || o + size > end) size = end - o;
        if (type === 'trak') timescale = 0;
        if (type === 'mdhd' && o + hdr + 24 <= end) timescale = be32(o + hdr + (u[o + hdr] === 1 ? 20 : 12));
        if (CONTAINERS[type]) { var r = walk(o + hdr, o + size); if (r) return r; }
        if (type === 'stsd') {
          var e = o + hdr + 8;                       // version/flags + entry count
          if (e + 36 <= end) {
            var etype = tag(e + 4), codec = AUDIO[etype];
            if (codec) {
              var ch = be16(e + 24), bits = be16(e + 26), rate = be32(e + 32) >>> 16;
              var info = { container: 'mp4', codec: codec, sampleRate: rate, channels: ch, bits: 0, lossless: false };
              var body = e + 36, ebody = Math.min(o + size, e + be32(e));
              // The ALAC cookie carries a 32-bit rate (so 176.4/192 kHz fit)
              // and the real bit depth.
              for (var c = body; c + 8 <= ebody;) {
                var cs = be32(c), ct = tag(c + 4);
                if (cs < 8) break;
                if (codec === 'alac' && ct === 'alac' && c + 36 <= ebody) {
                  info.bits = u[c + 17]; info.channels = u[c + 21]; info.sampleRate = be32(c + 32);
                }
                c += cs;
              }
              if (codec === 'alac' || codec === 'flac' || codec === 'pcm' || codec === 'float') {
                info.lossless = true;
                if (!info.bits) info.bits = bits;
                info.float = codec === 'float';
              }
              if (timescale > 65535 && timescale <= 768000 && codec !== 'alac') info.sampleRate = timescale;
              if (!info.sampleRate && timescale >= 8000) info.sampleRate = timescale;
              if (codec === 'opus') info.sampleRate = 48000;
              // HE-AAC is signalled at half its output rate (sometimes only
              // implicitly), and decodes at double. Decoding a genuine
              // low-rate AAC-LC at double is only a harmless upsample; the
              // other mistake would cut off the top octave.
              if (codec === 'aac' && info.sampleRate && info.sampleRate <= 24000) info.sampleRate *= 2;
              return info.sampleRate ? info : null;
            }
          }
        }
        o += size;
      }
      return null;
    }
    return walk(0, u.length);
  }

  /* ------------------------------------------------------------ decoding */

  var nativeRateOk = {};
  // The header of the file decoded most recently. A tool decodes, builds a
  // new buffer, then encodes; "match the source" reads this when the buffer
  // it is given is not the decoded one.
  var lastInfo = null;
  function canDecodeAt(rate) {
    if (!rate || rate < 3000 || rate > 768000) return false;
    if (nativeRateOk[rate] != null) return nativeRateOk[rate];
    var O = global.OfflineAudioContext || global.webkitOfflineAudioContext;
    var ok = false;
    try { new O(1, 1, rate); ok = true; } catch (e) { ok = false; }
    nativeRateOk[rate] = ok;
    return ok;
  }

  // Decode any audio/video file to a Web Audio AudioBuffer, at the file's own
  // sample rate whenever the header says what it is. The buffer gets a `srcInfo`
  // property (the sniffed header, or null) so an encoder can match the source.
  // Works for: mp3, wav, m4a/aac, flac, ogg (browser support varies),
  // and the audio track of mp4/mov/webm files.
  function decodeToAudioBuffer(file, onProgress) {
    if (onProgress) onProgress(5, 'Reading file…');
    return file.arrayBuffer().then(function (buf) {
      if (onProgress) onProgress(20, 'Decoding…');
      var info = null;
      try { info = sniffFormat(buf); } catch (e) { info = null; }
      function viaDevice() {
        var Ctor = global.AudioContext || global.webkitAudioContext;
        var ctx = new Ctor();
        return ctx.decodeAudioData(buf.slice(0)).then(function (ab) {
          try { ctx.close(); } catch (e) {}
          return ab;
        }, function (err) {
          try { ctx.close(); } catch (e) {}
          throw err;
        });
      }
      var run;
      if (info && canDecodeAt(info.sampleRate)) {
        var O = global.OfflineAudioContext || global.webkitOfflineAudioContext;
        var off = new O(1, 1, info.sampleRate);
        // Safari's old prefixed context only has the callback form.
        run = new Promise(function (res, rej) {
          var pr = off.decodeAudioData(buf.slice(0), res, rej);
          if (pr && pr.then) pr.then(res, rej);
        }).catch(function () { return viaDevice(); });
      } else {
        run = viaDevice();
      }
      return run.then(function (ab) {
        try { ab.srcInfo = info; } catch (e) {}
        lastInfo = info;
        if (onProgress) onProgress(50, 'Decoded ' + ab.numberOfChannels + 'ch ' + ab.sampleRate + 'Hz');
        return ab;
      });
    });
  }

  function makeBuffer(chans, sampleRate) {
    var O = global.OfflineAudioContext || global.webkitOfflineAudioContext;
    var len = Math.max(1, chans[0].length);
    var off = new O(chans.length, len, sampleRate);
    var out = off.createBuffer(chans.length, len, sampleRate);
    for (var c = 0; c < chans.length; c++) out.getChannelData(c).set(chans[c]);
    return out;
  }

  function channelsOf(ab) {
    var out = [];
    for (var c = 0; c < ab.numberOfChannels; c++) out.push(ab.getChannelData(c));
    return out;
  }

  // Mix an AudioBuffer down to mono. Average all channels into one.
  function mixToMono(audioBuffer) {
    if (audioBuffer.numberOfChannels === 1) return Promise.resolve(audioBuffer);
    var len = audioBuffer.length, ch = audioBuffer.numberOfChannels;
    var d = new Float32Array(len);
    for (var c = 0; c < ch; c++) {
      var src = audioBuffer.getChannelData(c);
      for (var i = 0; i < len; i++) d[i] += src[i] / ch;
    }
    return Promise.resolve(makeBuffer([d], audioBuffer.sampleRate));
  }

  // Fold 3-8 channels to stereo with the ITU-R BS.775 coefficients: centre and
  // surrounds at -3 dB into each side, LFE dropped. Channel order is the WAV /
  // Web Audio one: L R C LFE Ls Rs (Lb Rb). Scaled down only if it would clip.
  // Before this, MP3 kept channels 0 and 1 and a 5.1 file lost its dialogue.
  function downmixStereo(ab) {
    var ch = ab.numberOfChannels;
    if (ch <= 2) return ab;
    var len = ab.length, k = Math.SQRT1_2, src = channelsOf(ab);
    var L = new Float32Array(len), R = new Float32Array(len);
    // [toL, toR] per input channel
    var map = ch === 3 ? [[1, 0], [0, 1], [k, k]]
      : ch === 4 ? [[1, 0], [0, 1], [k, 0], [0, k]]
      : ch === 5 ? [[1, 0], [0, 1], [k, k], [k, 0], [0, k]]
      : [[1, 0], [0, 1], [k, k], [0, 0], [k, 0], [0, k], [k, 0], [0, k]];
    var peak = 0;
    for (var c = 0; c < ch && c < map.length; c++) {
      var s = src[c], gl = map[c][0], gr = map[c][1];
      if (!gl && !gr) continue;
      for (var i = 0; i < len; i++) { L[i] += s[i] * gl; R[i] += s[i] * gr; }
    }
    for (var j = 0; j < len; j++) { var a = Math.max(Math.abs(L[j]), Math.abs(R[j])); if (a > peak) peak = a; }
    if (peak > 1) { var g = 1 / peak; for (var m = 0; m < len; m++) { L[m] *= g; R[m] *= g; } }
    var out = makeBuffer([L, R], ab.sampleRate);
    try { out.srcInfo = ab.srcInfo; } catch (e) {}
    return out;
  }

  // The resampler lives in its own file (it also runs in Node for the check)
  // and is loaded on first use, with the same ?v= token as this script.
  var VER = (function () {
    try { var m = /\?v=[^&#]+/.exec(document.currentScript.src); return m ? m[0] : ''; } catch (e) { return ''; }
  })();
  var resamplePromise = null;
  function ensureResampler() {
    if (global.ASResample) return Promise.resolve(global.ASResample);
    if (!resamplePromise) {
      resamplePromise = loadScript('/js/resample.js' + VER).then(function () { return global.ASResample; });
      resamplePromise.catch(function () { resamplePromise = null; });
    }
    return resamplePromise;
  }

  // Resample an AudioBuffer to a target rate with a windowed-sinc converter
  // (js/resample.js). Not with an OfflineAudioContext: Web Audio's buffer
  // source interpolates with a short kernel, which dulls the top octave and
  // lets content above the new Nyquist alias back down.
  function resampleBuffer(audioBuffer, targetSampleRate) {
    if (!targetSampleRate || targetSampleRate === audioBuffer.sampleRate) {
      return Promise.resolve(audioBuffer);
    }
    return ensureResampler().then(function (R) {
      return R.channels(channelsOf(audioBuffer), audioBuffer.sampleRate, targetSampleRate);
    }).then(function (chans) {
      var out = makeBuffer(chans, targetSampleRate);
      try { out.srcInfo = audioBuffer.srcInfo; } catch (e) {}
      return out;
    });
  }

  // Tape-style speed change: pitch and tempo move together. Done as a
  // band-limited resample (the file read as if it were recorded at sr*speed,
  // written back at sr), not with a buffer source's playbackRate, which
  // interpolates without filtering and aliases when speeding up.
  function varispeed(audioBuffer, speed) {
    var sr = audioBuffer.sampleRate;
    if (!speed || speed === 1) return Promise.resolve(audioBuffer);
    return ensureResampler().then(function (R) {
      return R.channels(channelsOf(audioBuffer), Math.round(sr * speed), sr);
    }).then(function (chans) {
      var out = makeBuffer(chans, sr);
      try { out.srcInfo = audioBuffer.srcInfo; } catch (e) {}
      return out;
    });
  }

  /* ------------------------------------------------------------ PCM writers */

  // Quantise float channels to `bits`-bit integers, interleaved. TPDF dither
  // of +-1 LSB is added before rounding, which turns truncation distortion on
  // quiet material into a flat, benign noise floor (checked: a -90 dBFS tone's
  // harmonics sit at -135 dBFS dithered, -105 truncated).
  //
  // A signal that already sits on the target grid (an unprocessed 16-bit
  // source written as 16-bit) is written bit-exact with no dither. There are
  // two grids, because decoders disagree: Chrome decodes 16-bit WAV as
  // positive / 32767 and negative / 32768, while 24-bit and other browsers
  // divide by 2^(bits-1) both ways. Whichever one the samples sit on is the
  // one used to write them back.
  function gridOf(chans, bits) {
    var s = Math.pow(2, bits - 1), sym = true, asym = true;
    for (var c = 0; c < chans.length && (sym || asym); c++) {
      var d = chans[c];
      for (var i = 0; i < d.length; i++) {
        var x = d[i];
        if (sym) { var v = x * s; if (v !== Math.round(v)) sym = false; }
        // float32 cannot hold n/32767 exactly, so this grid gets a tolerance
        // (far inside the +-1 LSB dither it replaces).
        if (asym) { var w = x > 0 ? x * (s - 1) : x * s; if (Math.abs(w - Math.round(w)) > 1e-3) asym = false; }
        if (!sym && !asym) break;
      }
    }
    return sym ? 'sym' : (asym ? 'asym' : null);
  }

  function quantise(chans, bits, dither) {
    var scale = Math.pow(2, bits - 1), max = scale - 1, min = -scale;
    var nch = chans.length, len = chans[0].length;
    var out = new Int32Array(len * nch);
    var grid = gridOf(chans, bits);
    var useDither = dither !== false && !grid;
    var pos = grid === 'asym' ? max : scale;
    var seed = 0x9E3779B9 | 0;
    function rnd() {    // xorshift32, uniform in [0, 1)
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      return (seed >>> 0) / 4294967296;
    }
    for (var i = 0, o = 0; i < len; i++) {
      for (var c = 0; c < nch; c++, o++) {
        var x = chans[c][i];
        var v = x > 0 ? x * pos : x * scale;
        if (useDither) v += rnd() - rnd();
        v = Math.round(v);
        out[o] = v > max ? max : (v < min ? min : v);
      }
    }
    return out;
  }

  function writeStr(view, off, s) { for (var i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); }

  // WAV writer. bits: 16, 24 or 32 (32 = IEEE float). More than two channels
  // uses WAVE_FORMAT_EXTENSIBLE with the standard speaker mask, which is what
  // players need to route 5.1 correctly; float carries the 'fact' chunk the
  // spec requires for non-PCM data.
  function writeWav(chans, sampleRate, bits, opts) {
    opts = opts || {};
    var nch = chans.length, len = chans[0].length, isFloat = bits === 32;
    var bps = bits / 8, blockAlign = nch * bps, dataSize = len * blockAlign;
    var ext = nch > 2;
    var fmtSize = ext ? 40 : 16;
    var factSize = isFloat ? 12 : 0;
    var headerSize = 12 + 8 + fmtSize + factSize + 8;
    var buf = new ArrayBuffer(headerSize + dataSize);
    var v = new DataView(buf);
    writeStr(v, 0, 'RIFF'); v.setUint32(4, headerSize - 8 + dataSize, true); writeStr(v, 8, 'WAVE');
    writeStr(v, 12, 'fmt '); v.setUint32(16, fmtSize, true);
    var tagCode = isFloat ? 3 : 1;
    v.setUint16(20, ext ? 0xFFFE : tagCode, true);
    v.setUint16(22, nch, true);
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * blockAlign, true);
    v.setUint16(32, blockAlign, true);
    v.setUint16(34, bits, true);
    var o = 36;
    if (ext) {
      var MASKS = { 3: 0x7, 4: 0x33, 5: 0x37, 6: 0x3F, 7: 0x13F, 8: 0x63F };
      v.setUint16(36, 22, true);
      v.setUint16(38, bits, true);
      v.setUint32(40, MASKS[nch] || 0, true);
      // KSDATAFORMAT_SUBTYPE_PCM / _IEEE_FLOAT: {0000000X-0000-0010-8000-00AA00389B71}
      v.setUint16(44, tagCode, true); v.setUint16(46, 0, true);
      v.setUint32(48, 0x00100000, true);
      v.setUint32(52, 0xAA000080, true);
      v.setUint32(56, 0x719B3800, true);
      o = 60;
    }
    if (isFloat) { writeStr(v, o, 'fact'); v.setUint32(o + 4, 4, true); v.setUint32(o + 8, len, true); o += 12; }
    writeStr(v, o, 'data'); v.setUint32(o + 4, dataSize, true); o += 8;

    if (isFloat) {
      var f = new Float32Array(len * nch);
      for (var i = 0, k = 0; i < len; i++) for (var c = 0; c < nch; c++) f[k++] = chans[c][i];
      new Uint8Array(buf, o).set(new Uint8Array(f.buffer));
    } else {
      var q = quantise(chans, bits, opts.dither);
      var u8 = new Uint8Array(buf, o);
      if (bits === 16) {
        for (var j = 0, b = 0; j < q.length; j++) { var s = q[j]; u8[b++] = s & 0xff; u8[b++] = (s >> 8) & 0xff; }
      } else {
        for (var j2 = 0, b2 = 0; j2 < q.length; j2++) { var s2 = q[j2]; u8[b2++] = s2 & 0xff; u8[b2++] = (s2 >> 8) & 0xff; u8[b2++] = (s2 >> 16) & 0xff; }
      }
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  // AIFF writer, 16 or 24-bit big-endian PCM.
  function writeAiff(chans, sampleRate, bits, opts) {
    opts = opts || {};
    var nch = chans.length, len = chans[0].length, bps = bits / 8;
    var dataSize = len * nch * bps;
    var buf = new ArrayBuffer(12 + 26 + 16 + dataSize);
    var v = new DataView(buf);
    writeStr(v, 0, 'FORM'); v.setUint32(4, 4 + 26 + 16 + dataSize); writeStr(v, 8, 'AIFF');
    writeStr(v, 12, 'COMM'); v.setUint32(16, 18);
    v.setUint16(20, nch); v.setUint32(22, len); v.setUint16(26, bits);
    // 80-bit extended sample rate
    var e = Math.floor(Math.log2(sampleRate)), mant = sampleRate / Math.pow(2, e - 31);
    v.setUint16(28, 16383 + e); v.setUint32(30, Math.floor(mant) >>> 0); v.setUint32(34, 0);
    writeStr(v, 38, 'SSND'); v.setUint32(42, 8 + dataSize); v.setUint32(46, 0); v.setUint32(50, 0);
    var q = quantise(chans, bits, opts.dither), u8 = new Uint8Array(buf, 54);
    for (var j = 0, b = 0; j < q.length; j++) {
      var s = q[j];
      if (bits === 24) u8[b++] = (s >> 16) & 0xff;
      u8[b++] = (s >> 8) & 0xff; u8[b++] = s & 0xff;
    }
    return new Blob([buf], { type: 'audio/aiff' });
  }

  // Build a WAV file from an AudioBuffer. 16-bit by default (dithered, see
  // quantise); pass 24 or 32 (float) for more.
  function audioBufferToWav(audioBuffer, bits, opts) {
    return writeWav(channelsOf(audioBuffer), audioBuffer.sampleRate, bits || 16, opts);
  }

  // 32-bit float WAV: what the editor and project link use internally, so
  // nothing is quantised between steps.
  function floatWav(audioBuffer) { return writeWav(channelsOf(audioBuffer), audioBuffer.sampleRate, 32); }

  /* ------------------------------------------------------------ encoders */

  // Every output format the site writes, by token. The token is what a page's
  // format <select> holds and what flows through `fmt` params, so a page never
  // needs to know how a format is made.
  //
  //   mp3             lamejs, CBR at the page's bitrate. Fast, no download.
  //   mp3-v0, mp3-320 LAME itself (libmp3lame in the ffmpeg core): joint
  //                   stereo, bit reservoir, and a LAME/Xing header, so
  //                   players can trim the encoder delay (gapless). lamejs has
  //                   none of those: plain L/R stereo, reservoir off, no header.
  //   wav16/24/32f    PCM, dithered (see quantise); 32f is IEEE float.
  //   aiff16/24       big-endian PCM.
  //   flac16/24       ffmpeg's FLAC at compression level 8, from our own
  //                   dithered PCM, so FLAC 16 of a 24-bit source is dithered
  //                   rather than truncated.
  //   m4a, aac, ogg   lossy, via ffmpeg, from 32-bit float.
  //   wav, flac, aiff match the source: 24-bit (or float, for WAV) when the
  //                   decoded file was lossless and deeper than 16 bits, else
  //                   16. This is what the converter pages use, so FLAC -> WAV
  //                   of a 24-bit file stays 24-bit.
  var FORMATS = {
    mp3: { ext: 'mp3', mime: 'audio/mpeg' },
    'mp3-v0': { ext: 'mp3', mime: 'audio/mpeg', lame: ['-q:a', '0'] },
    'mp3-320': { ext: 'mp3', mime: 'audio/mpeg', lame: ['-b:a', '320k'] },
    wav: { ext: 'wav', pcm: 'wav', bits: 0 },
    wav16: { ext: 'wav', pcm: 'wav', bits: 16 },
    wav24: { ext: 'wav', pcm: 'wav', bits: 24 },
    wav32f: { ext: 'wav', pcm: 'wav', bits: 32 },
    aiff: { ext: 'aiff', pcm: 'aiff', bits: 0 },
    aiff16: { ext: 'aiff', pcm: 'aiff', bits: 16 },
    aiff24: { ext: 'aiff', pcm: 'aiff', bits: 24 },
    flac: { ext: 'flac', flac: true, bits: 0 },
    flac16: { ext: 'flac', flac: true, bits: 16 },
    flac24: { ext: 'flac', flac: true, bits: 24 },
    m4a: { ext: 'm4a', mime: 'audio/mp4', lossy: ['-c:a', 'aac'] },
    aac: { ext: 'aac', mime: 'audio/aac', lossy: ['-c:a', 'aac'] },
    ogg: { ext: 'ogg', mime: 'audio/ogg', lossy: ['-c:a', 'libvorbis'], vbr: true }
    // No Opus output: libopus in the 0.12.6 core dies with "memory access out
    // of bounds" on every input tried (s16, f32, any bitrate). Opus *input*
    // decodes fine, in the browser.
  };
  FORMATS.aif = FORMATS.aiff;
  FORMATS.wav32 = FORMATS.wav32f;

  function formatOf(fmt) {
    var f = FORMATS[String(fmt || 'mp3').toLowerCase()];
    if (!f) throw new Error('Unknown output format: ' + fmt);
    return f;
  }
  // A page's two selects, format and bitrate, to one token. The bitrate
  // select also offers 'lame320' and 'v0', which pick LAME over lamejs.
  function resolveFormat(fmt, bitrate) {
    fmt = String(fmt || 'mp3').toLowerCase();
    if (fmt === 'mp3' && bitrate === 'v0') return 'mp3-v0';
    if (fmt === 'mp3' && bitrate === 'lame320') return 'mp3-320';
    return fmt;
  }
  // The number in a bitrate select's value, or the fallback for 'v0' etc.
  function bitrateOf(value, fallback) { return parseInt(value, 10) || fallback || 192; }

  function extFor(fmt) { var f = FORMATS[String(fmt || '').toLowerCase()]; return f ? f.ext : String(fmt); }
  function isLossless(fmt) { var f = FORMATS[String(fmt || '').toLowerCase()]; return !!(f && (f.pcm || f.flac)); }

  // Depth for a "match the source" token.
  function matchBits(spec, info, canFloat) {
    if (spec.bits) return spec.bits;
    if (!info || !info.lossless || !(info.bits > 16)) return 16;
    return (info.float || info.bits > 24) && canFloat ? 32 : 24;
  }

  // MP3 exists only at these rates.
  var MP3_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];
  function mp3Rate(sr) {
    if (MP3_RATES.indexOf(sr) >= 0) return sr;
    if (sr > 48000) return sr % 11025 === 0 ? 44100 : 48000;
    for (var i = 0; i < MP3_RATES.length; i++) if (MP3_RATES[i] >= sr) return MP3_RATES[i];
    return 48000;
  }

  // Encode an AudioBuffer to MP3 using lamejs. Pure JS, no WASM. More than two
  // channels are folded with downmixStereo; rates MP3 cannot carry (88.2, 96
  // kHz...) are converted first.
  async function audioBufferToMp3(audioBuffer, bitrate, onProgress) {
    var lamejs = await ensureLamejs();
    bitrate = bitrate || 192;
    audioBuffer = downmixStereo(audioBuffer);
    var target = mp3Rate(audioBuffer.sampleRate);
    if (target !== audioBuffer.sampleRate) {
      if (onProgress) onProgress(52, 'Resampling to ' + (target / 1000) + ' kHz for MP3…');
      audioBuffer = await resampleBuffer(audioBuffer, target);
    }
    var channels = audioBuffer.numberOfChannels;
    var sampleRate = audioBuffer.sampleRate;
    var enc = new lamejs.Mp3Encoder(channels, sampleRate, bitrate);

    var left = audioBuffer.getChannelData(0);
    var right = channels === 2 ? audioBuffer.getChannelData(1) : null;

    // lamejs takes 16-bit input.
    var q = quantise(right ? [left, right] : [left], 16);
    var leftI16 = new Int16Array(left.length);
    var rightI16 = right ? new Int16Array(right.length) : null;
    for (var i = 0, k = 0; i < left.length; i++) {
      leftI16[i] = q[k++];
      if (right) rightI16[i] = q[k++];
    }

    var blockSize = 1152;
    var chunks = [];
    var total = leftI16.length;
    var last = -1;
    for (var pos = 0; pos < total; pos += blockSize) {
      var endL = leftI16.subarray(pos, pos + blockSize);
      var endR = rightI16 ? rightI16.subarray(pos, pos + blockSize) : null;
      var data = endR ? enc.encodeBuffer(endL, endR) : enc.encodeBuffer(endL);
      if (data && data.length) chunks.push(data);
      if (onProgress) {
        var pct = 55 + Math.floor((pos / total) * 40);
        if (pct !== last) { onProgress(pct, 'Encoding MP3…'); last = pct; }
      }
    }
    var tail = enc.flush();
    if (tail && tail.length) chunks.push(tail);
    return new Blob(chunks, { type: 'audio/mpeg' });
  }

  // Run one ffmpeg command over one input. `input` is a File, Blob or bytes.
  async function runFFmpeg(input, inExt, args, outExt, mime, onProgress, label) {
    // Download occupies 55–90 on a cold start and collapses to a single jump to
    // 60 when the core is already cached, so the bar never runs backwards.
    var loadEnd = 60;
    var pack = await ensureFFmpeg(function (msg) { /* console.log(msg); */ },
      function (received, total, source) {
        if (!onProgress || source !== 'network' || !total) return;
        loadEnd = 90;
        onProgress(55 + 35 * (received / total),
          'Downloading codec… ' + fmtMb(received) + ' of ' + fmtMb(total) + ' MB (first time only)');
      });
    var ffmpeg = pack.ffmpeg;
    var fetchFile = pack.util.fetchFile;
    if (onProgress) onProgress(loadEnd, 'Codec ready');

    var stamp = Date.now() + '_' + Math.floor(Math.random() * 1e6);
    var inName = 'in_' + stamp + '.' + (inExt || 'bin');
    var outName = 'out_' + stamp + '.' + outExt;
    await ffmpeg.writeFile(inName, input instanceof Uint8Array ? input : await fetchFile(input));

    // Named so it can be removed again. Registering an anonymous listener per
    // call left every previous conversion's closure attached and firing.
    var span = Math.max(5, 97 - loadEnd);
    function onFFProgress(e) {
      if (onProgress && e && e.progress != null) {
        onProgress(loadEnd + Math.min(span, Math.max(0, e.progress * span)), label || 'Converting…');
      }
    }
    ffmpeg.on('progress', onFFProgress);

    var data, ret, failed = false;
    try {
      ret = await ffmpeg.exec(['-i', inName].concat(args, [outName]));
      data = await ffmpeg.readFile(outName);
    } catch (e) {
      failed = true;
      throw e;
    } finally {
      try { ffmpeg.off('progress', onFFProgress); } catch (e) {}
      try { await ffmpeg.deleteFile(inName); } catch (e) {}
      try { await ffmpeg.deleteFile(outName); } catch (e) {}
      // A failed run leaves the wasm heap in a state where the next exec dies
      // with "memory access out of bounds", so throw that instance away.
      if (failed || ret || !data || !data.length) {
        try { ffmpeg.terminate(); } catch (e) {}
        ffmpegPromise = null;
      }
    }
    if (ret || !data || !data.length) throw new Error('The encoder could not write ' + outExt.toUpperCase() + ' with these settings');
    return new Blob([data.buffer], { type: mime || 'application/octet-stream' });
  }

  // ffmpeg's own resampler at high quality, for the paths where ffmpeg does the
  // rate change. The defaults are a 32-tap filter; this is 64 with a sharper
  // cutoff, plus triangular dither whenever it reduces to 16 bits.
  function ffResample(rate) {
    return 'aresample=' + (rate ? 'out_sample_rate=' + rate + ':' : '') +
      'filter_size=64:phase_shift=10:cutoff=0.97:dither_method=triangular';
  }

  // The ffmpeg arguments that produce `spec` from whatever the input is.
  function ffmpegArgs(spec, bits, options) {
    options = options || {};
    var args = [];
    if (spec.pcm === 'wav') args.push('-c:a', bits === 32 ? 'pcm_f32le' : (bits === 24 ? 'pcm_s24le' : 'pcm_s16le'));
    else if (spec.pcm === 'aiff') args.push('-c:a', bits === 24 ? 'pcm_s24be' : 'pcm_s16be');
    else if (spec.flac) {
      args.push('-c:a', 'flac', '-compression_level', '8');
      args.push('-sample_fmt', bits === 24 ? 's32' : 's16');
      if (bits === 24) args.push('-bits_per_raw_sample', '24');
    } else if (spec.lame) { args.push('-c:a', 'libmp3lame'); args.push.apply(args, spec.lame); }
    else if (spec.ext === 'mp3') args.push('-c:a', 'libmp3lame', '-b:a', (options.bitrate || 192) + 'k');
    else if (spec.lossy && spec.vbr) {
      // Vorbis refuses a managed bitrate at high sample rates (256k at 96 kHz
      // fails to open), so its quality scale stands in: q6 ~ 192k, q10 ~ 500k.
      args.push.apply(args, spec.lossy);
      args.push('-q:a', String(Math.min(10, Math.max(0, Math.round(((options.bitrate || 192) - 64) / 32)))));
    } else if (spec.lossy) { args.push.apply(args, spec.lossy); args.push('-b:a', (options.bitrate || 192) + 'k'); }
    var rate = options.sampleRate || spec.rate;
    if (!options.noFilter) args.push('-af', ffResample(rate));
    if (options.channels) args.push('-ac', String(options.channels));
    return args;
  }

  // Encode an AudioBuffer to any token in FORMATS. opts: { bitrate, dither,
  // onProgress }. Returns a Blob.
  async function encode(buffer, fmt, opts) {
    opts = opts || {};
    var spec = formatOf(fmt);
    var onProgress = opts.onProgress;
    var info = buffer.srcInfo || opts.srcInfo || lastInfo;
    if (spec.pcm) {
      var bits = matchBits(spec, info, spec.pcm === 'wav');
      if (onProgress) onProgress(80, 'Writing ' + spec.ext.toUpperCase() + '…');
      return spec.pcm === 'wav'
        ? writeWav(channelsOf(buffer), buffer.sampleRate, bits, opts)
        : writeAiff(channelsOf(buffer), buffer.sampleRate, bits, opts);
    }
    if (spec.ext === 'mp3' && !spec.lame) return audioBufferToMp3(buffer, opts.bitrate, onProgress);
    if (spec.flac) {
      var fb = matchBits(spec, info, false);
      var pcm = writeWav(channelsOf(buffer), buffer.sampleRate, fb, opts);
      return runFFmpeg(new Uint8Array(await pcm.arrayBuffer()), 'wav', ffmpegArgs(spec, fb, { noFilter: true }),
        'flac', 'audio/flac', onProgress, 'Encoding FLAC…');
    }
    // LAME and the lossy ffmpeg codecs start from 32-bit float.
    if (spec.lame) {
      buffer = downmixStereo(buffer);
      var r = mp3Rate(buffer.sampleRate);
      if (r !== buffer.sampleRate) buffer = await resampleBuffer(buffer, r);
    } else if (spec.rate && spec.rate !== buffer.sampleRate) {
      buffer = await resampleBuffer(buffer, spec.rate);
    }
    var src = floatWav(buffer);
    var args = ffmpegArgs(spec, 0, { bitrate: opts.bitrate, noFilter: true });
    return runFFmpeg(new Uint8Array(await src.arrayBuffer()), 'wav', args, spec.ext, spec.mime,
      onProgress, 'Encoding ' + spec.ext.toUpperCase() + '…');
  }

  // Generic conversion via ffmpeg.wasm, straight from the original file. Used
  // for video input and for codecs the browser cannot decode.
  async function convertViaFFmpeg(file, outExt, options, onProgress) {
    options = options || {};
    var spec = formatOf(outExt);
    var info = null;
    try { info = sniffFormat(await file.slice(0, 1 << 20).arrayBuffer()); } catch (e) { info = null; }
    var bits = matchBits(spec, info, spec.pcm === 'wav');
    var args = ffmpegArgs(spec, bits, options);
    if (options.startSec != null) args.push('-ss', String(options.startSec));
    if (options.durationSec != null) args.push('-t', String(options.durationSec));
    args.push('-vn');
    var mime = spec.mime || (spec.flac ? 'audio/flac' : (spec.pcm === 'aiff' ? 'audio/aiff' : 'audio/wav'));
    return runFFmpeg(file, (file.name.split('.').pop() || 'bin'), args, spec.ext, mime, onProgress);
  }

  // High-level convert function used by every tool page.
  // Decodes in the browser and writes with our own encoders for MP3, PCM and
  // FLAC targets (fast, and bit-exact where the target allows); everything
  // else, video input, and anything the browser cannot decode goes through
  // ffmpeg.wasm.
  async function convert(file, targetFormat, options, onProgress) {
    options = options || {};
    // A bitrate select's raw value may name the encoder ('v0', 'lame320').
    targetFormat = resolveFormat(targetFormat, options.bitrate);
    if (options.bitrate != null) options = Object.assign({}, options, { bitrate: bitrateOf(options.bitrate) });
    var spec = formatOf(targetFormat);

    var isVideo = /\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(file.name);
    var ownEncoder = spec.ext === 'mp3' || spec.pcm || spec.flac;

    if (ownEncoder && !isVideo) {
      var ab = null;
      try { ab = await decodeToAudioBuffer(file, onProgress); } catch (err) { ab = null; }
      // Fall through to ffmpeg for codecs Web Audio can't decode (rare).
      if (ab) {
        var info = ab.srcInfo;
        if (options.channels === 1 && ab.numberOfChannels > 1) {
          if (onProgress) onProgress(45, 'Mixing to mono…');
          ab = await mixToMono(ab);
        } else if (options.channels === 2 && ab.numberOfChannels > 2) {
          ab = downmixStereo(ab);
        }
        if (options.sampleRate && options.sampleRate !== ab.sampleRate) {
          if (onProgress) onProgress(50, 'Resampling…');
          ab = await resampleBuffer(ab, options.sampleRate);
        }
        try { ab.srcInfo = info; } catch (e) {}
        var out = await encode(ab, targetFormat, { bitrate: options.bitrate, onProgress: onProgress });
        if (onProgress) onProgress(100, 'Done');
        return out;
      }
    }

    var blob = await convertViaFFmpeg(file, targetFormat, options, onProgress);
    if (onProgress) onProgress(100, 'Done');
    return blob;
  }

  // Replace the extension on a filename. Takes an extension or a format token
  // ('wav24' -> '.wav').
  function rename(name, newExt) {
    var i = name.lastIndexOf('.');
    var base = i >= 0 ? name.substring(0, i) : name;
    return base + '.' + extFor(newExt);
  }

  // Zip multiple blobs into one download (used for batch conversion).
  // Tiny inline STORE-mode zip so we don't pull in a library.
  function zipBlobs(entries) {
    // entries: [{name, blob}]
    return Promise.all(entries.map(function (e) {
      return e.blob.arrayBuffer().then(function (buf) {
        return { name: e.name, data: new Uint8Array(buf) };
      });
    })).then(function (items) {
      var enc = new TextEncoder();
      var parts = [];
      var central = [];
      var offset = 0;

      function crc32(u8) {
        var c, table = crc32.table;
        if (!table) {
          table = crc32.table = new Uint32Array(256);
          for (var n = 0; n < 256; n++) {
            c = n;
            for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
            table[n] = c >>> 0;
          }
        }
        var crc = 0xffffffff;
        for (var i = 0; i < u8.length; i++) crc = table[(crc ^ u8[i]) & 0xff] ^ (crc >>> 8);
        return (crc ^ 0xffffffff) >>> 0;
      }
      function u16(v){ var b=new Uint8Array(2); b[0]=v&0xff;b[1]=(v>>>8)&0xff; return b; }
      function u32(v){ var b=new Uint8Array(4); b[0]=v&0xff;b[1]=(v>>>8)&0xff;b[2]=(v>>>16)&0xff;b[3]=(v>>>24)&0xff; return b; }

      items.forEach(function (it) {
        var nameBytes = enc.encode(it.name);
        var crc = crc32(it.data);
        var size = it.data.length;
        var local = new Uint8Array(30 + nameBytes.length);
        local.set([0x50,0x4b,0x03,0x04], 0);
        local.set(u16(20), 4);
        local.set(u16(0), 6);
        local.set(u16(0), 8);          // method = store
        local.set(u16(0), 10);
        local.set(u16(0x21), 12);
        local.set(u32(crc), 14);
        local.set(u32(size), 18);
        local.set(u32(size), 22);
        local.set(u16(nameBytes.length), 26);
        local.set(u16(0), 28);
        local.set(nameBytes, 30);
        parts.push(local, it.data);

        var cen = new Uint8Array(46 + nameBytes.length);
        cen.set([0x50,0x4b,0x01,0x02], 0);
        cen.set(u16(20), 4);
        cen.set(u16(20), 6);
        cen.set(u16(0), 8);
        cen.set(u16(0), 10);           // method = store
        cen.set(u16(0), 12);
        cen.set(u16(0x21), 14);
        cen.set(u32(crc), 16);
        cen.set(u32(size), 20);
        cen.set(u32(size), 24);
        cen.set(u16(nameBytes.length), 28);
        cen.set(u16(0), 30);
        cen.set(u16(0), 32);
        cen.set(u16(0), 34);
        cen.set(u16(0), 36);
        cen.set(u32(0), 38);
        cen.set(u32(offset), 42);
        cen.set(nameBytes, 46);
        central.push(cen);

        offset += local.length + it.data.length;
      });

      var cenSize = central.reduce(function (a, b) { return a + b.length; }, 0);
      var cenOffset = offset;
      central.forEach(function (c) { parts.push(c); });

      var end = new Uint8Array(22);
      end.set([0x50,0x4b,0x05,0x06], 0);
      end.set(u16(0), 4);
      end.set(u16(0), 6);
      end.set(u16(items.length), 8);
      end.set(u16(items.length), 10);
      end.set(u32(cenSize), 12);
      end.set(u32(cenOffset), 16);
      end.set(u16(0), 20);
      parts.push(end);

      return new Blob(parts, { type: 'application/zip' });
    });
  }

  global.AudioSaw = {
    decodeToAudioBuffer: decodeToAudioBuffer,
    sniffFormat: sniffFormat,
    encode: encode,
    extFor: extFor,
    resolveFormat: resolveFormat,
    bitrateOf: bitrateOf,
    isLossless: isLossless,
    formats: FORMATS,
    writeWav: writeWav,
    floatWav: floatWav,
    downmixStereo: downmixStereo,
    makeBuffer: makeBuffer,
    ensureResampler: ensureResampler,
    resampleBuffer: resampleBuffer,
    varispeed: varispeed,
    runFFmpeg: runFFmpeg,
    mixToMono: mixToMono,
    audioBufferToWav: audioBufferToWav,
    audioBufferToMp3: audioBufferToMp3,
    convertViaFFmpeg: convertViaFFmpeg,
    convert: convert,
    rename: rename,
    zipBlobs: zipBlobs,
    ensureFFmpeg: ensureFFmpeg,
    ensureLamejs: ensureLamejs
  };
})(window);
