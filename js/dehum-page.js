/*
 * /hum-remover page controller: CV.shell around js/dehum.js.
 *
 * Each file is decoded at its own rate, the mains found (or the one chosen),
 * its fundamental tracked second by second, and one zero-phase notch per
 * harmonic run along that track. The length never changes, so a video comes
 * back as a video with the picture copied (CV.shell's video option), and a
 * clip sent from the editor goes back in place.
 */
(function () {
  'use strict';
  if (typeof CV === 'undefined' || typeof AudioSaw === 'undefined' || typeof ASDehum === 'undefined' || !CV.shell) {
    console.error('[hum-remover] the /js/* includes must come before dehum-page.js');
    return;
  }
  var $ = CV.$;
  var report = $('#report');
  function row(id, text) { var el = $(id); if (el) el.textContent = text; }
  function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }

  async function process(file, opts, onProgress) {
    onProgress(2, 'Decoding…');
    var buf = await AudioSaw.decodeToAudioBuffer(file);
    var sr = buf.sampleRate, chans = CV.channelsOf(buf);
    onProgress(10, 'Listening for the hum…');
    await tick();
    var d = ASDehum.detect(chans, sr, { mains: opts.mains === 'auto' ? null : +opts.mains });
    if (!d.found && opts.mains === 'auto') {
      throw new Error('No mains hum found in ' + file.name + ': nothing at 50 or 60 Hz and its harmonics stands out. If you can hear a hum, choose 50 or 60 Hz under Mains and it will be removed anyway. A hiss or a fan is not hum: the noise reduction tool takes those.');
    }
    onProgress(18, 'Following the mains frequency through the file…');
    await tick();
    var tr = ASDehum.track(chans, sr, d.f0);
    var hs = ASDehum.harmonicsFor(d.f0, sr, opts.strength);
    var out = await ASDehum.remove(chans, sr, {
      f0: d.f0, track: tr, strength: opts.strength,
      onProgress: function (p) { onProgress(20 + p * 68, 'Removing the hum: ' + hs.length + ' notches…'); }
    });
    var lo = Math.min.apply(null, tr.f), hi = Math.max.apply(null, tr.f);
    if (report) {
      row('#rFound', d.found
        ? d.mains + ' Hz mains, measured at ' + d.f0.toFixed(2) + ' Hz, ' + d.strong + ' of the first 8 harmonics standing out'
        : 'Nothing stood out; ' + d.mains + ' Hz removed as asked (' + d.f0.toFixed(2) + ' Hz)');
      row('#rDrift', (hi - lo) < 0.005 ? 'steady' : 'between ' + lo.toFixed(3) + ' and ' + hi.toFixed(3) + ' Hz, followed');
      row('#rNotches', hs.length + ' notches, ' + Math.round(d.f0) + ' Hz to ' + Math.round(hs[hs.length - 1] * d.f0).toLocaleString() + ' Hz, each under 2 Hz wide');
      report.hidden = false;
    }
    var o = CV.bufferFrom(out, sr);
    o.srcInfo = buf.srcInfo;
    onProgress(90, 'Encoding…');
    var blob = await CV.encodeBuffer(o, opts.fmt, opts.bitrate, function (pct) { onProgress(90 + pct * 0.1); });
    return { name: AudioSaw.rename(file.name, opts.fmt).replace(/\.([^.]+)$/, '-dehummed.$1'), blob: blob };
  }

  CV.shell({
    accept: null,
    video: true,
    zipName: 'audiosaw-dehummed.zip',
    failMessage: 'Could not remove the hum. ',
    readOpts: function () {
      return {
        mains: $('#mains').value,
        strength: $('#strength').value,
        fmt: ($('#outFmt').value || 'wav').toLowerCase(),
        bitrate: $('#bitrate').value
      };
    },
    onFiles: function () { if (report) report.hidden = true; },
    onReset: function () { if (report) report.hidden = true; },
    process: process
  });
  CV.remember($('#mains'), 'as_dehum_mains');
})();
