/*
 * Page driver for the two speed-and-reverb preset pages, /slowed-reverb and
 * /nightcore.
 *
 * The pages are the same machine with different dials, so they share this file
 * and differ only in a `window.AS_FX` config block and in their own copy. The
 * rendering itself lives in slowed-reverb.js (`ASReverb.render`), which is
 * where the audio decisions are documented.
 *
 * Config, set before this script loads:
 *
 *   window.AS_FX = {
 *     suffix: 'slowed',            // appended to the output filename
 *     zipName: 'audiosaw-slowed.zip',
 *     seconds: 2.6, damp: 3800,    // reverb character for this page
 *     decay: 2.2, preDelay: 0.03
 *   };
 *
 * Speed and wet level come from the page's own `#speed` and `#reverb` selects,
 * so each page can offer the range that makes sense for it: /nightcore has no
 * reason to offer 0.7× and /slowed-reverb has no reason to offer 1.3×.
 */
(function () {
  'use strict';

  // The includes must come before this file. Shipping that wrong leaves a page
  // that looks complete and does nothing, which is exactly the fault
  // tools/check-includes.js now exists to prevent — but a page can still be
  // served from a stale cache, so say so loudly in the console too.
  if (!window.CV || !CV.shell || !window.ASReverb || !window.AudioSaw) {
    console.error('[AudioSaw] fx-preset.js loaded before its dependencies — ' +
      'check the <script> order on this page.');
    return;
  }

  var cfg = window.AS_FX || {};

  function process(file, opts, onProgress) {
    onProgress(5, 'Decoding…');
    return AudioSaw.decodeToAudioBuffer(file).then(function (buf) {
      onProgress(30, opts.speed < 1 ? 'Slowing it down…' : 'Speeding it up…');
      return ASReverb.render(buf, opts);
    }).then(function (rendered) {
      onProgress(62, 'Encoding…');
      return CV.encodeBuffer(rendered, opts.fmt, opts.bitrate, function (pct) {
        onProgress(62 + pct * 0.38);
      });
    }).then(function (blob) {
      return {
        name: AudioSaw.rename(file.name, opts.fmt)
          .replace(/\.([^.]+)$/, '-' + (cfg.suffix || 'fx') + '.$1'),
        blob: blob
      };
    });
  }

  CV.shell({
    // An explicit list rather than null: flow.js reads it to decide whether to
    // offer a file carried in from another tool, and a null list means "offer
    // anything", including files this page cannot decode.
    accept: ['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.opus', '.aac', '.aiff'],
    zipName: cfg.zipName || 'audiosaw-fx.zip',
    failMessage: 'Could not process that file. ',
    readOpts: function () {
      var reverb = parseFloat((CV.$('#reverb') || {}).value);
      return {
        speed: parseFloat(CV.$('#speed').value),
        mix: isNaN(reverb) ? 0.35 : reverb,
        seconds: cfg.seconds == null ? 2.4 : cfg.seconds,
        damp: cfg.damp == null ? 4200 : cfg.damp,
        decay: cfg.decay,
        preDelay: cfg.preDelay,
        fmt: CV.$('#outFmt').value,
        bitrate: CV.$('#bitrate').value
      };
    },
    process: process
  });
})();
