/*
 * Page driver for /8d-audio.
 *
 * Thin, like fx-preset.js: the rendering lives in spatial-fx.js, and this only
 * reads the controls and hands the result to CV.shell.
 */
(function () {
  'use strict';

  if (!window.CV || !CV.shell || !window.ASSpatial || !window.AudioSaw) {
    console.error('[AudioSaw] eight-d-page.js loaded before its dependencies — ' +
      'check the <script> order on this page.');
    return;
  }

  function process(file, opts, onProgress) {
    onProgress(5, 'Decoding…');
    return AudioSaw.decodeToAudioBuffer(file).then(function (buf) {
      onProgress(30, 'Moving it around your head…');
      return ASSpatial.render8d(buf, opts);
    }).then(function (rendered) {
      onProgress(62, 'Encoding…');
      return CV.encodeBuffer(rendered, opts.fmt, opts.bitrate, function (pct) {
        onProgress(62 + pct * 0.38);
      });
    }).then(function (blob) {
      return {
        name: AudioSaw.rename(file.name, opts.fmt).replace(/\.([^.]+)$/, '-8d.$1'),
        blob: blob
      };
    });
  }

  CV.shell({
    accept: ['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.opus', '.aac', '.aiff'],
    zipName: 'audiosaw-8d.zip',
    failMessage: 'Could not process that file. ',
    readOpts: function () {
      return {
        period: parseFloat(CV.$('#period').value),
        depth: parseFloat(CV.$('#depth').value),
        room: parseFloat(CV.$('#room').value),
        fmt: CV.$('#outFmt').value,
        bitrate: parseInt(CV.$('#bitrate').value, 10) || 192
      };
    },
    process: process
  });
})();
