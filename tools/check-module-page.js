#!/usr/bin/env node
/*
 * Checks /module-player in headless Chrome (the replayers themselves are
 * check-module.js).
 *
 * A four-channel ProTracker MOD is written here: one looped sine sample of
 * 32 bytes, one pattern, one note at period 254 on channel 1. On a PAL
 * Amiga that is 3546895 / 254 / 32 = 436.38 Hz, and one pattern at speed 6,
 * 125 BPM is 64 rows of 0.12 s = 7.68 s.
 *
 *   - Dropped, it renders in the worker: title, format, player, channels,
 *     the sample name as text, length 7.68 s.
 *   - The WAV download is stereo 16-bit at 48 kHz, 7.68 s, 436.4 Hz within
 *     2 cents, and is the page's convert_success; convert_start fires once.
 *   - At 44.1 kHz it is rendered again at that rate, same pitch.
 *   - At 100% stereo width the right channel is silent (channel 1 is hard
 *     left on an Amiga); at 0% both sides are equal.
 *   - A file of noise named .mod is refused in words, with no page error.
 */
const { withPage } = require('./chrome-harness');

let failed = 0;
const ok = (c, m) => { console.log((c ? '  ok  ' : '  FAIL ') + m); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cents = (f, ref) => 1200 * Math.log2(f / ref);

function mod() {
  const b = Buffer.alloc(1084 + 1024 + 32);
  b.write('AUDIOSAW CHECK', 0, 'latin1');
  b.write('hello from the check', 20, 'latin1');
  b.writeUInt16BE(16, 42);          // length in words
  b[45] = 64;                       // volume
  b.writeUInt16BE(0, 46);           // loop start
  b.writeUInt16BE(16, 48);          // loop length in words: the whole sample
  for (let i = 1; i < 31; i++) b.writeUInt16BE(1, 20 + i * 30 + 28);   // unused samples: loop length 1, as trackers write
  b[950] = 1; b[951] = 127;         // one position
  b.write('M.K.', 1080, 'latin1');
  // row 0, channel 1: sample 1, period 254
  b[1084] = 0x00 | (254 >> 8); b[1085] = 254 & 255; b[1086] = 0x10; b[1087] = 0;
  for (let i = 0; i < 32; i++) b.writeInt8(Math.round(127 * Math.sin(2 * Math.PI * i / 32)), 1084 + 1024 + i);
  return b;
}

const drop = (url, name) => `(async () => {
  const b = await (await fetch('${url}')).arrayBuffer(); const dt = new DataTransfer(); dt.items.add(new File([b], '${name}'));
  const input = document.getElementById('fileInput'); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  for (let i = 0; i < 150; i++) { await new Promise((r) => setTimeout(r, 100)); const s = document.getElementById('status'); if (/success|error/.test(s.className)) return s.className + ' | ' + s.textContent; }
  return 'no status';
})()`;
const waitStatus = `(async () => { for (let i = 0; i < 150; i++) { await new Promise((r) => setTimeout(r, 100)); const s = document.getElementById('status'); if (/success|error/.test(s.className)) return s.className + ' | ' + s.textContent; } return 'no status'; })()`;
// What the saved WAV holds: header fields, length, and each side's pitch and level.
const READ = (i) => `(async () => {
  const d = await window.__dl[${i}]; const v = new DataView(d.bytes);
  const rate = v.getUint32(24, true), ch = v.getUint16(22, true), bits = v.getUint16(34, true);
  const ac = new OfflineAudioContext(2, rate, rate); const buf = await ac.decodeAudioData(d.bytes.slice(0));
  // A 32-step sample through the Paula model has steps that cross zero on
  // their own; a 1 ms running mean leaves the 436 Hz fundamental to count.
  const smooth = (y) => { const w = Math.round(rate / 1000), o = new Float32Array(y.length); let acc = 0; for (let i = 0; i < y.length; i++) { acc += y[i]; if (i >= w) acc -= y[i - w]; o[i] = acc / w; } return o; };
  const side = (c) => { const raw = buf.getChannelData(c), x = smooth(raw); let first = -1, last = -1, n = 0, sq = 0; const a = rate, e = rate * 6;
    for (let i = a + 1; i < e; i++) { sq += raw[i] * raw[i]; if (x[i - 1] <= 0 && x[i] > 0) { const t = i - 1 - x[i - 1] / (x[i] - x[i - 1]); if (first < 0) first = t; else n++; last = t; } }
    return { hz: n ? n * rate / (last - first) : 0, rms: Math.sqrt(sq / (e - a)) }; };
  return { name: d.name, rate, ch, bits, dur: buf.duration, L: side(0), R: side(1) };
})()`;

async function main() {
  console.log('/module-player');
  const noise = Buffer.alloc(4096); for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761 >>> 13) & 255;
  await withPage({ routes: { '/__song.mod': mod(), '/__noise.mod': noise } }, async (page) => {
    await page.goto('/module-player', 1200);
    await page.eval('(function () { window.__ev = []; var o = window.gtag; window.gtag = function (k, n, p) { if (k === "event") window.__ev.push(n + ":" + (p && p.target_format)); return o.apply(this, arguments); }; })()');
    await page.eval(`window.__dl = []; (function () { var o = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () {
      if (this.download) { var a = this; window.__dl.push(fetch(a.href).then((r) => r.arrayBuffer()).then((b) => ({ name: a.download, bytes: b }))); return; } return o.apply(this, arguments); }; })()`);
    const st = await page.eval(drop('/__song.mod', 'song.mod'));
    const s = await page.eval('({ song: window.__md.song(), title: document.getElementById("mdTitle").textContent, facts: document.getElementById("mdFacts").textContent, names: document.getElementById("mdNames").textContent, audio: !!document.getElementById("mdAudio").src, sep: !document.getElementById("mdSepWrap").hidden })');
    ok(/success/.test(st) && s.song, 'a dropped MOD renders: "' + st.split(' | ')[1] + '"');
    ok(s.title === 'AUDIOSAW CHECK' && /MOD, played by pt2-clone/.test(s.facts) && /4 channels/.test(s.facts), 'title and facts: "' + s.title + '", "' + s.facts + '"');
    ok(/hello from the check/.test(s.names), 'the sample text is shown');
    ok(s.song && Math.abs(s.song.duration - 7.68) < 0.01 && s.audio && s.sep, 'one pass is ' + (s.song && s.song.duration.toFixed(3)) + ' s (7.68), and it is ready to play');

    const save = async (fmt) => {
      const before = await page.eval('window.__dl.length');
      await page.eval(`(function () { var f = document.getElementById('mdFormat'); f.value = '${fmt}'; document.getElementById('convertBtn').click(); })()`);
      for (let i = 0; i < 150; i++) { await sleep(100); if (await page.eval('window.__dl.length') > before) break; }
      return page.eval(READ(before));
    };
    const set = async (id, v) => { await page.eval(`(function () { var e = document.getElementById('${id}'); e.value = '${v}'; e.dispatchEvent(new Event('change')); })()`); await sleep(150); return page.eval(waitStatus); };

    const a = await save('wav16');
    ok(a.name === 'song.wav' && a.rate === 48000 && a.ch === 2 && a.bits === 16, 'the download is ' + a.name + ': ' + a.rate + ' Hz, ' + a.ch + ' channels, ' + a.bits + '-bit');
    ok(Math.abs(a.dur - 7.68) < 0.01, 'and 7.68 s long (' + a.dur.toFixed(3) + ')');
    ok(Math.abs(cents(a.L.hz, 436.38)) < 2, 'the note is ' + a.L.hz.toFixed(2) + ' Hz (' + cents(a.L.hz, 436.38).toFixed(2) + ' cents from a PAL Amiga\'s 436.38)');
    let ev = await page.eval('window.__ev');
    ok(ev.filter((e) => e === 'convert_success:wav').length === 1 && ev.filter((e) => /^convert_start/.test(e)).length === 1, 'convert_start and convert_success once each (' + ev.filter((e) => /convert/.test(e)).join(', ') + ')');

    await set('mdRate', '44100');
    const b = await save('wav16');
    ok(b.rate === 44100 && Math.abs(cents(b.L.hz, a.L.hz)) < 1 && Math.abs(b.dur - 7.68) < 0.01, 'at 44.1 kHz it is rendered again: ' + b.rate + ' Hz, ' + b.L.hz.toFixed(2) + ' Hz, ' + b.dur.toFixed(3) + ' s');
    await set('mdSep', '100');
    const hard = await save('wav16');
    ok(hard.L.rms > 0.05 && hard.R.rms < hard.L.rms / 300, '100% width: channel 1 is hard left (left RMS ' + hard.L.rms.toFixed(3) + ', right ' + hard.R.rms.toExponential(1) + ')');
    await set('mdSep', '0');
    const mono = await save('wav16');
    ok(Math.abs(mono.L.rms - mono.R.rms) < mono.L.rms / 100 && mono.L.rms > 0.02, '0% width: both sides equal (' + mono.L.rms.toFixed(3) + ', ' + mono.R.rms.toFixed(3) + ')');

    const bad = await page.eval(drop('/__noise.mod', 'noise.mod'));
    ok(/error/.test(bad) && /not a MOD, XM, S3M or IT/.test(bad) && (await page.eval('document.getElementById("mdView").hidden')), 'noise named .mod is refused: "' + bad.split(' | ')[1] + '"');
    ev = await page.eval('window.__ev');
    ok(ev.some((e) => /^convert_error/.test(e)), 'and counted as an error (' + ev.filter((e) => /error/.test(e)).join(', ') + ')');
    const errs = page.logs.filter((l) => !/scriptwrapper|ERR_CONNECTION_REFUSED|favicon|googletagmanager/.test(l));
    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ').slice(0, 300) : ''));
  });
}

main().then(() => {
  if (failed) { console.log('\ncheck-module-page: ' + failed + ' failed'); process.exit(1); }
  console.log('\ncheck-module-page: all good');
}).catch((e) => { console.error(e); process.exit(1); });
