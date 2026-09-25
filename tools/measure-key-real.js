#!/usr/bin/env node
/*
 * Measures ASKey.analyse on real recordings: all 48 preludes and fugues of
 * Book 1 of Bach's Well-Tempered Clavier, Kimiko Ishizaka's public-domain
 * (CC0) piano recording on Wikimedia Commons. Two pieces in every major and
 * minor key, and the key is in each title, so the truth is not ours.
 *
 * This is the figure /key-finder quotes for real music. It is not part of
 * check-all.js: it downloads about 250 MB the first time (cached in the OS
 * temp directory after that) and needs ffmpeg to decode Ogg Vorbis.
 *
 *   node tools/measure-key-real.js
 *
 * Measured 24 Sep 2026: 41/48 right, the runner-up right in 6 of the 7
 * misses; "clear" readings 35/36. Misses: 4 a fifth away, 2 parallel mode,
 * 1 other; none relative.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const K = require('../js/key-detect.js');

const CACHE = path.join(os.tmpdir(), 'audiosaw-wtc1');
const UA = { 'User-Agent': 'AudioSawKeyCheck/1.0 (https://audiosaw.com)' };
const API = 'https://commons.wikimedia.org/w/api.php?format=json&';
const PC = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

async function json(q) { return (await fetch(API + q, { headers: UA })).json(); }

async function files() {
  fs.mkdirSync(CACHE, { recursive: true });
  const list = path.join(CACHE, 'list.json');
  if (fs.existsSync(list)) return JSON.parse(fs.readFileSync(list, 'utf8'));
  const s = await json('action=query&list=search&srnamespace=6&srlimit=100&srsearch=' + encodeURIComponent('Kimiko Ishizaka Well-Tempered Clavier Book 1'));
  const byNo = {};
  s.query.search.map((r) => r.title).filter((t) => /Book 1 - \d\d /.test(t) && t.endsWith('.ogg')).sort()
    .forEach((t) => { const n = /Book 1 - (\d\d) /.exec(t)[1]; if (!byNo[n]) byNo[n] = t; });
  const titles = Object.keys(byNo).sort().map((n) => byNo[n]);
  const out = [];
  for (let i = 0; i < titles.length; i += 40) {
    const d = await json('action=query&prop=imageinfo&iiprop=url&titles=' + encodeURIComponent(titles.slice(i, i + 40).join('|')));
    Object.values(d.query.pages).forEach((p) => out.push({ title: p.title, url: p.imageinfo[0].url }));
  }
  out.sort((a, b) => a.title.localeCompare(b.title));
  fs.writeFileSync(list, JSON.stringify(out));
  return out;
}

(async () => {
  const list = await files();
  if (list.length !== 48) { console.error('measure-key-real: expected 48 recordings, found ' + list.length); process.exit(1); }
  const tally = { right: 0, relative: 0, fifth: 0, parallel: 0, other: 0 }, byConf = {};
  let runner = 0;
  for (const f of list) {
    const m = /in ([A-G])(-sharp|-flat)? (major|minor)/i.exec(f.title);
    const pc = (PC[m[1].toLowerCase()] + (m[2] === '-sharp' ? 1 : m[2] === '-flat' ? -1 : 0) + 12) % 12, mode = m[3].toLowerCase();
    const file = path.join(CACHE, /Book 1 - (\d\d) /.exec(f.title)[1] + '.ogg');
    if (!fs.existsSync(file)) fs.writeFileSync(file, Buffer.from(await (await fetch(f.url, { headers: UA })).arrayBuffer()));
    const raw = cp.execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', '22050', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
    const r = K.analyse([new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4)], 22050);
    const kind = r.pc === pc && r.mode === mode ? 'right'
      : (mode === 'major' && r.mode === 'minor' && r.pc === (pc + 9) % 12) || (mode === 'minor' && r.mode === 'major' && r.pc === (pc + 3) % 12) ? 'relative'
      : r.mode === mode && (r.pc === (pc + 7) % 12 || r.pc === (pc + 5) % 12) ? 'fifth'
      : r.pc === pc ? 'parallel' : 'other';
    tally[kind]++;
    if (kind !== 'right' && r.runnerUp.pc === pc && r.runnerUp.mode === mode) runner++;
    const c = byConf[r.confidence] = byConf[r.confidence] || [0, 0];
    c[1]++; if (kind === 'right') c[0]++;
    if (kind !== 'right') console.log('  ' + K.keyName(pc, mode) + ' read as ' + r.name + ' (' + kind + ', ' + r.confidence + ')');
  }
  console.log('measure-key-real: ' + tally.right + '/48 right; the runner-up right in ' + runner + ' of the ' + (48 - tally.right) + ' misses. Misses: ' +
    tally.fifth + ' a fifth away, ' + tally.parallel + ' parallel mode, ' + tally.relative + ' relative, ' + tally.other + ' other. By confidence: ' +
    Object.keys(byConf).map((k) => k + ' ' + byConf[k].join('/')).join(', ') + '.');
})().catch((e) => { console.error('measure-key-real: ' + (e.stack || e.message)); process.exit(1); });
