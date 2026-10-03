# RNNoise (Xiph), WebAssembly build by Shiguredo (Apache-2.0, LICENSE)

`@shiguredo/rnnoise-wasm` 2025.1.5, `dist/rnnoise.js` unmodified: an ES
module with the wasm inside. Imported by `js/rnnoise-worker.js` (a module
worker) for /noise-reduction's AI method. Browser/worker only (it checks for
window or WorkerGlobalScope). `/vendor/*` is immutable for a year: bump the
`?v=` in rnnoise-worker.js when upgrading.
