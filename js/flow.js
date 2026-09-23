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
      // A UI hint, not a failure: "Selection too short", "pick a region first".
      // These used to fire convert_error and open a "tell us about this file"
      // panel under a message that only meant "drag the handle further".
      id: 'validation',
      test: /too short|too long|select a region|pick a region|choose at least|at least two|nothing to/i,
      silent: true,
      message: null,
      action: null
    },
    {
      id: 'wrong_type',
      test: /wrong file type/i,
      message: null,
      action: { href: '/', label: 'Use the universal converter' }
    },
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
    // 404 and offline pages would otherwise report whatever URL a bot probed as
    // the tool name, which is unbounded cardinality in GA4.
    if (global.AS_PAGE) return global.AS_PAGE;
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
  // Read without consuming. Deleting on read meant a reload after landing lost
  // the carried file for good, and the chip never came back.
  function peekHandoff() { return withStore('readonly', function (s) { return s.get('pending'); }); }
  function dropHandoff() { return withStore('readwrite', function (s) { return s.delete('pending'); }); }

  function canInjectFiles() {
    try { return typeof DataTransfer === 'function' && 'files' in HTMLInputElement.prototype; }
    catch (e) { return false; }
  }

  // Drive the page's own intake path rather than reimplementing it: every tool
  // binds fileInput's change event through CV.bindDropzone, so setting .files
  // and dispatching change works everywhere, bespoke pages included.
  //
  // `via` says who carried it ('handoff' or 'project'), for file_selected's
  // pick_method: without it every injected file was reported as a browse.
  var injectedVia = null;
  function injectFile(file, via) {
    var input = document.getElementById('fileInput');
    if (!input || !canInjectFiles()) return false;
    injectedVia = via || 'handoff';
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
    // A visit from the audio editor is project-link.js's to handle. A leftover
    // pending file from some earlier chain must not compete with it.
    if (!from || from === 'project') return;

    peekHandoff().then(function (payload) {
      if (!payload || !payload.blob) return;

      // Do not offer a file this tool is going to turn away. Most "next" edges
      // are a good link with the wrong file behind them — /mp4-to-mp3 suggests
      // /mov-to-mp3 as "same job for a .mov", which is sound advice you follow
      // with a different file, not with the MP3 you just made. Carrying the
      // output there regardless produced the worst sequence on the site: a
      // success, a suggestion, a chip saying "continue with tone.mp3", and then
      // "Wrong file type: .mp3" from the tool that had just invited you in.
      //
      // Checked here rather than where the chip is created because this is the
      // only side that knows the answer: the accept list belongs to the landing
      // page. The pending record is deliberately left in place — a tool further
      // along the chain may well accept it.
      if (pageAccept && pageAccept.indexOf(extOf(payload.name)) === -1) return;

      var fromTool = payload.from === 'share'
        ? 'your share sheet'
        : ((G.TOOLS[payload.from] || {}).title || payload.from);

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
        // Only "use it" is a chain continuation. "start fresh" used to fire
        // chain_continue too, with accepted:false — which was harmless while
        // nothing read the event, and stopped being harmless the moment it was
        // starred as a GA4 key event: every decline was being counted as a
        // conversion, and `accepted` is not a registered custom dimension, so
        // the two could not be told apart in any report.
        //
        // The event is named for what it measures. A decline is not a chain
        // continuing, so it does not fire one. `accepted` stays on the accept
        // branch because injectFile can still genuinely fail, and that is worth
        // seeing — it just no longer doubles as "the user said no".
        if (act === 'use') {
          var file = new File([payload.blob], payload.name, { type: payload.blob.type || 'application/octet-stream' });
          var ok = injectFile(file, 'handoff');
          track('chain_continue', { from_tool: payload.from, to_tool: currentTool(), accepted: ok });
        }
        dropHandoff().catch(function () {});
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
  function releaseUrls() {
    objectUrls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
    objectUrls = [];
  }
  global.addEventListener('pagehide', releaseUrls);

  // Most pages end .tool-app with #resultList, but the waveform tools
  // (audio-cutter, audio-joiner, ringtone-maker) have their own layout and no
  // result list. Anchor to whatever that page does have, so the panel appears
  // everywhere rather than silently skipping three tools.
  function panelHost() {
    return document.getElementById('resultList')
      || document.getElementById('progressWrap')
      || document.getElementById('status');
  }

  function nextStepsPanel(output) {
    var slug = currentTool();
    var host = panelHost();
    if (!host || !host.parentNode) return;

    var existing = document.getElementById('nextSteps');
    if (existing) existing.remove();
    releaseUrls();

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

    // Let pwa.js decide whether this is a moment to offer the install, and
    // project-link.js offer to send the result back to the editor. The panel
    // is passed so a listener can add to it without flow.js knowing about it.
    try {
      document.dispatchEvent(new CustomEvent('as:converted', {
        detail: { tool: slug, name: output && output.name, blob: output && output.blob, panel: sec }
      }));
    } catch (e) {}
  }

  function errorPanel(rawMessage) {
    var slug = currentTool();
    var host = document.getElementById('status');
    if (!host) return;

    var existing = document.getElementById('errorHelp');
    if (existing) existing.remove();

    var kind = classifyError(rawMessage);
    if (kind.silent) return;

    // wrong_type used to offer "/" — the homepage — which asks somebody whose
    // file has just been refused to go and find the right tool themselves. We
    // already know the extension they dropped, so name the page that takes it.
    //
    // Worth doing because of where the traffic comes from: two thirds of
    // sessions arrive from an AI assistant, straight onto whichever tool page
    // the assistant picked. When that pick is wrong for the file in hand, this
    // panel is the only thing standing between the visitor and leaving.
    var action = kind.action;
    if (kind.id === 'wrong_type' && G.toolForExt) {
      var alt = G.toolForExt(lastRejectedExt);
      if (alt && alt !== slug && G.TOOLS[alt]) {
        action = { href: '/' + alt, label: G.TOOLS[alt].title };
      }
    }
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
    if (action) {
      var a = document.createElement('a');
      a.className = 'next-chip';
      a.href = action.href;
      a.textContent = action.label;
      a.addEventListener('click', function () {
        track('next_step_click', { tool: slug, to_tool: action.href.replace('/', '') || 'index', placement: 'error' });
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

  // The extension of the file that was last turned away. Set by the dropzone
  // wrapper below and read by errorPanel, which otherwise only sees the message
  // string and has to re-parse it to learn anything.
  var lastRejectedExt = null;

  var _downloadBlob = CV.downloadBlob;
  CV.downloadBlob = function (blob, filename, opts) {
    _downloadBlob(blob, filename);
    // The per-result buttons re-download an output that has already been
    // counted. In a batch they hand back the individual file rather than the
    // zip we tracked, so the blob identity check alone missed them and every
    // click was counted as another conversion.
    if (opts && opts.again) {
      track('download_again', { tool: currentTool() });
      return;
    }
    if (seenOutputs) {
      if (seenOutputs.has(blob)) {
        track('download_again', { tool: currentTool() });
        return;
      }
      seenOutputs.add(blob);
    }
    var slug = currentTool();
    pushRecent(slug);
    bumpSuccessCount();
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
      // A validation hint is not a conversion failure; counting it as one
      // buried the real error rate.
      if (!k.silent) track('convert_error', { tool: currentTool(), error_type: k.id });
      try { errorPanel(msg); } catch (e) {}
    }
  };

  // Long conversions run in a background tab. The stem splitter already put its
  // progress in the tab title; do it for every tool from one place.
  var baseTitle = null;
  var _setProgress = CV.setProgress;
  CV.setProgress = function (barEl, pct) {
    _setProgress(barEl, pct);
    try {
      var v = Math.round(Math.max(0, Math.min(100, pct)));
      if (baseTitle === null) baseTitle = document.title;
      if (v > 0 && v < 100) document.title = v + '% · ' + baseTitle;
      else if (baseTitle) { document.title = baseTitle; baseTitle = null; }
    } catch (e) {}
  };

  var BIG_FILE_BYTES = 500 * 1024 * 1024;

  function describeAccept(accept) {
    if (!accept || !accept.length) return '';
    return accept.map(function (e) { return e.replace(/^\./, '').toUpperCase(); }).join(', ');
  }

  // What this page will actually take. Captured here because the accept list
  // lives in each page's own config (AS_TOOL, or the argument a bespoke tool
  // passes) and never reached the graph — so the only place that reliably knows
  // it is the page itself, at the moment it binds.
  var pageAccept = null;

  var _bindDropzone = CV.bindDropzone;
  CV.bindDropzone = function (dropzoneEl, fileInputEl, onFiles, accept, onRejected) {
    if (accept && accept.length) {
      pageAccept = accept.map(function (e) {
        return String(e).replace(/^\./, '').toLowerCase();
      });
    }
    var seenDrop = false;
    dropzoneEl.addEventListener('drop', function () { seenDrop = true; }, true);

    // Rejected files used to vanish: onFiles([]) and every consumer returned
    // early, so dropping a .txt on a converter did nothing at all — no message,
    // no event, no way to know the site had seen the file.
    function rejected(files, acc) {
      lastRejectedExt = files && files[0] ? extOf(files[0].name) : null;
      if (onRejected) return onRejected(files, acc);
      var statusEl = document.getElementById('status');
      if (!statusEl) return;
      var want = describeAccept(acc);
      CV.setStatus(statusEl, 'error',
        'Wrong file type: .' + extOf(files[0].name) +
        (want ? ' — this tool takes ' + want + '.' : '.'));
    }

    _bindDropzone(dropzoneEl, fileInputEl, function (files) {
      if (files && files.length) {
        track('file_selected', {
          tool: currentTool(),
          file_ext: extOf(files[0].name),
          file_mb: mbBucket(files[0].size),
          file_count: files.length,
          pick_method: injectedVia || (seenDrop ? 'drop' : 'browse')
        });
        seenDrop = false;
        injectedVia = null;
        var old = document.getElementById('nextSteps');
        if (old) old.remove();
        var oldErr = document.getElementById('errorHelp');
        if (oldErr) oldErr.remove();

        // Warn before the wait, not after it. The memory ceiling was only ever
        // discovered by spending five minutes and getting a RangeError.
        var big = files.filter(function (f) { return f.size >= BIG_FILE_BYTES; })[0];
        var statusEl = document.getElementById('status');
        if (big && statusEl) {
          CV.setStatus(statusEl, 'warn', 'That file is ' + CV.fmtBytes(big.size) +
            '. Browsers usually run out of memory somewhere past 500 MB — it may fail. ' +
            'Cutting it into pieces first is more reliable.');
        }
      }
      onFiles(files);
    }, accept, rejected);
  };

  /* --------------------------------------------------------------- recents */

  var RECENT_KEY = 'as_recent_tools';
  var COUNT_KEY = 'as_success_count';

  function readJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      var v = raw ? JSON.parse(raw) : null;
      return Array.isArray(v) ? v : fallback;
    } catch (e) { return fallback; }
  }

  function pushRecent(slug) {
    if (!slug || slug === 'index' || !G.TOOLS[slug]) return;
    try {
      var list = readJSON(RECENT_KEY, []).filter(function (s) { return s !== slug; });
      list.unshift(slug);
      localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 5)));
    } catch (e) {}
  }

  function bumpSuccessCount() {
    try {
      var n = parseInt(localStorage.getItem(COUNT_KEY), 10) || 0;
      localStorage.setItem(COUNT_KEY, String(n + 1));
    } catch (e) {}
  }

  function renderRecents() {
    var host = document.getElementById('recentTools');
    if (!host) return;
    var list = readJSON(RECENT_KEY, []).filter(function (s) { return G.TOOLS[s]; });
    if (!list.length) return;
    var label = document.createElement('p');
    label.className = 'task-picker-label';
    label.textContent = 'Pick up where you left off';
    var row = document.createElement('div');
    row.className = 'task-picker-row';
    list.forEach(function (slug) {
      var a = document.createElement('a');
      a.href = '/' + slug;
      a.textContent = G.TOOLS[slug].label || G.TOOLS[slug].title || slug;
      row.appendChild(a);
    });
    host.appendChild(label);
    host.appendChild(row);
    host.hidden = false;
  }

  /* ------------------------------------------------------------------ init */

  function init() {
    // The action button is #convertBtn on most pages, but the waveform tools
    // name theirs after the verb.
    var actionBtns = ['convertBtn', 'cutBtn', 'joinBtn'].map(function (id) {
      return document.getElementById(id);
    }).concat(Array.prototype.slice.call(document.querySelectorAll('[data-track="convert"]')));
    actionBtns.forEach(function (btn) {
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
      // #recentTools has to be tested before .task-picker: the recents row is
      // rendered as a .task-picker-row inside it, and reading it as home_jobs
      // would merge a returning visitor's shortcut with a new arrival's.
      var rail = a.closest('.rail-row') ? a.closest('.rail') : null;
      var placement = a.closest('.related-tools') ? 'related'
        : a.closest('.footer-directory') ? 'footer_dir'
        : a.closest('#recentTools') ? 'recent'
        : rail ? 'home_rail'
        : a.closest('.task-picker') && currentTool() === 'index' ? 'home_jobs'
        // Nothing on / matches .card-grid any more — the rails replaced it. Kept
        // because reverting index.html is the rollback, and the control arm of
        // the rails A/B has to keep reporting under its old placement name for
        // the two numbers to be comparable at all.
        : a.closest('.card-grid') && currentTool() === 'index' ? 'home_grid'
        : null;
      if (placement) {
        track('next_step_click', {
          tool: currentTool(),
          to_tool: a.getAttribute('href').replace(/^\//, '') || 'index',
          placement: placement,
          // Which rail earned the click. The point of the rails is that a row
          // nobody scrolls is a row of dead links, and placement alone cannot
          // tell "the convert rail works" from "only its first three chips do".
          rail: rail ? rail.getAttribute('data-rail') : undefined
        });
      }
    });

    offerHandoff();
    renderRecents();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  /* --------------------------------------------------------------- exports */

  CV.track = track;
  CV.flow = {
    tool: currentTool,
    related: related,
    offerHandoff: offerHandoff,
    inject: injectFile,
    accepts: function (ext) {
      return !pageAccept || pageAccept.indexOf(String(ext).replace(/^\./, '').toLowerCase()) !== -1;
    },
    done: function (o) { nextStepsPanel(o && o.outputs ? o.outputs[0] : o); },
    fail: function (o) { errorPanel(o && o.error); }
  };
})(window);
