/*
 * Page driver for /loudness-normalizer.
 *
 * Measures with js/loudness.js (ITU-R BS.1770-4, validated against ffmpeg's
 * ebur128 to within 0.05 LU) and applies the gain needed to hit a target.
 *
 * The gain is a single multiplication across the whole file — no compression,
 * no limiting, nothing that changes the balance between loud and quiet. That is
 * deliberate: loudness normalization and dynamics processing are different
 * jobs, and a tool that quietly does both makes a mix decision the user did not
 * ask for. If the target cannot be reached without breaching the true-peak
 * ceiling, the page says so rather than squashing the file to get there.
 */
(function (global) {
  'use strict';
  var CV = global.CV;
  if (!CV) { console.error('loudness-page: CV missing — /js includes must come first'); return; }

  var $ = CV.$;
  var report = $('#loudReport');

  function fmt(v, digits) {
    if (v === -Infinity || isNaN(v)) return '—';
    return (v >= 0 ? '+' : '') + v.toFixed(digits === undefined ? 1 : digits);
  }

  function setRow(id, text) { var el = $(id); if (el) el.textContent = text; }

  CV.shell({
    accept: ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus',
      '.aif', '.aiff', '.m4b', '.wma', '.mp4', '.mov', '.webm', '.mkv'],
    zipName: 'audiosaw-normalized.zip',
    multiple: true,

    readOpts: function () {
      var sel = $('#target');
      var custom = parseFloat($('#customTarget').value);
      var target = sel.value === 'custom'
        ? (isNaN(custom) ? -14 : custom)
        : parseFloat(sel.value);
      return {
        target: Math.max(-40, Math.min(0, target)),
        ceiling: parseFloat($('#ceiling').value),
        format: $('#outFormat').value,
        bitrate: $('#bitrate').value || 256
      };
    },

    outName: function (name, opts) {
      return AudioSaw.rename(name, opts.format);
    },

    process: async function (file, opts, onProgress) {
      onProgress(5, 'Decoding…');
      var buffer = await AudioSaw.decodeToAudioBuffer(file, function (pct) {
        onProgress(Math.min(25, pct * 0.25), 'Decoding…');
      });

      // The spec's filter coefficients are defined at 48 kHz, so measure there.
      // Resampling only affects the measurement copy; the gain is applied to
      // the original samples at their own rate.
      onProgress(30, 'Preparing for measurement…');
      var measureBuf = buffer.sampleRate === global.ASLoudness.SPEC_RATE
        ? buffer
        : await AudioSaw.resampleBuffer(buffer, global.ASLoudness.SPEC_RATE);

      var chans = [];
      for (var c = 0; c < measureBuf.numberOfChannels; c++) chans.push(measureBuf.getChannelData(c));

      onProgress(45, 'Measuring loudness…');
      await new Promise(function (r) { setTimeout(r, 0); });   // let the status paint
      var loud = global.ASLoudness.integratedLoudness(chans, measureBuf.sampleRate);

      // True peak is measured on the ORIGINAL buffer, not the 48 kHz copy.
      // Loudness has to be measured at 48 kHz because that is where the spec
      // defines its filters, but the peak ceiling is a promise about the file
      // we are about to write — and resampling moves inter-sample peaks. An
      // earlier version measured both on the resampled copy and overshot a
      // -1 dBTP ceiling by 0.2 dB, which ffmpeg caught on the output file.
      onProgress(70, 'Measuring true peak…');
      await new Promise(function (r) { setTimeout(r, 0); });
      var origChans = [];
      for (var oc = 0; oc < buffer.numberOfChannels; oc++) origChans.push(buffer.getChannelData(oc));
      var peakLin = global.ASLoudness.truePeak(origChans);
      var peakDb = global.ASLoudness.toDb(peakLin);

      if (loud.integrated === -Infinity) {
        throw new Error('That file is silent, or too short to measure — BS.1770 needs at least 400 ms of audio.');
      }

      // The gain we want, and the gain the ceiling will actually allow.
      var wanted = opts.target - loud.integrated;
      var allowed = opts.ceiling - peakDb;
      var applied = Math.min(wanted, allowed);
      var capped = applied < wanted - 0.05;

      onProgress(80, 'Applying gain…');
      var lin = Math.pow(10, applied / 20);
      var outChans = [];
      for (var ch = 0; ch < buffer.numberOfChannels; ch++) {
        var src = buffer.getChannelData(ch);
        var dst = new Float32Array(src.length);
        for (var i = 0; i < src.length; i++) dst[i] = src[i] * lin;
        outChans.push(dst);
      }
      var outBuf = CV.bufferFrom(outChans, buffer.sampleRate);

      // Report the actual outcome, not the intention.
      var achieved = loud.integrated + applied;
      setRow('#loudBefore', fmt(loud.integrated) + ' LUFS');
      setRow('#peakBefore', fmt(peakDb) + ' dBTP');
      setRow('#loudAfter', fmt(achieved) + ' LUFS');
      setRow('#peakAfter', fmt(peakDb + applied) + ' dBTP');
      setRow('#gainApplied', fmt(applied) + ' dB');
      var note = $('#loudNote');
      if (note) {
        if (capped) {
          note.textContent = 'Stopped ' + Math.abs(opts.target - achieved).toFixed(1)
            + ' LU short of the target: going louder would have pushed the true peak past '
            + opts.ceiling + ' dBTP. This file is already close to its ceiling, so the only way '
            + 'to get it louder is to reduce its dynamic range with a compressor first.';
          note.hidden = false;
        } else {
          note.textContent = 'Target reached with ' + Math.abs(opts.ceiling - (peakDb + applied)).toFixed(1)
            + ' dB of true-peak headroom to spare.';
          note.hidden = false;
        }
      }
      if (report) report.hidden = false;

      onProgress(88, 'Encoding…');
      var enc = function () {
        return CV.encodeBuffer(outBuf, opts.format, opts.bitrate, function (pct) {
          onProgress(88 + Math.max(0, Math.min(8, (pct - 55) * 0.2)), 'Encoding…');
        });
      };
      var blob = await enc();

      // A lossy encoder rebuilds the waveform, and its peaks can land higher
      // than the ones we measured: decode what was written, measure its true
      // peak, and if it passed the ceiling, turn down by the overshoot and
      // encode again. The ceiling is a promise about the file, not about the
      // samples before the encoder.
      var fmtTok = AudioSaw.resolveFormat(opts.format, opts.bitrate);
      if (!AudioSaw.isLossless(fmtTok)) {
        for (var attempt = 0; attempt < 3; attempt++) {
          onProgress(96, 'Checking the peak of the encoded file…');
          var dec = await AudioSaw.decodeToAudioBuffer(new File([blob], 'check.' + AudioSaw.extFor(fmtTok)));
          var dch = [];
          for (var dc = 0; dc < dec.numberOfChannels; dc++) dch.push(dec.getChannelData(dc));
          var encPeak = global.ASLoudness.toDb(global.ASLoudness.truePeak(dch));
          setRow('#peakAfter', fmt(encPeak) + ' dBTP');
          if (encPeak <= opts.ceiling + 0.02) break;
          var back = encPeak - opts.ceiling + 0.1;
          var g = Math.pow(10, -back / 20);
          outChans.forEach(function (d) { for (var k = 0; k < d.length; k++) d[k] *= g; });
          outBuf = CV.bufferFrom(outChans, buffer.sampleRate);
          applied -= back;
          setRow('#loudAfter', fmt(loud.integrated + applied) + ' LUFS');
          setRow('#gainApplied', fmt(applied) + ' dB');
          if (note) {
            note.textContent = 'The encoder raised the peak ' + (encPeak - (peakDb + applied + back)).toFixed(2) +
              ' dB, so the gain came down ' + back.toFixed(2) + ' dB to keep the encoded file under ' + opts.ceiling + ' dBTP.';
            note.hidden = false;
          }
          onProgress(88, 'Encoding again, ' + back.toFixed(2) + ' dB lower…');
          blob = await enc();
        }
      }
      return blob;
    },

    onFiles: function () { if (report) report.hidden = true; },
    onReset: function () { if (report) report.hidden = true; },

    doneMessage: function (outputs) {
      return 'Done — ' + outputs[0].name + '. Measured, gained and re-encoded locally.';
    },
    failMessage: 'Could not measure that file. '
  });

  // Show the custom target box only when it is relevant.
  var sel = $('#target');
  var customWrap = $('#customWrap');
  function syncCustom() { if (customWrap) customWrap.style.display = sel.value === 'custom' ? '' : 'none'; }
  if (sel) { sel.addEventListener('change', syncCustom); syncCustom(); }

  // MP3 bitrate is meaningless for a WAV export.
  var fmtSel = $('#outFormat');
  var brWrap = $('#bitrateWrap');
  function syncBitrate() { if (brWrap) brWrap.style.display = fmtSel.value !== 'mp3' ? 'none' : ''; }
  if (fmtSel) { fmtSel.addEventListener('change', syncBitrate); syncBitrate(); }
})(window);
