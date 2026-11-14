#!/usr/bin/env node
/*
 * check-rebirth.js: js/rebirth-play.js + vendor/openrb/<v>/openrb.wasm.
 *
 * Nothing of ReBirth is in the repo: no song, no drum kit. So the check has
 * two halves.
 *
 * Always: the wasm loads and imports nothing; an empty song the wasm writes
 * itself (four silent bars) reports its header, lasts exactly as long as the
 * export's own chunk maths says (redone here in JS), and renders the same
 * twice; and rubbish, that song cut short at every length, and that song
 * with bytes flipped are each refused with a plain Error or rendered, never
 * a trap that escapes and never a long wait.
 *
 * With files (print `skip` otherwise):
 *   RB_SONGS=/dir          .rbs files, searched recursively
 *   RB_KIT=/path           the standard kit: Standard.rbm, or a clear kit
 *                          made by ASRebirth.clearKit (vendor/openrb/<v>/make-kit.js)
 *   RB_KEY=/path           the 2047 key bytes a .rbm needs
 *                          (upstream's crates/rbm/src/rb20ful_window.bin)
 *   RB_ORB=/path/to/orb    upstream's native CLI, the reference
 *   RB_COUNT=24            how many songs to compare against it
 * Then: every song's facts read, and equal to `orb info --json`; render
 * length equal to the chunk maths; two renders identical; a .rbm kit and
 * its clear kit give the same samples; the damaged-file sweep on real
 * songs; and the strongest one, the wasm render against the native
 * `orb render` of the same song, sample for sample.
 *
 * The native comparison keeps to what both sides can be given alike: songs
 * on the standard kit, songs that name a mod rendered with the standard kit
 * instead (`--standard-kit`), and a `--range` case. A loop over five minutes
 * is compared on its first 48 bars to keep the run short.
 */
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var child = require('child_process');
var ASRebirth = require('../js/rebirth-play.js');

var VERSION = '2026-11-13';
var WASM = path.join(__dirname, '..', 'vendor', 'openrb', VERSION, 'openrb.wasm');

var EXPORTS = ['memory', 'orb_alloc', 'orb_begin', 'orb_blank_song', 'orb_end', 'orb_export_kit',
  'orb_frames', 'orb_free', 'orb_info', 'orb_kit_name', 'orb_load_song', 'orb_message', 'orb_out',
  'orb_panic_text', 'orb_rate', 'orb_render', 'orb_set_key', 'orb_set_kit', 'orb_set_mod'];

var failed = 0;
function ok(cond, msg) {
  if (cond) console.log('ok  ' + msg);
  else { console.log('FAIL ' + msg); failed++; }
}
function skip(msg) { console.log('skip ' + msg); }

// ---- helpers --------------------------------------------------------------

// The export's chunk loop (upstream export.rs `chunk_sizes`, the original's
// sub_4280D5), written again here so the wasm's count is checked against
// something other than itself. The values are 32-bit signed, as its `fild`s.
function exportFrames(tempo, startTick, endTick) {
  var k = 192.0 / 2646000000.0;
  var t = tempo | 0, end = endTick | 0, pos = startTick | 0;
  var total = 0;
  for (;;) {
    var n = Math.trunc((end - pos) / (t * k));
    var last = n < 2048;
    if (!last) n = 2048;
    pos += (t * n) * k;
    if (n > 0) total += n;
    if (last) return total;
  }
}

function sameAudio(a, b) {
  if (a.channels[0].length !== b.channels[0].length) return false;
  for (var c = 0; c < 2; c++) {
    var x = a.channels[c], y = b.channels[c];
    for (var i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  }
  return true;
}

// mulberry32: the damaged files must be the same ones on every run
function rng(seed) {
  var a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    var t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Runs info and a short render on `bytes`. Returns 'ok', 'refused' (a plain
// Error from the parser), 'gave-up' (the engine panicked; the wrapper turned
// the trap into an Error) or 'escaped' (anything else: a failure).
var slowest = 0;
function attempt(bytes) {
  var t0 = Date.now();
  var out = 'ok';
  try {
    ASRebirth.info(bytes, { maxSeconds: 2 });
    ASRebirth.render(bytes, { maxSeconds: 2, idleBlocks: 64 });
  } catch (e) {
    if (!(e instanceof Error) || (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.RuntimeError)) out = 'escaped';
    else if (/not a ReBirth song|is empty/.test(e.message)) out = /panicked/.test(e.detail || '') ? 'gave-up' : 'refused';
    else if (/cannot be rendered|Not enough memory/.test(e.message)) out = 'refused';
    else out = 'escaped';
  }
  var ms = Date.now() - t0;
  if (ms > slowest) slowest = ms;
  return out;
}

function sweep(base, label, flips, seed) {
  var count = { ok: 0, refused: 0, 'gave-up': 0, escaped: 0 };
  var n, i;
  // cut short: every length through the headers, then in strides
  var cuts = [];
  for (n = 0; n < Math.min(base.length, 600); n++) cuts.push(n);
  for (n = 600; n < base.length; n += Math.max(1, Math.floor(base.length / 150))) cuts.push(n);
  for (i = 0; i < cuts.length; i++) count[attempt(base.subarray(0, cuts[i]))]++;
  var cutN = cuts.length;
  var rnd = rng(seed);
  for (i = 0; i < flips; i++) {
    var b = new Uint8Array(base);
    var hits = 1 + Math.floor(rnd() * 8);
    // half of them in the first kilobyte, where the headers and lengths are
    for (var h = 0; h < hits; h++) {
      var at = Math.floor(rnd() * (rnd() < 0.5 ? Math.min(1024, b.length) : b.length));
      b[at] = Math.floor(rnd() * 256);
    }
    count[attempt(b)]++;
  }
  ok(count.escaped === 0, label + ': ' + cutN + ' cut short and ' + flips + ' with bytes changed, none escaped as a trap (' +
    count.refused + ' refused, ' + count.ok + ' rendered, ' + count['gave-up'] + ' engine gave up)');
  return count;
}

function wavPcm(file) {
  var b = fs.readFileSync(file);
  if (b.toString('latin1', 0, 4) !== 'RIFF' || b.readUInt32LE(24) !== 44100 || b.readUInt16LE(22) !== 2 || b.readUInt16LE(34) !== 16) return null;
  var bytes = b.readUInt32LE(40);
  return new Int16Array(b.buffer.slice(b.byteOffset + 44, b.byteOffset + 44 + bytes));
}

// -> { frames, max } : the largest difference in 16-bit steps
function diffPcm(render, pcm) {
  var n = pcm.length / 2, L = render.channels[0], R = render.channels[1];
  var max = 0;
  var m = Math.min(n, L.length);
  for (var i = 0; i < m; i++) {
    var a = Math.abs(L[i] * 32768 - pcm[2 * i]), b = Math.abs(R[i] * 32768 - pcm[2 * i + 1]);
    if (a > max) max = a;
    if (b > max) max = b;
  }
  return { frames: n, max: max };
}

function listSongs(dir) {
  var out = [];
  (function walk(d) {
    fs.readdirSync(d, { withFileTypes: true }).forEach(function (e) {
      var p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name[0] !== '.') walk(p); }
      else if (/\.rbs$/i.test(e.name)) out.push(p);
    });
  })(dir);
  return out.sort();
}

// ---- always ---------------------------------------------------------------

function always() {
  var mod = new WebAssembly.Module(fs.readFileSync(WASM));
  var imports = WebAssembly.Module.imports(mod);
  ok(imports.length === 0, 'the wasm imports nothing' + (imports.length ? ' (' + imports.map(function (i) { return i.module + '.' + i.name; }).join(', ') + ')' : ''));
  var exps = WebAssembly.Module.exports(mod).map(function (e) { return e.name; }).sort();
  ok(exps.join() === EXPORTS.slice().sort().join(), 'its exports are the ' + EXPORTS.length + ' listed in the README' + (exps.join() === EXPORTS.slice().sort().join() ? '' : ' (' + exps.join(' ') + ')'));
  var size = fs.statSync(WASM).size;
  ok(size < 25 * 1024 * 1024, 'the wasm is ' + (size / 1024).toFixed(0) + ' KB (Pages limit 25 MiB)');
  ok(ASRebirth.sampleRate === 44100, 'the rate is the engine\'s 44100 Hz');

  // No ReBirth sample or key in the binary: the AIFF samples all carry a
  // "COMM" chunk, a mod its "PRBM" type, and the standard mod its name.
  var raw = fs.readFileSync(WASM).toString('latin1');
  ok(raw.indexOf('FORM') < 0 || raw.indexOf('AIFFCOMM') < 0, 'no AIFF sample is inside the wasm');
  ok(raw.indexOf('CAT ') < 0 || raw.indexOf('PRBMHEAD') < 0, 'no .rbm is inside the wasm');

  var blank = ASRebirth.blankSong();
  var info = ASRebirth.info(blank);
  ok(info.format === 'RBS 4.2' && info.rb1x === false && info.version === '4.2', 'empty song: format ' + info.format);
  ok(info.title === '' && info.text === '' && info.webPage === '' && info.copyright === '', 'empty song: title, text, web page and copyright are empty strings');
  ok(info.modName === 'Standard ReBirth' && info.usesMod === false, 'empty song: the kit is "' + info.modName + '", not a mod');
  ok(info.bpm === 140 && info.tempo === 140000, 'empty song: ' + info.bpm + ' BPM');
  ok(info.loopStartBar === 0 && info.loopEndBar === 4 && info.loopBars === 4 && info.looping === false, 'empty song: loop bars 0 to 4, switched off');
  ok(info.lastEventBar === null && info.drums.length === 0 && info.songMode === false, 'empty song: no track events, no drums playing, pattern mode');

  var want = exportFrames(info.tempo, info.loopStartTick, info.loopEndTick);
  ok(info.frames === want, 'empty song: ' + info.frames + ' frames, the chunk maths redone in JS gives ' + want);
  // 4 bars of 4 beats at 140 BPM is 302400 frames; the engine's sum of truncated chunks is one short
  ok(Math.abs(info.frames - 4 * 4 * 60 / 140 * 44100) <= 1, 'empty song: within a frame of 4 bars at 140 BPM (' + info.duration.toFixed(4) + ' s)');

  var steps = [];
  var a = ASRebirth.render(blank, { onProgress: function (p) { steps.push(p); } });
  ok(a.sampleRate === 44100 && a.channels.length === 2 && a.channels[0] instanceof Float32Array, 'empty song: stereo Float32 at 44100 Hz');
  ok(a.channels[0].length === want && a.channels[1].length === want && a.duration === want / 44100, 'empty song: rendered ' + a.channels[0].length + ' frames');
  ok(a.peak === 0 && a.truncated === false && a.faults === 0, 'empty song: digital silence, not truncated, no fault');
  ok(a.kitUsed === false && a.drumsSilent === false && a.modMissing === false, 'empty song: needs no kit and says so');
  var rising = steps.length > 1 && steps[steps.length - 1] === 1;
  for (var i = 1; i < steps.length; i++) if (!(steps[i] > steps[i - 1])) rising = false;
  ok(rising, 'empty song: progress rises to 1 in ' + steps.length + ' steps');

  var r = ASRebirth.render(blank, { range: [2, 3] });
  var bar = exportFrames(info.tempo, 2 * 768, 3 * 768);
  ok(r.channels[0].length === bar && r.info.range.join() === '2,3' && r.info.rangeIsLoop === false, 'range [2, 3): one bar, ' + r.channels[0].length + ' frames');
  var t = ASRebirth.render(blank, { range: [0, 1000], maxSeconds: 3 });
  ok(t.truncated === true && t.channels[0].length === 3 * 44100, 'maxSeconds 3 on 1000 bars: truncated at ' + t.channels[0].length + ' frames');
  var threw = '';
  try { ASRebirth.render(blank, { range: [5, 5] }); } catch (e) { threw = e.message; }
  ok(/range/.test(threw), 'an empty range is refused: ' + threw);

  // ---- files that are not songs
  function refused(bytes, label) {
    var msg = null, trap = false;
    try { ASRebirth.info(bytes); } catch (e) { msg = e.message; trap = !(e instanceof Error) || e instanceof WebAssembly.RuntimeError || /panicked/.test(e.detail || ''); }
    var msg2 = null;
    try { ASRebirth.render(bytes, { maxSeconds: 1 }); } catch (e) { msg2 = e.message; }
    ok(msg !== null && msg2 !== null && !trap, label + ': a plain Error ("' + msg + '")');
  }
  refused(new Uint8Array(0), 'an empty file');
  refused(new Uint8Array(4096), '4096 zero bytes');
  var rnd = rng(338);
  var junk = new Uint8Array(20000);
  for (i = 0; i < junk.length; i++) junk[i] = Math.floor(rnd() * 256);
  refused(junk, '20,000 random bytes');
  var txt = Buffer.from('This is a text file, not a song.\n');
  refused(new Uint8Array(txt), 'a text file');
  var cat = new Uint8Array(junk); cat.set(blank.subarray(0, 12));
  refused(cat, 'a song header followed by random bytes');
  var midi = new Uint8Array(junk); midi.set([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 2, 0, 0xc0, 0x4d, 0x54, 0x72, 0x6b, 0, 0, 0x40, 0]);
  refused(midi, 'a MIDI header followed by random bytes');
  var wav = new Uint8Array(junk); wav.set(Buffer.from('RIFF\x24\x08\x00\x00WAVEfmt ', 'latin1'));
  refused(wav, 'a WAV header followed by random bytes');
  refused(blank.subarray(0, blank.length - 1), 'the empty song one byte short');
  var grown = new Uint8Array(blank.length + 1); grown.set(blank);
  refused(grown, 'the empty song with a byte added');

  var threwKit = '';
  try { ASRebirth.render(blank, { kit: junk }); } catch (e) { threwKit = e.message; }
  ok(/drum kit/.test(threwKit), 'random bytes as a kit: ' + threwKit.slice(0, 70));
  var badKit = new Uint8Array(40); badKit.set(Buffer.from('ORBKIT1\x00', 'latin1'));
  badKit[8] = 2; badKit[11] = 255; badKit[12] = 255; badKit[13] = 255; badKit[14] = 127;
  threwKit = '';
  try { ASRebirth.render(blank, { kit: badKit }); } catch (e) { threwKit = e.message; }
  ok(/cut short/.test(threwKit), 'a clear kit that claims 2 GB of samples: ' + threwKit.slice(0, 70));

  // The built-in kit (vendor/openrb/<v>/kit): made from CC0 recordings, fitted to targets.json.
  var kitDir = path.join(__dirname, '../vendor/openrb/2026-11-13/kit');
  var own = fs.readFileSync(path.join(kitDir, 'audiosaw-kit-1.orbkit')), targets = JSON.parse(fs.readFileSync(path.join(kitDir, 'targets.json'), 'utf8'));
  var names = Object.keys(targets), p = 8 + 2 + own.readUInt16LE(8), wrong = [], quiet = [], hot = 0;
  for (var si = 0; si < 46; si++) {
    var frames = own.readUInt32LE(p), pk = 0; p += 4;
    for (var fi = 0; fi < frames; fi++) pk = Math.max(pk, Math.abs(own.readInt16LE(p + 2 * fi)));
    p += 2 * frames;
    if (names[si] === 'Startup') continue;
    if (frames !== targets[names[si]].frames) wrong.push(names[si]);
    if (pk < 3000) quiet.push(names[si]);
    hot = Math.max(hot, pk);
  }
  ok(p === own.length && names.length === 46, 'the built-in kit is 46 slots and nothing else (' + own.length + ' bytes)');
  ok(!wrong.length && !quiet.length && hot < 32767, 'each drum slot is its target length, sounds, and none clips' + (wrong.length || quiet.length ? ': ' + wrong.concat(quiet).join(' ') : ' (peak ' + (hot / 32768).toFixed(3) + ')'));
  var withOwn = ASRebirth.render(blank, { kit: new Uint8Array(own) });
  ok(sameAudio(a, withOwn), 'the engine takes it, and a song with no drums renders the same with it');

  slowest = 0;
  sweep(blank, 'the empty song', 400, 1);
  ok(slowest < 20000, 'none of them hung: the slowest took ' + slowest + ' ms');

  var again = ASRebirth.render(blank);
  ok(sameAudio(a, again), 'after all of that a fresh render is still the same');
}

// ---- with songs -----------------------------------------------------------

function withSongs() {
  var dir = process.env.RB_SONGS, kitPath = process.env.RB_KIT, keyPath = process.env.RB_KEY, orb = process.env.RB_ORB;
  if (!dir) {
    skip('RB_SONGS is not set: no real song was read');
    skip('RB_KIT, RB_KEY, RB_ORB: the drum kit, the determinism of real songs and the native comparison were not run');
    return;
  }
  var files = listSongs(dir);
  ok(files.length > 0, files.length + ' .rbs files under RB_SONGS');
  if (!files.length) return;

  // every file's facts
  var facts = [], bad = [], lengthOff = 0, kinds = {};
  files.forEach(function (f) {
    try {
      var i = ASRebirth.info(fs.readFileSync(f), { maxSeconds: 3600 });
      i.file = f;
      facts.push(i);
      kinds[i.format] = (kinds[i.format] || 0) + 1;
      if (!i.truncated && i.frames !== exportFrames(i.tempo, i.loopStartTick, i.loopEndTick)) lengthOff++;
    } catch (e) { bad.push(path.basename(f) + ': ' + (e.detail || e.message)); }
  });
  ok(bad.length === 0, 'info reads ' + facts.length + ' of ' + files.length + ' songs' + (bad.length ? ' (' + bad.slice(0, 3).join('; ') + ')' : '') +
    ': ' + Object.keys(kinds).sort().map(function (k) { return kinds[k] + ' ' + k; }).join(', '));
  ok(lengthOff === 0, 'every loop\'s frame count equals the chunk maths redone in JS' + (lengthOff ? ' (' + lengthOff + ' differ)' : ''));
  var std = facts.filter(function (i) { return !i.usesMod; }).length;
  var covers = facts.filter(function (i) { return i.lastEventBar !== null && i.loopStartBar === 0 && i.loopEndBar >= i.lastEventBar; }).length;
  var drumless = facts.filter(function (i) { return i.drums.length === 0; }).length;
  console.log('    ' + std + ' on the standard kit, ' + (facts.length - std) + ' name a mod; ' + drumless + ' play no drum machine; the loop covers the whole song in ' + covers);

  // the songs compared: spread over the sorted list, so every folder and format is drawn from
  var count = Math.max(1, parseInt(process.env.RB_COUNT || '24', 10));
  var usable = facts.filter(function (i) { return i.frames > 0; });
  var picked = [];
  for (var k = 0; k < count && k < usable.length; k++) picked.push(usable[Math.floor(k * usable.length / Math.min(count, usable.length))]);

  var kit = null, key = null;
  if (kitPath) {
    kit = new Uint8Array(fs.readFileSync(kitPath));
    if (keyPath) key = new Uint8Array(fs.readFileSync(keyPath));
  } else {
    skip('RB_KIT is not set: drum machines are silent in what follows, and the native comparison is not run');
  }

  if (orb) {
    // facts against upstream's own reader
    var infoOff = [];
    picked.forEach(function (i) {
      var j;
      try { j = JSON.parse(child.execFileSync(orb, ['info', '--json', i.file], { encoding: 'utf8' })); } catch (e) { infoOff.push(path.basename(i.file) + ': orb info failed'); return; }
      var mine = [i.rb1x ? 'rb1x' : 'rbs', i.version, i.title, i.text, i.webPage, i.copyright, i.modName, i.modWww, i.modFtp, i.bpm, i.shuffle,
        i.songMode ? 'song' : 'pattern', i.looping, i.loopStartBar, i.loopBars, i.vintage ? 'vintage' : 'rebirth2', i.lastEventBar, i.lastEventTick];
      var theirs = [j.format, j.version, j.title, j.text, j.web_page, j.copyright, j.mod_name, j.mod_web, j.mod_ftp, j.tempo_bpm, j.shuffle,
        j.mode, j.loop_on, j.loop_start_bar, j.loop_bars, j.synth_sound, j.last_event_bar, j.last_event_tick];
      for (var q = 0; q < mine.length; q++) if (mine[q] !== theirs[q]) { infoOff.push(path.basename(i.file) + ' field ' + q + ': ' + JSON.stringify(mine[q]) + ' vs ' + JSON.stringify(theirs[q])); break; }
    });
    ok(infoOff.length === 0, 'info: 18 fields equal to `orb info --json` on ' + picked.length + ' songs' + (infoOff.length ? ' (' + infoOff.slice(0, 3).join('; ') + ')' : ''));
  } else {
    skip('RB_ORB is not set: facts and audio were not compared with the native orb');
  }

  // a .rbm kit and the clear kit made from it
  var kitOpts = { kit: kit, key: key };
  if (kit && key && kit[0] === 0x43) {
    var clear = ASRebirth.clearKit(kit, key);
    var drummer = picked.filter(function (i) { return i.drums.length; })[0];
    if (drummer) {
      var bytes = fs.readFileSync(drummer.file);
      var r1 = ASRebirth.render(bytes, { kit: kit, key: key, maxSeconds: 20 });
      var r2 = ASRebirth.render(bytes, { kit: clear, maxSeconds: 20 });
      var r3 = ASRebirth.render(bytes, { maxSeconds: 20 });
      ok(r1.kitUsed && r2.kitUsed && sameAudio(r1, r2), 'the .rbm kit (' + kit.length + ' bytes) and its clear kit (' + clear.length + ' bytes, samples only) render the same');
      ok(r3.drumsSilent && !r3.kitUsed && !sameAudio(r1, r3) && r3.channels[0].length === r1.channels[0].length,
        'without a kit the same song renders at the same length with its drum machines silent (peak ' + r3.peak.toFixed(3) + ' against ' + r1.peak.toFixed(3) + ')');
    }
    var noKey = '';
    try { ASRebirth.render(fs.readFileSync(picked[0].file), { kit: kit, maxSeconds: 1 }); } catch (e) { noKey = e.message; }
    ok(/no key/.test(noKey), 'a .rbm without the key is refused: ' + noKey.slice(0, 80));
  } else if (kit) {
    skip('RB_KIT is a clear kit (or RB_KEY is not set): the .rbm path was not run');
  }

  // determinism, and wasm against native
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-rebirth-'));
  var exact = 0, compared = 0, worst = 0, twice = 0, lengthBad = 0, seconds = 0, spent = 0, notes = [];
  picked.forEach(function (i, n) {
    var bytes = fs.readFileSync(i.file);
    // a long loop is compared on its first 48 bars
    var long = i.duration > 300 || i.truncated;
    var range = long ? [i.loopStartBar, Math.min(i.loopStartBar + 48, 1000)] : null;
    // one in six of the short ones through --range as well, so that path is native-checked
    if (!long && n % 6 === 5 && i.loopBars > 2) range = [i.loopStartBar + 1, i.loopEndBar];
    var opts = { kit: kit, key: key, range: range || 'loop', maxSeconds: 3600 };
    var t0 = Date.now();
    var a = ASRebirth.render(bytes, opts);
    spent += Date.now() - t0;
    seconds += a.duration + 9088 * 64 / 44100;   // the idle blocks are rendered too
    var want = range ? exportFrames(i.tempo, range[0] * 768, range[1] * 768) : exportFrames(i.tempo, i.loopStartTick, i.loopEndTick);
    if (a.channels[0].length !== want) lengthBad++;
    if (n < 6) { if (sameAudio(a, ASRebirth.render(bytes, opts))) twice++; }
    if (!orb || !kit) return;
    var out = path.join(tmp, 'n' + n + '.wav');
    var args = ['render', i.file, '-o', out, '--standard-kit'];
    if (range) args.push('--range', range[0] + ':' + range[1]);
    try { child.execFileSync(orb, args, { stdio: ['ignore', 'ignore', 'pipe'], env: Object.assign({}, process.env, { ORB_MOD_DIR: '' }) }); }
    catch (e) { notes.push(path.basename(i.file) + ': orb render failed: ' + String(e.stderr || e.message).trim().split('\n').pop()); return; }
    var pcm = wavPcm(out);
    fs.unlinkSync(out);
    if (!pcm) { notes.push(path.basename(i.file) + ': unreadable WAV'); return; }
    var d = diffPcm(a, pcm);
    compared++;
    if (d.frames === a.channels[0].length && d.max === 0) exact++;
    else notes.push(path.basename(i.file) + ': ' + a.channels[0].length + ' frames against ' + d.frames + ', largest difference ' + d.max + ' of 32768');
    if (d.max > worst) worst = d.max;
  });
  try { fs.rmdirSync(tmp); } catch (e) { /* a failed render left a file: leave it for looking at */ }

  ok(lengthBad === 0, 'render length equals the chunk maths on ' + picked.length + ' songs');
  ok(twice === Math.min(6, picked.length), 'two renders of the same song are identical (' + twice + ' songs)');
  console.log('    rendered ' + seconds.toFixed(0) + ' s of sound in ' + (spent / 1000).toFixed(1) + ' s: ' + (seconds / (spent / 1000)).toFixed(1) + 'x real time in Node');
  if (orb && kit) {
    ok(compared >= Math.min(20, picked.length), compared + ' songs rendered by the native orb for comparison');
    ok(exact === compared && compared > 0, 'wasm equals native `orb render` sample for sample on ' + exact + ' of ' + compared + ' songs' +
      (exact === compared ? '' : ' (largest difference ' + worst + ' of 32768; ' + notes.slice(0, 4).join('; ') + ')'));
  } else if (orb) {
    skip('the native comparison needs RB_KIT too');
  }

  // damaged real songs: one RBS 4.x and one 1.x
  slowest = 0;
  var rbs = facts.filter(function (i) { return !i.rb1x; })[0], old = facts.filter(function (i) { return i.rb1x; })[0];
  if (rbs) sweep(new Uint8Array(fs.readFileSync(rbs.file)), 'a real RBS ' + rbs.version + ' song (' + path.basename(rbs.file) + ')', 300, 2);
  if (old) sweep(new Uint8Array(fs.readFileSync(old.file)), 'a real ReBirth 1.x song (' + path.basename(old.file) + ')', 300, 3);
  ok(slowest < 20000, 'none of them hung: the slowest took ' + slowest + ' ms');
}

ASRebirth.load(WASM).then(function () {
  always();
  withSongs();
  if (failed) { console.log('\n' + failed + ' failed'); process.exit(1); }
  console.log('\ncheck-rebirth: all passed');
}).catch(function (e) {
  console.log('FAIL ' + (e && e.stack || e));
  process.exit(1);
});
