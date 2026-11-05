/*
 * /fake-lossless-detector and /audio-file-info: one controller, two pages.
 * The tool section's data-inspect says which ("lossless" or "info").
 *
 * Each file is decoded at its own rate (AudioSaw.decodeToAudioBuffer), its
 * header read (sniffFormat, plus the MP3 frame for CBR/VBR and the encoder),
 * and js/audio-inspect.js measures what the samples really hold: the
 * long-term spectrum and its cutoff, the bits in use, peaks, DC, clipping.
 * The info page adds integrated loudness (on a 48 kHz copy, where BS.1770 is
 * defined) and true peak (on the file's own samples), from js/loudness.js.
 *
 * Nothing is written, so like the BPM finder these fire convert_start (the
 * button carries data-track="convert", and a drop presses it) and no
 * convert_success, except the info page's CSV download.
 */
(function () {
  'use strict';
  if (typeof CV === 'undefined' || typeof AudioSaw === 'undefined' || typeof ASInspect === 'undefined') {
    console.error('[inspect] the /js/* includes must come before inspect-page.js');
    return;
  }
  var $ = CV.$;
  var app = document.querySelector('[data-inspect]');
  if (!app) return;
  var MODE = app.getAttribute('data-inspect');
  var dropzone = $('#dropzone'), fileInput = $('#fileInput'), fileList = $('#fileList'), goBtn = $('#convertBtn');
  var statusEl = $('#status'), results = $('#results'), actions = $('#infoActions');
  var files = [], rows = [];
  if (!dropzone || !goBtn || !results) return;

  function kHz(r) { return r ? (r % 1000 ? (r / 1000).toFixed(1) : r / 1000) + ' kHz' : '—'; }
  function dB(x, unit) { return isFinite(x) ? x.toFixed(1) + ' ' + unit : '—'; }
  function dur(s) { var m = Math.floor(s / 60), r = s - m * 60; return (m ? m + ':' + (r < 10 ? '0' : '') + r.toFixed(2) : r.toFixed(2) + ' s'); }
  function channelsOf(b) { var o = []; for (var c = 0; c < b.numberOfChannels; c++) o.push(b.getChannelData(c)); return o; }
  function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function drawSpectrum(canvas, sp, cut) {
    var dpr = window.devicePixelRatio || 1, W = canvas.clientWidth || 640, H = canvas.clientHeight || 220;
    canvas.width = W * dpr; canvas.height = H * dpr;
    var g = canvas.getContext('2d'); g.scale(dpr, dpr);
    var css = getComputedStyle(document.body);
    var ink = css.getPropertyValue('--ink').trim() || '#222', muted = css.getPropertyValue('--muted').trim() || '#888', accent = css.getPropertyValue('--amber').trim() || '#c2410c';
    var L = 44, B = 22, T = 8, R = 8, w = W - L - R, h = H - T - B, top = 0, bot = -140;
    var nyq = sp.rate / 2;
    g.clearRect(0, 0, W, H);
    g.font = '11px system-ui, sans-serif'; g.fillStyle = muted; g.strokeStyle = 'rgba(128,128,128,.25)'; g.lineWidth = 1;
    for (var d = 0; d >= bot; d -= 20) { var y = T + h * (top - d) / (top - bot); g.beginPath(); g.moveTo(L, y); g.lineTo(L + w, y); g.stroke(); g.fillText(d + ' dB', 2, y + 4); }
    var step = nyq > 30000 ? 10000 : 2000;
    for (var f = 0; f <= nyq; f += step) { var x = L + w * f / nyq; g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + h); g.stroke(); g.fillText((f / 1000) + 'k', x - 8, H - 6); }
    g.strokeStyle = ink; g.lineWidth = 1.5; g.beginPath();
    for (var b = 0; b < sp.db.length; b++) {
      var xx = L + w * sp.hz[b] / nyq, yy = T + h * (top - Math.max(bot, Math.min(top, sp.db[b]))) / (top - bot);
      if (b) g.lineTo(xx, yy); else g.moveTo(xx, yy);
    }
    g.stroke();
    if (cut && cut.sharp) {
      var cx = L + w * cut.hz / nyq;
      g.strokeStyle = accent; g.setLineDash([4, 3]); g.beginPath(); g.moveTo(cx, T); g.lineTo(cx, T + h); g.stroke(); g.setLineDash([]);
      g.fillStyle = accent; g.fillText('cutoff ' + (cut.hz / 1000).toFixed(1) + ' kHz', Math.min(cx + 4, L + w - 90), T + 12);
    }
  }

  async function inspect(file) {
    var head = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
    var info = null;
    try { info = AudioSaw.sniffFormat(head); } catch (e) { info = null; }
    var buf = await AudioSaw.decodeToAudioBuffer(file);
    info = info || buf.srcInfo || {};
    var sr = buf.sampleRate, chans = channelsOf(buf);
    await tick();
    var sp = ASInspect.spectrum(chans, sr), cut = ASInspect.cutoff(sp);
    var bits = info.lossless && !info.float ? ASInspect.bitsUsed(chans, info.bits) : null;
    var verdicts = ASInspect.verdict(info, sp, cut, bits);
    var r = { file: file, info: info, rate: sr, channels: buf.numberOfChannels, duration: buf.duration, sp: sp, cut: cut, bits: bits, verdicts: verdicts };
    if (info.container === 'mp3' || /\.mp3$/i.test(file.name)) r.mp3 = ASInspect.mp3Info(head);
    if (MODE === 'info') {
      var st = ASInspect.stats(chans, sr), ed = ASInspect.edges(chans, sr);
      r.stats = st; r.edges = ed;
      if (window.ASLoudness) {
        r.truePeak = ASLoudness.toDb(ASLoudness.truePeak(chans));
        var at48 = sr === 48000 ? chans : channelsOf(await AudioSaw.resampleBuffer(buf, 48000));
        r.lufs = ASLoudness.integratedLoudness(at48, 48000).integrated;
      }
    }
    return r;
  }

  function fields(r) {
    var i = r.info || {}, kbps = r.duration > 0 ? Math.round(r.file.size * 8 / r.duration / 1000) : 0;
    var codec = AudioSaw.describeFormat({ container: i.container, codec: i.codec }) || (r.file.name.split('.').pop() || '').toUpperCase();
    var depth = i.float ? '32-bit float' : i.lossless && i.bits ? i.bits + '-bit' : 'lossy (no fixed depth)';
    if (r.bits && r.bits.used < r.bits.declared) depth += ', only ' + r.bits.used + ' in use';
    var br = kbps + ' kbps average';
    if (r.mp3) br = (r.mp3.vbr ? 'VBR, ' + kbps + ' kbps average' : r.mp3.kbps + ' kbps CBR') + (r.mp3.encoder ? ' · ' + r.mp3.encoder : '') + ' · ' + r.mp3.mode;
    var out = [
      ['File', r.file.name], ['Size', CV.fmtBytes(r.file.size)], ['Format', codec], ['Sample rate', kHz(r.rate)],
      ['Bit depth', depth], ['Channels', r.channels === 1 ? 'mono' : r.channels === 2 ? (r.stats && r.stats.monoInStereo ? 'stereo, but both sides identical (mono)' : 'stereo') : r.channels + ' channels'],
      ['Duration', dur(r.duration)], ['Bitrate', br]
    ];
    if (r.stats) {
      out.push(['Loudness', isFinite(r.lufs) ? r.lufs.toFixed(1) + ' LUFS integrated' : '—']);
      out.push(['True peak', dB(r.truePeak, 'dBTP')]);
      out.push(['Sample peak', dB(20 * Math.log10(Math.max(1e-12, r.stats.peak)), 'dBFS')]);
      out.push(['Clipping', r.stats.clips ? r.stats.clips + ' run' + (r.stats.clips === 1 ? '' : 's') + ' at full scale (' + r.stats.clippedSamples + ' samples)' : 'none']);
      out.push(['DC offset', r.stats.dc.map(function (d) { return (Math.abs(d) < 5e-6 ? 0 : d * 100).toFixed(3) + '%'; }).join(' / ')]);
      out.push(['Silence', r.edges.lead.toFixed(2) + ' s at the start, ' + r.edges.tail.toFixed(2) + ' s at the end']);
    }
    out.push(['Top end', r.cut.sharp ? 'cuts off at ' + (r.cut.hz / 1000).toFixed(1) + ' kHz (' + r.verdicts[r.verdicts.length - 1].grade.replace('-', ' ') + ')' : r.cut.full ? 'content to ' + kHz(r.rate / 2) + ', no cutoff' : 'fades out by ' + (r.cut.hz / 1000).toFixed(1) + ' kHz']);
    return out;
  }

  function render(r) {
    var card = el('div', 'inspect-card');
    card.appendChild(el('h3', null, r.file.name));
    card.appendChild(el('p', 'inspect-format', AudioSaw.describeFormat(r.info) || ''));
    if (MODE === 'lossless') {
      r.verdicts.forEach(function (v) {
        var box = el('div', 'verdict verdict-' + v.grade);
        box.appendChild(el('strong', null, v.title));
        box.appendChild(el('p', null, v.detail));
        card.appendChild(box);
      });
    }
    var cv = el('canvas', 'spectrum'); cv.setAttribute('role', 'img');
    cv.setAttribute('aria-label', 'Average spectrum of ' + r.file.name + (r.cut.sharp ? ', with a cutoff at ' + (r.cut.hz / 1000).toFixed(1) + ' kHz' : ''));
    card.appendChild(cv);
    if (MODE === 'info') {
      var wrap = el('div', 'spec-wrap'), t = el('table', 'spec-table'), tb = el('tbody');
      fields(r).forEach(function (f) { var tr = el('tr'); tr.appendChild(el('th', null, f[0])); tr.appendChild(el('td', null, f[1])); tb.appendChild(tr); });
      t.appendChild(tb); wrap.appendChild(t); card.appendChild(wrap);
    }
    results.appendChild(card);
    drawSpectrum(cv, r.sp, r.cut);
  }

  CV.bindDropzone(dropzone, fileInput, function (picked) {
    files = picked.slice(0, 20);
    CV.renderFileList(fileList, files, function (idx) { files.splice(idx, 1); goBtn.disabled = !files.length; });
    fileList.style.display = '';
    goBtn.disabled = false;
    goBtn.click();
  });

  goBtn.addEventListener('click', async function () {
    if (!files.length) return;
    goBtn.disabled = true;
    results.innerHTML = ''; rows = [];
    if (actions) actions.hidden = true;
    for (var k = 0; k < files.length; k++) {
      CV.setStatus(statusEl, 'info', (files.length > 1 ? '[' + (k + 1) + '/' + files.length + '] ' : '') + 'Reading ' + files[k].name + '…');
      try { var r = await inspect(files[k]); rows.push(r); render(r); }
      catch (e) { CV.setStatus(statusEl, 'error', 'Could not read ' + files[k].name + '. ' + (e.message || e), e); goBtn.disabled = false; return; }
    }
    var flagged = rows.filter(function (r) { return r.verdicts.some(function (v) { return v.grade !== 'genuine' && v.grade !== 'unclear'; }); }).length;
    CV.setStatus(statusEl, 'success', MODE === 'lossless'
      ? (rows.length === 1 ? rows[0].verdicts[0].title + '.' : flagged + ' of ' + rows.length + ' files show signs of a lossy or padded source.')
      : 'Read ' + rows.length + ' file' + (rows.length === 1 ? '' : 's') + '.');
    if (actions) actions.hidden = MODE !== 'info';
    goBtn.disabled = false;
  });

  function asText() {
    return rows.map(function (r) { return fields(r).map(function (f) { return f[0] + ': ' + f[1]; }).join('\n'); }).join('\n\n');
  }
  function asCsv() {
    if (!rows.length) return '';
    var head = fields(rows[0]).map(function (f) { return f[0]; });
    var q = function (s) { s = String(s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    return [head.map(q).join(',')].concat(rows.map(function (r) { return fields(r).map(function (f) { return q(f[1]); }).join(','); })).join('\n') + '\n';
  }
  var copyBtn = $('#copyBtn'), csvBtn = $('#csvBtn');
  if (copyBtn) copyBtn.addEventListener('click', function () {
    var text = asText();
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { copyBtn.textContent = 'Copied'; setTimeout(function () { copyBtn.textContent = 'Copy as text'; }, 1500); }, function () {
      var ta = el('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (e) {} ta.remove();
    });
  });
  if (csvBtn) csvBtn.addEventListener('click', function () { CV.downloadBlob(new Blob([asCsv()], { type: 'text/csv' }), 'audio-file-info.csv'); });

  window.__inspect = { rows: function () { return rows; }, fields: fields, text: asText, csv: asCsv, use: function (fs) { files = fs; goBtn.disabled = false; goBtn.click(); } };
})();
