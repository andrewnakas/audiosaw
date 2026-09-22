# Show HN

Post at **08:00–10:00 ET on a Tuesday, Wednesday or Thursday**. Avoid Friday
and the weekend. Submit the URL as `https://audiosaw.com`, then post the text
below as the first comment yourself.

## Title

Hacker News truncates around 80 characters. This is 76:

> Show HN: In-browser stem splitter, autotune and 59 audio tools, no upload

Alternatives, if the first reads as a list:

> Show HN: I put a neural stem splitter in the browser so files never upload
>
> Show HN: 59 audio tools that run entirely in your browser, no server

**Do not** write "free" in the title. On HN it reads as marketing, and the
first comment establishes it anyway.

## First comment

> I got annoyed that every free audio converter wants you to upload your file
> to someone's server and wait in a queue, for an operation the browser has
> been able to do locally for about a decade. So I built the version that
> doesn't. It's static files on a CDN — there is no backend, and there's
> nothing to sign up for.
>
> The parts that were actually hard:
>
> **Stem separation.** MDX-Net running in ONNX Runtime Web, WebGPU with a
> threaded WASM fallback. I started with Demucs and abandoned it — the ONNX
> export is 158 MB and ONNX Runtime Web grinds for two minutes before dying
> with `Aborted()` inside the WASM heap. MDX-Net is 64 MB and creates a session
> in about two seconds. On an Apple GPU it does a 5.9 s chunk in 2.9 s; on
> seven CPU threads, 45 s; on one thread, 140 s. Both backends produce
> numerically identical output, only the wait differs.
>
> **The threading, which cost me a day.** A dedicated worker spawned from a
> cross-origin-isolated page has to itself be served with a compatible COEP
> header, or `new Worker()` fails with an opaque error before the script's
> first line. It looks exactly like a broken script. Worse, ORT spawns its own
> pthread workers from the vendored runtime files, so *those* need the header
> too — without it, `numThreads > 1` hangs session creation forever and the CPU
> fallback appears completely broken.
>
> **The STFT.** The model needs n_fft 6144, which is 3×2048, so there's a
> radix-3 stage over the radix-2 kernel. I validated it against a NumPy
> implementation of the same pipeline and required six decimal places, because
> a subtly wrong STFT produces audio that sounds plausible and separates badly
> — which is the worst kind of bug to chase.
>
> Other things I'd point at: the loudness normalizer implements ITU-R BS.1770-4
> and is checked against FFmpeg's `ebur128` within 0.1 LU (true peak has to be
> measured on the buffer you actually write, not the 48 kHz copy you measured
> loudness on — resampling moves inter-sample peaks, and measuring both on the
> resampled copy overshot a -1 dBTP ceiling by 0.2 dB). The autotune places its
> pitch marks on a low-passed copy, because peak-picking a bright waveform
> lands on a different feature each cycle; when I got that wrong the output
> dropped two octaves.
>
> Honest limits: it's a single-file utility, not a DAW. Big files are bounded
> by browser memory, around 500 MB and less on iOS Safari. Audio-to-MIDI is
> monophonic only — polyphonic transcription is an open research problem and
> the page says so rather than letting you find out. And the stem splitter is
> genuinely slow without a GPU.
>
> Source: https://github.com/andrewnakas/audiosaw (AGPL-3.0)
>
> Happy to go into any of it.

## Questions HN will ask, with answers

**"How is this different from [X]?"**
> Most of the browser-based ones are a thin wrapper that uploads anyway — worth
> checking the network tab. The ones that genuinely run locally usually do
> format conversion only; the separation, loudness and pitch work is where this
> goes further. Against the desktop tools (Audacity, UVR) it is strictly less
> capable and strictly more convenient. It is for the job you do once, not the
> one you do every day.

**"What's the business model / what's the catch?"**
> There isn't one. AdSense used to load on 55 pages and I never placed a single
> ad unit, so it was pure cost to the visitor — I removed it. The site is
> static files and your computer does the work, so there's nearly nothing to
> pay for. If that changes I'd rather say so than quietly add tracking.

**"Does it really not upload? Prove it."**
> Open devtools, drop a file, watch the network tab: nothing goes out. Or turn
> off the wifi after the page loads — everything except the first FFmpeg core
> download keeps working. The service worker makes that true on a return visit
> too.

**"Why AGPL and not MIT?"**
> Because the obvious way to exploit this is to host a copy with ads and a
> signup wall, and the network clause is the one that addresses that. If you
> want to reuse a specific module under other terms, ask.

**"Why not WebCodecs instead of FFmpeg in WASM?"**
> WebCodecs is excellent where it's supported and covers a narrower set of
> containers than people actually have. The WASM core is 30 MB once, cached
> afterwards, and handles everything. There's a fast path that skips it
> entirely for MP3 and WAV.

**"The UI is ugly / it looks like 2005."**
> Fair. It's one person's taste and no framework. If something is genuinely
> unusable rather than just plain, that's a bug and I'd like the report.

**"Did an AI write this?"**
> Parts of it, with me driving and checking. The measurements in the comment
> above are real numbers from real runs, which is the part that matters.

**"Privacy policy says you use Google Analytics."**
> It does, and that is the one thing that touches a third party. Consent is
> region-aware, the footer has a permanent opt-out, and no filename or
> exception string is ever sent — file sizes are bucketed and error types
> enumerated. The audio itself cannot be sent because it never reaches a
> server.

## Rules

- Never ask for upvotes, anywhere, including in a DM. It gets the post buried
  and can get the domain banned.
- Reply to everything in the first four hours, including the rude ones, and
  concede real points rather than defending.
- If it doesn't take off, leave it. Reposting the same URL within a few months
  is against the norms and HN staff notice.
