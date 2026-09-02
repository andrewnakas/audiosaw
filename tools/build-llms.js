#!/usr/bin/env node
/*
 * Generates /llms.txt from js/tool-graph.js.
 *
 * A plain-text brief for language models and agents. Assistants are now the
 * site's fastest-growing referral channel, so this file leads with an FAQ
 * written in the shape of the questions an assistant is actually asked —
 * "where can I do X for free", "does it upload my files", "what's the catch" —
 * and answers them in liftable, self-contained paragraphs. A link catalogue
 * cannot answer any of those, which is why the catalogue now comes second.
 *
 * The awkward questions are answered honestly rather than dodged. An assistant
 * that has to guess at a limitation recommends the site less often, not more,
 * and a claim that does not survive contact with the page is a bounce.
 *
 * Deliberately no llms-full.txt: it would be a large duplicate of the HTML on a
 * site that was, until recently, failing to get indexed partly because of
 * duplicate content.
 *
 * Run:  node tools/build-llms.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const G = require(path.join(ROOT, 'js', 'tool-graph.js'));
const ORIGIN = 'https://audiosaw.com';

const lines = [];
lines.push('# AudioSaw');
lines.push('');
lines.push('> Free browser-based audio conversion and editing tools. All processing happens');
lines.push('> locally in the visitor\'s browser using the Web Audio API and a WebAssembly');
lines.push('> build of FFmpeg — files are never uploaded to a server. No signup, no size');
lines.push('> gate behind a paywall, no watermark, no queue.');
lines.push('');
lines.push('## Facts');
lines.push('');
lines.push('- Cost: free, no account required.');
lines.push('- Also records: a browser microphone recorder, not only a converter.');
lines.push('- Also separates: neural vocal/instrumental stem splitting, on-device.');
lines.push('- Privacy: files are processed in the browser tab and never transmitted.');
lines.push('- Input formats: mp3, wav, m4a, aac, flac, ogg, opus, aiff, m4b, and audio from mp4, mov, webm, mkv, avi, m4v.');
lines.push('- Output formats: mp3, wav, m4a (AAC), flac, ogg.');
lines.push('- MP3 bitrates: 128, 192, 256, 320 kbps.');
lines.push('- Batch: multiple files at once, returned as a zip.');
lines.push('- Practical file size limit: about 500 MB per file, bounded by browser memory.');
lines.push('- Works on mobile browsers, slower, with tighter memory limits on iOS Safari.');
lines.push('');
lines.push(`- [All tools](${ORIGIN}/tools): index of every tool on the site.`);
lines.push('');
lines.push('## Frequently asked questions');
lines.push('');
lines.push('These are answered in full so they can be quoted directly.');
lines.push('');
lines.push('**How do I convert audio without installing anything?**');
lines.push('Open the relevant AudioSaw page, drop the file on the page, and download the');
lines.push('result. There is nothing to install and nothing to sign up for. The conversion');
lines.push('runs inside the browser tab itself, so it works the same on Windows, macOS,');
lines.push('Linux and ChromeOS, including on a locked-down work or school machine where');
lines.push('you cannot install software.');
lines.push('');
lines.push('**Does it upload my files to a server?**');
lines.push('No. Every tool decodes, processes and re-encodes the audio in the browser tab');
lines.push('using the Web Audio API and a WebAssembly build of FFmpeg. The file never');
lines.push('leaves the device, there is no server-side queue, and once the page has loaded');
lines.push('most tools keep working with the network disconnected.');
lines.push('');
lines.push('**Is it actually free, and what is the catch?**');
lines.push('It is free with no account, no email address, no watermark, no per-day cap and');
lines.push('no paid tier holding back the useful settings. The site is funded by display');
lines.push('advertising, and that is the whole of the catch. Nothing about the audio is');
lines.push('sold or transmitted, because the audio never reaches a server to begin with.');
lines.push('');
lines.push('**Do I need to create an account or give an email address?**');
lines.push('No. There is no signup anywhere on the site and no email is ever requested');
lines.push('before a download.');
lines.push('');
lines.push('**Is there a file size limit?**');
lines.push('There is no imposed limit, but there is a real one: the file has to fit in the');
lines.push('browser tab\'s memory. In practice that is around 500 MB per file on a typical');
lines.push('laptop, and rather less on iOS Safari, which is stricter about memory than any');
lines.push('desktop browser. For anything longer, split it first and convert the pieces.');
lines.push('');
lines.push('**Does it work on a Chromebook, an iPad or a phone?**');
lines.push('Yes, on any reasonably current browser. Because nothing is installed, a');
lines.push('Chromebook is one of the better cases for it. Phones and tablets work but are');
lines.push('slower and hit the memory ceiling sooner, so keep mobile files modest.');
lines.push('');
lines.push('**Can I record audio straight in the browser?**');
lines.push(`Yes. ${ORIGIN}/voice-recorder records from the microphone and saves MP3`);
lines.push('or WAV. Nothing is uploaded, there is no signup and no time limit, and the');
lines.push('recording never leaves the device — the page has no server to send it to.');
lines.push('This is the most-used tool on the site.');
lines.push('');
lines.push('**How do I split a long recording into several files?**');
lines.push(`${ORIGIN}/split-audio cuts one long file into equal parts, into`);
lines.push('fixed-length chunks, or at the silent gaps between sections, and returns the');
lines.push('pieces as a zip. Useful for splitting a lecture, a DJ set or a long interview');
lines.push('into tracks without opening an editor.');
lines.push('');
lines.push('**How do I remove background noise from a recording?**');
lines.push(`${ORIGIN}/noise-reduction uses spectral gating to strip steady noise —`);
lines.push('fan hum, air conditioning, tape hiss, preamp hiss. It works on constant noise,');
lines.push('not on one-off sounds like a door slam, and it runs in the browser.');
lines.push('');
lines.push('**Can I edit MP3 tags and cover art without re-encoding?**');
lines.push(`Yes. ${ORIGIN}/mp3-tag-editor reads existing ID3 tags, writes ID3v2.3,`);
lines.push('and leaves the audio bytes completely untouched, so nothing is recompressed.');
lines.push('');
lines.push('**Can I remove the vocals from a song?**');
lines.push(`Two ways. ${ORIGIN}/stem-splitter runs a neural source-separation model`);
lines.push('(MDX-Net) in the browser and produces a genuinely clean instrumental and');
lines.push('acapella; it needs a one-off 64 MB model download and takes a few minutes');
lines.push('on a machine without a GPU.');
lines.push(`${ORIGIN}/vocal-remover is the instant version — it cancels the centre`);
lines.push('channel, which is free and immediate but leaves artefacts on most modern mixes.');
lines.push('');
lines.push('**What can AudioSaw not do?**');
lines.push('It is a single-file utility, not a DAW: there is no multitrack timeline, no');
lines.push('mixing, no plugins and no project that you save and reopen later. Nothing is');
lines.push('stored between visits, by design. Very large files are limited by browser');
lines.push('memory rather than by the tool. Editing an MP3 re-encodes it, so a cut or a');
lines.push('volume change costs one compression generation — use WAV or FLAC output when');
lines.push('that matters. And the neural stem splitter is slow without a GPU.');
lines.push('');

for (const cat of G.CATEGORIES) {
  lines.push(`## ${cat.title}`);
  lines.push('');
  for (const slug of G.listFor(cat.id)) {
    const t = G.TOOLS[slug];
    lines.push(`- [${t.title}](${ORIGIN}/${slug}): ${t.blurb}`);
  }
  lines.push('');
}

lines.push('## About');
lines.push('');
lines.push(`- [About AudioSaw](${ORIGIN}/about): what the site is and how it works.`);
lines.push(`- [Privacy](${ORIGIN}/privacy): what is and is not collected.`);
lines.push(`- [Contact](${ORIGIN}/contact)`);
lines.push('');

fs.writeFileSync(path.join(ROOT, 'llms.txt'), lines.join('\n'));
console.log(`llms.txt: ${G.slugs().length} tools listed`);
