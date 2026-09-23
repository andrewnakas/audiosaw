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

## Architecture

- `js/audio-core.js` — `window.AudioSaw`. Web Audio fast path for MP3 (lamejs)
  and WAV; a WebAssembly FFmpeg build, lazily loaded, for m4a/aac/ogg/flac and
  video demuxing.
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
- `js/editor-*.js` — `/audio-editor`, the multitrack editor. Five files with one
  job each: `editor-model.js` (pure project model, UMD, runs in Node),
  `editor-engine.js` (Web Audio playback, offline export, AudioWorklet
  recording), `editor-view.js` (canvas timeline and hit testing),
  `editor-fx.js` (effects, which reuse loudness.js, silence-gaps.js,
  slowed-reverb.js, the denoiser that noise-reduction.js now exports as
  `ASDenoise`, and ffmpeg's atempo) and `editor-ui.js` (gestures, menus,
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

  Touch and mouse differ in one deliberate place: a finger on an *unselected*
  clip pans the timeline, because on a phone one clip often fills the screen.
  Tap selects, then drag moves. Playback end and looping are checked from a
  timer as well as the animation loop, because a background tab gets no
  animation frames.
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
promoted. `tool`, `error_type`, `placement`, `rail` and `to_tool` are registered;
`file_ext`, `target_format`, `from_tool` and `pick_method` are not yet. If you
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

A `validation` error kind exists for UI hints like "Selection too short" and is
deliberately **silent** — it fires no event and shows no recovery panel. Those
used to be counted as conversion failures, which buried the real error rate.

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

## The stem splitter

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
