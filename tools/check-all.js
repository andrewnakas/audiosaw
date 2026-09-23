#!/usr/bin/env node
/*
 * Runs every generator in --check mode.
 *
 * The generated blocks drift silently: two categories rendered a literal
 * "undefined" paragraph on /tools for months because nothing compared the
 * output to the source. This is the guard. Run it before every commit.
 *
 * check-includes.js is not a generator but belongs to the same class of silent
 * drift: a hand-assembled <script> list that is missing a file, or has one in
 * the wrong order, breaks a tool with nothing visible on the page.
 *
 * check-fx.js renders every audio-editor effect in headless Chrome, which
 * takes about twenty seconds. check-project-link.js drives an editor -> tool ->
 * editor round trip through the real pages, about fifteen more. Both skip
 * themselves on a machine without Chrome.
 */
const { execFileSync } = require('child_process');
const path = require('path');

const CHECKS = [
  ['build-nav.js', '--check'],
  ['build-faq.js', '--check'],
  ['build-dates.js', '--check'],
  ['build-sitemap.js', '--check'],
  ['build-llms.js', '--check'],
  ['check-includes.js'],
  ['check-editor.js'],
  ['check-key.js'],
  ['check-chords.js'],
  ['check-slicer.js'],
  ['check-beat.js'],
  ['check-pitch.js'],
  ['check-fx.js'],
  ['check-project-link.js'],
  ['check-grid.js']
];

let failed = 0;
for (const [script, ...args] of CHECKS) {
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, script), ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    });
    process.stdout.write(out);
  } catch (e) {
    failed++;
    process.stdout.write(e.stdout || '');
    process.stderr.write(e.stderr || `${script} failed\n`);
  }
}
if (failed) {
  console.error(`\ncheck-all: ${failed} check(s) failed.`);
  process.exit(1);
}
console.log('\ncheck-all: all generated files are current and every page has its scripts.');
