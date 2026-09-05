/*
 * MP3 tag editor — reads and writes ID3v2 without touching the audio.
 *
 * An MP3 file is an ID3v2 tag (optional, at the front) followed by the audio
 * frames. Editing tags therefore means parsing the existing tag to prefill the
 * form, then writing a fresh tag and concatenating the untouched audio after
 * it. Nothing is decoded or re-encoded, so this is completely lossless — the
 * audio bytes that come out are the bytes that went in.
 *
 * That matters here specifically: every conversion on this site drops metadata,
 * and the format pages now say so. This is the tool that lets people put it
 * back.
 *
 * Writes ID3v2.3, which is the most widely supported version — 2.4's
 * syncsafe frame sizes still confuse some car stereos and older players.
 */
(function () {
  'use strict';

  var $ = CV.$;
  var TEXT_FRAMES = {
    title: 'TIT2', artist: 'TPE1', album: 'TALB',
    year: 'TYER', genre: 'TCON', track: 'TRCK', albumArtist: 'TPE2', comment: null
  };

  /* --------------------------------------------------------------- reading */

  function readSyncsafe(view, off) {
    return (view.getUint8(off) << 21) | (view.getUint8(off + 1) << 14) |
           (view.getUint8(off + 2) << 7) | view.getUint8(off + 3);
  }

  function decodeText(bytes) {
    if (!bytes.length) return '';
    var encoding = bytes[0];
    var body = bytes.subarray(1);
    try {
      if (encoding === 0) return new TextDecoder('iso-8859-1').decode(body).replace(/\0+$/, '');
      if (encoding === 1) return new TextDecoder('utf-16').decode(body).replace(/\0+$/, '');
      if (encoding === 2) return new TextDecoder('utf-16be').decode(body).replace(/\0+$/, '');
      return new TextDecoder('utf-8').decode(body).replace(/\0+$/, '');
    } catch (e) {
      return '';
    }
  }

  // Returns { tags, artwork, audioOffset } — audioOffset is where the MP3
  // frames actually begin, i.e. everything after any existing tag.
  function parseID3(buf) {
    var bytes = new Uint8Array(buf);
    var out = { tags: {}, artwork: null, audioOffset: 0 };

    if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) {
      return out; // no ID3v2 tag; audio starts at byte 0
    }

    var view = new DataView(buf);
    var version = bytes[3];
    var size = readSyncsafe(view, 6);
    out.audioOffset = 10 + size;

    var pos = 10;
    var end = Math.min(10 + size, bytes.length);
    var frameIdLen = version === 2 ? 3 : 4;
    var frameHeaderLen = version === 2 ? 6 : 10;

    while (pos + frameHeaderLen <= end) {
      var id = '';
      for (var i = 0; i < frameIdLen; i++) id += String.fromCharCode(bytes[pos + i]);
      if (!/^[A-Z0-9]+$/.test(id)) break; // padding reached

      var frameSize;
      if (version === 2) {
        frameSize = (bytes[pos + 3] << 16) | (bytes[pos + 4] << 8) | bytes[pos + 5];
      } else if (version === 4) {
        frameSize = readSyncsafe(view, pos + 4);
      } else {
        frameSize = view.getUint32(pos + 4);
      }
      if (frameSize <= 0 || pos + frameHeaderLen + frameSize > end) break;

      var body = bytes.subarray(pos + frameHeaderLen, pos + frameHeaderLen + frameSize);

      if (id === 'APIC' || id === 'PIC') {
        out.artwork = extractArtwork(body, id === 'PIC');
      } else if (id.charAt(0) === 'T') {
        var value = decodeText(body);
        for (var key in TEXT_FRAMES) {
          if (TEXT_FRAMES[key] === id) out.tags[key] = value;
        }
      } else if (id === 'COMM') {
        out.tags.comment = decodeComment(body);
      }

      pos += frameHeaderLen + frameSize;
    }
    return out;
  }

  // COMM is laid out as: encoding byte, three-byte language code, a short
  // description terminated by a null, then the comment itself. Decoding the
  // whole body as text yields the language code and description as garbage, so
  // the header has to be stepped over properly — and in UTF-16 the terminator
  // is a two-byte pair, not one byte.
  function decodeComment(body) {
    if (body.length < 5) return '';
    var enc = body[0];
    var p = 4; // encoding + 3-byte language
    if (enc === 1 || enc === 2) {
      if (p + 1 < body.length && body[p] === 0xFF && body[p + 1] === 0xFE) p += 2; // description BOM
      while (p + 1 < body.length && !(body[p] === 0 && body[p + 1] === 0)) p += 2;
      p += 2;
    } else {
      while (p < body.length && body[p] !== 0) p++;
      p += 1;
    }
    if (p >= body.length) return '';
    var slice = new Uint8Array(body.length - p + 1);
    slice[0] = enc;
    slice.set(body.subarray(p), 1);
    return decodeText(slice);
  }

  function extractArtwork(body, isV2) {
    try {
      var p = 1; // skip encoding byte
      var mime;
      if (isV2) {
        mime = 'image/' + String.fromCharCode(body[1], body[2], body[3]).toLowerCase();
        p = 4;
      } else {
        var s = p;
        while (p < body.length && body[p] !== 0) p++;
        mime = new TextDecoder('iso-8859-1').decode(body.subarray(s, p));
        p++;
      }
      p++; // picture type
      while (p < body.length && body[p] !== 0) p++; // description
      p++;
      return { mime: mime || 'image/jpeg', data: body.subarray(p) };
    } catch (e) {
      return null;
    }
  }

  /* --------------------------------------------------------------- writing */

  function encodeUtf16(str) {
    // UTF-16 with BOM — encoding byte 1. Handles any script the user types.
    var out = new Uint8Array(2 + str.length * 2);
    out[0] = 0xFF; out[1] = 0xFE;
    for (var i = 0; i < str.length; i++) {
      var code = str.charCodeAt(i);
      out[2 + i * 2] = code & 0xFF;
      out[3 + i * 2] = code >> 8;
    }
    return out;
  }

  function textFrame(id, value) {
    var text = encodeUtf16(value);
    var body = new Uint8Array(1 + text.length);
    body[0] = 1; // UTF-16 with BOM
    body.set(text, 1);
    return frame(id, body);
  }

  function commentFrame(value) {
    var text = encodeUtf16(value);
    // encoding, language, then an empty description: BOM followed by the
    // two-byte UTF-16 null terminator. Omitting the terminator makes the
    // description and the comment run together.
    var body = new Uint8Array(1 + 3 + 2 + 2 + text.length);
    body[0] = 1;
    body[1] = 0x65; body[2] = 0x6E; body[3] = 0x67;  // 'eng'
    body[4] = 0xFF; body[5] = 0xFE;                   // description BOM
    body[6] = 0x00; body[7] = 0x00;                   // description terminator
    body.set(text, 8);
    return frame('COMM', body);
  }

  function apicFrame(mime, data) {
    var mimeBytes = new TextEncoder().encode(mime);
    var body = new Uint8Array(1 + mimeBytes.length + 1 + 1 + 1 + data.length);
    var p = 0;
    body[p++] = 0;                       // ISO-8859-1
    body.set(mimeBytes, p); p += mimeBytes.length;
    body[p++] = 0;                       // mime terminator
    body[p++] = 3;                       // picture type: cover (front)
    body[p++] = 0;                       // empty description terminator
    body.set(data, p);
    return frame('APIC', body);
  }

  function frame(id, body) {
    var out = new Uint8Array(10 + body.length);
    for (var i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
    // ID3v2.3 frame sizes are plain big-endian, not syncsafe.
    out[4] = (body.length >>> 24) & 0xFF;
    out[5] = (body.length >>> 16) & 0xFF;
    out[6] = (body.length >>> 8) & 0xFF;
    out[7] = body.length & 0xFF;
    out[8] = 0; out[9] = 0;
    out.set(body, 10);
    return out;
  }

  function buildTag(tags, artwork) {
    var frames = [];
    Object.keys(TEXT_FRAMES).forEach(function (key) {
      var id = TEXT_FRAMES[key];
      var value = (tags[key] || '').trim();
      if (id && value) frames.push(textFrame(id, value));
    });
    if ((tags.comment || '').trim()) frames.push(commentFrame(tags.comment.trim()));
    if (artwork && artwork.data && artwork.data.length) {
      frames.push(apicFrame(artwork.mime, artwork.data));
    }

    var total = frames.reduce(function (a, f) { return a + f.length; }, 0);
    var padding = 512;   // room for a later edit without rewriting the file
    var size = total + padding;

    var header = new Uint8Array(10);
    header[0] = 0x49; header[1] = 0x44; header[2] = 0x33;  // 'ID3'
    header[3] = 3; header[4] = 0;                           // v2.3.0
    header[5] = 0;                                          // no flags
    // Header size IS syncsafe, unlike v2.3 frame sizes.
    header[6] = (size >>> 21) & 0x7F;
    header[7] = (size >>> 14) & 0x7F;
    header[8] = (size >>> 7) & 0x7F;
    header[9] = size & 0x7F;

    var tag = new Uint8Array(10 + size);
    tag.set(header, 0);
    var p = 10;
    frames.forEach(function (f) { tag.set(f, p); p += f.length; });
    return tag;
  }

  /* ------------------------------------------------------------------- UI */

  var currentFile = null;
  var currentArtwork = null;
  var audioBytes = null;

  var fields = ['title', 'artist', 'album', 'albumArtist', 'year', 'track', 'genre', 'comment'];

  function setFields(tags) {
    fields.forEach(function (f) {
      var el = $('#tag-' + f);
      if (el) el.value = tags[f] || '';
    });
  }

  function showArtwork(art) {
    var wrap = $('#artPreview');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (!art || !art.data || !art.data.length) {
      wrap.textContent = 'no artwork';
      wrap.classList.add('empty');
      return;
    }
    wrap.classList.remove('empty');
    var img = document.createElement('img');
    img.alt = 'Cover artwork';
    img.src = URL.createObjectURL(new Blob([art.data], { type: art.mime }));
    wrap.appendChild(img);
  }

  function onFiles(picked) {
    var file = picked && picked[0];
    if (!file) return;
    if (!/\.mp3$/i.test(file.name)) {
      CV.setStatus($('#status'), 'error', 'This editor works on MP3 files. Other formats store tags differently — convert to MP3 first.');
      return;
    }
    currentFile = file;
    CV.setStatus($('#status'), 'info', 'Reading tags…');

    file.arrayBuffer().then(function (buf) {
      var parsed = parseID3(buf);
      audioBytes = new Uint8Array(buf).subarray(parsed.audioOffset);
      currentArtwork = parsed.artwork;
      setFields(parsed.tags);
      showArtwork(parsed.artwork);
      CV.renderFileList($('#fileList'), [file], null);
      $('#fileList').style.display = '';
      $('#controls').style.display = '';
      $('#convertBtn').disabled = false;
      var found = Object.keys(parsed.tags).length;
      CV.setStatus($('#status'), 'info', found
        ? 'Found ' + found + ' existing tag' + (found === 1 ? '' : 's') + '. Edit and save.'
        : 'No tags found. Fill in what you want and save.');
    }).catch(function (e) {
      CV.setStatus($('#status'), 'error', 'Could not read that file. ' + (e.message || e));
    });
  }

  CV.bindDropzone($('#dropzone'), $('#fileInput'), onFiles, ['.mp3']);

  var artInput = $('#artInput');
  if (artInput) {
    artInput.addEventListener('change', function (e) {
      var img = e.target.files && e.target.files[0];
      if (!img) return;
      img.arrayBuffer().then(function (buf) {
        currentArtwork = { mime: img.type || 'image/jpeg', data: new Uint8Array(buf) };
        showArtwork(currentArtwork);
      });
    });
  }

  var removeArt = $('#removeArt');
  if (removeArt) {
    removeArt.addEventListener('click', function () {
      currentArtwork = null;
      showArtwork(null);
    });
  }

  $('#convertBtn').addEventListener('click', function () {
    if (!currentFile || !audioBytes) return;
    var tags = {};
    fields.forEach(function (f) {
      var el = $('#tag-' + f);
      if (el) tags[f] = el.value;
    });

    try {
      var tag = buildTag(tags, currentArtwork);
      var blob = new Blob([tag, audioBytes], { type: 'audio/mpeg' });
      var name = currentFile.name.replace(/\.mp3$/i, '') + '-tagged.mp3';
      CV.downloadBlob(blob, name);
      CV.setStatus($('#status'), 'success', 'Done — ' + name + ' (audio untouched)');

      var resultList = $('#resultList');
      resultList.innerHTML = '';
      var row = document.createElement('div');
      row.className = 'file-item';
      var label = document.createElement('span');
      var nm = document.createElement('span'); nm.className = 'name'; nm.textContent = name;
      var sz = document.createElement('span'); sz.className = 'size'; sz.textContent = CV.fmtBytes(blob.size);
      label.appendChild(nm); label.appendChild(sz);
      row.appendChild(label);
      var btn = document.createElement('button');
      btn.className = 'btn btn-small'; btn.textContent = 'download';
      btn.onclick = function () { CV.downloadBlob(blob, name); };
      row.appendChild(btn);
      resultList.appendChild(row);
    } catch (e) {
      CV.setStatus($('#status'), 'error', 'Could not write tags. ' + (e.message || e));
    }
  });

  var resetBtn = $('#resetBtn');
  if (resetBtn) {
    resetBtn.addEventListener('click', function () {
      currentFile = null; currentArtwork = null; audioBytes = null;
      setFields({});
      showArtwork(null);
      $('#fileList').innerHTML = '';
      $('#controls').style.display = 'none';
      $('#convertBtn').disabled = true;
      $('#resultList').innerHTML = '';
      CV.clearStatus($('#status'));
    });
  }
})();
