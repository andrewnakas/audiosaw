/*
 * Three-band EQ with presets.
 *
 * Uses the browser's own BiquadFilterNodes inside an OfflineAudioContext rather
 * than hand-written filters: they are the same well-tested implementations the
 * Web Audio API uses for live playback, and rendering offline means the whole
 * file is processed as fast as the machine allows rather than in real time.
 *
 * Chain: lowshelf (bass) -> peaking (mids) -> highshelf (treble), then a
 * make-up gain. Shelves rather than peaks at the ends because that is what
 * "bass" and "treble" controls do on every piece of hardware anyone has used.
 */
(function () {
  'use strict';

  var PRESETS = {
    flat:        { bass: 0,  mid: 0,  treble: 0 },
    bass:        { bass: 7,  mid: -1, treble: 0 },
    bassheavy:   { bass: 11, mid: -2, treble: 1 },
    voice:       { bass: -4, mid: 4,  treble: 3 },
    podcast:     { bass: -6, mid: 3,  treble: 2 },
    warm:        { bass: 4,  mid: 0,  treble: -3 },
    bright:      { bass: -1, mid: 1,  treble: 5 },
    phone:       { bass: -10, mid: 6, treble: -8 }
  };

  function render(buffer, opts) {
    var Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    var off = new Ctx(buffer.numberOfChannels, buffer.length, buffer.sampleRate);

    var src = off.createBufferSource();
    src.buffer = buffer;

    var bass = off.createBiquadFilter();
    bass.type = 'lowshelf';
    bass.frequency.value = 200;
    bass.gain.value = opts.bass;

    var mid = off.createBiquadFilter();
    mid.type = 'peaking';
    mid.frequency.value = 1200;
    mid.Q.value = 0.9;
    mid.gain.value = opts.mid;

    var treble = off.createBiquadFilter();
    treble.type = 'highshelf';
    treble.frequency.value = 3500;
    treble.gain.value = opts.treble;

    var makeup = off.createGain();
    // Boosting bands raises the peak level, so pull back roughly in proportion
    // to the largest boost to avoid clipping on render.
    var maxBoost = Math.max(0, opts.bass, opts.mid, opts.treble);
    makeup.gain.value = Math.pow(10, -maxBoost * 0.6 / 20);

    src.connect(bass).connect(mid).connect(treble).connect(makeup).connect(off.destination);
    src.start(0);
    return off.startRendering();
  }

  function process(file, opts, onProgress) {
    onProgress(5, 'Decoding…');
    return AudioSaw.decodeToAudioBuffer(file).then(function (buf) {
      onProgress(35, 'Applying EQ…');
      return render(buf, opts);
    }).then(function (rendered) {
      var chans = CV.channelsOf(rendered);
      if (opts.normalise) CV.peakNormalise(chans, 0.97);
      onProgress(65, 'Encoding…');
      return CV.encodeBuffer(rendered, opts.fmt, opts.bitrate, function (pct) {
        onProgress(65 + pct * 0.35);
      });
    }).then(function (blob) {
      return {
        name: AudioSaw.rename(file.name, opts.fmt).replace(/\.([^.]+)$/, '-eq.$1'),
        blob: blob
      };
    });
  }

  CV.shell({
    accept: null,
    zipName: 'audiosaw-eq.zip',
    failMessage: 'Could not apply EQ. ',
    readOpts: function () {
      return {
        bass: parseFloat(CV.$('#bass').value) || 0,
        mid: parseFloat(CV.$('#mid').value) || 0,
        treble: parseFloat(CV.$('#treble').value) || 0,
        normalise: CV.$('#normalise').value === 'yes',
        fmt: (CV.$('#outFmt').value || 'mp3').toLowerCase(),
        bitrate: parseInt(CV.$('#bitrate').value, 10) || 192
      };
    },
    process: process
  });

  /* -------- presets drive the sliders, and moving a slider clears the preset */

  var presetSel = CV.$('#preset');
  var sliders = ['bass', 'mid', 'treble'];

  function showValues() {
    sliders.forEach(function (id) {
      var el = CV.$('#' + id);
      var out = CV.$('#' + id + 'Val');
      if (el && out) {
        var v = parseFloat(el.value);
        out.textContent = (v > 0 ? '+' : '') + v.toFixed(0) + ' dB';
      }
    });
  }

  if (presetSel) {
    presetSel.addEventListener('change', function () {
      var p = PRESETS[presetSel.value];
      if (!p) return;
      sliders.forEach(function (id) { CV.$('#' + id).value = p[id]; });
      showValues();
    });
  }
  sliders.forEach(function (id) {
    var el = CV.$('#' + id);
    if (el) {
      el.addEventListener('input', function () {
        if (presetSel) presetSel.value = 'custom';
        showValues();
      });
    }
  });
  showValues();
})();
