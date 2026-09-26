// Shared dropzone + UI helpers used by every tool page.
(function (global) {
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  function fmtBytes(n) {
    if (n == null || isNaN(n)) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(2) + ' MB';
    return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  // Extension filter, applied to BOTH intake paths. It used to run only on the
  // drop path, so a file chosen through the OS picker skipped validation
  // entirely and went straight to the decoder.
  function filterAccepted(files, accept) {
    if (!accept || !accept.length) return { ok: files, rejected: [] };
    var ok = [], rejected = [];
    files.forEach(function (f) {
      var match = accept.some(function (ext) {
        return f.name.toLowerCase().endsWith(ext.toLowerCase());
      });
      (match ? ok : rejected).push(f);
    });
    return { ok: ok, rejected: rejected };
  }

  function bindDropzone(dropzoneEl, fileInputEl, onFiles, accept, onRejected) {
    function openPicker() { fileInputEl.click(); }

    // The dropzone is a div, so it needs the button semantics spelled out or it
    // is unreachable by keyboard — and the file input itself is display:none,
    // which takes it out of the tab order too.
    dropzoneEl.setAttribute('role', 'button');
    dropzoneEl.setAttribute('tabindex', '0');
    if (!dropzoneEl.getAttribute('aria-label')) {
      var big = dropzoneEl.querySelector('.big');
      dropzoneEl.setAttribute('aria-label', (big ? big.textContent.trim() : 'Choose a file') + ' — opens a file picker');
    }
    dropzoneEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        openPicker();
      }
    });

    function deliver(files) {
      var split = filterAccepted(files, accept);
      if (split.rejected.length && onRejected) onRejected(split.rejected, accept);
      onFiles(split.ok);
    }

    dropzoneEl.addEventListener('click', function (e) {
      if (e.target.tagName === 'BUTTON' || e.target.tagName === 'A') return;
      openPicker();
    });
    fileInputEl.addEventListener('change', function (e) {
      deliver(Array.from(e.target.files));
      fileInputEl.value = '';
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      dropzoneEl.addEventListener(ev, function (e) {
        e.preventDefault(); e.stopPropagation();
        dropzoneEl.classList.add('dragover');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dropzoneEl.addEventListener(ev, function (e) {
        e.preventDefault(); e.stopPropagation();
        dropzoneEl.classList.remove('dragover');
      });
    });
    dropzoneEl.addEventListener('drop', function (e) {
      deliver(Array.from(e.dataTransfer.files));
    });
  }

  // Status text is the only feedback several tools give, and it was invisible to
  // assistive tech: a plain div whose textContent was swapped. alert for errors
  // (interrupts), polite status for everything else.
  function setStatus(el, kind, msg) {
    el.className = 'status ' + kind;
    if (kind === 'error') {
      el.setAttribute('role', 'alert');
      el.setAttribute('aria-live', 'assertive');
    } else {
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
    }
    el.textContent = msg;
  }
  function clearStatus(el) {
    el.className = 'status hidden';
    el.textContent = '';
    if (signalEl && el.id === 'status') { sigRow('in', ''); sigRow('out', ''); }
  }
  function setProgress(barEl, pct) {
    var v = Math.max(0, Math.min(100, pct));
    barEl.style.width = v + '%';
    var wrap = barEl.parentNode;
    if (wrap && wrap.classList && wrap.classList.contains('progress')) {
      wrap.setAttribute('role', 'progressbar');
      wrap.setAttribute('aria-valuemin', '0');
      wrap.setAttribute('aria-valuemax', '100');
      wrap.setAttribute('aria-valuenow', String(Math.round(v)));
    }
  }

  // Remember a <select> across visits. Restores only a value this page actually
  // offers, so a 320 kbps preference does not select a missing option on a page
  // whose list stops at 256.
  function remember(sel, key) {
    if (!sel) return;
    var k = 'as_pref:' + (key || sel.id);
    try {
      var saved = localStorage.getItem(k);
      if (saved !== null) {
        var has = Array.prototype.some.call(sel.options, function (o) { return o.value === saved; });
        if (has) sel.value = saved;
      }
    } catch (e) {}
    sel.addEventListener('change', function () {
      try { localStorage.setItem(k, sel.value); } catch (e) {}
    });
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  function renderFileList(listEl, files, onRemove) {
    listEl.innerHTML = '';
    files.forEach(function (f, idx) {
      var item = document.createElement('div');
      item.className = 'file-item';
      var span = document.createElement('span');
      var name = document.createElement('span');
      name.className = 'name'; name.textContent = f.name;
      var size = document.createElement('span');
      size.className = 'size'; size.textContent = fmtBytes(f.size);
      span.appendChild(name); span.appendChild(size);
      describeFile(f, span);
      item.appendChild(span);
      if (onRemove) {
        var rm = document.createElement('button');
        rm.className = 'remove';
        rm.textContent = '\u00d7';
        rm.title = 'Remove';
        rm.onclick = function () { onRemove(idx); };
        item.appendChild(rm);
      }
      listEl.appendChild(item);
    });
  }

  // The file's real format next to its name: "FLAC · 96 kHz · 24-bit ·
  // stereo", read from its header (AudioSaw.sniffFormat). Nothing is shown
  // for a format the sniffer does not know rather than a guess.
  function describeFile(f, into) {
    var A = global.AudioSaw;
    if (!A || !A.sniffFormat || !f || !f.slice) return;
    var tag = document.createElement('span');
    tag.className = 'fmt';
    into.appendChild(tag);
    f.slice(0, 1 << 20).arrayBuffer().then(function (buf) {
      var info = A.sniffFormat(buf);
      if (info) tag.textContent = A.describeFormat(info);
    }).catch(function () {});
  }

  // What went in and what came out, measured, under the status line on every
  // tool page: audio-core announces 'as:decoded' when it reads the picked
  // file and 'as:encoded' with the header of the file it wrote. The editor
  // has its own readouts and is left out.
  var signalEl = null;
  function signalPanel() {
    if (signalEl && signalEl.isConnected) return signalEl;
    var host = document.getElementById('status');
    if (!host || document.getElementById('ed')) return null;
    signalEl = document.createElement('div');
    signalEl.className = 'signal-path';
    signalEl.id = 'signalPath';
    signalEl.hidden = true;
    signalEl.setAttribute('aria-live', 'polite');
    signalEl.innerHTML = '<div class="sig-row" data-sig="in"><span class="sig-k">Your file</span><span class="sig-v"></span></div>' +
      '<div class="sig-row" data-sig="out" hidden><span class="sig-k">Saved as</span><span class="sig-v"></span></div>';
    host.parentNode.insertBefore(signalEl, host.nextSibling);
    return signalEl;
  }
  function sigRow(which, text) {
    var el = signalPanel();
    if (!el) return;
    var row = el.querySelector('[data-sig="' + which + '"]');
    row.hidden = !text;
    row.querySelector('.sig-v').textContent = text || '';
    el.hidden = !el.querySelector('.sig-row:not([hidden])');
  }
  document.addEventListener('as:decoded', function (e) {
    var d = e.detail || {};
    var t = d.text || '';
    if (d.converted && d.sampleRate) t += ' → decoded at ' + (d.sampleRate / 1000) + ' kHz (the browser could not keep its rate)';
    sigRow('in', t);
    sigRow('out', '');
  });
  document.addEventListener('as:encoded', function (e) {
    var d = e.detail || {};
    sigRow('out', (d.text || '') + (d.notes && d.notes.length ? ' · ' + d.notes.join(' · ') : ''));
  });

  // Natural ordering so "file2" sorts before "file10".
  function naturalCompare(a, b) {
    var ax = a.match(/(\d+|\D+)/g) || [];
    var bx = b.match(/(\d+|\D+)/g) || [];
    var len = Math.min(ax.length, bx.length);
    for (var i = 0; i < len; i++) {
      var na = parseInt(ax[i], 10), nb = parseInt(bx[i], 10);
      if (!isNaN(na) && !isNaN(nb)) { if (na !== nb) return na - nb; }
      else { var c = ax[i].localeCompare(bx[i]); if (c !== 0) return c; }
    }
    return ax.length - bx.length;
  }

  // Best-effort MIME guess for previews.
  var MIME_BY_EXT = {
    'jpg':'image/jpeg','jpeg':'image/jpeg','png':'image/png','gif':'image/gif',
    'webp':'image/webp','bmp':'image/bmp','svg':'image/svg+xml','ico':'image/x-icon',
    'mp3':'audio/mpeg','wav':'audio/wav','ogg':'audio/ogg','oga':'audio/ogg','m4a':'audio/mp4','flac':'audio/flac',
    'opus':'audio/opus','aac':'audio/aac','aiff':'audio/aiff','aif':'audio/aiff','m4b':'audio/mp4','m4r':'audio/mp4','weba':'audio/webm','amr':'audio/amr','wma':'audio/x-ms-wma',
    'mp4':'video/mp4','webm':'video/webm','mov':'video/quicktime','mkv':'video/x-matroska',
    'pdf':'application/pdf',
    'json':'application/json','xml':'application/xml','html':'text/html','htm':'text/html',
    'css':'text/css','js':'application/javascript','ts':'application/typescript',
    'md':'text/markdown','csv':'text/csv','tsv':'text/tab-separated-values',
    'txt':'text/plain','log':'text/plain','ini':'text/plain','conf':'text/plain','yml':'text/plain','yaml':'text/plain'
  };
  function guessMime(name) {
    var ext = (name.split('.').pop() || '').toLowerCase();
    return MIME_BY_EXT[ext] || 'application/octet-stream';
  }
  function isTextLike(name) {
    var m = guessMime(name);
    return m.indexOf('text/') === 0 || /(json|xml|javascript|typescript|markdown|csv)/.test(m);
  }
  function isImage(name)  { return guessMime(name).indexOf('image/') === 0; }
  function isAudio(name)  { return guessMime(name).indexOf('audio/') === 0; }
  function isVideo(name)  { return guessMime(name).indexOf('video/') === 0; }
  function isPdf(name)    { return guessMime(name) === 'application/pdf'; }

  global.CV = {
    $: $, $$: $$,
    fmtBytes: fmtBytes,
    bindDropzone: bindDropzone,
    filterAccepted: filterAccepted,
    remember: remember,
    setStatus: setStatus,
    clearStatus: clearStatus,
    setProgress: setProgress,
    downloadBlob: downloadBlob,
    renderFileList: renderFileList,
    describeFile: describeFile,
    signal: { input: function (t) { sigRow('in', t); sigRow('out', ''); }, output: function (t) { sigRow('out', t); } },
    naturalCompare: naturalCompare,
    guessMime: guessMime,
    isTextLike: isTextLike,
    isImage: isImage,
    isAudio: isAudio,
    isVideo: isVideo,
    isPdf: isPdf
  };
})(window);
