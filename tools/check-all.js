#!/usr/bin/env node
/*
 * Runs every generator in --check mode.
 *
 * The generated blocks drift silently: two categories rendered a literal
 * "undefined" paragraph on /tools for months because nothing compared the
 * output to the source. This is the guard. Run it before every commit.
 *
 * check-includes.js is not a generator but belongs to the same class of silent
 * drift: a hand-assembled <script> list that is missing a file, or has one in
 * the wrong order, breaks a tool with nothing visible on the page.
 *
 * check-fx.js renders every audio-editor effect in headless Chrome, which
 * takes about twenty seconds. check-project-link.js drives an editor -> tool ->
 * editor round trip through the real pages, about fifteen more. check-fidelity.js
 * measures the decode/encode/resample layer and drives thirty tool pages with a
 * 96 kHz / 24-bit file, about a minute. check-record-computer.js records a real
 * tab through /record-computer-audio, about fifteen seconds. check-errors.js
 * pins the convert_error buckets and drives the failures behind them (0-byte,
 * unreadable and ffmpeg-only files, refused microphones). check-voice.js
 * holds the voice changer's pitch and formant claims in Node. check-tts.js
 * tests the text-to-speech engine in Node and, when the Kokoro files are in
 * ~/.cache/audiosaw/kokoro (TTS_DOWNLOAD=1 fetches them once, 420 MB), the
 * page on both backends. check-audiobook.js parses books (text, EPUB) in
 * Node and, with those files and the ffmpeg core cached, makes an M4B and
 * reads its chapters back with ffprobe. check-dictation.js holds the
 * phrase splitter behind /dictation (DICTATION_BROWSER=1 adds the page with
 * a spoken sentence through Whisper). All of them skip their browser parts on a machine
 * without Chrome.
 */
const { execFileSync } = require('child_process');
const path = require('path');

const CHECKS = [
  ['build-nav.js', '--check'],
  ['build-faq.js', '--check'],
  ['build-dates.js', '--check'],
  ['build-sitemap.js', '--check'],
  ['build-llms.js', '--check'],
  ['check-includes.js'],
  ['check-srt.js'],
  ['check-model-fetch.js'],
  ['check-editor.js'],
  ['check-key.js'],
  ['check-chords.js'],
  ['check-slicer.js'],
  ['check-beat.js'],
  ['check-pitch.js'],
  ['check-fx.js'],
  ['check-project-link.js'],
  ['check-grid.js'],
  ['check-midi.js'],
  ['check-midi-track.js'],
  ['check-record-computer.js'],
  ['check-fidelity.js'],
  ['check-errors.js'],
  ['check-consent.js'],
  ['check-add-audio-video.js'],
  ['check-voice.js'],
  ['check-tts.js'],
  ['check-audiobook.js'],
  ['check-dictation.js'],
  ['check-translate.js'],
  ['check-dubbing.js'],
  ['check-clone.js'],
  ['check-diarize.js'],
  ['check-editor-speech.js'],
  ['check-subtitles.js'],
  ['check-video-tools.js'],
  ['check-denoise.js'],
  ['check-enhance.js']
];

let failed = 0;
for (const [script, ...args] of CHECKS) {
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, script), ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    });
    process.stdout.write(out);
  } catch (e) {
    failed++;
    process.stdout.write(e.stdout || '');
    process.stderr.write(e.stderr || `${script} failed\n`);
  }
}
if (failed) {
  console.error(`\ncheck-all: ${failed} check(s) failed.`);
  process.exit(1);
}
console.log('\ncheck-all: all generated files are current and every page has its scripts.');
