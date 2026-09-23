// Audio speed: change playback speed with or without pitch shift.
// Pitch-preserve uses ffmpeg's atempo filter. Pitch-shift uses OfflineAudioContext at a faked sample rate.
(function () {
  'use strict';
  var $ = CV.$;

  var dropzone = $('#dropzone');
  var fileInput = $('#fileInput');
  var fileList = $('#fileList');
  var controls = $('#controls');
  var convertBtn = $('#convertBtn');
  var resetBtn = $('#resetBtn');
  var speedSel = $('#speed');
  var modeSel = $('#mode');
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

  // Pitch + speed coupled: render at speed×sampleRate, then declare it as the original sample rate.
  // Result: same number of samples played as though sped up, with pitch shifted.
  function pitchShiftSpeed(audioBuffer, speed) {
    var sr = audioBuffer.sampleRate;
    var newLen = Math.floor(audioBuffer.length / speed);
    var channels = audioBuffer.numberOfChannels;
    var Octx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    var off = new Octx(channels, newLen, sr);
    var src = off.createBufferSource();
    src.buffer = audioBuffer;
    src.playbackRate.value = speed;
    src.connect(off.destination);
    src.start(0);
    return off.startRendering();
  }

  // Build ffmpeg -filter:a atempo=X (atempo only takes 0.5–2.0 per filter, chain for outside).
  function buildAtempoChain(speed) {
    if (speed >= 0.5 && speed <= 2.0) return 'atempo=' + speed;
    // Chain factors. E.g. 0.25 = 0.5,0.5
    var parts = [];
    var remaining = speed;
    while (remaining > 2.0) { parts.push('atempo=2.0'); remaining /= 2.0; }
    while (remaining < 0.5) { parts.push('atempo=0.5'); remaining /= 0.5; }
    parts.push('atempo=' + remaining.toFixed(4));
    return parts.join(',');
  }

  // Pitch-preserved time-stretch via ffmpeg.
  async function timeStretchFFmpeg(file, speed, outExt, bitrate, onProgress) {
    if (onProgress) onProgress(20, 'Loading codec…');
    var pack = await AudioSaw.ensureFFmpeg();
    var ffmpeg = pack.ffmpeg;
    var fetchFile = pack.util.fetchFile;
    var inName = 'in_' + Date.now() + '.' + (file.name.split('.').pop() || 'bin');
    var outName = 'out.' + outExt;
    await ffmpeg.writeFile(inName, await fetchFile(file));
    if (onProgress) onProgress(40, 'Time-stretching…');

    var args = ['-i', inName, '-filter:a', buildAtempoChain(speed)];
    if (outExt === 'mp3') args.push('-b:a', bitrate + 'k');
    if (outExt === 'm4a') { args.push('-c:a', 'aac'); args.push('-b:a', bitrate + 'k'); }
    args.push('-vn', outName);

    ffmpeg.on('progress', function (e) {
      if (onProgress && e && e.progress != null) {
        var pct = 40 + Math.min(55, Math.max(0, e.progress * 55));
        onProgress(pct, 'Time-stretching…');
      }
    });

    await ffmpeg.exec(args);
    var data = await ffmpeg.readFile(outName);
    try { await ffmpeg.deleteFile(inName); await ffmpeg.deleteFile(outName); } catch (e) {}
    var mime = outExt === 'mp3' ? 'audio/mpeg' : (outExt === 'wav' ? 'audio/wav' : 'audio/mp4');
    return new Blob([data.buffer], { type: mime });
  }

  CV.bindDropzone(dropzone, fileInput, onFiles);
  resetBtn.addEventListener('click', reset);

  convertBtn.addEventListener('click', async function () {
    if (!files.length) return;
    convertBtn.disabled = true; resetBtn.disabled = true;
    progressWrap.style.display = '';
    CV.setProgress(progressBar, 0);
    resultList.innerHTML = '';

    var speed = parseFloat(speedSel.value) || 1;
    var mode = modeSel.value;
    var fmt = (outFmt.value || 'mp3').toLowerCase();
    var bitrate = parseInt(bitrateSel.value, 10) || 192;

    var outputs = [];
    var failures = [];

    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var idx = i + 1;
      try {
        var blob;
        if (mode === 'pitch-preserve') {
          CV.setStatus(statusEl, 'info', '[' + idx + '/' + files.length + '] Time-stretching at ' + speed + '×…');
          blob = await timeStretchFFmpeg(f, speed, fmt, bitrate, function (pct, msg) {
            CV.setProgress(progressBar, ((i + (pct / 100)) / files.length) * 100);
            if (msg) CV.setStatus(statusEl, 'info', '[' + idx + '/' + files.length + '] ' + msg);
          });
        } else {
          CV.setStatus(statusEl, 'info', '[' + idx + '/' + files.length + '] Decoding…');
          CV.setProgress(progressBar, ((i + 0.1) / files.length) * 100);
          var ab = await AudioSaw.decodeToAudioBuffer(f);
          CV.setStatus(statusEl, 'info', '[' + idx + '/' + files.length + '] Pitching at ' + speed + '×…');
          var shifted = await pitchShiftSpeed(ab, speed);
          CV.setProgress(progressBar, ((i + 0.5) / files.length) * 100);
          if (fmt === 'wav') {
            blob = AudioSaw.audioBufferToWav(shifted);
          } else {
            blob = await AudioSaw.audioBufferToMp3(shifted, bitrate, function (pct) {
              CV.setProgress(progressBar, ((i + 0.5 + (pct / 100) * 0.5) / files.length) * 100);
            });
          }
        }
        outputs.push({ name: AudioSaw.rename(f.name, fmt).replace(/\.([^.]+)$/, '-' + speed + 'x.$1'), blob: blob });
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
        CV.downloadBlob(zip, 'audiosaw-speed.zip');
        CV.setStatus(statusEl, 'success', 'Done — ' + outputs.length + ' files zipped' + (failures.length ? ' (' + failures.length + ' failed)' : ''));
      } else {
        CV.setStatus(statusEl, 'error', 'Could not change speed. ' + (failures[0] ? failures[0].error : ''));
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
      convertBtn.disabled = files.length === 0;
      resetBtn.disabled = false;
      CV.setProgress(progressBar, 100);
    }
  });
})();
