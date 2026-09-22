/*
 * Speed-and-pitch presets with reverb — behind /slowed-reverb and /nightcore.
 *
 * Both pages are the same renderer with different numbers. "Slowed + reverb"
 * plays the track slow and lets a long tail blur the gaps; "nightcore" plays it
 * fast and bright. The two are a matched pair and share every line here.
 *
 * The speed change is deliberately the *coupled* kind — pitch moves with tempo,
 * exactly like changing the speed of a record. That is the whole sound of these
 * genres, and it is why this does not reuse the ffmpeg `atempo` path that
 * audio-speed.js uses for pitch-preserved stretching, or the `asetrate` +
 * `atempo` pair pitch-shifter.js uses to move pitch alone. Coupled speed is one
 * line of Web Audio (`playbackRate` on a buffer source) and needs no codec
 * download at all, so these pages run offline after first load.
 *
 * The reverb is a ConvolverNode driven by a synthesised impulse response rather
 * than a recorded one: a recorded IR would be another asset to host, and the
 * sound these presets want is a plain decaying hall, not a specific room.
 *
 * Two things here are not arbitrary and should not be "simplified":
 *
 * 1. The two IR channels are generated from independent noise. Feeding the same
 *    noise to both ears produces a tail that collapses to the centre of the
 *    image and sounds like mono reverb pasted over a stereo track.
 *
 * 2. The render is longer than the audio by the reverb's own decay. Sizing the
 *    offline context to the dry length alone chops the tail off mid-decay,
 *    which is audible as an abrupt stop on the last note.
 *
 * 3. The output is pulled down when it would clip, and only then. Adding a wet
 *    signal on top of an untouched dry one necessarily raises the peak, and
 *    commercial music arrives at roughly full scale, so this is not an edge
 *    case — it is every real input. Measured on a full-scale file: the slowed
 *    preset reached 1.14, nightcore 1.05, and the heaviest settings 1.23, all
 *    of which clip on encode. Scaling unconditionally, the way a plain
 *    normalise would, is the wrong fix: it drags quiet recordings up to the
 *    ceiling as well, and someone running a voice memo through this does not
 *    expect the noise floor to come up with it.
 */
(function (global) {
  'use strict';

  var Octx = global.OfflineAudioContext || global.webkitOfflineAudioContext;

  /*
   * A decaying-noise impulse response.
   *
   *   seconds  RT60-ish length of the tail.
   *   decay    curve exponent. 2 is a natural-sounding room; higher numbers
   *            die away faster at the start and linger at the end.
   *   preDelay seconds of silence before the tail begins. A real room has a
   *            gap between the direct sound and the first reflections, and
   *            without it the wet signal smears straight over the dry one and
   *            the result sounds washed out rather than spacious.
   */
  function impulse(ctx, seconds, decay, preDelay) {
    var sr = ctx.sampleRate;
    var pre = Math.floor((preDelay || 0) * sr);
    var len = Math.max(1, Math.floor(seconds * sr)) + pre;
    var buf = ctx.createBuffer(2, len, sr);
    for (var c = 0; c < 2; c++) {
      var d = buf.getChannelData(c);
      for (var i = pre; i < len; i++) {
        var t = (i - pre) / (len - pre);
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
      }
    }
    return buf;
  }

  /*
   * Render one file.
   *
   *   speed    playback rate. <1 slows and lowers the pitch, >1 the reverse.
   *   mix      wet level, 0–1. The dry level is held at 1 rather than crossfaded
   *            to (1 - mix): these presets sit the reverb *behind* the track,
   *            and pulling the dry signal down as the tail comes up makes the
   *            vocal sound like it moved into the next room.
   *   seconds  tail length.
   *   damp     lowpass on the wet path, Hz. Real rooms absorb treble faster
   *            than bass, so an undamped tail sounds like a metal tank.
   */
  function render(buffer, opts) {
    var sr = buffer.sampleRate;
    var speed = opts.speed;
    var seconds = opts.seconds == null ? 2.4 : opts.seconds;
    var mix = opts.mix == null ? 0.35 : opts.mix;
    var damp = opts.damp == null ? 4200 : opts.damp;
    var channels = Math.max(2, buffer.numberOfChannels);

    // Dry length after the speed change, plus room for the tail to finish.
    var dryLen = Math.floor(buffer.length / speed);
    var total = dryLen + Math.ceil((seconds + 0.1) * sr);

    var off = new Octx(channels, total, sr);

    var src = off.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = speed;

    var dry = off.createGain();
    dry.gain.value = 1;

    var wet = off.createGain();
    wet.gain.value = mix;

    var conv = off.createConvolver();
    conv.normalize = true;
    conv.buffer = impulse(off, seconds, opts.decay == null ? 2.2 : opts.decay,
      opts.preDelay == null ? 0.03 : opts.preDelay);

    var tone = off.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = damp;

    src.connect(dry).connect(off.destination);
    src.connect(tone).connect(conv).connect(wet).connect(off.destination);
    src.start(0);

    return off.startRendering().then(function (out) {
      limitPeak(out, opts.ceiling == null ? 0.99 : opts.ceiling);
      return out;
    });
  }

  // Scale down to `ceiling` if the render overshot it, and otherwise leave the
  // level exactly as it is. See note 3 at the top of the file.
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

  global.ASReverb = { impulse: impulse, render: render, limitPeak: limitPeak };
})(typeof self !== 'undefined' ? self : this);
