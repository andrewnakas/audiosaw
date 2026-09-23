// Silence remover: trim leading + trailing silence from an AudioBuffer, then re-encode.
(function () {
  'use strict';
  var $ = CV.$;

  var dropzone = $('#dropzone');
  var fileInput = $('#fileInput');
  var fileList = $('#fileList');
  var controls = $('#controls');
  var convertBtn = $('#convertBtn');
  var resetBtn = $('#resetBtn');
  var thresholdSel = $('#threshold');
  var paddingSel = $('#padding');
  var outFmt = $('#outFmt');
  var bitrateSel = $('#bitrate');
  var statusEl = $('#status');
  var progressWrap = $('#progressWrap');
  var progressBar = $('#progressBar');
  var resultList = $('#resultList');

  var files = [];

  function onFiles(picked) {
    if (!picked || !picked.length) return;
    files = files.concat(picked);
    fileList.style.display = '';
    controls.style.display = '';
    convertBtn.disabled = false;
    CV.renderFileList(fileList, files, function (idx) {
      files.splice(idx, 1);
      if (!files.length) reset();
      else CV.renderFileList(fileList, files, arguments.callee);
    });
  }

  function reset() {
    files = [];
    fileList.innerHTML = '';
    controls.style.display = 'none';
    convertBtn.disabled = true;
    CV.clearStatus(statusEl);
    progressWrap.style.display = 'none';
    CV.setProgress(progressBar, 0);
    resultList.innerHTML = '';
  }

  // RMS-window based silence detection. Scans 10ms windows; threshold is in linear amp.
  function findContentBounds(audioBuffer, thresholdAmp) {
    var sr = audioBuffer.sampleRate;
    var windowSize = Math.max(1, Math.floor(sr * 0.01)); // 10 ms
    var len = audioBuffer.length;
    var channels = audioBuffer.numberOfChannels;

    // Get a "max abs across channels" view, computed per-window.
    function windowMax(windowStart) {
      var end = Math.min(len, windowStart + windowSize);
      var peak = 0;
      for (var c = 0; c < channels; c++) {
        var d = audioBuffer.getChannelData(c);
        for (var i = windowStart; i < end; i++) {
          var v = Math.abs(d[i]);
          if (v > peak) peak = v;
        }
      }
      return peak;
    }

    // Forward scan
    var firstSample = 0;
    for (var w = 0; w < len; w += windowSize) {
      if (windowMax(w) > thresholdAmp) { firstSample = w; break; }
    }
    // Backward scan
    var lastSample = len;
    for (var wb = Math.max(0, len - windowSize); wb >= 0; wb -= windowSize) {
      if (windowMax(wb) > thresholdAmp) { lastSample = Math.min(len, wb + windowSize); break; }
      if (wb === 0) break;
    }

    if (lastSample <= firstSample) return null; // all silent
    return { start: firstSample, end: lastSample };
  }

  function sliceBufferSamples(audioBuffer, startSample, endSample) {
    var Octx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    var sr = audioBuffer.sampleRate;
    var channels = audioBuffer.numberOfChannels;
    var length = endSample - startSample;
    var off = new Octx(channels, length, sr);
    var src = off.createBufferSource();
    var sliced = off.createBuffer(channels, length, sr);
    for (var c = 0; c < channels; c++) {
      sliced.getChannelData(c).set(audioBuffer.getChannelData(c).subarray(startSample, endSample));
    }
    src.buffer = sliced;
    src.connect(off.destination);
    src.start(0);
    return off.startRendering();
  }

  function dbToAmp(db) { return Math.pow(10, db / 20); }

  CV.bindDropzone(dropzone, fileInput, onFiles);
  resetBtn.addEventListener('click', reset);

  convertBtn.addEventListener('click', async function () {
    if (!files.length) return;
    convertBtn.disabled = true; resetBtn.disabled = true;
    progressWrap.style.display = '';
    CV.setProgress(progressBar, 0);
    resultList.innerHTML = '';

    var thresholdAmp = dbToAmp(parseFloat(thresholdSel.value));
    var paddingSec = parseFloat(paddingSel.value) || 0;
    var fmt = (outFmt.value || 'mp3').toLowerCase();
    var bitrate = parseInt(bitrateSel.value, 10) || 192;

    var outputs = [];
    var failures = [];

    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var idx = i + 1;
      try {
        CV.setStatus(statusEl, 'info', '[' + idx + '/' + files.length + '] Decoding…');
        CV.setProgress(progressBar, ((i + 0.1) / files.length) * 100);
        var ab = await AudioSaw.decodeToAudioBuffer(f);
        CV.setProgress(progressBar, ((i + 0.3) / files.length) * 100);

        CV.setStatus(statusEl, 'info', '[' + idx + '/' + files.length + '] Scanning for content…');
        var bounds = findContentBounds(ab, thresholdAmp);
        if (!bounds) throw new Error('File appears entirely silent at this threshold.');

        var pad = Math.floor(paddingSec * ab.sampleRate);
        var start = Math.max(0, bounds.start - pad);
        var end = Math.min(ab.length, bounds.end + pad);
        var origDur = ab.duration;
        var newDur = (end - start) / ab.sampleRate;
        var trimmed = origDur - newDur;

        CV.setProgress(progressBar, ((i + 0.5) / files.length) * 100);
        var processed = await sliceBufferSamples(ab, start, end);

        var blob;
        if (fmt === 'wav') {
          blob = AudioSaw.audioBufferToWav(processed);
        } else {
          blob = await AudioSaw.audioBufferToMp3(processed, bitrate, function (pct) {
            CV.setProgress(progressBar, ((i + 0.6 + (pct / 100) * 0.4) / files.length) * 100);
          });
        }
        outputs.push({ name: AudioSaw.rename(f.name, fmt), blob: blob, trimmed: trimmed });
      } catch (e) {
        failures.push({ name: f.name, error: e.message || String(e) });
      }
    }

    try {
      if (outputs.length === 1 && !failures.length) {
        CV.downloadBlob(outputs[0].blob, outputs[0].name);
        CV.setStatus(statusEl, 'success', 'Done — removed ' + outputs[0].trimmed.toFixed(2) + 's of silence');
      } else if (outputs.length > 1) {
        var zip = await AudioSaw.zipBlobs(outputs);
        CV.downloadBlob(zip, 'audiosaw-trimmed.zip');
        CV.setStatus(statusEl, 'success', 'Done — ' + outputs.length + ' files zipped' + (failures.length ? ' (' + failures.length + ' failed)' : ''));
      } else {
        CV.setStatus(statusEl, 'error', 'Could not trim. ' + (failures[0] ? failures[0].error : ''));
      }
      outputs.forEach(function (o) {
        var row = document.createElement('div');
        row.className = 'file-item';
        var label = document.createElement('span');
        var name = document.createElement('span'); name.className = 'name'; name.textContent = o.name;
        var size = document.createElement('span'); size.className = 'size';
        size.textContent = CV.fmtBytes(o.blob.size) + ' · -' + o.trimmed.toFixed(2) + 's';
        label.appendChild(name); label.appendChild(size);
        row.appendChild(label);
        var btn = document.createElement('button');
        btn.className = 'btn btn-small'; btn.textContent = 'download';
        btn.onclick = function () { CV.downloadBlob(o.blob, o.name, { again: true }); };
        row.appendChild(btn);
        resultList.appendChild(row);
      });
    } finally {
      convertBtn.disabled = files.length === 0;
      resetBtn.disabled = false;
      CV.setProgress(progressBar, 100);
    }
  });
})();
