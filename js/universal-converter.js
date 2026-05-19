// Homepage "drop anything" converter. Single dropzone, pick target format, convert (or batch-convert).
(function () {
  'use strict';
  var $ = CV.$;

  var dropzone = $('#dropzone');
  var fileInput = $('#fileInput');
  var controls = $('#universalControls');
  var fileList = $('#fileList');
  var convertBtn = $('#convertBtn');
  var resetBtn = $('#resetBtn');
  var targetSel = $('#targetFormat');
  var bitrateSel = $('#bitrate');
  var sampleSel = $('#sampleRate');
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
    CV.renderFileList(fileList, files, function (idx) {
      files.splice(idx, 1);
      if (!files.length) { reset(); return; }
      CV.renderFileList(fileList, files, arguments.callee);
    });
  }

  function reset() {
    files = [];
    fileList.innerHTML = '';
    controls.style.display = 'none';
    CV.clearStatus(statusEl);
    progressWrap.style.display = 'none';
    CV.setProgress(progressBar, 0);
    resultList.innerHTML = '';
    if (adPost) adPost.classList.remove('visible');
  }

  CV.bindDropzone(dropzone, fileInput, onFiles);
  resetBtn.addEventListener('click', reset);

  convertBtn.addEventListener('click', async function () {
    if (!files.length) return;
    convertBtn.disabled = true;
    resetBtn.disabled = true;
    progressWrap.style.display = '';
    CV.setProgress(progressBar, 0);
    resultList.innerHTML = '';

    var target = targetSel.value;
    var options = {
      bitrate: parseInt(bitrateSel.value, 10) || 192,
      sampleRate: sampleSel.value ? parseInt(sampleSel.value, 10) : null
    };

    var outputs = [];
    var failures = [];
    try {
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        var idx = i + 1;
        CV.setStatus(statusEl, 'info', 'Converting ' + idx + '/' + files.length + ': ' + f.name);
        try {
          var blob = await AudioSaw.convert(f, target, options, function (pct, msg) {
            var overall = ((i + (pct / 100)) / files.length) * 100;
            CV.setProgress(progressBar, overall);
            if (msg) CV.setStatus(statusEl, 'info', '[' + idx + '/' + files.length + '] ' + msg + ' — ' + f.name);
          });
          outputs.push({ name: AudioSaw.rename(f.name, target), blob: blob });
        } catch (e) {
          failures.push({ name: f.name, error: e.message || String(e) });
        }
      }

      if (outputs.length === 1 && !failures.length) {
        CV.downloadBlob(outputs[0].blob, outputs[0].name);
        renderResult(outputs);
        CV.setStatus(statusEl, 'success', 'Done — downloaded ' + outputs[0].name);
      } else if (outputs.length > 1) {
        CV.setStatus(statusEl, 'info', 'Packaging ' + outputs.length + ' files into a zip…');
        var zip = await AudioSaw.zipBlobs(outputs);
        CV.downloadBlob(zip, 'audiosaw-converted.zip');
        renderResult(outputs);
        CV.setStatus(statusEl, 'success', 'Done — ' + outputs.length + ' files zipped' + (failures.length ? ' (' + failures.length + ' failed)' : ''));
      } else {
        CV.setStatus(statusEl, 'error', 'All conversions failed: ' + failures.map(function (x) { return x.name + ' (' + x.error + ')'; }).join('; '));
      }
      if (adPost && outputs.length) adPost.classList.add('visible');
    } catch (e) {
      CV.setStatus(statusEl, 'error', 'Conversion error: ' + (e.message || e));
    } finally {
      convertBtn.disabled = false;
      resetBtn.disabled = false;
      CV.setProgress(progressBar, 100);
    }
  });

  function renderResult(outputs) {
    resultList.innerHTML = '';
    outputs.forEach(function (o) {
      var row = document.createElement('div');
      row.className = 'file-item';
      var label = document.createElement('span');
      var name = document.createElement('span'); name.className = 'name'; name.textContent = o.name;
      var size = document.createElement('span'); size.className = 'size'; size.textContent = CV.fmtBytes(o.blob.size);
      label.appendChild(name); label.appendChild(size);
      row.appendChild(label);
      var btn = document.createElement('button');
      btn.className = 'btn btn-small';
      btn.textContent = 'download';
      btn.onclick = function () { CV.downloadBlob(o.blob, o.name); };
      row.appendChild(btn);
      resultList.appendChild(row);
    });
  }
})();
