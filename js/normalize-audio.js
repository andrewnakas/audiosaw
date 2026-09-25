// Normalize audio: peak-normalize an AudioBuffer to a target dBFS, then re-encode.
(function () {
  'use strict';
  var $ = CV.$;

  var dropzone = $('#dropzone');
  var fileInput = $('#fileInput');
  var fileList = $('#fileList');
  var controls = $('#controls');
  var convertBtn = $('#convertBtn');
  var resetBtn = $('#resetBtn');
  var targetDb = $('#targetDb');
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

  // Find max |sample| across all channels.
  function findPeak(audioBuffer) {
    var peak = 0;
    for (var c = 0; c < audioBuffer.numberOfChannels; c++) {
      var d = audioBuffer.getChannelData(c);
      for (var i = 0; i < d.length; i++) {
        var v = Math.abs(d[i]);
        if (v > peak) peak = v;
      }
    }
    return peak;
  }

  // Apply gain to a new AudioBuffer (so original stays intact for retry).
  function applyGain(audioBuffer, gain) {
    var Octx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    var off = new Octx(audioBuffer.numberOfChannels, audioBuffer.length, audioBuffer.sampleRate);
    var out = off.createBuffer(audioBuffer.numberOfChannels, audioBuffer.length, audioBuffer.sampleRate);
    for (var c = 0; c < audioBuffer.numberOfChannels; c++) {
      var src = audioBuffer.getChannelData(c);
      var dst = out.getChannelData(c);
      for (var i = 0; i < src.length; i++) {
        var v = src[i] * gain;
        // Hard-clip safeguard (shouldn't trigger if peak math is right).
        if (v > 1) v = 1; else if (v < -1) v = -1;
        dst[i] = v;
      }
    }
    return out;
  }

  function dbToAmp(db) { return Math.pow(10, db / 20); }
  function ampToDb(amp) { return amp > 0 ? 20 * Math.log10(amp) : -Infinity; }

  CV.bindDropzone(dropzone, fileInput, onFiles);
  resetBtn.addEventListener('click', reset);

  convertBtn.addEventListener('click', async function () {
    if (!files.length) return;
    convertBtn.disabled = true; resetBtn.disabled = true;
    progressWrap.style.display = '';
    CV.setProgress(progressBar, 0);
    resultList.innerHTML = '';

    var fmt = (outFmt.value || 'mp3').toLowerCase();
    var bitrate = bitrateSel.value;
    var targetAmp = dbToAmp(parseFloat(targetDb.value));

    var outputs = [];
    var failures = [];

    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var idx = i + 1;
      try {
        CV.setStatus(statusEl, 'info', '[' + idx + '/' + files.length + '] Decoding ' + f.name + '…');
        CV.setProgress(progressBar, ((i + 0.1) / files.length) * 100);

        var ab = await AudioSaw.decodeToAudioBuffer(f);
        var peak = findPeak(ab);
        if (peak === 0) throw new Error('File is silent — nothing to normalize.');

        var gain = targetAmp / peak;
        var gainDb = ampToDb(gain);
        CV.setStatus(statusEl, 'info', '[' + idx + '/' + files.length + '] Peak ' + ampToDb(peak).toFixed(1) + ' dB → applying ' + (gainDb >= 0 ? '+' : '') + gainDb.toFixed(1) + ' dB gain');
        CV.setProgress(progressBar, ((i + 0.4) / files.length) * 100);

        var processed = applyGain(ab, gain);
        CV.setProgress(progressBar, ((i + 0.6) / files.length) * 100);

        var blob;
        blob = await AudioSaw.encode(processed, AudioSaw.resolveFormat(fmt, bitrate), {
          bitrate: AudioSaw.bitrateOf(bitrate),
          onProgress: function (pct) {
            CV.setProgress(progressBar, ((i + 0.6 + (pct / 100) * 0.4) / files.length) * 100);
          }
        });
        outputs.push({ name: AudioSaw.rename(f.name, fmt), blob: blob, gainDb: gainDb });
      } catch (e) {
        failures.push({ name: f.name, error: e.message || String(e) });
      }
    }

    try {
      if (outputs.length === 1 && !failures.length) {
        CV.downloadBlob(outputs[0].blob, outputs[0].name);
        CV.setStatus(statusEl, 'success', 'Done — ' + outputs[0].name + ' (' + (outputs[0].gainDb >= 0 ? '+' : '') + outputs[0].gainDb.toFixed(1) + ' dB applied)');
      } else if (outputs.length > 1) {
        var zip = await AudioSaw.zipBlobs(outputs);
        CV.downloadBlob(zip, 'audiosaw-normalized.zip');
        CV.setStatus(statusEl, 'success', 'Done — ' + outputs.length + ' files zipped' + (failures.length ? ' (' + failures.length + ' failed)' : ''));
      } else {
        CV.setStatus(statusEl, 'error', 'Could not normalize. ' + (failures[0] ? failures[0].error : ''));
      }
      outputs.forEach(function (o) {
        var row = document.createElement('div');
        row.className = 'file-item';
        var label = document.createElement('span');
        var name = document.createElement('span'); name.className = 'name'; name.textContent = o.name;
        var size = document.createElement('span'); size.className = 'size';
        size.textContent = CV.fmtBytes(o.blob.size) + ' · ' + (o.gainDb >= 0 ? '+' : '') + o.gainDb.toFixed(1) + ' dB';
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
