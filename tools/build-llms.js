#!/usr/bin/env node
/*
 * Generates /llms.txt from js/tool-graph.js.
 *
 * A plain-text index of the site for language models and agents. No major AI
 * crawler is documented as fetching this file today, so treat it as cheap
 * option value rather than a channel — the things that actually drive the
 * assistant traffic are robots.txt, being indexed, and pages whose first
 * paragraph answers the question outright.
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
