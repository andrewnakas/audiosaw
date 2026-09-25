/*
 * Standard MIDI File reader, for opening .mid files in the audio editor.
 *
 * Real files are messier than the ones midi-write.js makes, so this reads
 * what DAWs and notation programs actually write: type 0 and type 1, any
 * number of tracks, tempo changes anywhere (they apply to every track, so
 * ticks are turned into seconds through one merged tempo map), running
 * status, note-on with velocity 0 as a note-off, sysex, SMPTE timing, and
 * the sustain pedal (written into note lengths). Pitch bend and the other
 * controllers are skipped.
 * A note left on at the end of its track ends there.
 *
 * Notes are grouped into parts by track and channel, since a type 0 file
 * puts every instrument in one track on separate channels. Channel 10 is
 * General MIDI percussion, and its part is marked drums.
 *
 *   ASMidiRead.parse(Uint8Array | ArrayBuffer) -> {
 *     format, ppq, bpm, sig: [num, den] | null, duration,
 *     parts: [{ name, channel, program, drums, notes: [{midi, start, duration, velocity}] }]
 *   }
 *
 * Throws on a file that is not MIDI or is cut short.
 */
(function (global) {
  'use strict';

  function parse(input) {
    var b = input instanceof Uint8Array ? input : new Uint8Array(input);
    var i = 0;
    function need(n) { if (i + n > b.length) throw new Error('The MIDI file is cut short.'); }
    function str4() { need(4); var s = String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]); i += 4; return s; }
    function u32() { need(4); var v = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0; i += 4; return v; }
    function u16() { need(2); var v = (b[i] << 8) | b[i + 1]; i += 2; return v; }
    function vlq(end) {
      var v = 0, c, n = 0;
      do { if (i >= end || ++n > 4) throw new Error('Bad length in the MIDI file.'); c = b[i++]; v = (v << 7) | (c & 0x7f); } while (c & 0x80);
      return v;
    }

    if (str4() !== 'MThd') throw new Error('That is not a MIDI file.');
    var hlen = u32(), hstart = i;
    var format = u16(), ntracks = u16(), div = u16();
    i = hstart + hlen;
    var smpte = div & 0x8000, ppq = smpte ? 0 : div;
    var ticksPerSec = smpte ? (256 - (div >> 8)) * (div & 0xff) : 0;

    var tempos = [];          // [{tick, usPerQuarter}]
    var sig = null, raw = [];  // raw: per track {name, events: [{tick, ch, on/off, key, vel, program}]}
    for (var t = 0; t < ntracks && i + 8 <= b.length; t++) {
      var id = str4(), len = u32(), start = i, end = Math.min(b.length, start + len);
      if (id !== 'MTrk') { i = end; t--; continue; }     // unknown chunks are skipped
      var tick = 0, status = 0, tr = { name: '', ev: [] };
      while (i < end) {
        tick += vlq(end);
        if (i >= end) break;
        var s = b[i];
        if (s & 0x80) { i++; if (s < 0xf0) status = s; } else if (!status) throw new Error('The MIDI file is damaged.'); else s = status;
        if (s === 0xff) {
          need(1);
          var meta = b[i++], ml = vlq(end), m0 = i;
          need(ml);
          if (meta === 0x51 && ml === 3) tempos.push({ tick: tick, us: (b[m0] << 16) | (b[m0 + 1] << 8) | b[m0 + 2] });
          else if (meta === 0x58 && ml >= 2 && !sig) sig = [b[m0], Math.pow(2, b[m0 + 1])];
          else if (meta === 0x03 && !tr.name) tr.name = decodeText(b.subarray(m0, m0 + ml));
          i = m0 + ml;
          if (meta === 0x2f) break;
        } else if (s === 0xf0 || s === 0xf7) {
          var sl = vlq(end); need(sl); i += sl;
        } else {
          var type = s & 0xf0, ch = s & 0x0f;
          if (type === 0xc0 || type === 0xd0) { need(1); var d1 = b[i++]; if (type === 0xc0) tr.ev.push({ tick: tick, ch: ch, program: d1 }); }
          else {
            need(2);
            var k = b[i++], v = b[i++];
            if (type === 0x90 && v > 0) tr.ev.push({ tick: tick, ch: ch, on: true, key: k, vel: v });
            else if (type === 0x80 || type === 0x90) tr.ev.push({ tick: tick, ch: ch, on: false, key: k });
            else if (type === 0xb0 && k === 64) tr.ev.push({ tick: tick, ch: ch, pedal: v >= 64 });
          }
        }
      }
      tr.endTick = tick;
      raw.push(tr);
      i = end;
    }
    if (!raw.length) throw new Error('The MIDI file has no tracks.');

    // Ticks to seconds through the merged tempo map.
    tempos.sort(function (a, c) { return a.tick - c.tick; });
    if (!tempos.length || tempos[0].tick > 0) tempos.unshift({ tick: 0, us: 500000 });
    var acc = 0;
    tempos.forEach(function (tp, n) {
      if (n) acc += (tp.tick - tempos[n - 1].tick) * tempos[n - 1].us / 1e6 / ppq;
      tp.sec = acc;
    });
    function sec(tk) {
      if (smpte) return tk / ticksPerSec;
      var lo = 0, hi = tempos.length - 1;
      while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (tempos[mid].tick <= tk) lo = mid; else hi = mid - 1; }
      var tp = tempos[lo];
      return tp.sec + (tk - tp.tick) * tp.us / 1e6 / ppq;
    }

    var parts = [], duration = 0;
    raw.forEach(function (tr, ti) {
      var byCh = {}, program = {};
      // Note-offs sort before note-ons at the same tick, so a repeated note
      // ends before it starts again; the sort is stable, so a pedal change
      // keeps its place among them.
      tr.ev.sort(function (a, c) { return a.tick - c.tick || ((a.on === true) - (c.on === true)); });
      tr.ev.forEach(function (e) {
        if (e.program != null) { program[e.ch] = e.program; return; }
        var P = byCh[e.ch] = byCh[e.ch] || { open: {}, notes: [], pedal: false, held: {} };
        // The sustain pedal: a note released while it is down sounds until
        // it comes up. There is no pedal in the editor, so it is written
        // into the notes' lengths.
        if (e.pedal != null) {
          P.pedal = e.pedal;
          if (!e.pedal) Object.keys(P.held).forEach(function (k) { if (P.open[k]) close(P, +k, e.tick); delete P.held[k]; });
          return;
        }
        var key = e.key;
        if (e.on) {
          // A second note-on at a sounding pitch ends the first one.
          if (P.open[key]) close(P, key, e.tick);
          delete P.held[key];
          P.open[key] = { tick: e.tick, vel: e.vel };
        } else if (P.open[key]) {
          if (P.pedal) P.held[key] = true; else close(P, key, e.tick);
        }
      });
      function close(P, key, tk) {
        var o = P.open[key];
        delete P.open[key];
        var s0 = sec(o.tick), s1 = sec(tk);
        if (s1 - s0 > 1e-4) P.notes.push({ midi: key, start: s0, duration: s1 - s0, velocity: o.vel });
      }
      Object.keys(byCh).forEach(function (c) {
        var P = byCh[c];
        Object.keys(P.open).forEach(function (key) { close(P, +key, Math.max(tr.endTick, P.open[key].tick + 1)); });
        if (!P.notes.length) return;
        P.notes.sort(function (a, c2) { return a.start - c2.start || a.midi - c2.midi; });
        P.notes.forEach(function (n) { duration = Math.max(duration, n.start + n.duration); });
        var ch = +c;
        parts.push({ name: tr.name || (format === 0 || raw.length === 1 ? 'Channel ' + (ch + 1) : 'Track ' + (ti + 1)), channel: ch, program: program[ch] != null ? program[ch] : null, drums: ch === 9, notes: P.notes });
      });
    });
    return { format: format, ppq: ppq, bpm: 60e6 / tempos[0].us, sig: sig, duration: duration, parts: parts };
  }

  function decodeText(bytes) {
    try { return new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/\0/g, '').trim(); }
    catch (e) { return String.fromCharCode.apply(null, bytes).trim(); }
  }

  global.ASMidiRead = { parse: parse };
  if (typeof module === 'object' && module.exports) module.exports = global.ASMidiRead;
})(typeof window !== 'undefined' ? window : globalThis);
