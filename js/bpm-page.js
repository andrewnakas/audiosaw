/*
 * Page driver for /bpm-finder.
 *
 * Not built on CV.shell: that driver exists for tools that produce a file, and
 * this one produces a number. It still goes through CV.bindDropzone and
 * CV.setStatus so the shared validation, the wrong-file-type message and the
 * status announcements all behave the same as everywhere else.
 */
(function (global) {
  'use strict';
  var CV = global.CV;
  if (!CV) { console.error('bpm-page: CV missing — /js includes must come first'); return; }

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
  var result = $('#bpmResult');

  var ACCEPT = ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus',
    '.aif', '.aiff', '.m4b', '.wma', '.mp4', '.mov', '.webm', '.mkv'];

  var file = null;
  var current = 0;

  function fmtTime(sec) {
    var m = Math.floor(sec / 60), s = Math.round(sec % 60);
    if (s === 60) { m += 1; s = 0; }
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function show(bpm, conf, duration) {
    current = bpm;
    var rounded = Math.round(bpm * 10) / 10;
    $('#bpmNumber').textContent = rounded.toFixed(1);

    // Thresholds are calibrated against measured values, not guessed. A bare
    // click track scores about 0.9; real drum patterns that the detector gets
    // exactly right score 0.20 to 0.35; a drone or pink noise scores under
    // 0.01. So the interesting boundary is far lower than it looks, and an
    // earlier draft that called anything under 0.3 "weak" was calling its own
    // correct answers unreliable.
    var label;
    if (conf >= 0.15) label = 'strong, steady pulse';
    else if (conf >= 0.06) label = 'clear enough — check the alternates below';
    else label = 'no clear pulse found, so treat this number as a guess';
    $('#bpmConfidence').textContent = 'Confidence: ' + label + '.'
      + (conf >= 0.06 && Math.abs(rounded - Math.round(rounded)) < 0.25
        ? ' Almost certainly ' + Math.round(rounded) + ' exactly.' : '');

    $('#bpmHalf').textContent = (bpm / 2).toFixed(1) + ' — half time';
    $('#bpmDouble').textContent = (bpm * 2).toFixed(1) + ' — double time';

    var beat = 60 / bpm;
    $('#bpmLength').textContent = fmtTime(duration);
    $('#bpmBars').textContent = (duration / (beat * 4)).toFixed(1) + ' bars';
    $('#bpmBeat').textContent = (beat * 1000).toFixed(1) + ' ms';
    $('#bpmBar').textContent = (beat * 4).toFixed(3) + ' s';
    result.hidden = false;
  }

  $('#bpmHalf').addEventListener('click', function () { show(current / 2, 1, lastDuration); });
  $('#bpmDouble').addEventListener('click', function () { show(current * 2, 1, lastDuration); });
  var lastDuration = 0;

  function reset() {
    file = null;
    fileList.innerHTML = '';
    controls.style.display = 'none';
    goBtn.disabled = true;
    CV.clearStatus(statusEl);
    progressWrap.style.display = 'none';
    CV.setProgress(progressBar, 0);
    result.hidden = true;
  }

  CV.bindDropzone(dropzone, fileInput, function (picked) {
    if (!picked || !picked.length) return;
    file = picked[0];
    result.hidden = true;
    fileList.style.display = '';
    controls.style.display = '';
    goBtn.disabled = false;
    CV.renderFileList(fileList, [file], function () { reset(); });
  }, ACCEPT);

  resetBtn.addEventListener('click', reset);

  goBtn.addEventListener('click', async function () {
    if (!file) return;
    goBtn.disabled = true;
    resetBtn.disabled = true;
    result.hidden = true;
    progressWrap.style.display = '';
    CV.setProgress(progressBar, 0);
    CV.setStatus(statusEl, 'info', 'Decoding…');
    try {
      var buffer = await AudioSaw.decodeToAudioBuffer(file, function (pct, msg) {
        CV.setProgress(progressBar, pct * 0.5);
        if (msg) CV.setStatus(statusEl, 'info', msg);
      });
      // Yield once so the status paints before the synchronous analysis.
      await new Promise(function (r) { setTimeout(r, 0); });
      var out = global.ASBpm.analyse(buffer, function (pct, msg) {
        CV.setProgress(progressBar, 50 + pct * 0.5);
        if (msg) CV.setStatus(statusEl, 'info', msg);
      });
      if (!out) throw new Error('Could not find a pulse in that file.');
      lastDuration = out.duration;
      show(out.bpm, out.confidence, out.duration);
      if (out.confidence < 0.06) {
        // Returning a number regardless would be the dishonest option: on a
        // drone or on noise the correlation still has a winner, and it means
        // nothing. Say so rather than dressing it up.
        CV.setStatus(statusEl, 'warn', 'No clear beat in that file — the number below is unreliable. '
          + 'Tempo detection needs percussive transients, so ambient, drones and solo voice do not work.');
      } else {
        CV.setStatus(statusEl, 'success', 'Detected ' + (Math.round(out.bpm * 10) / 10).toFixed(1) + ' BPM');
      }
    } catch (e) {
      CV.setStatus(statusEl, 'error', 'Could not analyse that file. ' + (e.message || e));
    } finally {
      goBtn.disabled = !file;
      resetBtn.disabled = false;
      CV.setProgress(progressBar, 100);
    }
  });
})(window);
