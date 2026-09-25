/*
 * The instruments MIDI clips play through in /audio-editor.
 *
 * Each note is a handful of ordinary Web Audio nodes (oscillators, a filter,
 * a gain carrying the envelope) started and stopped on the context clock.
 * Nothing here is an AudioWorklet or a timer, so the same code runs in the
 * live AudioContext and in the OfflineAudioContext the export uses, and the
 * export sounds exactly like playback, which is the rule the whole engine
 * follows.
 *
 * These are simple synth voices, named for what they are. None of them is
 * a sampled piano, and the page does not say otherwise.
 *
 *   ASEditSynth.INSTRUMENTS  [{id, label, hint}]
 *   ASEditSynth.note(ctx, dest, instId, midi, when, dur, velocity, nodes)
 *     schedules one note into `dest` and pushes every source it starts onto
 *     `nodes`, so the engine can stop them. Returns when it has fully died.
 *   ASEditSynth.release(instId)  seconds a note rings past its end
 */
(function (global) {
  'use strict';

  var INSTRUMENTS = [
    { id: 'keys', label: 'Electric keys', hint: 'bell-like, fades as it is held' },
    { id: 'pad', label: 'Warm pad', hint: 'slow swell, holds' },
    { id: 'pluck', label: 'Pluck', hint: 'short, guitar-like' },
    { id: 'bass', label: 'Synth bass', hint: 'round low end' },
    { id: 'lead', label: 'Lead', hint: 'bright, for melodies' },
    { id: 'organ', label: 'Organ', hint: 'three drawbars' },
    { id: 'drums', label: 'Drum kit', hint: 'General MIDI drum notes' }
  ];
  var REL = { keys: 0.3, pad: 0.8, pluck: 0.15, bass: 0.08, lead: 0.12, organ: 0.05, drums: 0 };

  function hz(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  // Velocity to level: a curve, so soft notes are clearly softer, not just a
  // little. 100 is about -14 dBFS for one note.
  function level(v) { return 0.3 * Math.pow(Math.max(1, Math.min(127, v)) / 127, 1.6); }

  function osc(ctx, type, f, detune, when, stop, into, nodes) {
    var o = ctx.createOscillator();
    o.type = type; o.frequency.value = f;
    if (detune) o.detune.value = detune;
    o.connect(into);
    o.start(when); o.stop(stop);
    nodes.push(o);
    return o;
  }

  // Attack to peak, decay towards sustain while held, release after the end.
  function adsr(param, when, dur, peak, a, d, sus, r) {
    param.setValueAtTime(0, when);
    param.linearRampToValueAtTime(peak, when + a);
    param.setTargetAtTime(peak * sus, when + a, d / 3);
    var end = when + Math.max(dur, a);
    param.cancelAndHoldAtTime ? param.cancelAndHoldAtTime(end) : param.setValueAtTime(peak * sus, end);
    param.setTargetAtTime(0, end, r / 4);
    return end + r;
  }

  var noiseBufs = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  function noise(ctx) {
    var b = noiseBufs && noiseBufs.get(ctx);
    if (b) return b;
    var n = Math.round(ctx.sampleRate * 1.0);
    b = ctx.createBuffer(1, n, ctx.sampleRate);
    var d = b.getChannelData(0), s = 22222;
    for (var i = 0; i < n; i++) { s = (s * 16807) % 2147483647; d[i] = s / 1073741823.5 - 1; }
    if (noiseBufs) noiseBufs.set(ctx, b);
    return b;
  }
  function noiseHit(ctx, dest, when, len, amp, type, f, q, nodes) {
    var src = ctx.createBufferSource(), flt = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = noise(ctx);
    flt.type = type; flt.frequency.value = f; flt.Q.value = q;
    g.gain.setValueAtTime(amp, when);
    g.gain.setTargetAtTime(0, when + 0.002, len / 4);
    src.connect(flt); flt.connect(g); g.connect(dest);
    src.start(when, 0, Math.min(1, len * 1.5)); nodes.push(src);
    src.addEventListener('ended', function () { try { g.disconnect(); } catch (e) {} });
    return when + len * 1.5;
  }
  function thump(ctx, dest, when, f0, f1, len, amp, nodes) {
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(f0, when);
    o.frequency.exponentialRampToValueAtTime(f1, when + len * 0.6);
    g.gain.setValueAtTime(amp, when);
    g.gain.setTargetAtTime(0, when + 0.005, len / 4);
    o.connect(g); g.connect(dest);
    o.start(when); o.stop(when + len * 1.5); nodes.push(o);
    o.addEventListener('ended', function () { try { g.disconnect(); } catch (e) {} });
    return when + len * 1.5;
  }

  // General MIDI percussion, the notes drum parts actually use.
  function drum(ctx, dest, m, when, amp, nodes) {
    if (m === 35 || m === 36) return thump(ctx, dest, when, 150, 45, 0.35, amp * 2.2, nodes);
    if (m === 38 || m === 40) { thump(ctx, dest, when, 240, 170, 0.12, amp * 0.9, nodes); return noiseHit(ctx, dest, when, 0.18, amp * 1.2, 'highpass', 1200, 0.7, nodes); }
    if (m === 37) return noiseHit(ctx, dest, when, 0.05, amp, 'bandpass', 2500, 2, nodes);
    if (m === 39) return noiseHit(ctx, dest, when, 0.15, amp * 1.3, 'bandpass', 1500, 1.2, nodes);
    if (m === 42 || m === 44) return noiseHit(ctx, dest, when, 0.05, amp * 0.7, 'highpass', 7000, 0.7, nodes);
    if (m === 46) return noiseHit(ctx, dest, when, 0.35, amp * 0.6, 'highpass', 6500, 0.7, nodes);
    if (m === 49 || m === 52 || m === 55 || m === 57) return noiseHit(ctx, dest, when, 1.2, amp * 0.6, 'highpass', 4000, 0.5, nodes);
    if (m === 51 || m === 53 || m === 59) return noiseHit(ctx, dest, when, 0.6, amp * 0.4, 'bandpass', 6000, 1.5, nodes);
    if (m >= 41 && m <= 50) { var f = 80 + (m - 41) * 18; return thump(ctx, dest, when, f * 1.6, f, 0.3, amp * 1.4, nodes); }
    return noiseHit(ctx, dest, when, 0.08, amp * 0.6, 'bandpass', 3000, 1, nodes);
  }

  function note(ctx, dest, inst, m, when, dur, vel, nodes) {
    var amp = level(vel);
    if (inst === 'drums') return drum(ctx, dest, m, when, amp, nodes);
    var f = hz(m), g = ctx.createGain(), out = g, r = REL[inst] != null ? REL[inst] : 0.2, end, stop, first = nodes.length;
    g.gain.value = 0;
    if (inst === 'pad') {
      var lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = -3.01;
      lp.frequency.value = Math.min(8000, 900 + f * 2);
      lp.connect(g); stop = when + dur + r + 0.05;
      osc(ctx, 'sawtooth', f, -7, when, stop, lp, nodes); osc(ctx, 'sawtooth', f, 7, when, stop, lp, nodes);
      end = adsr(g.gain, when, dur, amp * 0.5, 0.25, 0.8, 0.8, r);
    } else if (inst === 'bass') {
      var lb = ctx.createBiquadFilter(); lb.type = 'lowpass'; lb.frequency.value = 700; lb.Q.value = 2;
      lb.connect(g); stop = when + dur + r + 0.05;
      osc(ctx, 'sine', f, 0, when, stop, g, nodes); osc(ctx, 'square', f, 0, when, stop, lb, nodes);
      end = adsr(g.gain, when, dur, amp * 0.8, 0.005, 0.4, 0.7, r);
    } else if (inst === 'pluck') {
      var pl = ctx.createBiquadFilter(); pl.type = 'lowpass'; pl.Q.value = 1;
      pl.frequency.setValueAtTime(Math.min(12000, f * 12), when);
      pl.frequency.setTargetAtTime(f * 1.5, when, 0.08);
      pl.connect(g); stop = when + Math.min(dur, 2) + r + 0.05;
      osc(ctx, 'sawtooth', f, 0, when, stop, pl, nodes);
      end = adsr(g.gain, when, Math.min(dur, 2), amp * 0.7, 0.002, 0.6, 0.15, r);
    } else if (inst === 'lead') {
      var ll = ctx.createBiquadFilter(); ll.type = 'lowpass'; ll.frequency.value = Math.min(9000, f * 8); ll.Q.value = 1;
      ll.connect(g); stop = when + dur + r + 0.05;
      osc(ctx, 'sawtooth', f, -5, when, stop, ll, nodes); osc(ctx, 'square', f, 5, when, stop, ll, nodes);
      end = adsr(g.gain, when, dur, amp * 0.4, 0.01, 0.3, 0.8, r);
    } else if (inst === 'organ') {
      stop = when + dur + r + 0.05;
      [[1, 1], [2, 0.6], [3, 0.4]].forEach(function (d) { var gg = ctx.createGain(); gg.gain.value = d[1] * 0.4; gg.connect(g); osc(ctx, 'sine', f * d[0], 0, when, stop, gg, nodes); });
      end = adsr(g.gain, when, dur, amp, 0.008, 0.05, 1, r);
    } else {
      // Electric keys: a sine with a quieter, faster-dying bell partial.
      stop = when + dur + r + 0.05;
      osc(ctx, 'sine', f, 0, when, stop, g, nodes);
      var bell = ctx.createGain(); bell.gain.setValueAtTime(0.5, when); bell.gain.setTargetAtTime(0, when, 0.15);
      bell.connect(g);
      osc(ctx, 'sine', f * 4, 0, when, Math.min(stop, when + 1), bell, nodes);
      osc(ctx, 'triangle', f, 3, when, stop, g, nodes);
      end = adsr(g.gain, when, dur, amp * 0.6, 0.004, 1.5, 0.35, r);
    }
    out.connect(dest);
    // Once every source of the note has stopped, take its chain off the
    // graph. Left connected, a finished note's gain and filter are still
    // processed every block: a 3-minute part of 5,000 notes took 13 minutes
    // to export that way.
    var srcs = nodes.slice(first), left = srcs.length;
    srcs.forEach(function (x) { x.addEventListener('ended', function () { if (--left === 0) try { out.disconnect(); } catch (e) {} }); });
    return end;
  }

  function release(inst) { return REL[inst] != null ? REL[inst] : 0.2; }

  global.ASEditSynth = { INSTRUMENTS: INSTRUMENTS, note: note, release: release };
})(typeof window !== 'undefined' ? window : globalThis);
