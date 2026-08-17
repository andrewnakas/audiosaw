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

```bash
# after editing js/ or css/
grep -rl '?v=2026-08-14' *.html | xargs sed -i '' 's/?v=2026-08-14/?v=2026-09-01/g'
```

**2. On a tool page, the `/js/*` includes must come before the page's own
inline `<script>`.**

The bespoke inline tools call `CV.bindDropzone()` at top level. If the includes
sit below them, that throws `ReferenceError: CV is not defined` and the dropzone
never binds — the page looks fine and does nothing. This shipped on nine pages
for months. Each inline block now starts with a guard that logs loudly if the
order is wrong. On pages using `tool-converter.js`, the `window.AS_TOOL = {...}`
config must still come before that file.

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
3. Run the generators:

```bash
node tools/build-nav.js      # footer directory, related blocks, breadcrumbs, /tools
node tools/build-sitemap.js  # sitemap.xml with lastmod from git
node tools/build-llms.js     # llms.txt
```

`js/tool-graph.js` is the single source of truth — both Node and the browser
read it. Nothing else should hardcode the list of tools.

The generators are idempotent; everything they write sits between `<!-- AS:name -->`
markers and gets replaced, not duplicated. Do not hand-edit inside those markers.

**Write real content.** Eight pages once shipped the same paragraphs with the
format name swapped and Google indexed none of them. Aim for 700–900 unique
words: what actually changes, when you'd want it, which settings matter, and
what you lose. Name real hardware and software.

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

GA4 `G-5X9ERMVYXE`. Key events: `convert_success`, `next_step_click`,
`chain_continue`. Never send filenames or raw exception strings — bucket sizes
and enumerate error types (see `mbBucket` and `ERROR_KINDS` in `flow.js`).

Search Console property is the URL-prefix `https://audiosaw.com/`, verified via
the GA tag. Removing the gtag snippet would break verification.

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
