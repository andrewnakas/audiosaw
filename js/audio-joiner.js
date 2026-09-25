// Audio joiner: decode each clip, concatenate (optional crossfade), encode result.
(function () {
  'use strict';
  var $ = CV.$;

  var dropzone = $('#dropzone');
  var fileInput = $('#fileInput');
  var clipList = $('#clipList');
  var controls = $('#controls');
  var joinBtn = $('#joinBtn');
  var resetBtn = $('#resetBtn');
  var outFmt = $('#outFmt');
  var bitrate = $('#bitrate');
  var crossfadeSel = $('#crossfade');
  var statusEl = $('#status');
  var progressWrap = $('#progressWrap');
  var progressBar = $('#progressBar');

  var clips = []; // { file, buffer, name }

  function render() {
    clipList.innerHTML = '';
    clips.forEach(function (c, idx) {
      var li = document.createElement('li');
      li.className = 'joiner-item';
      li.draggable = true;
      li.dataset.idx = idx;
      var dur = c.buffer ? c.buffer.duration : 0;
      li.innerHTML = '<span class="grip">⋮⋮</span>' +
        '<span class="name">' + c.name + '</span>' +
        '<span class="meta">' + (dur ? dur.toFixed(2) + 's · ' + c.buffer.sampleRate + 'Hz' : 'decoding…') + '</span>';
      var rm = document.createElement('button');
      rm.className = 'remove'; rm.textContent = '×';
      rm.onclick = function () { clips.splice(idx, 1); render(); if (!clips.length) reset(); };
      li.appendChild(rm);

      li.addEventListener('dragstart', function (e) {
        e.dataTransfer.setData('text/plain', String(idx));
        li.classList.add('dragging');
      });
      li.addEventListener('dragend', function () { li.classList.remove('dragging'); });
      li.addEventListener('dragover', function (e) { e.preventDefault(); li.classList.add('drop-target'); });
      li.addEventListener('dragleave', function () { li.classList.remove('drop-target'); });
      li.addEventListener('drop', function (e) {
        e.preventDefault();
        li.classList.remove('drop-target');
        var from = parseInt(e.dataTransfer.getData('text/plain'), 10);
        var to = idx;
        if (from === to || isNaN(from)) return;
        var moved = clips.splice(from, 1)[0];
        clips.splice(to, 0, moved);
        render();
      });
      clipList.appendChild(li);
    });
    controls.style.display = clips.length ? '' : 'none';
  }

  function reset() {
    clips = []; render();
    CV.clearStatus(statusEl);
    progressWrap.style.display = 'none';
    CV.setProgress(progressBar, 0);
  }

  function addFiles(files) {
    files.forEach(function (f) {
      var entry = { file: f, buffer: null, name: f.name };
      clips.push(entry);
      AudioSaw.decodeToAudioBuffer(f).then(function (ab) {
        entry.buffer = ab; render();
      }).catch(function (e) {
        entry.name += ' (failed: ' + (e.message || e) + ')';
        render();
      });
    });
    render();
  }

  CV.bindDropzone(dropzone, fileInput, addFiles,
    ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus', '.aif', '.aiff', '.m4b', '.wma']);
  resetBtn.addEventListener('click', reset);

  function concatBuffers(buffers, crossfadeSec) {
    var sr = 0, channels = 1;
    buffers.forEach(function (b) {
      if (b.sampleRate > sr) sr = b.sampleRate;
      if (b.numberOfChannels > channels) channels = b.numberOfChannels;
    });

    // Resample any buffers that don't match sr, and upmix mono to match channel count.
    function unify(b) {
      if (b.sampleRate === sr && b.numberOfChannels === channels) return Promise.resolve(b);
      return AudioSaw.resampleBuffer(b, sr).then(function (rb) {
        if (rb.numberOfChannels === channels) return rb;
        var Octx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        var off = new Octx(channels, rb.length, sr);
        var unified = off.createBuffer(channels, rb.length, sr);
        for (var c = 0; c < channels; c++) {
          unified.getChannelData(c).set(rb.getChannelData(Math.min(c, rb.numberOfChannels - 1)));
        }
        return unified;
      });
    }

    return Promise.all(buffers.map(unify)).then(function (unified) {
      var xfSamples = Math.floor((crossfadeSec || 0) * sr);
      var totalLen = unified.reduce(function (a, b) { return a + b.length; }, 0) - xfSamples * (unified.length - 1);
      if (totalLen < 1) totalLen = 1;
      var Octx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      var off = new Octx(channels, totalLen, sr);
      var out = off.createBuffer(channels, totalLen, sr);

      var offset = 0;
      unified.forEach(function (b, i) {
        var len = b.length;
        for (var c = 0; c < channels; c++) {
          var dst = out.getChannelData(c);
          var src = b.getChannelData(c);
          for (var s = 0; s < len; s++) {
            var pos = offset + s;
            if (pos >= totalLen) break;
            if (i > 0 && s < xfSamples) {
              var gain = s / xfSamples;
              dst[pos] = dst[pos] * (1 - gain) + src[s] * gain;
            } else {
              dst[pos] = src[s];
            }
          }
        }
        offset += len - xfSamples;
        if (i === 0) offset += xfSamples; // first clip has no leading crossfade
      });
      return out;
    });
  }

  joinBtn.addEventListener('click', async function () {
    var ready = clips.filter(function (c) { return c.buffer; });
    if (ready.length < 2) {
      CV.setStatus(statusEl, 'error', 'Need at least 2 decoded clips.');
      return;
    }
    joinBtn.disabled = true; resetBtn.disabled = true;
    progressWrap.style.display = '';
    CV.setProgress(progressBar, 10);
    CV.setStatus(statusEl, 'info', 'Concatenating ' + ready.length + ' clips…');

    try {
      var xf = parseFloat(crossfadeSel.value) || 0;
      var merged = await concatBuffers(ready.map(function (c) { return c.buffer; }), xf);
      CV.setProgress(progressBar, 55);
      var fmt = outFmt.value;
      var blob;
      blob = await AudioSaw.encode(merged, AudioSaw.resolveFormat(fmt, bitrate.value), {
        bitrate: AudioSaw.bitrateOf(bitrate.value),
        onProgress: function (pct) {
          CV.setProgress(progressBar, 55 + (pct - 55) * 0.9);
        }
      });
      CV.setProgress(progressBar, 100);
      var name = 'audiosaw-joined.' + AudioSaw.extFor(fmt);
      CV.downloadBlob(blob, name);
      CV.setStatus(statusEl, 'success', 'Done — downloaded ' + name);
    } catch (e) {
      CV.setStatus(statusEl, 'error', 'Join failed: ' + (e.message || e));
    } finally {
      joinBtn.disabled = false; resetBtn.disabled = false;
    }
  });
})();
