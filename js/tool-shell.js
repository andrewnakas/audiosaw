/*
 * Shared driver for tools that do custom processing.
 *
 * tool-converter.js already plays this role for straight format conversions,
 * driven by a `window.AS_TOOL` config. This is the same idea for tools whose
 * work is a function rather than a target format: the page supplies a
 * `process` callback, and everything around it — dropzone binding, the file
 * list, showing and hiding controls, progress, statuses, batching, zipping and
 * the result rows — is handled here.
 *
 * Without this, each new tool repeats ~130 lines of identical plumbing, which
 * is how the older page scripts ended up duplicating helpers between them.
 *
 * Usage:
 *   CV.shell({
 *     accept: ['.mp3', '.wav'],
 *     zipName: 'audiosaw-eq.zip',
 *     readOpts: function () { return { gain: +document.getElementById('gain').value }; },
 *     process: async function (file, opts, onProgress) {
 *       // return a Blob, {name, blob}, or an array of {name, blob}
 *     }
 *   });
 */
(function (global) {
  'use strict';
  var CV = global.CV;
  if (!CV) return;

  // The action button kept its idle label through the whole run.
  function setBusy(btn, busy) {
    if (!btn) return;
    if (busy) {
      if (!btn.dataset.label) btn.dataset.label = btn.textContent;
      btn.textContent = 'Working…';
      btn.setAttribute('aria-busy', 'true');
      btn.disabled = true;
    } else {
      if (btn.dataset.label) btn.textContent = btn.dataset.label;
      btn.removeAttribute('aria-busy');
    }
  }

  function shell(cfg) {
    var $ = CV.$;
    var dropzone = $('#dropzone');
    var fileInput = $('#fileInput');
    var fileList = $('#fileList');
    var controls = $('#controls');
    var goBtn = $('#convertBtn');
    var resetBtn = $('#resetBtn');
    var statusEl = $('#status');
    var progressWrap = $('#progressWrap');
    var progressBar = $('#progressBar');
    var resultList = $('#resultList');

    if (!dropzone || !fileInput || !goBtn) return;

    var files = [];

    function renderList() {
      CV.renderFileList(fileList, files, function (idx) {
        files.splice(idx, 1);
        if (!files.length) reset();
        else renderList();
      });
    }

    function onFiles(picked) {
      if (!picked || !picked.length) return;
      files = cfg.multiple === false ? picked.slice(0, 1) : files.concat(picked);
      fileList.style.display = '';
      if (controls) controls.style.display = '';
      goBtn.disabled = false;
      renderList();
      if (cfg.onFiles) cfg.onFiles(files);
    }

    function reset() {
      files = [];
      fileList.innerHTML = '';
      if (controls) controls.style.display = 'none';
      goBtn.disabled = true;
      CV.clearStatus(statusEl);
      progressWrap.style.display = 'none';
      CV.setProgress(progressBar, 0);
      resultList.innerHTML = '';
      if (cfg.onReset) cfg.onReset();
    }

    CV.bindDropzone(dropzone, fileInput, onFiles, cfg.accept);
    if (resetBtn) resetBtn.addEventListener('click', reset);

    goBtn.addEventListener('click', async function () {
      if (!files.length) return;
      setBusy(goBtn, true);
      if (resetBtn) resetBtn.disabled = true;
      progressWrap.style.display = '';
      CV.setProgress(progressBar, 0);
      resultList.innerHTML = '';

      var opts = cfg.readOpts ? cfg.readOpts() : {};
      var outputs = [];
      var failures = [];

      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        var idx = i + 1;
        var prefix = files.length > 1 ? '[' + idx + '/' + files.length + '] ' : '';
        try {
          /* eslint-disable no-loop-func */
          var got = await cfg.process(f, opts, (function (i) {
            return function (pct, msg) {
              CV.setProgress(progressBar, ((i + (pct / 100)) / files.length) * 100);
              if (msg) CV.setStatus(statusEl, 'info', prefix + msg);
            };
          })(i));
          /* eslint-enable no-loop-func */
          (Array.isArray(got) ? got : [got]).forEach(function (o) {
            if (!o) return;
            outputs.push(o.blob ? o : { name: cfg.outName ? cfg.outName(f.name, opts) : f.name, blob: o });
          });
        } catch (e) {
          failures.push({ name: f.name, error: e.message || String(e) });
        }
      }

      try {
        if (outputs.length === 1 && !failures.length) {
          CV.downloadBlob(outputs[0].blob, outputs[0].name);
          CV.setStatus(statusEl, 'success', (cfg.doneMessage ? cfg.doneMessage(outputs, opts) : 'Done — ' + outputs[0].name));
        } else if (outputs.length > 1) {
          CV.setStatus(statusEl, 'info', 'Packaging ' + outputs.length + ' files…');
          var zip = await AudioSaw.zipBlobs(outputs);
          CV.downloadBlob(zip, cfg.zipName || 'audiosaw.zip');
          CV.setStatus(statusEl, 'success', 'Done — ' + outputs.length + ' files zipped' +
            (failures.length ? ' (' + failures.length + ' failed)' : ''));
        } else {
          CV.setStatus(statusEl, 'error', (cfg.failMessage || 'Could not process that file. ') +
            (failures[0] ? failures[0].error : ''));
        }

        outputs.forEach(function (o) {
          var row = document.createElement('div');
          row.className = 'file-item';
          var label = document.createElement('span');
          var name = document.createElement('span');
          name.className = 'name'; name.textContent = o.name;
          var size = document.createElement('span');
          size.className = 'size'; size.textContent = CV.fmtBytes(o.blob.size);
          label.appendChild(name); label.appendChild(size);
          row.appendChild(label);
          var btn = document.createElement('button');
          btn.className = 'btn btn-small'; btn.textContent = 'download';
          btn.onclick = function () { CV.downloadBlob(o.blob, o.name, { again: true }); };
          row.appendChild(btn);
          resultList.appendChild(row);
        });
      } finally {
        setBusy(goBtn, false);
        goBtn.disabled = files.length === 0;
        if (resetBtn) resetBtn.disabled = false;
        CV.setProgress(progressBar, 100);
      }
    });

    return { reset: reset, files: function () { return files; } };
  }

  CV.shell = shell;

  /* ------------------------------------------------------------ DSP helpers */

  // Encode an AudioBuffer to whatever the page asked for. Every processing tool
  // needs this ending, so keep it in one place.
  CV.encodeBuffer = function (buffer, fmt, bitrate, onProgress) {
    if (fmt === 'wav') return Promise.resolve(AudioSaw.audioBufferToWav(buffer));
    return AudioSaw.audioBufferToMp3(buffer, bitrate || 192, onProgress);
  };

  // Build an AudioBuffer from raw Float32 channel data.
  CV.bufferFrom = function (channels, sampleRate) {
    var Ctx = global.OfflineAudioContext || global.webkitOfflineAudioContext;
    var len = channels[0].length;
    var off = new Ctx(channels.length, len, sampleRate);
    var buf = off.createBuffer(channels.length, len, sampleRate);
    for (var c = 0; c < channels.length; c++) buf.copyToChannel(channels[c], c);
    return buf;
  };

  // Pull an AudioBuffer's channels out as plain arrays.
  CV.channelsOf = function (buffer) {
    var out = [];
    for (var c = 0; c < buffer.numberOfChannels; c++) out.push(buffer.getChannelData(c));
    return out;
  };

  // Second-order Butterworth sections (RBJ cookbook), cascaded for a steeper
  // slope. `passes` of 2 gives 24 dB/octave.
  //
  // A single-pole filter (6 dB/octave) is not steep enough for a crossover that
  // has to actually separate content: splitting at 200 Hz, a one-pole is still
  // only ~14 dB down at 1 kHz, which is enough to leak an audible amount of a
  // centred vocal back into a supposedly instrumental track. Measured, that was
  // the difference between the vocal sitting 9 dB below the backing and 30 dB
  // below it.
  function biquad(data, sampleRate, cutoffHz, passes, highpass) {
    var w0 = 2 * Math.PI * cutoffHz / sampleRate;
    var cos0 = Math.cos(w0);
    var alpha = Math.sin(w0) / (2 * Math.SQRT1_2);  // Q = 1/sqrt(2), Butterworth

    var b0, b1, b2;
    if (highpass) {
      b0 = (1 + cos0) / 2; b1 = -(1 + cos0); b2 = (1 + cos0) / 2;
    } else {
      b0 = (1 - cos0) / 2; b1 = 1 - cos0;    b2 = (1 - cos0) / 2;
    }
    var a0 = 1 + alpha, a1 = -2 * cos0, a2 = 1 - alpha;
    b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;

    var out = Float32Array.from(data);
    for (var p = 0; p < (passes || 1); p++) {
      var x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (var i = 0; i < out.length; i++) {
        var x0 = out[i];
        var y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x0; y2 = y1; y1 = y0;
        out[i] = y0;
      }
    }
    return out;
  }

  CV.lowpass = function (data, sampleRate, cutoffHz, passes) {
    return biquad(data, sampleRate, cutoffHz, passes || 2, false);
  };
  CV.highpass = function (data, sampleRate, cutoffHz, passes) {
    return biquad(data, sampleRate, cutoffHz, passes || 2, true);
  };

  // Peak-normalise in place to a target, guarding against silence.
  CV.peakNormalise = function (channels, targetPeak) {
    var peak = 0;
    for (var c = 0; c < channels.length; c++) {
      var d = channels[c];
      for (var i = 0; i < d.length; i++) {
        var v = d[i] < 0 ? -d[i] : d[i];
        if (v > peak) peak = v;
      }
    }
    if (peak < 1e-6) return;
    var g = (targetPeak || 0.98) / peak;
    for (var c2 = 0; c2 < channels.length; c2++) {
      var dd = channels[c2];
      for (var j = 0; j < dd.length; j++) dd[j] *= g;
    }
  };
})(window);
