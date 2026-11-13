SoundCraft 0.20.1 web build (https://github.com/storytold/soundcraft), by
ArtCraft. Apache-2.0 (the release also carries LICENSE-MIT; NOTICE and
ATTRIBUTION.md list what it is built from).

Source: `soundcraft-web-0.20.1.zip` from the v0.20.1 GitHub release, SHA-256
ca7c03c53cf4b7ec9ae26ef2cbde5d86566d006127040fe694fb95f9773a34e4, which matches
the release's SHA256SUMS.txt. The .js, .wasm and snippets/ are unmodified;
the zip's index.html, README, HOSTING.md and sample server configs are left
out.

`frame.html` is ours: the zip's index.html plus a `postMessage` to the embedding page
when the app has started, and a noindex tag. /soundcraft loads it in an
`<iframe sandbox="allow-scripts allow-downloads">`, so the app runs on an
opaque origin with no access to audiosaw.com's storage or cookies. That is why
`_headers` sends `Access-Control-Allow-Origin: *` for this folder: a module
script fetched from an opaque origin is a CORS request.

An upgrade goes in a new version folder (/vendor is cached immutable), with
frame.html regenerated from the new index.html.
