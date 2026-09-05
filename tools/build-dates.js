#!/usr/bin/env node
/*
 * Writes dateModified into each tool page's SoftwareApplication schema.
 *
 * 54 of 56 pages carried no recency signal at all beyond the sitemap, which
 * matters for a tools site: both Google and the answer engines use it to decide
 * whether a page is still current.
 *
 * The date is the last git commit that touched the file, not the filesystem
 * mtime — a checkout or a bulk find/replace must not claim every page changed.
 * Same source as build-sitemap.js, so the two cannot disagree.
 *
 * Run AFTER committing, like build-sitemap.js: on a dirty tree the file's last
 * commit is the previous one, not the change you just made.
 *
 *   node tools/build-dates.js [--check]
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CHECK = process.argv.includes('--check');

function lastCommitDate(file) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cs', '--', file], {
      cwd: ROOT, encoding: 'utf8'
    }).trim();
    return out || null;
  } catch (e) {
    return null;
  }
}

const files = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));
let changed = 0;
const stale = [];

for (const file of files) {
  const p = path.join(ROOT, file);
  let html = fs.readFileSync(p, 'utf8');
  const before = html;

  // Only the SoftwareApplication block; leave FAQPage and BreadcrumbList alone.
  const re = /<script type="application\/ld\+json">\s*(\{[\s\S]*?"@type":\s*"SoftwareApplication"[\s\S]*?\})\s*<\/script>/;
  const m = html.match(re);
  if (!m) continue;

  let data;
  try { data = JSON.parse(m[1]); } catch (e) {
    console.error(`build-dates: ${file} has unparseable SoftwareApplication JSON`);
    process.exit(1);
  }

  const date = lastCommitDate(file);
  if (!date) continue;
  if (data.dateModified === date) continue;
  data.dateModified = date;

  html = html.replace(re,
    '<script type="application/ld+json">\n' + JSON.stringify(data, null, 2) + '\n</script>');

  if (html !== before) {
    if (CHECK) stale.push(file);
    else fs.writeFileSync(p, html);
    changed++;
  }
}

if (CHECK) {
  if (stale.length) {
    console.error(`build-dates --check: ${stale.length} page(s) have a stale dateModified. Run: node tools/build-dates.js`);
    process.exit(1);
  }
  console.log('build-dates --check: every dateModified matches git.');
  process.exit(0);
}
console.log(`build-dates: updated ${changed} pages`);
