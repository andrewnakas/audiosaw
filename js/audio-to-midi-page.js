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

  var file = null, buffer = null, bpm = 120, base = 'melody';

  /* ------------------------------------------------ piano roll and synth */

  // The transcription is shown for checking before it is written: the
  // download is the roll's notes, not the tracker's raw output.
  var roll = global.ASPianoRoll ? new global.ASPianoRoll($('#pianoRoll'), {
    onChange: function (notes) { $('#midiNotes').textContent = String(notes.length); },
    onKey: function (m, dur) { blip(m, dur || 0.25); }
  }) : null;
  var ctx = null, voices = [], raf = 0;
  function audio() {
    if (!ctx) { var C = global.AudioContext || global.webkitAudioContext; ctx = new C(); }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  // A plain triangle voice with a short attack and release: enough to hear
  // wrong notes, which is all it is for.
  function voice(c, m, when, dur, vel) {
    var o = c.createOscillator(), g = c.createGain();
    o.type = 'triangle';
    o.frequency.value = 440 * Math.pow(2, (m - 69) / 12);
    var peak = 0.25 * (vel || 96) / 127, end = when + Math.max(0.05, dur);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, when + 0.008);
    g.gain.setValueAtTime(peak, end - 0.03);
    g.gain.linearRampToValueAtTime(0, end);
    o.connect(g); g.connect(c.destination);
    o.start(when); o.stop(end + 0.02);
    voices.push(o);
  }
  function blip(m, dur) { var c = audio(); voice(c, m, c.currentTime + 0.01, Math.min(0.5, dur), 96); }
  function stopPlay() {
    voices.forEach(function (o) { try { o.stop(); } catch (e) {} });
    voices = [];
    cancelAnimationFrame(raf); raf = 0;
    if (roll) { roll.playhead = null; roll.draw(); }
    $('#rollPlay').textContent = 'Play notes';
    $('#rollBoth').textContent = 'Play with the recording';
  }
  function play(withOriginal) {
    if (voices.length) { stopPlay(); return; }
    var c = audio(), t0 = c.currentTime + 0.1, notes = roll.notes(), end = 0;
    notes.forEach(function (n) { voice(c, n.midi, t0 + n.start, n.duration, n.velocity); end = Math.max(end, n.start + n.duration); });
    if (withOriginal && buffer) {
      var src = c.createBufferSource(), g = c.createGain();
      src.buffer = buffer; g.gain.value = 0.6; src.connect(g); g.connect(c.destination);
      src.start(t0); voices.push(src); end = Math.max(end, buffer.duration);
    }
    (withOriginal ? $('#rollBoth') : $('#rollPlay')).textContent = 'Stop';
    (function tick() {
      var t = c.currentTime - t0;
      if (t > end + 0.2 || !voices.length) { stopPlay(); return; }
      roll.playhead = Math.max(0, t); roll.draw();
      raf = requestAnimationFrame(tick);
    })();
  }
  if (roll) {
    $('#rollPlay').addEventListener('click', function () { play(false); });
    $('#rollBoth').addEventListener('click', function () { play(true); });
    $('#rollQuant').addEventListener('click', function () { roll.quantize(); });
    $('#rollUndo').addEventListener('click', function () { roll.undo(); });
    $('#midiDownload').addEventListener('click', function () {
      var notes = roll.notes();
      if (!notes.length) { CV.setStatus(statusEl, 'warn', 'There are no notes left to write.'); return; }
      CV.downloadBlob(global.ASMidi.blob(notes, { bpm: bpm, trackName: base }), base + '.mid');
      CV.setStatus(statusEl, 'success', notes.length + ' notes written to ' + base + '.mid');
    });
  }

  function reset() {
    file = null; buffer = null;
    if (roll) stopPlay();
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
      buffer = await AudioSaw.decodeToAudioBuffer(file, function (pct) {
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
      bpm = parseFloat($('#bpm').value);
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
      base = file.name.replace(/\.[^.]+$/, '');

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

      if (roll) {
        // Check and fix the notes, then download from the button.
        roll.setBpm(bpm, division || 4);
        roll.setNotes(outNotes);
        CV.setStatus(statusEl, 'success', outNotes.length + ' notes found. Play them back, fix anything that is wrong, then download the .mid.');
      } else {
        CV.downloadBlob(global.ASMidi.blob(outNotes, { bpm: bpm, trackName: base }), base + '.mid');
        CV.setStatus(statusEl, 'success', 'Done — ' + outNotes.length + ' notes written to ' + base + '.mid');
      }
    } catch (e) {
      CV.setStatus(statusEl, 'error', 'Could not transcribe that file. ' + (e.message || e));
    } finally {
      goBtn.disabled = !file;
      resetBtn.disabled = false;
      CV.setProgress(progressBar, 100);
    }
  });
})(window);
