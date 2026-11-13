#!/usr/bin/env node
/*
 * Checks /dx7-synth in headless Chrome (the engine itself is check-dx7.js).
 *
 *   - Start builds the worklet from the wasm and the context runs.
 *   - With the PURE SINE voice, the H key (A in the middle octave of the
 *     keys) sounds at 880 Hz within 5 cents, measured on an analyser, and
 *     stops when the key comes up.
 *   - Twenty notes are convert_success 'play', once.
 *   - A 32-voice .syx bank (packed here from the built-in voices under new
 *     names) adds 32 voices and selects the first; a bank with a bad
 *     checksum is refused in words.
 *   - A MIDI file of four known notes renders to a WAV that is the right
 *     length, at the right pitches, mono, 48 kHz, peaking at -1 dBFS, and counts as a success.
 */
const { withPage } = require('./chrome-harness');
const D = require('../js/dx7-core.js');
require('../js/midi-write.js');
const MW = globalThis.ASMidi;

let failed = 0;
const ok = (c, m) => { console.log((c ? '  ok  ' : '  FAIL ') + m); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cents = (f, ref) => 1200 * Math.log2(f / ref);

function bank() {
  const voices = [];
  for (let i = 0; i < 32; i++) {
    const data = Uint8Array.from(D.PATCHES[i % D.PATCHES.length].data);
    const name = ('BANK ' + (i + 1) + '          ').slice(0, 10);
    for (let k = 0; k < 10; k++) data[145 + k] = name.charCodeAt(k);
    voices.push({ name, data });
  }
  return Buffer.from(D.packSyx(voices));
}

const key = async (page, type, code, k, vk) => page.send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, text: type === 'keyDown' ? k : undefined });

// The fundamental from the analyser's time data: mean spacing of upward zero crossings.
const HZ = `(function () {
  var a = window.__an, x = new Float32Array(a.fftSize); a.getFloatTimeDomainData(x);
  var first = -1, last = -1, n = 0, peak = 0;
  for (var i = 1; i < x.length; i++) {
    if (Math.abs(x[i]) > peak) peak = Math.abs(x[i]);
    if (x[i - 1] <= 0 && x[i] > 0) { var t = i - 1 + (0 - x[i - 1]) / (x[i] - x[i - 1]); if (first < 0) first = t; else n++; last = t; }
  }
  return { hz: n ? n * a.context.sampleRate / (last - first) : 0, peak: peak };
})()`;

async function main() {
  console.log('/dx7-synth');
  const good = bank(), bad = Buffer.from(good); bad[bad.length - 2] ^= 0x55;
  const notes = [69, 72, 76, 81].map((m, i) => ({ midi: m, start: i * 0.5, duration: 0.4, velocity: 100 }));
  const mid = Buffer.from(MW.build(notes, { bpm: 120 }));
  await withPage({ routes: { '/__bank.syx': good, '/__bad.syx': bad, '/__tune.mid': mid } }, async (page) => {
    await page.goto('/dx7-synth', 1200);
    await page.eval('(function () { window.__ev = []; var o = window.gtag; window.gtag = function (k, n, p) { if (k === "event") window.__ev.push(n + ":" + (p && p.target_format)); return o.apply(this, arguments); }; })()');
    await page.eval(`window.__dl = []; (function () { var o = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () {
      if (this.download) { var a = this; window.__dl.push(fetch(a.href).then((r) => r.arrayBuffer()).then((b) => ({ name: a.download, bytes: b }))); return; } return o.apply(this, arguments); }; })()`);
    await page.eval('document.getElementById("dxStart").click()');
    let st = null;
    for (let i = 0; i < 100; i++) { await sleep(100); st = await page.eval('window.__dx.state()'); if (st.node) break; }
    ok(st.node && st.ctx === 'running' && st.voices === 10, 'Start builds the synth (context ' + st.ctx + ', ' + st.voices + ' built-in voices)');
    await page.eval(`(function () { var c = window.__dx.ctx(), a = c.createAnalyser(); a.fftSize = 8192; window.__dx.node().connect(a); window.__an = a;
      var s = document.getElementById('dxVoice'); s.value = 0; s.dispatchEvent(new Event('change')); })()`);
    await key(page, 'keyDown', 'KeyH', 'h', 72);
    await sleep(500);
    const on = await page.eval(HZ);
    await key(page, 'keyUp', 'KeyH', 'h', 72);
    await sleep(900);
    const off = await page.eval(HZ);
    ok(Math.abs(cents(on.hz, 880)) < 5 && on.peak > 0.01, 'the H key plays A at ' + on.hz.toFixed(2) + ' Hz (' + cents(on.hz, 880).toFixed(2) + ' cents from 880), peak ' + on.peak.toFixed(3));
    ok(off.peak < on.peak / 100, 'and stops when the key comes up (peak ' + off.peak.toExponential(1) + ')');
    for (let i = 0; i < 20; i++) { await key(page, 'keyDown', 'KeyA', 'a', 65); await sleep(30); await key(page, 'keyUp', 'KeyA', 'a', 65); await sleep(20); }
    let ev = await page.eval('window.__ev');
    ok(ev.filter((e) => e === 'convert_success:play').length === 1 && ev.filter((e) => e === 'convert_start:play').length === 1, 'twenty notes are one convert_success (' + ev.filter((e) => /convert/.test(e)).join(', ') + ')');

    const drop = (url, name) => `(async () => {
      const b = await (await fetch('${url}')).arrayBuffer(); const dt = new DataTransfer(); dt.items.add(new File([b], '${name}'));
      const input = document.getElementById('fileInput'); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
      for (let i = 0; i < 50; i++) { await new Promise((r) => setTimeout(r, 100)); const s = document.getElementById('status'); if (!/hidden/.test(s.className)) return s.className + ' | ' + s.textContent; }
      return 'no status';
    })()`;
    const b1 = await page.eval(drop('/__bank.syx', 'mine.syx'));
    st = await page.eval('window.__dx.state()');
    ok(st.voices === 42 && /BANK 1\b/.test(st.voice) && /success/.test(b1), 'a 32-voice .syx bank joins the list and its first voice is selected (' + st.voices + ' voices, "' + st.voice.trim() + '")');
    const b2 = await page.eval(drop('/__bad.syx', 'broken.syx'));
    st = await page.eval('window.__dx.state()');
    ok(/error/.test(b2) && /checksum/i.test(b2) && st.voices === 42, 'a bank with a bad checksum is refused: "' + b2.split(' | ')[1] + '"');

    await page.eval('(function () { var s = document.getElementById("dxVoice"); s.value = 0; s.dispatchEvent(new Event("change")); })()');
    const m1 = await page.eval(drop('/__tune.mid', 'tune.mid'));
    ok(/success/.test(m1) && (await page.eval('!document.getElementById("dxSong").hidden')), 'a MIDI file is read and offered (' + m1.split(' | ')[1] + ')');
    await page.eval('document.getElementById("dxRender").click()');
    let n = 0;
    for (let i = 0; i < 100 && !n; i++) { await sleep(200); n = await page.eval('window.__dl.length'); }
    const r = await page.eval(`(async () => {
      const d = await window.__dl[0]; const v = new DataView(d.bytes);
      const ac = new OfflineAudioContext(1, 48000, 48000); const buf = await ac.decodeAudioData(d.bytes.slice(0));
      const x = buf.getChannelData(0), R = buf.sampleRate, hz = [];
      for (let k = 0; k < 4; k++) {
        const a = Math.round((k * 0.5 + 0.1) * R), b = Math.round((k * 0.5 + 0.38) * R); let first = -1, last = -1, c = 0;
        for (let i = a + 1; i < b; i++) if (x[i - 1] <= 0 && x[i] > 0) { const t = i - 1 - x[i - 1] / (x[i] - x[i - 1]); if (first < 0) first = t; else c++; last = t; }
        hz.push(c * R / (last - first));
      }
      let peak = 0; for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
      return { name: d.name, rate: v.getUint32(24, true), ch: v.getUint16(22, true), bits: v.getUint16(34, true), dur: buf.duration, hz, peak, status: document.getElementById('status').textContent };
    })()`);
    const want = [440, 523.251, 659.255, 880];
    const worst = Math.max(...r.hz.map((f, i) => Math.abs(cents(f, want[i]))));
    ok(r.name === 'tune-pure-sine.wav' && r.rate === 48000 && r.ch === 1 && r.bits === 24, 'the render is ' + r.name + ': ' + r.rate + ' Hz, ' + r.ch + ' channel, ' + r.bits + '-bit');
    ok(Math.abs(r.dur - 4.9) < 0.02, 'as long as the notes plus a 3 s tail (' + r.dur.toFixed(3) + ' s for 4.9)');
    ok(worst < 3, 'A4, C5, E5 and A5 are in tune (worst ' + worst.toFixed(2) + ' cents: ' + r.hz.map((f) => f.toFixed(1)).join(', ') + ' Hz)');
    ok(Math.abs(20 * Math.log10(r.peak) + 1) < 0.05, 'levelled to peak at -1 dBFS (' + (20 * Math.log10(r.peak)).toFixed(2) + ' dBFS): "' + r.status + '"');
    ev = await page.eval('window.__ev');
    ok(ev.filter((e) => e === 'convert_success:wav').length === 1, 'the download is a convert_success (' + ev.filter((e) => /success/.test(e)).join(', ') + ')');
    const errs = page.logs.filter((l) => !/scriptwrapper|ERR_CONNECTION_REFUSED|favicon|googletagmanager/.test(l));
    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ').slice(0, 300) : ''));
  });
}

main().then(() => {
  if (failed) { console.log('\ncheck-dx7-page: ' + failed + ' failed'); process.exit(1); }
  console.log('\ncheck-dx7-page: all good');
}).catch((e) => { console.error(e); process.exit(1); });
