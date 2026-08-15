/*
 * Product logic layered on top of common.js: what happens after a conversion
 * succeeds, how a file moves from one tool to the next, and what we measure.
 *
 * Kept separate from common.js because that file is generic UI plumbing and
 * this is behaviour.
 *
 * The key trick: every tool on the site — the ~21 pages driven by
 * tool-converter.js, the 8 dedicated page scripts, universal-converter.js and
 * the 12 bespoke inline IIFEs — ends up calling CV.downloadBlob() and
 * CV.setStatus(). Wrapping those two functions instruments and enhances all 47
 * pages without touching a single page script.
 *
 * Load order: common.js -> tool-graph.js -> flow.js -> (page script)
 */
(function (global) {
  'use strict';

  var CV = global.CV;
  if (!CV) { return; } // common.js missing — nothing to hang off

  var G = global.AS_GRAPH || { TOOLS: {}, CATEGORIES: [] };

  /* ------------------------------------------------------------ analytics */

  // GA4 caps custom params, so keep cardinality low: bucket sizes, enumerate
  // error types, and never send a filename or a raw exception string.
  function track(name, params) {
    try {
      if (typeof global.gtag === 'function') global.gtag('event', name, params || {});
    } catch (e) { /* analytics must never break the tool */ }
  }

  function mbBucket(bytes) {
    var mb = bytes / (1024 * 1024);
    if (mb < 1) return '<1';
    if (mb < 5) return '1-5';
    if (mb < 25) return '5-25';
    if (mb < 100) return '25-100';
    if (mb < 500) return '100-500';
    return '500+';
  }

  function extOf(name) {
    var m = /\.([a-z0-9]+)$/i.exec(name || '');
    return m ? m[1].toLowerCase() : 'none';
  }

  // Map a raw exception onto a small enum plus a recovery suggestion.
  var ERROR_KINDS = [
    {
      id: 'decode',
      test: /decodeAudioData|EncodingError|Unable to decode|unsupported|could not decode/i,
      message: 'Your browser could not decode this file directly.',
      action: { href: '/extract-audio', label: 'Try the heavier converter' }
    },
    {
      id: 'memory',
      test: /RangeError|allocation|out of memory|Array buffer/i,
      message: 'The file is too large for the browser to hold in memory (the practical ceiling is around 500 MB).',
      action: { href: '/audio-cutter', label: 'Split it into shorter pieces first' }
    },
    {
      id: 'codec_load',
      test: /Failed to load|NetworkError|importScripts|Loading chunk|fetch/i,
      message: 'The codec could not be downloaded. An ad blocker or a dropped connection is the usual cause.',
      action: null
    },
    {
      id: 'empty',
      test: /no audio|zero|empty|0 channels/i,
      message: 'No audio track was found in that file.',
      action: { href: '/extract-audio', label: 'Try the video extractor' }
    }
  ];

  function classifyError(msg) {
    for (var i = 0; i < ERROR_KINDS.length; i++) {
      if (ERROR_KINDS[i].test.test(msg || '')) return ERROR_KINDS[i];
    }
    return { id: 'other', message: null, action: { href: '/contact', label: 'Tell us about this file' } };
  }

  /* ----------------------------------------------------------- tool identity */

  function currentTool() {
    var p = global.location.pathname.replace(/^\//, '').replace(/\.html$/, '');
    if (p === '' || p === 'index') return 'index';
    return p;
  }

  function related(slug, n) {
    var t = G.TOOLS[slug];
    if (!t || !t.next) return [];
    return t.next.slice(0, n || 3).map(function (pair) {
      var target = G.TOOLS[pair[0]] || {};
      return { slug: pair[0], href: '/' + pair[0], label: target.title || pair[0], why: pair[1] };
    });
  }

  // The homepage has no fixed "next" list — route by what was produced instead,
  // so a universal conversion becomes a signpost to the dedicated page.
  var HOME_ROUTES = {
    mp3: ['mp4-to-mp3', 'wav-to-mp3', 'm4a-to-mp3'],
    wav: ['mp3-to-wav', 'wav-44100-16bit', 'change-sample-rate'],
    m4a: ['mp3-to-m4a', 'ringtone-maker', 'audio-compressor'],
    flac: ['wav-to-flac', 'flac-to-wav', 'normalize-audio'],
    ogg: ['ogg-to-mp3', 'audio-compressor', 'normalize-audio']
  };

  function suggestionsFor(slug, outName) {
    if (slug !== 'index') return related(slug, 3);
    var picks = HOME_ROUTES[extOf(outName)] || ['audio-cutter', 'normalize-audio', 'audio-compressor'];
    return picks.map(function (s) {
      var t = G.TOOLS[s] || {};
      return { slug: s, href: '/' + s, label: t.title || s, why: t.blurb || '' };
    });
  }

  /* -------------------------------------------------------------- handoff */

  // Blobs survive a structured clone, so IndexedDB can carry the output of one
  // tool across a navigation into the next one. sessionStorage cannot.
  var DB_NAME = 'audiosaw';
  var STORE = 'handoff';

  function withStore(mode, fn) {
    return new Promise(function (resolve, reject) {
      if (!global.indexedDB) return reject(new Error('no indexedDB'));
      var req = global.indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onerror = function () { reject(req.error); };
      req.onsuccess = function () {
        var db = req.result;
        var tx = db.transaction(STORE, mode);
        var out = fn(tx.objectStore(STORE));
        tx.oncomplete = function () { db.close(); resolve(out && out.result); };
        tx.onerror = function () { db.close(); reject(tx.error); };
      };
    });
  }

  function putHandoff(payload) { return withStore('readwrite', function (s) { return s.put(payload, 'pending'); }); }
  function takeHandoff() {
    return withStore('readwrite', function (s) {
      var g = s.get('pending');
      s.delete('pending');
      return g;
    });
  }

  function canInjectFiles() {
    try { return typeof DataTransfer === 'function' && 'files' in HTMLInputElement.prototype; }
    catch (e) { return false; }
  }

  // Drive the page's own intake path rather than reimplementing it: every tool
  // binds fileInput's change event through CV.bindDropzone, so setting .files
  // and dispatching change works everywhere, bespoke pages included.
  function injectFile(file) {
    var input = document.getElementById('fileInput');
    if (!input || !canInjectFiles()) return false;
    var dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function offerHandoff() {
    var dropzone = document.getElementById('dropzone');
    if (!dropzone || !canInjectFiles()) return;
    var from = new URLSearchParams(global.location.search).get('from');
    if (!from) return;

    takeHandoff().then(function (payload) {
      if (!payload || !payload.blob) return;
      var fromTool = (G.TOOLS[payload.from] || {}).title || payload.from;

      var chip = document.createElement('div');
      chip.className = 'handoff-chip';
      chip.innerHTML =
        '<span class="handoff-text">Continue with <strong></strong> <span class="handoff-size"></span> ' +
        'from ' + escapeHtml(fromTool) + '</span>' +
        '<span class="handoff-actions">' +
        '<button type="button" class="btn btn-small" data-act="use">use it</button> ' +
        '<button type="button" class="btn btn-small btn-secondary" data-act="skip">start fresh</button>' +
        '</span>';
      chip.querySelector('strong').textContent = payload.name;
      chip.querySelector('.handoff-size').textContent = '(' + CV.fmtBytes(payload.blob.size) + ')';

      dropzone.parentNode.insertBefore(chip, dropzone);

      chip.addEventListener('click', function (e) {
        var act = e.target.getAttribute('data-act');
        if (!act) return;
        if (act === 'use') {
          var file = new File([payload.blob], payload.name, { type: payload.blob.type || 'application/octet-stream' });
          var ok = injectFile(file);
          track('chain_continue', { from_tool: payload.from, to_tool: currentTool(), accepted: ok });
        } else {
          track('chain_continue', { from_tool: payload.from, to_tool: currentTool(), accepted: false });
        }
        chip.remove();
      });
    }).catch(function () { /* handoff is a nicety; never block the page */ });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* ------------------------------------------------- post-conversion panel */

  var objectUrls = [];
  global.addEventListener('pagehide', function () {
    objectUrls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
  });

  // Most pages end .tool-app with #resultList, but the waveform tools
  // (audio-cutter, audio-joiner, ringtone-maker) have their own layout and no
  // result list. Anchor to whatever that page does have, so the panel appears
  // everywhere rather than silently skipping three tools.
  function panelHost() {
    return document.getElementById('resultList')
      || document.getElementById('adSlotPost')
      || document.getElementById('progressWrap')
      || document.getElementById('status');
  }

  function nextStepsPanel(output) {
    var slug = currentTool();
    var host = panelHost();
    if (!host || !host.parentNode) return;

    var existing = document.getElementById('nextSteps');
    if (existing) existing.remove();

    var sec = document.createElement('section');
    sec.className = 'next-steps';
    sec.id = 'nextSteps';

    // Preview, so the file can be checked before anyone leaves the page.
    if (output && output.blob && CV.isAudio(output.name)) {
      var url = URL.createObjectURL(output.blob);
      objectUrls.push(url);
      var player = document.createElement('audio');
      player.controls = true;
      player.preload = 'metadata';
      player.src = url;
      player.className = 'next-steps-preview';
      player.addEventListener('play', function () {
        track('preview_play', { tool: slug, target_format: extOf(output.name) });
      }, { once: true });
      sec.appendChild(player);
    }

    var picks = suggestionsFor(slug, output && output.name);
    if (picks.length) {
      var label = document.createElement('p');
      label.className = 'next-steps-label';
      label.textContent = 'Next:';
      sec.appendChild(label);

      var row = document.createElement('div');
      row.className = 'next-steps-row';
      picks.forEach(function (p) {
        var a = document.createElement('a');
        a.className = 'next-chip';
        a.href = p.href;
        a.innerHTML = '<span class="next-chip-label"></span><span class="next-chip-why"></span>';
        a.querySelector('.next-chip-label').textContent = p.label;
        a.querySelector('.next-chip-why').textContent = p.why;
        a.addEventListener('click', function (e) {
          track('next_step_click', { tool: slug, to_tool: p.slug, placement: 'post_convert' });
          // Carry the file across so the next tool does not need a re-drop.
          if (output && output.blob && global.indexedDB) {
            e.preventDefault();
            putHandoff({ name: output.name, blob: output.blob, from: slug })
              .catch(function () {})
              .then(function () { global.location.href = p.href + '?from=' + encodeURIComponent(slug); });
          }
        });
        row.appendChild(a);
      });
      sec.appendChild(row);
    }

    host.parentNode.insertBefore(sec, host.nextSibling);

    // The ad slot sat in the highest-value post-conversion spot; put the useful
    // thing there instead and move the (currently empty) slot below it.
    var ad = document.getElementById('adSlotPost');
    if (ad && ad.parentNode) ad.parentNode.insertBefore(ad, sec.nextSibling);
  }

  function errorPanel(rawMessage) {
    var slug = currentTool();
    var host = document.getElementById('status');
    if (!host) return;

    var existing = document.getElementById('errorHelp');
    if (existing) existing.remove();

    var kind = classifyError(rawMessage);
    var box = document.createElement('div');
    box.className = 'error-recovery';
    box.id = 'errorHelp';

    if (kind.message) {
      var p = document.createElement('p');
      p.textContent = kind.message;
      box.appendChild(p);
    }

    var row = document.createElement('div');
    row.className = 'next-steps-row';
    if (kind.action) {
      var a = document.createElement('a');
      a.className = 'next-chip';
      a.href = kind.action.href;
      a.textContent = kind.action.label;
      a.addEventListener('click', function () {
        track('next_step_click', { tool: slug, to_tool: kind.action.href.replace('/', ''), placement: 'error' });
      });
      row.appendChild(a);
    }
    related(slug, 2).forEach(function (p) {
      var a = document.createElement('a');
      a.className = 'next-chip';
      a.href = p.href;
      a.textContent = p.label;
      a.addEventListener('click', function () {
        track('next_step_click', { tool: slug, to_tool: p.slug, placement: 'error' });
      });
      row.appendChild(a);
    });
    box.appendChild(row);
    host.parentNode.insertBefore(box, host.nextSibling);
  }

  /* --------------------------------------------------- instrument common.js */

  var seenOutputs = typeof WeakSet === 'function' ? new WeakSet() : null;
  var convertStartedAt = 0;

  var _downloadBlob = CV.downloadBlob;
  CV.downloadBlob = function (blob, filename) {
    _downloadBlob(blob, filename);
    // The per-result "download again" buttons reuse the same blob; only the
    // first sighting is a conversion.
    if (seenOutputs) {
      if (seenOutputs.has(blob)) {
        track('download_again', { tool: currentTool() });
        return;
      }
      seenOutputs.add(blob);
    }
    var slug = currentTool();
    track('convert_success', {
      tool: slug,
      target_format: extOf(filename),
      out_mb: mbBucket(blob.size),
      duration_ms: convertStartedAt ? Date.now() - convertStartedAt : undefined
    });
    convertStartedAt = 0;
    try { nextStepsPanel({ name: filename, blob: blob }); } catch (e) { /* never break the download */ }
  };

  var _setStatus = CV.setStatus;
  CV.setStatus = function (el, kind, msg) {
    _setStatus(el, kind, msg);
    if (kind === 'error') {
      var k = classifyError(msg);
      track('convert_error', { tool: currentTool(), error_type: k.id });
      try { errorPanel(msg); } catch (e) {}
    }
  };

  var _bindDropzone = CV.bindDropzone;
  CV.bindDropzone = function (dropzoneEl, fileInputEl, onFiles, accept) {
    var seenDrop = false;
    dropzoneEl.addEventListener('drop', function () { seenDrop = true; }, true);
    _bindDropzone(dropzoneEl, fileInputEl, function (files) {
      if (files && files.length) {
        track('file_selected', {
          tool: currentTool(),
          file_ext: extOf(files[0].name),
          file_mb: mbBucket(files[0].size),
          file_count: files.length,
          pick_method: seenDrop ? 'drop' : 'browse'
        });
        seenDrop = false;
        var old = document.getElementById('nextSteps');
        if (old) old.remove();
        var oldErr = document.getElementById('errorHelp');
        if (oldErr) oldErr.remove();
      }
      onFiles(files);
    }, accept);
  };

  /* ------------------------------------------------------------------ init */

  function init() {
    // The action button is #convertBtn on most pages, but the waveform tools
    // name theirs after the verb.
    ['convertBtn', 'cutBtn', 'joinBtn'].forEach(function (id) {
      var btn = document.getElementById(id);
      if (!btn) return;
      btn.addEventListener('click', function () {
        convertStartedAt = Date.now();
        var bitrate = document.getElementById('bitrate');
        track('convert_start', {
          tool: currentTool(),
          bitrate: bitrate ? bitrate.value : undefined
        });
      });
    });

    // Related-tools and footer-directory clicks, so we can tell which surface
    // actually moves people between tools.
    document.addEventListener('click', function (e) {
      var a = e.target.closest ? e.target.closest('a[href^="/"]') : null;
      if (!a) return;
      var placement = a.closest('.related-tools') ? 'related'
        : a.closest('.footer-directory') ? 'footer_dir'
        : a.closest('.card-grid') && currentTool() === 'index' ? 'home_grid'
        : null;
      if (placement) {
        track('next_step_click', {
          tool: currentTool(),
          to_tool: a.getAttribute('href').replace(/^\//, '') || 'index',
          placement: placement
        });
      }
    });

    offerHandoff();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  /* --------------------------------------------------------------- exports */

  CV.track = track;
  CV.flow = {
    tool: currentTool,
    related: related,
    offerHandoff: offerHandoff,
    done: function (o) { nextStepsPanel(o && o.outputs ? o.outputs[0] : o); },
    fail: function (o) { errorPanel(o && o.error); }
  };
})(window);
