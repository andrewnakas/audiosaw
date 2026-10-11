#!/usr/bin/env node
/*
 * Measures the community WAM2 plugins the way the editor and /audio-plugins
 * use them, and writes what it found to js/wam-status.js, which the plugin
 * browsers read.
 *
 * Per plugin, in headless Chrome, against the local mirror (wam-mirror.js;
 * WAM_DOWNLOAD=1 records it from the network once):
 *   - it loads in an OfflineAudioContext (an export) and renders finite audio;
 *   - two offline renders of the same state agree (an export is repeatable);
 *   - a parameter moved and saved through getState -> JSON -> createInstance
 *     renders the same as the instance it was saved from (the project file
 *     and undo restore what you set);
 *   - live (an AudioContext, recorded by a worklet tap) against offline, after
 *     alignment: 'same' when within 2e-3 of the peak. A plugin with an LFO
 *     cannot match (its phase starts when the node is made), so that is
 *     reported, not failed;
 *   - instruments get a note (A4) through scheduleEvents at a suspend point,
 *     the way the editor's export feeds MIDI, and must sound.
 *
 * A plugin that fails to load or render offline is written as hidden, and the
 * browsers leave it out. WAM_ONLY=com.wimmics.bigmuff,... limits the run.
 * WAM_WRITE=1 writes js/wam-status.js from the sweep (bump ?v= after).
 * --pages (or WAM_SKIP_SWEEP=1) skips the sweep and runs only the editor and
 * /audio-plugins end to end; check-all.js runs it that way, since the sweep
 * takes minutes and its live comparison is sensitive to a loaded machine.
 */
const fs = require('fs');
const path = require('path');
const { findChrome, withPage, ROOT } = require('./chrome-harness');
const mirror = require('./wam-mirror');

if (!findChrome()) { console.log('check-wam: skipped (no Chrome).'); process.exit(0); }
if (!mirror.have() && !process.env.WAM_DOWNLOAD) {
  console.log('check-wam: skipped (no plugin mirror; WAM_DOWNLOAD=1 records one).');
  process.exit(0);
}

const PAGE = `<!doctype html><meta charset=utf-8><title>wam</title>
<script src="/js/wam-host.js"></script>
<script>window.__probe = ${probe.toString()};</script>`;

// Runs in the page. Returns the measurements for one plugin.
async function probe(p) {
  const SR = 48000, SECS = 2.75, N = Math.round(SR * SECS);
  const res = { id: p.id, kind: p.kind };
  function signal(ctx) {
    const b = ctx.createBuffer(2, N, SR);
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 * 2 - 1; };
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < N; i++) {
        // 0.25 s of silence first: a plugin's parameter smoothing settles
        // from its start-up values, and that settling is not the effect.
        const t = i / SR - 0.25;
        let v = 0;
        if (t >= 0 && t < 0.8) v += 0.3 * Math.sin(2 * Math.PI * (c ? 330 : 220) * t);
        if (t >= 1.0 && t < 1.3) v += 0.15 * rnd();
        if (i === Math.round(1.85 * SR)) v += 0.8;
        d[i] = v;
      }
    }
    return b;
  }
  const withTimeout = (pr, ms, what) => Promise.race([pr, new Promise((_, j) => setTimeout(() => j(new Error(what + ' timed out')), ms))]);
  function stats(buf) {
    let peak = 0, bad = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (!isFinite(a)) bad++; else if (a > peak) peak = a; }
    }
    return { peak, bad };
  }
  function diff(a, b, lag) {
    // max |a[i] - b[i + lag]| over both channels, relative to a's peak.
    let m = 0, pk = 1e-9;
    const n = Math.min(a.length, b.length) - Math.abs(lag) - 1;
    for (let c = 0; c < Math.min(a.numberOfChannels, b.numberOfChannels); c++) {
      const x = a.getChannelData(c), y = b.getChannelData(c);
      for (let i = Math.max(0, -lag); i < n; i++) {
        const d = Math.abs(x[i] - y[i + lag]); if (d > m) m = d;
        if (Math.abs(x[i]) > pk) pk = Math.abs(x[i]);
      }
    }
    return m / pk;
  }
  function impulse(ctx) {
    const b = ctx.createBuffer(2, N, SR);
    b.getChannelData(0)[Math.round(0.5 * SR)] = 0.5;
    b.getChannelData(1)[Math.round(0.5 * SR)] = 0.5;
    return b;
  }
  async function offline(state, setParams, sig) {
    const ctx = new OfflineAudioContext(2, N, SR);
    const inst = await withTimeout(ASWam.load(ctx, p.url, state, p), 60000, 'load');
    if (setParams) await withTimeout(inst.node.setParameterValues(setParams), 5000, 'setParameterValues');
    const src = ctx.createBufferSource();
    src.buffer = (sig || signal)(ctx);
    if (p.kind !== 'instrument') src.connect(inst.node);
    inst.node.connect(ctx.destination);
    src.start(0);
    if (p.kind === 'instrument') {
      // The editor's export schedules MIDI the same way (wam-host.js).
      const steps = ASWam.offlineSteps(inst, [{ t: 0.35, bytes: [0x90, 69, 100] }, { t: 1.45, bytes: [0x80, 69, 0] }], SR);
      Object.keys(steps).forEach((k) => ctx.suspend(+k).then(() => steps[k]()).then(() => ctx.resume()));
    }
    const out = await withTimeout(ctx.startRendering(), 60000, 'offline render');
    const saved = await withTimeout(inst.getState(), 5000, 'getState').catch(() => null);
    const latency = inst.latency;
    inst.dispose();
    return { out, saved, latency, name: inst.name };
  }
  async function live(state) {
    const ctx = new AudioContext({ sampleRate: SR });
    await ctx.resume();
    const inst = await withTimeout(ASWam.load(ctx, p.url, state, p), 60000, 'live load');
    const code = `registerProcessor('tap', class extends AudioWorkletProcessor {
      constructor() { super(); this.n = 0; this.max = ${N}; this.l = new Float32Array(this.max); this.r = new Float32Array(this.max); this.from = Infinity;
        this.port.onmessage = (e) => { this.from = e.data; }; }
      process(i) { const x = i[0]; if (!x || !x.length || this.n >= this.max) return true;
        for (let j = 0; j < x[0].length; j++) { const f = currentFrame + j; if (f < this.from || this.n >= this.max) continue;
          this.l[this.n] = x[0][j]; this.r[this.n] = (x[1] || x[0])[j]; this.n++; }
        if (this.n >= this.max) this.port.postMessage([this.l, this.r]); return true; } });`;
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
    const tap = new AudioWorkletNode(ctx, 'tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit' });
    const mute = ctx.createGain();
    mute.gain.value = 0;
    inst.node.connect(tap);
    tap.connect(mute).connect(ctx.destination);
    const got = new Promise((r) => { tap.port.onmessage = (e) => r(e.data); });
    const src = ctx.createBufferSource();
    src.buffer = signal(ctx);
    if (p.kind !== 'instrument') src.connect(inst.node);
    // The tap records from the exact frame the source starts on, so live
    // and offline line up sample for sample with no search.
    const f0 = Math.ceil((ctx.currentTime + 0.3) * SR / 128) * 128;
    const t0 = f0 / SR;
    tap.port.postMessage(f0);
    src.start(t0);
    if (p.kind === 'instrument') { inst.midi([0x90, 69, 100], t0 + 0.35); inst.midi([0x80, 69, 0], t0 + 1.45); }
    const data = await withTimeout(got, 15000, 'live recording');
    inst.dispose();
    ctx.close();
    const b = new AudioBuffer({ numberOfChannels: 2, length: N, sampleRate: SR });
    b.copyToChannel(data[0], 0); b.copyToChannel(data[1], 1);
    return b;
  }
  function f0(buf, from, to) {
    // Zero-crossing rate of channel 0 over [from, to) s, as Hz.
    const d = buf.getChannelData(0), a = Math.round(from * SR), z = Math.round(to * SR);
    let n = 0, first = -1, last = -1;
    for (let i = a + 1; i < z; i++) if (d[i - 1] <= 0 && d[i] > 0) { const t = i - d[i] / (d[i] - d[i - 1]); if (first < 0) first = t; last = t; n++; }
    return n > 2 ? (n - 1) / ((last - first) / SR) : 0;
  }
  try {
    const t = performance.now();
    const a = await offline(null);
    res.loadMs = Math.round(performance.now() - t);
    res.name = a.name;
    res.latency = a.latency;
    const s = stats(a.out);
    res.peak = +s.peak.toFixed(4);
    res.bad = s.bad;
    if (s.bad) throw new Error('non-finite samples');
    res.silent = s.peak < 1e-4;
    if (p.kind === 'instrument') res.f0 = Math.round(f0(a.out, 0.55, 1.15) * 10) / 10;
    const b = await offline(null);
    res.repeat = +diff(a.out, b.out, 0).toExponential(2);
    // The real delay: where an impulse first comes out. (getCompensationDelay
    // answered 128 for nearly every plugin, delay or not.)
    if (p.kind !== 'instrument') {
      const im = (await offline(null, null, impulse)).out.getChannelData(0);
      let pk = 0; for (let i = 0; i < im.length; i++) pk = Math.max(pk, Math.abs(im[i]));
      const at = Math.round(0.5 * SR);
      let first = -1;
      for (let i = 0; i < im.length; i++) if (Math.abs(im[i]) > pk * 0.01) { first = i; break; }
      res.delay = pk > 1e-6 && first >= 0 ? first - at : null;
    }
    // Move one continuous parameter a quarter of its range off its default,
    // render, save the state, and render that state in a fresh instance.
    let info = {};
    try {
      const ctx = new OfflineAudioContext(2, 128, SR);
      const inst = await withTimeout(ASWam.load(ctx, p.url, null, p), 60000, 'load');
      info = await withTimeout(inst.node.getParameterInfo(), 5000, 'getParameterInfo');
      inst.dispose();
    } catch (e) { info = {}; }
    const ids = Object.keys(info || {}).filter((k) => {
      const q = info[k];
      return q && q.type !== 'boolean' && q.type !== 'choice' && isFinite(q.minValue) && isFinite(q.maxValue) && q.maxValue > q.minValue && !/bypass|enable|mute|on$/i.test(k + ' ' + (q.label || ''));
    });
    res.params = Object.keys(info || {}).length;
    if (ids.length) {
      const q = info[ids[0]];
      const v = q.defaultValue + (q.defaultValue > (q.minValue + q.maxValue) / 2 ? -1 : 1) * (q.maxValue - q.minValue) / 4;
      res.moved = ids[0];
      const c = await offline(null, { [ids[0]]: { id: ids[0], value: v, normalized: false } });
      res.paramChanges = +diff(a.out, c.out, 0).toExponential(2);
      if (c.saved == null) res.state = 'none';
      else {
        const json = JSON.parse(JSON.stringify(c.saved));
        const d = await offline(json);
        res.restore = +diff(c.out, d.out, 0).toExponential(2);
        res.restoreVsDefault = +diff(a.out, d.out, 0).toExponential(2);
        res.savedSample = JSON.stringify(json).slice(0, 300);
        res.state = res.restore <= 1e-3 ? 'restores' : 'differs';
      }
    } else {
      res.state = a.saved == null ? 'none' : 'no-params';
    }
    try {
      const l = await live(a.saved);
      res.live = +diff(a.out, l, 0).toExponential(2);
    } catch (e) { res.liveError = String(e.message || e).slice(0, 120); }
    res.ok = true;
  } catch (e) {
    res.ok = false;
    res.error = String(e && (e.message || e)).slice(0, 200);
  }
  return res;
}

// The editor and /audio-plugins, end to end, on the real pages: Big Muff with
// a moved setting (it measured exact live and offline, with no delay).
const MUFF = 'com.wimmics.bigmuff';
async function pageChecks(page) {
  const fails = [], notes = [];
  // Shared in-page helpers: a 2 s 48 kHz stereo test signal and a direct
  // offline render through one plugin with a pre-roll, as the reference.
  const HELP = `
    const SR = 48000, N = SR * 2;
    const sig = () => { const b = new AudioBuffer({ numberOfChannels: 2, length: N, sampleRate: SR }); let s = 3;
      for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < N; i++) { s = (s * 16807) % 2147483647;
        d[i] = 0.3 * Math.sin(2 * Math.PI * (c ? 330 : 220) * i / SR) + (i > SR && i < 1.3 * SR ? 0.1 * (s / 2147483647 * 2 - 1) : 0); } } return b; };
    const through = async (w, state, input) => { const pre = Math.round(0.25 * SR), off = new OfflineAudioContext(2, pre + input.length, SR);
      const inst = await ASWam.load(off, w.url, state, w); const src = off.createBufferSource(); src.buffer = input;
      src.connect(inst.node); inst.node.connect(off.destination); src.start(pre / SR); const r = await off.startRendering(); inst.dispose();
      return [r.getChannelData(0).slice(pre), r.getChannelData(1).slice(pre)]; };
    const worst = (a, b) => { let m = 0, pk = 1e-9; for (let c = 0; c < 2; c++) { const x = a[c], y = b[c]; const n = Math.min(x.length, y.length);
      for (let i = 0; i < n; i++) { m = Math.max(m, Math.abs(x[i] - y[i])); pk = Math.max(pk, Math.abs(y[i])); } } return m / pk; };
    const moved = async (w) => { const off = new OfflineAudioContext(2, 128, SR); const inst = await ASWam.load(off, w.url, null, w);
      await inst.node.setParameterValues({ '/BigMuff/Input': { id: '/BigMuff/Input', value: -9, normalized: false } });
      const st = await inst.getState(); inst.dispose(); return st; };
  `;

  await page.goto('/audio-editor', 1500);
  const ed = await page.eval(`(async () => { ${HELP}
    const M = ASEditModel, E = ASEditEngine, D = ASEditDsp, out = {};
    const w = (await ASWam.catalog()).filter((x) => x.id === ${JSON.stringify(MUFF)})[0];
    if (!w) return { error: 'Big Muff is not in the catalogue' };
    const st = await moved(w);
    const p = M.create('wam check');
    const sid = M.addSource(p, { name: 'sig.wav', duration: 2, channels: 2, sampleRate: SR });
    E.buffers.set(sid, sig());
    const tid = M.addTrack(p); M.addClip(p, tid, { sourceId: sid, start: 0 });
    const dry = await E.render(p, 0, 2, { sampleRate: SR, protect: false });
    const fid = M.addFx(p, tid, 'wam', D.fresh('wam').params, null, null, { id: w.id, url: w.url, name: w.name, vendor: w.vendor });
    M.setFxState(p, tid, fid, st);
    const wet = await E.render(M.parse(M.serialize(p)), 0, 2, { sampleRate: SR, protect: false });
    const ref = await through(w, st, dry.buffer);
    out.len = wet.buffer.length;
    out.exportVsRef = worst([wet.buffer.getChannelData(0), wet.buffer.getChannelData(1)], ref);
    out.changed = worst([dry.buffer.getChannelData(0), dry.buffer.getChannelData(1)], ref);
    // The live instance follows the slot: set, then undone.
    const slot = p.tracks[0].fx[0];
    const inst = await E.wamInstance(slot);
    const a = JSON.stringify(await inst.getState());
    const before = M.serialize(p);
    const st2 = JSON.parse(JSON.stringify(st)); st2['/BigMuff/Input'] = 3;
    M.setFxState(p, tid, fid, st2); E.syncWam(p); await inst.flush();
    const b = await inst.getState();
    const p0 = M.parse(before); E.syncWam(p0); await inst.flush();
    const c = JSON.stringify(await inst.getState());
    out.liveStart = a === JSON.stringify(st);
    out.liveSet = b['/BigMuff/Input'] === 3;
    out.liveUndo = c === JSON.stringify(st);
    // A plugin that cannot load stops the export by name.
    const bad = M.parse(M.serialize(p0));
    bad.tracks[0].fx[0].wam.url = 'https://www.webaudiomodules.com/community/plugins/nope/index.js';
    bad.tracks[0].fx[0].id = 'fbroken';
    try { await E.render(bad, 0, 2, { sampleRate: SR }); out.badExport = 'exported'; } catch (e) { out.badExport = e.message; }
    // A web instrument, if one measured usable: a MIDI clip through it.
    const wi = (await ASWam.catalog()).filter((x) => x.kind === 'instrument' && x.status && x.status.ok)[0];
    if (wi) {
      const q = M.create('inst');
      const ms = M.addSource(q, { kind: 'midi', name: 'riff', notes: [{ midi: 69, start: 0.2, duration: 0.6, velocity: 100 }, { midi: 72, start: 1.0, duration: 0.6, velocity: 100 }] });
      const t2 = M.addTrack(q); M.addClip(q, t2, { sourceId: ms, start: 0 });
      M.setTrack(q, t2, { instWam: { id: wi.id, url: wi.url, name: wi.name, vendor: wi.vendor } });
      const r1 = await E.render(q, 0, 2, { sampleRate: SR, protect: false });
      const r2 = await E.render(q, 0, 2, { sampleRate: SR, protect: false });
      const d = r1.buffer.getChannelData(0); let pk = 0, first = -1;
      for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > pk) pk = v; if (first < 0 && v > 1e-3) first = i / SR; }
      out.inst = { name: wi.name, peak: pk, first, repeat: worst([r1.buffer.getChannelData(0), r1.buffer.getChannelData(1)], [r2.buffer.getChannelData(0), r2.buffer.getChannelData(1)]) };
    }
    return out;
  })()`, 300000);
  if (ed.error) fails.push('editor: ' + ed.error);
  else {
    if (ed.len !== 96000) fails.push('editor export is ' + ed.len + ' samples, not 96000');
    if (!(ed.exportVsRef <= 1e-6)) fails.push('editor export differs from Big Muff rendered directly by ' + ed.exportVsRef);
    if (!(ed.changed > 0.05)) fails.push('the plugin setting did not reach the export (' + ed.changed + ')');
    if (!ed.liveStart || !ed.liveSet || !ed.liveUndo) fails.push('live instance state: start ' + ed.liveStart + ', set ' + ed.liveSet + ', undo ' + ed.liveUndo);
    if (!/could not be loaded/.test(ed.badExport || '')) fails.push('an unloadable plugin did not stop the export: ' + ed.badExport);
    notes.push('editor: export = direct render within ' + ed.exportVsRef.toExponential(1) + ', setting heard (' + ed.changed.toFixed(2) + ' of peak), live state follows undo, a missing plugin stops the export');
    if (ed.inst) {
      if (!(ed.inst.peak > 1e-3) || !(ed.inst.repeat <= 1e-3) || !(Math.abs(ed.inst.first - 0.2) < 0.02)) fails.push('web instrument ' + JSON.stringify(ed.inst));
      notes.push('editor: ' + ed.inst.name + ' plays a MIDI clip in the export, first sound at ' + ed.inst.first.toFixed(3) + ' s for a note at 0.200, repeatable (' + ed.inst.repeat.toExponential(1) + ')');
    } else notes.push('editor: no web instrument measured usable, so none was tested');
  }

  await page.goto('/audio-plugins?plugin=' + MUFF, 1500);
  const tp = await page.eval(`(async () => { ${HELP}
    const wait = async (fn, ms) => { const end = Date.now() + (ms || 60000); while (!fn()) { if (Date.now() > end) throw new Error('timed out: ' + fn); await new Promise((r) => setTimeout(r, 100)); } };
    await wait(() => ASPluginsPage.chain().length && ASPluginsPage.chain()[0].inst);
    const c = ASPluginsPage.chain()[0];
    await c.inst.node.setParameterValues({ '/BigMuff/Input': { id: '/BigMuff/Input', value: -9, normalized: false } });
    const st = await c.inst.getState();
    const input = sig();
    let got = null;
    const orig = CV.downloadBlob;
    CV.downloadBlob = function (b, n) { got = { b, n }; return orig.apply(this, arguments); };
    const file = new File([AudioSaw.floatWav(input)], 'sig.wav');
    const dt = new DataTransfer(); dt.items.add(file);
    const inp = document.getElementById('fileInput'); inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true }));
    const btn = document.getElementById('convertBtn');
    await wait(() => !btn.disabled);
    document.getElementById('outFmt').value = 'wav32f';
    btn.click();
    await wait(() => got || document.querySelector('#status.error'), 120000);
    if (!got) return { error: document.getElementById('status').textContent };
    const d = await AudioSaw.decodeToAudioBuffer(new File([got.b], got.n), null, { quiet: true });
    const ref = await through(c.p, st, input);
    return { name: got.n, len: d.length, rate: d.sampleRate, ch: d.numberOfChannels,
      vsRef: worst([d.getChannelData(0), d.getChannelData(1)], ref) };
  })()`, 300000);
  if (tp.error) fails.push('/audio-plugins: ' + tp.error);
  else {
    if (tp.len !== 96000 || tp.rate !== 48000 || tp.ch !== 2) fails.push('/audio-plugins wrote ' + tp.len + ' samples, ' + tp.rate + ' Hz, ' + tp.ch + ' ch');
    if (!(tp.vsRef <= 1e-6)) fails.push('/audio-plugins output differs from Big Muff rendered directly by ' + tp.vsRef);
    notes.push('/audio-plugins: ' + tp.name + ', exact length and rate, = direct render within ' + tp.vsRef.toExponential(1));
  }
  return { fails, notes };
}

(async () => {
  let code = 1;
  const only = (process.env.WAM_ONLY || '').split(',').filter(Boolean);
  try {
    await withPage({ routes: { '/__wam': PAGE } }, async (page) => {
      const m = await mirror.attach(page);
      await page.goto('/__wam');
      const skipSweep = !!process.env.WAM_SKIP_SWEEP || process.argv.includes('--pages');
      const list = skipSweep ? [] : await page.eval('fetch(ASWam.INDEX).then(r => r.json()).then(() => ASWam.catalog()).then(l => l.map(p => ({ id: p.id, url: p.url, name: p.name, vendor: p.vendor, kind: p.kind, sub: p.sub })))', 60000);
      const todo = list.filter((p) => !only.length || only.includes(p.id));
      const rows = [];
      for (const p of todo) {
        // A plugin that hangs the page (some do) must not take the run with
        // it: each gets a fresh page.
        await page.goto('/__wam', 200);
        let r;
        try { r = await page.eval('window.__probe(' + JSON.stringify(p) + ')', 240000); }
        catch (e) { r = { id: p.id, ok: false, error: String(e.message).slice(0, 200) }; }
        r.name = r.name || p.name;
        r.sub = p.sub;
        rows.push(r);
        if (process.env.WAM_VERBOSE) console.log('    ' + JSON.stringify(r));
        const live = r.live == null ? (r.liveError ? 'live: ' + r.liveError : '') : 'live ' + (r.live <= 2e-3 ? 'same' : 'differs (' + r.live + ')');
        console.log('  ' + (r.ok ? (r.silent ? 'SILENT' : 'ok    ') : 'FAIL  ') + ' ' + p.name.padEnd(24) +
          (r.ok ? ` load ${r.loadMs} ms, peak ${r.peak}, repeat ${r.repeat}, state ${r.state}${r.restore != null ? ' (' + r.restore + ')' : ''}, ${live}${r.latency ? ', reports ' + r.latency : ''}${r.delay != null ? ', delay ' + r.delay : ''}${r.f0 != null ? ', A4 at ' + r.f0 + ' Hz' : ''}`
            : r.error));
      }
      if (m.misses.length) console.log('  mirror misses: ' + m.misses.length + (m.recording ? '' : ' (WAM_DOWNLOAD=1 records them)') + '\n    ' + m.misses.slice(0, 8).join('\n    '));
      if (m.recording) console.log('  recorded ' + m.saved + ' files into ' + mirror.DIR);
      const usable = rows.filter((r) => r.ok && !r.silent && r.repeat <= 1e-3);
      if (process.env.WAM_WRITE === '1' && !only.length && !skipSweep) writeStatus(rows);
      let pc = { fails: [], notes: [] };
      if (!only.length) {
        try { pc = await pageChecks(page); } catch (e) { pc.fails.push('page checks: ' + (e.message || e)); }
        pc.notes.forEach((n) => console.log('  ' + n));
        pc.fails.forEach((f) => console.error('  FAIL ' + f));
      }
      if (skipSweep) console.log('check-wam: the editor and /audio-plugins render web plugins exactly (sweep skipped; js/wam-status.js kept).');
      else console.log(`check-wam: ${usable.length} of ${rows.length} plugins load and render repeatably offline` +
        `; ${rows.filter((r) => r.state === 'restores').length} restore a saved setting exactly` +
        `; ${rows.filter((r) => r.live != null && r.live <= 2e-3).length} sound the same live as exported.`);
      code = (usable.length || skipSweep) && !pc.fails.length ? 0 : 1;
      if (page.logs.length && process.env.WAM_VERBOSE) page.logs.slice(0, 20).forEach((l) => console.error('  ' + l));
    });
  } catch (e) {
    console.error('check-wam: ' + (e.stack || e.message));
  }
  process.exit(code);
})();

function writeStatus(rows) {
  const plugins = {};
  rows.forEach((r) => {
    const s = { ok: !!r.ok && !r.silent && r.repeat <= 1e-3 };
    if (!s.ok) { s.hide = true; s.why = r.error || (r.silent ? 'silent' : 'not repeatable offline'); }
    else {
      s.state = r.state;
      if (r.live != null) s.live = r.live <= 2e-3 ? 'same' : 'differs';
      // The first output of an impulse is the latency only where the dry
      // sound comes through: in a reverb or delay it can be the pre-delay
      // (KBVerb's 915 samples), which must not be trimmed off.
      if (r.delay > 0 && !/reverb|delay/i.test(r.sub || '')) s.delay = r.delay;
    }
    plugins[r.id] = s;
  });
  const out = `/*
 * Written by tools/check-wam.js: what each community WAM2 plugin measured in
 * headless Chrome. ASWam.catalog() hides the ones marked hide, and the plugin
 * browsers show the rest with these notes. Do not edit by hand; re-run the
 * check (WAM_DOWNLOAD=1 refreshes the mirror first).
 *
 *   ok      loads and renders repeatably in an OfflineAudioContext (export)
 *   state   'restores': a saved setting renders exactly as it was set;
 *           'differs': it reloads, but not sample-exactly;
 *           'none': the plugin keeps no state; 'no-params': nothing to move
 *   delay   samples an impulse comes out late (the plugin's own report of
 *           its latency is not used: it said 128 for plugins with none)
 *   live    'same': live playback matches the export within 2e-3 of peak;
 *           'differs': it does not (usually a free-running LFO)
 */
window.ASWamStatus = ${JSON.stringify({ checked: new Date().toISOString().slice(0, 10), plugins }, null, 1)};
`;
  fs.writeFileSync(path.join(ROOT, 'js', 'wam-status.js'), out);
}
