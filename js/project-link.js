/*
 * The link between the audio editor and the rest of the site: a project that
 * follows you onto a tool page and takes the tool's result back.
 *
 * The editor sends a clip out as a "target" (a WAV plus enough to find the
 * clip again). A tool page that knows how to work on project audio shows a
 * bar offering it; after the tool runs, the bar offers to send the result
 * back as a "return", and the editor applies it as one undoable edit.
 *
 * Its own database, `audiosaw-link`, for the same reason editor-store.js has
 * its own: `audiosaw` is shared with sw.js and its version cannot move. And
 * tool pages never open `audiosaw-editor`. If one did before the editor ever
 * had, it would create that database empty at version 1 and the editor's
 * upgrade handler would never run. So there are exactly two records here, and
 * one writer each:
 *
 *   'target'  written by the editor   {id, projectId, projectName, kind, ref, fp,
 *                                       tool, name, blob, duration, channels,
 *                                       sampleRate, peaks, createdAt}
 *   'return'  written by a tool page  {id, targetId, projectId, tool, name, blob,
 *                                       createdAt}
 *
 * A localStorage flag, `as_project`, says whether a target exists at all, so a
 * tool page with nothing to offer never touches IndexedDB.
 *
 * Loaded after flow.js: the bar feeds the file through CV.flow.inject, the same
 * path the tool-to-tool handoff uses, and hangs its "send back" chip on the
 * panel flow.js builds after every conversion.
 */
(function (global) {
  'use strict';

  var CV = global.CV, G = global.AS_GRAPH;
  if (!CV || !CV.flow || !G) {
    console.error('[project-link] common.js, tool-graph.js and flow.js must load before project-link.js.');
    return;
  }

  var DB = 'audiosaw-link', STORE = 'records', FLAG = 'as_project';
  var MAX_AGE = 7 * 24 * 3600 * 1000;

  /* ------------------------------------------------------------- storage */

  function withStore(mode, fn) {
    return new Promise(function (resolve, reject) {
      if (!global.indexedDB) return reject(new Error('No IndexedDB'));
      var req = global.indexedDB.open(DB, 1);
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
        tx.onabort = function () { db.close(); reject(tx.error || new Error('aborted')); };
      };
    });
  }

  function get(key) { return withStore('readonly', function (s) { return s.get(key); }); }
  function put(key, v) { return withStore('readwrite', function (s) { s.put(v, key); }); }
  function del(key) { return withStore('readwrite', function (s) { s.delete(key); }); }
  // Read and delete in one transaction, so two editor tabs can never both
  // apply the same result.
  function take(key) {
    var got = null;
    return withStore('readwrite', function (s) {
      var r = s.get(key);
      r.onsuccess = function () { got = r.result || null; if (got) s.delete(key); };
    }).then(function () { return got; });
  }

  function flag() {
    try { return JSON.parse(global.localStorage.getItem(FLAG) || 'null'); } catch (e) { return null; }
  }
  function setFlag(o) {
    try {
      var cur = flag() || {};
      Object.keys(o).forEach(function (k) { cur[k] = o[k]; });
      global.localStorage.setItem(FLAG, JSON.stringify(cur));
    } catch (e) {}
  }

  function uid(prefix) {
    return prefix + Date.now().toString(36) + Math.floor(Math.random() * 46656).toString(36);
  }

  // Ask the browser not to evict what we store. Chrome and Safari answer
  // silently; Firefox may ask, which is fine inside a deliberate "send".
  function persist() {
    try {
      if (global.navigator.storage && global.navigator.storage.persist) return global.navigator.storage.persist().catch(function () { return false; });
    } catch (e) {}
    return Promise.resolve(false);
  }

  /* ------------------------------------------------------------- channel */

  // Only for routing: is an editor with this project open in another tab? A
  // missing BroadcastChannel just means the answer is always "no".
  var chan = null;
  function channel() {
    if (!chan && typeof global.BroadcastChannel === 'function') chan = new global.BroadcastChannel('audiosaw-link');
    return chan;
  }
  function editorAlive(projectId, ms) {
    var ch = channel();
    if (!ch) return Promise.resolve(false);
    return new Promise(function (resolve) {
      var done = false;
      function on(e) {
        var d = e.data || {};
        if (d.t === 'pong' && d.projectId === projectId && !done) { done = true; ch.removeEventListener('message', on); resolve(true); }
      }
      ch.addEventListener('message', on);
      ch.postMessage({ t: 'ping' });
      setTimeout(function () { if (!done) { done = true; ch.removeEventListener('message', on); resolve(false); } }, ms || 300);
    });
  }

  /* --------------------------------------------------------------- peaks */

  // Min/max pairs as signed bytes: 480 bytes draw a waveform without decoding.
  function peaksOf(buf, bins) {
    bins = bins || 240;
    var out = new Int8Array(bins * 2), n = buf.length, nch = buf.numberOfChannels;
    var chans = [];
    for (var c = 0; c < nch; c++) chans.push(buf.getChannelData(c));
    for (var b = 0; b < bins; b++) {
      var a = Math.floor(b * n / bins), e = Math.max(a + 1, Math.floor((b + 1) * n / bins));
      var lo = 0, hi = 0;
      for (var ch = 0; ch < nch; ch++) {
        var d = chans[ch];
        for (var i = a; i < e && i < n; i++) { var v = d[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      }
      out[b * 2] = Math.max(-127, Math.round(lo * 127));
      out[b * 2 + 1] = Math.min(127, Math.round(hi * 127));
    }
    return out;
  }

  function drawPeaks(canvas, peaks) {
    if (!canvas || !peaks || !canvas.getContext) return;
    var dpr = global.devicePixelRatio || 1;
    var w = canvas.clientWidth || 300, h = canvas.clientHeight || 40;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    var g = canvas.getContext('2d');
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    g.fillStyle = global.getComputedStyle(canvas).color || '#888';
    var bins = peaks.length / 2, mid = h / 2, bw = w / bins;
    for (var b = 0; b < bins; b++) {
      var lo = peaks[b * 2] / 127, hi = peaks[b * 2 + 1] / 127;
      var y0 = mid - hi * mid, y1 = mid - lo * mid;
      g.fillRect(b * bw, y0, Math.max(1, bw - 0.5), Math.max(1, y1 - y0));
    }
  }

  function fmtTime(t) {
    t = Math.max(0, t || 0);
    var m = Math.floor(t / 60), s = Math.round(t - m * 60);
    if (s === 60) { m++; s = 0; }
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  var api = {
    getTarget: function () { return get('target'); },
    putTarget: function (rec) { return put('target', rec); },
    dropTarget: function () { return del('target'); },
    peekReturn: function () { return get('return'); },
    putReturn: function (rec) { return put('return', rec); },
    takeReturn: function () { return take('return'); },
    dropReturn: function () { return del('return'); },
    // Anything older than a week is a session nobody is coming back to.
    purge: function () {
      var cut = Date.now() - MAX_AGE;
      return withStore('readwrite', function (s) {
        ['target', 'return'].forEach(function (k) {
          var r = s.get(k);
          r.onsuccess = function () { if (r.result && r.result.createdAt < cut) s.delete(k); };
        });
      }).catch(function () {});
    },
    flag: flag, setFlag: setFlag, uid: uid, persist: persist,
    channel: channel, editorAlive: editorAlive,
    peaksOf: peaksOf, drawPeaks: drawPeaks, fmtTime: fmtTime
  };
  global.ASLink = api;

  /* ------------------------------------------------------- the tool bar */

  function currentTool() { return CV.flow.tool(); }

  function initBar() {
    var slug = currentTool();
    var info = G.TOOLS[slug];
    if (slug === 'audio-editor' || !info || !info.project) return;
    var dropzone = document.getElementById('dropzone');
    var f = flag();
    if (!dropzone || !f || !f.target) return;

    api.getTarget().then(function (target) {
      if (!target || !target.blob || target.id !== f.target) return;
      if (Date.now() - target.createdAt > MAX_AGE) return;
      render(slug, info, dropzone, target);
    }).catch(function () { /* the bar is an extra; never block the tool */ });
  }

  function render(slug, info, dropzone, target) {
    var fromEditor = new URLSearchParams(global.location.search).get('from') === 'project';
    var usedKey = 'as_link_used';
    var used = null;
    try { used = global.sessionStorage.getItem(usedKey) === target.id ? target.id : null; } catch (e) {}
    var injecting = false;

    var bar = document.createElement('section');
    bar.className = 'project-bar';
    bar.id = 'projectBar';
    bar.setAttribute('aria-label', 'Audio from your editor project');
    bar.innerHTML =
      '<div class="project-bar-text">' +
        '<span class="project-bar-kicker">From your project <strong></strong></span>' +
        '<span class="project-bar-meta"></span>' +
      '</div>' +
      '<canvas class="project-bar-wave" aria-hidden="true"></canvas>' +
      '<div class="project-bar-actions">' +
        '<button type="button" class="btn btn-small" data-act="use">Use project audio</button> ' +
        '<a class="btn btn-small btn-secondary" href="/audio-editor?resume=1" data-act="back">Back to the editor</a>' +
        '<button type="button" class="project-bar-close" data-act="close" aria-label="Hide this bar">×</button>' +
      '</div>';
    bar.querySelector('strong').textContent = '“' + (target.projectName || 'Untitled') + '”';
    bar.querySelector('.project-bar-meta').textContent =
      'Clip · ' + target.name.replace(/\.wav$/i, '') + ' · ' + fmtTime(target.duration);
    dropzone.parentNode.insertBefore(bar, dropzone);
    var wave = bar.querySelector('.project-bar-wave');
    drawPeaks(wave, target.peaks);
    if (global.ResizeObserver) new ResizeObserver(function () { drawPeaks(wave, target.peaks); }).observe(wave);

    var useBtn = bar.querySelector('[data-act="use"]');
    if (!CV.flow.accepts('wav')) {
      useBtn.disabled = true;
      useBtn.textContent = 'This tool does not take WAV';
    }

    function markUsed(on) {
      used = on ? target.id : null;
      try { if (on) global.sessionStorage.setItem(usedKey, target.id); else global.sessionStorage.removeItem(usedKey); } catch (e) {}
      bar.classList.toggle('is-used', !!on);
      if (on) useBtn.textContent = 'Loaded: run the tool, then send it back';
      else if (!useBtn.disabled) useBtn.textContent = 'Use project audio';
    }
    if (used) markUsed(true);

    // Whichever file the tool is working on decides whether its result belongs
    // to the project: pick or drop something else and the offer goes away.
    var input = document.getElementById('fileInput');
    if (input) input.addEventListener('change', function () { if (!injecting) markUsed(false); }, true);
    dropzone.addEventListener('drop', function () { markUsed(false); }, true);

    bar.addEventListener('click', function (e) {
      var act = e.target.getAttribute && e.target.getAttribute('data-act');
      if (act === 'close') { bar.remove(); return; }
      if (act !== 'use' || used) return;
      var file = new File([target.blob], target.name, { type: 'audio/wav' });
      injecting = true;
      var ok = CV.flow.inject(file, 'project');
      injecting = false;
      CV.track('chain_continue', { from_tool: 'audio-editor', to_tool: slug, placement: 'project', accepted: ok });
      if (ok) markUsed(true);
    });

    if (fromEditor && !useBtn.disabled && !used) {
      try { useBtn.focus({ preventScroll: true }); } catch (e) {}
    }

    document.addEventListener('as:converted', function (e) {
      var d = e.detail || {};
      if (!used || !d.blob || !d.panel) return;
      // Stems arrive zipped; any other tool's zip means several input files,
      // and only one of them was the project's.
      var many = /\.zip$/i.test(d.name);
      if (many ? info.project !== 'stems' : !CV.isAudio(d.name)) return;
      offerReturn(slug, target, d, many);
    });
  }

  function offerReturn(slug, target, out, many) {
    var row = document.createElement('div');
    row.className = 'next-steps-row project-return';
    var a = document.createElement('a');
    a.className = 'next-chip next-chip-primary';
    a.href = '/audio-editor';
    a.innerHTML = '<span class="next-chip-label"></span><span class="next-chip-why"></span>';
    a.querySelector('.next-chip-label').textContent = 'Send back to “' + (target.projectName || 'your project') + '”';
    a.querySelector('.next-chip-why').textContent = many
      ? 'The first file replaces the clip, the others go on new tracks below it. Undo takes it all off again.'
      : 'Replaces the clip in the editor. Undo takes it off again.';
    row.appendChild(a);
    out.panel.insertBefore(row, out.panel.firstChild);

    var sent = false;
    a.addEventListener('click', function (e) {
      e.preventDefault();
      if (sent) return;
      sent = true;
      var id = uid('r');
      CV.track('next_step_click', { tool: slug, to_tool: 'audio-editor', placement: 'project_return' });
      api.putReturn({
        v: 1, id: id, targetId: target.id, projectId: target.projectId, tool: slug,
        name: out.name, blob: out.blob, createdAt: Date.now()
      }).then(function () {
        return editorAlive(target.projectId, 300);
      }).then(function (alive) {
        if (alive) {
          channel().postMessage({ t: 'return', id: id });
          a.querySelector('.next-chip-label').textContent = 'Sent to the editor in your other tab';
          a.querySelector('.next-chip-why').textContent = 'Switch to it to hear the result.';
          return;
        }
        global.location.href = '/audio-editor?return=' + encodeURIComponent(id);
      }).catch(function () {
        sent = false;
        a.querySelector('.next-chip-why').textContent = 'Could not hand it over: this browser would not store it. Download it and drop it into the editor instead.';
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initBar);
  else initBar();
})(window);
