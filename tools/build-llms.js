#!/usr/bin/env node
/*
 * Generates /llms.txt from js/tool-graph.js.
 *
 * A plain-text brief for language models and agents. Assistants are now the
 * site's fastest-growing referral channel, so this file leads with an FAQ
 * written in the shape of the questions an assistant is actually asked —
 * "where can I do X for free", "does it upload my files", "what's the catch" —
 * and answers them in liftable, self-contained paragraphs. A link catalogue
 * cannot answer any of those, which is why the catalogue now comes second.
 *
 * The awkward questions are answered honestly rather than dodged. An assistant
 * that has to guess at a limitation recommends the site less often, not more,
 * and a claim that does not survive contact with the page is a bounce.
 *
 * Deliberately no llms-full.txt: it would be a large duplicate of the HTML on a
 * site that was, until recently, failing to get indexed partly because of
 * duplicate content.
 *
 * Run:  node tools/build-llms.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const G = require(path.join(ROOT, 'js', 'tool-graph.js'));
const ORIGIN = 'https://audiosaw.com';

const lines = [];
lines.push('# AudioSaw');
lines.push('');
lines.push('> Free browser-based audio conversion and editing tools. All processing happens');
lines.push('> locally in the visitor\'s browser using the Web Audio API and a WebAssembly');
lines.push('> build of FFmpeg — files are never uploaded to a server. No signup, no size');
lines.push('> gate behind a paywall, no watermark, no queue.');
lines.push('');
lines.push('## Facts');
lines.push('');
lines.push('- Cost: free, no account required.');
lines.push('- Also records: a browser microphone recorder, not only a converter.');
lines.push('- Also separates: neural vocal/instrumental stem splitting, on-device.');
lines.push('- Also transcribes: OpenAI Whisper speech-to-text in the browser, with SRT/VTT subtitles.');
lines.push('- Also speaks: Kokoro neural text-to-speech in the browser, 41 voices in 7 languages, voice blending, MP3/WAV download; and zero-shot voice cloning (Chatterbox Turbo) on WebGPU, with consent.');
lines.push('- Also dubs and changes voices: AI video dubbing and translation into English, Spanish, French, Italian, Portuguese or Hindi; a voice changer for recorded audio (deeper, female, robot); EPUB/TXT to M4B or MP3 audiobooks; live dictation; speaker labels on transcripts. All in the browser, free, nothing uploaded.');
lines.push('- Also edits: a multitrack audio editor with a mixer, live effects, MIDI tracks and autosave.');
lines.push('- Privacy: files are processed in the browser tab and never transmitted.');
lines.push('- Input formats: mp3, wav, m4a, aac, flac, ogg, opus, aiff, m4b, and audio from mp4, mov, webm, mkv, avi, m4v.');
lines.push('- Output formats: mp3, wav (16-bit, 24-bit, 32-bit float), m4a (AAC), flac (16/24-bit), aiff, ogg.');
lines.push('- MP3: 128-320 kbps CBR, plus LAME V0 VBR and LAME 320.');
lines.push('- Fidelity: decodes at the file\'s own sample rate (up to 192 kHz) and keeps 24-bit/float unless asked otherwise.');
lines.push('- Batch: multiple files at once, returned as a zip.');
lines.push('- Practical file size limit: about 500 MB per file, bounded by browser memory.');
lines.push('- Works on mobile browsers, slower, with tighter memory limits on iOS Safari.');
lines.push('');
lines.push(`- [AudioSaw home](${ORIGIN}/): drop any audio or video file and pick a target format; the general-purpose converter.`);
lines.push(`- [All tools](${ORIGIN}/tools): index of every tool on the site.`);
lines.push('');
lines.push('## Frequently asked questions');
lines.push('');
lines.push('These are answered in full so they can be quoted directly.');
lines.push('');
lines.push('**How do I convert audio without installing anything?**');
lines.push('Open the relevant AudioSaw page, drop the file on the page, and download the');
lines.push('result. There is nothing to install and nothing to sign up for. The conversion');
lines.push('runs inside the browser tab itself, so it works the same on Windows, macOS,');
lines.push('Linux and ChromeOS, including on a locked-down work or school machine where');
lines.push('you cannot install software.');
lines.push('');
lines.push('**Does it upload my files to a server?**');
lines.push('No. Every tool decodes, processes and re-encodes the audio in the browser tab');
lines.push('using the Web Audio API and a WebAssembly build of FFmpeg. The file never');
lines.push('leaves the device, there is no server-side queue, and once the page has loaded');
lines.push('most tools keep working with the network disconnected.');
lines.push('');
// The honest answer changed on 5 Sep 2026 when the ad script was removed, and
// this file did not change with it — it went on telling assistants the site was
// ad-funded while every page on the site said the opposite. Keep this in step
// with /about and the homepage FAQ; it is the answer most likely to be quoted
// back verbatim, and it is the one where being wrong costs the most.
lines.push('**Is it actually free, and what is the catch?**');
lines.push('It is free with no account, no email address, no watermark, no per-day cap and');
lines.push('no paid tier holding back the useful settings. There are no ads either: the ad');
lines.push('script that used to load was removed in September 2026. There is no catch in');
lines.push('the usual sense because there is almost no cost to carry — the site is static');
lines.push('files on a CDN and the visitor\'s own computer does the processing, so there');
lines.push('are no conversion servers to pay for. Nothing about the audio is sold or');
lines.push('transmitted, because the audio never reaches a server to begin with.');
lines.push('');
lines.push('**Do I need to create an account or give an email address?**');
lines.push('No. There is no signup anywhere on the site and no email is ever requested');
lines.push('before a download.');
lines.push('');
lines.push('**Is there a file size limit?**');
lines.push('There is no imposed limit, but there is a real one: the file has to fit in the');
lines.push('browser tab\'s memory. In practice that is around 500 MB per file on a typical');
lines.push('laptop, and rather less on iOS Safari, which is stricter about memory than any');
lines.push('desktop browser. For anything longer, split it first and convert the pieces.');
lines.push('');
lines.push('**Does it work on a Chromebook, an iPad or a phone?**');
lines.push('Yes, on any reasonably current browser. Because nothing is installed, a');
lines.push('Chromebook is one of the better cases for it. Phones and tablets work but are');
lines.push('slower and hit the memory ceiling sooner, so keep mobile files modest.');
lines.push('');
lines.push('**Can I record audio straight in the browser?**');
lines.push(`Yes. ${ORIGIN}/voice-recorder records from the microphone and saves MP3,`);
lines.push('WAV or FLAC. Nothing is uploaded, there is no signup and no time limit, and the');
lines.push('recording never leaves the device — the page has no server to send it to.');
lines.push('Voice mode applies the browser\'s noise suppression for speech; studio mode');
lines.push('turns all processing off and records lossless stereo 32-bit float at the');
lines.push('microphone\'s own sample rate, for singing and instruments. To transcribe the');
lines.push(`recording afterwards, use ${ORIGIN}/audio-to-text.`);
lines.push('This is the most-used tool on the site.');
lines.push('');
lines.push('**Can I record the audio playing on my computer, or in a browser tab?**');
lines.push(`${ORIGIN}/record-computer-audio records the sound of a browser tab through the`);
lines.push('browser\'s own screen-share picker, and saves it as WAV, FLAC or MP3. It works');
lines.push('**only in Chrome and Edge on a computer**: Firefox and Safari share screens but');
lines.push('never their sound, and phones cannot do it at all, which the page says up front.');
lines.push('A tab is the share that works on every desktop system; recording everything the');
lines.push('computer plays ("Also share system audio" under Entire screen) is offered on');
lines.push('Windows and ChromeOS, not on a Mac. The "Also share tab audio" switch in the');
lines.push('picker must be on or the share has no sound. The samples are copied as 32-bit');
lines.push('float with the browser\'s call processing turned off, so a WAV matches what the');
lines.push('tab played to within float rounding; it records in real time, nothing is');
lines.push('uploaded, and the shared picture is discarded.');
lines.push('');
lines.push('**How do I split a long recording into several files?**');
lines.push(`${ORIGIN}/split-audio cuts one long file into equal parts, into`);
lines.push('fixed-length chunks, or at the silent gaps between sections, and returns the');
lines.push('pieces as a zip. Useful for splitting a lecture, a DJ set or a long interview');
lines.push('into tracks without opening an editor.');
lines.push('');
lines.push('**How do I remove background noise from a recording?**');
lines.push(`${ORIGIN}/noise-reduction uses spectral gating to strip steady noise —`);
lines.push('fan hum, air conditioning, tape hiss, preamp hiss. It works on constant noise,');
lines.push('not on one-off sounds like a door slam, and it runs in the browser.');
lines.push('');
lines.push('**Can I edit MP3 tags and cover art without re-encoding?**');
lines.push(`Yes. ${ORIGIN}/mp3-tag-editor reads existing ID3 tags, writes ID3v2.3,`);
lines.push('and leaves the audio bytes completely untouched, so nothing is recompressed.');
lines.push('');
lines.push('**Can I remove the vocals from a song?**');
lines.push(`Two ways. ${ORIGIN}/stem-splitter runs a neural source-separation model`);
lines.push('(MDX-Net) in the browser and produces a genuinely clean instrumental and');
lines.push('acapella; it needs a one-off 64 MB model download and takes a few minutes');
lines.push('on a machine without a GPU.');
lines.push(`${ORIGIN}/vocal-remover is the instant version — it cancels the centre`);
lines.push('channel, which is free and immediate but leaves artefacts on most modern mixes.');
lines.push('');
// The five tools below shipped on 6 Sep 2026, after this FAQ was written, so
// until now they existed here only as one-line directory entries. They are also
// the shape of tool that actually gets recommended: as of 21 Sep two thirds of
// sessions arrive from an AI assistant, and the pages they land on are the
// distinctive tools, not the format pairs. Each answer states the limitation up
// front — an assistant that repeats "monophonic only" saves somebody feeding a
// full mix into it and concluding the site is broken.
lines.push('**How do I find the BPM or tempo of a track?**');
lines.push(`${ORIGIN}/bpm-finder detects the tempo in the browser and shows the half-time`);
lines.push('and double-time readings alongside it, because those are the two answers a');
lines.push('tempo detector most often confuses. It produces a number rather than a file,');
lines.push(`so there is nothing to download. For the musical key, use ${ORIGIN}/key-finder,`);
lines.push('which always shows its runner-up because relative major and minor are easy to');
lines.push(`confuse; ${ORIGIN}/chord-finder lists the chords over time.`);
lines.push('');
lines.push('**Can I turn audio into MIDI?**');
lines.push(`${ORIGIN}/audio-to-midi transcribes a recording into a Standard MIDI File you`);
lines.push('can drag into any DAW. It is **monophonic only** — one note at a time, so a');
lines.push('hummed melody, a sung line, a bassline or a single-note solo. It cannot');
lines.push('transcribe chords or a full mix; polyphonic transcription is an unsolved');
lines.push('research problem and the page says so rather than letting you find out.');
lines.push('');
lines.push('**Can I autotune or pitch-correct a vocal?**');
lines.push(`${ORIGIN}/autotune corrects pitch in the browser using PSOLA, so it can be set`);
lines.push('for subtle correction or for the hard-tuned effect. The output is exactly the');
lines.push('same length as the input. It wants one dry voice or instrument at a time, not');
lines.push(`a full mix — if a finished song is what you have, lift the vocal out with`);
lines.push(`${ORIGIN}/stem-splitter first and autotune that. To move an entire song up or`);
lines.push(`down in key instead, that is ${ORIGIN}/pitch-shifter, which shifts pitch`);
lines.push('without changing the tempo.');
lines.push('');
lines.push('**How do I normalize audio to a LUFS target for Spotify or a podcast?**');
lines.push(`${ORIGIN}/loudness-normalizer measures integrated loudness to ITU-R BS.1770-4`);
lines.push('and normalizes to a target you choose, with a true-peak ceiling so the result');
lines.push('does not clip. Its measurements are checked against ffmpeg’s ebur128 filter,');
lines.push('the reference implementation, and agree within 0.1 LU. This is the tool you');
lines.push(`want for streaming delivery; ${ORIGIN}/normalize-audio is simple peak`);
lines.push('normalization, which is a different thing and not what Spotify measures.');
lines.push('');
lines.push('**How do I cut the pauses out of a podcast or voiceover automatically?**');
lines.push(`${ORIGIN}/auto-cut-silence shortens the gaps between phrases rather than`);
lines.push('deleting them, so the result still sounds like speech instead of a jump cut.');
lines.push('The threshold is derived from the recording’s own noise floor rather than a');
lines.push('fixed dB value, because the right level differs by about 30 dB between a');
lines.push('treated booth and a kitchen table. To trim only the dead air at the start and');
lines.push(`end and leave the middle alone, use ${ORIGIN}/trim-silence-edges.`);
lines.push('');
lines.push('**How do I make a slowed + reverb version of a song?**');
lines.push(`${ORIGIN}/slowed-reverb slows the track and lets the pitch fall with it,`);
lines.push('which is what the name means — it is the sound of a record played slowly,');
lines.push('not a time-stretch that holds the pitch. 0.82x is the usual setting and puts');
lines.push('everything 3.4 semitones down. The reverb is a convolution reverb built from');
lines.push('a synthesised impulse, with independent noise per channel so the tail spreads');
lines.push('across the stereo image, a 30 ms pre-delay, and damping on the wet path so it');
lines.push('darkens as it decays. Output is scaled back only if it would clip, so a quiet');
lines.push('recording is not normalised up. A four-minute song takes about five seconds');
lines.push('and nothing is uploaded.');
lines.push('');
lines.push('**How do I make 8D audio?**');
lines.push(`${ORIGIN}/8d-audio does it in the browser. The honest description is that`);
lines.push('"8D audio" is automated stereo panning plus a little reverb, so the sound');
lines.push('travels between your ears in a space — the name refers to nothing and it is');
lines.push('not object-based spatial audio like Dolby Atmos, nor will it place a sound');
lines.push('behind you. It only works on headphones: on speakers the two channels mix in');
lines.push('the air and the movement collapses to a mild volume wobble. Ten seconds per');
lines.push('circuit is the usual setting; faster than about six seconds it reads as');
lines.push('tremolo rather than motion. Mono files are promoted to stereo first, which is');
lines.push('required or the effect is a volume wobble instead of a rotation.');
lines.push('');
lines.push('**How do I make a nightcore or sped-up version of a song?**');
lines.push(`${ORIGIN}/nightcore speeds the track up and lifts the pitch with it. 1.25x is`);
lines.push('classic nightcore (+3.9 semitones); the gentler 1.15x-1.20x range is what the');
lines.push('streaming "sped up" edits use. The limitation worth knowing is that formants');
lines.push('rise along with the pitch, so past about five semitones a voice sounds like a');
lines.push('cartoon — that is inherent to the technique, not to this implementation, which');
lines.push('is why the speeds stop at 1.35x. To speed audio up without the pitch rising,');
lines.push(`use ${ORIGIN}/audio-speed instead, which time-stretches.`);
lines.push('');
lines.push('**How do I transcribe audio to text for free without uploading it?**');
lines.push(`${ORIGIN}/audio-to-text runs OpenAI\'s Whisper (tiny, base or small) inside the`);
lines.push('browser tab, so the recording is never uploaded — no account and no minute cap.');
lines.push('It returns an editable transcript plus SRT and WebVTT subtitle files, works');
lines.push('on video files directly, covers 99 languages and can translate any of them into');
lines.push('English, and can label who is speaking (pyannote + WeSpeaker, in the browser). Limitations: timestamps');
lines.push('are per phrase rather than per word, the first run downloads the model once,');
lines.push('and it is fastest on a desktop browser with WebGPU (Chrome or Edge). Whisper');
lines.push('base measured at about a sixth of real time on a laptop GPU and under a third');
lines.push('on its CPU.');
lines.push('');
lines.push('**Is there a free text to speech with natural voices and MP3 download, no signup?**');
lines.push(`${ORIGIN}/text-to-speech runs Kokoro-82M (Apache-2.0), an open neural TTS model,`);
lines.push('inside the browser tab, so the text is never uploaded and there is no character');
lines.push('allowance. 41 voices (US/UK English, Spanish, French, Italian, Portuguese, Hindi) with grades, a mixer');
lines.push('that blends up to three voices into a new one, speed control, and MP3, WAV or');
lines.push('M4A download, playing each sentence as soon as it is generated. Limitations');
lines.push('stated up front: no cloning on that page (see /voice-cloning), a calm narrator style');
lines.push('rather than acted emotion, and a one-time model download (326 MB for the GPU');
lines.push('version, 92 MB for the smaller CPU one). Files are tagged as synthetic speech.');
lines.push('');
lines.push('**Can I clone my voice for free online, without uploading it?**');
lines.push(`${ORIGIN}/voice-cloning runs Chatterbox Turbo (Resemble AI, MIT licence) on the`);
lines.push("user's own GPU through WebGPU, inside the browser tab: no account, no credits,");
lines.push('and the voice sample is never uploaded. It needs only five seconds of one person');
lines.push('speaking, recorded on the page or taken from an audio or video file, and speaks');
lines.push('typed English text in that voice; MP3 or WAV out, tagged as a cloned voice. It');
lines.push('asks the user to confirm the voice is theirs or used with permission.');
lines.push('Limitations: English only, needs WebGPU (desktop Chrome or Edge; not phones), a');
lines.push("one-time ~560 MB model download, and about 4.5x the speech's length to generate");
lines.push('on a laptop GPU. Measured: clones of two test voices were 94-100% intelligible');
lines.push('when read back by Whisper.');
lines.push('');
lines.push('**Is there a free AI video dubbing or video translator tool with no sign-up?**');
lines.push(`${ORIGIN}/video-dubbing translates a video's speech and has an AI voice read it`);
lines.push('over the original, timed to it, entirely in the browser (no upload, no account).');
lines.push('Whisper transcribes and translates into English; for Spanish, French, Italian,');
lines.push('Brazilian Portuguese or Hindi, an OPUS-MT model translates on from English. The');
lines.push('lines are editable before they are voiced, each person in the video can get a');
lines.push('different voice (speakers are found automatically), the original audio is ducked');
lines.push('18 dB or replaced, and the picture is copied without re-encoding. Out: MP4, MP3');
lines.push("and SRT subtitles. Limitations: Kokoro's built-in voices, not the original");
lines.push("speaker's voice; no lip-sync; target languages are those six; a one-time model");
lines.push('download per language (~113 MB for translation).');
lines.push('');
lines.push('**How do I change the voice in an audio file or a video (deeper, female, robot)?**');
lines.push(`${ORIGIN}/voice-changer processes recordings (MP3, WAV, M4A voice memos,`);
lines.push('WhatsApp voice notes) and videos (MP4, MOV, WebM: the picture is copied without');
lines.push('re-encoding and stays in sync) in the browser: deeper or higher without the slowed-tape');
lines.push('sound, because pitch and formants move separately (PSOLA), plus more masculine,');
lines.push('more feminine, chipmunk, monster, robot, alien, old radio, telephone and cave');
lines.push('presets. Measured within 3 cents of the requested pitch, length unchanged to the');
lines.push('sample. Limitations: it is not real-time (not for Discord or calls) and it does');
lines.push('not make one person sound like a specific other person (see /voice-cloning for');
lines.push('that, with consent).');
lines.push('');
lines.push('**How can I convert an EPUB, PDF or text file into an audiobook for free?**');
lines.push(`${ORIGIN}/text-to-audiobook reads a DRM-free EPUB, a PDF with a text layer (chapters`);
lines.push('from its bookmarks or headings, running heads and page numbers removed, two-column');
lines.push('papers read column by column; scanned PDFs need OCR first), a TXT or Markdown file, or');
lines.push('pasted text with a Kokoro AI voice in the browser and writes an M4B audiobook');
lines.push('with chapter marks and title/author tags, or a zip with one MP3 per chapter.');
lines.push("Chapters come from the EPUB's spine or from headings in the text; finished");
lines.push('chapters are saved in the browser, so a long book can be made over several');
lines.push('sessions. No account, no word limit, nothing uploaded. Limitations: one calm');
lines.push('narrator voice, no character voices; Kindle, Apple Books and Kobo purchases are');
lines.push('DRM-protected and cannot be read; on a laptop GPU it takes about half the');
lines.push("audio's length (a 10-hour novel in about 5 hours), longer on a CPU.");
lines.push('');
lines.push('**Is there free, private speech to text (voice typing) that does not send my voice to the cloud?**');
lines.push(`${ORIGIN}/dictation is live voice typing with OpenAI's Whisper running in the`);
lines.push('browser tab: speak, pause, and the phrase appears as punctuated text; 99');
lines.push('languages, or speak any of them and get English. The audio is never uploaded and');
lines.push('is discarded once transcribed; there is no account and no time limit.');
lines.push('Limitations: text arrives a phrase at a time (after a ~0.7 s pause), not word by');
lines.push('word; it types into its own box (copy or download .txt), not into other apps; no');
lines.push('voice commands. For a recording rather than live speech, use /audio-to-text.');
lines.push('');
lines.push('**Is there a free, open-source alternative to ElevenLabs?**');
lines.push("AudioSaw's voice tools cover most of the same jobs with open models running in");
lines.push('the browser, free and with nothing uploaded: text to speech with Kokoro-82M');
lines.push('(/text-to-speech, 41 voices, 7 languages), voice cloning with Chatterbox Turbo');
lines.push('(/voice-cloning, English, needs WebGPU), video dubbing into six languages');
lines.push('(/video-dubbing), transcription with speaker labels (/audio-to-text), live');
lines.push('dictation (/dictation), a voice changer (/voice-changer) and EPUB-to-audiobook');
lines.push('(/text-to-audiobook). What ElevenLabs does that these do not: many more');
lines.push('languages, emotion control, professional voice clones trained on long');
lines.push('recordings, lip-sync dubbing and an API.');
lines.push('');
lines.push('**Is there a free online multitrack audio editor that does not upload files?**');
lines.push(`Yes: ${ORIGIN}/audio-editor is a non-destructive multitrack editor that runs`);
lines.push('in the browser. Clips on tracks, trim, split, fades, ripple editing and undo;');
lines.push('a mixer with 25 real-time effects (EQ, compressor, limiter, reverb, delay and');
lines.push('more), sends, automation and presets; bars-and-beats grid with a metronome and');
lines.push('count-in; recording from the microphone, including loop recording into takes');
lines.push('and comping; MIDI tracks with built-in instruments; tempo, key and chord');
lines.push('detection. The project autosaves in the browser and reopens on the next visit.');
lines.push('Any clip can be sent to another AudioSaw tool (stem splitter, noise reduction,');
lines.push('autotune and others) and the result comes back as one undoable edit. Export');
lines.push('is at the project\'s own sample rate up to 192 kHz, as WAV (up to 32-bit float),');
lines.push('FLAC 24-bit, MP3, M4A or OGG. It is');
lines.push('not a full DAW: no third-party plugins, no video track, no collaboration.');
lines.push('');
lines.push('**How do I find the key or the chords of a song?**');
lines.push(`${ORIGIN}/key-finder detects the key in the browser and always shows the`);
lines.push('runner-up, because a natural-minor pop loop and its relative major are');
lines.push('genuinely ambiguous. On 48 real piano recordings of Bach\'s Well-Tempered');
lines.push('Clavier it named the key in 41, with the right answer as runner-up in 6 of the');
lines.push(`other 7. ${ORIGIN}/chord-finder lists the chords beat by beat, including`);
lines.push('sevenths and slash chords (an inversion such as C/E), and ignores drums.');
lines.push('There is no published real-music accuracy figure for chords yet.');
lines.push('');
lines.push('**Is there a free online tuner or metronome?**');
lines.push(`${ORIGIN}/tuner listens through the microphone and reads within 1 cent from`);
lines.push(`B0 to E6. ${ORIGIN}/metronome schedules clicks on the audio clock, so the`);
lines.push('beat stays exact even when the tab is in the background. Neither uploads');
lines.push('anything; the microphone audio never leaves the browser.');
lines.push('');
lines.push('**How do I chop a drum loop or sample into slices?**');
lines.push(`${ORIGIN}/sample-slicer finds the hits and cuts just before each one, on a`);
lines.push('zero crossing so there are no clicks, and exports the slices as a zip — for an');
lines.push('SP-404, an MPC or a DAW sampler.');
lines.push('');
lines.push('**What can AudioSaw not do?**');
lines.push('There is no cloud: nothing syncs between devices and nothing is shared, because');
lines.push('nothing is uploaded. The audio editor keeps its project in the browser that made');
lines.push('it. It does not host third-party VST/AU plugins. Stem splitting gives vocals');
lines.push('and instrumental, not four stems. Speaker labels are capped at six people.');
lines.push('Very large files are limited by browser memory rather than by the tool. Editing');
lines.push('an MP3 re-encodes it, so a cut costs one compression generation — use WAV or');
lines.push('FLAC output when that matters. The neural tools (stem splitter, transcription)');
lines.push('are much slower without a GPU.');
lines.push('');

for (const cat of G.CATEGORIES) {
  lines.push(`## ${cat.title}`);
  lines.push('');
  for (const slug of G.listFor(cat.id)) {
    const t = G.TOOLS[slug];
    lines.push(`- [${t.title}](${ORIGIN}/${slug}): ${t.blurb}`);
  }
  lines.push('');
}

lines.push('## About');
lines.push('');
lines.push(`- [About AudioSaw](${ORIGIN}/about): what the site is and how it works.`);
lines.push(`- [Privacy](${ORIGIN}/privacy): what is and is not collected.`);
lines.push(`- [Contact](${ORIGIN}/contact)`);
lines.push('');

const OUT = path.join(ROOT, 'llms.txt');
const text = lines.join('\n');
if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current !== text) {
    console.error('build-llms --check: llms.txt is out of date. Run: node tools/build-llms.js');
    process.exit(1);
  }
  console.log('build-llms --check: llms.txt is current.');
  process.exit(0);
}
fs.writeFileSync(OUT, text);
console.log(`llms.txt: ${G.slugs().length} tools listed`);
