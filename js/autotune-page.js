/*
 * Page driver for /autotune. DSP in js/autotune.js, checked by
 * tools/check-autotune.js.
 */
(function (global) {
  'use strict';
  var CV = global.CV;
  if (!CV) { console.error('autotune-page: CV missing — /js includes must come first'); return; }
  var $ = CV.$;
  var report = $('#tuneReport');

  // The key and scale can come from three places: /key-finder (?key=A-minor),
  // the editor's project key when "Use project audio" is taken, or a read
  // of the file itself.
  var K = global.ASKey, shellApi = null;
  function setKey(key, from) {
    if (!key) return;
    $('#key').value = String(key.pc);
    $('#scale').value = key.mode === 'major' ? 'major' : 'minor';
    var hint = $('#keyFromFinder');
    if (hint) { hint.textContent = 'Set to ' + (key.name || K.keyName(key.pc, key.mode)) + ' ' + from + '.'; hint.hidden = false; }
  }
  (function () {
    var m = location.search.match(/[?&]key=([^&]+)/);
    if (K && m) setKey(K.parse(decodeURIComponent(m[1])), 'from the key finder');
  })();
  document.addEventListener('as:project-key', function (e) { if (K) setKey(e.detail.key, 'from the project'); });
  var detectBtn = $('#detectKey');
  if (detectBtn) detectBtn.addEventListener('click', async function () {
    var files = shellApi && shellApi.files();
    if (!K || !files || !files.length) return;
    detectBtn.disabled = true;
    var hint = $('#keyFromFinder');
    hint.hidden = false; hint.textContent = 'Listening for the key…';
    try {
      var buf = await AudioSaw.decodeToAudioBuffer(files[0]), ch = [];
      for (var c = 0; c < buf.numberOfChannels; c++) ch.push(buf.getChannelData(c));
      var res = K.analyse(ch, buf.sampleRate);
      if (!res) hint.textContent = 'No key to read in that file.';
      else setKey(res, 'from the file' + (res.confidence === 'clear' ? '' : ' (or possibly ' + res.runnerUp.name + ')'));
    } catch (err) { hint.textContent = 'Could not read that file.'; }
    detectBtn.disabled = false;
  });
  function setRow(id, v) { var el = $(id); if (el) el.textContent = v; }

  shellApi = CV.shell({
    accept: ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus',
      '.aif', '.aiff', '.m4b', '.wma', '.mp4', '.mov', '.webm', '.mkv'],
    zipName: 'audiosaw-tuned.zip',

    readOpts: function () {
      return {
        rootPc: parseInt($('#key').value, 10),
        scale: $('#scale').value,
        strength: parseFloat($('#strength').value),
        retuneSec: parseFloat($('#retune').value),
        format: $('#outFormat').value,
        bitrate: $('#bitrate').value || 256
      };
    },
    outName: function (name, opts) { return AudioSaw.rename(name, opts.format); },

    process: async function (file, opts, onProgress) {
      onProgress(5, 'Decoding…');
      var buffer = await AudioSaw.decodeToAudioBuffer(file, function (pct) {
        onProgress(Math.min(25, pct * 0.25), 'Decoding…');
      });

      var chans = [];
      for (var c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
      var mono = chans.length === 1 ? chans[0] : global.ASSilence.toMono(chans);

      onProgress(35, 'Tracking pitch…');
      await new Promise(function (r) { setTimeout(r, 0); });
      var frames = global.ASPitch.track(mono, buffer.sampleRate);

      var voiced = frames.filter(function (f) { return f.clarity >= 0.55 && f.hz > 0; });
      if (voiced.length < 5) {
        throw new Error('No steady pitch found. This corrects one voice or instrument at a time — a full mix has no single pitch to move.');
      }

      onProgress(55, 'Correcting…');
      await new Promise(function (r) { setTimeout(r, 0); });
      var res = global.ASAutotune.correct(chans, buffer.sampleRate, frames, opts);

      // How far out of tune was it to begin with? Useful, and honest about
      // whether the tool had anything to do.
      var errs = voiced.map(function (f) {
        var t = global.ASAutotune.snapMidi(f.midi, opts.rootPc,
          global.ASAutotune.SCALES[opts.scale] || global.ASAutotune.SCALES.chromatic);
        return Math.abs(t - f.midi) * 100;
      }).sort(function (a, b) { return a - b; });
      var medianErr = errs[Math.floor(errs.length / 2)] || 0;

      setRow('#tuneFrames', voiced.length + ' of ' + frames.length + ' frames had a clear pitch');
      setRow('#tuneOffset', medianErr.toFixed(0) + ' cents (median)');
      setRow('#tuneAmount', Math.round(opts.strength * 100) + '% toward the nearest note in the scale');
      var note = $('#tuneNote');
      if (note) {
        note.textContent = medianErr < 12
          ? 'This was already close to the scale — the median note was only ' + medianErr.toFixed(0)
            + ' cents out, so the correction is subtle by design.'
          : medianErr > 45
            ? 'The median note was ' + medianErr.toFixed(0) + ' cents out, which is a long way. '
              + 'Check the key and scale are right — correcting to the wrong scale sounds worse than not correcting.'
            : 'Typical singing error. Full strength with a slower retune usually sounds most natural here.';
        note.hidden = false;
      }
      if (report) report.hidden = false;

      onProgress(85, 'Encoding…');
      var outBuf = CV.bufferFrom(res.channels, buffer.sampleRate);
      return await CV.encodeBuffer(outBuf, opts.format, opts.bitrate, function (pct) {
        onProgress(85 + Math.max(0, Math.min(12, (pct - 55) * 0.3)), 'Encoding…');
      });
    },

    onFiles: function () { if (report) report.hidden = true; },
    onReset: function () { if (report) report.hidden = true; },
    doneMessage: function (outputs) { return 'Done — ' + outputs[0].name; },
    failMessage: 'Could not tune that file. '
  });

  var fmtSel = $('#outFormat'), brWrap = $('#bitrateWrap');
  function sync() { if (brWrap) brWrap.style.display = fmtSel.value !== 'mp3' ? 'none' : ''; }
  if (fmtSel) { fmtSel.addEventListener('change', sync); sync(); }

  // Scale choice is meaningless for chromatic; say so rather than leaving a
  // key selector that does nothing.
  var scaleSel = $('#scale'), keyWrap = $('#keyWrap');
  function syncKey() { if (keyWrap) keyWrap.style.opacity = scaleSel.value === 'chromatic' ? '0.45' : '1'; }
  if (scaleSel) { scaleSel.addEventListener('change', syncKey); syncKey(); }
})(window);
