#!/usr/bin/env node
// The consent banner and the ad bar (9 Oct 2026).
//
// 1. In Europe, with no ad CMP on the page (the ad-free pages, an ad
//    blocker), our banner still appears.
// 2. In Europe, when Journey's TCF CMP is running, ours stays away and GA's
//    consent follows the CMP's answer: one banner, not two.
// 3. Outside Europe, no banner at all.
// 4. On a 13" laptop (1354 x 690 inside the browser) the tool starts high
//    enough that Journey's ~90 px bottom bar does not sit on it.
const { withPage } = require('./chrome-harness');

let failed = 0;
const ok = (c, m) => { console.log((c ? '  ok  ' : '  FAIL ') + m); if (!c) failed++; };

// A stand-in for Journey's CMP: answers addEventListener with a stored
// choice, the way a returning visitor's TC string does.
const fakeTcf = (granted) => `
  window.__tcfapi = function (cmd, v, cb) {
    if (cmd !== 'addEventListener') return;
    setTimeout(function () {
      cb({ gdprApplies: true, eventStatus: 'tcloaded',
           purpose: { consents: ${granted ? '{1: true, 8: true, 9: true}' : '{1: true}'} } }, true);
    }, 300);
  };`;

async function scenario(tz, inject, path) {
  return withPage({}, async (page) => {
    await page.send('Emulation.setTimezoneOverride', { timezoneId: tz });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1354, height: 690, deviceScaleFactor: 1, mobile: false });
    if (inject) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: inject });
    await page.goto(path || '/mp4-to-mp3');
    await new Promise((r) => setTimeout(r, 5000));
    return page.eval(`(function () {
      var upd = (window.dataLayer || []).filter(function (a) { return a[0] === 'consent' && a[1] === 'update'; });
      var app = document.querySelector('.tool-app');
      return {
        banner: !!document.getElementById('fbc-consent'),
        update: upd.length ? upd[upd.length - 1][2].analytics_storage : null,
        stored: localStorage.getItem('fex_consent_v1'),
        toolTop: app ? Math.round(app.getBoundingClientRect().top) : null,
        vh: innerHeight
      };
    })()`);
  });
}

(async () => {
  console.log('check-consent: one consent banner, and a tool the ad bar does not cover');
  const a = await scenario('Europe/Berlin', null);
  ok(a.banner, 'Europe, no ad CMP: our banner appears');
  const b = await scenario('Europe/Berlin', fakeTcf(true));
  ok(!b.banner, 'Europe, CMP running: our banner stays away');
  ok(b.update === 'granted' && b.stored === 'all', 'the CMP\'s yes reaches GA (' + b.update + ', stored ' + b.stored + ')');
  const c = await scenario('Europe/Paris', fakeTcf(false));
  ok(!c.banner && c.update === 'denied' && c.stored === 'essential', 'the CMP\'s no reaches GA (' + c.update + ', stored ' + c.stored + ')');
  const d = await scenario('America/Chicago', null);
  ok(!d.banner, 'outside Europe: no banner');
  // The ad bar is ~90 px. The tool's top edge must clear it with room for its
  // first row (drop zone or record button) to show.
  for (const p of ['/mp4-to-mp3', '/voice-recorder', '/split-audio']) {
    const r = await scenario('America/Chicago', null, p);
    ok(r.toolTop !== null && r.toolTop < r.vh - 90 - 160, p + ': the tool starts at ' + r.toolTop + ' px of ' + r.vh + ' (under ' + (r.vh - 250) + ')');
  }
  console.log(failed ? '\n' + failed + ' check(s) failed' : '\ncheck-consent: all good');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
