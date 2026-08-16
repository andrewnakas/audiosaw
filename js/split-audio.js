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

  function sliceBuffer(buffer, startSample, endSample) {
    var chans = CV.channelsOf(buffer);
    var len = endSample - startSample;
    var out = [];
    for (var c = 0; c < chans.length; c++) {
      out.push(chans[c].slice(startSample, endSample));
    }
    return CV.bufferFrom(out, buffer.sampleRate);
  }

  function pad(num, width) {
    var s = String(num);
    while (s.length < width) s = '0' + s;
    return s;
  }

  function process(file, opts, onProgress) {
    onProgress(5, 'Decoding…');
    return AudioSaw.decodeToAudioBuffer(file).then(function (buf) {
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
          outputs.push({ name: base + '-' + pad(idx + 1, width) + '.' + opts.fmt, blob: blob });
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
        bitrate: parseInt(CV.$('#bitrate').value, 10) || 192
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
