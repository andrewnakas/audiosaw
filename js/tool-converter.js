// Shared script used by every focused converter landing page (mp4-to-mp3, wav-to-mp3, etc.).
// The page tells us the target format via window.AS_TOOL = { target: 'mp3', accept: [...], inputExts: [...] }.
(function () {
  'use strict';
  var cfg = window.AS_TOOL || {};
  var defaultTarget = (cfg.target || 'mp3').toLowerCase();
  var accept = cfg.accept || null;
  var targetSelect = cfg.targetFromSelect ? document.getElementById(cfg.targetFromSelect) : null;
  function currentTarget() {
    return targetSelect ? (targetSelect.value || defaultTarget).toLowerCase() : defaultTarget;
  }

  var $ = CV.$;
  var dropzone = $('#dropzone');
  var fileInput = $('#fileInput');
  var fileList = $('#fileList');
  var controls = $('#controls');
  var convertBtn = $('#convertBtn');
  var resetBtn = $('#resetBtn');
  var bitrateSel = $('#bitrate');
  var statusEl = $('#status');
  var progressWrap = $('#progressWrap');
  var progressBar = $('#progressBar');
  var resultList = $('#resultList');

  var files = [];

  // The button stayed on its idle label for the whole conversion, so a slow
  // encode looked like a dead page.
  function setBusy(btn, busy) {
    if (!btn) return;
    if (busy) {
      if (!btn.dataset.label) btn.dataset.label = btn.textContent;
      btn.textContent = 'Converting…';
      btn.setAttribute('aria-busy', 'true');
      btn.disabled = true;
    } else {
      if (btn.dataset.label) btn.textContent = btn.dataset.label;
      btn.removeAttribute('aria-busy');
    }
  }

  // Named, not arguments.callee: this file is strict mode, where reading
  // .callee throws, so removing one file from a list of three or more used to
  // blow up after the splice and leave a stale list on screen.
  function renderList() {
    CV.renderFileList(fileList, files, function (idx) {
      files.splice(idx, 1);
      if (!files.length) reset();
      else renderList();
    });
  }

  function onFiles(picked) {
    if (!picked || !picked.length) return;
    files = files.concat(picked);
    fileList.style.display = '';
    if (controls) controls.style.display = '';
    convertBtn.disabled = false;
    renderList();
  }

  function reset() {
    files = [];
    fileList.innerHTML = '';
    if (controls) controls.style.display = 'none';
    convertBtn.disabled = true;
    CV.clearStatus(statusEl);
    progressWrap.style.display = 'none';
    CV.setProgress(progressBar, 0);
    resultList.innerHTML = '';
  }

  CV.bindDropzone(dropzone, fileInput, onFiles, accept);
  if (resetBtn) resetBtn.addEventListener('click', reset);
  if (bitrateSel && !cfg.lockedBitrate) CV.remember(bitrateSel);
  if (targetSelect) CV.remember(targetSelect);

  convertBtn.addEventListener('click', async function () {
    if (!files.length) return;
    setBusy(convertBtn, true);
    if (resetBtn) resetBtn.disabled = true;
    progressWrap.style.display = '';
    CV.setProgress(progressBar, 0);
    resultList.innerHTML = '';

    var options = {
      bitrate: cfg.lockedBitrate || (bitrateSel ? (parseInt(bitrateSel.value, 10) || 192) : 192)
    };
    if (cfg.lockedSampleRate) options.sampleRate = cfg.lockedSampleRate;
    if (cfg.lockedChannels) options.channels = cfg.lockedChannels;
    var target = currentTarget();

    var outputs = [];
    var failures = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var idx = i + 1;
      try {
        var blob = await AudioSaw.convert(f, target, options, function (pct, msg) {
          var overall = ((i + (pct / 100)) / files.length) * 100;
          CV.setProgress(progressBar, overall);
          if (msg) CV.setStatus(statusEl, 'info', '[' + idx + '/' + files.length + '] ' + msg);
        });
        outputs.push({ name: AudioSaw.rename(f.name, target), blob: blob });
      } catch (e) {
        failures.push({ name: f.name, error: e.message || String(e) });
      }
    }

    try {
      if (outputs.length === 1 && !failures.length) {
        CV.downloadBlob(outputs[0].blob, outputs[0].name);
        CV.setStatus(statusEl, 'success', 'Done — downloaded ' + outputs[0].name);
      } else if (outputs.length > 1) {
        CV.setStatus(statusEl, 'info', 'Packaging ' + outputs.length + ' files…');
        var zip = await AudioSaw.zipBlobs(outputs);
        CV.downloadBlob(zip, 'audiosaw-' + currentTarget() + '.zip');
        CV.setStatus(statusEl, 'success', 'Done — ' + outputs.length + ' files zipped' + (failures.length ? ' (' + failures.length + ' failed)' : ''));
      } else {
        CV.setStatus(statusEl, 'error', 'Could not convert. ' + (failures[0] ? failures[0].error : ''));
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
        btn.onclick = function () { CV.downloadBlob(o.blob, o.name, { again: true }); };
        row.appendChild(btn);
        resultList.appendChild(row);
      });
    } finally {
      setBusy(convertBtn, false);
      convertBtn.disabled = files.length === 0;
      if (resetBtn) resetBtn.disabled = false;
      CV.setProgress(progressBar, 100);
    }
  });
})();
