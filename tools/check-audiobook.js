#!/usr/bin/env node
/*
 * Checks /text-to-audiobook.
 *
 * Node: chapter detection in text, an EPUB built here with zlib (deflated
 * and stored entries, a spine order that differs from the manifest, a
 * cover and a contents page to drop, a footnote marker, entities), DRM
 * refusal, and the ffmetadata writer.
 *
 * Browser (when the Kokoro q8 model and the ffmpeg core are cached, see
 * check-tts.js and check-fidelity.js): a three-chapter book through the real
 * page on the CPU path, to an M4B. The M4B's chapters are read back with
 * ffprobe, a reader that shares nothing with the writer, and must match the
 * titles and start where the page says each chapter's audio began (within
 * 50 ms; AAC frames are 43 ms at 24 kHz).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const B = require('../js/book-parse.js');

let failed = 0;
function ok(c, m) { console.log((c ? '  ok  ' : '  FAIL ') + m); if (!c) failed++; }

/* ---------------------------------------------------------------- text */

console.log('text');
{
  const b = B.fromText('# The Book\n\n## Chapter 1\nIt began.\n\n## Chapter 2: Later\nIt ended.');
  ok(b.title === 'The Book' && b.chapters.map((c) => c.title).join('|') === 'Chapter 1|Chapter 2: Later', 'Markdown: # is the title when chapters are ##');
}
{
  const b = B.fromText('A foreword line.\n\nCHAPTER I\nOne.\n\nChapter Two\nTwo.\n\nEPILOGUE\nAfter.');
  ok(b.chapters.map((c) => c.title).join('|') === 'Opening|CHAPTER I|Chapter Two|EPILOGUE', 'plain text: chapter/epilogue lines start chapters, text before is the opening');
}
{
  const b = B.fromText('Contents\nChapter 1\nChapter 2\n\nChapter 1\nReal one.\n\nChapter 2\nReal two.');
  ok(b.chapters.length === 2 && b.chapters[0].text === 'Real one.', 'headings with nothing under them (a contents list) are dropped');
}
{
  const para = Array.from({ length: 40 }, () => 'word '.repeat(500).trim()).join('\n\n');
  const b = B.fromText(para);
  ok(b.chapters.length >= 3 && b.chapters.every((c) => B.words(c.text) >= 2000), 'no headings: split into parts at paragraphs (' + b.chapters.length + ' parts)');
}

/* ---------------------------------------------------------------- epub */

function zip(entries) {
  const locals = [], centrals = [];
  let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name), raw = Buffer.from(e.data);
    const data = e.store ? raw : zlib.deflateRawSync(raw);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(e.store ? 0 : 8, 8);
    h.writeUInt32LE(zlib.crc32 ? zlib.crc32(raw) : 0, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(raw.length, 22);
    h.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(e.store ? 0 : 8, 10);
    c.writeUInt32LE(zlib.crc32 ? zlib.crc32(raw) : 0, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt32LE(off, 42);
    locals.push(h, name, data);
    centrals.push(c, name);
    off += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
const body = (h, ps) => `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${h}</title></head><body><h1>${h}</h1>${ps.map((p) => `<p>${p}</p>`).join('')}</body></html>`;
const long = (s) => Array.from({ length: 30 }, (_, i) => s + ' sentence ' + i + '.').join(' ');
const epubFiles = [
  { name: 'mimetype', data: 'application/epub+zip', store: true },
  { name: 'META-INF/container.xml', data: '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>' },
  { name: 'OEBPS/content.opf', data: `<?xml version="1.0"?><package><metadata><dc:title>The Test &amp; Book</dc:title><dc:creator>A. Writer</dc:creator></metadata>
    <manifest><item id="c2" href="text/two.xhtml" media-type="application/xhtml+xml"/><item id="cover" href="text/cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="toc" href="text/toc.xhtml" media-type="application/xhtml+xml"/><item id="c1" href="text/one%20a.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="epi" href="text/epigraph.xhtml" media-type="application/xhtml+xml"/><item id="css" href="s.css" media-type="text/css"/></manifest>
    <spine><itemref idref="cover"/><itemref idref="nav"/><itemref idref="toc"/><itemref idref="epi"/><itemref idref="c1"/><itemref idref="c2"/></spine></package>` },
  { name: 'OEBPS/text/cover.xhtml', data: body('Cover', ['The Test Book']) },
  { name: 'OEBPS/nav.xhtml', data: body('Navigation', [long('nav')]) },
  { name: 'OEBPS/text/toc.xhtml', data: body('Contents', [long('toc')]) },
  { name: 'OEBPS/text/epigraph.xhtml', data: body('Epigraph', ['All happy families are alike.']) },
  { name: 'OEBPS/text/one a.xhtml', data: body('Chapter One', [long('First') + '<sup>1</sup>', 'Caf&eacute; &amp; &#8220;quotes&#8221;']) },
  { name: 'OEBPS/text/two.xhtml', data: body('Chapter Two', [long('Second')]), store: true }
];

(async () => {
  console.log('epub');
  {
    const b = await B.fromEpub(zip(epubFiles));
    ok(b.title === 'The Test & Book' && b.author === 'A. Writer', 'title and author from the OPF');
    ok(b.chapters.map((c) => c.title).join('|') === 'Chapter One|Chapter Two', 'spine order, nav and contents dropped (' + b.chapters.map((c) => c.title).join('|') + ')');
    ok(!/The Test Book/.test(b.chapters[0].text), 'the cover page is dropped, not read');
    ok(/^Epigraph\s+All happy families/.test(b.chapters[0].text), 'a short page (an epigraph) folds into the next chapter');
    ok(!/sentence 29\.1/.test(b.chapters[0].text) && /“quotes”/.test(b.chapters[0].text), 'footnote markers dropped, entities decoded');
    ok(b.chapters[1].text.startsWith('Chapter Two'), 'stored (uncompressed) entries read too');
  }
  {
    let msg = '';
    try { await B.fromEpub(zip(epubFiles.concat([{ name: 'META-INF/encryption.xml', data: '<encryption/>' }]))); } catch (e) { msg = e.message; }
    ok(/DRM/.test(msg), 'a DRM-protected EPUB is refused with a reason');
  }
  {
    const m = B.ffmetadata({ title: 'A=B; #1', author: 'Me' }, [{ title: 'One', seconds: 2 }, { title: 'Two', seconds: 3.5 }]);
    ok(/^;FFMETADATA1\n/.test(m) && m.includes('title=A\\=B\\; \\#1') && m.includes('START=2000\nEND=5500\ntitle=Two'), 'ffmetadata escapes and chapter times');
  }

  /* ------------------------------------------------------------ browser */

  console.log('page');
  const cache = path.join(os.homedir(), '.cache', 'audiosaw');
  const need = [path.join(cache, 'kokoro', 'model_quantized.onnx'), path.join(cache, 'kokoro', 'af_heart.bin'), path.join(cache, 'ffmpeg-core-0.12.6.wasm')];
  let ffprobe = null;
  try { execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); ffprobe = 'ffprobe'; } catch (e) {}
  const { withPage, findChrome } = require('./chrome-harness');
  if (!findChrome() || !need.every((f) => fs.existsSync(f))) {
    console.log('  skip: needs Chrome, the Kokoro q8 model and the ffmpeg core in ' + cache + ' (check-tts.js with TTS_DOWNLOAD=1, and check-fidelity.js)');
  } else {
    await withPage({
      headers: true,
      routes: {
        '/__kokoro/model_quantized.onnx': () => fs.readFileSync(need[0]),
        '/__kokoro/af_heart.bin': () => fs.readFileSync(need[1]),
        '/__core.wasm': () => fs.readFileSync(need[2])
      }
    }, async (page) => {
      page.listen('Fetch.requestPaused', (p) => {
        const u = p.request.url;
        const to = /ffmpeg-core\.wasm/.test(u) ? '/__core.wasm' : '/__kokoro/' + u.split('?')[0].split('/').pop();
        page.send('Fetch.continueRequest', { requestId: p.requestId, url: page.url(to) });
      });
      await page.send('Fetch.enable', { patterns: [{ urlPattern: '*huggingface.co/onnx-community/Kokoro*' }, { urlPattern: '*unpkg.com*ffmpeg-core.wasm*' }] });
      await page.goto('/text-to-audiobook?backend=wasm', 1500);
      const r = await page.eval(`(async () => {
        try { indexedDB.deleteDatabase('audiosaw-tts'); } catch (e) {}
        window.__ab.load({ title: 'Check Book', author: 'Checker', chapters: [
          { title: 'The First', text: 'This is the first chapter. It is short.' },
          { title: 'The Second', text: 'Here is the second chapter, a little longer than the first one was.' },
          { title: 'The Third', text: 'And the end.' }
        ] });
        document.querySelector('#outFmt').value = 'm4b';
        const got = [];
        const orig = CV.downloadBlob;
        CV.downloadBlob = (b, name) => { got.push({ b, name }); };
        await window.__ab.run();
        CV.downloadBlob = orig;
        if (!got.length) return { err: document.querySelector('#status').textContent };
        const u = new Uint8Array(await got[0].b.arrayBuffer());
        let bin = ''; for (let i = 0; i < u.length; i += 8192) bin += String.fromCharCode.apply(null, u.subarray(i, i + 8192));
        return { name: got[0].name, b64: btoa(bin), chapters: window.__audiobook.chapters };
      })()`, 900000);
      ok(!r.err, 'the page makes an M4B' + (r.err ? ' — ' + r.err : ' (' + r.name + ')'));
      if (r.err) return;
      const file = path.join(os.tmpdir(), 'as-check-book.m4b');
      fs.writeFileSync(file, Buffer.from(r.b64, 'base64'));
      if (!ffprobe) { console.log('  skip: no ffprobe to read the chapters back'); return; }
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_chapters', '-show_format', '-of', 'json', file], { encoding: 'utf8' }));
      const ch = probe.chapters || [];
      ok(ch.length === 3 && ch.map((c) => c.tags && c.tags.title).join('|') === 'The First|The Second|The Third', 'ffprobe reads three chapters with their titles');
      let t = 0, worst = 0;
      r.chapters.forEach((c, i) => { if (ch[i]) worst = Math.max(worst, Math.abs(parseFloat(ch[i].start_time) - t)); t += c.seconds; });
      ok(worst < 0.05, 'chapter starts match the audio (worst ' + (worst * 1000).toFixed(1) + ' ms)');
      const dur = parseFloat(probe.format.duration);
      ok(Math.abs(dur - t) < 0.15, 'total length ' + dur.toFixed(2) + ' s for ' + t.toFixed(2) + ' s of chapters');
      ok(probe.format.tags && probe.format.tags.title === 'Check Book' && probe.format.tags.artist === 'Checker', 'title and author tags');
      if (page.logs.length) console.log('    console: ' + page.logs.slice(0, 4).join(' | '));
    });
  }

  if (failed) { console.log('\n' + failed + ' check(s) failed'); process.exit(1); }
  console.log('\ncheck-audiobook: all good');
})().catch((e) => { console.log('  FAIL ' + (e.stack || e)); process.exit(1); });
