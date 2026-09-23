#!/usr/bin/env node
/*
 * Regenerates sitemap.xml from the .html files in the repo root.
 *
 * Run by hand after adding or editing pages:   node tools/build-sitemap.js
 *
 * Why this exists: the sitemap previously had no <lastmod> on any URL, and
 * pages drifted out of it entirely (/mp3-to-aiff was live but unlisted).
 * Google ignores <changefreq> and <priority> but does use <lastmod> for
 * recrawl scheduling, so it is the one field worth keeping accurate.
 *
 * <lastmod> comes from the last git commit that touched each file, not the
 * filesystem mtime — a checkout or a bulk find/replace shouldn't tell Google
 * that every page changed.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ORIGIN = 'https://audiosaw.com';

// Pages that exist but should never be in the sitemap.
// offline.html is the service worker's fallback, not a destination.
const EXCLUDE = new Set(['404.html', 'offline.html']);

// Real pages that are not .html files in this repo. /stemflipper is served by
// functions/stemflipper/ from another repo's build, so there is nothing here to walk —
// but it is a destination and belongs in the sitemap like any other tool. lastmod tracks
// the mount, which is the only date this repo actually knows about.
const EXTRA = [
  { loc: '/stemflipper', source: 'functions/stemflipper', priority: 0.9, changefreq: 'monthly' },
];

// Priority tiers. Anything unlisted falls through to DEFAULT_PRIORITY.
const PRIORITY = {
  'index.html': 1.0,
  'tools.html': 0.9,
  'about.html': 0.3, 'privacy.html': 0.3, 'terms.html': 0.3, 'contact.html': 0.3,
};
const DEFAULT_PRIORITY = 0.8;

// The primary converters — the pages we most want recrawled.
const HIGH = new Set([
  'mp4-to-mp3', 'm4a-to-mp3', 'wav-to-mp3', 'mp3-to-wav', 'flac-to-mp3',
  'mov-to-mp3', 'ogg-to-mp3', 'opus-to-mp3', 'aac-to-mp3', 'extract-audio',
  'audio-cutter', 'audio-joiner', 'audio-compressor', 'normalize-audio',
  'silence-remover', 'ringtone-maker', 'm4a-to-wav-for-audacity',
  'audio-for-whisper', 'm4b-to-mp3', 'mp3-320kbps', 'discord-audio-compressor',
  'audio-to-text-prep', 'davinci-resolve-audio', 'capcut-audio', 'flac-to-wav',
  'change-sample-rate', 'podcast-prep',
]);

function lastmod(file) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cs', '--', file], {
      cwd: ROOT, encoding: 'utf8',
    }).trim();
    if (out) return out;
  } catch (e) { /* not in git yet — fall through */ }
  return new Date(fs.statSync(path.join(ROOT, file)).mtime).toISOString().slice(0, 10);
}

function urlFor(file) {
  if (file === 'index.html') return ORIGIN + '/';
  return ORIGIN + '/' + file.replace(/\.html$/, '');
}

function priorityFor(file) {
  if (file in PRIORITY) return PRIORITY[file];
  const slug = file.replace(/\.html$/, '');
  if (HIGH.has(slug)) return 0.9;
  return DEFAULT_PRIORITY;
}

function changefreqFor(file) {
  if (file === 'index.html') return 'weekly';
  if (priorityFor(file) <= 0.3) return 'yearly';
  return 'monthly';
}

const files = fs.readdirSync(ROOT)
  .filter((f) => f.endsWith('.html') && !EXCLUDE.has(f))
  .sort((a, b) => {
    const pa = priorityFor(a), pb = priorityFor(b);
    if (pa !== pb) return pb - pa;
    return a.localeCompare(b);
  });

const entries = [
  ...files.map((f) => ({
    loc: urlFor(f),
    lastmod: lastmod(f),
    changefreq: changefreqFor(f),
    priority: priorityFor(f),
  })),
  ...EXTRA.map((e) => ({
    loc: ORIGIN + e.loc,
    lastmod: lastmod(e.source),
    changefreq: e.changefreq,
    priority: e.priority,
  })),
].sort((a, b) => (a.priority !== b.priority ? b.priority - a.priority : a.loc.localeCompare(b.loc)));

const body = entries.map((e) =>
  `  <url><loc>${e.loc}</loc><lastmod>${e.lastmod}</lastmod>` +
  `<changefreq>${e.changefreq}</changefreq>` +
  `<priority>${e.priority.toFixed(1)}</priority></url>`
).join('\n');

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>
`;

const OUT = path.join(ROOT, 'sitemap.xml');
if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current !== xml) {
    console.error('build-sitemap --check: sitemap.xml is out of date. Run: node tools/build-sitemap.js');
    process.exit(1);
  }
  console.log('build-sitemap --check: sitemap.xml is current.');
  process.exit(0);
}
fs.writeFileSync(OUT, xml);
console.log(`sitemap.xml: ${entries.length} URLs`);
