/*
 * ASRange: a vocal range from pitch readings, and the voice type it is
 * closest to. Behind /vocal-range-test.
 *
 * Meter: fed one pitch reading at a time (YIN from js/pitch-track.js, every
 * 50 ms on the live page, every frame from a recording). A note counts once
 * the voice has stayed near it for 300 ms (its average within 50 cents,
 * every reading within 75, so vibrato does not break a hold): long enough that a
 * crack, a slide through the note or a breathy onset does not count, short
 * enough that a sung note of any length does. The range is the lowest and
 * highest notes that counted. Readings with poor clarity (noise, breath,
 * two notes at once) are dropped; a gap of more than 150 ms breaks a hold.
 *
 * Voice types: the classical ranges, as most choir and singing-teacher
 * charts give them (soprano C4-C6, mezzo A3-A5, contralto F3-F5,
 * countertenor E3-E5, tenor C3-C5, baritone A2-A4, bass E2-E4). A range is
 * matched to the type whose span it covers best, with the distance between
 * the two centres as the tie-break; contralto and countertenor share almost
 * the same notes, so they are named together.
 *
 * Checked by tools/check-vocal-range.js (in Node, and live through a fake
 * microphone in Chrome).
 *
 * UMD: runs in Node for the check and in the page.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ASRange = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var HOLD = 0.3, CENTS = 50, GAP = 0.15, CLARITY = 0.85;
  var NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  function name(m) { return NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1); }
  function midiOf(hz) { return 69 + 12 * Math.log(hz / 440) / Math.LN2; }
  function hzOf(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  // MIDI numbers: C4 = 60.
  var TYPES = [
    { id: 'bass', name: 'Bass', lo: 40, hi: 64 },              // E2-E4
    { id: 'baritone', name: 'Baritone', lo: 45, hi: 69 },      // A2-A4
    { id: 'tenor', name: 'Tenor', lo: 48, hi: 72 },            // C3-C5
    { id: 'alto', name: 'Contralto or countertenor', lo: 52.5, hi: 76.5 }, // F3-F5 / E3-E5
    { id: 'mezzo', name: 'Mezzo-soprano', lo: 57, hi: 81 },    // A3-A5
    { id: 'soprano', name: 'Soprano', lo: 60, hi: 84 }         // C4-C6
  ];

  function classify(lo, hi) {
    if (lo == null || hi == null || hi < lo) return null;
    var c = (lo + hi) / 2;
    var scored = TYPES.map(function (t) {
      var overlap = Math.max(0, Math.min(hi, t.hi) - Math.max(lo, t.lo));
      var span = Math.max(1, Math.min(hi - lo, t.hi - t.lo));
      return { type: t, fit: overlap / span, dist: Math.abs(c - (t.lo + t.hi) / 2) };
    });
    scored.sort(function (a, b) { return (b.fit - a.fit) || (a.dist - b.dist); });
    // Within a whole-semitone of fit, the nearer centre wins.
    var best = scored.filter(function (s) { return s.fit >= scored[0].fit - 1 / 24; }).sort(function (a, b) { return a.dist - b.dist; });
    var first = best[0], second = scored.filter(function (s) { return s !== first; }).sort(function (a, b) { return a.dist - b.dist; })[0];
    return { type: first.type, runnerUp: second.type, fit: first.fit };
  }

  function Meter(opts) {
    opts = opts || {};
    this.hold = opts.hold || HOLD;
    this.reset();
  }
  Meter.prototype.reset = function () {
    this.cur = null;        // { note, since, last, sum, n }
    this.notes = {};        // midi -> seconds held in total
    this.lo = null; this.hi = null;
    this.last = null;       // last reading { midi, t }
    this.prevT = null;
  };
  // One reading: hz (0 for none), clarity 0..1, t in seconds.
  Meter.prototype.feed = function (hz, clarity, t) {
    var counted = null, dt = this.prevT == null ? 0 : Math.min(GAP, t - this.prevT);
    this.prevT = t;
    if (!(hz > 0) || clarity < CLARITY) {
      if (this.cur && t - this.cur.last > GAP) this.cur = null;
      this.last = null;
      return null;
    }
    var m = midiOf(hz), near = Math.round(m);
    this.last = { midi: m, t: t, note: near, cents: Math.round((m - near) * 100) };
    var c = this.cur;
    // A hold carries on through vibrato (up to 75 cents either way) and
    // counts if its average sits within 50 cents of the note.
    if (c && Math.abs(m - c.note) * 100 <= 75 && t - c.last <= GAP) {
      c.last = t; c.sum += m; c.n++;
    } else {
      // A new hold starts on the nearest note, if this reading is near one.
      c = this.cur = Math.abs(m - near) * 100 <= CENTS ? { note: near, since: t, last: t, sum: m, n: 1, counted: false } : null;
    }
    if (c && !c.counted && c.last - c.since >= this.hold - 1e-9 && Math.abs(c.sum / c.n - c.note) * 100 <= CENTS) {
      c.counted = true;
      counted = c.note;
      if (this.lo == null || c.note < this.lo) this.lo = c.note;
      if (this.hi == null || c.note > this.hi) this.hi = c.note;
    }
    if (c && c.counted) this.notes[c.note] = (this.notes[c.note] || 0) + dt;
    return counted;
  };
  Meter.prototype.result = function () {
    if (this.lo == null) return null;
    var semis = this.hi - this.lo;
    return {
      lo: this.lo, hi: this.hi, loName: name(this.lo), hiName: name(this.hi), loHz: hzOf(this.lo), hiHz: hzOf(this.hi),
      semitones: semis, octaves: Math.floor(semis / 12), extra: semis % 12,
      voice: classify(this.lo, this.hi)
    };
  };

  // A whole recording: frames of { time, hz, clarity } from ASPitch.track.
  function fromFrames(frames) {
    var m = new Meter();
    frames.forEach(function (f) { m.feed(f.hz, f.clarity, f.time); });
    return m;
  }

  return { Meter: Meter, classify: classify, fromFrames: fromFrames, TYPES: TYPES, name: name, midiOf: midiOf, hzOf: hzOf, HOLD: HOLD, CENTS: CENTS };
});
