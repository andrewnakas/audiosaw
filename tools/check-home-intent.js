#!/usr/bin/env node
// The homepage's "What do you want to do with it?" cards (js/home-intent.js)
// and the handoff that carries the dropped file to the chosen tool.
//
//   1. Every tool in HOME_INTENTS has a file input, and takes the kind of file
//      it is offered for (audio: .wav, .mp3, .m4a; video: .mp4), asked of the
//      page itself through CV.flow.accepts.
//   2. Dropping a short WAV, a 12-minute M4A, an MP4 and two files on / shows
//      the right cards (long files lift transcribe/split; video gets subtitles).
//   3. Clicking a card opens the tool with the file already loaded, fires
//      chain_continue once with placement home_intent, and clears the handoff,
//      so a later visit with ?from=index does not load it again.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { withPage, findChrome } = require('./chrome-harness');
const G = require('../js/tool-graph.js');

let failed = 0;
function ok(c, msg) { console.log((c ? '  ok  ' : '  FAIL ') + msg); if (!c) failed++; }

function ff(args, out) { execFileSync('ffmpeg', ['-loglevel', 'error', '-y'].concat(args, [out])); return out; }

const DROP = (b64, name, type) => `(async () => {
  const bin = atob('${b64}'); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  window.__f = new File([u], '${name}', { type: '${type}' });
})()`;

async function main() {
  if (!findChrome()) { console.log('check-home-intent: no Chrome, skipped'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-hi-'));
  const wav = ff(['-f', 'lavfi', '-i', 'sine=f=440:d=5', '-ac', '2', '-c:a', 'pcm_s16le'], path.join(dir, 'song.wav'));
  const m4a = ff(['-f', 'lavfi', '-i', 'sine=f=220:d=720', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '12k'], path.join(dir, 'lecture.m4a'));
  const mp4 = ff(['-f', 'lavfi', '-i', 'testsrc=d=2:s=160x120:r=10', '-f', 'lavfi', '-i', 'sine=f=330:d=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'], path.join(dir, 'clip.mp4'));
  const b64 = (f) => fs.readFileSync(f).toString('base64');

  await withPage({}, async (page) => {
    console.log('accept lists');
    const want = { audio: ['wav', 'mp3', 'm4a'], video: ['mp4'] };
    const slugs = {};
    for (const [kind, list] of Object.entries(G.HOME_INTENTS)) {
      for (const [slug] of list) if (slug !== 'here') (slugs[slug] = slugs[slug] || new Set()).add(kind);
    }
    for (const [slug, kinds] of Object.entries(slugs)) {
      await page.goto('/' + slug, 300);
      const exts = [].concat(...[...kinds].map((k) => want[k]));
      const r = await page.eval(`({ input: !!document.getElementById('fileInput'),
        refused: ${JSON.stringify(exts)}.filter((e) => !(window.CV && CV.flow && CV.flow.accepts(e))) })`);
      ok(r.input && !r.refused.length, `/${slug} takes ${exts.join(', ')}` +
        (r.input ? '' : ' (no #fileInput)') + (r.refused.length ? ' (refuses ' + r.refused.join(', ') + ')' : ''));
    }

    console.log('cards');
    async function dropOnHome(files) {
      await page.goto('/', 500);
      for (const [i, [f, type]] of files.entries()) {
        await page.eval(DROP(b64(f), path.basename(f), type));
        await page.eval(`(window.__fs = window.__fs || []).push(window.__f)`);
      }
      return page.eval(`(async () => {
        const dt = new DataTransfer(); window.__fs.forEach((f) => dt.items.add(f));
        const input = document.getElementById('fileInput'); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
        const host = document.getElementById('homeIntent');
        for (let i = 0; i < 60 && host.hidden; i++) await new Promise((r) => setTimeout(r, 100));
        return { hidden: host.hidden, multi: !!host.querySelector('.hi-multi'),
          meta: (host.querySelector('.hi-meta') || {}).textContent,
          cards: [...host.querySelectorAll('.hi-card')].map((a) => a.getAttribute('href') || 'here'),
          visible: [...host.querySelectorAll('.hi-card')].filter((a) => a.offsetParent).length,
          controls: document.getElementById('universalControls').style.display !== 'none' };
      })()`);
    }

    let r = await dropOnHome([[wav, 'audio/wav']]);
    ok(!r.hidden && r.cards[0] === 'here' && r.cards[1] === '/audio-cutter' && (r.visible === 6 || r.visible === 8) && r.controls,
      `short WAV: ${r.visible} cards shown, converter first and still open (${r.cards.slice(0, 6).join(' ')}; ${r.meta})`);
    r = await dropOnHome([[m4a, 'audio/mp4']]);
    ok(r.cards.slice(1, 4).includes('/audio-to-text') && r.cards.slice(1, 4).includes('/split-audio') && /12:00/.test(r.meta),
      `12-minute M4A: long-file jobs lifted (${r.cards.slice(0, 5).join(' ')}; ${r.meta})`);
    r = await dropOnHome([[mp4, 'video/mp4']]);
    ok(r.cards[1] === '/add-subtitles-to-video' && !r.cards.includes('/stem-splitter'),
      `MP4: video jobs (${r.cards.slice(0, 6).join(' ')})`);
    r = await dropOnHome([[wav, 'audio/wav'], [mp4, 'video/mp4']]);
    ok(r.multi && !r.cards.length, 'two files: no cards, a line pointing at batch convert and the joiner');

    console.log('handoff');
    await dropOnHome([[wav, 'audio/wav']]);
    await page.eval(`document.querySelector('.hi-card[href="/audio-cutter"]').click()`);
    let landed = null;
    for (let i = 0; i < 80; i++) {
      await new Promise((res) => setTimeout(res, 200));
      landed = await page.eval(`(location.pathname === '/audio-cutter' && document.readyState === 'complete') ? {
        q: location.search,
        // gtag() pushes its arguments object onto dataLayer.
        events: (window.dataLayer || []).filter((a) => a && a[0] === 'event').map((a) => [a[1], a[2]]).filter((e) => e[0] === 'chain_continue' || e[0] === 'file_selected'),
        listed: (document.getElementById('fileList') || document.body).textContent.includes('song.wav') || document.body.textContent.includes('song.wav'),
        chip: !!document.querySelector('.handoff-chip')
      } : null`).catch(() => null);
      if (landed && landed.events.length) break;
    }
    ok(landed && landed.q === '?from=index', 'the card opens /audio-cutter?from=index');
    const cc = landed ? landed.events.filter((e) => e[0] === 'chain_continue') : [];
    ok(cc.length === 1 && cc[0][1].placement === 'home_intent' && cc[0][1].accepted === true && cc[0][1].to_tool === 'audio-cutter',
      'chain_continue once, placement home_intent, accepted: ' + JSON.stringify(cc));
    ok(landed && landed.listed && !landed.chip, 'the file is loaded with no chip to click');
    const left = await page.eval(`new Promise((res) => { const q = indexedDB.open('audiosaw', 1); q.onsuccess = () => { const db = q.result; try { const g = db.transaction('handoff').objectStore('handoff').get('pending'); g.onsuccess = () => { res(!!g.result); db.close(); }; } catch (e) { res(false); } }; q.onerror = () => res(false); })`);
    ok(!left, 'the handoff is cleared after it is taken');

    console.log('wrong file type');
    // An .m4a dropped on /wav-to-mp3 is refused; the panel's "M4A to MP3"
    // chip must open that tool with the same file already in it.
    await page.goto('/wav-to-mp3', 500);
    await page.eval(DROP(b64(m4a), 'memo.m4a', 'audio/mp4'));
    const chips = await page.eval(`(async () => {
      const dt = new DataTransfer(); dt.items.add(window.__f);
      const input = document.getElementById('fileInput'); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
      for (let i = 0; i < 30 && !document.getElementById('errorHelp'); i++) await new Promise((r) => setTimeout(r, 100));
      return [...document.querySelectorAll('#errorHelp a')].map((a) => a.getAttribute('href') + ' ' + a.textContent);
    })()`);
    ok(chips[0] === '/m4a-to-mp3 M4A to MP3' && chips.some((c) => /^\/ Other things to do with memo\.m4a/.test(c)),
      'the panel offers the right tool and the homepage, both with the file: ' + chips.join(' | '));
    await page.eval(`document.querySelector('#errorHelp a[href="/m4a-to-mp3"]').click()`);
    let moved = null;
    for (let i = 0; i < 80; i++) {
      await new Promise((res) => setTimeout(res, 200));
      moved = await page.eval(`(location.pathname === '/m4a-to-mp3' && document.readyState === 'complete') ? {
        q: location.search, listed: document.body.textContent.includes('memo.m4a'),
        cc: (window.dataLayer || []).filter((a) => a && a[0] === 'event' && a[1] === 'chain_continue').map((a) => a[2]) } : null`).catch(() => null);
      if (moved && moved.cc.length) break;
    }
    ok(moved && moved.q === '?from=wav-to-mp3' && moved.listed && moved.cc.length === 1 && moved.cc[0].placement === 'error' && moved.cc[0].accepted,
      'the chip opens /m4a-to-mp3 with memo.m4a loaded: ' + JSON.stringify(moved));

    const errs = page.logs.filter((l) => !/scriptwrapper|ERR_CONNECTION_REFUSED|favicon|googletagmanager/.test(l));
    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ').slice(0, 400) : ''));
  });
  await webkitFlow(m4a);
  fs.rmSync(dir, { recursive: true, force: true });
}

// The same drop -> card -> tool in WebKit at phone size, when Playwright's
// WebKit is installed (see check-webkit.js). WebKit's ephemeral contexts, like
// Safari's private windows, refuse Blobs in IndexedDB; the handoff falls back
// to bytes, and this is what showed the file arriving empty before it did.
async function webkitFlow(m4a) {
  const PW = path.join(os.homedir(), '.cache', 'audiosaw', 'playwright', 'node_modules', 'playwright');
  if (!fs.existsSync(PW)) { console.log('webkit\n  skip: no Playwright in ~/.cache/audiosaw/playwright'); return; }
  let browser;
  try { browser = await require(PW).webkit.launch(); } catch (e) { console.log('webkit\n  skip: WebKit not installed (npx playwright install webkit)'); return; }
  console.log('webkit');
  const s = await require('./serve').start(0);
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await ctx.route(/scriptwrapper|googletagmanager/, (r) => r.abort());
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('http://127.0.0.1:' + s.port + '/');
    await page.setInputFiles('#fileInput', m4a);
    await page.waitForSelector('#homeIntent:not([hidden]) .hi-card', { timeout: 20000 });
    await page.click('.hi-card[href="/audio-to-text"]');
    await page.waitForURL(/audio-to-text\?from=index/, { timeout: 30000 });
    const got = await page.waitForFunction(() => document.body.textContent.includes('lecture.m4a'), null, { timeout: 20000 }).then(() => true, () => false);
    ok(got, 'WebKit (phone): the card opens /audio-to-text with lecture.m4a loaded');
    await page.goto('http://127.0.0.1:' + s.port + '/tools');
    await page.fill('#toolSearchInput', 'm4a to mp3');
    const first = await page.textContent('#toolSearchList a');
    ok(first === 'M4A to MP3', 'WebKit: the search box on /tools answers "m4a to mp3" with ' + first);
    ok(!errors.length, 'WebKit: no page errors' + (errors.length ? ': ' + errors.join(' | ').slice(0, 300) : ''));
  } finally {
    await browser.close();
    await s.close();
  }
}

main().then(() => {
  if (failed) { console.log('\ncheck-home-intent: ' + failed + ' failed'); process.exit(1); }
  console.log('\ncheck-home-intent: all good');
}).catch((e) => { console.error(e); process.exit(1); });
