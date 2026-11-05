/*
 * /click-remover page controller: CV.shell around js/declick.js.
 *
 * A record side is long, so each channel is worked through in 20 s pieces
 * with 0.5 s of overlap either side (the detector and the repair look about
 * 45 ms around a click; the overlap keeps a click on a seam whole), yielding
 * to the page between pieces. Only the middle of each piece is kept.
 * The length never changes and nothing outside a repaired click is touched,
 * so a video comes back as a video and an editor clip goes back in place.
 */
(function () {
  'use strict';
  if (typeof CV === 'undefined' || typeof AudioSaw === 'undefined' || typeof ASDeclick === 'undefined' || !CV.shell) {
    console.error('[click-remover] the /js/* includes must come before declick-page.js');
    return;
  }
  var $ = CV.$;
  var report = $('#report');
  function row(id, text) { var el = $(id); if (el) el.textContent = text; }
  function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }

  async function declick(chans, sr, sensitivity, onProgress) {
    var PIECE = 20 * sr, OVER = Math.round(0.5 * sr), n = chans[0].length;
    var pieces = Math.max(1, Math.ceil(n / PIECE)), total = pieces * chans.length, done = 0, count = 0, samples = 0;
    var out = chans.map(function (c) { return Float32Array.from(c); });
    for (var c = 0; c < chans.length; c++) {
      for (var p = 0; p < pieces; p++) {
        var a = p * PIECE, b = Math.min(n, a + PIECE), f = Math.max(0, a - OVER), t = Math.min(n, b + OVER);
        var res = ASDeclick.process([chans[c].subarray(f, t)], sr, { sensitivity: sensitivity });
        out[c].set(res.channels[0].subarray(a - f, b - f), a);
        res.clicks[0].forEach(function (k) { if (k[0] + f >= a && k[0] + f < b) { count++; samples += k[1] - k[0]; } });
        done++;
        onProgress(done / total);
        await tick();
      }
    }
    return { channels: out, count: count, samples: samples };
  }

  async function process(file, opts, onProgress) {
    onProgress(2, 'Decoding…');
    var buf = await AudioSaw.decodeToAudioBuffer(file);
    var sr = buf.sampleRate, dur = buf.duration;
    var res = await declick(CV.channelsOf(buf), sr, opts.sensitivity, function (p) { onProgress(5 + p * 83, 'Finding and repairing clicks…'); });
    if (report) {
      var perMin = res.count / Math.max(1 / 60, dur / 60);
      row('#rCount', !res.count ? 'None found at this setting' + (opts.sensitivity !== 'strong' ? '; if you can still hear crackle, try "Strong"' : '') : res.count.toLocaleString() + ' click' + (res.count === 1 ? '' : 's') + ' repaired' + (buf.numberOfChannels > 1 ? ' across ' + buf.numberOfChannels + ' channels' : '') + ' (' + Math.round(perMin) + ' a minute)');
      row('#rTouched', (res.samples / sr * 1000).toFixed(1) + ' ms of ' + (dur >= 60 ? (dur / 60).toFixed(1) + ' minutes' : dur.toFixed(1) + ' s') + ' (' + (100 * res.samples / (sr * dur * buf.numberOfChannels)).toFixed(3) + '%); everything else is bit-identical');
      report.hidden = false;
    }
    var o = CV.bufferFrom(res.channels, sr);
    o.srcInfo = buf.srcInfo;
    onProgress(90, 'Encoding…');
    var blob = await CV.encodeBuffer(o, opts.fmt, opts.bitrate, function (pct) { onProgress(90 + pct * 0.1); });
    return { name: AudioSaw.rename(file.name, opts.fmt).replace(/\.([^.]+)$/, '-declicked.$1'), blob: blob };
  }

  CV.shell({
    accept: null,
    video: true,
    zipName: 'audiosaw-declicked.zip',
    failMessage: 'Could not remove the clicks. ',
    readOpts: function () {
      return {
        sensitivity: $('#sensitivity').value,
        fmt: ($('#outFmt').value || 'wav').toLowerCase(),
        bitrate: $('#bitrate').value
      };
    },
    onFiles: function () { if (report) report.hidden = true; },
    onReset: function () { if (report) report.hidden = true; },
    process: process
  });
  CV.remember($('#sensitivity'), 'as_declick_sens');
})();
