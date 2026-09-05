/*
 * One-shot: remove every AdSense reference from the HTML.
 *
 * The site loaded adsbygoogle.js on 55 pages and had never placed a single
 * <ins> unit, so it was carrying the largest third-party script on the site for
 * no revenue at all. The three reserved .ad-slot containers were display:none.
 *
 * Kept here rather than done by hand so the change is reviewable and repeatable.
 * Safe to delete once it has run.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const files = fs.readdirSync(root).filter((f) => f.endsWith('.html'));

let touched = 0;
for (const f of files) {
  const p = path.join(root, f);
  const before = fs.readFileSync(p, 'utf8');
  let s = before;

  // The loader script and the account meta.
  s = s.replace(/^[ \t]*<script async src="https:\/\/pagead2\.googlesyndication\.com[^\n]*\n/gm, '');
  s = s.replace(/^[ \t]*<meta name="google-adsense-account"[^\n]*\n/gm, '');

  // The reserved slot containers.
  s = s.replace(/^[ \t]*<div class="ad-slot[^\n]*<\/div>\n/gm, '');

  // The two adsbygoogle lines inside the inline consent bootstrap.
  s = s.replace(
    /window\.adsbygoogle\s*=\s*window\.adsbygoogle\s*\|\|\s*\[\];\s*if\s*\(s!=='all'\)\s*\{?\s*window\.adsbygoogle\.requestNonPersonalizedAds\s*=\s*1;\s*\}?/g,
    ''
  );

  // Preconnect to a CDN nothing on the site ever loads from.
  s = s.replace(/^[ \t]*<link rel="(?:preconnect|dns-prefetch)" href="https:\/\/cdn\.jsdelivr\.net"[^\n]*\n/gm, '');

  // Decorative glyph in every dropzone, announced by screen readers.
  s = s.replace(/<span class="icon">/g, '<span class="icon" aria-hidden="true">');

  // Collapse any blank-line pileup the deletions left behind.
  s = s.replace(/\n{3,}/g, '\n\n');

  if (s !== before) {
    fs.writeFileSync(p, s);
    touched++;
  }
}
console.log(`strip-ads: rewrote ${touched} of ${files.length} files`);
