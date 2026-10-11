/*
 * /audio-plugins: run a file through web plugins (WAM2) from the Web Audio
 * Modules community, the same ones the editor's mixer offers.
 *
 * Up to four plugins in a chain. Each one's own window sits in the page, and
 * a looping preview plays the file through the chain live, so the plugins'
 * controls are set by ear. "Apply" then reads each plugin's settings and
 * builds the chain again in an OfflineAudioContext at the file's own rate
 * (wam-host.js: one host group per context, state applied with setState and
 * waited for), with a quarter-second pre-roll so start-up smoothing never
 * touches the audio, and trims each plugin's measured delay off the front.
 * check-wam.js measured which plugins come out sample-identical to what the
 * preview played; those carry a mark.
 *
 * Same length in as out, so a video comes back as a video (CV.shell's video
 * path) and an editor clip can be sent here and back (project 'same'). The
 * optional tail ("let the reverb ring out") applies only to audio files.
 */
(function () {
  'use strict';
  if (!window.CV) { console.error('[audio-plugins] CV is not defined: the /js includes must come before this script'); return; }

  var $ = CV.$;
  var MAX = 4, PRE = 0.25, TAIL_MAX = 12;
  var C = window.AudioContext || window.webkitAudioContext;
  var Off = window.OfflineAudioContext || window.webkitOfflineAudioContext;

  var list = null;          // the catalogue (effects only)
  var chain = [];           // [{ p: catalogue entry, inst, gui, tab, panel }]
  var ctx = null, input = null, out = null;
  var shown = null;         // the chain entry whose window is showing
  var preview = { src: null, file: null, buf: null };

  var el = {
    search: $('#wamSearch'), list: $('#wamList'), chain: $('#wamChain'), tabs: $('#wamTabs'),
    guis: $('#wamGuis'), preview: $('#previewBtn'), tail: $('#tail'), status: $('#status'), note: $('#wamNote')
  };

  /* ----------------------------------------------------------- catalogue */

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function drawList() {
    if (!el.list) return;
    if (!list) { el.list.innerHTML = '<p class="wam-msg">Loading the plugin list…</p>'; return; }
    var q = (el.search && el.search.value || '').toLowerCase().trim();
    var rows = list.filter(function (w) {
      return !q || (w.name + ' ' + w.vendor + ' ' + w.sub + ' ' + w.description + ' ' + w.keywords.join(' ')).toLowerCase().indexOf(q) !== -1;
    });
    if (!rows.length) { el.list.innerHTML = '<p class="wam-msg">No plugin matches “' + esc(q) + '”.</p>'; return; }
    el.list.innerHTML = rows.map(function (w) {
      var exact = w.status && w.status.live === 'same';
      var on = chain.some(function (c) { return c.p.id === w.id; });
      return '<button type="button" class="wam-item" data-id="' + esc(w.id) + '"' + (chain.length >= MAX && !on ? ' disabled' : '') + '>' +
        (w.thumb ? '<img src="' + esc(w.thumb) + '" alt="" loading="lazy" width="64" height="48">' : '<span class="wam-noimg"></span>') +
        '<span><strong>' + esc(w.name) + '</strong>' + (exact ? ' <i class="wam-exact" title="Measured: the file comes out sample for sample as the preview plays">exact</i>' : '') +
        '<small>' + esc(w.sub) + ' · ' + esc(w.vendor) + '</small>' +
        (w.description ? '<small class="wam-desc">' + esc(w.description) + '</small>' : '') + '</span></button>';
    }).join('');
  }

  function loadList() {
    if (!window.ASWam) { if (el.list) el.list.innerHTML = '<p class="wam-msg">The plugin host did not load. Reload the page.</p>'; return; }
    drawList();
    ASWam.catalog().then(function (all) {
      list = all.filter(function (w) { return w.kind === 'effect'; });
      drawList();
      // ?plugin= takes a catalogue identifier, never an address: a plugin
      // runs as script on this site, so a link must not be able to choose one.
      var want = (/[?&]plugin=([\w.\-]+)/.exec(location.search) || [])[1];
      if (want) { var w = list.filter(function (x) { return x.id === want; })[0]; if (w) add(w); }
    }, function () {
      if (el.list) el.list.innerHTML = '<p class="wam-msg">The plugin list did not load. Check your connection and reload.</p>';
    });
  }

  /* --------------------------------------------------------------- chain */

  function ensureCtx() {
    if (ctx) return ctx;
    ctx = new C({ latencyHint: 'interactive' });
    input = ctx.createGain();
    out = ctx.createGain();
    out.connect(ctx.destination);
    wire();
    return ctx;
  }

  function wire() {
    if (!ctx) return;
    try { input.disconnect(); } catch (e) {}
    chain.forEach(function (c) { if (c.inst) try { c.inst.node.disconnect(); } catch (e) {} });
    var node = input;
    chain.forEach(function (c) { if (c.inst) { node.connect(c.inst.node); node = c.inst.node; } });
    node.connect(out);
  }

  function add(w) {
    if (chain.length >= MAX || chain.some(function (c) { return c.p.id === w.id; })) return;
    ensureCtx();
    var c = { p: w, inst: null, gui: null, failed: null };
    chain.push(c);
    c.panel = document.createElement('div');
    c.panel.className = 'wam-gui';
    c.panel.innerHTML = '<p class="wam-msg">Loading ' + esc(w.name) + '…</p>';
    el.guis.appendChild(c.panel);
    show(c);
    drawChain(); drawList();
    ASWam.load(ctx, w.url, null, w).then(function (inst) {
      if (chain.indexOf(c) < 0) { inst.dispose(); return null; }
      c.inst = inst;
      wire();
      return inst.gui();
    }).then(function (gui) {
      if (!c.inst || chain.indexOf(c) < 0) return;
      c.panel.innerHTML = '';
      if (gui) { c.gui = gui; c.panel.appendChild(gui); }
      else c.panel.innerHTML = '<p class="wam-msg">' + esc(w.name) + ' has no window of its own.</p>';
      drawChain();
      ready();
    }).catch(function (e) {
      c.failed = e;
      c.panel.innerHTML = '<p class="wam-msg">' + esc(w.name) + ' did not load: ' + esc(e && e.message || 'unknown error') + '. Remove it and try another.</p>';
      drawChain();
      ready();
    });
  }

  function remove(c) {
    var i = chain.indexOf(c);
    if (i < 0) return;
    chain.splice(i, 1);
    if (c.inst) { if (c.gui) c.inst.closeGui(c.gui); c.inst.dispose(); }
    if (c.panel.parentNode) c.panel.parentNode.removeChild(c.panel);
    wire();
    if (shown === c) show(chain[Math.max(0, i - 1)] || null);
    drawChain(); drawList(); ready();
  }

  function move(c, d) {
    var i = chain.indexOf(c), j = i + d;
    if (i < 0 || j < 0 || j >= chain.length) return;
    chain.splice(i, 1); chain.splice(j, 0, c);
    wire(); drawChain();
  }

  function show(c) {
    shown = c;
    chain.forEach(function (x) { x.panel.hidden = x !== c; });
    if (el.guis) el.guis.hidden = !c;
    drawChain();
  }

  function drawChain() {
    if (!el.tabs) return;
    if (!chain.length) {
      el.tabs.innerHTML = '<p class="wam-msg">No plugins yet. Pick one from the list: it opens here, and you can add up to ' + MAX + ' in a row.</p>';
      return;
    }
    el.tabs.innerHTML = chain.map(function (c, i) {
      return '<span class="wam-tab' + (c === shown ? ' on' : '') + (c.failed ? ' bad' : '') + '">' +
        '<button type="button" data-a="show" data-i="' + i + '" aria-pressed="' + (c === shown) + '"><b>' + (i + 1) + '</b> ' + esc(c.p.name) + (c.inst || c.failed ? '' : ' …') + '</button>' +
        '<button type="button" data-a="left" data-i="' + i + '" aria-label="Earlier in the chain"' + (i === 0 ? ' disabled' : '') + '>‹</button>' +
        '<button type="button" data-a="right" data-i="' + i + '" aria-label="Later in the chain"' + (i === chain.length - 1 ? ' disabled' : '') + '>›</button>' +
        '<button type="button" data-a="remove" data-i="' + i + '" aria-label="Remove ' + esc(c.p.name) + '">✕</button></span>';
    }).join('<span class="wam-arrow" aria-hidden="true">→</span>');
  }

  // The action button needs a file and a chain of loaded plugins.
  function ready() {
    var btn = $('#convertBtn');
    var ok = chain.length && chain.every(function (c) { return c.inst; });
    if (el.note) {
      el.note.textContent = !chain.length ? 'Add at least one plugin.' : chain.some(function (c) { return c.failed; }) ? 'Remove the plugin that did not load.' :
        ok ? '' : 'Waiting for the plugins to load…';
    }
    if (btn) btn.dataset.wamReady = ok ? '1' : '';
    if (btn && shell && shell.files().length) btn.disabled = !ok;
  }

  /* ------------------------------------------------------------- preview */

  function stopPreview() {
    if (preview.src) { try { preview.src.stop(); } catch (e) {} preview.src = null; }
    if (el.preview) el.preview.textContent = '▶ Preview through the chain';
  }

  function startPreview() {
    var files = shell && shell.files();
    if (!files || !files.length) return;
    ensureCtx();
    if (ctx.state === 'suspended') ctx.resume();
    el.preview.disabled = true;
    el.preview.textContent = 'Decoding…';
    var get = preview.file === files[0] ? Promise.resolve(preview.buf)
      : AudioSaw.decodeToAudioBuffer(files[0], null, { quiet: true }).then(function (b) { preview.file = files[0]; preview.buf = b; return b; });
    get.then(function (b) {
      var src = ctx.createBufferSource();
      src.buffer = b;
      src.loop = true;
      src.connect(input);
      src.start();
      preview.src = src;
      el.preview.textContent = '■ Stop the preview';
    }).catch(function (e) {
      stopPreview();
      CV.setStatus(el.status, 'error', 'The preview could not play this file. ' + (e && e.message || ''), e);
    }).then(function () { el.preview.disabled = false; });
  }

  /* -------------------------------------------------------------- render */

  // The chain again, offline, from the settings the plugins hold now.
  function render(buf, states, opts, onProgress) {
    var sr = buf.sampleRate, n = buf.length;
    var delay = chain.reduce(function (a, c) { return a + (c.p.status && c.p.status.delay > 0 ? c.p.status.delay : 0); }, 0);
    var tail = opts.tail ? TAIL_MAX : 0;
    var pre = Math.round(PRE * sr);
    var len = pre + delay + n + Math.round(tail * sr) + 128;
    var off = new Off(2, len, sr);
    var made = [];
    return Promise.all(chain.map(function (c, i) {
      return ASWam.load(off, c.p.url, states[i], c.p).then(function (inst) { made[i] = inst; return inst; });
    })).then(function () {
      onProgress(30, 'Rendering…');
      var src = off.createBufferSource();
      src.buffer = buf;
      var node = src;
      made.forEach(function (inst) { node.connect(inst.node); node = inst.node; });
      node.connect(off.destination);
      src.start(pre / sr);
      return off.startRendering();
    }).then(function (r) {
      made.forEach(function (inst) { inst.dispose(); });
      var from = pre + delay, keep = n;
      if (tail) {
        // Where the effects have died away below -90 dBFS.
        var floor = Math.pow(10, -90 / 20), last = n;
        for (var ch = 0; ch < 2; ch++) {
          var d = r.getChannelData(ch);
          for (var i = r.length - 1; i >= from + n; i--) if (d[i] > floor || d[i] < -floor) { last = Math.max(last, i - from + 1); break; }
        }
        keep = Math.min(last, r.length - from);
      }
      var L = r.getChannelData(0).slice(from, from + keep), R = r.getChannelData(1).slice(from, from + keep);
      // A mono file stays mono unless a plugin made it stereo.
      var mono = buf.numberOfChannels === 1;
      for (var k = 0; mono && k < L.length; k++) if (Math.abs(L[k] - R[k]) > 1e-7) mono = false;
      return AudioSaw.makeBuffer(mono ? [L] : [L, R], sr);
    }, function (e) { made.forEach(function (inst) { if (inst) inst.dispose(); }); throw e; });
  }

  function process(file, opts, onProgress) {
    // Worded to land in flow.js's silent 'validation' kind: these are hints.
    if (!chain.length) return Promise.reject(new Error('Choose at least one plugin first.'));
    if (chain.some(function (c) { return !c.inst; })) return Promise.reject(new Error('Nothing to apply yet: a plugin is still loading or did not load.'));
    onProgress(3, 'Reading the plugin settings…');
    var states;
    return Promise.all(chain.map(function (c) { return c.inst.getState(); })).then(function (s) {
      states = s;
      onProgress(8, 'Decoding…');
      return AudioSaw.decodeToAudioBuffer(file);
    }).then(function (buf) {
      return render(buf, states, { tail: opts.tail && !opts.video }, onProgress);
    }).then(function (rendered) {
      var chans = CV.channelsOf(rendered);
      // A distortion or a resonant filter can pass full scale: limit to
      // -1 dBTP rather than let the encoder clip it.
      if (window.ASLoudness && ASLoudness.truePeak(chans) > 1) ASLoudness.limit(chans, rendered.sampleRate, Math.pow(10, -1 / 20));
      onProgress(70, 'Encoding…');
      return CV.encodeBuffer(rendered, opts.fmt, opts.bitrate, function (pct) { onProgress(70 + pct * 0.3); });
    }).then(function (blob) {
      return { name: AudioSaw.rename(file.name, opts.fmt).replace(/\.([^.]+)$/, '-fx.$1'), blob: blob };
    });
  }

  var shell = CV.shell({
    accept: null,
    video: true,
    zipName: 'audiosaw-plugins.zip',
    failMessage: 'The plugins could not process that file. ',
    readOpts: function () {
      return {
        tail: !!(el.tail && el.tail.checked),
        fmt: ($('#outFmt').value || 'mp3').toLowerCase(),
        bitrate: $('#bitrate').value
      };
    },
    onFiles: function () { stopPreview(); preview.file = null; setTimeout(ready, 0); },
    onReset: function () { stopPreview(); preview.file = null; preview.buf = null; },
    process: process
  });

  /* -------------------------------------------------------------- events */

  if (el.list) el.list.addEventListener('click', function (e) {
    var b = e.target.closest('[data-id]');
    if (!b || !list) return;
    var w = list.filter(function (x) { return x.id === b.getAttribute('data-id'); })[0];
    var on = chain.filter(function (c) { return c.p.id === w.id; })[0];
    if (on) show(on); else if (w) add(w);
  });
  if (el.search) el.search.addEventListener('input', drawList);
  if (el.tabs) el.tabs.addEventListener('click', function (e) {
    var b = e.target.closest('[data-a]');
    if (!b) return;
    var c = chain[+b.getAttribute('data-i')];
    if (!c) return;
    var a = b.getAttribute('data-a');
    if (a === 'show') show(c);
    else if (a === 'remove') remove(c);
    else if (a === 'left') move(c, -1);
    else if (a === 'right') move(c, 1);
  });
  if (el.preview) el.preview.addEventListener('click', function () { if (preview.src) stopPreview(); else startPreview(); });
  // Keys typed into a plugin's window are the plugin's.
  if (el.guis) el.guis.addEventListener('keydown', function (e) { e.stopPropagation(); });

  // For tools/check-wam.js, which sets a plugin's parameter and compares
  // the download with its own render.
  window.ASPluginsPage = { chain: function () { return chain.slice(); } };

  drawChain();
  loadList();
  ready();
})();
