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
  and WAV; a WebAssembly FFmpeg build, lazily fetched, for m4a/aac/ogg/flac and
  video demuxing. Both are hot-linked from CDNs.
- `js/common.js` — `window.CV`. Dropzone binding and UI helpers.
- `js/flow.js` — post-conversion behaviour and analytics. Works by wrapping
  `CV.downloadBlob` and `CV.setStatus`, which every tool on the site funnels
  through, so it reaches all pages without per-page code. If you write a new
  tool, call those two functions and you get the next-step panel, the preview,
  error recovery and event tracking for free.
- `js/tool-converter.js` — the shared driver for simple format conversions.

## Analytics

GA4 `G-5X9ERMVYXE`. Key events: `convert_success`, `next_step_click`,
`chain_continue`. Never send filenames or raw exception strings — bucket sizes
and enumerate error types (see `mbBucket` and `ERROR_KINDS` in `flow.js`).

Search Console property is the URL-prefix `https://audiosaw.com/`, verified via
the GA tag. Removing the gtag snippet would break verification.
