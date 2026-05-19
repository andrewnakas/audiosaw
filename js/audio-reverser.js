// Audio reverser: reverse each channel's sample array, re-encode.
(function () {
  'use strict';
  var $ = CV.$;

  var dropzone = $('#dropzone');
  var fileInput = $('#fileInput');
  var fileList = $('#fileList');
  var controls = $('#controls');
  var convertBtn = $('#convertBtn');
  var resetBtn = $('#resetBtn');
  var outFmt = $('#outFmt');
  var bitrateSel = $('#bitrate');
  var statusEl = $('#status');
  var progressWrap = $('#progressWrap');
  var progressBar = $('#progressBar');
  var resultList = $('#resultList');
  var adPost = $('#adSlotPost');

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
    if (adPost) adPost.classList.remove('visible');
  }

  function reverseBuffer(audioBuffer) {
    var Octx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    var sr = audioBuffer.sampleRate;
    var len = audioBuffer.length;
    var channels = audioBuffer.numberOfChannels;
    var off = new Octx(channels, len, sr);
    var out = off.createBuffer(channels, len, sr);
    for (var c = 0; c < channels; c++) {
      var src = audioBuffer.getChannelData(c);
      var dst = out.getChannelData(c);
      for (var i = 0; i < len; i++) dst[i] = src[len - 1 - i];
    }
    var bs = off.createBufferSource();
    bs.buffer = out;
    bs.connect(off.destination);
    bs.start(0);
    return off.startRendering();
  }

  CV.bindDropzone(dropzone, fileInput, onFiles);
  resetBtn.addEventListener('click', reset);

  convertBtn.addEventListener('click', async function () {
    if (!files.length) return;
    convertBtn.disabled = true; resetBtn.disabled = true;
    progressWrap.style.display = '';
    CV.setProgress(progressBar, 0);
    resultList.innerHTML = '';

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
        CV.setStatus(statusEl, 'info', '[' + idx + '/' + files.length + '] Reversing…');
        var reversed = await reverseBuffer(ab);
        CV.setProgress(progressBar, ((i + 0.5) / files.length) * 100);

        var blob;
        if (fmt === 'wav') {
          blob = AudioSaw.audioBufferToWav(reversed);
        } else {
          blob = await AudioSaw.audioBufferToMp3(reversed, bitrate, function (pct) {
            CV.setProgress(progressBar, ((i + 0.5 + (pct / 100) * 0.5) / files.length) * 100);
          });
        }
        outputs.push({ name: AudioSaw.rename(f.name, fmt).replace(/\.([^.]+)$/, '-reversed.$1'), blob: blob });
      } catch (e) {
        failures.push({ name: f.name, error: e.message || String(e) });
      }
    }

    try {
      if (outputs.length === 1 && !failures.length) {
        CV.downloadBlob(outputs[0].blob, outputs[0].name);
        CV.setStatus(statusEl, 'success', 'Done — ' + outputs[0].name);
      } else if (outputs.length > 1) {
        var zip = await AudioSaw.zipBlobs(outputs);
        CV.downloadBlob(zip, 'audiosaw-reversed.zip');
        CV.setStatus(statusEl, 'success', 'Done — ' + outputs.length + ' files zipped' + (failures.length ? ' (' + failures.length + ' failed)' : ''));
      } else {
        CV.setStatus(statusEl, 'error', 'Could not reverse. ' + (failures[0] ? failures[0].error : ''));
      }
      outputs.forEach(function (o) {
        var row = document.createElement('div');
        row.className = 'file-item';
        var label = document.createElement('span');
        var name = document.createElement('span'); name.className = 'name'; name.textContent = o.name;
        var size = document.createElement('span'); size.className = 'size'; size.textContent = CV.fmtBytes(o.blob.size);
        label.appendChild(name); label.appendChild(size);
        row.appendChild(label);
        var btn = document.createElement('button');
        btn.className = 'btn btn-small'; btn.textContent = 'download';
        btn.onclick = function () { CV.downloadBlob(o.blob, o.name); };
        row.appendChild(btn);
        resultList.appendChild(row);
      });
      if (adPost && outputs.length) adPost.classList.add('visible');
    } finally {
      convertBtn.disabled = files.length === 0;
      resetBtn.disabled = false;
      CV.setProgress(progressBar, 100);
    }
  });
})();
