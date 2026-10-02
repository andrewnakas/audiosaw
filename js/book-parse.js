/*
 * ASBook — turns a pasted text, a .txt/.md file or an EPUB into chapters for
 * /text-to-audiobook. UMD: tools/check-audiobook.js runs it in Node, which has
 * DecompressionStream as the browser does.
 *
 *   ASBook.fromText(text)          → { title, chapters: [{ title, text }] }
 *   ASBook.fromEpub(arrayBuffer)   → Promise<{ title, author, chapters }>
 *   ASBook.fromPdf({ pages, outline, info }) → { title, author, chapters }
 *
 * An EPUB is a zip: META-INF/container.xml names the OPF package, whose
 * <spine> lists the XHTML documents in reading order. Each spine document
 * becomes a chapter, titled by its first heading; very short ones (a cover,
 * a copyright page) are folded into the next chapter rather than read as a
 * chapter of their own, and front-matter titled like a contents page is
 * dropped.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ASBook = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MIN_WORDS = 60;        // shorter spine items fold into the next
  var SPLIT_WORDS = 6000;    // a text with no headings is split into parts this long

  function words(s) { return (String(s).match(/\S+/g) || []).length; }

  /* ---------------------------------------------------------------- text */

  // Headings: Markdown #, "Chapter 12", "CHAPTER XII: Title", "Part Two",
  // "Prologue"/"Epilogue", each on a line of its own.
  var HEADING = /^\s*(?:#{1,3}\s+(.+?)\s*#*|((?:chapter|part|book)\s+(?:[0-9]+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|[a-z]+-?[a-z]*)\b[^\n]{0,80})|(prologue|epilogue|introduction|preface|afterword|foreword)\b[^\n]{0,60})\s*$/i;

  function fromText(text) {
    var lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    var chapters = [], cur = null, title = '';
    // A leading "# Title" is the book's title only when the chapters below it
    // are "##"; otherwise it is the first chapter.
    var hasH2 = /^\s*##\s/m.test(text);
    lines.forEach(function (ln) {
      var m = HEADING.exec(ln);
      if (m && ln.length < 120) {
        var t = (m[1] || m[2] || m[3]).trim();
        if (hasH2 && !title && /^#\s/.test(ln.trim()) && !chapters.length) { title = t; return; }
        cur = { title: t, text: '' };
        chapters.push(cur);
        return;
      }
      if (!cur) { cur = { title: '', text: '' }; chapters.push(cur); }
      cur.text += ln + '\n';
    });
    chapters.forEach(function (c) { c.text = c.text.replace(/\n{3,}/g, '\n\n').trim(); });
    chapters = chapters.filter(function (c) { return words(c.text) > 0; });
    // The leftover heading of a contents list above the first real heading.
    if (chapters.length > 1 && !chapters[0].title && /^(table of )?contents\.?$/i.test(chapters[0].text.trim())) chapters.shift();
    // A heading with nothing under it was a contents line; text before the
    // first heading is an untitled opening.
    if (chapters.length === 1 && words(chapters[0].text) > SPLIT_WORDS * 1.5) chapters = splitLong(chapters[0]);
    chapters.forEach(function (c, i) { if (!c.title) c.title = i === 0 && chapters.length > 1 ? 'Opening' : 'Part ' + (i + 1); });
    return { title: title, chapters: chapters };
  }

  // No headings at all: parts of about SPLIT_WORDS, broken at paragraphs.
  function splitLong(ch) {
    var paras = ch.text.split(/\n\s*\n/), out = [], buf = [], n = 0;
    paras.forEach(function (p) {
      buf.push(p); n += words(p);
      if (n >= SPLIT_WORDS) { out.push({ title: '', text: buf.join('\n\n') }); buf = []; n = 0; }
    });
    if (buf.length) {
      if (out.length && n < SPLIT_WORDS / 3) out[out.length - 1].text += '\n\n' + buf.join('\n\n');
      else out.push({ title: '', text: buf.join('\n\n') });
    }
    return out;
  }

  /* ----------------------------------------------------------------- zip */

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  // Central directory → { name: { method, offset, csize } }. Reading the
  // central directory rather than walking local headers copes with zips
  // whose local headers carry no sizes (data descriptors).
  function zipIndex(b) {
    var eocd = -1;
    for (var i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
      if (u32(b, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('This is not a valid EPUB (no zip directory).');
    var n = u16(b, eocd + 10), off = u32(b, eocd + 16), out = {};
    var dec = new TextDecoder();
    for (var k = 0; k < n; k++) {
      if (u32(b, off) !== 0x02014b50) break;
      var method = u16(b, off + 10), csize = u32(b, off + 20);
      var nl = u16(b, off + 28), el = u16(b, off + 30), cl = u16(b, off + 32), lho = u32(b, off + 42);
      out[dec.decode(b.subarray(off + 46, off + 46 + nl))] = { method: method, csize: csize, offset: lho };
      off += 46 + nl + el + cl;
    }
    return out;
  }

  async function zipRead(b, idx, name) {
    var e = idx[name];
    if (!e) {
      // Paths in an OPF are URL-encoded and sometimes differ in case.
      var want = decodeURIComponent(name).toLowerCase();
      for (var k in idx) if (k.toLowerCase() === want) { e = idx[k]; break; }
    }
    if (!e) throw new Error('The EPUB is missing ' + name);
    var lo = e.offset, start = lo + 30 + u16(b, lo + 26) + u16(b, lo + 28);
    var data = b.subarray(start, start + e.csize);
    if (e.method === 0) return new TextDecoder().decode(data);
    if (e.method !== 8) throw new Error('Unsupported compression in the EPUB');
    var ds = new DecompressionStream('deflate-raw');
    var stream = new Blob([data]).stream().pipeThrough(ds);
    return new TextDecoder().decode(await new Response(stream).arrayBuffer());
  }

  /* ---------------------------------------------------------------- epub */

  function attr(tag, name) {
    var m = new RegExp('\\s' + name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')', 'i').exec(tag);
    return m ? (m[2] != null ? m[2] : m[3]) : null;
  }
  function decodeEntities(s) {
    return s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
      .replace(/&hellip;/g, '…').replace(/&rsquo;/g, '’').replace(/&lsquo;/g, '‘').replace(/&rdquo;/g, '”').replace(/&ldquo;/g, '“')
      .replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCodePoint(parseInt(h, 16)); })
      .replace(/&#(\d+);/g, function (_, d) { return String.fromCodePoint(+d); });
  }
  // XHTML → plain paragraphs. Block elements end a paragraph; footnote
  // markers (<sup>, <a epub:type="noteref">) are not read out.
  function htmlText(html) {
    var body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
    var s = body ? body[1] : html;
    s = s.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<sup[\s\S]*?<\/sup>/gi, '')
      .replace(/<a[^>]*noteref[^>]*>[\s\S]*?<\/a>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|blockquote|section|tr)>/gi, '\n\n')
      .replace(/<[^>]+>/g, '');
    return decodeEntities(s).replace(/[ \t\u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  function firstHeading(html) {
    var m = /<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/i.exec(html) || /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    if (!m) return '';
    return decodeEntities((m[2] != null ? m[2] : m[1]).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  }
  function resolve(base, href) {
    var dir = base.indexOf('/') >= 0 ? base.slice(0, base.lastIndexOf('/') + 1) : '';
    var parts = (dir + href.split('#')[0]).split('/'), out = [];
    parts.forEach(function (p) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); });
    return out.join('/');
  }

  var SKIP = /^(contents|table of contents|copyright|cover|title page|dedication|also by|about the publisher|index)$/i;

  async function fromEpub(buffer) {
    var b = new Uint8Array(buffer);
    var idx = zipIndex(b);
    if (idx['META-INF/encryption.xml'] || idx['META-INF/rights.xml']) {
      throw new Error('This EPUB is DRM-protected, so its text cannot be read outside the store\'s own app. DRM-free EPUBs (Project Gutenberg, Standard Ebooks, most indie publishers) work.');
    }
    var container = await zipRead(b, idx, 'META-INF/container.xml');
    var opfPath = attr(/<rootfile\b[^>]*>/i.exec(container)[0], 'full-path');
    var opf = await zipRead(b, idx, opfPath);
    var meta = function (tag) {
      var m = new RegExp('<dc:' + tag + '[^>]*>([\\s\\S]*?)</dc:' + tag + '>', 'i').exec(opf);
      return m ? decodeEntities(m[1].replace(/<[^>]+>/g, '')).trim() : '';
    };
    var manifest = {};
    (opf.match(/<item\b[^>]*>/gi) || []).forEach(function (t) {
      manifest[attr(t, 'id')] = { href: attr(t, 'href'), type: attr(t, 'media-type') || '', props: attr(t, 'properties') || '' };
    });
    var spine = (opf.match(/<itemref\b[^>]*>/gi) || []).map(function (t) {
      return { id: attr(t, 'idref'), linear: attr(t, 'linear') !== 'no' };
    }).filter(function (r) { return r.linear && manifest[r.id] && /html/.test(manifest[r.id].type) && !/\bnav\b/.test(manifest[r.id].props); });

    var chapters = [], carry = '';
    for (var i = 0; i < spine.length; i++) {
      var html = await zipRead(b, idx, resolve(opfPath, manifest[spine[i].id].href));
      var t = firstHeading(html), text = htmlText(html);
      if (SKIP.test(t.trim())) continue;
      if (words(text) < MIN_WORDS) { carry += (carry ? '\n\n' : '') + text; continue; }
      if (carry) { text = carry + '\n\n' + text; carry = ''; }
      chapters.push({ title: t || 'Chapter ' + (chapters.length + 1), text: text });
    }
    if (carry && chapters.length) chapters[chapters.length - 1].text += '\n\n' + carry;
    if (!chapters.length) throw new Error('No readable text found in this EPUB. If it has DRM, it cannot be read outside its store\'s app.');
    return { title: meta('title'), author: meta('creator'), chapters: chapters };
  }


  /* ----------------------------------------------------------------- pdf */

  // A PDF has no paragraphs, only positioned runs of text, so they are
  // rebuilt here from what pdf.js reports (audiobook-page.js does the
  // reading; this part is pure, so check-audiobook runs it in Node):
  //   pages:   [{ items: [{ str, x, y, w, h }] }]   (PDF space: y grows up)
  //   outline: [{ title, page, depth }]             (the PDF's bookmarks)
  // Lines are items at the same height; a gap of more than 1.4 lines, or a
  // short line ending a sentence, ends a paragraph; "exam-" + "ple" is
  // rejoined; and a line that recurs at the top or bottom of most pages (a
  // running head, "Page 3 of 90") is dropped. Chapters come from the
  // bookmarks when there are at least two at one level; otherwise from
  // headings in the text (fromText), helped by marking clearly larger type
  // as a heading.
  function pdfLines(items) {
    var its = items.filter(function (i) { return i.str && i.str.trim(); })
      .sort(function (a, b) { return Math.abs(b.y - a.y) > Math.min(a.h, b.h) * 0.5 ? b.y - a.y : a.x - b.x; });
    var lines = [];
    its.forEach(function (i) {
      var l = lines[lines.length - 1];
      // Same height, and not across a column gutter (a gap of over two
      // characters' height between runs is one).
      var gapX = l ? i.x - l.end : 0, hh = l ? Math.max(l.h, i.h) : 0;
      if (l && Math.abs(l.y - i.y) <= hh * 0.5 && gapX > -hh && gapX < hh * 2) {
        var gap = i.x - l.end;
        if (gap > Math.max(l.h, i.h) * 0.15 && !/\s$/.test(l.text) && !/^\s/.test(i.str)) l.text += ' ';
        l.text += i.str; l.end = Math.max(l.end, i.x + (i.w || 0)); l.h = Math.max(l.h, i.h);
      } else lines.push({ text: i.str, x: i.x, y: i.y, h: i.h, end: i.x + (i.w || 0) });
    });
    lines.forEach(function (l) { l.text = l.text.replace(/\s+/g, ' ').trim(); });
    return columns(lines.filter(function (l) { return l.text; }));
  }

  // Two-column pages (papers, magazines): when most lines sit wholly in the
  // left or the right half, read full-width lines above the columns (a title,
  // an abstract), then the left column, then the right, then the rest.
  function columns(lines) {
    if (lines.length < 10) return lines;
    var x0 = Math.min.apply(null, lines.map(function (l) { return l.x; }));
    var x1 = Math.max.apply(null, lines.map(function (l) { return l.end; }));
    var mid = (x0 + x1) / 2, slack = (x1 - x0) * 0.04;
    var side = function (l) { return l.end <= mid + slack ? 'L' : l.x >= mid - slack ? 'R' : 'S'; };
    var n = { L: 0, R: 0, S: 0 };
    lines.forEach(function (l) { n[side(l)]++; });
    if (n.L < 5 || n.R < 5 || n.L + n.R < lines.length * 0.6) return lines;
    // The columns start at their first full-length line; anything above
    // that (a title, a short author block split by the gutter) is a header.
    var colW = (x1 - x0) / 2, body = lines.filter(function (l) { return side(l) !== 'S' && l.end - l.x > colW * 0.6; });
    var top = body.length ? Math.max.apply(null, body.map(function (l) { return l.y; })) + 1 : Infinity;
    var byY = function (a, b) { return b.y - a.y; };
    var head = lines.filter(function (l) { return l.y > top; }).sort(function (a, b) { return Math.abs(b.y - a.y) > 1 ? b.y - a.y : a.x - b.x; });
    var rest = lines.filter(function (l) { return side(l) === 'S' && l.y <= top; }).sort(byY);
    var col = function (s) { return lines.filter(function (l) { return side(l) === s && l.y <= top; }).sort(byY); };
    return head.concat(col('L'), col('R'), rest);
  }

  var CAPTION = /^(?:figure|fig\.|table)\s*\d+[a-z]?\s*[.:|]/i;
  var SECTION = /^(?:[A-Z]\.?\s+)?(?:abstract|introduction|background|related work|methods?|materials and methods|results|discussion|conclusions?|acknowledge?ments|references|bibliography|appendix(?:\s+[A-Z0-9]+)?|summary)$/i;

  function median(a) { a = a.slice().sort(function (x, y) { return x - y; }); return a.length ? a[a.length >> 1] : 0; }

  function fromPdf(pdf) {
    var pages = (pdf.pages || []).map(function (p) { return pdfLines(p.items || []); });
    // Running heads and folios: the first two and last two lines of a page,
    // with digits blanked, seen on at least 30% of pages.
    var PAGE_NO = /^(?:page\s+)?(?:\d{1,4}|[ivxlc]{1,7})(?:\s+of\s+\d{1,4})?$/i;
    var key = function (t) { return t.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' '); };
    var seen = {};
    pages.forEach(function (ls) {
      var edge = {};
      ls.slice(0, 2).concat(ls.slice(-2)).forEach(function (l) { edge[key(l.text)] = 1; });
      Object.keys(edge).forEach(function (k) { seen[k] = (seen[k] || 0) + 1; });
    });
    var many = pages.length >= 4 ? Math.max(2, pages.length * 0.3) : Infinity;
    pages = pages.map(function (ls) {
      return ls.filter(function (l, i) {
        var edge = i < 2 || i >= ls.length - 2;
        return !(edge && (PAGE_NO.test(l.text) || seen[key(l.text)] >= many));
      });
    });
    var all = [].concat.apply([], pages);
    if (all.length) {
      // Figure labels, axis numbers and footnotes: clearly smaller type, or
      // a line that is mostly not words.
      var h0 = median(all.map(function (l) { return l.h; }));
      var wordy = function (t) { var w = t.split(/\s+/); return w.filter(function (x) { return /[A-Za-z\u00C0-\u024F\u0900-\u097F]{2,}/.test(x); }).length / w.length; };
      pages = pages.map(function (ls) { return ls.filter(function (l) { return l.h >= h0 * 0.85 && (wordy(l.text) >= 0.5 || l.text.length > 60); }); });
      all = [].concat.apply([], pages);
    }
    if (!all.length) throw new Error('This PDF has no text to read: it is probably scanned pages (pictures of text). Run it through OCR first, for example in Adobe Acrobat, Google Drive or macOS Preview, then try again.');
    var bodyH = median(all.map(function (l) { return l.h; }));
    var bodyW = median(all.map(function (l) { return l.end - l.x; }));
    // Headings: clearly larger type, or slightly larger type on a short line
    // that reads like a section title ("3. Experiments").
    var isHead = function (l) {
      return l.text.length < 80 && (l.h >= bodyH * 1.45 ||
        (l.h >= bodyH * 1.12 && (/^\d+(?:\.\d+)*\.?\s+[A-Z][^.!?]*$/.test(l.text) || SECTION.test(l.text))));
    };
    var marked = all.filter(isHead).length;
    var useSize = marked >= 2 && marked <= Math.max(3, pages.length * 2);

    // Text of pages [a, b), with paragraphs and headings.
    function textOf(a, b, markHeads) {
      var out = '', prev = null;
      for (var p = a; p < b; p++) {
        var ls = pages[p], gaps = [];
        for (var i = 1; i < ls.length; i++) gaps.push(ls[i - 1].y - ls[i].y);
        var step = median(gaps.filter(function (g) { return g > 0; })) || bodyH * 1.2;
        var caption = false;
        ls.forEach(function (l, i) {
          // A figure or table caption is skipped up to the next paragraph
          // break: read aloud, it lands in the middle of a sentence.
          var gapBreak = i > 0 && ls[i - 1].y - l.y > step * 1.4;
          if (caption && !gapBreak && !(i > 0 && l.y > ls[i - 1].y)) return;
          var resumed = caption;
          caption = false;
          if (CAPTION.test(l.text)) { caption = true; return; }
          // Clearly larger type is a heading: its own line, and marked for
          // fromText when the chapters come from headings.
          if (isHead(l)) { out += '\n\n' + (markHeads ? '# ' : '') + l.text + '\n\n'; prev = null; return; }
          var brk = !prev || (i > 0 && ls[i - 1].y - l.y > step * 1.4) ||
            (prev.end - prev.x < bodyW * 0.75 && /[.!?:"”’)]$/.test(prev.text));
          // A page break, or a skipped caption, mid-sentence (or mid-word) joins.
          if (!prev || resumed) brk = !/(?:[a-z,;]|[a-z]-)$/.test(out);
          if (brk) out += '\n\n' + l.text;
          else if (/[a-z]-$/.test(out) && /^[a-z]/.test(l.text)) out = out.slice(0, -1) + l.text;
          else out += ' ' + l.text;
          prev = l;
        });
        prev = null;
      }
      return out.replace(/\n{3,}/g, '\n\n').trim();
    }

    var info = pdf.info || {}, chapters = [];
    // Bookmarks: the shallowest level that has two or more entries.
    var ol = (pdf.outline || []).filter(function (o) { return o.page >= 0 && o.page < pages.length && o.title; });
    var depths = {};
    ol.forEach(function (o) { depths[o.depth] = (depths[o.depth] || 0) + 1; });
    var lvl = Object.keys(depths).map(Number).sort(function (x, y) { return x - y; }).filter(function (d) { return depths[d] >= 2; })[0];
    if (lvl != null) {
      var marks = ol.filter(function (o) { return o.depth === lvl; }).sort(function (x, y) { return x.page - y.page; });
      marks = marks.filter(function (o, i) { return !i || o.page > marks[i - 1].page; });
      if (marks[0].page > 0) {
        var pre = textOf(0, marks[0].page, false);
        if (words(pre) >= MIN_WORDS) chapters.push({ title: 'Opening', text: pre });
      }
      marks.forEach(function (o, i) {
        var t = textOf(o.page, i + 1 < marks.length ? marks[i + 1].page : pages.length, false);
        // The bookmark's own title is usually the first line of its text.
        var first = t.split('\n')[0].trim();
        if (first.toLowerCase() === String(o.title).trim().toLowerCase()) t = t.slice(first.length).trim();
        if (words(t)) chapters.push({ title: String(o.title).trim(), text: t });
      });
      chapters = chapters.filter(function (c) { return !/^(table of )?contents$/i.test(c.title); });
    }
    if (!chapters.length) chapters = fromText(textOf(0, pages.length, useSize)).chapters;
    // Word and print drivers fill Title with the file name.
    var title = String(info.title || '').trim();
    if (/^(microsoft word\b|untitled\b)|\.(docx?|pages|odt|rtf|txt|indd)$/i.test(title)) title = '';
    return { title: title, author: String(info.author || '').trim(), chapters: chapters };
  }

  /* ------------------------------------------------------------ chapters */

  // ffmpeg's FFMETADATA1 with one [CHAPTER] per entry; starts and ends in ms.
  // = ; # \ and newlines are escaped with a backslash, as the format requires.
  function ffmetadata(meta, chapters) {
    function esc(v) { return String(v || '').replace(/[=;#\\\n]/g, function (c) { return '\\' + c; }); }
    var out = [';FFMETADATA1'];
    if (meta.title) out.push('title=' + esc(meta.title), 'album=' + esc(meta.title));
    if (meta.author) out.push('artist=' + esc(meta.author), 'album_artist=' + esc(meta.author));
    if (meta.comment) out.push('comment=' + esc(meta.comment));
    out.push('genre=Audiobook');
    var t = 0;
    chapters.forEach(function (c) {
      var start = Math.round(t * 1000), end = Math.round((t + c.seconds) * 1000);
      out.push('[CHAPTER]', 'TIMEBASE=1/1000', 'START=' + start, 'END=' + end, 'title=' + esc(c.title));
      t += c.seconds;
    });
    return out.join('\n') + '\n';
  }

  return { fromText: fromText, fromEpub: fromEpub, fromPdf: fromPdf, htmlText: htmlText, words: words, zipIndex: zipIndex, ffmetadata: ffmetadata };
}));
