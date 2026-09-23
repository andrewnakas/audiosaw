/*
 * Page driver for /key-finder. The same shape as bpm-page.js: it produces an
 * answer, not a file, so it goes through CV.bindDropzone and CV.setStatus
 * for validation and announcements and never calls CV.downloadBlob.
 *
 * The runner-up is always shown. Key detection's usual miss is the relative
 * major or minor, which shares every note, and saying so beats a confident
 * single answer that is wrong a known share of the time.
 */
(function (global) {
  'use strict';
  var CV = global.CV;
  if (!CV) { console.error('key-page: CV missing — /js includes must come first'); return; }

  var $ = CV.$, K = global.ASKey;
  var dropzone = $('#dropzone'), fileInput = $('#fileInput'), fileList = $('#fileList');
  var controls = $('#controls'), goBtn = $('#convertBtn'), resetBtn = $('#resetBtn');
  var statusEl = $('#status'), progressWrap = $('#progressWrap'), progressBar = $('#progressBar');
  var result = $('#keyResult');

  var ACCEPT = ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus',
    '.aif', '.aiff', '.m4b', '.wma', '.mp4', '.mov', '.webm', '.mkv'];
  var MAJOR = [0, 2, 4, 5, 7, 9, 11], MINOR = [0, 2, 3, 5, 7, 8, 10];

  var file = null, last = null, shown = null;

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function scaleOf(key) {
    return (key.mode === 'major' ? MAJOR : MINOR).map(function (s) { return (key.pc + s) % 12; });
  }
  function noteName(pc, key) {
    // Flats in the flat keys (F, Bb, Eb, Ab, Db major and their relative
    // minors), sharps everywhere else.
    var major = key.mode === 'major' ? key.pc : (key.pc + 3) % 12;
    var flat = [5, 10, 3, 8, 1].indexOf(major) !== -1;
    return (flat ? ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] : ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'])[pc];
  }

  // The keys that mix cleanly with this one on the Camelot wheel: the same
  // number in the other mode, and one step either way in the same mode.
  function neighbours(key) {
    var code = K.camelot(key.pc, key.mode), n = parseInt(code, 10), l = code.slice(-1);
    var want = [n + (l === 'A' ? 'B' : 'A'), ((n + 10) % 12 + 1) + l, (n % 12 + 1) + l];
    var out = [];
    ['major', 'minor'].forEach(function (mode) {
      for (var pc = 0; pc < 12; pc++) {
        var c = K.camelot(pc, mode);
        if (want.indexOf(c) !== -1) out.push({ code: c, name: K.keyName(pc, mode), order: want.indexOf(c) });
      }
    });
    return out.sort(function (a, b) { return a.order - b.order; });
  }

  function drawChroma(key) {
    var chroma = last.chroma, max = Math.max.apply(null, chroma) || 1, inKey = scaleOf(key);
    // Start the row on the tonic, so the scale reads left to right.
    var html = '';
    for (var i = 0; i < 12; i++) {
      var pc = (key.pc + i) % 12, v = chroma[pc] / max, on = inKey.indexOf(pc) !== -1, name = noteName(pc, key);
      html += '<div class="chroma-col' + (on ? ' in-key' : '') + '" title="' + name + ': ' + Math.round(v * 100) + '% of the strongest note' + (on ? ', in the key' : ', not in the key') + '">' +
        '<div class="chroma-track"><div class="chroma-bar" style="height:' + Math.max(2, v * 100).toFixed(1) + '%"></div></div>' +
        '<span class="chroma-note">' + name + '</span></div>';
    }
    $('#keyChroma').innerHTML = html;
    $('#keyChroma').setAttribute('aria-label', 'How much of each note the recording contains, starting on ' + noteName(key.pc, key) + ': ' +
      Array.from({ length: 12 }, function (_, i) { var pc = (key.pc + i) % 12; return noteName(pc, key) + ' ' + Math.round(chroma[pc] / max * 100) + '%'; }).join(', '));
    $('#keyNotes').textContent = 'Notes of ' + key.name + ': ' + inKey.map(function (pc) { return noteName(pc, key); }).join(' ');
  }

  function show(key) {
    shown = key;
    var other = key.pc === last.pc && key.mode === last.mode ? last.runnerUp : last;
    $('#keyName').textContent = key.name;
    $('#keyCamelot').textContent = K.camelot(key.pc, key.mode);
    var conf = key === last || (key.pc === last.pc && key.mode === last.mode)
      ? { clear: 'A clear reading.', likely: 'Likely, but check the alternative below by ear.', unsure: 'A close call — the alternative below is almost as likely.' }[last.confidence]
      : 'You picked the alternative reading.';
    var rel = other.pc === (key.mode === 'major' ? (key.pc + 9) % 12 : (key.pc + 3) % 12) && other.mode !== key.mode;
    $('#keyConfidence').textContent = conf + (rel ? ' The alternative is the relative ' + other.mode + ', which uses the same notes; it is the key the song leans on, not the notes, that separates them.' : '');
    var alt = $('#keyAlt');
    alt.textContent = other.name + ' (' + K.camelot(other.pc, other.mode) + ')';
    alt._key = other;
    drawChroma(key);
    $('#keyMix').innerHTML = neighbours(key).map(function (n) { return '<li><strong>' + n.code + '</strong> ' + esc(n.name) + '</li>'; }).join('');
    var slug = encodeURIComponent(K.keyName(key.pc, key.mode).replace(' ', '-'));
    $('#keyToPitch').href = '/pitch-shifter?key=' + slug;
    $('#keyToTune').href = '/autotune?key=' + slug;
    result.hidden = false;
  }

  $('#keyAlt').addEventListener('click', function () { if (this._key) show(this._key); });

  function reset() {
    file = null; last = null;
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
    goBtn.disabled = true; resetBtn.disabled = true;
    result.hidden = true;
    progressWrap.style.display = '';
    CV.setProgress(progressBar, 0);
    CV.setStatus(statusEl, 'info', 'Decoding…');
    try {
      var buffer = await AudioSaw.decodeToAudioBuffer(file, function (pct, msg) {
        CV.setProgress(progressBar, pct * 0.6);
        if (msg) CV.setStatus(statusEl, 'info', msg);
      });
      CV.setStatus(statusEl, 'info', 'Listening for the key…');
      CV.setProgress(progressBar, 65);
      await new Promise(function (r) { setTimeout(r, 30); });
      var chans = [];
      for (var c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
      var key = K.analyse(chans, buffer.sampleRate);
      CV.setProgress(progressBar, 85);
      await new Promise(function (r) { setTimeout(r, 0); });
      var tempo = global.ASBpm ? global.ASBpm.analyse(buffer) : null;
      if (!key) throw new Error('There is nothing tonal in it to read — silence, or noise.');
      last = key;
      show(key);
      // Within a few cents is standard pitch; the figure is not that precise.
      $('#keyTuning').textContent = Math.abs(key.tuningCents) <= 3 ? 'A = 440 Hz, standard'
        : (key.tuningCents > 0 ? '+' : '') + key.tuningCents + ' cents (A ≈ ' + (440 * Math.pow(2, key.tuningCents / 1200)).toFixed(1) + ' Hz)';
      $('#keyTempo').textContent = tempo && tempo.confidence >= 0.06 ? (Math.round(tempo.bpm * 10) / 10).toFixed(1) + ' BPM' : 'no steady beat';
      $('#keyLength').textContent = Math.floor(buffer.duration / 60) + ':' + ('0' + Math.round(buffer.duration % 60)).slice(-2) +
        (buffer.duration > 240 ? ' (the first 4 minutes were read)' : '');
      if (key.confidence === 'unsure') CV.setStatus(statusEl, 'warn', 'Found ' + key.name + ', but only just — ' + key.runnerUp.name + ' is nearly as likely. Listen to both.');
      else CV.setStatus(statusEl, 'success', 'Key: ' + key.name + ' (' + key.camelot + ')');
    } catch (e) {
      CV.setStatus(statusEl, 'error', 'Could not analyse that file. ' + (e.message || e));
    } finally {
      goBtn.disabled = !file;
      resetBtn.disabled = false;
      CV.setProgress(progressBar, 100);
    }
  });
})(window);
