/*
 * Page driver for /audio-to-midi.
 *
 * Not built on CV.shell: the output is a .mid, not audio, so the shared
 * encoder path does not apply. It still routes through CV.bindDropzone and
 * CV.setStatus for validation and announcements, and through CV.downloadBlob so
 * the post-conversion panel and analytics behave like every other tool.
 */
(function (global) {
  'use strict';
  var CV = global.CV;
  if (!CV) { console.error('audio-to-midi: CV missing — /js includes must come first'); return; }

  var $ = CV.$;
  var dropzone = $('#dropzone'), fileInput = $('#fileInput'), fileList = $('#fileList');
  var controls = $('#controls'), goBtn = $('#convertBtn'), resetBtn = $('#resetBtn');
  var statusEl = $('#status'), progressWrap = $('#progressWrap'), progressBar = $('#progressBar');
  var report = $('#midiReport'), noteList = $('#noteList');

  var ACCEPT = ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus',
    '.aif', '.aiff', '.m4b', '.wma', '.mp4', '.mov', '.webm', '.mkv'];

  var file = null;

  function reset() {
    file = null;
    fileList.innerHTML = '';
    controls.style.display = 'none';
    goBtn.disabled = true;
    CV.clearStatus(statusEl);
    progressWrap.style.display = 'none';
    CV.setProgress(progressBar, 0);
    if (report) report.hidden = true;
  }

  CV.bindDropzone(dropzone, fileInput, function (picked) {
    if (!picked || !picked.length) return;
    file = picked[0];
    if (report) report.hidden = true;
    fileList.style.display = '';
    controls.style.display = '';
    goBtn.disabled = false;
    CV.renderFileList(fileList, [file], function () { reset(); });
  }, ACCEPT);

  resetBtn.addEventListener('click', reset);

  // Snap starts and lengths to a musical grid. Only worth doing when the tempo
  // is known, which is why it is off unless a BPM is detected or supplied.
  function quantize(notes, bpm, division) {
    if (!bpm || !division) return notes;
    var step = 60 / bpm / division;      // seconds per grid unit
    return notes.map(function (n) {
      var start = Math.round(n.start / step) * step;
      var dur = Math.max(step, Math.round(n.duration / step) * step);
      return { midi: n.midi, start: start, duration: dur, velocity: n.velocity, clarity: n.clarity };
    });
  }

  goBtn.addEventListener('click', async function () {
    if (!file) return;
    goBtn.disabled = true; resetBtn.disabled = true;
    if (report) report.hidden = true;
    progressWrap.style.display = '';
    CV.setProgress(progressBar, 0);
    try {
      CV.setStatus(statusEl, 'info', 'Decoding…');
      var buffer = await AudioSaw.decodeToAudioBuffer(file, function (pct) {
        CV.setProgress(progressBar, Math.min(20, pct * 0.2));
      });

      // Channels inline rather than via CV.channelsOf: that helper lives in
      // tool-shell.js, which this page has no other reason to load.
      var chans = [];
      for (var ci = 0; ci < buffer.numberOfChannels; ci++) chans.push(buffer.getChannelData(ci));
      var mono = chans.length === 1 ? chans[0] : global.ASSilence.toMono(chans);

      CV.setStatus(statusEl, 'info', 'Tracking pitch…');
      CV.setProgress(progressBar, 30);
      await new Promise(function (r) { setTimeout(r, 0); });

      var sens = $('#sensitivity').value;
      var frames = global.ASPitch.track(mono, buffer.sampleRate, {
        minHz: parseFloat($('#range').value.split('-')[0]),
        maxHz: parseFloat($('#range').value.split('-')[1])
      });

      CV.setProgress(progressBar, 65);
      CV.setStatus(statusEl, 'info', 'Finding notes…');
      await new Promise(function (r) { setTimeout(r, 0); });

      var notes = global.ASPitch.segment(frames, {
        minClarity: sens === 'strict' ? 0.7 : sens === 'loose' ? 0.4 : 0.55,
        minNoteSec: parseFloat($('#minNote').value)
      });

      if (!notes.length) {
        throw new Error('No clear pitch found. This works on one instrument or voice at a time — a full mix has no single fundamental to follow.');
      }

      // Tempo: detected, or whatever the user typed.
      var bpm = parseFloat($('#bpm').value);
      var detected = null;
      if (!bpm || bpm <= 0) {
        CV.setStatus(statusEl, 'info', 'Detecting tempo…');
        CV.setProgress(progressBar, 78);
        await new Promise(function (r) { setTimeout(r, 0); });
        try {
          var t = global.ASBpm.analyse(buffer);
          if (t && t.confidence >= 0.06) { detected = t.bpm; bpm = t.bpm; }
        } catch (e) { /* tempo is a nicety here */ }
        if (!bpm || bpm <= 0) bpm = 120;
      }

      var division = parseFloat($('#quantize').value);
      var outNotes = division ? quantize(notes, bpm, division) : notes;

      CV.setProgress(progressBar, 90);
      var base = file.name.replace(/\.[^.]+$/, '');
      var midi = global.ASMidi.blob(outNotes, { bpm: bpm, trackName: base });

      // Report before the download, so the numbers are on screen either way.
      $('#midiNotes').textContent = String(outNotes.length);
      $('#midiTempo').textContent = bpm.toFixed(1) + ' BPM' + (detected ? ' (detected)' : '');
      var lo = outNotes[0].midi, hi = outNotes[0].midi;
      outNotes.forEach(function (n) { if (n.midi < lo) lo = n.midi; if (n.midi > hi) hi = n.midi; });
      $('#midiRange').textContent = global.ASPitch.midiName(lo) + ' – ' + global.ASPitch.midiName(hi);
      var avgClar = notes.reduce(function (a, n) { return a + (n.clarity || 0); }, 0) / notes.length;
      $('#midiConfidence').textContent = avgClar >= 0.8 ? 'strong — a clean monophonic line'
        : avgClar >= 0.6 ? 'reasonable — check the low and high notes'
        : 'weak — this may not be a single instrument';
      if (noteList) {
        noteList.innerHTML = '';
        outNotes.slice(0, 40).forEach(function (n) {
          var li = document.createElement('span');
          li.className = 'note-chip';
          li.textContent = global.ASPitch.midiName(n.midi);
          noteList.appendChild(li);
        });
        if (outNotes.length > 40) {
          var more = document.createElement('span');
          more.className = 'note-chip note-chip-more';
          more.textContent = '+' + (outNotes.length - 40) + ' more';
          noteList.appendChild(more);
        }
      }
      if (report) report.hidden = false;

      CV.downloadBlob(midi, base + '.mid');
      CV.setStatus(statusEl, 'success', 'Done — ' + outNotes.length + ' notes written to ' + base + '.mid');
    } catch (e) {
      CV.setStatus(statusEl, 'error', 'Could not transcribe that file. ' + (e.message || e));
    } finally {
      goBtn.disabled = !file;
      resetBtn.disabled = false;
      CV.setProgress(progressBar, 100);
    }
  });
})(window);
