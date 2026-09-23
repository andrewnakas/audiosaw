/*
 * Page driver for /chord-finder. Produces an answer, not a file, like
 * key-page.js and bpm-page.js: CV.bindDropzone and CV.setStatus for the
 * shared validation and announcements, no CV.downloadBlob.
 *
 * When the song has a steady beat, the chords are read beat by beat and set
 * out in bars like a lead sheet. The beat comes from ASBpm.analyse and the
 * first beat from ASBpm.phase, and bars are counted from the first beat,
 * which is a guess the page does not dress up. Without a steady beat, it
 * falls back to a timed list.
 *
 * The player highlights the chord under the playhead, which is how you
 * check a reading by ear, and clicking a chord jumps there.
 */
(function (global) {
  'use strict';
  var CV = global.CV;
  if (!CV) { console.error('chord-page: CV missing — /js includes must come first'); return; }

  var $ = CV.$, K = global.ASKey, B = global.ASBpm;
  var dropzone = $('#dropzone'), fileInput = $('#fileInput'), fileList = $('#fileList');
  var controls = $('#controls'), goBtn = $('#convertBtn'), resetBtn = $('#resetBtn');
  var statusEl = $('#status'), progressWrap = $('#progressWrap'), progressBar = $('#progressBar');
  var result = $('#chordResult'), sheet = $('#chordSheet'), player = $('#chordPlayer');

  var ACCEPT = ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus',
    '.aif', '.aiff', '.m4b', '.wma', '.mp4', '.mov', '.webm', '.mkv'];

  var file = null, url = null, cells = [], raf = 0;

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmt(t) { var m = Math.floor(t / 60), s = Math.floor(t % 60); return m + ':' + (s < 10 ? '0' : '') + s; }

  function reset() {
    file = null;
    fileList.innerHTML = '';
    controls.style.display = 'none';
    goBtn.disabled = true;
    CV.clearStatus(statusEl);
    progressWrap.style.display = 'none';
    result.hidden = true;
    if (url) { URL.revokeObjectURL(url); url = null; }
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

  // Chords per bar: each cell is one beat; a chord is written only where it
  // changes, the way a lead sheet repeats nothing.
  function renderBars(chords, beats, perBar) {
    var html = '', prev = null;
    cells = [];
    for (var i = 0; i + 1 < beats.length; i++) {
      var t = (beats[i] + beats[i + 1]) / 2;
      var ch = chords.filter(function (c) { return t >= c.t0 && t < c.t1; })[0];
      var name = ch ? ch.name : 'N';
      if (i % perBar === 0) html += (i ? '</div>' : '') + '<div class="cs-bar"><span class="cs-num">' + (i / perBar + 1) + '</span>';
      var show = name !== prev ? (name === 'N' ? '–' : name) : '';
      html += '<button type="button" class="cs-beat" data-t="' + beats[i].toFixed(3) + '">' + esc(show) + '</button>';
      cells.push({ t0: beats[i], t1: beats[i + 1] });
      prev = name;
    }
    sheet.className = 'chord-sheet cs-bars';
    sheet.innerHTML = html + '</div>';
  }

  function renderList(chords) {
    cells = [];
    sheet.className = 'chord-sheet cs-list';
    sheet.innerHTML = chords.filter(function (c) { return c.name !== 'N'; }).map(function (c) {
      cells.push({ t0: c.t0, t1: c.t1 });
      return '<button type="button" class="cs-beat" data-t="' + c.t0.toFixed(3) + '"><span class="cs-time">' + fmt(c.t0) + '</span> ' + esc(c.name) + '</button>';
    }).join('');
  }

  sheet.addEventListener('click', function (e) {
    var b = e.target.closest('[data-t]');
    if (!b) return;
    player.currentTime = Math.max(0, parseFloat(b.getAttribute('data-t')));
    player.play().catch(function () {});
  });

  function follow() {
    raf = 0;
    var t = player.currentTime, btns = sheet.querySelectorAll('.cs-beat');
    for (var i = 0; i < cells.length; i++) {
      var on = t >= cells[i].t0 && t < cells[i].t1;
      if (btns[i] && btns[i].classList.contains('on') !== on) {
        btns[i].classList.toggle('on', on);
        if (on && !player.paused) {
          var r = btns[i].getBoundingClientRect(), sr = sheet.getBoundingClientRect();
          if (r.top < sr.top || r.bottom > sr.bottom) btns[i].scrollIntoView({ block: 'nearest' });
        }
      }
    }
    if (!player.paused) raf = requestAnimationFrame(follow);
  }
  player.addEventListener('play', function () { if (!raf) raf = requestAnimationFrame(follow); });
  player.addEventListener('seeked', function () { if (!raf) raf = requestAnimationFrame(follow); });

  goBtn.addEventListener('click', async function () {
    if (!file) return;
    goBtn.disabled = true; resetBtn.disabled = true;
    result.hidden = true;
    progressWrap.style.display = '';
    CV.setProgress(progressBar, 0);
    CV.setStatus(statusEl, 'info', 'Decoding…');
    try {
      var buffer = await AudioSaw.decodeToAudioBuffer(file, function (pct, msg) {
        CV.setProgress(progressBar, pct * 0.5);
        if (msg) CV.setStatus(statusEl, 'info', msg);
      });
      CV.setStatus(statusEl, 'info', 'Finding the beat…');
      CV.setProgress(progressBar, 55);
      await new Promise(function (r) { setTimeout(r, 30); });
      var tempo = B.analyse(buffer), beats = null, perBar = 4, ph = null;
      if (tempo && tempo.confidence >= 0.06) {
        ph = B.phase(buffer, tempo.bpm, perBar);
        if (ph) {
          // Bars start on the guessed downbeat, counted back to at or before
          // 0:00, so bar 1 may begin with a beat or two of nothing (a pickup
          // shows as rests).
          var P = 60 / tempo.bpm, bar = P * perBar;
          var first = ph.downbeat - Math.floor(ph.downbeat / bar) * bar;
          // A pickup of more than half a beat gets its own (mostly empty)
          // bar; a shorter lead-in is just silence before bar 1.
          if (first > P / 2) first -= bar;
          beats = [];
          for (var t = first; t < buffer.duration + P; t += P) beats.push(t);
        }
      }
      CV.setStatus(statusEl, 'info', 'Listening for chords…');
      CV.setProgress(progressBar, 70);
      await new Promise(function (r) { setTimeout(r, 30); });
      var chans = [];
      for (var c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
      var chords = K.chords(chans, buffer.sampleRate, { beats: beats });
      var key = K.analyse(chans, buffer.sampleRate);
      CV.setProgress(progressBar, 95);
      if (!chords.length || chords.every(function (x) { return x.name === 'N'; })) throw new Error('No clear chords in it — is it drums, speech or a single voice?');

      if (beats) renderBars(chords, beats, perBar); else renderList(chords);
      var used = {};
      chords.forEach(function (x) { if (x.name !== 'N') used[x.name] = (used[x.name] || 0) + (x.t1 - x.t0); });
      var common = Object.keys(used).sort(function (a, b) { return used[b] - used[a]; });
      $('#chordKey').textContent = key ? key.name + ' (' + key.camelot + ')' + (key.confidence === 'clear' ? '' : ', or ' + key.runnerUp.name) : '—';
      $('#chordTempo').textContent = beats ? (Math.round(tempo.bpm * 10) / 10).toFixed(1) + ' BPM, first downbeat at ' + (ph.downbeat % (P * perBar)).toFixed(2) + ' s (which beat is one is a guess)' : 'no steady beat, so chords are listed by time';
      $('#chordUsed').textContent = common.slice(0, 8).join(', ') + (common.length > 8 ? ' and ' + (common.length - 8) + ' more' : '');
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(file);
      player.src = url;
      result.hidden = false;
      CV.setStatus(statusEl, 'success', common.length + ' chord' + (common.length === 1 ? '' : 's') + ' found. Press play to follow along.');
    } catch (e) {
      CV.setStatus(statusEl, 'error', 'Could not read chords from that file. ' + (e.message || e));
    } finally {
      goBtn.disabled = !file;
      resetBtn.disabled = false;
      CV.setProgress(progressBar, 100);
    }
  });
})(window);
