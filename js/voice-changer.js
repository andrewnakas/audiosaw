/*
 * /voice-changer page: presets and two sliders (pitch, formant) over
 * ASVoice (voice-fx.js), driven by CV.shell for the dropzone, batch and
 * download. "Preview" runs the current setting on the first eight seconds
 * of the first file and plays it, so trying presets does not mean
 * downloading each one.
 */
(function () {
  'use strict';

  if (typeof CV === 'undefined' || typeof AudioSaw === 'undefined' || typeof ASVoice === 'undefined' || !CV.shell) {
    console.error('[voice-changer] the /js/* includes must come before voice-changer.js');
    return;
  }

  var $ = CV.$;
  var presetSel = $('#preset');
  var pitchEl = $('#pitch'), pitchOut = $('#pitchVal');
  var formantEl = $('#formant'), formantOut = $('#formantVal');
  var previewBtn = $('#previewBtn');
  var PREVIEW_S = 8;

  function settings() {
    var id = presetSel ? presetSel.value : 'custom';
    var p = Object.assign({}, ASVoice.PRESETS[id] || {});
    // The sliders always win for pitch and formant, so a preset can be
    // nudged ("Deeper, but a bit less") without becoming "custom".
    if (!p.monotone) {
      p.pitch = parseFloat(pitchEl.value) || 0;
      p.formant = Math.pow(2, (parseFloat(formantEl.value) || 0) / 12);
    }
    return p;
  }

  function show() {
    var st = parseFloat(pitchEl.value) || 0, fm = parseFloat(formantEl.value) || 0;
    pitchOut.textContent = (st > 0 ? '+' : '') + st + ' semitones';
    formantOut.textContent = fm === 0 ? 'unchanged' : (fm > 0 ? 'smaller head, +' : 'bigger head, ') + fm;
    var mono = presetSel && (ASVoice.PRESETS[presetSel.value] || {}).monotone;
    pitchEl.disabled = formantEl.disabled = !!mono;
  }

  if (presetSel) {
    presetSel.addEventListener('change', function () {
      var p = ASVoice.PRESETS[presetSel.value] || {};
      pitchEl.value = p.pitch || 0;
      formantEl.value = p.formant ? Math.round(12 * Math.log2(p.formant) * 2) / 2 : 0;
      show();
    });
    CV.remember(presetSel, 'as_vc_preset');
    presetSel.dispatchEvent(new Event('change'));
  }
  [pitchEl, formantEl].forEach(function (el) { el.addEventListener('input', show); });
  show();

  async function render(buf, s, onProgress) {
    var chans = CV.channelsOf(buf);
    if (onProgress) onProgress(30, 'Finding the pitch…');
    await new Promise(function (r) { setTimeout(r, 0); });
    var out = ASVoice.apply(chans, buf.sampleRate, s);
    // ASVoice brings the level back to the input's peak; this is the true-peak
    // guard every other tool uses, for the inter-sample overs a pitch shift
    // can create.
    if (window.ASLoudness && ASLoudness.truePeak(out) > 0.891) ASLoudness.limit(out, buf.sampleRate, Math.pow(10, -1 / 20));
    var res = AudioSaw.makeBuffer(out, buf.sampleRate);
    res.srcInfo = buf.srcInfo;
    return res;
  }

  function process(file, opts, onProgress) {
    onProgress(5, 'Decoding…');
    return AudioSaw.decodeToAudioBuffer(file).then(function (buf) {
      return render(buf, opts.fx, onProgress);
    }).then(function (rendered) {
      onProgress(70, 'Encoding…');
      return CV.encodeBuffer(rendered, opts.fmt, opts.bitrate, function (pct) { onProgress(70 + pct * 0.3); });
    }).then(function (blob) {
      return {
        name: AudioSaw.rename(file.name, opts.fmt).replace(/\.([^.]+)$/, '-' + (opts.presetId || 'voice') + '.$1'),
        blob: blob
      };
    });
  }

  var shell = CV.shell({
    accept: null,
    zipName: 'audiosaw-voice-changer.zip',
    failMessage: 'Could not change that voice. ',
    readOpts: function () {
      return {
        fx: settings(),
        presetId: presetSel ? presetSel.value : 'custom',
        fmt: ($('#outFmt').value || 'mp3').toLowerCase(),
        bitrate: $('#bitrate').value
      };
    },
    process: process
  });

  /* ------------------------------------------------------------- preview */

  var ctx = null, playing = null, cache = { file: null, buf: null };

  function stop() {
    if (playing) { try { playing.stop(); } catch (e) {} playing = null; }
    if (previewBtn) previewBtn.textContent = '▶ Preview 8 s';
  }

  if (previewBtn) previewBtn.addEventListener('click', async function () {
    if (playing) { stop(); return; }
    var files = shell && shell.files();
    if (!files || !files.length) return;
    var C = window.AudioContext || window.webkitAudioContext;
    ctx = ctx || new C();
    if (ctx.state === 'suspended') ctx.resume();
    previewBtn.disabled = true;
    previewBtn.textContent = 'Working…';
    try {
      if (cache.file !== files[0]) {
        cache.buf = await AudioSaw.decodeToAudioBuffer(files[0], null, { quiet: true });
        cache.file = files[0];
      }
      var b = cache.buf, n = Math.min(b.length, Math.round(PREVIEW_S * b.sampleRate));
      var cut = AudioSaw.makeBuffer(CV.channelsOf(b).map(function (c) { return c.slice(0, n); }), b.sampleRate);
      var out = await render(cut, settings());
      var src = ctx.createBufferSource();
      src.buffer = out;
      src.connect(ctx.destination);
      src.onended = function () { if (playing === src) stop(); };
      src.start();
      playing = src;
      previewBtn.textContent = '■ Stop preview';
    } catch (e) {
      previewBtn.textContent = '▶ Preview 8 s';
      CV.setStatus($('#status'), 'error', 'Preview failed. ' + (e.message || e));
    }
    previewBtn.disabled = false;
  });
})();
