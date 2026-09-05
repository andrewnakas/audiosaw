#!/usr/bin/env node
/*
 * Runs every generator in --check mode.
 *
 * The generated blocks drift silently: two categories rendered a literal
 * "undefined" paragraph on /tools for months because nothing compared the
 * output to the source. This is the guard. Run it before every commit.
 */
const { execFileSync } = require('child_process');
const path = require('path');

const CHECKS = ['build-nav.js', 'build-faq.js', 'build-sitemap.js', 'build-llms.js'];

let failed = 0;
for (const script of CHECKS) {
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, script), '--check'], {
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
  console.error(`\ncheck-all: ${failed} generator(s) out of date.`);
  process.exit(1);
}
console.log('\ncheck-all: all generated files are current.');
