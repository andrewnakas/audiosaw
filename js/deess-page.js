/*
 * /de-esser page controller: CV.shell around js/deess.js. The same length
 * comes back, so a video keeps its picture (CV.shell's video option) and an
 * editor clip goes back in place. "Only what is removed" writes the cut
 * itself, to hear exactly what the de-esser takes.
 */
(function () {
  'use strict';
  if (typeof CV === 'undefined' || typeof AudioSaw === 'undefined' || typeof ASDeess === 'undefined' || !CV.shell) {
    console.error('[de-esser] the /js/* includes must come before deess-page.js');
    return;
  }
  var $ = CV.$;
  var report = $('#report');
  function row(id, text) { var el = $(id); if (el) el.textContent = text; }

  async function process(file, opts, onProgress) {
    onProgress(2, 'Decoding…');
    var buf = await AudioSaw.decodeToAudioBuffer(file);
    var sr = buf.sampleRate;
    onProgress(30, 'Finding the esses…');
    await new Promise(function (r) { setTimeout(r, 0); });
    var r = ASDeess.process(CV.channelsOf(buf), sr, { amount: opts.amount, share: opts.share, listen: opts.listen });
    if (report) {
      row('#rCross', Math.round(r.crossover).toLocaleString() + ' Hz' + (r.peak ? ' (the sibilance peaks near ' + (r.peak / 1000).toFixed(1) + ' kHz)' : ''));
      row('#rTime', r.reduced.toFixed(1) + ' s of ' + buf.duration.toFixed(1) + ' s turned down, by up to ' + opts.amount + ' dB above ' + (r.crossover / 1000).toFixed(1) + ' kHz');
      report.hidden = false;
    }
    var o = CV.bufferFrom(r.channels, sr);
    o.srcInfo = buf.srcInfo;
    onProgress(80, 'Encoding…');
    var blob = await CV.encodeBuffer(o, opts.fmt, opts.bitrate, function (pct) { onProgress(80 + pct * 0.2); });
    return { name: AudioSaw.rename(file.name, opts.fmt).replace(/\.([^.]+)$/, (opts.listen ? '-esses-only' : '-deessed') + '.$1'), blob: blob };
  }

  CV.shell({
    accept: null,
    video: true,
    zipName: 'audiosaw-deessed.zip',
    failMessage: 'Could not de-ess that file. ',
    readOpts: function () {
      return {
        amount: +$('#amount').value,
        share: +$('#sens').value,
        listen: !!($('#listen') && $('#listen').checked),
        fmt: ($('#outFmt').value || 'wav').toLowerCase(),
        bitrate: $('#bitrate').value
      };
    },
    onFiles: function () { if (report) report.hidden = true; },
    onReset: function () { if (report) report.hidden = true; },
    process: process
  });
  CV.remember($('#amount'), 'as_deess_amount');
})();
