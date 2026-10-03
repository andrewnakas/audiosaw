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
  console.log('docx');
  {
    const para = (t, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
    const split = `<w:p><w:r><w:t>Split </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>across</w:t></w:r><w:r><w:tab/><w:t>runs &amp; tabs.</w:t></w:r></w:p>`;
    const doc = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="x"><w:body>${para('The Keeper', 'Title')}${para('Chapter One', 'Heading1')}${para(long('Lamp'))}${split}${para('Chapter Two', 'Heading1')}${para(long('Storm'))}<w:sectPr/></w:body></w:document>`;
    const core = '<cp:coreProperties xmlns:dc="d"><dc:title>The Keeper Doc</dc:title><dc:creator>A. Writer</dc:creator></cp:coreProperties>';
    const b = await B.fromDocx(zip([{ name: '[Content_Types].xml', data: '<Types/>' }, { name: 'word/document.xml', data: doc }, { name: 'docProps/core.xml', data: core }]));
    ok(b.chapters.map((c) => c.title).join('|') === 'The Keeper|Chapter One|Chapter Two' || b.chapters.map((c) => c.title).join('|') === 'Chapter One|Chapter Two', 'Word headings become chapters (' + b.chapters.map((c) => c.title).join(' | ') + ')');
    ok(b.chapters.some((c) => /Split across runs & tabs\./.test(c.text)), 'runs are joined, tabs become spaces, entities decoded');
    ok(b.author === 'A. Writer' && /The Keeper/.test(b.title || ''), 'title and author from the document properties');
    let msg = '';
    try { await B.fromDocx(Buffer.from('not a zip at all')); } catch (e) { msg = e.message; }
    ok(/not a valid Word/.test(msg), 'a file that is not a .docx is refused with a reason');
  }

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


  /* ----------------------------------------------------------------- pdf */

  console.log('pdf (layout rebuilt from positioned text)');
  {
    // A page as pdf.js reports it: runs with x, y (from the bottom), width, height.
    const run = (str, x, y, h = 11) => ({ str, x, y, w: str.length * h * 0.5, h });
    const page = (n, lines, head = true) => ({ items: [].concat(
      head ? [run('The Keeper — a test book', 72, 770, 9)] : [],
      lines.map((l, i) => typeof l === 'string' ? run(l, 72, 720 - i * 14) : run(l.t, 72, 720 - i * 14, l.h)),
      [run(String(n), 300, 40, 9)]) });
    const P = [
      page(1, [{ t: 'Chapter One', h: 20 }, 'The lamp was lit every evening at six, an unremark-', 'able ritual that nobody in the village had ever ' + 'watched.', '', 'He climbed the stairs.']),
      page(2, ['The second page begins mid', 'sentence and carries on here.', { t: 'Chapter Two', h: 20 }, 'A storm came in from the west.']),
      page(3, ['Waves broke over the rail all night long, and he', 'kept the light burning until dawn.']),
      page(4, [{ t: 'Chapter Three', h: 20 }, 'Morning was calm.'])
    ];
    const r = B.fromPdf({ pages: P, outline: [], info: { title: 'Microsoft Word - keeper.docx' } });
    ok(r.chapters.map((c) => c.title).join('|') === 'Chapter One|Chapter Two|Chapter Three', 'no bookmarks: larger type and "Chapter N" make the chapters (' + r.chapters.map((c) => c.title).join(' | ') + ')');
    const all = r.chapters.map((c) => c.text).join('\n\n');
    ok(/an unremarkable ritual/.test(all), 'a word hyphenated at a line end is rejoined');
    ok(!/test book/.test(all) && !/(^|\n)\s*\d\s*($|\n)/.test(all), 'the running head and the page numbers are gone');
    ok(/mid sentence and carries on/.test(all), 'a line wrap inside a sentence is joined');
    ok(/watched\.\n\nHe climbed/.test(r.chapters[0].text) && /\bmid sentence\b/.test(r.chapters[0].text), 'a gap of more than a line starts a paragraph; a plain line wrap does not');
    ok(r.title === '', 'a Word file name in the PDF title is ignored');
    const o = B.fromPdf({ pages: P, outline: [{ title: 'The Keeper', page: 0, depth: 0 }, { title: 'Lamp', page: 0, depth: 1 }, { title: 'Storm', page: 1, depth: 1 }, { title: 'Morning', page: 3, depth: 1 }], info: { title: 'The Keeper', author: 'A. Writer' } });
    ok(o.chapters.map((c) => c.title).join('|') === 'Lamp|Storm|Morning' && o.title === 'The Keeper' && o.author === 'A. Writer', 'bookmarks: the first level with two or more entries gives the chapters');
    ok(/storm came in/i.test(o.chapters[1].text) && /kept the light burning/.test(o.chapters[1].text) && !/Morning was calm/.test(o.chapters[1].text), 'a bookmark chapter runs to the page before the next');
    // A two-column paper page: a full-width title, an author line split by
    // the gutter, columns of 30-character lines, a caption mid-column, and a
    // sideways-free layout as pdf.js would report it after the page's filter.
    {
      const L = (t, y) => run(t, 60, y, 10), R = (t, y) => run(t, 320, y, 10);
      const items = [run('A Study of Lighthouses', 150, 740, 16), run('Ann Lee', 150, 715, 11), run('Bo Chan', 330, 715, 11),
        run('1. Introduction', 60, 690, 12)];
      const left = ['Lighthouses guide ships into a', 'harbour at night, and keepers', 'tended them by hand for two', 'hundred years until the lamps', 'were automated.', 'Figure 1. A lamp room seen', 'from the gallery outside.', 'The work was lonely and the', 'pay was poor, yet many kept'];
      const right = ['their posts for decades.', 'Some wrote diaries that now', 'tell us how storms were', 'survived on the rock.', '2. Methods', 'We read forty diaries kept', 'between 1850 and 1920 and', 'counted the storms noted in', 'each of them, year by year.'];
      // A caption sits in its own space: 10 pt more above and below it.
      left.forEach((t, i) => items.push(L(t, 670 - i * 13 - (i >= 5 ? 10 : 0) - (i >= 7 ? 10 : 0))));
      right.forEach((t, i) => items.push(t === '2. Methods' ? run(t, 320, 670 - i * 13, 12) : R(t, 670 - i * 13)));
      const c = B.fromPdf({ pages: [{ items }], outline: [] });
      const titles = c.chapters.map((x) => x.title).join('|'), text = c.chapters.map((x) => x.text).join(' ');
      ok(titles === 'A Study of Lighthouses|1. Introduction|2. Methods', 'two columns: the title and numbered sections become chapters (' + titles + ')');
      ok(/many kept their posts for decades/.test(text), 'two columns: the left column runs into the right, not across the gutter');
      ok(!/Figure 1|gallery outside/.test(text) && /were automated\.\n\nThe work was lonely/.test(text), 'a figure caption is skipped and the paragraphs around it stay intact');
      ok(/^Ann Lee Bo Chan$/.test(c.chapters[0].text), 'the author line split by the gutter stays one line, above the columns');
    }
    let msg = '';
    try { B.fromPdf({ pages: [{ items: [] }, { items: [] }], outline: [] }); } catch (e) { msg = e.message; }
    ok(/scanned/.test(msg) && /OCR/.test(msg), 'a PDF with no text layer is refused with a reason (scanned pages, OCR)');
  }


  /* -------------------------------------------------------- pdf, browser */

  // A real PDF through the real page and pdf.js. Two files: one written here
  // (bookmarks one level down, a running head, page numbers, a word split
  // across pages), and, on macOS, one printed by cupsfilter from a text with
  // "Chapter N" headings and no bookmarks. Needs only Chrome.
  function makePdf(pages, outline, info) {
    const objs = [];
    const add = (s) => { objs.push(s); return objs.length; };
    const esc = (t) => t.replace(/[\\()]/g, (c) => '\\' + c);
    const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    const pagesId = objs.length + 1; objs.push(null);
    const pageIds = pages.map((lines) => {
      const ops = lines.map((l) => `BT /F1 ${l.size || 11} Tf ${l.x || 72} ${l.y} Td (${esc(l.t)}) Tj ET`).join('\n');
      const c = add(`<< /Length ${Buffer.byteLength(ops)} >>\nstream\n${ops}\nendstream`);
      return add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${c} 0 R >>`);
    });
    objs[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((i) => i + ' 0 R').join(' ')}] /Count ${pageIds.length} >>`;
    // Outlines: one top entry (the book) with the chapters as its children.
    const olId = objs.length + 1; objs.push(null);
    const topId = objs.length + 1; objs.push(null);
    const kids = outline.map(() => { objs.push(null); return objs.length; });
    outline.forEach((o, i) => {
      objs[kids[i] - 1] = `<< /Title (${esc(o.title)}) /Parent ${topId} 0 R /Dest [${pageIds[o.page]} 0 R /XYZ null null null]` +
        (i ? ` /Prev ${kids[i - 1]} 0 R` : '') + (i < kids.length - 1 ? ` /Next ${kids[i + 1]} 0 R` : '') + ' >>';
    });
    objs[topId - 1] = `<< /Title (${esc(info.title)}) /Parent ${olId} 0 R /Dest [${pageIds[0]} 0 R /XYZ null null null] /First ${kids[0]} 0 R /Last ${kids[kids.length - 1]} 0 R /Count ${kids.length} >>`;
    objs[olId - 1] = `<< /Type /Outlines /First ${topId} 0 R /Last ${topId} 0 R /Count 1 >>`;
    const cat = add(`<< /Type /Catalog /Pages ${pagesId} 0 R /Outlines ${olId} 0 R /PageMode /UseOutlines >>`);
    const inf = add(`<< /Title (${esc(info.title)}) /Author (${esc(info.author)}) >>`);
    let out = '%PDF-1.4\n';
    const offs = objs.map((o, i) => { const at = Buffer.byteLength(out); out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
    const xref = Buffer.byteLength(out);
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
    out += `trailer\n<< /Size ${objs.length + 1} /Root ${cat} 0 R /Info ${inf} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  }

  console.log('pdf through the page');
  if (!require('./chrome-harness').findChrome()) console.log('  skip: needs Chrome');
  else {
    const body = (n, lines) => [{ t: 'THE KEEPER', y: 760, size: 9 }].concat(lines.map((t, i) => (typeof t === 'string' ? { t, y: 700 - i * 15 } : Object.assign({ y: 700 - i * 15 }, t))), [{ t: String(n), x: 300, y: 40, size: 9 }]);
    const pdf = makePdf([
      body(1, [{ t: 'The Lamp', size: 18 }, 'The lamp was lit every evening at six, and the keeper', 'wrote the time in a book that nobody had read for years.', 'The ritual was so ordinary that it had become unremark-']),
      body(2, ['able to the whole village.', '', 'He climbed the stairs.']),
      body(3, [{ t: 'The Storm', size: 18 }, 'A storm came in from the west before midnight.']),
      body(4, [{ t: 'Morning', size: 18 }, 'Morning was calm, and the sea lay flat and grey.'])
    ], [{ title: 'The Lamp', page: 0 }, { title: 'The Storm', page: 2 }, { title: 'Morning', page: 3 }], { title: 'The Keeper', author: 'A. Writer' });
    let cups = null;
    try {
      const txt = ['Chapter One', ''].concat(Array(40).fill('The lamp was lit every evening at six and he wrote it down.'), ['', 'Chapter Two', ''], Array(40).fill('A storm came in from the west and he kept the light burning.')).join('\n');
      const tf = path.join(os.tmpdir(), 'as-check-book.txt');
      fs.writeFileSync(tf, txt);
      cups = execFileSync('cupsfilter', ['-m', 'application/pdf', tf], { stdio: ['ignore', 'pipe', 'ignore'] });
      if (!/^%PDF/.test(cups.slice(0, 5).toString())) cups = null;
    } catch (e) { cups = null; }
    const para = (t, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t>${t}</w:t></w:r></w:p>`;
    const docx = zip([{ name: 'word/document.xml', data: `<w:document xmlns:w="x"><w:body>${para('Opening Words', 'Heading1')}${para('The keeper climbed the stairs at dusk.')}</w:body></w:document>` }]);
    await require('./chrome-harness').withPage({ routes: { '/__book.pdf': () => pdf, '/__cups.pdf': () => cups || Buffer.alloc(0), '/__w.docx': () => docx } }, async (page) => {
      await page.goto('/text-to-audiobook', 1500);
      const read = (url, name) => page.eval(`(async () => {
        const f = new File([await (await fetch('${url}')).blob()], '${name}', { type: 'application/pdf' });
        const dt = new DataTransfer(); dt.items.add(f);
        const inp = document.querySelector('#fileInput'); const before = window.__ab.book();
        inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true }));
        for (let i = 0; i < 300 && window.__ab.book() === before && !/Could not/.test(document.querySelector('#status').textContent); i++) await new Promise((r) => setTimeout(r, 100));
        const b = window.__ab.book();
        return b && b !== before ? { title: b.title, author: b.author, chapters: b.chapters.map((c) => ({ title: c.title, text: c.text })) } : { err: document.querySelector('#status').textContent };
      })()`, 120000);
      const r = await read('/__book.pdf', 'keeper.pdf');
      ok(!r.err, 'pdf.js reads the PDF on the page' + (r.err ? ' — ' + r.err : ''));
      if (!r.err) {
        ok(r.chapters.map((c) => c.title).join('|') === 'The Lamp|The Storm|Morning', 'chapters from the bookmarks (' + r.chapters.map((c) => c.title).join(' | ') + ')');
        ok(r.title === 'The Keeper' && r.author === 'A. Writer', 'title and author from the PDF');
        const t = r.chapters[0].text;
        ok(/become unremarkable to the whole village\./.test(t), 'a word split across a page break is rejoined');
        ok(!/THE KEEPER/.test(r.chapters.map((c) => c.text).join(' ')) && !/(^|\s)[1-4](\s|$)/.test(r.chapters.map((c) => c.text).join(' ')), 'running head and page numbers dropped');
        ok(!/^The Lamp/.test(t), 'the chapter text does not repeat its title');
      }
      if (cups && cups.length) {
        const c = await read('/__cups.pdf', 'printed.pdf');
        const titles = c.err ? '' : c.chapters.map((x) => x.title).join('|');
        const words = c.err ? 0 : c.chapters.map((x) => x.text).join(' ').split(/\s+/).length;
        const good = !c.err && titles === 'Chapter One|Chapter Two' && words === 1040;
        ok(good, 'a PDF printed by macOS: ' + (c.err || titles + ', ' + words + ' words: every one of the 1,040 kept, nothing added'));
        if (!good && !c.err) console.log('       ' + JSON.stringify(c.chapters.map((x) => x.text.slice(0, 300))));
      } else console.log('  skip: no cupsfilter to print a second PDF');
      // The text to speech page's "Open a file" reads the same files into its box.
      await page.goto('/text-to-speech', 1500);
      const tts = (url, name, type) => page.eval(`(async () => {
        const f = new File([await (await fetch('${url}')).blob()], '${name}', { type: '${type}' });
        const dt = new DataTransfer(); dt.items.add(f);
        const box = document.querySelector('#status'); box.textContent = '';
        const inp = document.querySelector('#ttsFile'); inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true }));
        for (let i = 0; i < 300 && !/Loaded|Could not/.test(box.textContent); i++) await new Promise((r) => setTimeout(r, 100));
        return { text: document.querySelector('#ttsText').value, status: box.textContent };
      })()`, 120000);
      const w = await tts('/__w.docx', 'note.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      ok(/Opening Words\.\s+The keeper climbed the stairs at dusk\./.test(w.text) && /Loaded note\.docx/.test(w.status), 'text to speech opens a Word file into the box: ' + JSON.stringify(w.text));
      const pf = await tts('/__book.pdf', 'keeper.pdf', 'application/pdf');
      ok(/The Lamp\./.test(pf.text) && /become unremarkable/.test(pf.text) && /Morning\./.test(pf.text) && !/THE KEEPER/.test(pf.text), 'and a PDF, chapters as headings, running head gone (' + pf.text.length + ' chars)');
      if (page.logs.length) console.log('    console: ' + page.logs.slice(0, 4).join(' | '));
    });
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
