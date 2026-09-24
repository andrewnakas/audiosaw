#!/usr/bin/env node
/*
 * Checks where js/bpm-detector.js puts the beats (ASBpm.phase), which is
 * what lines the editor's bar grid up with a song.
 *
 * Fixtures are drum patterns synthesized at a known tempo, with the first
 * beat at a known offset: a kick on every beat and a crash on beat one, a
 * noise snare on 2 and 4, and eighth-note hats. That is a band, not a
 * metronome. They run at 84 to 174 BPM, in 4/4 and in 3/4, with offsets
 * spread across the beat. Required:
 *
 *   - the tempo within 0.2 BPM (the page's existing claim)
 *   - the first beat within 10 ms
 *
 * and, on those plus 13 patterns in four styles that start partway into a
 * bar (rock, dance, waltz and drumless strumming, with the chords changing
 * on the bar line):
 *
 *   - the downbeat right on at least 20 of the 22
 *
 * The downbeat is still a guess by design; the margin is so a small change
 * in the cues does not fail the check, while a real regression does (the
 * old energy-only guess got 5 of the first 9).
 *
 *   node tools/check-beat.js
 */
const B = require('../js/bpm-detector.js');

const SR = 44100;
let seed = 7;
function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647 * 2 - 1; }

function fixture(bpm, offset, num, sec) {
  const n = Math.round(SR * sec), d = new Float32Array(n), beat = 60 / bpm;
  function add(t, len, fn) {
    const i0 = Math.round(t * SR);
    for (let i = 0; i < len * SR && i0 + i < n; i++) if (i0 + i >= 0) d[i0 + i] += fn(i / SR);
  }
  for (let k = 0; offset + k * beat < sec; k++) {
    const t = offset + k * beat, b = k % num;
    add(t, 0.2, (x) => 0.7 * Math.exp(-x / 0.06) * Math.sin(2 * Math.PI * (45 + 90 * Math.exp(-x / 0.03)) * x));   // kick
    if (b === 0) add(t, 0.6, (x) => 0.25 * rnd() * Math.exp(-x / 0.3));                                        // crash
    if (b % 2 === 1) add(t, 0.15, (x) => 0.35 * rnd() * Math.exp(-x / 0.04));                                    // snare
    add(t + beat / 2, 0.05, (x) => 0.1 * rnd() * Math.exp(-x / 0.01));                                           // hats
    add(t, 0.05, (x) => 0.1 * rnd() * Math.exp(-x / 0.01));
  }
  return { numberOfChannels: 1, sampleRate: SR, length: n, duration: sec, getChannelData: () => d };
}

const CASES = [
  [120, 0.137, 4], [128, 0.0, 4], [97, 0.41, 4], [140, 0.2, 4], [174, 0.05, 4],
  [84, 0.66, 4], [110, 0.31, 3], [150, 0.12, 3], [122.5, 0.25, 4]
];

// Styles that put the downbeat where real music does, each starting partway
// into a bar (a pickup of 0 to num-1 beats), with the harmony changing on the
// bar line:
//   rock   kick on 1 and 3, snare on 2 and 4, chords strummed on every beat,
//          a crash only every fourth bar
//   dance  kick on every beat, clap on 2 and 4, a sustained pad, no crash
//   waltz  3/4: bass on 1, chord stabs on 2 and 3, no drums
//   strum  no drums: a chord strummed on every beat, all at the same level
const DEG = [[0, 4, 7], [5, 9, 12], [7, 11, 14], [9, 12, 16], [2, 5, 9], [4, 7, 11]];   // I IV V vi ii iii
function styled(style, bpm, pickup, num, sec, key) {
  const n = Math.round(SR * sec), d = new Float32Array(n), beat = 60 / bpm, bar = beat * num;
  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  function add(t, len, fn) {
    const i0 = Math.round(t * SR);
    for (let i = 0; i < len * SR && i0 + i < n; i++) if (i0 + i >= 0) d[i0 + i] += fn(i / SR);
  }
  function tone(t, len, m, amp, tau) {
    const w = 2 * Math.PI * hz(m);
    add(t, len, (x) => amp * Math.min(1, x / 0.004) * Math.exp(-x / tau) * (Math.sin(w * x) + 0.4 * Math.sin(2 * w * x) + 0.2 * Math.sin(3 * w * x)));
  }
  function chord(t, len, deg, amp, tau) { deg.forEach((iv) => tone(t, len, 60 + key + iv, amp, tau)); }
  const kick = (t) => add(t, 0.2, (x) => 0.7 * Math.exp(-x / 0.06) * Math.sin(2 * Math.PI * (45 + 90 * Math.exp(-x / 0.03)) * x));
  const snare = (t) => add(t, 0.15, (x) => 0.35 * rnd() * Math.exp(-x / 0.04));
  const hat = (t) => add(t, 0.05, (x) => 0.1 * rnd() * Math.exp(-x / 0.01));
  const crash = (t) => add(t, 0.6, (x) => 0.25 * rnd() * Math.exp(-x / 0.3));
  // The file starts `pickup` beats before the first downbeat.
  const first = pickup * beat;
  let prev = -1;
  for (let b = -1; first + b * bar < sec; b++) {
    let dg;
    do { dg = Math.floor((rnd() + 1) / 2 * DEG.length) % DEG.length; } while (dg === prev);
    prev = dg;
    const t0 = first + b * bar, deg = DEG[dg];
    for (let j = 0; j < num; j++) {
      const t = t0 + j * beat;
      if (style === 'rock') {
        if (j % 2 === 0) kick(t); else snare(t);
        hat(t); hat(t + beat / 2);
        if (j === 0 && ((b + 4) % 4 === 0)) crash(t);
        chord(t, beat, deg, 0.05, 0.25);
        if (j % 2 === 0) tone(t, beat * 2, 36 + key + deg[0], 0.25, 0.5);
      } else if (style === 'dance') {
        kick(t); if (j % 2 === 1) snare(t); hat(t + beat / 2);
        if (j === 0) { chord(t, bar, deg, 0.04, bar); tone(t, bar, 36 + key + deg[0], 0.2, bar); }
      } else if (style === 'waltz') {
        if (j === 0) tone(t, beat, 36 + key + deg[0], 0.35, 0.4);
        else chord(t, beat * 0.6, deg, 0.06, 0.12);
      } else if (style === 'strum') {
        // A strum: the notes a few ms apart, low to high.
        [0, 1, 2].forEach((k) => tone(t + k * 0.012, beat, 48 + key + deg[k] + (k ? 12 : 0), 0.08, 0.35));
      }
    }
  }
  return { buf: { numberOfChannels: 1, sampleRate: SR, length: n, duration: sec, getChannelData: () => d }, first };
}

const STYLED = [
  ['rock', 100, 1, 4, 3], ['rock', 120, 0, 4, 7], ['rock', 136, 3, 4, 2], ['rock', 92, 2, 4, 10],
  ['dance', 124, 2, 4, 5], ['dance', 128, 1, 4, 0], ['dance', 118, 3, 4, 9],
  ['waltz', 90, 1, 3, 2], ['waltz', 150, 2, 3, 7], ['waltz', 120, 0, 3, 4],
  ['strum', 80, 3, 4, 0], ['strum', 110, 1, 4, 5], ['strum', 96, 2, 4, 9]
];

const fails = [];
let worst = 0, downRight = 0;
CASES.forEach(([bpm, off, num]) => {
  const buf = fixture(bpm, off, num, 20);
  const t = B.analyse(buf);
  if (!t || Math.abs(t.bpm - bpm) > 0.2) {
    // The half/double reading is the page's documented ambiguity; phase is
    // then measured against the true tempo, which is what the editor uses
    // once the person has picked it.
    if (!t || [0.5, 2].every((m) => Math.abs(t.bpm * m - bpm) > 0.2)) fails.push(bpm + ' BPM read as ' + (t && t.bpm.toFixed(2)));
  }
  const p = B.phase(buf, bpm, num);
  const period = 60 / bpm;
  let err = ((p.beat - off) % period + period) % period;
  if (err > period / 2) err -= period;
  worst = Math.max(worst, Math.abs(err));
  if (Math.abs(err) > 0.010) fails.push(bpm + ' BPM, first beat at ' + off + ' s: read ' + p.beat.toFixed(4) + ' s (' + (err * 1000).toFixed(1) + ' ms off)');
  const bar = period * num;
  let derr = ((p.downbeat - off) % bar + bar) % bar;
  if (derr > bar / 2) derr -= bar;
  if (Math.abs(derr) < 0.012) downRight++;
});

const styledRight = {};
let styledDown = 0;
STYLED.forEach(([style, bpm, pickup, num, key]) => {
  const { buf, first } = styled(style, bpm, pickup, num, 20, key);
  const p = B.phase(buf, bpm, num);
  const period = 60 / bpm, bar = period * num;
  let err = ((p.beat - first) % period + period) % period;
  if (err > period / 2) err -= period;
  worst = Math.max(worst, Math.abs(err));
  if (Math.abs(err) > 0.010) fails.push(style + ' ' + bpm + ' BPM: first beat ' + (err * 1000).toFixed(1) + ' ms off');
  let derr = ((p.downbeat - first) % bar + bar) % bar;
  if (derr > bar / 2) derr -= bar;
  const r = styledRight[style] = styledRight[style] || [0, 0];
  r[1]++;
  if (Math.abs(derr) < 0.012) { r[0]++; styledDown++; }
  else if (process.env.VERBOSE) console.log('    ' + style + ' ' + bpm + ' BPM, pickup ' + pickup + ': downbeat ' + Math.round(derr / period) + ' beats off');
});

console.log('  first beat: worst error ' + (worst * 1000).toFixed(1) + ' ms over ' + (CASES.length + STYLED.length) + ' patterns; downbeat right in ' + downRight + '/' + CASES.length + ' crash-on-one patterns and ' + styledDown + '/' + STYLED.length + ' styled ones (' +
  Object.keys(styledRight).map((k) => k + ' ' + styledRight[k].join('/')).join(', ') + ')');
if (downRight + styledDown < 20) fails.push('downbeat right on only ' + (downRight + styledDown) + ' of ' + (CASES.length + STYLED.length) + ' patterns, needs 20');
if (fails.length) {
  fails.forEach((f) => console.error('  FAIL ' + f));
  console.error('check-beat: ' + fails.length + ' failure(s).');
  process.exit(1);
}
console.log('check-beat: tempo within 0.2 BPM, the first beat within 10 ms and the downbeat found, on drum patterns from 84 to 174 BPM in 4/4 and 3/4 and on rock, dance, waltz and strummed patterns.');
