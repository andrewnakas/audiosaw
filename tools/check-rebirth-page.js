#!/usr/bin/env node
/*
 * Checks /rebirth-player in headless Chrome (the engine is check-rebirth.js).
 *
 * Always, with the engine's own blank song (four bars at 140 BPM, no notes):
 *   - dropped, it renders in the worker: 302,399 frames (6.857 s), the facts
 *     line names the loop, and no drum note is shown;
 *   - the WAV download is 16-bit stereo at 44.1 kHz and exactly that long,
 *     and is the one convert_success;
 *   - a file of noise named .rbs is refused in words.
 *
 * With RB_SONGS=/dir, RB_KIT=/path/Standard.rbm and RB_KEY=/path/key.bin
 * (none of which is in this repository): a real song dropped alone says its
 * drum machines are silent; dropping the kit and key renders it again, the
 * note goes, and the audio is different by the drums.
 */
const fs = require('fs');
const path = require('path');
const { withPage } = require('./chrome-harness');
const R = require('../js/rebirth-play.js');

let failed = 0;
const ok = (c, m) => { console.log((c ? '  ok  ' : '  FAIL ') + m); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const drop = (list) => `(async () => {
  const s = document.getElementById('status'); s.className = 'status hidden';
  const dt = new DataTransfer();
  for (const [url, name] of ${JSON.stringify(list)}) { const b = await (await fetch(url)).arrayBuffer(); dt.items.add(new File([b], name)); }
  const input = document.getElementById('fileInput'); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  for (let i = 0; i < 600; i++) { await new Promise((r) => setTimeout(r, 100)); if (/success|error/.test(s.className)) return s.className + ' | ' + s.textContent; }
  return 'no status';
})()`;
// The player's audio as samples, kept on the page; the second call returns
// the largest difference from the first. One drum hit moves the RMS of a
// whole loop by almost nothing, so the renders are compared sample by sample.
const GRAB = `(async () => { const a = document.getElementById('rbAudio'); const b = await (await fetch(a.src)).arrayBuffer();
  const ac = new OfflineAudioContext(2, 44100, 44100); const buf = await ac.decodeAudioData(b); const x = buf.getChannelData(0);
  const was = window.__first; window.__first = window.__first || x.slice(); if (!was) return 0;
  let m = 0; for (let i = 0; i < x.length && i < was.length; i++) m = Math.max(m, Math.abs(x[i] - was[i])); return m; })()`;

async function main() {
  console.log('/rebirth-player');
  await R.load(fs.readFileSync(path.join(__dirname, '../vendor/openrb/2026-11-13/openrb.wasm')));
  const blank = Buffer.from(R.blankSong());
  const noise = Buffer.alloc(4096); for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761 >>> 13) & 255;
  const routes = { '/__blank.rbs': blank, '/__noise.rbs': noise };
  const E = process.env, real = E.RB_SONGS && E.RB_KIT && E.RB_KEY;
  let songFile = '';
  if (real) {
    // A song that plays a drum machine on the standard kit, so both halves of the test mean something.
    // A drum machine can be switched on and never hit (5 of the first 25
    // such songs render the same with and without the kit), so the song is
    // chosen by rendering it both ways here first.
    const kitBytes = fs.readFileSync(E.RB_KIT), keyBytes = fs.readFileSync(E.RB_KEY);
    songFile = fs.readdirSync(E.RB_SONGS).filter((f) => /\.rbs$/i.test(f)).find((f) => {
      try {
        const bytes = fs.readFileSync(path.join(E.RB_SONGS, f)), i = R.info(bytes);
        if (i.usesMod || !i.drums.length || i.duration < 5 || i.duration > 40) return false;
        const a = R.render(bytes, {}).channels[0], b = R.render(bytes, { kit: kitBytes, key: keyBytes }).channels[0];
        let m = 0; for (let k = 0; k < a.length; k++) m = Math.max(m, Math.abs(a[k] - b[k]));
        return m > 0.05;
      } catch (e) { return false; }
    });
    routes['/__song.rbs'] = fs.readFileSync(path.join(E.RB_SONGS, songFile));
    routes['/__kit.rbm'] = fs.readFileSync(E.RB_KIT);
    routes['/__key.bin'] = fs.readFileSync(E.RB_KEY);
  }
  await withPage({ routes }, async (page) => {
    await page.goto('/rebirth-player', 1200);
    await page.eval('(function () { window.__ev = []; var o = window.gtag; window.gtag = function (k, n, p) { if (k === "event") window.__ev.push(n + ":" + (p && p.target_format)); return o.apply(this, arguments); }; })()');
    await page.eval(`window.__dl = []; (function () { var o = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () {
      if (this.download) { var a = this; window.__dl.push(fetch(a.href).then((r) => r.arrayBuffer()).then((b) => ({ name: a.download, bytes: b }))); return; } return o.apply(this, arguments); }; })()`);
    const st = await page.eval(drop([['/__blank.rbs', 'blank.rbs']]));
    const s = await page.eval('window.__rb.state()');
    ok(/success/.test(st) && s.out, 'the blank song renders: "' + st.split(' | ')[1] + '"');
    ok(s.out && Math.abs(s.out.duration - 302399 / 44100) < 1e-6 && s.out.rate === 44100, 'four bars at 140 BPM are 302,399 frames (' + (s.out && Math.round(s.out.duration * 44100)) + ') at ' + (s.out && s.out.rate) + ' Hz');
    ok(/RBS 4\.2/.test(s.facts) && /140 BPM/.test(s.facts) && /bars 1 to 4 \(the song's loop\)/.test(s.facts), 'the facts line: "' + s.facts + '"');
    ok(!s.notes, 'no drum note for a song with no drums');
    await page.eval('document.getElementById("convertBtn").click()');
    for (let i = 0; i < 100; i++) { await sleep(100); if (await page.eval('window.__dl.length')) break; }
    const w = await page.eval('(async () => { const d = await window.__dl[0]; const v = new DataView(d.bytes); return { name: d.name, rate: v.getUint32(24, true), ch: v.getUint16(22, true), bits: v.getUint16(34, true), frames: (d.bytes.byteLength - 44) / 4 }; })()');
    ok(w.name === 'blank.wav' && w.rate === 44100 && w.ch === 2 && w.bits === 16 && w.frames === 302399, 'the download is ' + w.name + ': ' + w.rate + ' Hz, ' + w.ch + ' channels, ' + w.bits + '-bit, ' + w.frames + ' frames');
    let ev = await page.eval('window.__ev');
    ok(ev.filter((e) => e === 'convert_success:wav').length === 1 && ev.filter((e) => /^convert_start/.test(e)).length === 1, 'convert_start and convert_success once each');
    const bad = await page.eval(drop([['/__noise.rbs', 'noise.rbs']]));
    ok(/error/.test(bad) && (await page.eval('document.getElementById("rbView").hidden')), 'noise named .rbs is refused: "' + bad.split(' | ')[1] + '"');

    if (real) {
      const a = await page.eval(drop([['/__song.rbs', songFile]]));
      const s1 = await page.eval('window.__rb.state()');
      await page.eval(GRAB);
      ok(/success/.test(a) && /without drums/.test(a) && /drum machines are silent/.test(s1.notes), songFile + ' alone: "' + a.split(' | ')[1] + '"');
      const b = await page.eval(drop([['/__kit.rbm', 'Standard.rbm'], ['/__key.bin', 'rb20ful_window.bin']]));
      const s2 = await page.eval('window.__rb.state()');
      const diff = await page.eval(GRAB);
      ok(/success/.test(b) && !/without drums/.test(b) && s2.kit && s2.key && !/silent/.test(s2.notes), 'with the kit and key dropped it renders again with drums: "' + b.split(' | ')[1] + '"');
      ok(diff > 0.02 && Math.abs(s2.out.duration - s1.out.duration) < 1e-6, 'and the drums are in the audio, same length (largest sample difference ' + diff.toFixed(3) + ', ' + s2.out.duration.toFixed(2) + ' s)');
    } else console.log('  skip RB_SONGS, RB_KIT, RB_KEY: the drum-kit path was not driven');
    const errs = page.logs.filter((l) => !/scriptwrapper|ERR_CONNECTION_REFUSED|favicon|googletagmanager/.test(l));
    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ').slice(0, 300) : ''));
  });
}

main().then(() => {
  if (failed) { console.log('\ncheck-rebirth-page: ' + failed + ' failed'); process.exit(1); }
  console.log('\ncheck-rebirth-page: all good');
}).catch((e) => { console.error(e); process.exit(1); });
