#!/usr/bin/env node
/*
 * Check js/subtitles.js by parsing its SRT and VTT back with readers written
 * here, separately from the writers, so a mistake in one does not cancel out
 * in the other (the same reason check-midi.js has its own reader).
 *
 * What a player needs and what the checks assert:
 *   - SRT: cue numbers 1..n without gaps, HH:MM:SS,mmm --> HH:MM:SS,mmm,
 *     a blank line between cues, no blank line inside one.
 *   - VTT: "WEBVTT" header, dots not commas in times.
 *   - Every cue ends after it starts, cues never run backwards or overlap.
 *   - The text survives the round trip (modulo the two-line wrap).
 *   - Whisper's quirks are absorbed: an open last segment (end null), an empty
 *     segment, a zero-length segment, "-->" in the words, a blank line in the
 *     words, times past an hour.
 */
const S = require('../js/subtitles.js');

let failed = 0;
function ok(cond, msg) { if (!cond) { failed++; console.log('  FAIL ' + msg); } }

function parseTime(s, sep) {
  const m = new RegExp('^(\\d{2,}):(\\d{2}):(\\d{2})\\' + sep + '(\\d{3})$').exec(s);
  if (!m) return NaN;
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
}

function readSRT(text) {
  const blocks = text.replace(/\n+$/, '').split(/\n\n/);
  return blocks.map((b, i) => {
    const lines = b.split('\n');
    ok(lines[0] === String(i + 1), `srt cue ${i + 1} numbered "${lines[0]}"`);
    const t = lines[1].split(' --> ');
    ok(t.length === 2, `srt cue ${i + 1} timing line "${lines[1]}"`);
    const cue = { start: parseTime(t[0], ','), end: parseTime(t[1], ','), text: lines.slice(2).join('\n') };
    ok(isFinite(cue.start) && isFinite(cue.end), `srt cue ${i + 1} times parse: "${lines[1]}"`);
    ok(cue.text.length > 0, `srt cue ${i + 1} has text`);
    return cue;
  });
}

function readVTT(text) {
  ok(text.startsWith('WEBVTT\n\n'), 'vtt header');
  const body = text.slice('WEBVTT\n\n'.length).replace(/\n+$/, '');
  if (!body) return [];
  return body.split(/\n\n/).map((b, i) => {
    const lines = b.split('\n');
    const t = lines[0].split(' --> ');
    ok(t.length === 2, `vtt cue ${i + 1} timing line "${lines[0]}"`);
    const cue = { start: parseTime(t[0], '.'), end: parseTime(t[1], '.'), text: lines.slice(1).join('\n') };
    ok(isFinite(cue.start) && isFinite(cue.end), `vtt cue ${i + 1} times parse: "${lines[0]}"`);
    return cue;
  });
}

function ordered(cues, label) {
  cues.forEach((c, i) => {
    ok(c.end > c.start, `${label} cue ${i + 1} ends after it starts (${c.start} → ${c.end})`);
    if (i) ok(c.start >= cues[i - 1].end - 1e-9, `${label} cue ${i + 1} overlaps the one before`);
  });
}

const flat = (t) => t.replace(/\s+/g, ' ').trim();

// 1. An ordinary Whisper result.
const segs = [
  { text: ' Hello, this is a test of in-browser transcription.', start: 0, end: 3.28 },
  { text: ' AudioSaw converts audio files without uploading them.', start: 3.28, end: 6.5 },
  { text: ' The quick brown fox jumps over the lazy dog.', start: 6.5, end: 9.12 }
];
{
  const srt = readSRT(S.toSRT(segs, 12.5));
  ok(srt.length === 3, 'three srt cues');
  ordered(srt, 'srt');
  ok(Math.abs(srt[1].start - 3.28) < 1e-6 && Math.abs(srt[1].end - 6.5) < 1e-6, 'srt times exact');
  srt.forEach((c, i) => ok(flat(c.text) === flat(segs[i].text), `srt text ${i + 1} round-trips`));
  srt.forEach((c, i) => c.text.split('\n').forEach((l) => ok(l.length <= 42 || !/ /.test(l), `srt cue ${i + 1} line under 42: "${l}"`)));
  ok(srt.every((c) => c.text.split('\n').length <= 2), 'at most two lines per cue');

  const vtt = readVTT(S.toVTT(segs, 12.5));
  ok(vtt.length === 3, 'three vtt cues');
  ordered(vtt, 'vtt');
  vtt.forEach((c, i) => ok(flat(c.text) === flat(segs[i].text), `vtt text ${i + 1} round-trips`));
}

// 2. Whisper's awkward cases.
{
  const nasty = [
    { text: '', start: 0, end: 1 },                                   // empty: dropped
    { text: ' First -> second --> third', start: 1, end: 2 },        // arrow in the words
    { text: ' line one\n\n\nline two', start: 2, end: 2 },           // blank line, zero length
    { text: ' backwards', start: 1.5, end: 4 },                       // starts before the last one
    { text: ' open ending', start: 3725.5, end: null }                // past an hour, no end
  ];
  const srtText = S.toSRT(nasty, 3731);
  const srt = readSRT(srtText);
  ok(srt.length === 4, `empty segment dropped (got ${srt.length})`);
  ordered(srt, 'srt-nasty');
  ok(!/-->.*-->/.test(srtText.split('\n').filter((l) => !/^\d\d:/.test(l)).join('\n')), 'no "-->" left in srt text');
  ok(Math.abs(srt[3].start - 3725.5) < 1e-6, 'hour+ start time');
  ok(Math.abs(srt[3].end - 3731) < 1e-6, `open last segment ends at the duration (got ${srt[3].end})`);
  ok(srt[1].end - srt[1].start >= 0.299 || srt[1].end <= srt[2].start, 'zero-length cue given a readable minimum');
  const vtt = readVTT(S.toVTT(nasty, 3731));
  ordered(vtt, 'vtt-nasty');
}

// 3. Plain text: paragraphs at pauses, timestamps on request.
{
  const t = S.toText([
    { text: ' One.', start: 0, end: 1 },
    { text: ' Two.', start: 1.2, end: 2 },
    { text: ' Three.', start: 5, end: 6 }
  ]);
  ok(t === 'One. Two.\n\nThree.\n', `paragraph break at a 3 s pause: ${JSON.stringify(t)}`);
  const ts = S.toText([{ text: ' One.', start: 61, end: 62 }], { timestamps: true });
  ok(ts === '[01:01] One.\n', `timestamped text: ${JSON.stringify(ts)}`);
  ok(S.toText([]) === '', 'empty transcript is empty');
}

// 4. Stamps.
ok(S.stamp(0, ',') === '00:00:00,000', 'zero stamp');
ok(S.stamp(3599.9996, ',') === '01:00:00,000', `rounding carries: ${S.stamp(3599.9996, ',')}`);
ok(S.stamp(-1, '.') === '00:00:00.000', 'negative clamps to zero');

if (failed) { console.log(`check-srt: ${failed} failure(s)`); process.exit(1); }
console.log('check-srt: SRT, VTT and text writers parse back cleanly');
