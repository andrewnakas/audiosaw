// Ringtone maker: cutter with a 30s cap, fade in/out, iOS .m4r or Android .mp3 output.
(function () {
  'use strict';
  var $ = CV.$;
  var MAX_LEN = 30; // seconds (iOS limit)

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
  var capWarn = $('#capWarn');
  var playBtn = $('#playBtn');
  var cutBtn = $('#cutBtn');
  var resetBtn = $('#resetBtn');
  var phoneType = $('#phoneType');
  var fadeInSel = $('#fadeIn');
  var fadeOutSel = $('#fadeOut');
  var statusEl = $('#status');
  var progressWrap = $('#progressWrap');
  var progressBar = $('#progressBar');
  var adPost = $('#adSlotPost');

  var sourceFile = null;
  var audioBuffer = null;
  var startPct = 0, endPct = 100;
  var playCtx = null, playSrc = null;
  var fileBaseName = 'ringtone';

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

  function clampedSelection() {
    var s = Math.min(startPct, endPct), e = Math.max(startPct, endPct);
    var dur = audioBuffer ? audioBuffer.duration : 0;
    var startSec = dur * s / 100;
    var endSec = dur * e / 100;
    var capped = false;
    if (endSec - startSec > MAX_LEN) {
      endSec = startSec + MAX_LEN;
      capped = true;
    }
    return { startSec: startSec, endSec: endSec, capped: capped };
  }

  function refreshRange() {
    var s = Math.min(startPct, endPct);
    var e = Math.max(startPct, endPct);
    rangeOverlay.style.left = s + '%';
    rangeOverlay.style.right = (100 - e) + '%';
    handleStart.style.left = s + '%';
    handleEnd.style.left = e + '%';
    if (audioBuffer) {
      var sel = clampedSelection();
      startTime.textContent = fmtTime(sel.startSec);
      endTime.textContent = fmtTime(sel.endSec);
      rangeLen.textContent = fmtTime(sel.endSec - sel.startSec);
      capWarn.style.display = sel.capped ? '' : 'none';
    }
  }

  function bindHandle(handle, setter) {
    function down(e) {
      e.preventDefault();
      var rect = canvas.getBoundingClientRect();
      function move(ev) {
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
      window.addEventListener('touchmove', move);
      window.addEventListener('touchend', up);
    }
    handle.addEventListener('mousedown', down);
    handle.addEventListener('touchstart', down);
  }

  bindHandle(handleStart, function (p) { startPct = p; });
  bindHandle(handleEnd, function (p) { endPct = p; });

  function sliceAndFade(buffer, startSec, endSec, fadeInSec, fadeOutSec) {
    var sr = buffer.sampleRate;
    var channels = buffer.numberOfChannels;
    var startSample = Math.max(0, Math.floor(startSec * sr));
    var endSample = Math.min(buffer.length, Math.ceil(endSec * sr));
    var length = endSample - startSample;
    var Ctor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    var off = new Ctor(channels, length, sr);
    var sliced = off.createBuffer(channels, length, sr);
    for (var c = 0; c < channels; c++) {
      sliced.getChannelData(c).set(buffer.getChannelData(c).subarray(startSample, endSample));
    }
    var src = off.createBufferSource();
    src.buffer = sliced;
    var gain = off.createGain();
    src.connect(gain).connect(off.destination);
    var dur = length / sr;
    var fi = Math.min(fadeInSec, dur / 2);
    var fo = Math.min(fadeOutSec, dur / 2);
    gain.gain.setValueAtTime(fi > 0 ? 0.0001 : 1, 0);
    if (fi > 0) gain.gain.exponentialRampToValueAtTime(1, fi);
    if (fo > 0) {
      gain.gain.setValueAtTime(1, dur - fo);
      gain.gain.exponentialRampToValueAtTime(0.0001, dur);
    }
    src.start(0);
    return off.startRendering();
  }

  function onFile(f) {
    sourceFile = f;
    fileBaseName = (f.name.replace(/\.[^.]+$/, '') || 'ringtone');
    CV.setStatus(statusEl, 'info', 'Decoding ' + f.name + '…');
    progressWrap.style.display = '';
    CV.setProgress(progressBar, 10);
    AudioSaw.decodeToAudioBuffer(f, function (pct) { CV.setProgress(progressBar, pct); })
      .then(function (ab) {
        audioBuffer = ab;
        editor.style.display = '';
        drawWaveform(ab);
        startPct = 0;
        // Default end handle to ~30s window so the cap warning isn't on by default.
        endPct = Math.min(100, (MAX_LEN / ab.duration) * 100);
        refreshRange();
        CV.setStatus(statusEl, 'success', 'Loaded ' + f.name + ' — ' + fmtTime(ab.duration));
        CV.setProgress(progressBar, 100);
        setTimeout(function () { progressWrap.style.display = 'none'; }, 600);
      })
      .catch(function (e) {
        CV.setStatus(statusEl, 'error', 'Could not decode: ' + (e.message || e));
        progressWrap.style.display = 'none';
      });
  }

  CV.bindDropzone(dropzone, fileInput, function (files) { if (files[0]) onFile(files[0]); });

  resetBtn.addEventListener('click', function () {
    sourceFile = null; audioBuffer = null;
    editor.style.display = 'none';
    CV.clearStatus(statusEl);
    progressWrap.style.display = 'none';
    CV.setProgress(progressBar, 0);
    if (adPost) adPost.classList.remove('visible');
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
    var sel = clampedSelection();
    var Ctor = window.AudioContext || window.webkitAudioContext;
    playCtx = new Ctor();
    playSrc = playCtx.createBufferSource();
    playSrc.buffer = audioBuffer;
    playSrc.connect(playCtx.destination);
    playSrc.onended = function () { playBtn.textContent = '▶ play selection'; playSrc = null; };
    playSrc.start(0, sel.startSec, sel.endSec - sel.startSec);
    playBtn.textContent = '⏹ stop';
  });

  cutBtn.addEventListener('click', async function () {
    if (!audioBuffer) return;
    cutBtn.disabled = true;
    progressWrap.style.display = '';
    CV.setProgress(progressBar, 5);

    var sel = clampedSelection();
    if (sel.endSec - sel.startSec < 0.5) {
      CV.setStatus(statusEl, 'error', 'Selection too short — pick at least half a second.');
      cutBtn.disabled = false; return;
    }

    try {
      var fadeIn = parseFloat(fadeInSel.value) || 0;
      var fadeOut = parseFloat(fadeOutSel.value) || 0;
      CV.setStatus(statusEl, 'info', 'Trimming and fading…');
      var processed = await sliceAndFade(audioBuffer, sel.startSec, sel.endSec, fadeIn, fadeOut);
      CV.setProgress(progressBar, 40);

      var phone = phoneType.value;
      var blob, outName;
      if (phone === 'android') {
        CV.setStatus(statusEl, 'info', 'Encoding MP3…');
        blob = await AudioSaw.audioBufferToMp3(processed, 192, function (pct) {
          CV.setProgress(progressBar, 40 + (pct - 55) * 1.0);
        });
        outName = fileBaseName + '-ringtone.mp3';
      } else {
        // iOS: encode to AAC (.m4a) via ffmpeg, then rename to .m4r.
        var wav = AudioSaw.audioBufferToWav(processed);
        var wavFile = new File([wav], 'tmp.wav', { type: 'audio/wav' });
        CV.setStatus(statusEl, 'info', 'Encoding AAC for iPhone…');
        var m4a = await AudioSaw.convertViaFFmpeg(wavFile, 'm4a', { bitrate: 192 }, function (pct, msg) {
          CV.setProgress(progressBar, 40 + (pct - 55) * 1.0);
          if (msg) CV.setStatus(statusEl, 'info', msg);
        });
        blob = new Blob([await m4a.arrayBuffer()], { type: 'audio/mp4' });
        outName = fileBaseName + '-ringtone.m4r';
      }

      CV.setProgress(progressBar, 100);
      CV.downloadBlob(blob, outName);
      CV.setStatus(statusEl, 'success', 'Done — downloaded ' + outName);
      if (adPost) adPost.classList.add('visible');
    } catch (err) {
      CV.setStatus(statusEl, 'error', 'Ringtone failed: ' + (err.message || err));
    } finally {
      cutBtn.disabled = false;
    }
  });

  window.addEventListener('resize', function () { if (audioBuffer) drawWaveform(audioBuffer); });
})();
