/*
 * /enhance-speech: one button for "make this recording sound better".
 *
 *   AI denoise (ASDenoise.ai, RNNoise; optional, on by default)
 *   -> ASEnhance.pre: 80 Hz high-pass, de-box and presence EQ, gentle compressor
 *   -> loudness measured on a 48 kHz copy (BS.1770 is defined there)
 *   -> ASEnhance.finish: gain to the target, true-peak limit at -1 dBTP
 *
 * The same length out as in, so a video comes back as a video (CV.shell's
 * video option) and a clip sent from the editor comes back aligned.
 */
(function () {
  'use strict';
  if (typeof CV === 'undefined' || typeof AudioSaw === 'undefined' || typeof ASEnhance === 'undefined' || typeof ASLoudness === 'undefined' || !CV.shell) {
    console.error('[enhance-speech] the /js/* includes must come before enhance-page.js');
    return;
  }
  var $ = CV.$;
  var report = $('#report');
  function row(id, text) { var el = $(id); if (el) el.textContent = text; }
  function fmt(v) { return (v > 0 ? '+' : '') + v.toFixed(1); }

  async function process(file, opts, onProgress) {
    onProgress(2, 'Decoding…');
    var buf = await AudioSaw.decodeToAudioBuffer(file);
    var sr = buf.sampleRate, chans;
    if (opts.ai && window.ASDenoise && window.ASDenoise.ai) {
      chans = await window.ASDenoise.ai(buf, 1, function (pct) { onProgress(5 + pct * 0.6, 'Removing background noise (AI)…'); });
    } else {
      chans = CV.channelsOf(buf).map(function (c) { return Float32Array.from(c); });
    }
    onProgress(68, 'EQ and compression…');
    await new Promise(function (r) { setTimeout(r, 0); });
    var p = ASEnhance.pre(chans, sr);
    onProgress(78, 'Measuring loudness…');
    var at48 = async function (chs) { return sr === 48000 ? chs : CV.channelsOf(await AudioSaw.resampleBuffer(AudioSaw.makeBuffer(chs, sr), 48000)); };
    var lufs = ASLoudness.integratedLoudness(await at48(p.channels), 48000).integrated;
    // The limiter shaves the peaks after the gain is set, which takes a
    // little loudness with it (measured 0.5 LU on a peaky take): measure the
    // limited result and correct once.
    var x, adj = 0, got = NaN;
    for (var pass = 0; pass < 2; pass++) {
      x = ASEnhance.finish(p.channels.map(function (c) { return c.slice(); }), sr, lufs - adj, { target: opts.target, ceiling: -1 });
      got = ASLoudness.integratedLoudness(await at48(x), 48000).integrated;
      if (!isFinite(got) || Math.abs(got - opts.target) < 0.15) break;
      adj += opts.target - got;
    }
    var out = CV.bufferFrom(x, sr);
    out.srcInfo = buf.srcInfo;
    if (report) {
      var inLufs = ASLoudness.integratedLoudness(sr === 48000 ? CV.channelsOf(buf) : CV.channelsOf(await AudioSaw.resampleBuffer(buf, 48000)), 48000).integrated;
      row('#rLoudIn', isFinite(inLufs) ? inLufs.toFixed(1) + ' LUFS' : '—');
      row('#rLoudOut', (isFinite(got) ? got.toFixed(1) : opts.target.toFixed(0)) + ' LUFS (target ' + opts.target.toFixed(0) + ')');
      row('#rComp', 'up to ' + p.compressionDb.toFixed(1) + ' dB on the loudest moments');
      row('#rPeak', ASLoudness.toDb(ASLoudness.truePeak(x)).toFixed(1) + ' dBTP');
      row('#rNoise', opts.ai ? 'AI noise removal on' : 'off');
      report.hidden = false;
    }
    onProgress(90, 'Encoding…');
    var blob = await CV.encodeBuffer(out, opts.fmt, opts.bitrate, function (pct) { onProgress(90 + pct * 0.1); });
    return { name: AudioSaw.rename(file.name, opts.fmt).replace(/\.([^.]+)$/, '-enhanced.$1'), blob: blob };
  }

  CV.shell({
    accept: null,
    video: true,   // the same length out as in: a video comes back as a video
    zipName: 'audiosaw-enhanced.zip',
    failMessage: 'Could not enhance that file. ',
    readOpts: function () {
      return {
        target: parseFloat($('#target').value) || -16,
        ai: !$('#aiNoise') || $('#aiNoise').checked,
        fmt: ($('#outFmt').value || 'mp3').toLowerCase(),
        bitrate: $('#bitrate').value
      };
    },
    onFiles: function () { if (report) report.hidden = true; },
    onReset: function () { if (report) report.hidden = true; },
    process: process
  });
  CV.remember($('#target'), 'as_enh_target');
})();
