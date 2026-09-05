// AudioSaw core engine. Decodes any browser-supported audio, encodes to MP3/WAV/FLAC/OGG/M4A.
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

  // Decode any audio/video file to a Web Audio AudioBuffer.
  // Works for: mp3, wav, m4a/aac, flac, ogg (browser support varies),
  // and the audio track of mp4/mov/webm files.
  function decodeToAudioBuffer(file, onProgress) {
    if (onProgress) onProgress(5, 'Reading file…');
    return file.arrayBuffer().then(function (buf) {
      if (onProgress) onProgress(20, 'Decoding…');
      var Ctor = global.AudioContext || global.webkitAudioContext;
      var ctx = new Ctor();
      return ctx.decodeAudioData(buf.slice(0)).then(function (ab) {
        try { ctx.close(); } catch (e) {}
        if (onProgress) onProgress(50, 'Decoded ' + ab.numberOfChannels + 'ch ' + ab.sampleRate + 'Hz');
        return ab;
      }).catch(function (err) {
        try { ctx.close(); } catch (e) {}
        throw err;
      });
    });
  }

  // Mix an AudioBuffer down to mono. Average all channels into one.
  function mixToMono(audioBuffer) {
    if (audioBuffer.numberOfChannels === 1) return audioBuffer;
    var sr = audioBuffer.sampleRate;
    var len = audioBuffer.length;
    var ch = audioBuffer.numberOfChannels;
    var Octx = global.OfflineAudioContext || global.webkitOfflineAudioContext;
    var off = new Octx(1, len, sr);
    var out = off.createBuffer(1, len, sr);
    var d = out.getChannelData(0);
    for (var c = 0; c < ch; c++) {
      var src = audioBuffer.getChannelData(c);
      for (var i = 0; i < len; i++) d[i] += src[i] / ch;
    }
    var bs = off.createBufferSource();
    bs.buffer = out;
    bs.connect(off.destination);
    bs.start(0);
    return off.startRendering();
  }

  // Resample an AudioBuffer to a target sample rate using OfflineAudioContext.
  function resampleBuffer(audioBuffer, targetSampleRate) {
    if (!targetSampleRate || targetSampleRate === audioBuffer.sampleRate) {
      return Promise.resolve(audioBuffer);
    }
    var duration = audioBuffer.duration;
    var channels = audioBuffer.numberOfChannels;
    var length = Math.ceil(duration * targetSampleRate);
    var Octx = global.OfflineAudioContext || global.webkitOfflineAudioContext;
    var off = new Octx(channels, length, targetSampleRate);
    var src = off.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(off.destination);
    src.start(0);
    return off.startRendering();
  }

  // Build a WAV file from an AudioBuffer. 16-bit PCM, all channels interleaved.
  function audioBufferToWav(audioBuffer) {
    var channels = audioBuffer.numberOfChannels;
    var sampleRate = audioBuffer.sampleRate;
    var bitDepth = 16;
    var bytesPerSample = bitDepth / 8;
    var blockAlign = channels * bytesPerSample;
    var numFrames = audioBuffer.length;
    var dataSize = numFrames * blockAlign;
    var buf = new ArrayBuffer(44 + dataSize);
    var view = new DataView(buf);

    function writeStr(off, s) { for (var i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); }

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    var offset = 44;
    var channelData = [];
    for (var c = 0; c < channels; c++) channelData[c] = audioBuffer.getChannelData(c);

    for (var i = 0; i < numFrames; i++) {
      for (var ch = 0; ch < channels; ch++) {
        var s = Math.max(-1, Math.min(1, channelData[ch][i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        offset += 2;
      }
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  // Encode an AudioBuffer to MP3 using lamejs. Pure JS, no WASM.
  async function audioBufferToMp3(audioBuffer, bitrate, onProgress) {
    var lamejs = await ensureLamejs();
    bitrate = bitrate || 192;
    var channels = Math.min(audioBuffer.numberOfChannels, 2);
    var sampleRate = audioBuffer.sampleRate;
    var enc = new lamejs.Mp3Encoder(channels, sampleRate, bitrate);

    var left = audioBuffer.getChannelData(0);
    var right = channels === 2 ? audioBuffer.getChannelData(1) : null;

    // Convert float [-1,1] to int16.
    var leftI16 = new Int16Array(left.length);
    var rightI16 = right ? new Int16Array(right.length) : null;
    for (var i = 0; i < left.length; i++) {
      var l = Math.max(-1, Math.min(1, left[i]));
      leftI16[i] = l < 0 ? l * 0x8000 : l * 0x7FFF;
      if (right) {
        var r = Math.max(-1, Math.min(1, right[i]));
        rightI16[i] = r < 0 ? r * 0x8000 : r * 0x7FFF;
      }
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

  // Generic conversion via ffmpeg.wasm for formats lamejs can't do (m4a/aac/ogg/flac).
  async function convertViaFFmpeg(file, outExt, options, onProgress) {
    options = options || {};
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

    var inName = 'in_' + Date.now() + '.' + (file.name.split('.').pop() || 'bin');
    var outName = 'out.' + outExt;
    await ffmpeg.writeFile(inName, await fetchFile(file));

    var args = ['-i', inName];
    if (options.bitrate) args.push('-b:a', options.bitrate + 'k');
    if (options.sampleRate) args.push('-ar', String(options.sampleRate));
    if (options.channels) args.push('-ac', String(options.channels));
    if (outExt === 'm4a' || outExt === 'aac') args.push('-c:a', 'aac');
    if (outExt === 'flac') args.push('-c:a', 'flac');
    if (outExt === 'ogg') args.push('-c:a', 'libvorbis');
    if (outExt === 'aif' || outExt === 'aiff') args.push('-c:a', 'pcm_s16be');
    if (options.startSec != null) args.push('-ss', String(options.startSec));
    if (options.durationSec != null) args.push('-t', String(options.durationSec));
    args.push('-vn');
    args.push(outName);

    // Named so it can be removed again. Registering an anonymous listener per
    // call left every previous conversion's closure attached and firing.
    var span = Math.max(5, 97 - loadEnd);
    function onFFProgress(e) {
      if (onProgress && e && e.progress != null) {
        onProgress(loadEnd + Math.min(span, Math.max(0, e.progress * span)), 'Converting…');
      }
    }
    ffmpeg.on('progress', onFFProgress);

    var data;
    try {
      await ffmpeg.exec(args);
      data = await ffmpeg.readFile(outName);
    } finally {
      try { ffmpeg.off('progress', onFFProgress); } catch (e) {}
    }
    try { await ffmpeg.deleteFile(inName); await ffmpeg.deleteFile(outName); } catch (e) {}
    var mime = ({
      mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
      flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/opus',
      aif: 'audio/aiff', aiff: 'audio/aiff'
    })[outExt] || 'application/octet-stream';
    return new Blob([data.buffer], { type: mime });
  }

  // High-level convert function used by every tool page.
  // Routes simple WAV/MP3 paths through Web Audio + lamejs (fast, no WASM load),
  // and everything else through ffmpeg.wasm.
  async function convert(file, targetFormat, options, onProgress) {
    options = options || {};
    targetFormat = (targetFormat || 'mp3').toLowerCase();

    var isVideo = /\.(mp4|mov|webm|mkv|avi)$/i.test(file.name);
    var canFastPath = (targetFormat === 'mp3' || targetFormat === 'wav') && !isVideo;

    if (canFastPath) {
      try {
        var ab = await decodeToAudioBuffer(file, onProgress);
        if (options.channels === 1 && ab.numberOfChannels > 1) {
          if (onProgress) onProgress(45, 'Mixing to mono…');
          ab = await mixToMono(ab);
        }
        if (options.sampleRate && options.sampleRate !== ab.sampleRate) {
          if (onProgress) onProgress(50, 'Resampling…');
          ab = await resampleBuffer(ab, options.sampleRate);
        }
        if (targetFormat === 'wav') {
          if (onProgress) onProgress(80, 'Writing WAV…');
          var wav = audioBufferToWav(ab);
          if (onProgress) onProgress(100, 'Done');
          return wav;
        } else {
          var mp3 = await audioBufferToMp3(ab, options.bitrate || 192, onProgress);
          if (onProgress) onProgress(100, 'Done');
          return mp3;
        }
      } catch (err) {
        // Fall through to ffmpeg for codecs Web Audio can't decode (rare).
      }
    }

    var blob = await convertViaFFmpeg(file, targetFormat, options, onProgress);
    if (onProgress) onProgress(100, 'Done');
    return blob;
  }

  // Replace the extension on a filename.
  function rename(name, newExt) {
    var i = name.lastIndexOf('.');
    var base = i >= 0 ? name.substring(0, i) : name;
    return base + '.' + newExt;
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
    resampleBuffer: resampleBuffer,
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
