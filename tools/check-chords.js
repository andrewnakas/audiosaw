#!/usr/bin/env node
/*
 * Checks ASKey.chords (js/key-detect.js) against synthesized progressions
 * with known chord boundaries.
 *
 * 36 progressions of eight chords. The chords are drawn at random from all 24
 * major and minor triads, lasting 1, 1.5 or 2 s each. They are voiced the
 * way a keyboard player would: a bass note on the root, the triad above it
 * in root position or an inversion, and harmonic tones with six partials.
 * Three versions:
 *
 *   clean    as above
 *   band     plus kick, snare and hats, and a noise floor 30 dB down
 *   melody   plus a melody line that mixes chord tones with passing notes
 *            from the chord's own scale, a quarter of a beat each
 *
 * and two more sets for sevenths and slash chords (the third in the bass).
 *
 * Accuracy is the share of time labelled with the right chord, measured every
 * 50 ms, ignoring 0.25 s either side of each real change, since no detector
 * can know a chord has changed before the new one has sounded.
 * Required: at least 90% in each version. Printed: the actual figures, which
 * the /chord-finder page quotes.
 *
 *   node tools/check-chords.js
 */
const K = require('../js/key-detect.js');

const SR = 44100;
let seed = 11;
function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
function pick(a) { return a[Math.floor(rnd() * a.length)]; }

function tone(out, start, dur, midi, amp) {
  const hz = 440 * Math.pow(2, (midi - 69) / 12);
  const i0 = Math.round(start * SR), n = Math.min(Math.round(dur * SR), out.length - i0);
  const decay = Math.exp(-1 / (SR * Math.max(0.3, dur) * 0.8));
  for (let h = 1; h <= 6; h++) {
    if (hz * h > SR / 2 - 1000) break;
    const w = 2 * Math.PI * hz * h / SR, c2 = 2 * Math.cos(w);
    let y = 0, prev = -Math.sin(w), env = 1;
    for (let i = 0; i < n; i++) {
      out[i0 + i] += (amp / h) * Math.min(1, i / 300) * Math.min(1, (n - i) / 300) * env * y;
      const next = c2 * y - prev; prev = y; y = next;
      env *= decay;
    }
  }
}

function progression(variant) {
  const chords = [];
  let t = 0;
  for (let k = 0; k < 8; k++) {
    let c;
    do { c = { pc: Math.floor(rnd() * 12), q: rnd() < 0.5 ? 'maj' : 'min' }; }
    while (chords.length && chords[chords.length - 1].pc === c.pc && chords[chords.length - 1].q === c.q);
    c.t0 = t; c.dur = pick([1, 1.5, 2]); t += c.dur;
    chords.push(c);
  }
  const d = new Float32Array(Math.ceil(t * SR) + SR);
  chords.forEach((c) => {
    const third = c.q === 'maj' ? 4 : 3, triad = [0, third, 7];
    const inv = Math.floor(rnd() * 3), base = 60 + c.pc - (c.pc > 6 ? 12 : 0);   // root G3..F#4
    const notes = triad.map((iv, i) => base + iv + (i < inv ? 12 : 0));
    // Sevenths: a dominant 7 or a major 7 on major chords, a minor 7 on minor.
    c.ext = '';
    if (variant === 'sevenths') {
      const iv = c.q === 'maj' && rnd() < 0.5 ? 11 : 10;
      notes.push(base + iv);
      c.ext = iv === 11 ? 'maj7' : c.q === 'maj' ? '7' : 'm7';
    }
    // Slash chords put the third in the bass (C/E), which pulls a bass-heavy
    // chroma towards the wrong root.
    const bassPc = variant === 'slash' ? (c.pc + third) % 12 : c.pc;
    tone(d, c.t0, c.dur, 36 + bassPc + (bassPc > 7 ? 0 : 12), 0.22);          // bass, G#2..G3
    notes.forEach((m) => tone(d, c.t0, c.dur, m, 0.1));
    if (variant === 'melody') {
      const scale = c.q === 'maj' ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10];
      for (let s = 0; s < c.dur; s += 0.25) {
        const onBeat = Math.abs(s - Math.round(s * 2) / 2) < 1e-9 && Math.round(s * 2) % 2 === 0;
        const deg = onBeat ? pick([0, 2, 4]) : Math.floor(rnd() * 7);
        tone(d, c.t0 + s, 0.25, 72 + c.pc % 12 + scale[deg] - (c.pc > 5 ? 12 : 0), 0.08);
      }
    }
  });
  if (variant === 'band') {
    for (let b = 0; b * 0.5 < t; b++) {
      const i0 = Math.round(b * 0.5 * SR);
      for (let i = 0; i < SR * 0.15 && i0 + i < d.length; i++) { const x = i / SR; d[i0 + i] += 0.5 * Math.exp(-x / 0.05) * Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-x / 0.03)) * x); }
      if (b % 2) for (let i = 0; i < SR * 0.12 && i0 + i < d.length; i++) d[i0 + i] += 0.25 * (rnd() * 2 - 1) * Math.exp(-i / (SR * 0.04));
      const h0 = i0 + SR / 4;
      for (let i = 0; i < SR * 0.03 && h0 + i < d.length; i++) d[h0 + i] += 0.08 * (rnd() * 2 - 1) * Math.exp(-i / (SR * 0.008));
    }
    for (let i = 0; i < d.length; i++) d[i] += 0.01 * (rnd() * 2 - 1);
  }
  return { audio: d, chords, dur: t };
}

// The share of time with the right triad; with `full`, the right seventh too.
function accuracy(truth, got, dur, full) {
  let right = 0, total = 0;
  for (let t = 0.05; t < dur; t += 0.05) {
    if (truth.some((c) => Math.abs(t - c.t0) < 0.25) || Math.abs(t - dur) < 0.25) continue;
    const want = truth.filter((c) => t >= c.t0 && t < c.t0 + c.dur)[0];
    const have = got.filter((c) => t >= c.t0 && t < c.t1)[0];
    total++;
    if (have && want && have.quality === want.q && have.pc === want.pc && (!full || (have.ext || '') === want.ext)) right++;
  }
  return total ? right / total : 0;
}
// The share of named time given a seventh that is not there.
function falseSevenths(truth, got) {
  let bad = 0, named = 0;
  got.forEach((c) => {
    if (c.quality === 'N') return;
    named += c.t1 - c.t0;
    if (c.ext) bad += c.t1 - c.t0;
  });
  return { bad, named };
}

const fails = [], lines = [];
let fsBad = 0, fsNamed = 0, slashBad = 0, slashNamed = 0;
for (const variant of ['clean', 'band', 'melody']) {
  let sum = 0, worst = 1;
  for (let k = 0; k < 12; k++) {
    const p = progression(variant);
    const got = K.chords([p.audio], SR);
    const a = accuracy(p.chords, got, p.dur);
    sum += a; worst = Math.min(worst, a);
    const f = falseSevenths(p.chords, got); fsBad += f.bad; fsNamed += f.named;
    got.forEach((c) => { if (c.quality === 'N') return; slashNamed += c.t1 - c.t0; if (c.bass >= 0) slashBad += c.t1 - c.t0; });
  }
  const mean = sum / 12;
  lines.push(variant + ': ' + (mean * 100).toFixed(1) + '% of the time right (worst progression ' + (worst * 100).toFixed(1) + '%)');
  if (mean < 0.9) fails.push(variant + ' accuracy ' + (mean * 100).toFixed(1) + '%, needs 90%');
}
// Sevenths: the triad must still be right, and the seventh named.
{
  let tri = 0, full = 0;
  for (let k = 0; k < 12; k++) {
    const p = progression('sevenths'), got = K.chords([p.audio], SR);
    tri += accuracy(p.chords, got, p.dur); full += accuracy(p.chords, got, p.dur, true);
  }
  tri /= 12; full /= 12;
  lines.push('sevenths: the triad right ' + (tri * 100).toFixed(1) + '% of the time, the whole chord (C7, Cmaj7, Cm7) ' + (full * 100).toFixed(1) + '%');
  if (tri < 0.9) fails.push('sevenths: triad right only ' + (tri * 100).toFixed(1) + '%');
  if (full < 0.8) fails.push('sevenths: whole chord right only ' + (full * 100).toFixed(1) + '%, needs 80%');
  lines.push('triads given a seventh they do not have: ' + (fsBad / fsNamed * 100).toFixed(1) + '% of the named time');
  if (fsBad / fsNamed > 0.05) fails.push('plain triads named as sevenths ' + (fsBad / fsNamed * 100).toFixed(1) + '% of the time, allowed 5%');
}
// Slash chords: the third in the bass (C/E). A bass note's own overtones
// spell another chord (an E bass brings B and G#: E minor), which is what
// pulled these to 74% before the inversion check. Required: the chord right
// 90% of the time and the bass named with it (C/E) 80%; and on the plain
// sets, a slash named at most 5% of the time, since their bass is the root.
{
  let tri = 0, named = 0;
  for (let k = 0; k < 12; k++) {
    const p = progression('slash'), got = K.chords([p.audio], SR);
    tri += accuracy(p.chords, got, p.dur);
    let r = 0, n = 0;
    for (let t = 0.05; t < p.dur; t += 0.05) {
      if (p.chords.some((c) => Math.abs(t - c.t0) < 0.25) || Math.abs(t - p.dur) < 0.25) continue;
      const w = p.chords.filter((c) => t >= c.t0 && t < c.t0 + c.dur)[0], h = got.filter((c) => t >= c.t0 && t < c.t1)[0];
      n++;
      if (w && h && h.pc === w.pc && h.quality === w.q && h.bass === (w.pc + (w.q === 'maj' ? 4 : 3)) % 12) r++;
    }
    named += n ? r / n : 0;
  }
  tri /= 12; named /= 12;
  lines.push('slash: the chord right ' + (tri * 100).toFixed(1) + '% of the time, with its bass named (C/E) ' + (named * 100).toFixed(1) + '%');
  if (tri < 0.9) fails.push('slash chords right only ' + (tri * 100).toFixed(1) + '%, needs 90%');
  if (named < 0.8) fails.push('slash chords named with their bass only ' + (named * 100).toFixed(1) + '%, needs 80%');
  lines.push('plain triads named as slash chords: ' + (slashBad / slashNamed * 100).toFixed(1) + '% of the named time');
  if (slashBad / slashNamed > 0.05) fails.push('plain triads named as slash chords ' + (slashBad / slashNamed * 100).toFixed(1) + '% of the time, allowed 5%');
}

// Drums alone have no chord. A kick's falling pitch and a snare's noise can
// pass for one. Eight seeds, each with its own snare noise: a cap that held
// on one seed once hid 1.0-1.5 s of false chords on three others.
{
  let worstNamed = 0, worstNames = '';
  for (const sd of [11, 3, 101, 2024, 77777, 5, 99, 1234]) {
    let s2 = sd;
    const r2 = () => { s2 = (s2 * 16807) % 2147483647; return s2 / 2147483647; };
    const d = new Float32Array(SR * 8);
    for (let b = 0; b < 16; b++) {
      const i0 = Math.round(b * 0.5 * SR);
      for (let i = 0; i < SR * 0.15; i++) { const x = i / SR; d[i0 + i] += 0.6 * Math.exp(-x / 0.05) * Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-x / 0.03)) * x); }
      if (b % 2) for (let i = 0; i < SR * 0.12; i++) d[i0 + i] += 0.3 * (r2() * 2 - 1) * Math.exp(-i / (SR * 0.04));
    }
    const got = K.chords([d], SR), named = got.filter((c) => c.name !== 'N').reduce((a, c) => a + c.t1 - c.t0, 0);
    if (named > worstNamed) { worstNamed = named; worstNames = got.filter((c) => c.name !== 'N').map((c) => c.name).join(' '); }
  }
  if (worstNamed > 0.8) fails.push('drums alone were given ' + worstNamed.toFixed(1) + ' s of chords: ' + worstNames);
  lines.push('drums alone, 8 seeds: at most ' + worstNamed.toFixed(1) + ' s of 8 named as a chord');
}

// Beat-aligned segments: with beats given, changes land on beats.
{
  const p = progression('clean');
  const beats = [];
  for (let t = 0; t <= p.dur + 1e-9; t += 0.5) beats.push(t);
  const got = K.chords([p.audio], SR, { beats });
  const offGrid = got.filter((c) => Math.abs(c.t0 / 0.5 - Math.round(c.t0 / 0.5)) > 1e-6).length;
  if (offGrid) fails.push(offGrid + ' chord changes fell between beats when beats were given');
  lines.push('beat-aligned: ' + (accuracy(p.chords, got, p.dur) * 100).toFixed(1) + '% right, every change on a beat');
}

lines.forEach((l) => console.log('  ' + l));
if (fails.length) {
  fails.forEach((f) => console.error('  FAIL ' + f));
  console.error('check-chords: ' + fails.length + ' failure(s).');
  process.exit(1);
}
console.log('check-chords: major and minor triads read right at least 90% of the time, clean, over a band and under a melody; sevenths and inversions named, and seldom invented.');
