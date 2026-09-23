# AudioSaw

Free audio tools that run entirely in your browser. A multitrack audio editor,
plus single-purpose tools to convert, cut, join, normalise, transcribe pitch to
MIDI, split stems with a neural network and record from a microphone — with no
upload, no account, no watermark and no queue.

**[audiosaw.com](https://audiosaw.com)** · 61 tools · no ads · works offline

The file never leaves your machine. There is no server to send it to: the site
is static files on a CDN, and every byte of processing happens in the tab using
the Web Audio API and a WebAssembly build of FFmpeg. You can disconnect from
the network after a page loads and it still works.

## Why it exists

Every free audio converter on the web asks for the same thing: upload your file
to someone's server, wait in a queue, and accept whatever they do with it. For
a format conversion that is an absurd trade. Browsers have had the codecs and
the compute to do this locally for a decade.

So there is no signup, no size gate behind a paywall, and no "Pro" tier holding
back the useful settings. There is nothing to monetise, because there is almost
nothing to run — no conversion servers exist to pay for.

## What is actually interesting in here

Most of the 61 pages are ordinary format conversions. These are not:

| | |
|---|---|
| [`js/editor-*.js`](js/editor-ui.js) | [/audio-editor](https://audiosaw.com/audio-editor): a non-destructive multitrack editor that works with touch and mouse. Clips are windows onto immutable sources, so undo is a stack of small JSON snapshots; playback and export build the same Web Audio graph, so the file matches what you heard; recording goes through an AudioWorklet on the playback clock and is placed using the latency the browser reports. The model is pure and runs in Node against a thousand random edits. |
| [`js/stem-separator.js`](js/stem-separator.js), [`js/stem-worker.js`](js/stem-worker.js) | Neural source separation (MDX-Net) via ONNX Runtime Web, WebGPU with a threaded WASM fallback. ~2.9 s per 5.9 s chunk on an Apple GPU; 45 s on seven CPU threads. |
| [`js/spectral.js`](js/spectral.js) | The STFT the model needs — n_fft 6144, so a radix-3 stage over the radix-2 kernel. Validated against a NumPy implementation of the same pipeline to six decimal places. |
| [`js/loudness.js`](js/loudness.js) | ITU-R BS.1770-4 integrated loudness and true peak, checked against FFmpeg's `ebur128` filter and required to agree within 0.1 LU. |
| [`js/autotune.js`](js/autotune.js) | PSOLA pitch correction. The pitch marks are placed on a low-passed copy, because peak-picking a bright waveform lands on a different feature each cycle — measured, that dropped the output two octaves. |
| [`js/pitch-track.js`](js/pitch-track.js), [`js/midi-write.js`](js/midi-write.js) | YIN pitch detection into a Standard MIDI File. YIN rather than plain autocorrelation because autocorrelation's strongest peak is routinely at twice the true period. |
| [`js/silence-gaps.js`](js/silence-gaps.js) | Shortens the pauses between phrases without clicks at the joins. The threshold comes from the recording's own noise floor, because the right value differs by ~30 dB between a treated booth and a kitchen table. |
| [`js/slowed-reverb.js`](js/slowed-reverb.js) | Convolution reverb from a synthesised impulse, with independent noise per channel so the tail does not collapse to the centre of the stereo image. |

## Testing

The DSP is checked by scripts that parse the output back with a reader written
separately from the writer, so a mistake in one does not cancel out in the
other:

```bash
node tools/check-loudness.js   # against ffmpeg ebur128, within 0.1 LU
node tools/check-midi.js       # round-trips MIDI through an independent parser
node tools/check-autotune.js   # off-pitch note lands on target, in-tune note untouched
node tools/check-silence.js    # no speech truncated, no clicks at the joins
node tools/check-editor.js     # editor model: undo exact, no overlaps after 1,000 random edits
node tools/check-all.js        # generated files current, every page has its scripts
```

## Running it locally

There is no build step and there are no dependencies. Serve the directory:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`. That is the whole development setup.

Two caveats. `/stem-splitter` needs cross-origin isolation (the COOP/COEP
headers in [`_headers`](_headers)), which a plain static server does not send,
so that page needs a server that does. And the FFmpeg core is fetched from a
CDN at 30 MB the first time, then cached.

## Contributing

Issues and pull requests are welcome. Two rules that will save you time:

1. **Test the format before you write the page.** Feed a real file through
   `AudioSaw.convert` in a browser and confirm it decodes. A bad `-f` guess
   once produced a 460-byte "m4r" that looked like a site bug.
2. **Claim only what you measured.** The AC3 page says the centre channel sits
   about 4 dB down in the stereo downmix because that was measured with a 5.1
   file carrying a separate tone per channel, not because a coefficient table
   said so.

[`CLAUDE.md`](CLAUDE.md) documents the architecture and the traps in more
detail than this file does.

## Licence

[GNU AGPL-3.0](LICENSE). If you run a modified version as a network service,
the licence requires you to offer its source to the people using it.

Vendored third-party code under `vendor/` keeps its own licence:
[ONNX Runtime Web](https://github.com/microsoft/onnxruntime) (MIT),
[lamejs](https://github.com/zhuker/lamejs) (LGPL),
[ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) (MIT) — note that the
FFmpeg **core** it loads is a GPL build, because it includes libx264.
