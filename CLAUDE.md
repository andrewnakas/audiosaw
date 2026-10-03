# AudioSaw

Static site, no build step, no dependencies. Deployed to Cloudflare Pages from
`main` — pushing deploys. Every page is a standalone `.html` file at the repo
root, served at an extensionless URL (`/mp4-to-mp3`).

## The two rules that will bite you

**1. Bump the `?v=` token when you change anything in `/js` or `/css`.**

`_headers` serves those directories as `max-age=31536000, immutable` against
unversioned filenames. `immutable` tells browsers not to revalidate, so a
returning visitor is pinned to whatever they cached until the token changes.
Shortening the header does nothing for responses already in a cache.

`sw.js` carries the same token in its `Q` constant and precaches those exact
URLs, so it has to move with them — miss it and the worker precaches the old
filenames.

`js/resample.js` is included by no page: `audio-core.js` loads it on first use
with the token from its own `<script src>` (`document.currentScript`), so the
bump reaches it without a separate edit. `sw.js` precaches it for offline use.

```bash
# after editing js/ or css/
grep -rl '?v=2026-09-05' *.html sw.js | xargs sed -i '' 's/?v=2026-09-05/?v=2026-10-01/g'
```

**2. On a tool page, the `/js/*` includes must come before the page's own
inline `<script>`.**

The bespoke inline tools call `CV.bindDropzone()` at top level. If the includes
sit below them, that throws `ReferenceError: CV is not defined` and the dropzone
never binds — the page looks fine and does nothing. This shipped on nine pages
for months. Each inline block now starts with a guard that logs loudly if the
order is wrong. On pages using `tool-converter.js`, the `window.AS_TOOL = {...}`
config must still come before that file.

`node tools/check-includes.js` now enforces both halves of this: it walks each
page's `<script>` tags in document order and fails if a script uses a `CV.*` or
`AudioSaw.*` member that no earlier script defines. That is the same fault one
step later than the ordering bug — `/voice-recorder` shipped without
`tool-shell.js` at all and threw "CV.encodeBuffer is not a function" only after
the user had finished recording. It runs as part of `check-all.js`.

Correct order:

```html
<script src="/js/common.js?v=..."></script>
<script src="/js/tool-graph.js?v=..."></script>
<script src="/js/flow.js?v=..."></script>
<script src="/js/audio-core.js?v=..."></script>
<script>window.AS_TOOL = { target: 'mp3', accept: ['.wav'] };</script>
<script src="/js/tool-converter.js?v=..."></script>
<script src="/js/consent.js?v=..."></script>
<script>(function(){ /* page-specific tool, if any */ })();</script>
```

## Adding a tool page

1. Copy an existing page of the same shape. Simple format conversions need no
   JS at all — set `window.AS_TOOL` and include `tool-converter.js`.
2. Add an entry to `js/tool-graph.js`: `cat`, `label`, `title`, `blurb`, and
   `next` (related tools, each with the *reason* it is related).
3. Add the slug to one — exactly one — rail in `HOME_RAILS`, in the same file.
   `build-nav.js` refuses to build if a tool is in no rail or in two. That is
   deliberate: the homepage is the strongest internal link a tool page gets, and
   the hand-written 39-tile grid the rails replaced had quietly drifted to 18
   tools short. `HOME_RAILS` groups by *intent* and `CATEGORIES` groups for the
   breadcrumb and the footer directory; they are allowed to disagree, and do —
   the pitch shifter is filed under "clean up & separate" but rails with
   "make music".
4. Run the generators:

```bash
node tools/build-nav.js      # footer directory, related blocks, breadcrumbs, /tools, PWA head
node tools/build-faq.js      # merges the visible FAQ with FAQPage schema
node tools/build-dates.js    # dateModified in each SoftwareApplication block
node tools/build-sitemap.js  # sitemap.xml with lastmod from git
node tools/build-llms.js     # llms.txt
node tools/check-includes.js # every CV./AudioSaw. helper a page uses is on the page
node tools/check-editor.js   # the audio editor's model invariants
node tools/check-all.js      # runs all of the above; use before committing
```

`build-dates.js` and `build-sitemap.js` both read the last git commit that
touched each file, so run them **after** committing or they write the previous
commit's date.

`build-faq.js` exists because the visible FAQ and the JSON-LD were authored
separately and drifted: 31 pages shipped schema promising questions that were
nowhere on the page, which is a structured-data policy violation and wastes the
answers. It now generates the schema *from* the `<details>` list, so write the
FAQ in the HTML and run the script. `node tools/build-faq.js --check` exits 1 if
they ever disagree again.

`js/tool-graph.js` is the single source of truth — both Node and the browser
read it. Nothing else should hardcode the list of tools.

The generators are idempotent; everything they write sits between `<!-- AS:name -->`
markers and gets replaced, not duplicated. Do not hand-edit inside those markers.

**Write real content.** Eight pages once shipped the same paragraphs with the
format name swapped and Google indexed none of them. Aim for 700–900 unique
words: what actually changes, when you'd want it, which settings matter, and
what you lose. Name real hardware and software. Every tool page now clears 700;
the median is around 940.

**Test the format before you write the page.** Before adding a converter, feed a
real file of that format through `AudioSaw.convert` in a browser and confirm it
decodes. WMA, CAF, AC3, ALAC and WavPack were all checked that way; ALAC was
dropped because it arrives as `.m4a` and would only cannibalise the existing
page. Generating fixtures with local ffmpeg is fine, but verify the fixture too
— a bad `-f` guess produced a 460-byte "m4r" that looked like a site bug.

**Claim only what you measured.** The AC3 page states the centre channel sits
about 4 dB down in the stereo downmix because that was measured with a 5.1 file
carrying a separate tone per channel, not because the coefficient tables say
-3 dB. Same for the BPM confidence thresholds.

## Audio quality: no hidden ceilings

The hi-fi pass (Sep 2026) made every tool keep the source's sample rate,
channels and precision unless asked otherwise, and offer a maximum-quality
output. `node tools/check-fidelity.js` holds all of it and runs in check-all.
It measures the core (below) and drives 33 real tool pages, the editor, the
recorder and the stem splitter with a 96 kHz / 24-bit file. Pages quote its
numbers; tighten the check before quoting a new one.

- **Decoding is at the file's own rate.** `decodeAudioData` resamples to the
  rate of the context that calls it, and a plain `AudioContext` runs at the
  device rate: every tool turned 96 kHz into 48, and on a 48 kHz Mac every
  44.1 kHz file into 48. `AudioSaw.sniffFormat` reads rate, channels and depth
  from the header (WAV/RF64, AIFF, FLAC, Ogg, CAF, WebM, MP4, ADTS, MP3), and
  `decodeToAudioBuffer` decodes in an `OfflineAudioContext` at that rate, with
  the device path as the fallback. The buffer carries `srcInfo`.
  - **MP4:** the sample entry's 16.16 rate field cannot hold 96000 (ffmpeg
    writes 48000), so the track's `mdhd` timescale wins above 65535.
  - **AAC:** at 24 kHz or less it is decoded at double, since HE-AAC signals
    half its output rate, sometimes only implicitly.
- **Format tokens.** Every writer is `AudioSaw.encode(buffer, token, opts)`,
  and page selects hold tokens:
  - `wav16/24/32f`, `aiff16/24`, `flac16/24`;
  - `mp3` (lamejs) and `mp3-v0`/`mp3-320` (LAME in the ffmpeg core, joint
    stereo, reservoir, LAME header);
  - `m4a`, `ogg`;
  - plain `wav`/`flac`/`aiff`: match the source. That gives 24-bit (or float
    for WAV) when the decoded file was lossless and deeper than 16, else 16.
    It reads `srcInfo`, then `opts.srcInfo`, then the last decoded file's
    header.
  - The bitrate selects also offer `v0` and `lame320`. `resolveFormat(fmt,
    bitrate)` folds them into the token, and `bitrateOf` takes the number.
    Pages pass the select's raw value; `convert()`, `CV.encodeBuffer` and the
    editor do the folding. `extFor`/`rename` give the extension.
- **Dither and the two grids.** 16- and 24-bit get TPDF dither (-90 dBFS tone:
  harmonics -135 dBFS dithered, -105 truncated). A signal already on the target
  grid is written bit-exact with no dither, and there are two grids. Chrome
  decodes 16-bit WAV as positive/32767, negative/32768; 24-bit and other
  browsers divide by 2^(n-1) both ways. `gridOf` detects either and writes back
  on the same one. The asymmetric one needs a tolerance, because float32
  cannot hold n/32767.
- **Resampling is `js/resample.js`**, not Web Audio: a Kaiser windowed-sinc,
  120 dB, UMD. It gives an exact polyphase bank when the reduced ratio has at
  most 2048 phases and a 4096-per-crossing table otherwise.
  - It is flat within 0.0001 dB to 20 kHz. 96 -> 48 puts a 30 kHz tone more
    than 140 dB down; Chrome's own conversion (a buffer source into a slower
    context) passes it at full level, because it just takes every other
    sample.
  - `AudioSaw.varispeed` is the same resampler used for tape-style speed
    (audio-speed, nightcore, slowed+reverb).
  - Where ffmpeg resamples (pitch shifter, `convertViaFFmpeg`) it gets
    `aresample` at filter_size 64 with triangular dither. soxr and rubberband
    are not in the core.
- **MP3 limits.** MP3 carries at most 48 kHz and two channels. Higher rates
  are resampled first (88.2/176.4 to 44.1, anything else to 48). 3 to 8
  channels fold with BS.775 coefficients (centre and surrounds -3 dB, LFE
  dropped) instead of keeping channels 0 and 1, which used to drop a film's
  dialogue.
- **ffmpeg hazards.**
  - libopus in the 0.12.6 core dies with "memory access out of bounds" on
    every input, so there is no Opus output. Opus input decodes in the
    browser.
  - libvorbis refuses a managed bitrate at 96 kHz, so OGG uses `-q:a` mapped
    from the bitrate.
  - Any failed `exec` corrupts the wasm heap for the next one. `runFFmpeg`
    terminates the instance after a failure, and pages reuse `runFFmpeg`
    rather than calling `exec` themselves.
- **Clip handling.** `ASLoudness.limit` (loudness.js) is a true-peak limiter
  for whole files:
  - 4x detection, 1.5 ms look-ahead, a linear release to exactly 1.0 (a region
    it never touches is bit-exact), and a second pass for heavy limiting.
  - /amplify-audio uses it at -1 dBTP. The EQ and vocal remover use it when
    their unlevelled output would pass 0 dBTP.
  - /loudness-normalizer decodes its own MP3 and turns down if the encoder
    pushed the true peak over the ceiling.
- **/voice-recorder has two paths.**
  - Voice is MediaRecorder with processing, asking for 256 kbps.
  - Studio skips MediaRecorder. An AudioWorklet copies float samples
    (stereo requested, processing off) in a context opened at the
    microphone's own rate, and they go straight to the encoder. "Match the
    source" on a studio take means float WAV and 24-bit FLAC.
- **Project audio defaults to `wav32f`.** When a tool page takes project
  audio (`project-link.js`), its output select moves to float WAV. The
  editor's own send path, ffmpeg effects and import fallback are all float.
- **The readout.** Every tool shows what went in and what came out, and the
  sweep asserts it matches the file:
  - Each picked file gets a format badge in the file list
    (`CV.describeFile`).
  - After a run, a "Your file / Saved as" panel sits under `#status`
    (`CV.signal` in common.js).
  - The panel is fed by `as:decoded` and `as:encoded`, which audio-core
    dispatches with `AudioSaw.describeFormat` text. The "Saved as" line comes
    from the written file's own header, plus notes: bit-exact or dithered,
    resampled, folded, encoder, bitrate.
  - Decodes of intermediate files pass `{ quiet: true }`, as do the loudness
    page's check decode and the pitch and speed float files, or they would
    replace the real input.
  - In the editor: an engine-rate badge by the clock (`E.currentRate()`,
    which never creates a context), the source format on the clip inspector
    (`source.format`), and the written format in the export message.
- **Harness.** `tools/chrome-harness.js` is the shared headless-Chrome setup
  for new checks: routes, CDP events, fake media devices.
  - check-fidelity serves the ffmpeg core from `~/.cache/audiosaw/`,
    downloading it once, by rewriting the unpkg request with CDP `Fetch`.
    Without the core, the ffmpeg parts are skipped.
  - `FID_PAGES=/a,/b` runs only those sweep pages, and `FID_SKIP_PAGES=1`
    only the core.

## Architecture

- `js/audio-core.js` — `window.AudioSaw`. Decode at the source's rate, the
  format tokens and writers, the resampler loader, and a WebAssembly FFmpeg
  build, lazily loaded, for m4a/ogg/flac/LAME and video demuxing (see "Audio
  quality" above).
  - **`decodeToAudioBuffer` falls back to ffmpeg** (float WAV at the file's
    rate) when the browser refuses a file, so every tool reads AMR/3GP voice
    notes, WMA and AC-3. Not for text/zip/PDF/images (no 30 MB download to
    fail), not for a >48 MB MP3/AAC/FLAC/Vorbis/Opus (that is memory, and is
    reported as such), and not on /stem-splitter: it is cross-origin isolated
    and `/vendor/ffmpeg/*` carries no COEP header. `{ ffmpeg: false }` turns
    it off; `convert()` uses that and goes straight to the target instead.
  - A 0-byte file is refused before decoding ("That file is empty").
  - The core falls back from unpkg to jsDelivr (same bytes); the cache key
    is still the unpkg URL.
  - Long files: the WAV/AIFF/lamejs writers quantise in 64k-frame blocks, and
    `AudioSaw.view(buffer, start, end)` hands encode() a window without a
    copy. Copying is what made a 75-minute split need ~2 GB on top of the
    decoded audio. /split-audio also cuts equal parts or fixed lengths by
    ffmpeg stream copy when the decode fails for memory.
- `js/tool-shell.js` — `CV.shell({process})`, the driver for tools that do
  custom processing, plus shared DSP helpers (`CV.lowpass`, `CV.highpass`,
  `CV.peakNormalise`, `CV.bufferFrom`, `CV.channelsOf`, `CV.encodeBuffer`).
  `tool-converter.js` is the equivalent for plain format conversions.
- `js/common.js` — `window.CV`. Dropzone binding and UI helpers.
- `js/flow.js` — post-conversion behaviour and analytics. Works by wrapping
  `CV.downloadBlob` and `CV.setStatus`, which every tool on the site funnels
  through, so it reaches all pages without per-page code. If you write a new
  tool, call those two functions and you get the next-step panel, the preview,
  error recovery and event tracking for free.
- `js/tool-converter.js` — the shared driver for simple format conversions.
- `js/pitch-track.js` — YIN pitch detection and note segmentation, shared by
  `/audio-to-midi`. YIN rather than plain autocorrelation because
  autocorrelation's strongest peak is routinely at twice the true period — the
  same octave trap the BPM detector hits — and the cumulative mean
  normalisation is specifically the fix. Take the *first* dip below threshold,
  never the deepest, or the octave error comes straight back.
- `js/autotune.js` — PSOLA pitch correction behind `/autotune`, checked by
  `node tools/check-autotune.js` (an off-pitch note must land on the target, a
  note already in tune must be left alone, duration must not change, level must
  hold within 3 dB).

  **Pitch marks must be placed on a low-passed copy**, not the raw signal. On a
  bright waveform there are several peaks inside one period, so peak-picking the
  raw signal lands on a different feature each cycle. Measured: grain spacing
  wandered by 15% and the output dropped *two octaves*. One clear peak per cycle
  is the whole requirement.
- `js/key-detect.js` — `ASKey`, key detection behind `/key-finder`. It is also
  used by the editor's tempo sheet ("Detect the key", stored as `project.key`),
  the pitch shifter (it shows the key each shift lands in) and autotune. The
  last two take `?key=A-minor` from the key finder. It computes a peak-picked
  chromagram on audio decimated to ~11 kHz, removes the tuning, normalises each
  frame, and correlates against Temperley profiles. `node tools/check-key.js`
  synthesizes all 24 keys three ways (clean, with a band, 30 cents sharp) and
  all 72 must read right. It also *reports* the natural-minor pop loop
  (Am–F–C–G). That loop reads as the relative major in 12 of 12 keys, with the
  minor as runner-up in 11. It is inherently ambiguous, so the page always
  shows the runner-up. The one real-music figure is
  `node tools/measure-key-real.js` (network + ffmpeg, not in check-all):
  Bach WTC Book 1, 48 CC0 piano recordings, key from the title. 41/48, the
  runner-up right in 6 of the 7 misses, "clear" readings 35/36. Misses were
  fifths and parallel mode, not relative. Only inner-movement-free pieces
  work as truth: a sonata's slow movement is usually in another key. There
  is still no real-music figure for chords or downbeats.
- `ASKey.chords` + `js/chord-page.js`: `/chord-finder` and the editor's
  "Detect chords", which stores `source.chords` in source time and draws them
  in a strip at the bottom of the clip.
  - **How it detects.** Chroma frames are 4096 samples at ~11 kHz every
    1024, summed per beat, and matched against the 24 major and minor triads.
    Short segments are folded into a neighbour. Then a seventh (7, maj7, m7)
    is looked for on the whole merged segment, so it can never change the
    triad. A note's third harmonic is a fifth above it, so a major third
    feeds the maj7 and a minor third the m7: plain triads showed as much
    "seventh" as real sevenths at their quietest. `seventhOf` subtracts
    0.3 of the note a fifth below, compares with the third (the voice the
    bass does not feed), and needs the seventh 1.5x any other non-chord
    note, which is what keeps a melody's passing notes out.
  - **Inversions.** A bass note's overtones spell a chord (an E bass brings
    B and G#: Em), which is why C/E read as Em. Each frame's lowest strong
    note is its bass (`fr.bass`); `fr.alt` is the chroma with that note's
    3rd, 5th and 6th harmonics at 0.3. After merging, a chord is re-scored
    on `alt`, and switched only if the new chord has the bass as its third
    or fifth. It has to be per merged chord: per beat, passing notes made a
    root-position C read as Am/C, and no margin separated those (161 right
    switches, 6 wrong over five seeds, all under a melody). Ducking the
    overtones globally instead wrecked root-position chords, because upper
    voices sit on the bass's overtones. The name gets `/E` when the bass is
    the third or fifth.
  - **Checked by** `tools/check-chords.js`, which requires ≥90% on random
    progressions (clean, band, melody) and measured 100%. Sevenths: the
    triad must be right ≥90% (100%) and the whole chord ≥80% (91.7%), and
    plain triads may be given a seventh ≤5% of the time (1.8%). On four
    other seeds: 85–95% and ≤1.6%. Slash chords (third in the bass): the
    chord ≥90% (98.3%), named with its bass ≥80% (97.8%), and a slash on a
    root-position chord ≤5% (0.2%); other seeds 95–99.6%. The melody set
    measures 99.5% (94.4% on seed 3); the inversion switch is what costs
    it. Drums alone are tested on eight seeds, capped at 0.8 s (measure 0).
  - **Drums.** Four things keep drums from being named as chords: the
    0.7 score floor, the 100 Hz analysis floor, the rule that the root
    and third are present, and `IN_TUNE`: at least 0.7 of a segment's peak
    weight near a semitone (real chords ≥0.82 at p5, drums ≤0.63). The
    score floor alone let drums through at 0.70–0.76 on some seeds.
- `js/slicer.js` (`ASSlicer`) + `js/slicer-page.js`: `/sample-slicer`, and
  the editor's "Slice at the hits". Onsets are band flux (24 log bands,
  2048/512 frames) against 1.8x the local median, with a 12%-of-peak floor
  and an absolute floor. Each cut is placed 1.5 ms before the steepest rise
  of a 0.7 ms envelope, then moved back to a zero crossing.
  - **Checked by** `tools/check-slicer.js`, which needs ≥90% of 211 hits
    (measured 91.9%) and ≤5% false cuts (1.5%). Cuts are never more than
    1 ms late. A pad is cut only where it begins, and slices start and end
    on zero.
  - **Each rule was measured.** Summing bins instead of bands missed kicks.
    A threshold from the global mean missed a kick at -2 dB. 1024-point
    frames cut a steady chord 27 times.
  - **A fixture trap.** A test kick cut off abruptly mid-decay is a real
    transient, not a slicer bug.
- `js/metronome-page.js` + `js/tuner-page.js`: `/metronome` and `/tuner`,
  two pages that play or listen live and never take a file.
  - **Metronome.** It schedules on the AudioContext clock 120 ms ahead, or
    1.5 s ahead when the tab is hidden, because a hidden tab's timers can be
    held to once a second. Measured in headless Chrome, consecutive clicks
    are exactly one beat apart (worst error 6e-16 s).
  - **Tuner.** It runs YIN from pitch-track.js on a 4096-sample
    AnalyserNode window every 50 ms and shows the median of five readings.
    `tools/check-pitch.js` requires it to be within 1 cent from B0 to E6.
    That became true once YIN's parabolic refinement moved from the
    normalised curve (4.5 cents off at 1.3 kHz) to the raw difference
    (0.25 cents).
- `js/record-computer-page.js`: `/record-computer-audio`, tab (and, on
  Windows/ChromeOS, system) audio through `getDisplayMedia`. The video track
  is stopped at once; the audio goes through the studio-mode worklet (float,
  stereo, at the track's rate). Chromium only: Firefox and Safari return no
  audio track, and the page says so before and after.
  - **Ask for processing off.** With `audio: true` Chrome delivers tab audio
    mono, 48 kHz, with echo cancellation, noise suppression and AGC on (a
    0.5 tone peaked at 0.05–0.3). Off, every sample is within 1.5e-7 of what
    the tab played (float rounding, not bit-exact).
  - **Checked by** `tools/check-record-computer.js`: Chrome without the fake
    media flags (`fakeMedia: false` in the harness) and with
    `--auto-select-tab-capture-source-by-title`, recording a second tab that
    loops a known buffer. Chrome moves the focus to a tab when sharing it
    starts, and `getDisplayMedia` throws InvalidStateError on an unfocused
    page, so the check brings the page back (`Page.bringToFront`) per step.
    A hidden page's timers run once a second, hence its MutationObserver
    timestamps.
  - A share with no sound, a cancelled picker and a silent tab are `warn`,
    not `error`: they are user-side misses and must not count as
    `convert_error` (the `empty` kind's "no audio" regex would also
    misdescribe them as a file problem).
- `js/piano-roll.js` (`ASPianoRoll`): the note editor on `/audio-to-midi`.
  Transcriptions land on the roll, and the .mid is written from the roll's
  notes when "Download .mid" is pressed. `convert_success` therefore fires on
  that click, not on the transcription. It plays back on a triangle voice
  from the page, alone or against the recording.
- `js/midi-write.js` — Standard MIDI File writer (type 0). MIDI has no forgiving
  parser: chunk lengths must match their contents and delta times are
  variable-length quantities. `node tools/check-midi.js` parses the output back
  with a reader written separately from the writer, so an error in one does not
  cancel out in the other. It also asserts that a repeated note at the same
  pitch emits its note-off before the next note-on, which is what stops a DAW
  killing the second note on arrival.

  Velocity is scaled against the loudest note in the file, not an absolute
  level. An absolute mapping saturates: every note of a normalised recording
  comes out at 127 and the dynamics are gone. That shipped in a first draft and
  the check caught it.
- `js/loudness.js` — ITU-R BS.1770-4 loudness and true peak, behind
  `/loudness-normalizer`. **Validated against ffmpeg's `ebur128` filter**, the
  reference implementation: `node tools/check-loudness.js` generates its own
  fixtures and compares. Integrated loudness must stay within 0.1 LU. True peak
  is checked asymmetrically — at most 0.15 dB *under* the reference, up to
  0.6 dB over — because reading a peak low is the error that lets a file clip.
  Re-run it after any change here, the same way `spectral.js` is checked
  against numpy.

  Two rate subtleties that caused real bugs: loudness must be measured at
  48 kHz because that is where the spec defines its filter coefficients, but
  true peak must be measured on the buffer that actually gets written, since
  resampling moves inter-sample peaks. Measuring both on the resampled copy
  overshot a -1 dBTP ceiling by 0.2 dB.
- `js/silence-gaps.js` — shortens the pauses *between* phrases, behind
  `/auto-cut-silence`. Checked by `node tools/check-silence.js`, which asserts
  the three things that make this sound bad if they regress: no speech is
  truncated, the largest sample-to-sample step in the output never exceeds the
  input's (i.e. no clicks at the joins), and pauses are shortened rather than
  deleted. Also that stereo channels are cut at identical positions.

  The threshold is derived from the file's own noise floor — the 10th
  percentile of frame energy — not set in absolute dBFS, because the right
  value differs by ~30 dB between a booth and a kitchen. Keep it that way.
- `js/bpm-detector.js` + `js/bpm-page.js` — `/bpm-finder`. The third page shape
  on the site: a tool that produces a *number* rather than a file. It still goes
  through `CV.bindDropzone` and `CV.setStatus` so validation, the wrong-type
  message and the aria-live announcements behave identically, but it never calls
  `CV.downloadBlob`, so it fires `convert_start` (via `data-track="convert"`)
  and no `convert_success`. That is correct — nothing was converted — but it
  means the tool is invisible in the `convert_success` metric by design.
- `js/editor-*.js` — `/audio-editor`, the multitrack editor. Seven files with
  one job each: `editor-model.js` (pure project model, UMD, runs in Node),
  `editor-engine.js` (Web Audio playback, offline export, AudioWorklet
  recording), `editor-view.js` (canvas timeline and hit testing),
  `editor-fx.js` (the destructive "Process…" effects, which reuse
  loudness.js, silence-gaps.js, slowed-reverb.js, the denoiser that
  noise-reduction.js now exports as `ASDenoise`, and ffmpeg's atempo),
  `editor-dsp.js` (the real-time plugin catalogue and its builders),
  `editor-fxui.js` (the mixer panel) and `editor-ui.js` (gestures, menus,
  import/export, autosave). `node tools/check-editor.js` checks the model: exact
  undo, trim bounds, overwrite-on-move, ripple, and no overlapping clips after
  1,000 random edits. It runs in `check-all.js`.

  **Clips on a track never overlap.** Everything that places audio carves the
  space first (`carve()` in the model). The engine and the renderer assume it;
  do not add an operation that skips it.

  **Sources are immutable.** An effect writes a new source and repoints the
  clip; it never edits a buffer in place, because undo snapshots still point at
  the old one. `editor-fx.js` copies channels before touching them for that
  reason.

  Autosave uses its own IndexedDB database, `audiosaw-editor`, deliberately not
  the `audiosaw` one shared by flow.js and sw.js (see the share-target section).
  Imported files are stored as the original file and re-decoded on restore;
  effect outputs and recordings are stored as Float32 samples.

  **Rates and recording.**
  - `E.setSampleRate(rate)` sets the engine rate (the recording sheet next
    to Record; `as_ed_rate` in localStorage). It closes the context, and the
    next play or record builds one at that rate. Takes are captured at the
    engine rate, so a 96 kHz interface records at 96 kHz only with the engine
    there.
  - `micConstraints` asks for stereo, sampleSize 24 and all processing off.
    Chrome's default is mono with echo cancellation, noise suppression and
    AGC on; check-fidelity asserts both. `startRecording` resolves with what
    the browser delivered, and the status line says it.
  - Export defaults to `'project'`, which is `E.projectRate`: the highest
    rate among the audio in use. Before the render, clips at another rate are
    converted with the sinc resampler (`convertSources`, cached per
    source@rate). An untouched 96k/24 clip exports bit-identical.

  Touch and mouse differ in one deliberate place: a finger on an *unselected*
  clip pans the timeline, because on a phone one clip often fills the screen.
  Tap selects, then drag moves. Playback end and looping are checked from a
  timer as well as the animation loop, because a background tab gets no
  animation frames.

  **The mixer.** Each track, the master and each return bus has an insert
  chain (`fx: [{id, type, on, params, m}]`, `m` = smart-control positions),
  tracks have `sends` and `auto` lanes (`'vol'`, `'pan'`, `'send:<bus>'`,
  `'fx:<fxId>:<param>'`), and the project has `master`, `buses` and `bpm`.
  `M.normalize()` fills these in for older projects; `adopt()` calls it.
  editor-dsp.js is the single source of truth for plugins: params, smart
  controls, presets and patches are all declared there, and check-editor.js
  asserts every preset and patch names real parameters inside their ranges.
  `node tools/check-fx.js` renders every plugin and preset in headless Chrome
  and re-measures the numbers the page quotes (compressor 7.5 dB GR at 4:1,
  limiter true peak at the ceiling, EQ +6.00 dB, multiband flat within
  0.15 dB, latency compensation, automation, tails). It runs in check-all.

  Four things that bit. `BiquadFilterNode` takes Q **in dB** for lowpass and
  highpass (Butterworth is -3.01, not 0.7071). `DynamicsCompressorNode`
  adds unreported make-up gain (measured 9.3 dB louder than textbook), so the
  dynamics are an AudioWorklet. `WaveShaperNode` clamps its input to ±1, so
  drive lives inside the curve. And a Web Audio feedback loop cannot be
  shorter than 128 samples, which is why the flanger and phaser are worklets.
  The worklet source is a function in editor-dsp.js shipped as a Blob URL;
  its classes must not share a name with a site global, or check-includes
  reads them as a missing script.

  Live edits go through `E.syncFx(project)`: a parameter change is `set()` on
  the running plugin, a structural change (add, remove, reorder, bypass, or a
  param listed in `structural`) rebuilds that one chain in place. Only a new
  send to an idle bus or a look-ahead plugin appearing restarts playback. Any
  plugin with look-ahead declares `latency`; the engine pads the other tracks
  and buses to match and the export trims it off the front.

  A mono clip enters its track at -3 dB and the pan is an equal-power balance
  scaled by √2, so a mono track sounds exactly as it did before the mixer
  (0.707 per side at centre, unity hard-panned). Do not swap it for
  StereoPannerNode on a stereo signal: that folds and is +3 dB hard-panned.

  **The grid and the metronome.** The project has `bpm`, `sig` ([num, den]),
  `gridOffset` (bar 1's time, wrapped into one bar) and `ruler`
  (`'time'|'bars'`). The tempo always counts quarter notes; a beat is the
  denominator's note. All the grid maths (`gridLines`, `nearestGrid`,
  `clickTimes`) lives in the model, so check-editor tests it in Node. The click
  is scheduled ~150 ms ahead on the context clock and goes to
  `ctx.destination`, never `master`. That keeps it out of the meters and out of
  `render()`, and `node tools/check-grid.js` asserts that an export with the
  click on is exactly silent. A count-in is a `countIn` delay on `E.play()`, so
  `t0` moves and take placement needs no special case. The take is clamped to
  start at the playhead, so count-in audio never carves the track before it.
  Recording always runs the timeline now, even over an empty project.

  "Detect from the audio" also sets `gridOffset` from `ASBpm.phase()`. The
  beat is measured: `tools/check-beat.js` requires it within 10 ms, and it
  measured 1.3 ms on drums, 3.1 ms on strums. `phase()` uses a trailing
  20 ms peak envelope, not `analyse()`'s RMS: on a bass note a 1.25 ms RMS
  hop tracks the waveform, and put strums 30–75 ms late. The downbeat is
  still a labelled guess, from four cues (chord change, low end, backbeat,
  crash ring; see `downbeatOf`). check-beat requires 20 of 22 patterns
  across rock, dance, waltz, strum and drums-with-a-crash, each starting
  mid-bar (measured 22; 131 of 132 with tempo, key and pickup varied). It
  was 5 of 9 before. No real-music figure; do not quote one. The clip menu has "Fit to the project tempo" (FX `tempoFit`,
  atempo, held to exactly length/rate, because a loop a few ms long drifts
  off the grid) and "Match the project key" (the Pitch FX by
  `ASKey.shiftBetween`). A Process effect can put `_meta` on its output; it
  lands on the new source (`source.bpm` after a fit).

  **Takes and comping.** `track.takes = [{id, name, clips}]`. Takes are
  lanes that are kept but never played or exported, and `usedSources`
  includes them so their audio is never collected.
  - **Swapping.** `M.useTake(p, track, take, t0, t1)` swaps a range between
    the track and a take, and puts 5 ms fades on the seams.
    `check-editor.js` asserts that no audio is lost and that swapping twice
    restores the original.
  - **Loop recording.** It records while the range loops, and
    `checkEnd()` stamps each pass's `playInfo()`. `placeLoopTakes()` cuts
    the single recording at `(t0_k - firstT) + latency` for each pass. The
    last pass that got at least halfway round plays; the rest, and the
    track's previous audio in that range, become takes.
  - **Takes follow the edits.** A take is the part of a take lane under a
    clip, by time. Moving a clip carries its takes (to a new take of the same
    name on another track); deleting a clip, or overwriting it with another,
    deletes its takes; ripple deletes, inserted gaps, crops and effects that
    change a clip's length shift them as they shift clips. check-editor
    asserts each case, and the fuzz run includes takes.
  - **Looping is seamless.** The engine loops (`opts.loop` on `E.play`), not
    the UI: each pass is scheduled into the running graph 0.3 s before the
    one before it ends (1.5 s in a hidden tab), with its clips, automation
    and clicks. `E.passes()` lists when each pass began on the context clock,
    which is what loop recording cuts the takes by. Restarting the graph at
    the end, as it used to, left about 0.1 s of silence. check-grid step 7
    asserts the passes are exactly one bar apart and nothing was late.

- **MIDI in the editor.** `js/midi-read.js` (`ASMidiRead`, SMF reader),
  `js/editor-synth.js` (`ASEditSynth`, the instruments) and
  `js/editor-midi.js` (`ASEditMidi`: import, note editor, instrument,
  .mid download, bounce, audio-to-MIDI, new clip).
  - **A MIDI clip is an ordinary clip** on a source with `kind: 'midi'` and
    `notes: [[midi, start, dur, vel]]` in source time, kept in the project
    JSON (`M.packNotes`, `M.clipNotes`). So trim, split, move, carve,
    ripple, takes and loop need nothing new. A note that begins before a
    clip's offset is not re-struck (split mid-note: the right half is
    silent until its next note). Editing notes writes a new source.
    `track.inst` picks the instrument; unset means keys, or drums for a
    channel-10 part.
  - **The engine** schedules each note as a few oscillator/filter/gain
    nodes into one gain per clip (clip gain and fades), in at -3 dB like a
    mono clip. No worklet, so export equals playback. `E.previewNotes` is
    the note editor's Play.
  - **Notes are built just ahead of when they sound** (`feedMidi`): 1 s
    ahead from `pump()` live (2.5 s in a hidden tab), and from suspends
    every second in `render()`, and each note's chain is disconnected
    when its sources end. Building every note up front made a 3-minute,
    5,000-note part take 5.6 minutes to export (13 under load); now 6.7 s,
    and Play starts in 97 ms instead of 481. check-midi-track step 8 needs
    a 1,700-note minute to export faster than real time (measures ~2 s).
    `render()` keeps one suspend per time for both this and fx lanes;
    two suspends at the same time throw.
  - **Audio-only paths** refuse a MIDI clip with "Bounce to audio first"
    (`refuseMidi` in editor-ui: Process, Send to a tool), the MIDI clip
    menu leaves them out, and tempo/key detection reads audio clips only.
    The store writes no file for a MIDI source.
  - **Checked by** `tools/check-midi.js` (the reader: tempo map, running
    status, velocity-0 offs, sysex, hung notes, drums, sustain pedal,
    truncated files) and `tools/check-midi-track.js` (headless Chrome:
    import, live play, export pitch within 17 cents (measured 2.4),
    every instrument at 440 Hz, drum spectra, project files, bounce
    within 5 cents and 0.5 dB with undo, audio to MIDI, the note editor).
    A headless AudioContext only runs after real input, so that check
    clicks with CDP before pressing Play.
  - **Known gaps:** notes are in seconds, so a tempo change does not move
    them; pitch bend and controllers other than the pedal are dropped;
    no velocity lane; the voices are simple synths, not samples.

- `js/project-link.js` + `js/editor-link.js` — the project that follows you
  onto tool pages. "Send to a tool…" on a clip in `/audio-editor` hands it to a
  tool page. The page shows a project bar ("Use project audio"), and after the
  tool runs, a "Send back" chip. The result replaces the clip as one undoable
  edit, the same way a Process effect does. `node tools/check-project-link.js`
  drives the whole round trip through the real pages in headless Chrome, and it
  runs in `check-all.js`.

  **Tool pages never write the project.** They use a third database,
  `audiosaw-link` (store `records`), with two keys and one writer each:
  - `target`, written by the editor: the clip as a 16-bit WAV, plus peaks and a
    fingerprint;
  - `return`, written by the tool page: exactly the blob `CV.downloadBlob` got.

  It is not `audiosaw`, because that one's version is pinned by `sw.js`. It is
  not `audiosaw-editor` either: a tool page opening that before the editor ever
  had would create it empty at v1, and the editor's upgrade handler would never
  run. The localStorage key `as_project` says whether a target exists, so a
  tool page with nothing to offer does no IndexedDB work at all.

  A tool opts in with `project` in `tool-graph.js`:
  - `'same'`: same length, so the result is aligned and nothing moves;
  - `'len'`: the length changes, so later clips ripple;
  - `'stems'`: several files come back.

  `check-includes.js` fails if a `project` tool's page lacks `project-link.js`
  after `flow.js`.

  **Encoder delay is real and is trimmed.** lamejs puts 25 ms of silence at the
  front, measured through `/noise-reduction`. For `'same'` tools, `align()`
  cross-correlates the result against what was sent and drops the lead-in. When
  the correlation is under 0.6 (a reverser, a pitch shift) there is no reliable
  measurement, so it only cuts or pads to length.

  If the clip was edited while the tool was open (`M.targetPrint` differs), the
  editor asks instead of replacing. The same goes for a result whose project id
  is not the saved project.

  Three things can be sent: a clip, a range, or the whole mix (Project menu).
  - **A range on one track** goes out dry. Clip gains and fades are baked in,
    the track's own effects stay live, and the result goes back into exactly
    that range (`M.replaceRange`).
  - **A range over several tracks, or the mix,** is bounced wet, through the
    track effects, sends and automation but not the master. The result comes
    back as one new "bounce" track, and the range is cleared on the originals.
  - **Muted tracks are left out of a bounce.** They are neither rendered nor
    cleared.

  Once a result is applied, that clip becomes the new target, so the bar keeps
  offering the current audio on every eligible tool page. Stems come back as
  a zip: the first file replaces the clip, the rest go on new tracks below it,
  and they share one alignment shift, because lining each one up separately
  could leave them apart by exactly the encoder delay.

  **Only one editor tab saves.** `editor-link.js` holds a Web Lock
  (`audiosaw-editor-project`) for the tab's lifetime. A second tab keeps
  working but does not autosave, and shows "Use this tab instead". That button
  steals the lock and reloads the latest save. Before the lock, two tabs were
  last-write-wins, and one tab's source clean-up could delete audio the other
  still pointed at. A tab without the lock also ignores the channel, so it can
  never be the one that takes a result.

  The per-row "download" buttons on multi-file tools pass `{ again: true }`
  to `CV.downloadBlob`. Without it, each click counted as another
  `convert_success` and rebuilt the next-steps panel around a single file.

- `js/pwa.js` — service worker registration and the install prompt. Loaded last
  on every page, including the five that carry no other JavaScript.
- `sw.js` — offline support and the share target. Cloudflare Pages will not
  serve a `.js` file with a browser TTL shorter than four hours, so the worker
  is kept fresh by `updateViaCache: 'none'` plus an explicit `reg.update()` in
  `pwa.js`, not by the `_headers` rule. Do not "fix" that rule by deleting it or
  by registering the worker with a `?v=` — a versioned URL creates a *new*
  registration each release and orphans the old one. Deliberately narrow: it
  bypasses everything cross-origin, and it bypasses `/stem-splitter`,
  `/js/stem-worker.js` and `/vendor/ort/*` entirely, because a synthesised or
  fallback response there would arrive without the COOP/COEP/CORP headers those
  files need and hang session creation exactly as documented below.

### The share target writes into the same store flow.js reads

`sw.js` answers `POST /share` by putting `{name, blob, from:'share'}` into
IndexedDB `audiosaw` v1, store `handoff`, key `pending` — a hand-copied mirror
of `withStore` in `flow.js`. The database name, version and store name must
match on both sides or one of them throws `VersionError`. There is no build
step to share the code, so the two carry cross-referencing comments instead.

### The ffmpeg core is cached by audio-core.js, not by the service worker

`fetchCoreWasm` streams the 32 MB core with a `ReadableStream` reader, reports
byte progress, and keeps it in a Cache Storage bucket named
`audiosaw-ffmpeg-core`. unpkg gzips it and sends no `Content-Length`, so
`FFMPEG_WASM_BYTES` is the hard-coded decoded size — **update it whenever
`FFMPEG_WASM`'s version changes** or the progress bar is scaled against the
wrong denominator. Measured: 5.2 s cold, 78 ms from cache.

The service worker never touches it. One writer, one reader, and the worker
receives a `blob:` URL it never sees.

### ffmpeg must be served from our own origin

`/vendor/ffmpeg/` holds the ffmpeg.wasm loader, its worker chunk and the core.
This is not a preference. ffmpeg.wasm 0.12 spawns its worker from a chunk next
to `ffmpeg.js`, and a Worker cannot be constructed from a cross-origin URL — so
loading the library from a CDN fails with:

```
Failed to construct 'Worker': Script at 'https://unpkg.com/.../814.ffmpeg.js'
cannot be accessed from origin 'https://audiosaw.com'
```

That silently broke *every* ffmpeg-dependent conversion in production: all video
input (including `/mp4-to-mp3`) and all m4a/aac/ogg/flac/aiff output. Do not
move these back to a CDN.

The 30.6 MB `ffmpeg-core.wasm` is the exception and stays on unpkg — it exceeds
Cloudflare Pages' 25 MiB per-file limit, and it is the one piece that does not
need to be same-origin. Because `coreURL` is then local while the wasm is
remote, `wasmURL` must be passed explicitly or the core looks for the wasm next
to itself and 404s.

`/vendor/*` is cached immutable for a year, so the paths in `audio-core.js`
carry `?v=<library version>`. Bump those when upgrading a library.

## Analytics

GA4 `G-5X9ERMVYXE` — property **"Audio Saw", 538578494**. The same Google
account holds seven other properties (exebrowser is 539318036) and the picker
opens on whichever was used last, so check the name before trusting a number.
Key events: `convert_success`, `next_step_click`, `chain_continue`. Never send
filenames or raw exception strings — bucket sizes and enumerate error types (see
`mbBucket` and `ERROR_KINDS` in `flow.js`).

**A parameter is invisible until it is a registered custom dimension**, and
registration is not retroactive. Every parameter this site sends was being
discarded by GA4 until 21 Sep 2026 — collection was fine, nothing had ever been
promoted. `tool`, `error_type`, `placement`, `rail` and `to_tool` are registered, and
`from_tool` since 23 Sep 2026 (it tells tools apart on the project link's
`chain_continue`); `file_ext`, `target_format` and `pick_method` are not yet. If you
add a parameter, register it the same day you ship it or the first weeks of its
data do not exist.

**There are no ads.** AdSense used to load on 55 pages with zero ad units ever
placed, so it was cost without revenue; the script, the meta, the slot divs, the
CSS and the per-page toggles are all gone. `ads.txt` stays, because an AdSense
account whose site drops it flags a misconfiguration. If ads ever return, they
need real `<ins>` units, not just the loader.

Consent is region-aware: the inline bootstrap in every `<head>` reads the
browser timezone and defaults to granted outside Europe, denied inside it, and
an unreadable timezone counts as European. A stored choice always wins. The
footer's "cookie settings" link reopens the banner anywhere, which is also the
opt-out path for visitors who never saw it.

Search Console property is the URL-prefix `https://audiosaw.com/`, verified via
the GA tag. Removing the gtag snippet would break verification.

The site emits exactly eight events, all through `track()` in `flow.js`:
`convert_success`, `convert_start`, `convert_error`, `file_selected`,
`next_step_click`, `chain_continue`, `preview_play`, `download_again`. There is
no heartbeat and no retry loop anywhere — keep it that way.

New outcomes become new *values* on those events, never a ninth event:

| Event | Value | Means |
|---|---|---|
| `convert_error` | `error_type: wrong_type` | a file the tool does not accept |
| `next_step_click` | `placement: recent` | the recent-tools row |
| `next_step_click` | `placement: home_rail` + `rail: <id>` | a homepage tool rail, and which one |
| `next_step_click` | `placement: home_jobs` | the "jump straight to a job" row on / |
| `next_step_click` | `to_tool: install` / `install_later` | the PWA install chip |
| `chain_continue` | `from_tool: share` | arrived through the OS share sheet |
| `chain_continue` | `accepted: false` | the file was offered and taken, but injection failed |
| `next_step_click` | `placement: project` | a clip sent from the editor to a tool (`tool: audio-editor`) |
| `chain_continue` | `placement: project`, `from_tool: audio-editor` | "Use project audio" taken on the tool page |
| `next_step_click` | `placement: project_return` | "Send back" clicked on the tool page |
| `chain_continue` | `placement: project`, `to_tool: audio-editor` | the editor actually applied a tool's result |

A `validation` error kind exists for UI hints like "Selection too short" and is
deliberately **silent** — it fires no event and shows no recovery panel. Those
used to be counted as conversion failures, which buried the real error rate.

**`error_type` values** (`ERROR_KINDS` in flow.js, first match wins):
`wrong_type`, `empty_file` (0 bytes), `mic_denied`, `mic_missing`, `mic_busy`,
`mic_constraints`, `insecure`, `unsupported_api` (a named browser API is
missing), `storage`, `codec_crash` (a wasm module died), `too_long` (a tool's
cap), `memory`, `no_content` (no gaps, no pitch, silence), `bad_file`,
`codec_load`, `decode`, `encode`, `empty` (no audio track), `aborted`,
`script_error` (a TypeError/ReferenceError: usually ours), `other`. Until Oct
2026 most failures were `other`: every refused microphone among them.
- Pass the exception as `CV.setStatus(el, 'error', msg, err)`: the classifier
  then sees `NotAllowedError: Permission denied`, not only the page's words.
- The picked files' names are cut out of the message before it is matched;
  `empty.mp3` failing to decode was filed under `empty`.
- `node tools/check-errors.js` pins the buckets against the real messages and
  drives the failures in Chrome. A new message goes in its table.

Why no heartbeat and no retry: a `setInterval` that reports to GA4 does not stop
in a background tab, so an abandoned tab reports near-perfect usage; and a silent
retry turns one failure into hundreds of events from one user.

The one periodic thing that does exist is `CV.setProgress` mirroring the
percentage into `document.title`. It is driven by conversion progress, not by a
timer, and it sends nothing.

`chain_continue` fires **only when the carried file is actually taken**. The
"start fresh" button fires nothing. It used to fire `chain_continue` with
`accepted: false`, which was harmless until the event was starred as a key
event — at which point every decline was being counted as a conversion, and
`accepted` is not a registered dimension, so nothing could separate them. The
event is named for what it measures.

The handoff chip is only offered when the landing page's own accept list
contains the carried file's extension. 26 of the graph's `next` edges point at
a tool that cannot take the source tool's output — most of them good links you
follow with a *different* file — and carrying the output to all of them
produced a success, a suggestion, and then "Wrong file type" from the tool that
had just invited you in.

`placement: home_rail` carries a `rail` parameter because the rails only work
if people scroll them: placement alone cannot tell "the convert rail earns
clicks" from "its first three chips do and the other nineteen are dead links".
There is deliberately no impression event — a rail scrolling into view is not an
outcome, and counting it would be the heartbeat this site does not have.

`docs/growth-playbook.md` records what the growth work has and has not covered,
including which GA4 key events to star and why `file_selected` must not be one.

## Transcription (/audio-to-text)

Whisper through transformers.js, on the stem splitter's isolation pattern:
`js/transcribe-page.js` decodes, folds to mono and resamples to 16 kHz with
the sinc resampler; `js/transcribe-worker.js` (a **module** worker) runs the
pipeline; `js/subtitles.js` (UMD) writes TXT, SRT and VTT and is checked by
`node tools/check-srt.js`, which parses the output back with its own reader.

**The runtime is pinned, and the pin is the finding** (playbook §11):
transformers.js **4.2.0** with its ORT 1.26.0-dev, vendored in
`/vendor/transformers/`. 4.3.0 needs a 26.9 MB asyncify wasm, over Pages'
25 MiB limit, and it cannot come from a CDN because the page is isolated.
`/vendor/ort/` is ORT 1.22 for the stem splitter; the majors cannot share
files. The worker sets `wasmPaths` to the vendored asyncify build (plain
build on Safari), or the library fetches jsDelivr and fails under COEP.

- **dtypes: `q4` on both backends.** The CPU path has no choice (q8, int8,
  fp16 fail on ORT 1.26 with "TransposeDQWeightsForMatMulNBits Missing
  required scale"). The spike used an fp32 encoder on WebGPU; q4 there was
  re-measured on 1 Oct (tiny and base, a 42 s speech clip, transcripts
  correct word for word bar punctuation) and is what ships, because then
  both backends load the same files. With different files, a WebGPU session
  that failed made the CPU fallback download a second encoder (base: 217 MB
  instead of 135), and whisper-small's fp32 encoder alone is 336 MB.
- **Downloads resume.** `env.fetch` is `resumableFetch`: when the stream
  drops it asks for the rest with `Range` and keeps going, so
  transformers.js sees one complete response. Before it, a slow link failed
  the 117 MB base decoder at 67 MB, twice, and started over each time; a
  network error was also mistaken for a WebGPU failure. Hugging Face's CDN
  answers Range with 206 and CORS. `tools/check-model-fetch.js` lifts the
  function out of the worker and runs it against a server that drops every
  2 MB.
- **Headers.** `_headers` gives COOP/COEP to the page, COEP to the worker
  and CORP+COEP to `/vendor/transformers/*`; `sw.js` BYPASSes all three,
  for the same reason as the stem splitter.
- **Progress.** The pipeline gives none while it runs. A
  `WhisperTextStreamer` on the call fires `on_finalize` once per 30 s
  window, which is the part counter, and its text is the live preview.
- **Testing.** `tools/serve.js` serves the repo with `_headers` applied
  (`withPage({ headers: true })` does the same in the harness). Headless
  Chrome on a Mac gets a real WebGPU adapter with `--enable-unsafe-webgpu
  --use-angle=metal --ignore-gpu-blocklist`; without those flags it still
  reports `navigator.gpu` and an adapter, then fails to build the session.
  `withPage({ profile })` keeps the model cache between runs (q4: tiny
  90 MB, base 135 MB, small 285 MB). Do not quote speeds measured on a
  loaded machine; the page quotes the spike's (playbook §11).

## The voice tools (Oct 2026, from VoiceStudio)

/text-to-speech, /voice-changer, /text-to-audiobook, /dictation and
/video-dubbing are browser rebuilds of what github.com/debpalash/VoiceStudio
(a desktop Python app) does; no code came across. They sit in the
`voice` category and homepage rail with /audio-to-text.

- **Kokoro-82M** (`js/tts-worker.js`, `js/tts-engine.js` = `ASTTS`) runs on
  **`/vendor/ort` (ORT 1.22)**, not transformers.js: ORT 1.26 rejects q8/fp16
  on the CPU, and Kokoro is one graph with three inputs (`input_ids`,
  `style` = row n-2 of the voice's 510×256 table, `speed`), 24 kHz out.
  - **Weights per backend:** fp32 (326 MB) on WebGPU, q8 (92 MB) on WASM.
    **fp16 on WebGPU gives wrong audio inside a worker** (wrong length, a
    silent voice, speed ignored) though it looked fine on the main thread;
    q8 on WebGPU is correct but no faster (quantised ops fall to the CPU).
    `?backend=wasm` and the page's "smaller download" skip the GPU.
  - Measured idle (check-tts, Apple GPU, 8 cores): 0.48× the speech's
    length on WebGPU, 1.36× on 7 CPU threads. Under load average 50 the
    same runs took 3-6× longer, so speed asserts only run with TTS_SPEED=1.
  - Phonemes: the `phonemizer` package (espeak-ng, English only,
    `vendor/phonemizer/`), imported into the classic worker with `import()`.
    English normalisation is ported from kokoro-js. Text is chunked to
    ~220 chars (the model card: best at 100-200 tokens, rushes past 400).
  - Every file is tagged as synthetic speech (ID3 COMM / WAV INFO ICMT,
    `ASTTS.tagMp3/tagWav`). Metadata, not a watermark; the page says so.
  - The voice mixer averages whole style tables; one live voice is returned
    untouched.
- **/voice-changer** (`js/voice-fx.js` = `ASVoice`, UMD): TD-PSOLA with a
  time-stretch, after a sinc resample for the formant shift, so pitch and
  formant move separately. f0 is tracked on an 11.025 kHz copy (3 s of CPU
  instead of 23 for the check). **The noise floor is capped 20 dB under the
  loud frames**: on a recording with no pauses the 10th percentile was the
  voice, nothing counted as voiced, and nothing shifted.
- **/text-to-audiobook** (`js/book-parse.js` = `ASBook`, `audiobook-page.js`):
  EPUB spine / text headings to chapters; each chapter is encoded as soon as
  it is read (AAC or MP3) and stored in IndexedDB `audiosaw-tts`, so runs
  resume. The M4B is a stream-copy concat with an ffmetadata chapter file;
  `runFFmpeg` takes `extra: { files, raw }` for that. Chapters read back by
  ffprobe start within 0.5 ms. DRM EPUBs are refused by name.
  - **PDF input** (`ASBook.fromPdf`, pure; `readPdf` in audiobook-page.js
    feeds it from pdf.js 6.3.289 legacy in `vendor/pdfjs/`, imported only
    when a PDF is dropped). A PDF has no paragraphs, so they are rebuilt:
    runs at one height are a line (but never across a gutter, and only
    joining runs to the right of the line so far, or a left-column line
    glues onto a right-column caption); a gap over 1.4 lines or a short
    line ending a sentence is a paragraph; hyphens at line and page ends
    rejoin; lines recurring in the top/bottom two of ≥30% of pages are
    running heads. Two-column pages read left then right, with anything
    above the first full-length column line as a header (a short author
    line split by the gutter otherwise lands mid-column). Rotated runs
    (arXiv's margin stamp), type under 0.85x body (labels, footnotes),
    mostly-not-words lines and `Figure N.` captions are dropped; a caption
    is skipped to the next paragraph break and the sentence around it
    rejoins. Chapters: the shallowest bookmark level with ≥2 entries, else
    headings (≥1.45x type, or ≥1.12x and numbered or a standard section
    name: "Jian Sun" in 12 pt was a chapter until that rule), else
    fromText. No text at all is refused as scanned (OCR first).
    check-audiobook: synthetic pages in Node (incl. two columns) and two
    real PDFs through the page (one written by the check with bookmarks,
    one printed by `cupsfilter`). A real ResNet paper gave Abstract, the
    four sections and References; that one is not in the check.
  - **Word (.docx)**: `ASBook.fromDocx` reads word/document.xml (runs,
    tabs, breaks; `Heading1-3`/`Title` styles, whose ids are English in
    every language, become "#" chapters). `ASBook.readFile(file)` is the one
    browser entry point for every format, used by the audiobook page and by
    /text-to-speech's "Open a file" (first 20,000 characters, cut at a
    paragraph, with a pointer to the audiobook maker past that).
- **/dictation** (`js/dictation-vad.js` = `ASVad`): phrases split on an
  adaptive floor (+10 dB, 700 ms hang, 300 ms pre-roll, 25 s cap) and sent
  to the unmodified `transcribe-worker.js`. **The AudioContext is made inside
  the click, before `await getUserMedia`**: made after the permission
  prompt it stayed suspended and delivered zeros.
- **/video-dubbing** (`js/dub-plan.js` = `ASDub`): Whisper (translate or
  transcribe) → lines → Kokoro, a line that overruns its slot re-read up to
  1.3× with Kokoro's own speed input, original ducked 18 dB under lines,
  picture stream-copied by ffmpeg.
- **"Add speech…" in the editor** (`js/editor-speech.js`, Project and track
  menus): tts-worker.js → a tagged 16-bit WAV → the editor's own
  `importFiles`, so autosave/undo are the import path's. It goes on the
  selected track only if that track is empty for the speech's length at the
  playhead, else on a new track: importFiles' "at" placement carves.
  `tools/check-editor-speech.js` (Kokoro q8 from the cache) checks both
  placements, the export, the stored tag and undo. **Do not
  `deleteDatabase('audiosaw-editor')` from a check while the editor is
  open**: the delete waits for the editor's connection and every later
  `open()` queues behind it, which hung the first version of that check.
- **Live voice changer** (`js/voice-live.js`, the second section of
  /voice-changer): one AudioWorklet (Blob URL) does a delay-line pitch shift
  (two read heads 40 ms apart, sin²/cos² crossfade), ring mod, two RBJ
  biquads, drive and bit-crush, and posts its own output blocks when
  recording, so the MP3 is exactly what is heard. No formant hold live (the
  page says so). check-voice drives it with a fake 200 Hz sawtooth
  getUserMedia: Deeper records at 158.7 Hz (0.0 cents), no-effect at 200.
  Other apps cannot use a tab as a mic; the page names virtual cables
  (VB-CABLE, BlackHole) as untested-by-us, and Voicemod.
- **Voice changer video in, video out:** "keep the picture" (on) muxes the
  changed voice beside the copied picture stream (`remux` in
  voice-changer.js, `runFFmpeg` with an extra WAV). MOV/MKV keep their
  container, WebM becomes MP4 (no working libopus). check-voice's video
  case: frames 125/125, length to 0.01 s, Deeper measured -394 cents of
  -400.
- **Isolation:** /text-to-speech and /dictation are cross-origin isolated
  (threads). /text-to-audiobook and /video-dubbing are **not**, because they
  need ffmpeg and `/vendor/ffmpeg/*` has no COEP header; their CPU path is
  one thread.
- **Checks:** check-tts (Kokoro files in `~/.cache/audiosaw/kokoro`,
  `TTS_DOWNLOAD=1` fetches them), check-voice, check-audiobook,
  check-dictation and check-dubbing all run in check-all. The last two drive
  their pages only with `DICTATION_BROWSER=1` / `DUBBING_BROWSER=1` (Whisper
  from the network, kept in the `~/.cache/audiosaw/chrome-dictation`
  profile). Chrome's `--use-file-for-fake-audio-capture` delivered only
  zeros headless, so the dictation test replaces `getUserMedia` with a
  MediaStream playing a `say` recording.
- **Languages:** 41 voices. es/fr/it/pt-br/hi go through the full
  espeak-ng wasm (`vendor/espeak/`, 17.6 MB, GPL-3.0, loaded only for those
  voices), text passed as a UTF-8 file with `-f` (as an argument, accented
  letters came out as Latin-1 garbage). `tools/measure-tts-langs.js` (not in
  check-all) reads each back with Whisper: es and pt word for word, fr/it miss
  only numbers written as digits, hi correct but transcribed in Urdu script.
  The English fix-ups (r → ɹ) are not applied to them: they cost Portuguese 20%.
- **Dubbing timing:** Whisper stamped a sentence that starts at 1.0 s as
  0.00; `ASDub.snapStarts` moves each line to the first real speech in it.
- **/voice-cloning** (`js/clone-worker.js`, `js/clone-page.js`):
  Chatterbox Turbo (Resemble AI, MIT) through transformers.js 4.2.0 on
  WebGPU, q4f16, ~560 MB, gated on a consent box, files tagged as a cloned
  voice. check-clone (Whisper from the local mirror) needs both clones
  intelligible (measured 94-100% of the words over repeated runs, on a male
  and a female `say` reference), each clone's pitch nearer its own reference
  than the other's, and the tag. About 4.5x the speech's length on an Apple
  GPU (a 4 s line in ~17 s), nearly all of it the decoder. Traps, each
  measured against Resemble's Python reference on the same files (CPU,
  word-perfect every run):
  - ORT 1.22 cannot create its sessions; ORT 1.26 (transformers.js) can.
  - embed_tokens routes the LAST TWO ids to the speech table; a one-id step
    asks the text table for zero rows and WebGPU rejects the dispatch, so a
    single id is sent as [text pad, id, id]. The text must end 50256 50256.
  - The language model is NOT the problem, though it looked like it: its
    logits differ from the CPU's by 0.5-0.8 and near-ties swap (13/19 agree
    teacher-forced, in q4, q4f16 and fp16 alike; every op matches the CPU in
    isolation), yet its tokens, decoded by Python, transcribe word for word.
  - The decoder is: past 65,535 samples it writes zeros, and its words
    degrade with the new tokens per call (8-10 perfect on both voices, 12
    slips, 25 wrong, 50 gibberish). Tokens are decoded 10 at a time with a
    2-token crossfade, each window carrying the WHOLE reference prompt:
    trimmed to its last 30 or 60 tokens it was fine in Python and garbled on
    WebGPU. So the page caps the reference at 5 s of speech instead, which is
    what bounds the decode cost (a 6 s reference decoded twice as slowly as
    a 4 s one). The decoder starts from noise, so renders vary slightly run
    to run; that is why check-clone runs two voices.
  - The browser's CPU build runs none of these models (no
    GatherBlockQuantized kernel in q4, q4f16 or q8).
- **Speaker labels on /audio-to-text** (`js/diarize.js` = `ASDiar`,
  `js/diarize-worker.js`): pyannote segmentation-3.0 (MIT, 6 MB) marks speech
  and voice changes, WeSpeaker ResNet34 (CC-BY-4.0, 26.5 MB, credited on the
  page) embeds each turn of 0.5 s or more, and average-linkage cosine
  clustering groups them: to the count chosen, or on Auto to a 0.45 distance
  then folding any speaker under 8% of the speech into its nearest. Both on
  the CPU through transformers.js. Segmentation alone merged two women's
  voices (68%); with embeddings, check-diarize measures 99.7% of the speech
  labelled right with two `say` voices and 92.0% with three over 3 minutes,
  and Auto counts both right (0.4 split the pair in three, 0.5 merged the
  trio). Whisper segments take the speaker who talks most inside them; the
  transcript gets "Speaker n:" paragraphs (renamable) and subtitles the name
  at each change.
- **Re-voicing** on /video-dubbing works in es/fr/it/pt-br/hi as well as
  English (a Spanish case in check-dubbing).
- **Dubbing into es/fr/it/pt-br/hi** ("Dub it: Into Spanish", task value
  `to:<lang>`): Whisper translates to English, then `js/translate-worker.js`
  (a classic worker) runs Helsinki OPUS-MT, and the voice and per-speaker
  defaults switch to that language's Kokoro voices. Each line shows its
  English underneath.
  - **The runtime is ORT 1.22, not transformers.js.** ORT 1.26 refuses every
    8-bit OPUS-MT export with the same "TransposeDQWeightsForMatMulNBits
    Missing required scale" that pinned Whisper to q4, and the q4 files are
    ~300 MB a language against ~113. ORT 1.22 loads the 8-bit ones.
    `js/marian.js` (`ASMarian`, UMD) is the decode loop (encoder, then the
    merged decoder with its KV cache, 4-beam search). transformers.js is
    imported only for its tokenizer. `ort.min.js` declares a module-scoped
    `var ort`, so the worker is classic (`importScripts`) with a dynamic
    `import()` for transformers.js.
  - **The language tag must be one token.** For en-ROMANCE, `>>es<<` typed
    into the text is split into pieces and ignored (output came back in
    a mix of languages); `tok.convert_tokens_to_ids(tag)` goes in front.
  - **One model per language**: en-es, en-fr, en-it, en-hi, and en-ROMANCE
    with `>>pt_BR<<` (there is no en-pt export). ROMANCE for all four
    drifted into French mid-Italian; the dedicated en-it did not.
  - **One sentence at a time** (`ASMarian.sentences`): given two at once,
    the Spanish output dropped the first.
  - The start/pad ids come from each model's config.json (ROMANCE 65000,
    en-hi 61949).
  - **Checked by** `tools/check-translate.js`: each language's key words
    per line, no other language mixed in, no sentence dropped, and the
    same output twice. Models are in the mirror (`TRANSLATE_DOWNLOAD=1`
    fetches ~620 MB once). It measured about 1 s a line on one thread,
    which is what the page gets: /video-dubbing is not isolated. Also
    check-dubbing's into-Spanish case (DUBBING_BROWSER=1): an English
    `say` video, dubbed into Spanish and heard back by Whisper in Spanish.
- **/add-subtitles-to-video** (`js/subtitle-page.js`): captions from
  Whisper (transcribe-worker.js) or the user's SRT/VTT (`ASSubs.parse`),
  "short" 3-5 word captions (`ASSubs.split`, spread by length, not word
  times), an editable list previewed through a `<track>`, then either
  burned in (ffmpeg `subtitles` filter: this core has libass, freetype and
  fribidi; Noto Sans SemiBold TTF from `vendor/fonts/` written beside the
  SRT, `fontsdir=.`; x264 superfast CRF 20, audio copied) or added as a
  track (stream copy; mov_text/srt/webvtt by container). Measured
  (check-subtitles, idle): 30 s of 720p burned in ~21 s with superfast;
  under load average 30+ the same took 56 s (veryfast 78), so do not
  quote a loaded run;
  the caption drawn only inside its cue; audio packets identical; the soft
  track reads back. **The font bytes must be copied per burn**: ffmpeg's
  writeFile transfers the buffer, and the second burn found it detached.
  Latin/Greek/Cyrillic only (no HarfBuzz shaping tested; CJK needs a 16 MB
  font).
- **Dubbing in the speaker's own voice** ("use each speaker's own voice",
  English output on WebGPU only; the box is the consent): `cloneAll` in
  dubbing-page.js cuts ~5 s of each speaker's own longest lines from the
  original as the reference, encodes it once per speaker, and runs every
  line of theirs through clone-worker.js. Chatterbox has no speed input,
  so an overlong line is fitted with `ASVoice.stretch` (PSOLA at the same
  pitch; check-voice: 1.300x, 2.3 cents). A speaker with under 3 s falls
  back to a Kokoro voice. The dub MP3 is tagged (cloned or synthetic).
  check-dubbing `DUB_ONLY=own` (DUBBING_BROWSER=1, Chatterbox cached): a
  woman's clip dubs at a median 171 Hz (default voice ~120), 6-8 of 8 key
  words back from Whisper. ID3 comments are UTF-16: search both alignments.
- **Per-speaker dubbing:** "a different voice for each speaker" runs the same
  diarization; `ASDub.merge` never joins lines across a change of speaker,
  and voices default to alternating man/woman. check-dubbing's two-person case
  (DUBBING_BROWSER=1): both found, voices alternate, the man's lines 122 Hz
  vs the woman's 197.

## The stem splitter

The model runs at 44.1 kHz, but the stems go back to the file's own rate and
channel count (`toNative` in stem-separator.js). The vocal is resampled up,
and the instrumental is the original, at its own rate, minus that vocal. So
the two still sum to the source, and content above 22 kHz stays in the
instrumental. check-fidelity tests this with a stand-in worker, since the
64 MB model is too heavy for a check.

`/stem-splitter` runs neural source separation through onnxruntime-web. Three
things about it are load-bearing:

**It uses MDX-Net, not Demucs, and that is not a preference.** The Demucs ONNX
export is 158 MB; ONNX Runtime Web grinds for two minutes and then dies with
`Aborted()` inside the WebAssembly heap. MDX-Net is 64 MB, creates a session in
about two seconds, and separates the vocal/instrumental boundary most people
want. Do not "upgrade" it to Demucs without re-testing that it loads at all.

**The page is cross-origin isolated, and the worker script needs its own COEP
header.** A dedicated worker spawned from an isolated page must itself be served
with a compatible `Cross-Origin-Embedder-Policy`, or `new Worker()` fails with an
opaque error before the script's first line — which looks exactly like a broken
script. See the `/js/stem-worker.js` rule in `_headers`. Isolation is scoped to
this page only; applying COEP site-wide would break the analytics and AdSense
embeds everywhere else.

**Threads are set per backend.** On the WebGPU path `numThreads` must be 1 —
asking for a WASM thread pool there stalls session creation and buys nothing
when the compute is on the GPU. The CPU fallback does ask for threads, and needs
them: measured, one chunk takes ~140 s on a single thread and ~45 s on seven.

For those threads to work, `/vendor/ort/*` must carry a COEP header too, not
just `/js/stem-worker.js`. ORT spawns its pthread workers from those files, and
a nested worker needs COEP exactly as much as the top-level one. Without it,
`numThreads > 1` hangs session creation forever — the CPU fallback looked
completely broken until that header was added.

Measured on one machine (Apple GPU, 8 cores), per 5.9 s chunk:

| Backend            | Session | Per chunk | vs realtime |
|--------------------|---------|-----------|-------------|
| WebGPU             | 2.5 s   | 2.9 s     | ~1.1x       |
| WASM, 7 threads    | 2.0 s   | 45 s      | ~10x        |
| WASM, 1 thread     | 2.5 s   | 140 s     | ~31x        |

Both backends produce numerically identical output; only the wait differs.

`js/spectral.js` provides the STFT the model needs (n_fft 6144, which is 3x2048
and so needs a radix-3 stage over the radix-2 kernel). It is validated against a
numpy reference — the browser output matches a Python implementation of the same
pipeline to six decimal places. If you change it, re-run that comparison; a
subtly wrong STFT produces audio that sounds plausible but separates badly.

## If AI-assistant traffic disappears, check Cloudflare first

Answer engines are the largest referral channel here, and they were once being
403'd at the edge for weeks. The cause was Cloudflare's **"Block AI bots"**
feature (Security → Settings → Bot traffic), which deploys a managed rule named
*Manage AI bots* from the *Cloudflare Bot Management rules for all plans*
ruleset.

It is easy to miss: it does not appear under Security → Security rules, it has
no on/off switch of its own — only a "Blocks AI Bots scope" configuration line —
and every other bot toggle can be off while it is still blocking. It also blocks
the *retrieval* agents (`ChatGPT-User`, `OAI-SearchBot`, `Claude-User`,
`PerplexityBot`), not just training crawlers, despite what its description says.

To diagnose: Security → Analytics → Events shows the exact ruleset and rule for
each blocked request. To confirm from a shell:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -A "Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)" \
  https://audiosaw.com/
```

robots.txt cannot override this — the block happens at the edge, before robots
is ever consulted.
