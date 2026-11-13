#!/usr/bin/env node
/*
 * Checks the four hosted open-source apps, in headless Chrome:
 *
 * /webamp (Webamp 2.3.1): the player and its MilkDrop window render, a
 *   dropped WAV plays, three seconds of play is convert_success once, a
 *   dropped .wsz (built here: a zip holding one solid-colour main.bmp)
 *   changes the main window's skin, and the bundle asks the network for
 *   nothing but its own file.
 * /music-visualizer (Butterchurn 2.6.7): 100 presets, a dropped tone draws a
 *   picture that is not blank and moves, "Another preset" changes it, the
 *   PNG is the canvas size, and a three-second recording is a video of that
 *   size with the tone in its audio track.
 * /soundcraft (SoundCraft 0.20.1): with _headers applied, nothing is fetched
 *   before Start; the frame is sandboxed without allow-same-origin; the app
 *   reports that it started, which is convert_success once. Opened directly,
 *   the app's audio context runs after a click and Space makes sound.
 * /honeydew (Honeydew 0.5.3): the same sandbox and start message; opened
 *   directly, a MiniSynth key sounds, and choosing the Rock Kit fetches its
 *   pack from the hosted subset and a pad sounds.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { withPage } = require('./chrome-harness');

let failed = 0;
const ok = (c, m) => { console.log((c ? '  ok  ' : '  FAIL ') + m); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = (logs) => logs.filter((l) => !/scriptwrapper|ERR_CONNECTION_REFUSED|favicon|googletagmanager/.test(l));

function wav(seconds, hz) {
  const R = 44100, n = Math.round(seconds * R), b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22); b.writeUInt32LE(R, 24); b.writeUInt32LE(R * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(0.5 * 32767 * Math.sin(2 * Math.PI * hz * i / R)), 44 + i * 2);
  return b;
}

// A 24-bit BMP of one colour, and a zip with one deflated entry: the least
// that is still a Winamp skin. Webamp falls back to its base skin for every
// sprite sheet the archive leaves out.
function bmp(w, h, rgb) {
  const row = Math.ceil(w * 3 / 4) * 4, b = Buffer.alloc(54 + row * h);
  b.write('BM', 0); b.writeUInt32LE(b.length, 2); b.writeUInt32LE(54, 10); b.writeUInt32LE(40, 14); b.writeInt32LE(w, 18); b.writeInt32LE(h, 22);
  b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28); b.writeUInt32LE(row * h, 34);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = 54 + y * row + x * 3; b[o] = rgb[2]; b[o + 1] = rgb[1]; b[o + 2] = rgb[0]; }
  return b;
}
function crc32(buf) {
  let c, crc = ~0;
  for (let i = 0; i < buf.length; i++) { c = (crc ^ buf[i]) & 255; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1; crc = (crc >>> 8) ^ c; }
  return ~crc >>> 0;
}
function zip(name, data) {
  const def = zlib.deflateRawSync(data), nm = Buffer.from(name), crc = crc32(data);
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(def.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
  const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc, 16);
  ch.writeUInt32LE(def.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28);
  const eo = Buffer.alloc(22); eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(1, 8); eo.writeUInt16LE(1, 10); eo.writeUInt32LE(46 + nm.length, 12);
  eo.writeUInt32LE(30 + nm.length + def.length, 16);
  return Buffer.concat([lh, nm, def, ch, nm, eo]);
}

// Every event leaves through gtag, whether the page calls CV.track or flow.js
// counts a download itself, so that is the one place to listen.
const TRACK = '(function () { window.__ev = []; var o = window.gtag; window.gtag = function (k, n, p) { if (k === "event") window.__ev.push(n + ":" + (p && p.target_format)); return o.apply(this, arguments); }; })()';
const dropFiles = (list) => `(async () => {
  const dt = new DataTransfer();
  for (const [url, name, type] of ${JSON.stringify(list)}) { const b = await (await fetch(url)).arrayBuffer(); dt.items.add(new File([b], name, { type })); }
  const input = document.getElementById('fileInput'); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
})()`;

async function webamp() {
  console.log('/webamp');
  const routes = { '/__tone.wav': wav(40, 440), '/__skin.wsz': zip('MAIN.BMP', bmp(275, 116, [255, 0, 200])) };
  await withPage({ routes }, async (page) => {
    const asked = [];
    await page.send('Network.enable');
    page.listen('Network.requestWillBeSent', (p) => asked.push(p.request.url));
    await page.goto('/webamp', 1500);
    await page.eval(TRACK);
    let st = null;
    for (let i = 0; i < 100; i++) {
      st = await page.eval('({ main: !!document.querySelector("#webamp #main-window"), eq: !!document.querySelector("#webamp #equalizer-window"), pl: !!document.querySelector("#webamp #playlist-window"), milk: [...document.querySelectorAll("#webamp .gen-window canvas")].map((c) => c.width + "x" + c.height).join() })');
      if (st.main && st.pl) break;
      await sleep(200);
    }
    ok(st.main && st.eq && st.pl, 'the main, equaliser and playlist windows render');
    ok(!!st.milk, 'the MilkDrop window is open (canvas ' + st.milk + ')');
    const before = await page.eval('getComputedStyle(document.querySelector("#webamp #main-window")).backgroundImage.length');
    await page.eval(dropFiles([['/__tone.wav', 'tone.wav', 'audio/wav']]));
    let playing = false;
    for (let i = 0; i < 50 && !playing; i++) { await sleep(200); playing = await page.eval('/\\bplay\\b/.test(document.querySelector("#webamp #main-window").className)'); }
    ok(playing, 'a dropped WAV is playing');
    const title = await page.eval('(document.querySelector("#webamp #playlist-window") || {}).innerText || ""');
    ok(/tone/.test(title), 'it is in the playlist by its file name');
    await sleep(4200);
    const ev = await page.eval('window.__ev');
    ok(ev.filter((e) => e === 'convert_success:play').length === 1 && ev.filter((e) => e === 'convert_start:play').length === 1, 'three seconds of play is convert_success, once (' + ev.join(', ') + ')');
    await page.eval(dropFiles([['/__skin.wsz', 'pink.wsz', 'application/zip']]));
    let after = before;
    for (let i = 0; i < 50 && after === before; i++) { await sleep(200); after = await page.eval('getComputedStyle(document.querySelector("#webamp #main-window")).backgroundImage.length'); }
    ok(after !== before, 'a dropped .wsz reskins the main window (background ' + before + ' -> ' + after + ' chars)');
    const still = await page.eval('({ st: window.__wamp.status(), cls: document.querySelector("#webamp #main-window").className, t: (document.querySelector("#webamp audio") || {}).currentTime })');
    ok(still.st === 'PLAYING', 'and the song carries on (' + still.st + ', "' + still.cls + '")');
    const outside = asked.filter((u) => !u.startsWith(page.url('/')) && !/^(data|blob):/.test(u) && !/googletagmanager|scriptwrapper|google-analytics/.test(u));
    ok(!outside.length, 'the player asked the network for nothing of its own' + (outside.length ? ': ' + outside.slice(0, 3).join(' ') : ''));
    const errs = quiet(page.logs);
    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ').slice(0, 300) : ''));
  });
}

// Mean brightness and how many distinct colours, of the canvas as a PNG would save it.
const PIX = `(async () => {
  const c = document.getElementById('vzCanvas');
  const blob = await new Promise((r) => { window.__vz.render(); c.toBlob(r, 'image/png'); });
  const bm = await createImageBitmap(blob), k = document.createElement('canvas'); k.width = 160; k.height = 90;
  const g = k.getContext('2d'); g.drawImage(bm, 0, 0, 160, 90);
  const d = g.getImageData(0, 0, 160, 90).data; let sum = 0; const seen = new Set(); let sig = 0;
  for (let i = 0; i < d.length; i += 4) { sum += d[i] + d[i + 1] + d[i + 2]; seen.add((d[i] >> 3) << 10 | (d[i + 1] >> 3) << 5 | d[i + 2] >> 3); sig = (sig * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) >>> 0; }
  return { mean: sum / (d.length / 4 * 3), colours: seen.size, sig, w: bm.width, h: bm.height };
})()`;

async function visualizer() {
  console.log('/music-visualizer');
  await withPage({ routes: { '/__tone.wav': wav(20, 440) }, args: ['--enable-unsafe-swiftshader'] }, async (page) => {
    await page.goto('/music-visualizer', 1200);
    await page.eval(TRACK);
    // Downloads are caught at the anchor, the last thing CV.downloadBlob does.
    await page.eval(`window.__dl = []; (function () { var o = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () {
      if (this.download) { var a = this; window.__dl.push(fetch(a.href).then((r) => r.blob()).then((b) => ({ name: a.download, blob: b }))); return; } return o.apply(this, arguments); }; })()`);
    await page.eval(dropFiles([['/__tone.wav', 'tone.wav', 'audio/wav']]));
    let st = null;
    for (let i = 0; i < 100; i++) { await sleep(200); st = await page.eval('window.__vz.state()'); if (st.viz && st.presets) break; }
    ok(st.viz && st.presets === 100, 'the visualiser starts with ' + st.presets + ' presets (context ' + st.ctx + ')');
    await sleep(2500);
    const a = await page.eval(PIX);
    await sleep(700);
    const b = await page.eval(PIX);
    ok(a.w === 1280 && a.h === 720, 'the picture is the chosen size (' + a.w + 'x' + a.h + ')');
    ok(a.mean > 3 && a.colours > 20, 'it is not blank (mean ' + a.mean.toFixed(1) + ' of 255, ' + a.colours + ' colours)');
    ok(a.sig !== b.sig, 'it moves');
    const p0 = st.preset;
    await page.eval('document.getElementById("vzNext").click()');
    const p1 = await page.eval('document.getElementById("vzPreset").value');
    ok(p1 && p1 !== p0, '"Another preset" changes it');
    await page.eval('document.getElementById("vzPng").click()');
    await sleep(800);
    const png = await page.eval('(async () => { const d = await window.__dl[0]; const bm = await createImageBitmap(d.blob); return { name: d.name, type: d.blob.type, w: bm.width, h: bm.height, size: d.blob.size }; })()');
    ok(png.name === 'tone-visualizer.png' && png.w === 1280 && png.h === 720 && png.size > 5000, 'the PNG is the frame (' + png.name + ', ' + png.w + 'x' + png.h + ', ' + Math.round(png.size / 1024) + ' KB)');
    await page.eval('document.getElementById("vzRec").click()');
    await sleep(3500);
    const recState = await page.eval('window.__vz.state().rec');
    await page.eval('document.getElementById("vzRec").click()');
    await sleep(1500);
    const vid = await page.eval(`(async () => {
      const d = await window.__dl[1]; if (!d) return null;
      const v = document.createElement('video'); v.muted = true; v.src = URL.createObjectURL(d.blob);
      await new Promise((r, j) => { v.onloadedmetadata = r; v.onerror = () => j(new Error('video did not load')); });
      // A MediaRecorder file can report Infinity until it has been sought.
      if (!isFinite(v.duration)) { v.currentTime = 1e6; await new Promise((r) => { v.onseeked = r; setTimeout(r, 2000); }); }
      const ac = new OfflineAudioContext(1, 44100, 44100);
      const buf = await ac.decodeAudioData(await d.blob.arrayBuffer());
      const x = buf.getChannelData(0); let cross = 0, sq = 0; const from = Math.floor(x.length / 4), to = Math.floor(x.length * 3 / 4);
      for (let i = from + 1; i < to; i++) { if (x[i - 1] <= 0 && x[i] > 0) cross++; sq += x[i] * x[i]; }
      return { name: d.name, type: d.blob.type, size: d.blob.size, w: v.videoWidth, h: v.videoHeight, dur: v.duration, hz: cross / ((to - from) / buf.sampleRate), rms: Math.sqrt(sq / (to - from)) };
    })()`);
    ok(recState === 'recording', 'recording runs while the song plays');
    ok(vid && /^video\/(mp4|webm)$/.test(vid.type) && vid.size > 50000, 'it saves a video: ' + (vid && vid.name + ', ' + vid.type + ', ' + Math.round(vid.size / 1024) + ' KB'));
    ok(vid && vid.w === 1280 && vid.h === 720, 'at the canvas size (' + (vid && vid.w + 'x' + vid.h) + ')');
    ok(vid && vid.dur > 2.5 && vid.dur < 6, 'as long as it was recorded (' + (vid && vid.dur.toFixed(2)) + ' s for about 3.5)');
    ok(vid && Math.abs(vid.hz - 440) < 5 && vid.rms > 0.1, 'with the song in it (' + (vid && vid.hz.toFixed(1)) + ' Hz for 440, RMS ' + (vid && vid.rms.toFixed(3)) + ')');
    const ev = await page.eval('window.__ev');
    const wins = ev.filter((e) => /^convert_success/.test(e));
    ok(wins.length === 2, 'the PNG and the video each count as a success (' + wins.join(', ') + ')');
    const errs = quiet(page.logs);
    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ').slice(0, 300) : ''));
  });
}

async function soundcraft() {
  console.log('/soundcraft');
  const args = ['--enable-unsafe-swiftshader', '--window-size=1280,900'];
  await withPage({ headers: true, args }, async (page) => {
    const asked = [];
    await page.send('Network.enable');
    page.listen('Network.requestWillBeSent', (p) => asked.push(p.request.url));
    await page.goto('/soundcraft', 1500);
    await page.eval(TRACK);
    ok(!asked.some((u) => /vendor\/soundcraft/.test(u)), 'nothing of the app is fetched before Start');
    await page.eval('document.getElementById("scStart").click()');
    let ev = [];
    for (let i = 0; i < 300; i++) { await sleep(200); ev = await page.eval('window.__ev'); if (ev.some((e) => /^convert_success/.test(e))) break; }
    const fr = await page.eval('(function () { var f = document.querySelector("#scStage iframe"); var reach = "blocked"; try { reach = f.contentWindow.document ? "reachable" : "blocked"; } catch (e) {} return { sandbox: f.getAttribute("sandbox"), src: f.getAttribute("src"), reach: reach }; })()');
    ok(fr.sandbox === 'allow-scripts allow-downloads' && fr.reach === 'blocked', 'the frame is sandboxed to an opaque origin (sandbox="' + fr.sandbox + '", page -> frame ' + fr.reach + ')');
    ok(ev.filter((e) => e === 'convert_success:app').length === 1 && ev.filter((e) => e === 'convert_start:app').length === 1, 'the app reports that it started: convert_success once (' + ev.join(', ') + ')');
    const errs = quiet(page.logs);
    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ').slice(0, 300) : ''));
  });
  // The app itself, outside the sandbox, where the check can listen to it.
  await withPage({ headers: true, args }, async (page) => {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(function () {
      window.__ac = []; var O = window.AudioContext;
      function W(o) { var c = new O(o); c.__an = c.createAnalyser(); c.__an.fftSize = 2048; window.__ac.push(c); return c; }
      W.prototype = O.prototype; window.AudioContext = W;
      var conn = AudioNode.prototype.connect;
      AudioNode.prototype.connect = function (d) { if (d && d === this.context.destination && this.context.__an) conn.call(this, this.context.__an); return conn.apply(this, arguments); };
    })()` });
    await page.goto('/vendor/soundcraft/0.20.1/frame', 1500);
    let up = false;
    for (let i = 0; i < 300 && !up; i++) { await sleep(200); up = await page.eval('!!window.wasmBindings'); }
    ok(up, 'the app starts when opened directly');
    await sleep(3000);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 640, y: 450, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 640, y: 450, button: 'left', clickCount: 1 });
    await sleep(500);
    const peak = `(function () { var c = window.__ac[0]; if (!c) return { n: 0 }; var a = new Float32Array(2048), m = 0; c.__an.getFloatTimeDomainData(a); for (var i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i])); return { n: window.__ac.length, state: c.state, peak: m, rate: c.sampleRate }; })()`;
    const idle = await page.eval(peak);
    ok(idle.n >= 1 && idle.state === 'running', 'its audio context runs after a click (' + idle.state + ', ' + idle.rate + ' Hz)');
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', text: ' ', windowsVirtualKeyCode: 32 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
    let loud = 0;
    for (let i = 0; i < 40; i++) { await sleep(250); const p = await page.eval(peak); loud = Math.max(loud, p.peak || 0); }
    ok(loud > 0.01, 'Space plays the demo session: output peak ' + loud.toFixed(3) + ' (idle ' + (idle.peak || 0).toFixed(3) + ')');
  });
}

// Honeydew is driven by position: the add button in the middle of an empty
// song, the menu it opens, the kit list. The positions are 0.5.3's at
// 1280x800; an upgrade means looking again.
async function honeydew() {
  console.log('/honeydew');
  const args = ['--enable-unsafe-swiftshader', '--window-size=1280,800'];
  await withPage({ headers: true, args }, async (page) => {
    const asked = [];
    await page.send('Network.enable');
    page.listen('Network.requestWillBeSent', (p) => asked.push(p.request.url));
    await page.goto('/honeydew', 1500);
    await page.eval(TRACK);
    ok(!asked.some((u) => /vendor\/honeydew/.test(u)), 'nothing of the app is fetched before Start');
    await page.eval('document.getElementById("hdStart").click()');
    let ev = [];
    for (let i = 0; i < 300; i++) { await sleep(200); ev = await page.eval('window.__ev'); if (ev.some((e) => /^convert_success/.test(e))) break; }
    const fr = await page.eval('(function () { var f = document.querySelector("#hdStage iframe"); var reach = "blocked"; try { reach = f.contentWindow.document ? "reachable" : "blocked"; } catch (e) {} return { sandbox: f.getAttribute("sandbox"), reach: reach }; })()');
    ok(fr.sandbox === 'allow-scripts allow-downloads' && fr.reach === 'blocked', 'the frame is sandboxed to an opaque origin (page -> frame ' + fr.reach + ')');
    ok(ev.filter((e) => e === 'convert_success:app').length === 1 && ev.filter((e) => e === 'convert_start:app').length === 1, 'the app reports that it started: convert_success once (' + ev.join(', ') + ')');
    const errs = quiet(page.logs);
    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ').slice(0, 300) : ''));
  });
  const direct = async (fn) => withPage({ headers: true, args }, async (page) => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await page.send('Network.enable');
    const packs = [];
    page.listen('Network.responseReceived', (p) => { if (/content\/p\//.test(p.response.url)) packs.push(p.response.status); });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(function () {
      window.__ac = []; var O = window.AudioContext;
      function W(o) { var c = new O(o); c.__an = c.createAnalyser(); c.__an.fftSize = 2048; window.__ac.push(c); return c; }
      W.prototype = O.prototype; window.AudioContext = W;
      var conn = AudioNode.prototype.connect;
      AudioNode.prototype.connect = function (d) { if (d && d === this.context.destination && this.context.__an) conn.call(this, this.context.__an); return conn.apply(this, arguments); };
    })()` });
    await page.goto('/vendor/honeydew/0.5.3/frame', 1500);
    // The module being loaded is not the app being ready: clicks sent before
    // its first frame go nowhere. It opens its audio output as it starts, so
    // that is waited for, and then a few frames more.
    for (let i = 0; i < 300; i++) { await sleep(200); if (await page.eval('!!window.wasmBindings && window.__ac.length > 0')) break; }
    await sleep(4000);
    const mouse = (type, x, y) => page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    const click = async (x, y, wait) => { await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); await sleep(wait || 800); };
    // The loudest sample from just before a press until 0.7 s after it is
    // let go: a drum hit is over in 50 ms, so it is read every 10 ms.
    const hit = async (x, y, hold) => {
      const run = page.eval('(async function(){var c=window.__ac[0];if(!c)return -1;var x=new Float32Array(2048),m=0;for(var k=0;k<' + Math.round(((hold || 150) + 700) / 10) + ';k++){c.__an.getFloatTimeDomainData(x);for(var i=0;i<x.length;i++)m=Math.max(m,Math.abs(x[i]));await new Promise(r=>setTimeout(r,10));}return m;})()');
      await sleep(60); await mouse('mousePressed', x, y); await sleep(hold || 150); await mouse('mouseReleased', x, y);
      return run;
    };
    return fn({ page, click, hit, packs });
  });
  // A loaded machine can still be too slow for the fixed waits between
  // clicks, so a silent run is tried once more before it counts.
  const twice = async (fn) => { let r = await direct(fn); if (!(r.peak > 0.02)) r = await direct(fn); return r; };
  const drums = await twice(async ({ click, hit, packs }) => {
    await click(640, 378, 1200);     // add a channel
    await click(430, 259, 2500);     // Drums
    await click(118, 520, 800);      // Rock Kit
    for (let i = 0; i < 100 && !packs.length; i++) await sleep(200);
    await sleep(3000);
    await click(543, 32, 1500);      // close the kit list
    return { peak: Math.max(await hit(640, 745), await hit(800, 745)), packs: packs.slice() };
  });
  ok(drums.packs.length >= 1 && drums.packs.every((s) => s === 200), 'the Rock Kit\'s samples come from the hosted packs (' + drums.packs.join(', ') + ')');
  ok(drums.peak > 0.02, 'and a pad sounds (peak ' + drums.peak.toFixed(3) + ')');
  const synth = await twice(async ({ click, hit }) => {
    await click(640, 378, 1200);     // add a channel
    await click(582, 259, 2500);     // MiniSynth
    return { peak: Math.max(await hit(340, 760, 1200), await hit(340, 760, 1200)) };
  });
  ok(synth.peak > 0.02, 'a MiniSynth key sounds (peak ' + synth.peak.toFixed(3) + ')');
}

const only = process.argv[2];
(async () => {
  if (!only || only === 'webamp') await webamp();
  if (!only || only === 'visualizer') await visualizer();
  if (!only || only === 'soundcraft') await soundcraft();
  if (!only || only === 'honeydew') await honeydew();
})().then(() => {
  if (failed) { console.log('\ncheck-retro-apps: ' + failed + ' failed'); process.exit(1); }
  console.log('\ncheck-retro-apps: all good');
}).catch((e) => { console.error(e); process.exit(1); });
