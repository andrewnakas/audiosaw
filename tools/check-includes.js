#!/usr/bin/env node
/*
 * Every page assembles its JavaScript by hand, so a page can reference a helper
 * whose file it never included. Nothing fails at load time: the page renders,
 * the dropzone binds, and the error only surfaces at the end of a conversion —
 * `/voice-recorder` shipped without `tool-shell.js` and died with
 * "CV.encodeBuffer is not a function" *after* the user had recorded a take.
 * Same failure shape as the include-order bug in CLAUDE.md, one step later.
 *
 * This walks the `<script>` tags of every page in document order, works out
 * which `CV.*` / `AudioSaw.*` members each included file defines, and flags a
 * member that is used but never defined — or defined only by a file that loads
 * *after* the one using it.
 *
 * Static, so it is deliberately conservative: comments and string literals are
 * stripped before scanning, and only these two namespaces are considered.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Derived, not listed, so a new module's global is covered the day it lands.
// Every namespace on the site is exported as `global.<name> = ...` from a file
// in /js: CV, AudioSaw, and the AS* modules (ASBpm, ASLoudness, ASPitch, ...).
// `AS_TOOL` is the one that travels the other way — a page sets it inline and
// tool-converter.js reads it — and the same ordering rule catches that too.
const JS_FILES = fs.readdirSync(path.join(ROOT, 'js')).filter((f) => f.endsWith('.js')).sort();
const NAMESPACES = [...new Set(
  JS_FILES.flatMap((f) => [...fs.readFileSync(path.join(ROOT, 'js', f), 'utf8')
    .matchAll(/(?:global|window|self)\.([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1]))
)].filter((n) => /^(CV|AudioSaw|AS[A-Z_])/.test(n)).sort();

// Comments and strings hold plenty of `CV.shell` prose ("Not built on CV.shell:
// ...") that is not a call. Blank them out before any matching.
function strip(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

// Members a file adds to a namespace: the `global.CV = { ... }` literal in
// common.js and audio-core.js, plus the `CV.encodeBuffer = ...` assignments
// tool-shell.js uses.
function definitions(src) {
  const code = strip(src);
  const out = {};
  for (const ns of NAMESPACES) {
    const found = new Set();
    for (const m of code.matchAll(new RegExp('(?:global|window|self)\\.' + ns + '\\s*=\\s*\\{', 'g'))) {
      const open = code.indexOf('{', m.index);
      let depth = 0, end = open;
      for (; end < code.length; end++) {
        if (code[end] === '{') depth++;
        else if (code[end] === '}' && --depth === 0) break;
      }
      const body = code.slice(open + 1, end);
      let nest = 0;
      for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (c === '{' || c === '(' || c === '[') nest++;
        else if (c === '}' || c === ')' || c === ']') nest--;
        else if (nest === 0 && c === ':') {
          const key = /([A-Za-z_$][\w$]*)\s*$/.exec(body.slice(0, i));
          if (key) found.add(key[1]);
        }
      }
    }
    for (const m of code.matchAll(new RegExp('(?:^|[^.\\w$])(?:(?:global|window|self)\\.)?' + ns + '\\.([A-Za-z_$][\\w$]*)\\s*=[^=]', 'g'))) {
      found.add(m[1]);
    }
    // `global.CV = {...}` or `window.AS_TOOL = {...}` also defines the
    // namespace itself, which is what a whole-object reference needs.
    if (new RegExp('(?:global|window|self)\\.' + ns + '\\s*=').test(code)) found.add('*');
    if (found.size) out[ns] = found;
  }
  return out;
}

// Two kinds of reference, because two kinds of mistake. `CV.encodeBuffer` needs
// that member; `window.AS_TOOL` is read as a whole object and only needs the
// namespace to exist by then. A bare namespace use is reported as member '*'.
// `if (global.CV && global.CV.track)` is pwa.js declaring CV optional on the
// five pages that carry no other JavaScript. A feature-detected reference is
// not a missing include, so don't report one.
function guarded(code, ns, at, len) {
  const after = code.slice(at + len, at + len + 8);
  if (/^\s*(&&|\|\|)/.test(after)) return true;
  const before = code.slice(Math.max(0, at - 90), at);
  const g = '(?:(?:global|window|self)\\.)?' + ns;
  return new RegExp(g + '\\s*&&').test(before) || new RegExp('typeof\\s+' + g).test(before);
}

function usages(src) {
  const code = strip(src);
  const out = [];
  for (const ns of NAMESPACES) {
    // The `global.` prefix is not optional decoration: loudness-page.js says
    // `global.ASLoudness.truePeak(...)`, and a pattern anchored on a bare `ns`
    // matches none of it — the first cut of this check passed every page while
    // seeing nothing at all.
    for (const m of code.matchAll(new RegExp('(?:^|[^.\\w$])(?:(?:global|window|self)\\.)?' + ns + '\\.([A-Za-z_$][\\w$]*)', 'g'))) {
      if (!guarded(code, ns, m.index, m[0].length)) out.push([ns, m[1]]);
    }
    // `window.AS_TOOL || {}` — the object itself, no member named. Skip the
    // assignment that defines it, which is a definition and not a use.
    for (const m of code.matchAll(new RegExp('(?:^|[^.\\w$])(?:(?:global|window|self)\\.)?' + ns + '(?![\\w$.])\\s*(=?)', 'g'))) {
      if (m[1] !== '=' && !guarded(code, ns, m.index, m[0].length)) out.push([ns, '*']);
    }
  }
  return out;
}

// Scripts in document order: external ones as their file body, inline ones as
// their own text, because an inline block that runs before its includes is the
// original version of this bug.
function scriptsOf(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    const src = /\bsrc\s*=\s*"([^"]+)"/.exec(m[1]);
    if (!src) {
      out.push({ label: 'inline script', body: m[2] });
      continue;
    }
    const url = src[1].split('?')[0];
    if (!url.startsWith('/js/')) continue;
    const file = path.join(ROOT, url.slice(1));
    if (!fs.existsSync(file)) {
      out.push({ label: url, body: '', missing: true });
      continue;
    }
    out.push({ label: url, body: fs.readFileSync(file, 'utf8') });
  }
  return out;
}

const cache = new Map();
function defsOf(script) {
  if (script.label.startsWith('/js/')) {
    if (!cache.has(script.label)) cache.set(script.label, definitions(script.body));
    return cache.get(script.label);
  }
  return definitions(script.body);
}

// Which file would have fixed it — reported so the failure names its own cure.
const providers = new Map();
function providerFor(ns, member) {
  const key = ns + '.' + member;
  if (providers.has(key)) return providers.get(key);
  for (const f of JS_FILES) {
    const d = definitions(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'));
    if (d[ns] && d[ns].has(member)) {
      providers.set(key, '/js/' + f);
      return providers.get(key);
    }
  }
  providers.set(key, null);
  return null;
}

const problems = [];
for (const page of fs.readdirSync(ROOT).filter((f) => f.endsWith('.html')).sort()) {
  const scripts = scriptsOf(fs.readFileSync(path.join(ROOT, page), 'utf8'));
  const seen = Object.fromEntries(NAMESPACES.map((ns) => [ns, new Set()]));
  for (const script of scripts) {
    if (script.missing) {
      problems.push(`${page}: includes ${script.label}, which does not exist`);
      continue;
    }
    // A file's own definitions count for its own use of them, so register
    // them before scanning: flow.js both defines and calls CV.track.
    const defs = defsOf(script);
    for (const ns of NAMESPACES) for (const m of defs[ns] || []) seen[ns].add(m);
    for (const [ns, member] of usages(script.body)) {
      if (seen[ns].has(member)) continue;
      const later = scripts.slice(scripts.indexOf(script) + 1)
        .some((s) => (defsOf(s)[ns] || new Set()).has(member));
      const provider = providerFor(ns, member);
      const what = member === '*' ? ns : `${ns}.${member}`;
      if (later) {
        problems.push(`${page}: ${script.label} uses ${what} before ${provider} loads`);
      } else if (provider) {
        problems.push(`${page}: ${script.label} uses ${what}, but ${provider} is not included`);
      } else {
        problems.push(`${page}: ${script.label} uses ${what}, which nothing in /js defines`);
      }
      seen[ns].add(member); // one line per member, not one per call site
    }
  }
}

if (problems.length) {
  for (const p of problems) console.error(p);
  console.error(`\ncheck-includes: ${problems.length} problem(s).`);
  process.exit(1);
}
console.log('check-includes: every page includes the scripts its helpers live in.');
