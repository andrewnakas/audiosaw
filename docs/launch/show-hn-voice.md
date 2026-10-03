# Show HN: the voice tools

A second, separate Show HN, and probably the stronger one to lead with: the
voice work (cloning, dubbing, transcription with speaker labels, captions,
denoising) is what is new, and "it runs in a browser tab" is a claim HN will
test and find true. Same rules as [show-hn.md](show-hn.md): post at
**08:00–10:00 ET, Tuesday to Thursday**, submit the URL, then post the text
below as the first comment. Do not post both within a few months of each
other; pick this one first.

Submit: `https://audiosaw.com/voice-cloning`

## Title

79 characters:

> Show HN: Voice cloning, dubbing and captions that run entirely in a browser tab

Alternatives:

> Show HN: I got Chatterbox voice cloning running on WebGPU in the browser  (73)
>
> Show HN: A local ElevenLabs-style voice studio, as static web pages  (68)

## First comment

> These all run in the tab: no server, no account, nothing uploaded. The site
> is static files; the models download once from Hugging Face and are cached.
>
> - Text to speech with Kokoro-82M (41 voices, 7 languages, MP3 out, batch mode)
> - Voice cloning from 5 seconds of audio with Chatterbox Turbo on WebGPU
> - Transcription with Whisper, with speaker labels (pyannote segmentation +
>   WeSpeaker embeddings + clustering, all in the browser)
> - Video dubbing into six languages, optionally in each speaker's own cloned voice
> - Burned-in captions (libass inside ffmpeg.wasm), word-timed
> - An AI denoiser (RNNoise), and a live mic voice changer in an AudioWorklet
>
> The interesting part was everything that broke:
>
> **Chatterbox's decoder on WebGPU.** Past 65,535 output samples it writes
> zeros, and its intelligibility degrades with the number of new speech tokens
> per call: 8–10 tokens decode perfectly, 25 change words, 50 is gibberish. The
> language model looked guilty for days, but its tokens, decoded in Resemble's
> Python reference, transcribe word for word. The fix is decoding 10 tokens at a
> time with a 2-token crossfade, each window carrying the whole reference
> prompt (trimming the prompt was fine in Python and garbled on WebGPU). Clones
> come out 94–100% intelligible by Whisper. Its embedding graph also routes the
> last two ids to the speech table, so a one-id step asks the text table for
> zero rows and WebGPU rejects the dispatch; single ids go in as
> [pad, id, id].
>
> **ONNX Runtime versions.** transformers.js 4.2 bundles ORT 1.26, which
> refuses every 8-bit export I tried with "TransposeDQWeightsForMatMulNBits
> Missing required scale". Whisper got around it with q4 weights, but for
> translation (OPUS-MT) the q4 files are 300 MB a language against 113, so the
> translation worker runs the 8-bit models on ORT 1.22 with a hand-written
> beam search over the merged decoder's KV cache, and borrows only the
> tokenizer from transformers.js. Kokoro is on ORT 1.22 too, and its fp16
> weights give wrong audio inside a worker on WebGPU while looking fine on
> the main thread.
>
> **Whisper's word times run late.** The cross-attention word timestamps came
> out 120–340 ms after the truth on words placed at known positions, so the
> captions shift them by 0.26 s; on a held-out voice that leaves every word
> within about ±70 ms.
>
> **Cross-origin isolation.** Threads need SharedArrayBuffer, so the heavy
> pages are COOP/COEP isolated, and every worker *and* every nested pthread
> worker ORT spawns needs its own COEP header, or `new Worker()` dies before
> its first line with an error that looks exactly like a broken script.
>
> Each of these has a check in the repo that re-measures the number (headless
> Chrome, models served from a local mirror).
>
> Honest limits: cloning is English only and needs WebGPU (desktop Chrome or
> Edge); it is a likeness, not a copy. Voice-to-voice conversion didn't make it:
> decoding a recording's own speech tokens through the WebGPU decoder loses
> about half the words, even re-decoding a voice as itself. Dubbing is
> voice-over, not lip-sync. The first visit downloads models (Kokoro 92–326 MB,
> Whisper 90–285 MB, Chatterbox ~560 MB).
>
> Source: https://github.com/andrewnakas/audiosaw (AGPL-3.0). The voice
> features are browser rebuilds of what VoiceStudio does as a desktop app.

## Questions HN will ask

**"Isn't voice cloning in a browser a deepfake machine?"**
> It asks you to confirm the voice is yours or used with permission, tags every
> file it writes as a cloned voice in its metadata (a label, not a watermark, and
> the page says so), and needs five seconds of clean audio of the person. That is
> the same bar as every cloud service, minus sending the voice anywhere.

**"How fast is it?"**
> On an Apple laptop GPU: Kokoro about half the speech's length, Whisper base
> about a sixth of real time, Chatterbox about 4.5× the speech's length (a 4 s
> line in ~17 s). On the CPU everything is several times slower, and cloning
> doesn't run at all (no kernel for its quantised gather in the CPU build).

**"Why not just use the ElevenLabs API?"**
> Cost per character, an account, and the audio leaving your machine. For a
> narration or a dub you check once, a model that runs locally is enough.

**"Which models, which licences?"**
> Kokoro-82M (Apache-2.0), Chatterbox Turbo (MIT), Whisper (MIT), pyannote
> segmentation-3.0 (MIT), WeSpeaker ResNet34 (CC-BY-4.0), OPUS-MT (CC-BY-4.0),
> RNNoise (BSD; Apache-2.0 wasm build), Noto fonts (OFL). All credited on the
> pages that use them.
