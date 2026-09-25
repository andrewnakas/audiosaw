// Audio cutter: decode to AudioBuffer, draw waveform, drag handles, slice, encode.
(function () {
  'use strict';

  // Without an accept list any file reached the decoder and surfaced a raw
  // exception instead of "wrong file type".
  var CUT_ACCEPT = ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus',
    '.aif', '.aiff', '.m4b', '.wma', '.mp4', '.mov', '.webm', '.mkv'];
  var $ = CV.$;

  var dropzone = $('#dropzone');
  var fileInput = $('#fileInput');
  var editor = $('#editor');
  var canvas = $('#waveform');
  var rangeOverlay = $('#rangeOverlay');
  var handleStart = $('#handleStart');
  var handleEnd = $('#handleEnd');
  var startTime = $('#startTime');
  var endTime = $('#endTime');
  var rangeLen = $('#rangeLen');
  var playBtn = $('#playBtn');
  var cutBtn = $('#cutBtn');
  var resetBtn = $('#resetBtn');
  var outFmt = $('#outFmt');
  var bitrate = $('#bitrate');
  var statusEl = $('#status');
  var progressWrap = $('#progressWrap');
  var progressBar = $('#progressBar');

  var sourceFile = null;
  var audioBuffer = null;
  var startPct = 0, endPct = 100;
  var playCtx = null, playSrc = null;
  var fileBaseName = 'clip';

  function fmtTime(sec) {
    var m = Math.floor(sec / 60);
    var s = sec - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2);
  }

  function drawWaveform(buffer) {
    var dpr = window.devicePixelRatio || 1;
    var w = canvas.clientWidth;
    var h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    var data = buffer.getChannelData(0);
    var step = Math.ceil(data.length / w);
    var amp = h / 2;

    ctx.fillStyle = '#7a705f';
    for (var i = 0; i < w; i++) {
      var min = 1.0, max = -1.0;
      for (var j = 0; j < step; j++) {
        var v = data[i * step + j];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      ctx.fillRect(i, (1 + min) * amp, 1, Math.max(1, (max - min) * amp));
    }
  }

  function refreshRange() {
    var s = Math.min(startPct, endPct);
    var e = Math.max(startPct, endPct);
    rangeOverlay.style.left = s + '%';
    rangeOverlay.style.right = (100 - e) + '%';
    handleStart.style.left = s + '%';
    handleEnd.style.left = e + '%';
    if (audioBuffer) {
      var dur = audioBuffer.duration;
      var st = dur * s / 100;
      var en = dur * e / 100;
      startTime.textContent = fmtTime(st);
      endTime.textContent = fmtTime(en);
      rangeLen.textContent = fmtTime(en - st);
    }
  }

  function bindHandle(handle, setter) {
    function down(e) {
      e.preventDefault();
      var rect = canvas.getBoundingClientRect();
      function move(ev) {
        if (ev.touches && ev.cancelable) ev.preventDefault();
        var x = (ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left;
        var pct = Math.max(0, Math.min(100, (x / rect.width) * 100));
        setter(pct);
        refreshRange();
      }
      function up() {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        window.removeEventListener('touchmove', move);
        window.removeEventListener('touchend', up);
      }
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      // passive:false or the browser ignores preventDefault and the page
      // scrolls under the finger instead of the handle moving. Without this the
      // whole waveform tool was desktop-only.
      window.addEventListener('touchmove', move, { passive: false });
      window.addEventListener('touchend', up);
    }
    handle.addEventListener('mousedown', down);
    handle.addEventListener('touchstart', down, { passive: false });
  }

  bindHandle(handleStart, function (p) { startPct = p; });
  bindHandle(handleEnd, function (p) { endPct = p; });

  function sliceBuffer(buffer, startSec, endSec) {
    var sr = buffer.sampleRate;
    var channels = buffer.numberOfChannels;
    var startSample = Math.max(0, Math.floor(startSec * sr));
    var endSample = Math.min(buffer.length, Math.ceil(endSec * sr));
    var length = endSample - startSample;
    var Ctor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    var off = new Ctor(channels, length, sr);
    var src = off.createBufferSource();
    var sliced = off.createBuffer(channels, length, sr);
    for (var c = 0; c < channels; c++) {
      sliced.getChannelData(c).set(buffer.getChannelData(c).subarray(startSample, endSample));
    }
    src.buffer = sliced;
    src.connect(off.destination);
    src.start(0);
    return off.startRendering();
  }

  function onFile(f) {
    sourceFile = f;
    fileBaseName = (f.name.replace(/\.[^.]+$/, '') || 'clip');
    CV.setStatus(statusEl, 'info', 'Decoding ' + f.name + '…');
    progressWrap.style.display = '';
    CV.setProgress(progressBar, 10);
    AudioSaw.decodeToAudioBuffer(f, function (pct) { CV.setProgress(progressBar, pct); })
      .then(function (ab) {
        audioBuffer = ab;
        editor.style.display = '';
        drawWaveform(ab);
        startPct = 0; endPct = 100;
        refreshRange();
        CV.setStatus(statusEl, 'success', 'Loaded ' + f.name + ' — ' + fmtTime(ab.duration) + ', ' + ab.sampleRate + ' Hz, ' + ab.numberOfChannels + 'ch');
        CV.setProgress(progressBar, 100);
        setTimeout(function () { progressWrap.style.display = 'none'; }, 600);
      })
      .catch(function (e) {
        CV.setStatus(statusEl, 'error', 'Could not decode: ' + (e.message || e));
        progressWrap.style.display = 'none';
      });
  }

  CV.bindDropzone(dropzone, fileInput, function (files) { if (files[0]) onFile(files[0]); }, CUT_ACCEPT);

  resetBtn.addEventListener('click', function () {
    sourceFile = null; audioBuffer = null;
    editor.style.display = 'none';
    CV.clearStatus(statusEl);
    progressWrap.style.display = 'none';
    CV.setProgress(progressBar, 0);
    stopPlayback();
  });

  function stopPlayback() {
    if (playSrc) { try { playSrc.stop(); } catch (e) {} playSrc = null; }
    if (playCtx) { try { playCtx.close(); } catch (e) {} playCtx = null; }
    playBtn.textContent = '▶ play selection';
  }

  playBtn.addEventListener('click', function () {
    if (playSrc) { stopPlayback(); return; }
    if (!audioBuffer) return;
    var s = Math.min(startPct, endPct), e = Math.max(startPct, endPct);
    var dur = audioBuffer.duration;
    var startSec = dur * s / 100;
    var endSec = dur * e / 100;
    var Ctor = window.AudioContext || window.webkitAudioContext;
    playCtx = new Ctor();
    playSrc = playCtx.createBufferSource();
    playSrc.buffer = audioBuffer;
    playSrc.connect(playCtx.destination);
    playSrc.onended = function () { playBtn.textContent = '▶ play selection'; playSrc = null; };
    playSrc.start(0, startSec, endSec - startSec);
    playBtn.textContent = '⏹ stop';
  });

  cutBtn.addEventListener('click', async function () {
    if (!audioBuffer) return;
    cutBtn.disabled = true;
    progressWrap.style.display = '';
    CV.setProgress(progressBar, 5);

    var s = Math.min(startPct, endPct), e = Math.max(startPct, endPct);
    var dur = audioBuffer.duration;
    var startSec = dur * s / 100;
    var endSec = dur * e / 100;
    if (endSec - startSec < 0.05) {
      CV.setStatus(statusEl, 'error', 'Selection too short.');
      cutBtn.disabled = false; return;
    }

    try {
      CV.setStatus(statusEl, 'info', 'Cutting…');
      var sliced = await sliceBuffer(audioBuffer, startSec, endSec);
      CV.setProgress(progressBar, 50);

      var fmt = outFmt.value;
      var blob;
      blob = await AudioSaw.encode(sliced, AudioSaw.resolveFormat(fmt, bitrate.value), {
        bitrate: AudioSaw.bitrateOf(bitrate.value),
        onProgress: function (pct) {
          CV.setProgress(progressBar, 50 + (pct - 55) * 0.9);
        }
      });
      CV.setProgress(progressBar, 100);
      var outName = fileBaseName + '-clip.' + AudioSaw.extFor(fmt);
      CV.downloadBlob(blob, outName);
      CV.setStatus(statusEl, 'success', 'Done — downloaded ' + outName);
    } catch (err) {
      CV.setStatus(statusEl, 'error', 'Cut failed: ' + (err.message || err));
    } finally {
      cutBtn.disabled = false;
    }
  });

  window.addEventListener('resize', function () { if (audioBuffer) drawWaveform(audioBuffer); });
})();
