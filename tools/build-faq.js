#!/usr/bin/env node
/*
 * Reconciles each page's visible FAQ with its FAQPage schema, and regenerates
 * both from one merged list.
 *
 * Why this exists: the two were authored independently and had drifted badly.
 * On 31 of 46 pages the JSON-LD promised questions that appeared nowhere on the
 * page — 141 questions and 169 answers existing only in schema. capcut-audio
 * was the extreme case: six schema questions, six visible questions, zero
 * overlap.
 *
 * That is a Google structured-data policy violation ("the content must be
 * visible to the user on the source page"), so the rich result can be dropped
 * and the property can take a manual action. It also wasted the content: those
 * schema-only answers are good, and no human or assistant could read them.
 *
 * The merge keeps every visible Q&A in its authored order, then appends any
 * schema-only Q&A that is not a near-duplicate of one already there. Schema is
 * then regenerated *from the merged visible list*, so the two cannot drift
 * again — that is the whole point, and it is why the schema is written by this
 * script rather than by hand.
 *
 * The <details> list lives between <!-- AS:faq --> markers, like the other
 * generated blocks. Do not hand-edit inside them; edit the page's FAQ, run this.
 *
 * Run:  node tools/build-faq.js          (rewrites pages)
 *       node tools/build-faq.js --check  (exit 1 if anything is out of sync)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CHECK = process.argv.includes('--check');

const STOP = new Set(['a', 'an', 'the', 'is', 'it', 'do', 'does', 'my', 'i', 'to', 'in',
  'of', 'for', 'and', 'or', 'this', 'that', 'get', 'can', 'will', 'be', 'are', 'you',
  'your', 'me', 'on', 'at', 'with', 'here', 'there', 'what', 'why', 'how', 'so']);

// Two questions are the same question if their content words mostly agree.
// "Does my audio get uploaded?" and "Does my audio file get uploaded?" are one
// question written twice, and shipping both reads as padding.
function sig(q) {
  return new Set(q.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((w) => w && !STOP.has(w)));
}
function similar(a, b) {
  const [x, y] = [sig(a), sig(b)];
  if (!x.size || !y.size) return false;
  let hit = 0;
  for (const w of x) if (y.has(w)) hit++;
  return hit / Math.min(x.size, y.size) >= 0.7;
}

const stripTags = (s) => s.replace(/<[^>]+>/g, '');
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ').trim();
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function faqSection(html) {
  const body = html.replace(/<script[\s\S]*?<\/script>/g, '');
  const m = body.match(/<section class="faq">\s*<h2[^>]*>[\s\S]*?<\/h2>([\s\S]*?)<\/section>/);
  return m ? m[1] : null;
}

// Visible answers may carry links; keep the markup for the page, strip it for
// the schema, which must be plain text.
function visibleQA(html) {
  const sec = faqSection(html);
  if (!sec) return [];
  return [...sec.matchAll(/<details>\s*<summary>([\s\S]*?)<\/summary>\s*<p>([\s\S]*?)<\/p>\s*<\/details>/g)]
    .map((m) => ({ q: decode(stripTags(m[1])), aHtml: m[2].replace(/\s+/g, ' ').trim() }));
}

function schemaQA(html) {
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let j;
    try { j = JSON.parse(m[1]); } catch (e) { continue; }
    if (j['@type'] === 'FAQPage') {
      return j.mainEntity.map((e) => ({ q: e.name, aHtml: esc(e.acceptedAnswer.text) }));
    }
  }
  return [];
}

const files = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));
let touched = 0, added = 0, drifted = [];

for (const file of files) {
  const p = path.join(ROOT, file);
  let html = fs.readFileSync(p, 'utf8');
  const visible = visibleQA(html);
  if (!visible.length) continue;

  const merged = visible.slice();
  for (const s of schemaQA(html)) {
    if (merged.some((v) => similar(v.q, s.q))) continue;
    merged.push(s);
    added++;
  }

  const detailsHtml = merged.map((x) =>
    `      <details><summary>${esc(x.q)}</summary><p>${x.aHtml}</p></details>`).join('\n');
  const block = `<!-- AS:faq -->\n${detailsHtml}\n      <!-- /AS:faq -->`;

  const json = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: merged.map((x) => ({
      '@type': 'Question',
      name: x.q,
      acceptedAnswer: { '@type': 'Answer', text: decode(stripTags(x.aHtml)) },
    })),
  });

  const before = html;

  // Replace the whole run of <details> inside section.faq with the marked block.
  html = html.replace(/(<section class="faq">\s*<h2[^>]*>[\s\S]*?<\/h2>)([\s\S]*?)(<\/section>)/,
    (_, head, body, tail) => {
      const rebuilt = body.replace(
        /(?:<!-- AS:faq -->[\s\S]*?<!-- \/AS:faq -->|<details>[\s\S]*<\/details>)/,
        block);
      return head + rebuilt + tail;
    });

  const ld = `<script type="application/ld+json">\n${json}\n</script>`;
  if (html.includes('FAQPage')) {
    html = html.replace(/<script type="application\/ld\+json">\s*\{[^<]*"FAQPage"[\s\S]*?<\/script>/, ld);
  } else if (html.includes('<!-- AS:pageschema -->')) {
    html = html.replace('<!-- AS:pageschema -->', '<!-- AS:pageschema -->\n' + ld);
  } else {
    html = html.replace('<!-- AS:bcschema -->', `<!-- AS:pageschema -->\n${ld}\n<!-- /AS:pageschema -->\n<!-- AS:bcschema -->`);
  }

  if (html !== before) {
    drifted.push(file.replace('.html', '') + ` (${visible.length} -> ${merged.length})`);
    if (!CHECK) fs.writeFileSync(p, html);
    touched++;
  }
}

if (CHECK) {
  if (touched) {
    console.error(`build-faq --check: ${touched} pages out of sync:\n  ` + drifted.join('\n  '));
    process.exit(1);
  }
  console.log('build-faq --check: visible FAQ and schema agree on every page.');
} else {
  console.log(`build-faq: ${touched} pages rewritten, ${added} schema-only Q&A promoted to visible.`);
  if (drifted.length) console.log('  ' + drifted.join('\n  '));
}
