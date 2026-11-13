Honeydew 0.5.3 web build (https://github.com/daijro/honeydew), by daijro and
the Honeydew contributors. GPL-3.0-or-later (LICENSE). The corresponding
source is that repository at tag v0.5.3; `tools/web-dist.sh` there builds
this.

From `honeydew-web-0.5.3.zip` in the v0.5.3 GitHub release. Each file here was
pulled from that archive and its CRC-32 checked against the archive's own
directory; the app also checks every sound pack's SHA-256 against the index.

Unmodified: the .js, the .wasm, snippets/, the icons, content/CREDITS.txt and
the packs in content/p/.

Ours:
- `frame.html`: upstream's index.html without the wrapper that fetches a
  pre-gzipped .wasm.gz (Cloudflare Pages compresses the plain .wasm itself),
  plus a `postMessage` to the embedding page when the app has started or the
  browser has no WebAssembly SIMD, and a noindex tag.
- `content/index.json`: upstream's index cut down to 54 of its 143 entries
  (all 7 drum kits, 16 one-shot sets, 31 instruments of 1.4 MB or less, and
  the VCSL upright piano), 49 MB of packs instead of 740. Entries are
  otherwise untouched, so the app lists and loads only what is hosted. The
  credits table is cut to the sources those entries use; CREDITS.txt is whole.

/honeydew loads frame.html in an `<iframe sandbox="allow-scripts
allow-downloads">`: an opaque origin with no access to audiosaw.com's
storage, which is why `_headers` sends `Access-Control-Allow-Origin: *` for
this folder and why the app keeps nothing between visits.

An upgrade goes in a new version folder (/vendor is cached immutable).
