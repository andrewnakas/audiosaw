#!/usr/bin/env node
/*
 * Checks /mic-test (js/mic-test-page.js) in headless Chrome.
 *
 * The microphone is replaced, per case, by a MediaStream from a second
 * AudioContext carrying a known signal, so each verdict is tested against
 * the input that should produce it:
 *   - a -12 dBFS tone: "working", the panel lists the device's settings,
 *     and a 5 s test clip comes back 5 s long at the context's rate;
 *   - pure zeros: "digital silence" (a mute upstream of the page);
 *   - a tone at 1.5x full scale: clipping;
 *   - a -50 dBFS tone: "very quiet";
 *   - a stereo stream with the right side empty: one side silent, still OK;
 *   - getUserMedia refusing: the permission advice, and analytics files it
 *     under mic_denied;
 *   - and Chrome's own fake microphone, end to end, with no replacement.
 * Hearing the clip to the end fires convert_success (target_format 'play')
 * once, not once per replay.
 */
const { withPage, findChrome } = require('./chrome-harness');

let failed = 0;
const ok = (c, m) => { console.log((c ? '  ok  ' : '  FAIL ') + m); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs in the page: getUserMedia answers with a synthetic stream.
const fake = (spec) => `(function () {
  window.__events = [];
  var orig = CV.track; CV.track = function (n, p) { window.__events.push([n, p]); return orig.apply(this, arguments); };
  var spec = ${JSON.stringify(spec)};
  navigator.mediaDevices.getUserMedia = async function () {
    if (spec.deny) throw new DOMException('Permission denied', 'NotAllowedError');
    var c = new AudioContext(); await c.resume();
    var dest = c.createMediaStreamDestination();
    dest.channelCount = spec.channels || 1;
    var merger = c.createChannelMerger(spec.channels || 1);
    (spec.amps || [0]).forEach(function (a, i) {
      var o = c.createOscillator(); o.frequency.value = 440;
      var g = c.createGain(); g.gain.value = a;
      o.connect(g).connect(merger, 0, i); o.start();
    });
    merger.connect(dest);
    window.__fakeCtx = c;
    return dest.stream;
  };
})()`;

async function run(page, spec, wait) {
  await page.goto('/mic-test', 600);
  if (spec) await page.eval(fake(spec));
  // A real click: an AudioContext made from a script's click() never runs.
  const r = await page.eval('(function () { var e = document.getElementById("micStart"); e.scrollIntoView({ block: "center" }); var b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()');
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', buttons: 1, clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(wait || 3500);
  return page.eval('Object.assign(window.__micTest.state(), { status: document.getElementById("status").textContent, events: window.__events || [] })');
}

(async () => {
  if (!findChrome()) { console.log('check-mic-test: skip, no Chrome'); return; }
  await withPage({}, async (page) => {
    let s = await run(page, { amps: [0.25] });
    ok(/working/i.test(s.verdict) && /healthy/.test(s.verdict), 'a -12 dBFS tone reads as working, healthy level (' + s.verdict.slice(0, 60) + '…)');
    ok(/^-1[12]\.\d dBFS$/.test(s.peak.replace('−', '-')), 'peak reads -12 dBFS (' + s.peak + ')');
    ok(/Sample rate/.test(s.info) && /Echo cancellation/.test(s.info), 'the panel lists what the browser delivered');
    await page.eval('window.__micTest.record()');
    await sleep(6500);
    s = await page.eval('window.__micTest.state()');
    ok(s.clip && Math.abs(s.clip.length / s.clip.rate - 5) < 0.1, 'the test clip is 5 s long (' + (s.clip ? (s.clip.length / s.clip.rate).toFixed(3) : 'none') + ' s)');
    const played = await page.eval(`(function () {
      var p = document.getElementById('micPlayer');
      p.dispatchEvent(new Event('ended')); p.dispatchEvent(new Event('ended'));
      return { src: !!p.src, n: window.__events.filter(function (e) { return e[0] === 'convert_success' && e[1].target_format === 'play' && e[1].tool === 'mic-test'; }).length };
    })()`);
    ok(played.src && played.n === 1, 'hearing the clip to the end counts once (' + played.n + ')');

    s = await run(page, { amps: [0] });
    ok(/digital silence/.test(s.verdict), 'all zeros reads as digital silence');

    s = await run(page, { amps: [1.5] });
    ok(/clipping/i.test(s.verdict), 'a tone over full scale reads as clipping');

    s = await run(page, { amps: [0.003] });
    ok(/very quiet/i.test(s.verdict), 'a -50 dBFS tone reads as very quiet (' + s.peak + ')');

    s = await run(page, { channels: 2, amps: [0.25, 0] });
    ok(s.channels === 2 && /one side/i.test(s.verdict), 'stereo with an empty right side is named, and still working (' + s.channels + ' ch)');

    s = await run(page, { deny: true }, 800);
    const denied = (await page.eval('(window.dataLayer || []).map(function (a) { return Array.prototype.slice.call(a); }).filter(function (a) { return a[0] === "event"; })'))
      .map((a) => [a[1], a[2] || {}]).find((e) => e[0] === 'convert_error');
    ok(/refused/.test(s.status) && denied && denied[1].error_type === 'mic_denied', 'a refused microphone gets the advice and is filed as mic_denied (' + (denied && denied[1].error_type) + ')');

    s = await run(page, null, 4000);
    ok(!/digital silence/.test(s.verdict) && s.verdict.length > 0 && /Sample rate/.test(s.info), "Chrome's fake microphone end to end (" + s.verdict.slice(0, 50) + '…)');

    const errs = page.logs.filter((l) => !/scriptwrapper|ERR_CONNECTION_REFUSED|favicon/.test(l));
    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ').slice(0, 300) : ''));
  });
  if (failed) { console.log('\ncheck-mic-test: ' + failed + ' failed'); process.exit(1); }
  console.log('\ncheck-mic-test: all good');
})().catch((e) => { console.error(e); process.exit(1); });
