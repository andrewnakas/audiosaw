#!/usr/bin/env node
/*
 * Which model size a phone gets, in Playwright WebKit with Playwright's own
 * iPhone and iPad profiles (every browser on iOS is WebKit).
 *
 * /video-dubbing used to give a phone the 326 MB fp32 voice model, because
 * Safari reports a WebGPU adapter; GA4 19 Oct-15 Nov showed 9 of 97 visitors
 * hitting "memory" there. Since 16 Nov 2026 phones and tablets get the 92 MB
 * model unless the big one is already cached, and desktops keep the GPU
 * model. /text-to-audiobook's engine choice follows the same rule.
 * Nothing is downloaded: this reads the page's choice.
 *
 * Requires Playwright with WebKit in ~/.cache/audiosaw/playwright (see
 * check-webkit.js); skipped without it.
 */
const fs = require('fs'), os = require('os'), path = require('path');
const PW = path.join(os.homedir(), '.cache', 'audiosaw', 'playwright', 'node_modules', 'playwright');
if (!fs.existsSync(PW)) { console.log('check-phone-models: skipped (no Playwright in ~/.cache/audiosaw/playwright)'); process.exit(0); }
const { webkit, devices } = require(PW);

let failed = 0;
const ok = (c, m) => { console.log((c ? '  ok  ' : '  FAIL ') + m); if (!c) failed++; };

(async () => {
  const { start } = require('./serve');
  const s = await start(0);
  const browser = await webkit.launch();
  try {
    for (const [name, opts, want] of [['iPhone 15', devices['iPhone 15'], true], ['iPad Pro 11', devices['iPad Pro 11'], true], ['desktop Safari', {}, false]]) {
      const ctx = await browser.newContext(opts);
      await ctx.route(/scriptwrapper|googletagmanager/, (r) => r.abort());
      const page = await ctx.newPage();
      await page.goto('http://127.0.0.1:' + s.port + '/video-dubbing');
      await page.waitForTimeout(500);
      const small = await page.evaluate(() => window.__dubPage.smallVoice());
      ok(small === want, '/video-dubbing on ' + name + ': ' + (small ? 'the 92 MB voice model' : 'the GPU voice model'));
      await page.goto('http://127.0.0.1:' + s.port + '/text-to-audiobook');
      await page.waitForTimeout(500);
      const eng = await page.evaluate(() => document.querySelector('#engine').value);
      ok((eng === 'small') === want, '/text-to-audiobook on ' + name + ': engine "' + eng + '"');
      await ctx.close();
    }
  } finally { await browser.close(); s.close(); }
  console.log(failed ? '\ncheck-phone-models: ' + failed + ' failed' : '\ncheck-phone-models: all good');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
