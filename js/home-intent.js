// "What do you want to do with it?" — the cards that appear after a file is
// dropped on the homepage. Each card sends the file to a tool through flow.js's
// handoff store, and the tool takes it without a second drop (offerHandoff's
// `auto` branch). The list itself is HOME_INTENTS in tool-graph.js.
//
// The converter stays where it was, open underneath: converting is still what
// most people who drop a file here want, and it must not cost an extra click.
(function () {
  'use strict';
  if (typeof CV === 'undefined' || !CV.flow || typeof AS_GRAPH === 'undefined') {
    console.error('home-intent.js: load common.js, tool-graph.js and flow.js first.');
    return;
  }
  var G = AS_GRAPH;
  var host = document.getElementById('homeIntent');
  if (!host) return;

  // Cards before "more": two full rows at the grid's width (2 columns on a
  // phone, 4 on a laptop).
  var SHOWN = window.innerWidth >= 900 ? 8 : 6;
  var LONG = 10 * 60;     // seconds: a file this long ranks the 'long' jobs up
  var VIDEO_EXT = ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', '3gp', 'mpeg', 'mpg', 'wmv', 'flv'];
  var token = 0;

  function extOf(name) { var m = /\.([^.]+)$/.exec(name || ''); return m ? m[1].toLowerCase() : ''; }

  function kindOf(file) {
    var ext = extOf(file.name);
    if (VIDEO_EXT.indexOf(ext) !== -1) return 'video';
    if (/^video\//.test(file.type || '') && ext !== 'm4a') return 'video';
    return 'audio';
  }

  // Duration from the media element's metadata: no decode, so it costs nothing
  // on a 2 GB video. Resolves null if the browser cannot tell within 3 s.
  function durationOf(file, kind) {
    return new Promise(function (resolve) {
      var url, el, done = false;
      function finish(v) {
        if (done) return; done = true;
        try { if (el) el.removeAttribute('src'); URL.revokeObjectURL(url); } catch (e) {}
        resolve(v);
      }
      try {
        url = URL.createObjectURL(file);
        el = document.createElement(kind === 'video' ? 'video' : 'audio');
        el.preload = 'metadata';
        el.muted = true;
        el.onloadedmetadata = function () { finish(isFinite(el.duration) ? el.duration : null); };
        el.onerror = function () { finish(null); };
        el.src = url;
        setTimeout(function () { finish(null); }, 3000);
      } catch (e) { finish(null); }
    });
  }

  function ordered(kind, seconds) {
    var list = (G.HOME_INTENTS[kind] || []).slice();
    if (seconds && seconds >= LONG) {
      // Keep "here" first; lift the long-file jobs right behind it.
      var head = list.filter(function (x) { return x[0] === 'here'; });
      var lng = list.filter(function (x) { return x[0] !== 'here' && x[3] === 'long'; });
      var rest = list.filter(function (x) { return x[0] !== 'here' && x[3] !== 'long'; });
      list = head.concat(lng, rest);
    }
    return list;
  }

  function fmtDur(s) {
    if (!s) return '';
    s = Math.round(s);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(r).padStart(2, '0');
  }

  function go(slug, file, card) {
    CV.track('next_step_click', { tool: 'index', to_tool: slug, placement: 'home_intent' });
    card.classList.add('is-going');
    card.querySelector('.hi-hint').textContent = 'opening…';
    var href = '/' + slug + '?from=index';
    // A failed store (private mode, quota) still opens the tool; the visitor
    // drops the file once more instead of being stuck here.
    CV.flow.handoff({ name: file.name, blob: file, from: 'index', auto: true, at: Date.now() })
      .catch(function () {})
      .then(function () { location.href = href; });
  }

  function render(files) {
    var my = ++token;
    host.innerHTML = '';
    host.hidden = true;
    if (!files || !files.length) return;

    if (files.length > 1) {
      host.innerHTML = '<p class="hi-multi">' + files.length + ' files: convert them all at once below, ' +
        'or <a href="/audio-joiner">join them into one file</a>.</p>';
      host.hidden = false;
      return;
    }

    var file = files[0];
    var kind = kindOf(file);
    durationOf(file, kind).then(function (seconds) {
      if (my !== token) return;   // another drop or a reset since
      var list = ordered(kind, seconds);

      var head = document.createElement('div');
      head.className = 'hi-head';
      var h = document.createElement('h2');
      h.textContent = 'What do you want to do with it?';
      var meta = document.createElement('p');
      meta.className = 'hi-meta';
      meta.textContent = file.name + (seconds ? ' · ' + fmtDur(seconds) : '') + ' · ' + CV.fmtBytes(file.size);
      head.appendChild(h); head.appendChild(meta);
      host.appendChild(head);

      var grid = document.createElement('div');
      grid.className = 'hi-grid';
      list.forEach(function (item, i) {
        var slug = item[0];
        var card = document.createElement(slug === 'here' ? 'button' : 'a');
        card.className = 'hi-card' + (slug === 'here' ? ' is-here' : '') + (i >= SHOWN ? ' is-extra' : '');
        if (slug === 'here') {
          card.type = 'button';
        } else {
          card.href = '/' + slug;
        }
        var t = document.createElement('span'); t.className = 'hi-label'; t.textContent = item[1];
        var s = document.createElement('span'); s.className = 'hi-hint'; s.textContent = slug === 'here' ? 'settings below ↓' : item[2];
        card.appendChild(t); card.appendChild(s);
        card.addEventListener('click', function (e) {
          if (slug === 'here') {
            var c = document.getElementById('universalControls');
            if (c) c.scrollIntoView({ behavior: 'smooth', block: 'center' });
            var b = document.getElementById('convertBtn');
            if (b) b.focus({ preventScroll: true });
            return;
          }
          // Let a modifier-click open the plain page in a new tab, as a link should.
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
          e.preventDefault();
          go(slug, file, card);
        });
        grid.appendChild(card);
      });
      host.appendChild(grid);

      if (list.length > SHOWN) {
        var more = document.createElement('button');
        more.type = 'button';
        more.className = 'hi-more';
        more.textContent = (list.length - SHOWN) + ' more things to do with it';
        more.addEventListener('click', function () {
          grid.classList.add('is-open');
          more.remove();
        });
        host.appendChild(more);
      }
      host.hidden = false;
    });
  }

  document.addEventListener('as:homefiles', function (e) { render(e.detail || []); });
})();
