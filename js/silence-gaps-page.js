/*
 * Page driver for /auto-cut-silence. The DSP is in js/silence-gaps.js and is
 * checked by tools/check-silence.js.
 */
(function (global) {
  'use strict';
  var CV = global.CV;
  if (!CV) { console.error('silence-gaps-page: CV missing — /js includes must come first'); return; }

  var $ = CV.$;
  var report = $('#gapReport');
  function setRow(id, v) { var el = $(id); if (el) el.textContent = v; }
  function mmss(sec) {
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  }

  CV.shell({
    accept: ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus',
      '.aif', '.aiff', '.m4b', '.wma', '.mp4', '.mov', '.webm', '.mkv'],
    zipName: 'audiosaw-tightened.zip',

    readOpts: function () {
      return {
        marginDb: parseFloat($('#sensitivity').value),
        minSilence: parseFloat($('#minGap').value),
        keepSilence: parseFloat($('#keepGap').value),
        format: $('#outFormat').value,
        bitrate: $('#bitrate').value
      };
    },

    outName: function (name, opts) { return AudioSaw.rename(name, opts.format); },

    process: async function (file, opts, onProgress) {
      onProgress(5, 'Decoding…');
      var buffer = await AudioSaw.decodeToAudioBuffer(file, function (pct) {
        onProgress(Math.min(30, pct * 0.3), 'Decoding…');
      });

      var chans = CV.channelsOf(buffer);
      onProgress(40, 'Finding the pauses…');
      await new Promise(function (r) { setTimeout(r, 0); });

      var p = global.ASSilence.plan(chans, buffer.sampleRate, {
        marginDb: opts.marginDb,
        minSilence: opts.minSilence,
        keepSilence: opts.keepSilence,
        padding: 0.08
      });

      if (!p.keep.length) {
        throw new Error('No speech found above the noise floor. If the recording is very quiet, amplify it first.');
      }

      onProgress(65, 'Tightening…');
      await new Promise(function (r) { setTimeout(r, 0); });
      var out = global.ASSilence.render(chans, buffer.sampleRate, p, { crossfade: 0.008 });

      var beforeSec = buffer.length / buffer.sampleRate;
      var afterSec = out.channels[0].length / buffer.sampleRate;
      var saved = beforeSec - afterSec;

      setRow('#gapBefore', mmss(beforeSec));
      setRow('#gapAfter', mmss(afterSec));
      setRow('#gapSaved', mmss(Math.max(0, saved)) + '  (' + (beforeSec > 0 ? (saved / beforeSec * 100).toFixed(0) : '0') + '%)');
      setRow('#gapCuts', String(out.cuts));
      setRow('#gapFloor', p.floorDb === -Infinity ? '—' : p.floorDb.toFixed(1) + ' dBFS');
      setRow('#gapThreshold', p.thresholdDb.toFixed(1) + ' dBFS');
      var note = $('#gapNote');
      if (note) {
        if (out.cuts === 0) {
          note.textContent = 'No pause was long enough to cut. Either the recording is already tight, '
            + 'or the gaps are shorter than the minimum you set — try lowering it.';
        } else {
          note.textContent = 'Every remaining pause is ' + opts.keepSilence + ' s long. Speech was never cut '
            + 'closer than 80 ms, and each join has an 8 ms crossfade so there are no clicks.';
        }
        note.hidden = false;
      }
      if (report) report.hidden = false;

      onProgress(85, 'Encoding…');
      var outBuf = CV.bufferFrom(out.channels, buffer.sampleRate);
      return await CV.encodeBuffer(outBuf, opts.format, opts.bitrate, function (pct) {
        onProgress(85 + Math.max(0, Math.min(12, (pct - 55) * 0.3)), 'Encoding…');
      });
    },

    onFiles: function () { if (report) report.hidden = true; },
    onReset: function () { if (report) report.hidden = true; },
    doneMessage: function (outputs) { return 'Done — ' + outputs[0].name; },
    failMessage: 'Could not process that file. '
  });

  var fmtSel = $('#outFormat');
  var brWrap = $('#bitrateWrap');
  function sync() { if (brWrap) brWrap.style.display = fmtSel.value !== 'mp3' ? 'none' : ''; }
  if (fmtSel) { fmtSel.addEventListener('change', sync); sync(); }
})(window);
