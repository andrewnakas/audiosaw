// Audio compressor: re-encodes with chosen bitrate / sample rate / channels for size reduction.
(function () {
  'use strict';
  var $ = CV.$;

  var dropzone = $('#dropzone');
  var fileInput = $('#fileInput');
  var fileList = $('#fileList');
  var controls = $('#controls');
  var convertBtn = $('#convertBtn');
  var resetBtn = $('#resetBtn');
  var targetFmt = $('#targetFormat');
  var bitrateSel = $('#bitrate');
  var sampleRateSel = $('#sampleRate');
  var channelsSel = $('#channels');
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

  CV.bindDropzone(dropzone, fileInput, onFiles);
  resetBtn.addEventListener('click', reset);

  convertBtn.addEventListener('click', async function () {
    if (!files.length) return;
    convertBtn.disabled = true; resetBtn.disabled = true;
    progressWrap.style.display = '';
    CV.setProgress(progressBar, 0);
    resultList.innerHTML = '';

    var target = (targetFmt.value || 'mp3').toLowerCase();
    var options = {
      bitrate: parseInt(bitrateSel.value, 10) || 128,
      sampleRate: sampleRateSel.value ? parseInt(sampleRateSel.value, 10) : null,
      channels: channelsSel.value ? parseInt(channelsSel.value, 10) : null
    };

    var outputs = [];
    var failures = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var idx = i + 1;
      var origSize = f.size;
      try {
        var blob = await AudioSaw.convert(f, target, options, function (pct, msg) {
          var overall = ((i + (pct / 100)) / files.length) * 100;
          CV.setProgress(progressBar, overall);
          if (msg) CV.setStatus(statusEl, 'info', '[' + idx + '/' + files.length + '] ' + msg);
        });
        var saved = origSize > 0 ? Math.round((1 - blob.size / origSize) * 100) : 0;
        outputs.push({ name: AudioSaw.rename(f.name, target), blob: blob, saved: saved, origSize: origSize });
      } catch (e) {
        failures.push({ name: f.name, error: e.message || String(e) });
      }
    }

    try {
      if (outputs.length === 1 && !failures.length) {
        CV.downloadBlob(outputs[0].blob, outputs[0].name);
        CV.setStatus(statusEl, 'success', 'Done — ' + outputs[0].name + ' (' + (outputs[0].saved > 0 ? outputs[0].saved + '% smaller' : 'no size reduction') + ')');
      } else if (outputs.length > 1) {
        CV.setStatus(statusEl, 'info', 'Packaging ' + outputs.length + ' files…');
        var zip = await AudioSaw.zipBlobs(outputs);
        CV.downloadBlob(zip, 'audiosaw-compressed.zip');
        CV.setStatus(statusEl, 'success', 'Done — ' + outputs.length + ' files zipped' + (failures.length ? ' (' + failures.length + ' failed)' : ''));
      } else {
        CV.setStatus(statusEl, 'error', 'Could not compress. ' + (failures[0] ? failures[0].error : ''));
      }
      outputs.forEach(function (o) {
        var row = document.createElement('div');
        row.className = 'file-item';
        var label = document.createElement('span');
        var name = document.createElement('span'); name.className = 'name'; name.textContent = o.name;
        var size = document.createElement('span'); size.className = 'size';
        size.textContent = CV.fmtBytes(o.blob.size) + (o.saved > 0 ? ' (-' + o.saved + '%)' : '');
        label.appendChild(name); label.appendChild(size);
        row.appendChild(label);
        var btn = document.createElement('button');
        btn.className = 'btn btn-small'; btn.textContent = 'download';
        btn.onclick = function () { CV.downloadBlob(o.blob, o.name); };
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
