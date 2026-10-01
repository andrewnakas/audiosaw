/*
 * Split one long recording into several files.
 *
 * Three ways to choose the cut points, because the three real use cases want
 * different things:
 *   parts    — N equal pieces. For getting a long file under an upload limit.
 *   duration — every N minutes. For chapterising a lecture or an audiobook.
 *   silence  — at gaps. For splitting an album side or a set of takes recorded
 *              in one pass, where the natural boundaries are the pauses.
 *
 * The silence detection is the same shape as the one in silence-remover.js:
 * an RMS threshold over short windows, with a minimum gap length so a breath
 * between words is not mistaken for a track boundary.
 */
(function () {
  'use strict';

  var WINDOW = 1024;

  // Find gaps quieter than `thresholdDb` lasting at least `minGapSec`.
  // Returns cut points, in samples, at the middle of each gap.
  function findSilenceCuts(buffer, thresholdDb, minGapSec) {
    var n = buffer.length;
    var sr = buffer.sampleRate;
    var chans = CV.channelsOf(buffer);
    var threshold = Math.pow(10, thresholdDb / 20);
    var minGap = minGapSec * sr;

    var cuts = [];
    var runStart = -1;

    for (var pos = 0; pos < n; pos += WINDOW) {
      var end = Math.min(pos + WINDOW, n);
      var sum = 0, count = 0;
      for (var c = 0; c < chans.length; c++) {
        var d = chans[c];
        for (var i = pos; i < end; i++) { sum += d[i] * d[i]; count++; }
      }
      var rms = Math.sqrt(sum / Math.max(1, count));

      if (rms < threshold) {
        if (runStart < 0) runStart = pos;
      } else {
        if (runStart >= 0 && pos - runStart >= minGap) {
          // Cut in the middle of the gap so neither side loses its tail.
          cuts.push(Math.floor((runStart + pos) / 2));
        }
        runStart = -1;
      }
    }
    return cuts;
  }

  // A view, not a copy: a long recording is exactly what this tool gets, and
  // copying each part on top of the decoded file is what ran phones out of
  // memory (see AudioSaw.view).
  function sliceBuffer(buffer, startSample, endSample) {
    return AudioSaw.view(buffer, startSample, endSample);
  }

  function pad(num, width) {
    var s = String(num);
    while (s.length < width) s = '0' + s;
    return s;
  }

  // The file's length from its metadata, without decoding it.
  function durationOf(file) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file), a = new Audio(), done = false;
      function end(v) { if (done) return; done = true; URL.revokeObjectURL(url); resolve(v); }
      a.preload = 'metadata';
      a.onloadedmetadata = function () { end(isFinite(a.duration) ? a.duration : 0); };
      a.onerror = function () { end(0); };
      setTimeout(function () { end(0); }, 15000);
      a.src = url;
    });
  }

  // When the whole file will not fit in memory decoded — a two-hour MP3 is
  // 2.5 GB of samples, and phones give a tab far less — equal parts and fixed
  // lengths can still be cut without decoding: ffmpeg copies the compressed
  // stream between the cut points. The parts keep the original's format and
  // quality (no re-encode), so the format choice is set aside and said so.
  // Silence mode needs the samples, so it cannot take this path.
  function splitByCopy(file, opts, onProgress, cause) {
    if (opts.mode === 'silence') return Promise.reject(cause);
    return durationOf(file).then(function (dur) {
      if (!dur) throw cause;
      var cuts = [0];
      if (opts.mode === 'parts') { for (var p = 1; p < opts.parts; p++) cuts.push(dur * p / opts.parts); }
      else { for (var t = opts.seconds; t < dur - 0.05; t += opts.seconds) cuts.push(t); }
      cuts.push(dur);
      var inExt = (file.name.split('.').pop() || 'mp3').toLowerCase();
      var outExt = /^(mp4|mov|m4a|m4b|3gp|aac)$/.test(inExt) ? 'm4a' : inExt;
      var base = file.name.replace(/\.[^.]+$/, ''), width = String(cuts.length - 1).length, outputs = [];
      function next(i) {
        if (i >= cuts.length - 1) return Promise.resolve(outputs);
        onProgress(10 + (i / (cuts.length - 1)) * 88, 'Too large to decode here, so cutting without re-encoding: part ' + (i + 1) + ' of ' + (cuts.length - 1) + '…');
        return AudioSaw.runFFmpeg(file, inExt, ['-ss', cuts[i].toFixed(3), '-t', (cuts[i + 1] - cuts[i]).toFixed(3), '-map', '0:a:0', '-c', 'copy'],
          outExt, AudioSaw.formats[outExt] ? AudioSaw.formats[outExt].mime : 'application/octet-stream').then(function (blob) {
          outputs.push({ name: base + '-' + pad(i + 1, width) + '.' + outExt, blob: blob });
          return next(i + 1);
        });
      }
      return next(0);
    });
  }

  function isMemory(e) {
    return e && (e.name === 'RangeError' || /memory|allocation/i.test(e.message || ''));
  }

  function process(file, opts, onProgress) {
    onProgress(5, 'Decoding…');
    return AudioSaw.decodeToAudioBuffer(file).catch(function (e) {
      if (isMemory(e)) return splitByCopy(file, opts, onProgress, e);
      throw e;
    }).then(function (buf) {
      if (Array.isArray(buf)) return buf;      // split without decoding
      var sr = buf.sampleRate;
      var n = buf.length;
      var bounds = [0];

      if (opts.mode === 'parts') {
        var per = Math.floor(n / opts.parts);
        for (var p = 1; p < opts.parts; p++) bounds.push(p * per);
      } else if (opts.mode === 'duration') {
        var step = Math.floor(opts.seconds * sr);
        if (step < sr) throw new Error('Choose a chunk length of at least one second.');
        for (var t = step; t < n; t += step) bounds.push(t);
      } else {
        onProgress(15, 'Looking for gaps…');
        var cuts = findSilenceCuts(buf, opts.thresholdDb, opts.minGapSec);
        if (!cuts.length) {
          throw new Error('No gaps long enough were found. Try a shorter minimum gap, or split by duration instead.');
        }
        bounds = bounds.concat(cuts);
      }
      bounds.push(n);

      // In silence mode, two detected gaps can land close together and produce a
      // fragment that is an artefact rather than content, so require a second.
      // In parts and duration mode the boundaries are exactly what was asked
      // for — discarding them because they are short would throw away the
      // user's actual request.
      var minLen = opts.mode === 'silence' ? sr : Math.floor(sr * 0.05);
      var pieces = [];
      for (var i = 0; i < bounds.length - 1; i++) {
        if (bounds[i + 1] - bounds[i] >= minLen) pieces.push([bounds[i], bounds[i + 1]]);
      }
      if (!pieces.length) throw new Error('Splitting produced nothing long enough to keep.');

      var base = file.name.replace(/\.[^.]+$/, '');
      var width = String(pieces.length).length;
      var outputs = [];

      function encodeNext(idx) {
        if (idx >= pieces.length) return Promise.resolve(outputs);
        onProgress(20 + (idx / pieces.length) * 78, 'Encoding part ' + (idx + 1) + ' of ' + pieces.length + '…');
        var piece = sliceBuffer(buf, pieces[idx][0], pieces[idx][1]);
        return CV.encodeBuffer(piece, opts.fmt, opts.bitrate).then(function (blob) {
          outputs.push({ name: base + '-' + pad(idx + 1, width) + '.' + AudioSaw.extFor(opts.fmt), blob: blob });
          return encodeNext(idx + 1);
        });
      }

      return encodeNext(0);
    });
  }

  CV.shell({
    accept: null,
    multiple: false,
    zipName: 'audiosaw-split.zip',
    failMessage: 'Could not split that file. ',
    readOpts: function () {
      return {
        mode: CV.$('#mode').value,
        parts: parseInt(CV.$('#parts').value, 10) || 2,
        seconds: (parseFloat(CV.$('#minutes').value) || 5) * 60,
        thresholdDb: parseFloat(CV.$('#threshold').value) || -45,
        minGapSec: parseFloat(CV.$('#minGap').value) || 2,
        fmt: (CV.$('#outFmt').value || 'mp3').toLowerCase(),
        bitrate: CV.$('#bitrate').value
      };
    },
    process: process
  });

  // Show only the fields that apply to the chosen mode.
  var modeSel = CV.$('#mode');
  function syncMode() {
    var m = modeSel.value;
    CV.$('#partsWrap').style.display = m === 'parts' ? '' : 'none';
    CV.$('#minutesWrap').style.display = m === 'duration' ? '' : 'none';
    CV.$('#silenceWrap').style.display = m === 'silence' ? '' : 'none';
    CV.$('#silenceWrap2').style.display = m === 'silence' ? '' : 'none';
  }
  if (modeSel) { modeSel.addEventListener('change', syncMode); syncMode(); }
})();
