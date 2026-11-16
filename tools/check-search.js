#!/usr/bin/env node
// Pins the "type what you want" box (js/tool-search.js) to real phrasings.
// Each query must put its tool first; a few allow a top-3 hit, marked `top3`.
// Add a line whenever someone's phrasing found the wrong tool.
'use strict';
const G = require('../js/tool-graph.js');
const S = require('../js/tool-search.js');

const CASES = [
  ['m4a to mp3', 'm4a-to-mp3'],
  ['convert m4a to mp3', 'm4a-to-mp3'],
  ['wav 2 mp3', 'wav-to-mp3'],
  ['mp4 to mp3', 'mp4-to-mp3'],
  ['video to mp3', 'mp4-to-mp3'],
  ['flac to wav', 'flac-to-wav'],
  ['m4a → wav', 'index'],
  ['ogg to flac', 'index'],
  ['whatsapp voice note', 'opus-to-mp3'],
  ['remove vocals', 'stem-splitter', 'top3'],
  ['karaoke', 'vocal-remover', 'top3'],
  ['acapella', 'stem-splitter'],
  ['isolate vocals from a song', 'stem-splitter'],
  ['transcribe audio', 'audio-to-text'],
  ['audio to text', 'audio-to-text'],
  ['speech to text', 'audio-to-text', 'top3'],
  ['make it louder', 'amplify-audio'],
  ['make my voice memo louder', 'amplify-audio'],
  ['increase volume', 'amplify-audio'],
  ['remove background noise', 'noise-reduction'],
  ['remove hiss', 'noise-reduction'],
  ['cut audio', 'audio-cutter'],
  ['trim mp3', 'audio-cutter'],
  ['merge mp3 files', 'audio-joiner'],
  ['combine songs', 'audio-joiner'],
  ['speed up audio', 'audio-speed', 'top3'],
  ['slow down a song', 'audio-speed', 'top3'],
  ['slowed and reverb', 'slowed-reverb'],
  ['change pitch', 'pitch-shifter'],
  ['change key of song', 'pitch-shifter'],
  ['find bpm', 'bpm-finder'],
  ['what key is this song', 'key-finder'],
  ['chords of a song', 'chord-finder'],
  ['sheet music from audio', 'audio-to-sheet-music'],
  ['record my voice', 'voice-recorder'],
  ['record computer sound', 'record-computer-audio'],
  ['text to speech', 'text-to-speech'],
  ['read text aloud', 'text-to-speech'],
  ['add subtitles to video', 'add-subtitles-to-video'],
  ['auto captions', 'add-subtitles-to-video'],
  ['add music to video', 'add-audio-to-video'],
  ['put mp3 on youtube', 'mp3-to-mp4'],
  ['make a ringtone', 'ringtone-maker'],
  ['iphone ringtone', 'ringtone-maker'],
  ['edit mp3 tags', 'mp3-tag-editor'],
  ['reduce file size', 'audio-compressor'],
  ['make audio file smaller', 'audio-compressor'],
  ['bleep swear words', 'censor-audio'],
  ['remove ums', 'remove-filler-words'],
  ['split long recording', 'split-audio'],
  ['audio out of sync', 'fix-audio-sync'],
  ['test my microphone', 'mic-test'],
  ['tune guitar', 'tuner'],
  ['bass boost', 'audio-eq'],
  ['autotune my voice', 'autotune'],
  ['translate video', 'video-dubbing'],
  ['8d audio', '8d-audio'],
  ['nightcore', 'nightcore'],
  ['reverse audio', 'audio-reverser'],
  ['extract audio from webm', 'extract-audio'],
  ['remove silence', 'silence-remover', 'top3'],
  ['multitrack editor', 'audio-editor'],
  ['make voice sound better', 'enhance-speech'],
  ['lyrics', 'lyrics-from-song']
];

let bad = 0;
for (const [q, want, mode] of CASES) {
  const r = S.search(q, G, 6).map((x) => x.slug);
  const ok = mode === 'top3' ? r.slice(0, 3).includes(want) : r[0] === want;
  if (!ok) { bad++; console.log(`  FAIL  "${q}" -> ${r.slice(0, 3).join(', ') || '(nothing)'}; want ${want}`); }
}
console.log(bad ? `check-search: ${bad} of ${CASES.length} failed` : `check-search: all ${CASES.length} phrasings find their tool`);
process.exit(bad ? 1 : 0);
