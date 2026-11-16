#!/usr/bin/env node
// The busiest pages at phone size (390x844, touch, mobile UA), the way 35% of
// visitors see them (GA4, Oct-Nov 2026). For each page:
//   - nothing is wider than the screen (no sideways scroll);
//   - the place to put a file (or the main control on a page that takes none)
//     starts on the first screen, so the tool is visible without scrolling;
//   - every button, link and select in the tool is at least 32 px tall
//     (a thumb, not a cursor);
//   - no page errors.
// The list is the top of the convert_start table in playbook §20.
'use strict';
const { withPage, findChrome } = require('./chrome-harness');

const PAGES = ['/', '/audio-to-sheet-music', '/text-to-speech', '/voice-recorder', '/audio-editor',
  '/pitch-shifter', '/split-audio', '/video-dubbing', '/audio-to-text', '/key-finder', '/voice-cloning',
  '/audio-eq', '/text-to-audiobook', '/noise-reduction', '/mp3-tag-editor', '/stem-splitter'];
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';

let failed = 0;
function ok(c, msg) { console.log((c ? '  ok  ' : '  FAIL ') + msg); if (!c) failed++; }

async function main() {
  if (!findChrome()) { console.log('check-mobile: no Chrome, skipped'); return; }
  await withPage({}, async (page) => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await page.send('Emulation.setUserAgentOverride', { userAgent: UA });
    for (const p of PAGES) {
      page.logs.length = 0;
      await page.goto(p, 800);
      const r = await page.eval(`(() => {
        const vw = document.documentElement.clientWidth;
        const wide = [...document.querySelectorAll('body *')].filter((el) => {
          const b = el.getBoundingClientRect(); const cs = getComputedStyle(el);
          if (!b.width || cs.position === 'fixed' || el.closest('.rail-row, .ts-list, [hidden]')) return false;
          let a = el.parentElement; while (a) { const o = getComputedStyle(a).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') return false; a = a.parentElement; }
          return b.right > vw + 1;
        }).slice(0, 3).map((el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''));
        const target = document.querySelector('.tool-app') || document.querySelector('#dropzone, .dropzone, textarea, canvas, button.btn');
        const top = target ? target.getBoundingClientRect().top + scrollY : null;
        const app = document.querySelector('.tool-app') || document.querySelector('main');
        const small = app ? [...app.querySelectorAll('button, select, a.btn, input[type=checkbox] + label')].filter((el) => {
          const b = el.getBoundingClientRect(); return b.width && b.height && b.height < 32 && !el.closest('[hidden]') && getComputedStyle(el).visibility !== 'hidden';
        }).slice(0, 4).map((el) => (el.id || el.textContent.trim().slice(0, 18)) + ' ' + Math.round(el.getBoundingClientRect().height) + 'px') : [];
        return { sw: document.documentElement.scrollWidth, vw, wide, top, target: target && (target.id || target.className), small };
      })()`);
      const errs = page.logs.filter((l) => !/scriptwrapper|ERR_CONNECTION_REFUSED|favicon|googletagmanager/.test(l));
      ok(r.sw <= r.vw && !r.wide.length, `${p}: fits the screen (${r.sw}/${r.vw})` + (r.wide.length ? ' — too wide: ' + r.wide.join(', ') : ''));
      ok(r.top !== null && r.top < 844, `${p}: tool starts on the first screen (${r.target} at ${r.top === null ? '—' : Math.round(r.top)} px)`);
      ok(!r.small.length, `${p}: controls at least 32 px tall` + (r.small.length ? ' — ' + r.small.join(', ') : ''));
      ok(!errs.length, `${p}: no page errors` + (errs.length ? ': ' + errs.join(' | ').slice(0, 200) : ''));
    }
  });
}

main().then(() => {
  if (failed) { console.log('\ncheck-mobile: ' + failed + ' failed'); process.exit(1); }
  console.log('\ncheck-mobile: all good');
}).catch((e) => { console.error(e); process.exit(1); });
