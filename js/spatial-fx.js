/*
 * The rotating-image effect behind /8d-audio.
 *
 * A Web Audio node graph inside an OfflineAudioContext, the same shape
 * audio-eq.js uses, borrowing its room from ASReverb.
 *
 * "8D audio" is a StereoPannerNode driven by a slow oscillator, plus a little
 * reverb so the movement lands in a space instead of in your skull. There is
 * nothing eight-dimensional about it and the page says so.
 *
 * Two details decide whether it works:
 *
 *   A mono file has to be promoted to stereo first. Panning a mono source
 *   does move it, but with nothing in the other channel the effect is a
 *   volume wobble rather than a rotation.
 *
 *   The pan has to be driven by an audio-rate oscillator connected to the
 *   AudioParam, not by scheduled value ramps. Ramps between a handful of
 *   points produce audible stepping on a slow sweep, and an oscillator is
 *   both smoother and one line shorter.
 *
 */
(function (global) {
  'use strict';

  var Octx = global.OfflineAudioContext || global.webkitOfflineAudioContext;

  // Promote mono to dual-mono so a panner has something to move between.
  function toStereo(ctx, buffer) {
    if (buffer.numberOfChannels >= 2) return buffer;
    var out = ctx.createBuffer(2, buffer.length, buffer.sampleRate);
    var src = buffer.getChannelData(0);
    out.copyToChannel(src, 0);
    out.copyToChannel(src, 1);
    return out;
  }

  // Scale down only if the render would clip. Same policy as ASReverb, and the
  // same reason: normalising unconditionally drags quiet recordings up.
  function limitPeak(buffer, ceiling) {
    var peak = 0, c, i, d;
    for (c = 0; c < buffer.numberOfChannels; c++) {
      d = buffer.getChannelData(c);
      for (i = 0; i < d.length; i++) {
        var v = d[i] < 0 ? -d[i] : d[i];
        if (v > peak) peak = v;
      }
    }
    if (peak <= ceiling || peak < 1e-6) return peak;
    var g = ceiling / peak;
    for (c = 0; c < buffer.numberOfChannels; c++) {
      d = buffer.getChannelData(c);
      for (i = 0; i < d.length; i++) d[i] *= g;
    }
    return peak;
  }

  /*
   * 8D: rotate the image.
   *
   *   period  seconds for one full circuit. 8–12 is the usual range; below
   *           about 5 it stops reading as movement and starts reading as a
   *           tremolo.
   *   depth   0–1, how far toward each ear it travels. 1.0 is hard left to
   *           hard right, which is more than most tracks want.
   *   room    wet level of the reverb behind it.
   */
  function render8d(buffer, opts) {
    var sr = buffer.sampleRate;
    var period = opts.period == null ? 10 : opts.period;
    var depth = opts.depth == null ? 0.85 : opts.depth;
    var room = opts.room == null ? 0.22 : opts.room;
    var tail = room > 0 ? 1.6 : 0;
    var total = buffer.length + Math.ceil(tail * sr);

    var off = new Octx(2, total, sr);
    var src = off.createBufferSource();
    src.buffer = toStereo(off, buffer);

    var panner = off.createStereoPanner();
    // An oscillator wired into the AudioParam, rather than scheduled ramps.
    var lfo = off.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 1 / period;
    var lfoDepth = off.createGain();
    lfoDepth.gain.value = depth;
    lfo.connect(lfoDepth).connect(panner.pan);
    panner.pan.value = 0;

    var dry = off.createGain();
    dry.gain.value = 1;
    src.connect(panner).connect(dry).connect(off.destination);

    if (room > 0 && global.ASReverb) {
      var conv = off.createConvolver();
      conv.normalize = true;
      conv.buffer = global.ASReverb.impulse(off, 1.5, 2.4, 0.02);
      var tone = off.createBiquadFilter();
      tone.type = 'lowpass';
      tone.frequency.value = 5000;
      var wet = off.createGain();
      wet.gain.value = room;
      panner.connect(tone).connect(conv).connect(wet).connect(off.destination);
    }

    lfo.start(0);
    src.start(0);
    return off.startRendering().then(function (out) {
      limitPeak(out, opts.ceiling == null ? 0.99 : opts.ceiling);
      return out;
    });
  }

  global.ASSpatial = {
    render8d: render8d,
    toStereo: toStereo,
    limitPeak: limitPeak
  };
})(typeof self !== 'undefined' ? self : this);
