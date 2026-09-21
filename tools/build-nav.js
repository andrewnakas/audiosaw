#!/usr/bin/env node
/*
 * Generates the static navigation surfaces from js/tool-graph.js and writes
 * them into every page:
 *
 *   1. footer tool directory  — all 41 tools, on all 47 pages, so every page is
 *                               one click from every other. Fixes a link graph
 *                               where 8 pages had a single inbound link and 3
 *                               had none, which is why Google reported
 *                               "Discovered - currently not indexed /
 *                               Referring page: None detected".
 *   2. related-tools block    — per page, topically chosen, with the reason in
 *                               the card copy rather than a generic blurb.
 *   3. breadcrumb             — visible trail + matching BreadcrumbList JSON-LD.
 *   4. header link            — one "all tools" entry pointing at /tools.
 *   5. tools.html             — the hub page.
 *   6. homepage rails         — the five intent-grouped scroll rows on / and the
 *                               "jump straight to a job" shortcut above them.
 *                               Generated because the 39-tile grid they replace was
 *                               hand-written HTML in index.html and had drifted to
 *                               18 tools short of the graph.
 *
 * These have to be real HTML rather than JS-injected: the problem being solved
 * is crawl discovery, and a renderer-dependent link is a weaker signal.
 *
 * Idempotent — everything generated sits between AS:name markers, so re-running
 * replaces rather than duplicates.
 *
 * Run:  node tools/build-nav.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const G = require(path.join(ROOT, 'js', 'tool-graph.js'));
const ORIGIN = 'https://audiosaw.com';

const NON_TOOL = new Set(['index', 'about', 'privacy', 'terms', 'contact', '404', 'tools', 'offline']);
const LEGAL = new Set(['about', 'privacy', 'terms', 'contact']);

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ---------------------------------------------------------------- markers */

function replaceBlock(html, name, content) {
  const open = `<!-- AS:${name} -->`;
  const close = `<!-- /AS:${name} -->`;
  const re = new RegExp(escapeRe(open) + '[\\s\\S]*?' + escapeRe(close));
  const block = open + '\n' + content + '\n' + close;
  if (re.test(html)) return html.replace(re, block);
  return null; // caller decides where to insert it the first time
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function wrap(name, content) {
  return `<!-- AS:${name} -->\n${content}\n<!-- /AS:${name} -->`;
}

/* -------------------------------------------------------------- 1. footer */

function footerDirectory() {
  const cols = G.CATEGORIES.map((cat) => {
    const links = G.listFor(cat.id).map((slug) => {
      const t = G.TOOLS[slug];
      return `        <a href="/${slug}">${esc(t.label)}</a>`;
    }).join('\n');
    return `      <div class="footer-col">\n        <h4>${esc(cat.title)}</h4>\n${links}\n      </div>`;
  }).join('\n');

  return `<footer class="site-footer">
  <div class="container">
    <nav class="footer-directory" aria-label="All tools">
${cols}
    </nav>
    <p class="footer-legal">&copy; 2026 AudioSaw &middot; runs in your tab, nowhere else</p>
    <nav class="footer-meta"><a href="/tools">all tools</a> &middot; <a href="/about">about</a> &middot; <a href="/privacy">privacy</a> &middot; <a href="/terms">terms</a> &middot; <a href="/contact">contact</a> &middot; <a href="/privacy#cookies" id="consentSettings">cookie settings</a></nav>
  </div>
</footer>`;
}

/* ------------------------------------------------------- 2. related tools */

function relatedBlock(slug) {
  const tool = G.TOOLS[slug];
  if (!tool) return null;
  const cards = tool.next.map(([target, why]) => {
    const t = G.TOOLS[target];
    return `      <a class="card" href="/${target}"><h3>${esc(t.title)}</h3><p>${esc(why)}.</p></a>`;
  }).join('\n');
  return `  <section class="related-tools">
    <h2><span class="num">⤳</span>Related tools</h2>
    <div class="card-grid">
${cards}
    </div>
  </section>`;
}

/* ---------------------------------------------------------- 3. breadcrumb */

function breadcrumb(slug) {
  const tool = G.TOOLS[slug];
  if (!tool) return null;
  const cat = G.CATEGORIES.find((c) => c.id === tool.cat);
  return `<nav class="breadcrumb container" aria-label="Breadcrumb">
  <a href="/">Home</a> <span aria-hidden="true">›</span>
  <a href="/tools#${cat.id}">${esc(cat.title)}</a> <span aria-hidden="true">›</span>
  <span aria-current="page">${esc(tool.title)}</span>
</nav>`;
}

function breadcrumbSchema(slug) {
  const tool = G.TOOLS[slug];
  if (!tool) return null;
  const cat = G.CATEGORIES.find((c) => c.id === tool.cat);
  const data = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: ORIGIN + '/' },
      { '@type': 'ListItem', position: 2, name: cat.title, item: ORIGIN + '/tools#' + cat.id },
      { '@type': 'ListItem', position: 3, name: tool.title }
    ]
  };
  return `<script type="application/ld+json">\n${JSON.stringify(data)}\n</script>`;
}

/* ------------------------------------------------------------ 4. tools.html */

function toolsPage() {
  const sections = G.CATEGORIES.map((cat) => {
    const cards = G.listFor(cat.id).map((slug) => {
      const t = G.TOOLS[slug];
      return `      <a class="card" href="/${slug}"><h3>${esc(t.title)}</h3><p>${esc(t.blurb)}</p></a>`;
    }).join('\n');
    return `  <section id="${cat.id}">
    <h2>${esc(cat.title)}</h2>
    <p>${esc(CATEGORY_INTRO[cat.id])}</p>
    <div class="card-grid">
${cards}
    </div>
  </section>`;
  }).join('\n\n');

  const itemList = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'AudioSaw tools',
    itemListElement: G.slugs().map((slug, i) => ({
      '@type': 'ListItem', position: i + 1,
      name: G.TOOLS[slug].title, url: ORIGIN + '/' + slug
    }))
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>All AudioSaw tools — ${G.slugs().length} free browser audio tools | AudioSaw</title>
<meta name="description" content="Every AudioSaw tool in one place: convert between MP3, WAV, M4A, FLAC, AAC, OGG and AIFF, pull audio out of video, cut, join, normalize, compress and prep audio for Whisper, Discord, CapCut and hardware samplers. All of it runs in your browser — nothing is uploaded.">
<meta name="robots" content="index,follow">
<link rel="canonical" href="${ORIGIN}/tools">
<link rel="icon" href="/favicon.ico">
${wrap('pwa', pwaHead())}
<meta property="og:title" content="All AudioSaw tools">
<meta property="og:description" content="Every AudioSaw tool in one place. ${G.slugs().length} free audio tools that run in your browser — nothing is uploaded.">
<meta property="og:type" content="website">
<meta property="og:url" content="${ORIGIN}/tools">
<meta property="og:image" content="${ORIGIN}/assets/og-image.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="preconnect" href="https://unpkg.com" crossorigin>
<link rel="dns-prefetch" href="https://unpkg.com">
<link rel="preconnect" href="https://www.googletagmanager.com">
<link rel="stylesheet" href="/css/style.css?v=${VERSION}">
<script type="application/ld+json">
${JSON.stringify(itemList)}
</script>
${GTAG_BLOCK}
</head>
<body>
${HEADER}

${wrap('breadcrumb', `<nav class="breadcrumb container" aria-label="Breadcrumb">
  <a href="/">Home</a> <span aria-hidden="true">›</span>
  <span aria-current="page">All tools</span>
</nav>`)}

<main class="container">
  <section class="page-intro">
    <h1>All <span class="ital">${G.slugs().length}</span> tools.</h1>
    <p>Every tool on AudioSaw runs entirely inside your browser tab. Your file is decoded, processed and re-encoded locally — it is never uploaded to a server, so there is no queue, no size gate behind a signup, and no copy of your audio sitting on someone else's disk. Pick the tool that matches the job; each one has the settings for that job already chosen.</p>
  </section>

${sections}
</main>

${FOOTER_PLACEHOLDER}

<script src="/js/common.js?v=${VERSION}"></script>
<script src="/js/tool-graph.js?v=${VERSION}"></script>
<script src="/js/flow.js?v=${VERSION}"></script>
<script src="/js/consent.js?v=${VERSION}"></script>
<script src="/js/pwa.js?v=${VERSION}"></script>
</body>
</html>
`;
}

const CATEGORY_INTRO = {
  'to-mp3': 'MP3 is the format that plays on everything — every phone, every car stereo, every cheap MP3 player, every editing program written in the last thirty years. These convert into it from whatever you started with. All of them are lossy encodes, so work from the highest-quality source you have rather than from something already compressed.',
  'formats': 'Conversions that are not about getting to MP3: uncompressed PCM for editing and burning, lossless FLAC for archiving, Apple-native containers, and fixed-bitrate MP3 presets when you want the decision made for you.',
  'video': 'Video files are containers — the audio inside is usually AAC, and it can be lifted out without re-encoding the picture. Because everything runs locally, the video itself never leaves your machine, which matters more here than anywhere else on the site.',
  'edit': 'Cutting, joining, trimming and shaping. These change the length or arrangement of a file rather than its format, and they are the ones worth chaining together — cut, then join, then fade.',
  'levels': 'Loudness and channel-count fixes. Most "this file sounds wrong" problems are one of these: it is too quiet, it is louder than everything around it, it is stuck in one ear, or the sample rate does not match the project it is going into.',
  'repair': 'Fixing what is wrong with a recording rather than converting it. Hiss, hum, dead air, a vocal you need isolated from the backing — these read the audio, decide what to keep, and write it back out. The separation tools run a neural network locally, which is slower than everything else here and still never uploads your file.',
  'create': 'Making a file rather than changing one. Record straight from a microphone, or fix the metadata that decides what your music player prints on screen.',
  'apps': 'Presets for a specific destination. Each of these targets one program or device that is fussy about what it accepts, and applies the exact spec that program wants, so the import works the first time.'
};

// Two categories shipped without an intro and rendered a literal "undefined"
// paragraph on the hub page for months. Fail the build instead.
for (const cat of G.CATEGORIES) {
  if (!CATEGORY_INTRO[cat.id]) {
    console.error(`build-nav: no CATEGORY_INTRO for "${cat.id}" — add one before shipping.`);
    process.exit(1);
  }
}

/* ------------------------------------------------- 5. homepage jobs + rails */

/*
 * The homepage used to carry 39 hand-written <a class="card"> tiles in one flat
 * grid — about 2,100px of identical-looking boxes, more than half of them format
 * pairs, with "Why this site" stranded underneath all of it. Two costs: nobody
 * scrolled far enough to read the one paragraph that says what is different
 * about the site, and because the list was hand-maintained rather than generated
 * from the graph, 18 of the 57 tools had no homepage link at all.
 *
 * Now: five horizontally scrolling rails grouped by intent, generated from
 * G.HOME_RAILS. Every tool gets a link, the format pairs collapse to compact
 * chips, and the whole set is shorter than the old grid.
 *
 * The rails are real anchors inside an overflow-x container, not a JS carousel.
 * That is load-bearing — the reason the footer directory exists at all is crawl
 * discovery, and a link that only exists after a script runs is a weaker signal.
 * Horizontal scroll is pure CSS here; the arrow buttons only call scrollBy.
 */

function homeJobs() {
  const links = G.HOME_JOBS.map(([slug, label]) => {
    const t = G.TOOLS[slug];
    if (!t) {
      console.error(`build-nav: HOME_JOBS points at unknown tool "${slug}".`);
      process.exit(1);
    }
    return `      <a href="/${slug}" title="${esc(t.title)}">${esc(label)}</a>`;
  }).join('\n');

  return `  <section class="task-picker">
    <h2 class="task-picker-label">Or jump straight to a job</h2>
    <div class="task-picker-row">
${links}
      <a href="/tools" class="task-picker-all">all ${G.slugs().length} tools &rarr;</a>
    </div>
  </section>`;
}

function homeRails() {
  const rails = G.HOME_RAILS.map((rail) => {
    const headingId = `rail-${rail.id}`;
    const chips = rail.style === 'chip';

    const items = rail.tools.map((slug) => {
      const t = G.TOOLS[slug];
      return chips
        ? `        <li><a href="/${slug}" title="${esc(t.title)}">${esc(t.label)}</a></li>`
        : `        <li><a href="/${slug}"><span class="rail-tile-title">${esc(t.title)}</span>` +
          `<span class="rail-tile-blurb">${esc(t.blurb)}</span></a></li>`;
    }).join('\n');

    // The arrows are a pointer affordance only, hence aria-hidden and
    // tabindex="-1": a keyboard user tabs the links themselves and the browser
    // scrolls each one into view, so exposing the buttons would add two stops
    // per rail that do nothing a keyboard user needs.
    return `    <div class="rail${chips ? ' rail-is-chips' : ''}" data-rail="${rail.id}">
      <div class="rail-head">
        <div>
          <h3 id="${headingId}">${esc(rail.title)} <span class="rail-count">${rail.tools.length}</span></h3>
          <p>${esc(rail.note)}</p>
        </div>
        <div class="rail-arrows" aria-hidden="true">
          <button type="button" class="rail-arrow" data-dir="-1" tabindex="-1">&lsaquo;</button>
          <button type="button" class="rail-arrow" data-dir="1" tabindex="-1">&rsaquo;</button>
        </div>
      </div>
      <ul class="rail-row" aria-labelledby="${headingId}">
${items}
      </ul>
    </div>`;
  }).join('\n\n');

  return `  <section class="rails">
    <h2><span class="num">02.</span>Pick a tool</h2>
    <p class="rails-intro">All ${G.slugs().length}, grouped by what you are actually trying to do. Each row scrolls sideways &mdash; or see <a href="/tools">the full list</a>.</p>

${rails}
  </section>

  <script>
  /* Rail arrows. Progressive enhancement: with JS off the rows still scroll by
     touch, trackpad and keyboard, so this only adds the buttons and the edge
     fade that tells you there is more to the right. */
  (function () {
    var rails = document.querySelectorAll('.rail');
    if (!rails.length) return;
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var smooth = reduce ? 'auto' : 'smooth';
    Array.prototype.forEach.call(rails, function (rail) {
      var row = rail.querySelector('.rail-row');
      var arrows = rail.querySelector('.rail-arrows');
      function sync() {
        // A rail that fits needs no arrows and no fade. Half a pixel of slack
        // because scrollWidth and clientWidth disagree at some zoom levels and
        // a permanently-lit right arrow that cannot move is worse than none.
        var over = row.scrollWidth - row.clientWidth > 1;
        rail.classList.toggle('is-scrollable', over);
        if (!over) return;
        // 2px of slack: scrollLeft is fractional at browser zoom levels other
        // than 100%, and an end never quite reached leaves an arrow lit that
        // cannot move.
        var atStart = row.scrollLeft <= 2;
        var atEnd = row.scrollLeft >= row.scrollWidth - row.clientWidth - 2;
        row.style.setProperty('--fade-l', atStart ? '0px' : '30px');
        row.style.setProperty('--fade-r', atEnd ? '0px' : '44px');
        arrows.children[0].disabled = atStart;
        arrows.children[1].disabled = atEnd;
      }
      Array.prototype.forEach.call(arrows.children, function (btn) {
        btn.addEventListener('click', function () {
          // 80% rather than a full page so the tile you were looking at stays
          // partly visible and the row does not feel like it jumped.
          row.scrollBy({ left: row.clientWidth * 0.8 * +btn.dataset.dir, behavior: smooth });
        });
      });
      row.addEventListener('scroll', sync, { passive: true });
      if (window.ResizeObserver) new ResizeObserver(sync).observe(row);
      sync();
    });
  })();
  </script>`;
}

// Every tool must be reachable from the homepage, exactly once. The grid this
// replaced was hand-maintained and had drifted 18 tools short without anything
// noticing, so this is a build failure rather than a warning.
(function validateRails() {
  const seen = new Map();
  for (const rail of G.HOME_RAILS) {
    for (const slug of rail.tools) {
      if (!G.TOOLS[slug]) {
        console.error(`build-nav: rail "${rail.id}" lists unknown tool "${slug}".`);
        process.exit(1);
      }
      if (seen.has(slug)) {
        console.error(`build-nav: "${slug}" is in both the "${seen.get(slug)}" and "${rail.id}" rails. Pick one.`);
        process.exit(1);
      }
      seen.set(slug, rail.id);
    }
  }
  const missing = G.slugs().filter((s) => !seen.has(s));
  if (missing.length) {
    console.error(`build-nav: ${missing.length} tool(s) are in no homepage rail: ${missing.join(', ')}`);
    console.error('Add them to HOME_RAILS in js/tool-graph.js — the homepage is the strongest internal link a tool page gets.');
    process.exit(1);
  }

  // EXT_TOOL is what the wrong-file-type panel offers instead of the homepage.
  // A typo there fails open — toolForExt returns null and the visitor silently
  // gets nothing — so catch it at build time instead.
  for (const [ext, slug] of Object.entries(G.EXT_TOOL)) {
    if (!G.TOOLS[slug]) {
      console.error(`build-nav: EXT_TOOL maps .${ext} to "${slug}", which is not a tool.`);
      process.exit(1);
    }
  }
})();

/* ----------------------------------------------------------- 6. PWA head */

// Installability, the tab/theme colour, and the icons Safari and Android look
// for. Injected from here because it belongs on all 56 pages, including the
// five that load no other JavaScript.
function pwaHead() {
  return `<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#fbf6ed">
<link rel="apple-touch-icon" href="/assets/icons/apple-touch-icon.png">
<meta name="apple-mobile-web-app-title" content="AudioSaw">
<meta name="twitter:image" content="${ORIGIN}/assets/og-image.png">
<link rel="preload" href="/assets/fonts/ibm-plex-sans-var.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/assets/fonts/fraunces-var.woff2" as="font" type="font/woff2" crossorigin>`;
}

/* ------------------------------------------------------------------ main */

// Read the version token and shared header/gtag from an existing page so the
// generated hub stays in sync with the rest of the site.
const sample = fs.readFileSync(path.join(ROOT, 'mp4-to-mp3.html'), 'utf8');
const VERSION = (sample.match(/style\.css\?v=([^"']+)/) || [, '1'])[1];
const GTAG_BLOCK = sample.slice(
  sample.indexOf('<script>\nwindow.dataLayer'),
  sample.indexOf('</head>')
).trim();
const FOOTER_PLACEHOLDER = wrap('footer', footerDirectory());

const HEADER = `<header class="site-header">
  <div class="container">
    <a href="/" class="logo">AudioSaw<span class="stamp">.com</span></a>
    <nav>
      <a href="/mp4-to-mp3">mp4 &rarr; mp3</a>
      <a href="/m4a-to-mp3">m4a &rarr; mp3</a>
      <a href="/wav-to-mp3">wav &rarr; mp3</a>
      <a href="/audio-cutter">cut</a>
      <a href="/audio-joiner">join</a>
      <a href="/tools" class="nav-all">all tools</a>
    </nav>
  </div>
</header>`;

let changed = 0;
const CHECK = process.argv.includes('--check');
const stale = [];

// --- write tools.html first so it exists before we link to it everywhere
const toolsOut = path.join(ROOT, 'tools.html');
if (CHECK) {
  const current = fs.existsSync(toolsOut) ? fs.readFileSync(toolsOut, 'utf8') : '';
  if (current !== toolsPage()) stale.push('tools.html');
} else {
  fs.writeFileSync(toolsOut, toolsPage());
  console.log('wrote tools.html');
}

const files = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));

for (const file of files) {
  const slug = file.replace(/\.html$/, '');
  const p = path.join(ROOT, file);
  let html = fs.readFileSync(p, 'utf8');
  const before = html;

  // ---- header: add the "all tools" link (idempotent) --------------------
  if (!html.includes('class="nav-all"')) {
    html = html.replace(
      /(<a href="\/audio-joiner">join<\/a>)(\s*)/,
      '$1\n      <a href="/tools" class="nav-all">all tools</a>$2'
    );
  }

  // ---- PWA head block, on every page ------------------------------------
  if (html.includes('<!-- AS:pwa -->')) {
    html = replaceBlock(html, 'pwa', pwaHead());
  } else {
    html = html.replace(
      /(<link rel="icon" href="\/favicon\.ico">\n)/,
      '$1' + wrap('pwa', pwaHead()) + '\n'
    );
  }

  // ---- service worker registration + install prompt, last script --------
  if (!html.includes('/js/pwa.js')) {
    html = html.replace(
      /(\n<\/body>)/,
      `\n<script src="/js/pwa.js?v=${VERSION}"></script>$1`
    );
  }

  // ---- footer: replace the whole element with the directory -------------
  const footerBlock = wrap('footer', footerDirectory());
  if (html.includes('<!-- AS:footer -->')) {
    html = replaceBlock(html, 'footer', footerDirectory());
  } else {
    html = html.replace(/<footer class="site-footer">[\s\S]*?<\/footer>/, footerBlock);
  }

  // ---- tool-page-only surfaces ------------------------------------------
  if (!NON_TOOL.has(slug) && G.TOOLS[slug]) {
    // breadcrumb, between </header> and <main
    const bc = wrap('breadcrumb', breadcrumb(slug));
    if (html.includes('<!-- AS:breadcrumb -->')) {
      html = replaceBlock(html, 'breadcrumb', breadcrumb(slug));
    } else {
      html = html.replace(/(<\/header>\s*)/, '$1\n' + bc + '\n\n');
    }

    // breadcrumb schema, just before </head>
    const bs = wrap('bcschema', breadcrumbSchema(slug));
    if (html.includes('<!-- AS:bcschema -->')) {
      html = replaceBlock(html, 'bcschema', breadcrumbSchema(slug));
    } else {
      html = html.replace(/(<\/head>)/, bs + '\n$1');
    }

    // related tools: replace the existing block, or insert before </main>
    const rel = wrap('related', relatedBlock(slug));
    if (html.includes('<!-- AS:related -->')) {
      html = replaceBlock(html, 'related', relatedBlock(slug));
    } else if (/<section>\s*<h2><span class="num">⤳<\/span>Related tools<\/h2>[\s\S]*?<\/section>/.test(html)) {
      html = html.replace(
        /<section>\s*<h2><span class="num">⤳<\/span>Related tools<\/h2>[\s\S]*?<\/section>/,
        rel
      );
    } else {
      html = html.replace(/(\s*<\/main>)/, '\n\n' + rel + '$1');
    }

    // tool-graph.js + flow.js need to load on tool pages
    if (!html.includes('/js/flow.js')) {
      html = html.replace(
        /(<script src="\/js\/common\.js\?v=[^"]*"><\/script>\n)/,
        `$1<script src="/js/tool-graph.js?v=${VERSION}"></script>\n<script src="/js/flow.js?v=${VERSION}"></script>\n`
      );
    }
  }

  // ---- homepage: the job shortcut row and the tool rails ----------------
  if (slug === 'index') {
    for (const [name, content] of [['jobs', homeJobs()], ['home', homeRails()]]) {
      const next = replaceBlock(html, name, content);
      if (next === null) {
        console.error(`build-nav: index.html has no <!-- AS:${name} --> markers. Add them before running.`);
        process.exit(1);
      }
      html = next;
    }
  }

  // ---- legal pages + index also get flow.js (for tracking) --------------
  if ((LEGAL.has(slug) || slug === 'index') && !html.includes('/js/flow.js') && html.includes('/js/common.js')) {
    html = html.replace(
      /(<script src="\/js\/common\.js\?v=[^"]*"><\/script>\n)/,
      `$1<script src="/js/tool-graph.js?v=${VERSION}"></script>\n<script src="/js/flow.js?v=${VERSION}"></script>\n`
    );
  }

  // ---- 404 and offline: recent tools needs the graph and flow -----------
  // These two carried no JavaScript at all, so a dead end stayed a dead end.
  if ((slug === '404' || slug === 'offline') && !html.includes('/js/flow.js')) {
    html = html.replace(
      /(\n<script src="\/js\/pwa\.js)/,
      `\n<script src="/js/common.js?v=${VERSION}"></script>` +
      `\n<script src="/js/tool-graph.js?v=${VERSION}"></script>` +
      `\n<script src="/js/flow.js?v=${VERSION}"></script>` +
      `\n<script src="/js/consent.js?v=${VERSION}"></script>$1`
    );
  }

  if (html !== before) {
    if (CHECK) stale.push(file);
    else fs.writeFileSync(p, html);
    changed++;
  }
}

if (CHECK) {
  if (stale.length) {
    console.error(`build-nav --check: ${stale.length} file(s) out of date: ${stale.join(', ')}`);
    console.error('Run: node tools/build-nav.js');
    process.exit(1);
  }
  console.log('build-nav --check: every generated block is current.');
  process.exit(0);
}

console.log(`build-nav: updated ${changed} files`);
console.log(`  footer directory: ${G.slugs().length} tools x ${files.length + 1} pages`);
console.log(`  homepage rails:   ${G.HOME_RAILS.length} rails covering all ${G.slugs().length} tools`);
