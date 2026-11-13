#!/usr/bin/env node
/*
 * check-module.js: js/module-play.js + vendor/modplay/<v>/modplay.wasm.
 *
 * The fixtures are written here, byte by byte, so nothing is fetched and no
 * module file lives in the repo: one looped sine sample, one note near A440,
 * a known speed and tempo. Each of MOD, XM, S3M and IT then has to report
 * its header, last exactly as long as the rows say, sound the note at the
 * pitch its format defines, render the same bytes twice, end when it jumps
 * back to the start, and refuse rubbish without trapping.
 *
 * Pitch references, for a 32-sample cycle:
 *   MOD, 4 channels (pt2-clone, a PAL Amiga): period 254 is clocked at
 *     3546895 / 254 Hz, so the note is 436.38 Hz.
 *   MOD, 8 channels (ft2play): Fasttracker tunes that same period to
 *     8363 * 428 / 254 Hz, 440.38 Hz. 16 cents apart, and both are right:
 *     the two kinds of MOD were written on different machines.
 *   XM, S3M, IT: C is 8363 Hz and A is nine equal-tempered semitones up,
 *     8363 * 2^(9/12) / 32 = 439.53 Hz.
 * A MOD's tick is the Amiga CIA timer's, 0.003% off 20 ms, hence 7.6802 s
 * where the PC formats give 7.6800.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var ASModule = require('../js/module-play.js');

var WASM = path.join(__dirname, '..', 'vendor', 'modplay', '1.0.0', 'modplay.wasm');

var failed = 0;
function ok(cond, msg) {
  if (cond) console.log('ok  ' + msg);
  else { console.log('FAIL ' + msg); failed++; }
}

// ---- fixtures -------------------------------------------------------------

var CYCLE = 32, CYCLES = 10, SMP_LEN = CYCLE * CYCLES;
var SPEED = 6, TEMPO = 125;
var ROW_SECONDS = SPEED * 2.5 / TEMPO;   // 0.12 s

function sine8() {
  var s = new Int8Array(SMP_LEN);
  for (var i = 0; i < SMP_LEN; i++) s[i] = Math.round(100 * Math.sin(2 * Math.PI * i / CYCLE));
  return s;
}

function put(buf, off, str) { for (var i = 0; i < str.length; i++) buf[off + i] = str.charCodeAt(i); }
function u16(buf, off, v) { buf[off] = v & 255; buf[off + 1] = (v >> 8) & 255; }
function u32(buf, off, v) { u16(buf, off, v & 65535); u16(buf, off + 2, (v >>> 16) & 65535); }
function concat(parts) {
  var n = 0, i;
  for (i = 0; i < parts.length; i++) n += parts[i].length;
  var out = new Uint8Array(n), at = 0;
  for (i = 0; i < parts.length; i++) { out.set(parts[i], at); at += parts[i].length; }
  return out;
}

// A song is { orders: [pattern numbers], patterns: [[cell, ...], ...] }, a cell
// { row, ch, note: true, jump: order, loopStart: true, loopTimes: n }.
// Every pattern is 64 rows.
var ROWS = 64;

function cellsAt(cells, row, ch) {
  for (var i = 0; i < cells.length; i++) if (cells[i].row === row && cells[i].ch === ch) return cells[i];
  return null;
}

// ProTracker MOD, 31 samples, 4 channels ("M.K.") or 8 ("8CHN"). Period 254 is A-2.
function writeMOD(song, nch) {
  nch = nch || 4;
  var head = new Uint8Array(1084);
  put(head, 0, 'check mod');
  put(head, 20, 'sine');
  head[20 + 22] = (SMP_LEN / 2) >> 8; head[20 + 23] = (SMP_LEN / 2) & 255;   // big-endian words
  head[20 + 25] = 64;
  head[20 + 28] = (SMP_LEN / 2) >> 8; head[20 + 29] = (SMP_LEN / 2) & 255;   // loop the lot
  head[950] = song.orders.length;
  head[951] = 127;
  for (var i = 0; i < song.orders.length; i++) head[952 + i] = song.orders[i];
  put(head, 1080, nch === 4 ? 'M.K.' : nch + 'CHN');
  var parts = [head];
  song.patterns.forEach(function (cells) {
    var p = new Uint8Array(ROWS * nch * 4);
    for (var row = 0; row < ROWS; row++) for (var ch = 0; ch < nch; ch++) {
      var c = cellsAt(cells, row, ch), o = (row * nch + ch) * 4;
      if (!c) continue;
      if (c.note) { p[o] = 254 >> 8; p[o + 1] = 254 & 255; p[o + 2] = 0x10; }
      if (c.jump !== undefined) { p[o + 2] |= 0x0B; p[o + 3] = c.jump; }
      if (c.loopStart) { p[o + 2] |= 0x0E; p[o + 3] = 0x60; }
      if (c.loopTimes) { p[o + 2] |= 0x0E; p[o + 3] = 0x60 | c.loopTimes; }
    }
    parts.push(p);
  });
  parts.push(new Uint8Array(sine8().buffer));
  return concat(parts);
}

// Fasttracker 2 XM, 2 channels, linear frequencies. Note 58 is A-4.
function writeXM(song) {
  var head = new Uint8Array(60 + 276);
  put(head, 0, 'Extended Module: ');
  put(head, 17, 'check xm');
  head[37] = 0x1A;
  put(head, 38, 'check-module.js');
  u16(head, 58, 0x0104);
  u32(head, 60, 276);
  u16(head, 64, song.orders.length);
  u16(head, 66, 0);
  u16(head, 68, 2);
  u16(head, 70, song.patterns.length);
  u16(head, 72, 1);
  u16(head, 74, 1);
  u16(head, 76, SPEED);
  u16(head, 78, TEMPO);
  for (var i = 0; i < song.orders.length; i++) head[80 + i] = song.orders[i];
  var parts = [head];

  song.patterns.forEach(function (cells) {
    var data = [];
    for (var row = 0; row < ROWS; row++) for (var ch = 0; ch < 2; ch++) {
      var c = cellsAt(cells, row, ch);
      if (!c) { data.push(0x80); continue; }
      var fx = -1, param = 0;
      if (c.jump !== undefined) { fx = 0x0B; param = c.jump; }
      if (c.loopStart) { fx = 0x0E; param = 0x60; }
      if (c.loopTimes) { fx = 0x0E; param = 0x60 | c.loopTimes; }
      data.push(0x80 | (c.note ? 0x03 : 0) | (fx >= 0 ? 0x18 : 0));
      if (c.note) data.push(58, 1);
      if (fx >= 0) data.push(fx, param);
    }
    var ph = new Uint8Array(9);
    u32(ph, 0, 9);
    u16(ph, 5, ROWS);
    u16(ph, 7, data.length);
    parts.push(ph, Uint8Array.from(data));
  });

  var ins = new Uint8Array(263);
  u32(ins, 0, 263);
  put(ins, 4, 'sine');
  u16(ins, 27, 1);
  u32(ins, 29, 40);
  var sh = new Uint8Array(40);
  u32(sh, 0, SMP_LEN);
  u32(sh, 4, 0);
  u32(sh, 8, SMP_LEN);
  sh[12] = 64;      // volume
  sh[14] = 1;       // forward loop, 8-bit
  sh[15] = 128;     // centre
  put(sh, 18, 'sine');
  var s = sine8(), delta = new Uint8Array(SMP_LEN), prev = 0;
  for (var k = 0; k < SMP_LEN; k++) { delta[k] = (s[k] - prev) & 255; prev = s[k]; }
  parts.push(ins, sh, delta);
  return concat(parts);
}

// IT and S3M pack a row the same way in spirit: per-cell bytes, 0 ends a row.
function packS3M(cells) {
  var data = [];
  for (var row = 0; row < ROWS; row++) {
    for (var ch = 0; ch < 2; ch++) {
      var c = cellsAt(cells, row, ch);
      if (!c) continue;
      var cmd = 0, param = 0;
      if (c.jump !== undefined) { cmd = 2; param = c.jump; }           // Bxx
      if (c.loopStart) { cmd = 19; param = 0xB0; }                     // SB0
      if (c.loopTimes) { cmd = 19; param = 0xB0 | c.loopTimes; }
      data.push(ch | (c.note ? 0x20 : 0) | (cmd ? 0x80 : 0));
      if (c.note) data.push(0x49, 1);                                  // A-4
      if (cmd) data.push(cmd, param);
    }
    data.push(0);
  }
  return data;
}

// Scream Tracker 3 S3M, 2 channels. Offsets are "parapointers": bytes / 16.
function writeS3M(song) {
  var nOrd = song.orders.length + 1;
  if (nOrd & 1) nOrd++;
  var nPat = song.patterns.length;
  var headLen = 0x60 + nOrd + 2 + nPat * 2;
  var pad = function (n) { return (n + 15) & ~15; };
  var insAt = pad(headLen);
  var at = insAt + 80;
  var packed = song.patterns.map(packS3M), patAt = [];
  packed.forEach(function (d) { at = pad(at); patAt.push(at); at += d.length + 2; });
  var smpAt = pad(at);
  var out = new Uint8Array(smpAt + SMP_LEN);

  put(out, 0, 'check s3m');
  out[0x1C] = 0x1A; out[0x1D] = 16;
  u16(out, 0x20, nOrd);
  u16(out, 0x22, 1);
  u16(out, 0x24, nPat);
  u16(out, 0x28, 0x1320);
  u16(out, 0x2A, 2);                 // unsigned samples
  put(out, 0x2C, 'SCRM');
  out[0x30] = 64; out[0x31] = SPEED; out[0x32] = TEMPO; out[0x33] = 0x80 | 48;
  for (var i = 0; i < 32; i++) out[0x40 + i] = 255;
  out[0x40] = 0; out[0x41] = 8;      // left 1, right 1
  for (i = 0; i < nOrd; i++) out[0x60 + i] = i < song.orders.length ? song.orders[i] : 255;
  u16(out, 0x60 + nOrd, insAt / 16);
  for (i = 0; i < nPat; i++) u16(out, 0x60 + nOrd + 2 + i * 2, patAt[i] / 16);

  var h = insAt;
  out[h] = 1;                        // PCM sample
  put(out, h + 1, 'SINE.SMP');
  out[h + 13] = (smpAt / 16) >> 16;
  u16(out, h + 14, (smpAt / 16) & 65535);
  u32(out, h + 16, SMP_LEN);
  u32(out, h + 20, 0);
  u32(out, h + 24, SMP_LEN);
  out[h + 28] = 64;
  out[h + 31] = 1;                   // looped
  u32(out, h + 32, 8363);
  put(out, h + 48, 'sine');
  put(out, h + 76, 'SCRS');

  packed.forEach(function (d, n) {
    u16(out, patAt[n], d.length + 2);
    out.set(d, patAt[n] + 2);
  });
  var s = sine8();
  for (i = 0; i < SMP_LEN; i++) out[smpAt + i] = s[i] + 128;
  return out;
}

// Impulse Tracker IT, sample mode, 2 channels, linear slides. Note 69 is A-5.
function writeIT(song) {
  var nOrd = song.orders.length + 1;
  var nPat = song.patterns.length;
  var packed = song.patterns.map(function (cells) {
    var data = [];
    for (var row = 0; row < ROWS; row++) {
      for (var ch = 0; ch < 2; ch++) {
        var c = cellsAt(cells, row, ch);
        if (!c) continue;
        var cmd = 0, param = 0;
        if (c.jump !== undefined) { cmd = 2; param = c.jump; }
        if (c.loopStart) { cmd = 19; param = 0xB0; }
        if (c.loopTimes) { cmd = 19; param = 0xB0 | c.loopTimes; }
        data.push((ch + 1) | 0x80, (c.note ? 3 : 0) | (cmd ? 8 : 0));
        if (c.note) data.push(69, 1);
        if (cmd) data.push(cmd, param);
      }
      data.push(0);
    }
    return data;
  });
  var smpHead = 192 + nOrd + 4 + nPat * 4;
  var at = smpHead + 80, patAt = [];
  packed.forEach(function (d) { patAt.push(at); at += 8 + d.length; });
  var smpAt = at;
  var out = new Uint8Array(smpAt + SMP_LEN);

  put(out, 0, 'IMPM');
  put(out, 4, 'check it');
  u16(out, 0x20, nOrd);
  u16(out, 0x22, 0);
  u16(out, 0x24, 1);
  u16(out, 0x26, nPat);
  u16(out, 0x28, 0x0214);
  u16(out, 0x2A, 0x0200);
  u16(out, 0x2C, 1 | 8);             // stereo, linear slides
  out[0x30] = 128; out[0x31] = 48; out[0x32] = SPEED; out[0x33] = TEMPO; out[0x34] = 128;
  for (var i = 0; i < 64; i++) { out[0x40 + i] = i < 2 ? 32 : 32 | 128; out[0x80 + i] = 64; }
  for (i = 0; i < nOrd; i++) out[0xC0 + i] = i < song.orders.length ? song.orders[i] : 255;
  u32(out, 0xC0 + nOrd, smpHead);
  for (i = 0; i < nPat; i++) u32(out, 0xC0 + nOrd + 4 + i * 4, patAt[i]);

  var h = smpHead;
  put(out, h, 'IMPS');
  put(out, h + 4, 'SINE.SMP');
  out[h + 0x11] = 64;
  out[h + 0x12] = 0x01 | 0x10;       // has data, looped
  out[h + 0x13] = 64;
  put(out, h + 0x14, 'sine');
  out[h + 0x2E] = 1;                 // signed
  u32(out, h + 0x30, SMP_LEN);
  u32(out, h + 0x34, 0);
  u32(out, h + 0x38, SMP_LEN);
  u32(out, h + 0x3C, 8363);
  u32(out, h + 0x48, smpAt);

  packed.forEach(function (d, n) {
    u16(out, patAt[n], d.length);
    u16(out, patAt[n] + 2, ROWS);
    out.set(d, patAt[n] + 8);
  });
  out.set(new Uint8Array(sine8().buffer), smpAt);
  return out;
}

var EQUAL_A = 8363 * Math.pow(2, 9 / 12) / CYCLE;
var FORMATS = [
  { name: 'MOD', format: 'MOD', write: writeMOD, channels: 4, hz: 28375160 / 8 / 254 / CYCLE, instruments: 31, player: 'pt2-clone' },
  { name: 'MOD 8CHN', format: 'MOD', write: function (s) { return writeMOD(s, 8); }, channels: 8, hz: 8363 * 428 / 254 / CYCLE, instruments: 31, player: 'ft2play' },
  { name: 'XM', format: 'XM', write: writeXM, channels: 2, hz: EQUAL_A, instruments: 1, player: 'ft2play' },
  { name: 'S3M', format: 'S3M', write: writeS3M, channels: 2, hz: EQUAL_A, instruments: 1, player: 'it2play' },
  { name: 'IT', format: 'IT', write: writeIT, channels: 2, hz: EQUAL_A, instruments: 1, player: 'it2play' }
];

// the same note on two channels, so that both are in use and both sides sound
var NOTE = { row: 0, ch: 0, note: true }, NOTE2 = { row: 0, ch: 1, note: true };
var PLAIN = { orders: [0], patterns: [[NOTE, NOTE2]] };
// order 1 jumps straight back: one pattern and one row, then the song repeats
var LOOPING = { orders: [0, 1], patterns: [[NOTE], [{ row: 0, ch: 0, jump: 0 }]] };
// rows 4..7 are played three times over; that is not the song repeating
var PATTERN_LOOP = { orders: [0], patterns: [[NOTE, { row: 4, ch: 1, loopStart: true }, { row: 7, ch: 1, loopTimes: 2 }]] };

// ---- measurements ---------------------------------------------------------

// Frequency from rising zero crossings, each placed by linear interpolation.
// A crossing counts only after the signal has been well below zero: Paula
// holds each 8-bit sample as a step, and the band-limited edges of a step
// near zero cross it more than once. Only the first and last crossing set
// the answer, so over three seconds a sample of jitter is 0.01 cents.
function pitchOf(r, from, to) {
  var L = r.channels[0], R = r.channels[1];
  var a = Math.floor(from * r.sampleRate), b = Math.floor(to * r.sampleRate);
  var i, peak = 0;
  for (i = a; i < b; i++) peak = Math.max(peak, Math.abs(L[i] + R[i]));
  var first = -1, last = -1, n = 0, armed = false;
  for (i = a + 1; i < b; i++) {
    var p = L[i - 1] + R[i - 1], q = L[i] + R[i];
    if (q < -0.3 * peak) armed = true;
    if (armed && p < 0 && q >= 0) {
      var t = i - 1 + (-p) / (q - p);
      if (first < 0) first = t;
      last = t;
      n++;
      armed = false;
    }
  }
  return n > 1 ? (n - 1) * r.sampleRate / (last - first) : 0;
}

function cents(f, ref) { return 1200 * Math.log(f / ref) / Math.LN2; }

function same(a, b) {
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function rms(x, from, to) {
  var s = 0;
  for (var i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / (to - from));
}

function throwsCleanly(fn) {
  try { fn(); return 'no error'; } catch (e) {
    if (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.RuntimeError) return 'trap: ' + e.message;
    if (!(e instanceof Error) || !e.message) return 'not an Error';
    return '';
  }
}

function rng(seed) {
  var s = seed >>> 0;
  return function () { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s >>> 24; };
}

// ---- the checks -----------------------------------------------------------

function run() {
  ok(ASModule.formats.join() === 'mod,xm,s3m,it', 'formats lists mod, xm, s3m, it');

  FORMATS.forEach(function (f) {
    var file = f.write(PLAIN);
    var info = ASModule.info(file);
    ok(info.format === f.format && info.title === 'check ' + f.format.toLowerCase() && info.player === f.player,
      f.name + ': info format, title and player ("' + info.format + '", "' + info.title + '", ' + info.player + ')');
    ok(info.channels === f.channels && info.patterns === 1 && info.orders === 1,
      f.name + ': info channels ' + info.channels + ', patterns ' + info.patterns + ', orders ' + info.orders);
    ok(info.instruments.length === f.instruments && info.instruments[0] === 'sine',
      f.name + ': info instruments (' + info.instruments.length + ', first "' + info.instruments[0] + '")');

    var want = ROWS * ROW_SECONDS;
    ok(Math.abs(info.duration - want) < 0.02 && !info.truncated,
      f.name + ': info duration ' + info.duration.toFixed(4) + ' s, expected ' + want.toFixed(2));

    var t0 = Date.now(), progress = 0;
    var r = ASModule.render(file, { onProgress: function (p) { progress = p; } });
    var took = (Date.now() - t0) / 1000;
    ok(r.sampleRate === 48000 && r.channels.length === 2 && r.channels[0] instanceof Float32Array &&
      r.channels[0].length === r.channels[1].length && r.format === f.format && progress === 1,
      f.name + ': render is 48 kHz stereo float and progress reached 1');
    var err = r.duration - want;
    ok(Math.abs(err) < 0.02 && r.duration === info.duration,
      f.name + ': rendered duration ' + r.duration.toFixed(4) + ' s (' + (err * 1000).toFixed(2) + ' ms off), same as info');

    var level = rms(r.channels[0], 24000, 96000) + rms(r.channels[1], 24000, 96000);
    ok(level > 0.01 && r.peak <= 1, f.name + ': the note sounds (rms ' + level.toFixed(3) + ', peak ' + r.peak.toFixed(3) + ')');

    var hz = pitchOf(r, 0.5, 3.5);
    var off = cents(hz, f.hz);
    ok(Math.abs(off) < 10, f.name + ': pitch ' + hz.toFixed(3) + ' Hz, expected ' + f.hz.toFixed(3) + ' (' + off.toFixed(2) + ' cents)');

    var r2 = ASModule.render(file);
    ok(same(r.channels[0], r2.channels[0]) && same(r.channels[1], r2.channels[1]),
      f.name + ': two renders are identical');

    var r44 = ASModule.render(file, { sampleRate: 44100 });
    var hz44 = pitchOf(r44, 0.5, 3.5);
    ok(r44.sampleRate === 44100 && Math.abs(cents(hz44, hz)) < 1 && Math.abs(r44.duration - want) < 0.02,
      f.name + ': at 44.1 kHz the pitch is ' + hz44.toFixed(3) + ' Hz (' + cents(hz44, hz).toFixed(3) +
      ' cents from 48 kHz), duration ' + r44.duration.toFixed(4) + ' s');

    // a jump back to the start must end the song, not fill maxSeconds
    var loop = ASModule.render(f.write(LOOPING), { maxSeconds: 60 });
    var loopWant = (ROWS + 1) * ROW_SECONDS;
    ok(Math.abs(loop.duration - loopWant) < 0.02 && !loop.truncated,
      f.name + ': a module that jumps back to order 0 ends at ' + loop.duration.toFixed(4) + ' s, expected ' + loopWant.toFixed(2));

    // a pattern loop is part of the song and must not be taken for its end
    var pl = ASModule.render(f.write(PATTERN_LOOP), { maxSeconds: 60 });
    var plWant = (ROWS + 8) * ROW_SECONDS;
    ok(Math.abs(pl.duration - plWant) < 0.02,
      f.name + ': a pattern loop plays in full: ' + pl.duration.toFixed(4) + ' s, expected ' + plWant.toFixed(2));

    var capped = ASModule.render(file, { maxSeconds: 2 });
    ok(capped.duration === 2 && capped.truncated, f.name + ': maxSeconds 2 stops at ' + capped.duration + ' s and says so');

    // cut short: an Error or a shorter song, never a trap or a hang
    var cuts = [1, 30, 64, 100, 200, 400, 700, 1083, 1084, 1090, 1500, file.length - SMP_LEN - 5, file.length - 100, file.length - 1];
    var bad = '';
    cuts.forEach(function (n) {
      if (n <= 0 || n >= file.length || bad) return;
      try {
        var t = ASModule.render(file.subarray(0, n), { maxSeconds: 30 });
        if (!(t.duration >= 0 && t.duration <= 30)) bad = 'cut at ' + n + ': duration ' + t.duration;
      } catch (e) {
        if (!(e instanceof Error) || (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.RuntimeError)) {
          bad = 'cut at ' + n + ': ' + e;
        }
      }
    });
    ok(!bad, f.name + ': truncated at ' + cuts.length + ' points, each a clean Error or a render' + (bad ? ' (' + bad + ')' : ''));
    var why = throwsCleanly(function () { ASModule.info(file.subarray(0, 200)); });
    ok(!why, f.name + ': cut to 200 bytes throws a plain Error' + (why ? ' (' + why + ')' : ''));

    // the real header in front of noise: the loaders must not follow its offsets out of the file
    var next = rng(f.name.length * 7919), worst = '';
    for (var round = 0; round < 40 && !worst; round++) {
      var junk = file.slice();
      var from = round < 20 ? 64 : 0, flips = round < 20 ? junk.length : 12;
      if (round < 20) { for (var j = from; j < junk.length; j++) junk[j] = next(); }
      else { for (var k = 0; k < flips; k++) junk[(next() * 256 + next()) % junk.length] = next(); }
      try { ASModule.render(junk, { maxSeconds: 5 }); } catch (e) {
        if (!(e instanceof Error) || (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.RuntimeError)) worst = String(e);
      }
    }
    ok(!worst, f.name + ': 40 corrupted copies, each a clean Error or a render' + (worst ? ' (' + worst + ')' : ''));

    var r3 = ASModule.render(file);
    ok(same(r.channels[0], r3.channels[0]) && same(r.channels[1], r3.channels[1]),
      f.name + ': still renders the same after the bad files');

    console.log('    ' + f.name + ': ' + (r.duration / took).toFixed(0) + 'x realtime (' + r.duration.toFixed(2) + ' s in ' + (took * 1000).toFixed(0) + ' ms)');
  });

  // files that are not modules at all
  var next = rng(12345);
  var noise = new Uint8Array(65536);
  for (var i = 0; i < noise.length; i++) noise[i] = next();
  var text = new Uint8Array(4000);
  for (i = 0; i < text.length; i++) text[i] = 'The quick brown fox. '.charCodeAt(i % 21);
  var wav = new Uint8Array(3000);
  put(wav, 0, 'RIFF'); put(wav, 8, 'WAVEfmt ');
  [['64 KB of noise', noise], ['a text file', text], ['a WAV header', wav], ['2000 zero bytes', new Uint8Array(2000)], ['10 bytes', new Uint8Array(10)]]
    .forEach(function (g) {
      var a = throwsCleanly(function () { ASModule.info(g[1]); });
      var b = throwsCleanly(function () { ASModule.render(g[1]); });
      ok(!a && !b, g[0] + ' is refused with a plain Error' + (a || b ? ' (' + (a || b) + ')' : ''));
    });
  var e1 = throwsCleanly(function () { ASModule.render(new Uint8Array(0)); });
  var e2 = throwsCleanly(function () { ASModule.render(FORMATS[0].write(PLAIN), { sampleRate: 8000 }); });
  ok(!e1 && !e2, 'an empty file and an unsupported sample rate are plain Errors');
}

// ---- the same thing in a browser -------------------------------------------

// One number for a whole render: every sample's bits go in, so two renders
// with the same digest are the same audio.
function digest(r) {
  var h = 2166136261 >>> 0;
  for (var c = 0; c < 2; c++) {
    var u = new Uint32Array(r.channels[c].buffer, r.channels[c].byteOffset, r.channels[c].length);
    for (var i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 16777619) >>> 0;
  }
  return h + ':' + r.channels[0].length;
}

// The page will call this from the main thread or from a Worker. Both are
// driven here: by URL, twice over (the second render needs a new instance
// made synchronously, which browsers have at times refused on the main
// thread), and the audio must be bit for bit what Node renders.
function browser() {
  var harness = require('./chrome-harness.js');
  if (!harness.findChrome()) {
    console.log('skip  no Chrome found: the browser half was not run');
    return Promise.resolve();
  }
  var files = FORMATS.map(function (f) { return Array.from(f.write(LOOPING)); });
  var want = FORMATS.map(function (f) { return digest(ASModule.render(f.write(LOOPING))); });
  var url = '/vendor/modplay/1.0.0/modplay.wasm';
  var job = 'function job(files) { return ASModule.load(' + JSON.stringify(url) + ').then(function () {' +
    ' return files.map(function (a) { var b = new Uint8Array(a); ASModule.render(b);' +
    ' var bad = ""; try { ASModule.info(new Uint8Array(5000)); bad = "no error"; } catch (e) { bad = e instanceof Error && !(e instanceof WebAssembly.RuntimeError) ? "" : String(e); }' +
    ' return digest(ASModule.render(b)) + bad; }); }); }';
  var worker = 'importScripts("/js/module-play.js");' + digest.toString() + job +
    'onmessage = function (e) { job(e.data).then(function (r) { postMessage(r); }, function (err) { postMessage(String(err)); }); };';
  var html = '<!doctype html><meta charset="utf-8"><script src="/js/module-play.js"></script><script>' +
    digest.toString() + job + 'var FILES = ' + JSON.stringify(files) + ';' +
    'function inWorker() { return new Promise(function (res) { var w = new Worker("/__modworker.js");' +
    ' w.onmessage = function (e) { res(e.data); }; w.onerror = function (e) { res("worker error: " + e.message); }; w.postMessage(FILES); }); }' +
    '</script>';
  return harness.withPage({ routes: { '/__mod': html, '/__modworker.js': Buffer.from(worker) } }, function (page) {
    return page.goto('/__mod').then(function () {
      return page.eval('job(FILES)');
    }).then(function (got) {
      ok(Array.isArray(got) && got.join() === want.join(),
        'Chrome, main thread: loaded by URL, all five fixtures bit-identical to Node' + (Array.isArray(got) && got.join() === want.join() ? '' : ' (' + got + ' vs ' + want + ')'));
      return page.eval('inWorker()');
    }).then(function (got) {
      ok(Array.isArray(got) && got.join() === want.join(),
        'Chrome, Worker: importScripts, all five fixtures bit-identical to Node' + (Array.isArray(got) && got.join() === want.join() ? '' : ' (' + got + ')'));
    });
  });
}

ASModule.load(WASM).then(function () {
  var mod = new WebAssembly.Module(fs.readFileSync(WASM));
  var imports = WebAssembly.Module.imports(mod).map(function (i) { return i.module + '.' + i.name; });
  ok(imports.join() === 'env.emscripten_notify_memory_growth', 'the wasm imports only ' + imports.join(', '));
  ok(fs.statSync(WASM).size < 25 * 1024 * 1024, 'the wasm is ' + (fs.statSync(WASM).size / 1024).toFixed(0) + ' KB (Pages limit 25 MiB)');
  run();
  return browser();
}).then(function () {
  if (failed) { console.log('\n' + failed + ' failed'); process.exit(1); }
  console.log('\ncheck-module: all passed');
}).catch(function (e) {
  console.log('FAIL ' + (e && e.stack || e));
  process.exit(1);
});
