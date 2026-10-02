# pdf.js (Mozilla, Apache-2.0)

`pdfjs-dist@6.3.289`, the **legacy** build (`legacy/build/pdf.min.mjs` and
`pdf.worker.min.mjs`), unmodified. Used by /text-to-audiobook to read the text
layer of a PDF (`js/audiobook-page.js` imports it only when a PDF is dropped).
The legacy build is the one that runs on older Safari.

`/vendor/*` is cached immutable for a year, so the importing code carries
`?v=6.3.289`; bump it when upgrading. No cMaps or standard fonts are vendored:
text extraction of Latin-script PDFs does not need them, and the voices do not
speak CJK.
