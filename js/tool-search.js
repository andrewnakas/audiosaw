// "Type what you want" — finds the tool for a plain-language request
// ("make my voice memo louder", "remove vocals", "m4a to mp3") from
// tool-graph.js alone: titles, labels, blurbs and SEARCH_ALSO. No index file,
// no library, no network. UMD so tools/check-search.js can pin real phrasings
// to the tool they must find.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ASSearch = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var STOP = ('a an the my me to of from in on for with and or how do does i can ' +
    'want need make it its this that file files audio sound online free tool ' +
    'some please way get into is be will using use convert converter').split(' ');

  // Words that name the thing rather than the job ("make my *voice memo*
  // louder"). They still count, but a job word outranks them, or every query
  // that mentions a voice lands on the recorder and every "mp3" on a converter.
  var WEAK = ('mp3 wav m4a aac flac ogg opus wma aiff mp4 mov webm song songs track music voice ' +
    'memo recording podcast video clip sound').split(' ');

  // Formats the homepage converter writes. "x to y" with no page of its own
  // still has an answer: the converter on /.
  var OUT_FORMATS = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'aiff'];
  var FORMAT_ALIAS = { aif: 'aiff', wave: 'wav', vorbis: 'ogg', alac: 'm4a', video: 'mp4' };

  function norm(s) {
    return String(s || '').toLowerCase()
      .replace(/→|->|=>/g, ' to ')
      .replace(/[^a-z0-9+\s-]/g, ' ')
      .replace(/-/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  function stem(w) {
    if (w.length > 4 && /ies$/.test(w)) return w.slice(0, -3) + 'y';
    if (w.length > 3 && /[^s]s$/.test(w)) return w.slice(0, -1);
    return w;
  }

  function words(s) { return norm(s).split(' ').filter(Boolean).map(stem); }

  var cache = null;
  function index(G) {
    if (cache && cache.G === G) return cache.rows;
    var rows = G.slugs().map(function (slug) {
      var t = G.TOOLS[slug];
      return {
        slug: slug,
        phrase: norm(slug),
        fields: [
          [words(t.title), 3],
          [words(t.label), 2],
          [words((G.SEARCH_ALSO || {})[slug]), 3],
          [words(slug), 2],
          [words(t.blurb), 1]
        ]
      };
    });
    cache = { G: G, rows: rows };
    return rows;
  }

  function wordScore(tok, list) {
    var best = 0;
    for (var i = 0; i < list.length; i++) {
      var w = list[i];
      if (w === tok) return 1;
      if (tok.length >= 3 && w.indexOf(tok) === 0) best = Math.max(best, 0.7);
      else if (w.length >= 4 && tok.indexOf(w) === 0) best = Math.max(best, 0.6);
    }
    return best;
  }

  // Returns [{ slug, title, href, score }], best first. slug 'index' is the
  // homepage converter, for a format pair with no page of its own.
  function search(query, G, limit) {
    limit = limit || 6;
    var q = norm(query);
    if (!q) return [];
    var out = [];

    // "m4a to mp3", "wav 2 flac", "video into mp3"
    var m = /\b([a-z0-9]{2,5})\s+(?:to|2|into)\s+([a-z0-9]{2,5})\b/.exec(q);
    var pairSlug = null;
    if (m) {
      var a = FORMAT_ALIAS[m[1]] || m[1], b = FORMAT_ALIAS[m[2]] || m[2];
      var cand = [a + '-to-' + b, a === 'mp4' && b === 'mp3' ? 'mp4-to-mp3' : null];
      for (var c = 0; c < cand.length; c++) if (cand[c] && G.TOOLS[cand[c]]) { pairSlug = cand[c]; break; }
      if (!pairSlug && OUT_FORMATS.indexOf(b) !== -1) {
        out.push({ slug: 'index', title: 'Convert ' + a.toUpperCase() + ' to ' + b.toUpperCase(), href: '/', score: 50 });
      }
    }

    var toks = words(q).filter(function (w) { return STOP.indexOf(w) === -1; });
    if (!toks.length && !pairSlug && !out.length) return [];

    var strong = toks.some(function (t) { return WEAK.indexOf(t) === -1; });
    index(G).forEach(function (row) {
      var score = 0, hit = 0;
      toks.forEach(function (tok) {
        var best = 0;
        row.fields.forEach(function (f) { best = Math.max(best, wordScore(tok, f[0]) * f[1]); });
        if (best > 0) {
          var weak = strong && WEAK.indexOf(tok) !== -1;
          score += weak ? best * 0.25 : best;
          hit += weak ? 0.25 : 1;
        }
      });
      // The tool's own name typed in full ("text to speech") is the answer.
      if (q.indexOf(row.phrase) !== -1) score += 20;
      // Every word the visitor typed that the tool answers is worth more than
      // one word answered loudly.
      if (hit) score += hit * 2 + (hit >= toks.length ? 3 : 0);
      if (row.slug === pairSlug) score += 100;
      if (score > 0) out.push({ slug: row.slug, title: G.TOOLS[row.slug].title, href: '/' + row.slug, score: score });
    });

    out.sort(function (x, y) { return y.score - x.score; });
    // A tail of one-word coincidences ("make it louder" -> Microphone Test)
    // reads as the site not understanding; keep what is close to the best.
    var top = out.length ? out[0].score : 0;
    return out.filter(function (r) { return r.score >= top * 0.45; }).slice(0, limit);
  }

  // Browser: bind an <input> (and a <ul> for results) inside `form`.
  function bind(form, G, track) {
    if (!form) return;
    var input = form.querySelector('input');
    var list = form.querySelector('ul');
    var results = [], sel = 0;

    function render() {
      results = search(input.value, G, 6);
      sel = 0;
      list.innerHTML = '';
      list.hidden = !results.length;
      results.forEach(function (r, i) {
        var li = document.createElement('li');
        var a = document.createElement('a');
        a.href = r.href;
        a.textContent = r.title;
        a.setAttribute('role', 'option');
        if (i === 0) a.className = 'is-sel';
        a.addEventListener('click', function () { go(r, true); });
        li.appendChild(a);
        list.appendChild(li);
      });
      input.setAttribute('aria-expanded', results.length ? 'true' : 'false');
    }

    function go(r, viaClick) {
      if (track) track(r.slug);
      if (r.slug === 'index') {
        if (location.pathname === '/' || location.pathname === '/index') {
          var dz = document.getElementById('dropzone');
          if (dz) { dz.scrollIntoView({ behavior: 'smooth', block: 'center' }); dz.focus && dz.focus(); }
          list.hidden = true;
          return;
        }
      }
      if (!viaClick) location.href = r.href;
    }

    input.addEventListener('input', render);
    input.addEventListener('keydown', function (e) {
      if (!results.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        sel = (sel + (e.key === 'ArrowDown' ? 1 : results.length - 1)) % results.length;
        Array.prototype.forEach.call(list.querySelectorAll('a'), function (a, i) { a.className = i === sel ? 'is-sel' : ''; });
      } else if (e.key === 'Escape') {
        list.hidden = true;
      }
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!results.length) render();
      if (results[sel]) go(results[sel], false);
    });
  }

  // Any page with a #toolSearch form gets it bound: the homepage and /tools.
  if (typeof document !== 'undefined') {
    var auto = function () {
      var form = document.getElementById('toolSearch');
      if (!form || typeof AS_GRAPH === 'undefined') return;
      bind(form, AS_GRAPH, function (slug) {
        if (typeof CV !== 'undefined' && CV.track) {
          CV.track('next_step_click', {
            tool: (CV.flow && CV.flow.tool()) || 'index',
            to_tool: slug, placement: 'search'
          });
        }
      });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', auto);
    else auto();
  }

  return { search: search, bind: bind, norm: norm };
}));
