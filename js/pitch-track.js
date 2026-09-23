/*
 * Monophonic pitch detection (YIN) and note segmentation.
 *
 * Shared foundation: audio-to-MIDI needs the note, key detection needs the
 * pitch class, and any correction tool needs to know what it is correcting.
 *
 * YIN rather than plain autocorrelation because autocorrelation's biggest peak
 * is routinely at twice the true period — the same octave trap the BPM detector
 * hits — and YIN's cumulative mean normalisation is specifically the fix for it.
 *
 * Monophonic only, and that is a hard limit rather than a rough edge: this
 * finds ONE fundamental. Given a chord it returns something confident and
 * wrong, which is why the page says so plainly.
 */
(function (global) {
  'use strict';

  var A4 = 440;

  function hzToMidi(hz) { return 69 + 12 * Math.log(hz / A4) / Math.LN2; }
  function midiToHz(m) { return A4 * Math.pow(2, (m - 69) / 12); }
  var NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  function midiName(m) {
    var r = Math.round(m);
    return NAMES[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1);
  }

  /*
   * One YIN estimate for a single window.
   * Returns { hz, clarity } — clarity is 1 - d'(tau), so 1 is a perfect
   * periodic match and 0 is noise.
   */
  function yin(buf, sampleRate, opts) {
    opts = opts || {};
    var minHz = opts.minHz || 65;      // ~C2
    var maxHz = opts.maxHz || 1600;    // ~G6
    var threshold = opts.threshold || 0.15;

    var tauMin = Math.max(2, Math.floor(sampleRate / maxHz));
    var tauMax = Math.min(Math.floor(buf.length / 2), Math.ceil(sampleRate / minHz));
    if (tauMax <= tauMin) return { hz: 0, clarity: 0 };

    // 1. Difference function.
    var diff = new Float32Array(tauMax + 1);
    for (var tau = tauMin; tau <= tauMax; tau++) {
      var sum = 0;
      var n = buf.length - tauMax;
      for (var i = 0; i < n; i++) {
        var delta = buf[i] - buf[i + tau];
        sum += delta * delta;
      }
      diff[tau] = sum;
    }

    // 2. Cumulative mean normalised difference. This is what stops the octave
    //    error: it divides by the running mean, so a lag of twice the period
    //    no longer looks as good as the period itself.
    var cmnd = new Float32Array(tauMax + 1);
    cmnd[tauMin] = 1;
    var running = 0;
    for (var t = tauMin; t <= tauMax; t++) {
      running += diff[t];
      cmnd[t] = running > 0 ? diff[t] * (t - tauMin + 1) / running : 1;
    }

    // 3. First minimum below the threshold, not the global minimum — taking the
    //    global one reintroduces the octave error this algorithm exists to fix.
    var best = -1;
    for (var k = tauMin + 1; k < tauMax; k++) {
      if (cmnd[k] < threshold) {
        while (k + 1 < tauMax && cmnd[k + 1] < cmnd[k]) k++;
        best = k;
        break;
      }
    }
    if (best === -1) {
      // Nothing convincing: fall back to the shallowest dip so callers can see
      // a low clarity rather than a hole.
      var lowest = tauMin, lowVal = cmnd[tauMin];
      for (var m = tauMin; m < tauMax; m++) if (cmnd[m] < lowVal) { lowVal = cmnd[m]; lowest = m; }
      best = lowest;
    }

    // 4. Parabolic interpolation around the dip for sub-sample precision. At
    //    440 Hz and 44.1 kHz one sample of period is already ~4 Hz, which is
    //    most of a semitone's worth of error at the top of the range.
    var x0 = best > tauMin ? best - 1 : best;
    var x2 = best + 1 < tauMax ? best + 1 : best;
    var refined = best;
    if (x0 !== best && x2 !== best) {
      // On the raw difference, not the normalised curve: the normalisation
      // tilts the dip, which read high notes up to 4.5 cents off (measured at
      // 1.3 kHz). On d(tau) the worst case is a fraction of a cent.
      var s0 = diff[x0], s1 = diff[best], s2 = diff[x2];
      var denom = 2 * (2 * s1 - s2 - s0);
      if (denom !== 0) refined = best + (s2 - s0) / denom;
    }

    return {
      hz: refined > 0 ? sampleRate / refined : 0,
      clarity: Math.max(0, Math.min(1, 1 - cmnd[best]))
    };
  }

  /*
   * Track pitch across a whole signal.
   * Returns frames of { time, hz, midi, clarity, rms }.
   */
  function track(mono, sampleRate, opts) {
    opts = opts || {};
    var hop = Math.round(sampleRate * (opts.hopSec || 0.010));
    var win = Math.round(sampleRate * (opts.winSec || 0.0464));   // ~2048 @ 44.1k
    var frames = [];
    for (var start = 0; start + win < mono.length; start += hop) {
      var slice = mono.subarray(start, start + win);
      var rms = 0;
      for (var i = 0; i < slice.length; i++) rms += slice[i] * slice[i];
      rms = Math.sqrt(rms / slice.length);
      var r = (rms > 1e-4) ? yin(slice, sampleRate, opts) : { hz: 0, clarity: 0 };
      frames.push({
        time: start / sampleRate,
        hz: r.hz,
        midi: r.hz > 0 ? hzToMidi(r.hz) : 0,
        clarity: r.clarity,
        rms: rms
      });
    }
    return frames;
  }

  /*
   * Turn pitch frames into notes.
   *
   * A note ends when the pitch moves by more than a semitone or so, when the
   * signal drops below the level floor, or when the detector loses confidence.
   * Short blips are dropped: they are almost always the detector wobbling on a
   * consonant or a note transition, not something a player intended.
   */
  function segment(frames, opts) {
    opts = opts || {};
    var minClarity = opts.minClarity === undefined ? 0.55 : opts.minClarity;
    var minNoteSec = opts.minNoteSec === undefined ? 0.06 : opts.minNoteSec;
    var maxJump = opts.maxJump === undefined ? 0.9 : opts.maxJump;   // semitones
    var floorRms = opts.floorRms === undefined ? 0.005 : opts.floorRms;

    var notes = [];
    var cur = null;
    var hop = frames.length > 1 ? frames[1].time - frames[0].time : 0.01;

    function close(endTime) {
      if (!cur) return;
      var dur = endTime - cur.start;
      if (dur >= minNoteSec && cur.pitches.length) {
        // Median is the right centre here: a couple of wild frames at the
        // attack should not move the note, and they move a mean a lot.
        var sorted = cur.pitches.slice().sort(function (a, b) { return a - b; });
        var mid = sorted[Math.floor(sorted.length / 2)];
        notes.push({
          midi: Math.round(mid),
          exactMidi: mid,
          start: cur.start,
          duration: dur,
          peakRms: cur.peakRms,
          velocity: 100,      // filled in below, once the loudest note is known
          clarity: cur.clarSum / cur.pitches.length
        });
      }
      cur = null;
    }

    for (var i = 0; i < frames.length; i++) {
      var f = frames[i];
      var voiced = f.clarity >= minClarity && f.rms >= floorRms && f.hz > 0;
      if (!voiced) { close(f.time); continue; }
      if (cur && Math.abs(f.midi - cur.pitches[cur.pitches.length - 1]) > maxJump) close(f.time);
      if (!cur) cur = { start: f.time, pitches: [], clarSum: 0, peakRms: 0 };
      cur.pitches.push(f.midi);
      cur.clarSum += f.clarity;
      if (f.rms > cur.peakRms) cur.peakRms = f.rms;
    }
    close(frames.length ? frames[frames.length - 1].time + hop : 0);

    // Velocity, scaled against the loudest note in this file rather than
    // against an absolute level. An absolute mapping saturates: a normalised
    // recording puts every note at 127 and the performance loses its dynamics
    // entirely. 30 dB below the loudest note maps to the bottom of the useful
    // range, which is about what a MIDI instrument can express.
    var loudest = 0;
    for (var q = 0; q < notes.length; q++) if (notes[q].peakRms > loudest) loudest = notes[q].peakRms;
    for (var w = 0; w < notes.length; w++) {
      var rel = loudest > 0 ? 20 * Math.log10(notes[w].peakRms / loudest) : 0;
      var t01 = Math.max(0, Math.min(1, 1 + rel / 30));
      notes[w].velocity = Math.max(20, Math.min(127, Math.round(20 + t01 * 107)));
      delete notes[w].peakRms;
    }
    return notes;
  }

  global.ASPitch = {
    yin: yin, track: track, segment: segment,
    hzToMidi: hzToMidi, midiToHz: midiToHz, midiName: midiName, NAMES: NAMES
  };
})(typeof window !== 'undefined' ? window : globalThis);
