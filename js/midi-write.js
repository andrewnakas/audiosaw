/*
 * Minimal Standard MIDI File writer (SMF type 0).
 *
 * Everything here is byte-exact by necessity: MIDI has no forgiving parser.
 * Chunk lengths must match their contents, and delta times are variable-length
 * quantities — seven bits per byte, high bit set on every byte but the last.
 * Get either wrong and a DAW reports a corrupt file with no clue why, so
 * tools/check-midi.js parses the output back and checks it note for note.
 */
(function (global) {
  'use strict';

  var PPQ = 480;   // ticks per quarter note; 480 divides cleanly by 3 and 4

  // Variable-length quantity, as the spec defines it.
  function vlq(value) {
    var out = [];
    var v = Math.max(0, Math.round(value));
    out.push(v & 0x7f);
    v >>= 7;
    while (v > 0) { out.push((v & 0x7f) | 0x80); v >>= 7; }
    return out.reverse();
  }

  function str(s) {
    var out = [];
    for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xff);
    return out;
  }
  function u32(v) { return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]; }
  function u16(v) { return [(v >>> 8) & 0xff, v & 0xff]; }

  /*
   * notes: [{ midi, start (seconds), duration (seconds), velocity }]
   * opts:  { bpm, ppq, trackName }
   */
  function build(notes, opts) {
    opts = opts || {};
    var bpm = opts.bpm && opts.bpm > 0 ? opts.bpm : 120;
    var ppq = opts.ppq || PPQ;
    var secPerTick = 60 / bpm / ppq;

    // Note on and note off as separate events on one timeline, sorted by tick.
    // Off must come before on at the same tick, or a repeated note is cut dead
    // by its own predecessor's release.
    var events = [];
    notes.forEach(function (n) {
      var onTick = Math.round(n.start / secPerTick);
      var offTick = Math.max(onTick + 1, Math.round((n.start + n.duration) / secPerTick));
      var vel = Math.max(1, Math.min(127, n.velocity || 90));
      var key = Math.max(0, Math.min(127, Math.round(n.midi)));
      events.push({ tick: onTick, order: 1, bytes: [0x90, key, vel] });
      events.push({ tick: offTick, order: 0, bytes: [0x80, key, 0] });
    });
    events.sort(function (a, b) { return a.tick - b.tick || a.order - b.order; });

    var track = [];
    // Tempo, so the DAW lays the notes on the right grid rather than assuming 120.
    var usPerQuarter = Math.round(60000000 / bpm);
    track = track.concat(vlq(0), [0xff, 0x51, 0x03],
      [(usPerQuarter >>> 16) & 0xff, (usPerQuarter >>> 8) & 0xff, usPerQuarter & 0xff]);
    // 4/4, 24 clocks per metronome click, 8 32nds per quarter.
    track = track.concat(vlq(0), [0xff, 0x58, 0x04], [4, 2, 24, 8]);
    if (opts.trackName) {
      var nm = str(opts.trackName).slice(0, 120);
      track = track.concat(vlq(0), [0xff, 0x03], vlq(nm.length), nm);
    }

    var last = 0;
    events.forEach(function (e) {
      track = track.concat(vlq(e.tick - last), e.bytes);
      last = e.tick;
    });
    track = track.concat(vlq(0), [0xff, 0x2f, 0x00]);   // end of track

    var bytes = [].concat(
      str('MThd'), u32(6), u16(0), u16(1), u16(ppq),
      str('MTrk'), u32(track.length), track
    );
    return new Uint8Array(bytes);
  }

  function blob(notes, opts) {
    return new Blob([build(notes, opts)], { type: 'audio/midi' });
  }

  global.ASMidi = { build: build, blob: blob, vlq: vlq, PPQ: PPQ };
})(typeof window !== 'undefined' ? window : globalThis);
