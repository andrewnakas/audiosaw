# Reddit

Reddit is the one channel in this kit where a launch post is the wrong move.
Every relevant subreddit removes self-promotion on sight, and an account whose
history is one link gets filtered before a human sees it.

What works is answering questions that are already being asked. Those threads
rank in Google for years, and they are frequently what an AI assistant is
reading when it recommends a tool.

## Ground rules

- **Never post a bare link.** Answer the question fully, then mention the tool
  as one option among several, naming its limitations.
- **Say it is yours.** "I built this" is fine and expected. Hiding it is what
  gets you banned.
- **Recommend competitors where they are better.** For anything serious and
  repeated, Audacity or Ultimate Vocal Remover genuinely beats a browser tab,
  and saying so is what makes the rest credible.
- Read each subreddit's rules first. Several ban all links regardless of
  context, and for those the answer is still worth writing without one.

## Where to look, and what people ask there

| Subreddit | The recurring question |
|---|---|
| r/podcasting | "How do I get to -16 LUFS?" · "How do I cut the silences?" |
| r/edmproduction, r/WeAreTheMusicMakers | "How do I get an acapella out of a track?" |
| r/audioengineering | "What free tool does X?" — strict, expert, low tolerance for marketing |
| r/chromeos, r/Chromebook | "How do I convert audio without installing anything?" — a genuinely strong fit |
| r/privacy, r/degoogle | "Is there a converter that doesn't upload my files?" |
| r/DJs, r/Beatmatch | "How do I find the BPM / key of this?" |
| r/VoiceActing | "What do I use to clean up a home recording?" |
| r/DataHoarder | batch conversion and tagging |

Search each for the question rather than waiting: sort by new, and also answer
a few well-ranked older threads.

## Three worked answers

### Loudness, for r/podcasting

> -16 LUFS integrated for stereo is the usual target (-19 for mono on some
> platforms), and the important thing is that it is *integrated* loudness over
> the whole episode, not peak. Normalising to -1 dB peak, which is what most
> "normalize" buttons do, gets you nowhere near it — a quiet episode and a
> loud one can both peak at -1 dB and be 8 LU apart.
>
> Auphonic is the standard answer and is very good. Free alternatives:
> FFmpeg's `loudnorm` filter if you are comfortable on a command line, or
> Audacity's Loudness Normalization effect.
>
> I also built a browser one — audiosaw.com/loudness-normalizer — which does
> BS.1770-4 with a true-peak ceiling and runs locally without uploading.
> I check its measurements against FFmpeg's `ebur128` and require agreement
> within 0.1 LU. It handles one file at a time, so for a whole back catalogue
> the command line is still the right tool.
>
> Whichever you use, set a true-peak ceiling of -1 dBTP rather than -0.1. The
> encoder your platform runs can push inter-sample peaks above where your DAW
> says the file sits.

### Acapellas, for a production subreddit

> The free options are better than they were two years ago.
>
> Ultimate Vocal Remover (desktop, free, open source) is the best quality if
> you don't mind installing Python-adjacent software — it runs the same family
> of models the paid services use and you can pick the model.
>
> If you want it in a browser, I built audiosaw.com/stem-splitter, which runs
> MDX-Net locally through ONNX Runtime Web. It downloads a 64 MB model once and
> then separates on your machine — nothing is uploaded. With a GPU it is about
> realtime; without one, roughly ten times realtime, so a four-minute song is a
> few minutes of waiting. UVR on a decent machine beats it.
>
> Whatever you use, the result depends enormously on the mix. Dense, loud
> masters bleed; sparse ones come out almost clean. And if all you need is to
> drop the centre channel — which works only on some older stereo mixes — that
> is instant and needs no model at all.

### Chromebook conversion

> On ChromeOS, anything browser-based that runs locally is the right answer,
> because there is nothing to install and Linux mode is more hassle than the
> job deserves.
>
> I built audiosaw.com for this — drop the file, pick a format, download. It
> uses the Web Audio API and a WebAssembly FFmpeg build, so the conversion
> happens in the tab and the file is never uploaded. Free, no account, and it
> works on a managed school device where you cannot install software, which is
> the case it is genuinely best at.
>
> The limit is memory rather than policy: around 500 MB per file. Anything
> longer, split it first.

## What to expect

A good answer in an active thread sends tens of visitors, not thousands. The
value is the durable Google ranking of that thread and the chance an assistant
reads it. Five good answers over a month beat one launch post, and they do not
get removed.
