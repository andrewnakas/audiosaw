/*
 * The audio editor's mixer panel: effect chains, sends, levels, presets,
 * patches and automation lanes.
 *
 * Depth is optional, and the panel always opens at the shallowest level:
 *
 *   1. Patches: a whole chain in one tap ("Podcast voice", "Streaming master").
 *   2. Smart controls: two to four plain-words knobs per plugin, each driving
 *      several parameters along a curve (editor-dsp.js declares them).
 *   3. Show all controls: every parameter, grouped, typed or dragged.
 *
 * Bypass, Mix, Output, A/B, presets and meters are visible at every depth.
 *
 * It is docked rather than modal — a drawer on the right on a wide screen, a
 * bottom sheet on a phone — with no backdrop, so the timeline stays usable,
 * Space still plays, and a knob can be turned while the song runs.
 *
 * Every change is a model edit, so undo, autosave and project files carry it.
 * A slider drag is one undo step. During playback, parameter changes go to
 * the running graph through ASEditEngine.syncFx without restarting.
 *
 * editor-ui.js owns the state and calls init() with the handful of its
 * functions this file needs.
 */
(function (global) {
  'use strict';

  var D = global.ASEditDsp, M = global.ASEditModel, E = global.ASEditEngine;
  var A = null;          // editor-ui's API
  var root = null;
  var P = {
    open: false, owner: null, view: 'strip', fxId: null, q: '', cat: '',
    full: false, rec: false, ab: {}, recBuf: null, lastSig: ''
  };
  try { P.full = localStorage.getItem('as_ed_fxfull') === '1'; } catch (e) {}

  function esc(s) { return A.esc(s); }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function proj() { return A.S.project; }

  /* ------------------------------------------------------------ owners */

  function ownerName(key) {
    var p = proj();
    if (key === 'master') return 'Master';
    var o = M.owner(p, key);
    return o ? o.name : '';
  }
  function ownerKind(key) {
    var p = proj();
    if (key === 'master') return 'master';
    return M.trackIndex(p, key) >= 0 ? 'track' : 'bus';
  }
  function ownerExists(key) { return !!M.owner(proj(), key); }
  function slotOf(key, id) {
    var ch = M.chainOf(proj(), key) || [];
    for (var i = 0; i < ch.length; i++) if (ch[i].id === id) return ch[i];
    return null;
  }

  /* ------------------------------------------------------ user storage */

  function load(k, d) { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function userPresets(type) { return (load('as_ed_presets', {})[type]) || []; }
  function saveUserPreset(type, name, params) {
    var all = load('as_ed_presets', {});
    all[type] = (all[type] || []).filter(function (x) { return x.name !== name; });
    all[type].push({ name: name, p: params });
    save('as_ed_presets', all);
  }
  function deleteUserPreset(type, name) {
    var all = load('as_ed_presets', {});
    all[type] = (all[type] || []).filter(function (x) { return x.name !== name; });
    save('as_ed_presets', all);
  }
  function userPatches() { return load('as_ed_patches', []); }

  /* ----------------------------------------------------------- editing */

  // A discrete change: one undo step, applied to the running mix in place.
  function commit(fn) {
    A.edit(fn, { noRestart: true });
    sync();
  }
  function sync() {
    E.syncFx(proj());
    E.updateTracks(proj());
  }
  // A continuous change (a slider drag): snapshot on the first move, commit on release.
  function live(fn) {
    A.beginLive();
    fn(proj());
    sync();
  }
  function endLive() { A.endLive({ noRestart: true }); }

  /* ------------------------------------------------------------ panel */

  function init(api) {
    A = api;
    root = document.createElement('aside');
    root.className = 'ed-mixer';
    root.hidden = true;
    root.setAttribute('aria-label', 'Mixer and effects');
    A.el.ed.appendChild(root);
    root.addEventListener('click', onClick);
    root.addEventListener('input', onInput);
    root.addEventListener('change', onChange);
    root.addEventListener('keydown', onKey);
    root.addEventListener('pointerdown', onVizDown);
  }

  function open(key, fxId) {
    if (!key || !ownerExists(key)) key = A.S.selTrack && ownerExists(A.S.selTrack) ? A.S.selTrack : (proj().tracks[0] ? proj().tracks[0].id : 'master');
    P.owner = key;
    P.view = fxId ? 'edit' : 'strip';
    P.fxId = fxId || null;
    P.open = true;
    root.hidden = false;
    A.el.ed.classList.add('has-mixer');
    document.documentElement.classList.add('ed-mixer-open');
    render();
    loop();
    A.layout();
  }
  function close() {
    if (!P.open) return;
    P.open = false;
    root.hidden = true;
    A.el.ed.classList.remove('has-mixer');
    document.documentElement.classList.remove('ed-mixer-open');
    finishRecord();
    A.layout();
    A.refresh();
  }
  function isOpen() { return P.open; }

  // Called from editor-ui's refresh(): the project may have changed under us
  // (undo, a patch, a deleted track).
  function refresh() {
    if (!P.open) return;
    if (!ownerExists(P.owner)) { P.owner = 'master'; P.view = 'strip'; }
    if (P.view === 'edit' && !slotOf(P.owner, P.fxId)) P.view = 'strip';
    if (document.activeElement && root.contains(document.activeElement) && document.activeElement.type === 'range' && A.isLive()) return;
    render();
  }

  function render() {
    var scroll = root.querySelector('.mx-body');
    var top = scroll ? scroll.scrollTop : 0;
    var html;
    if (P.view === 'browse') html = browserHtml();
    else if (P.view === 'edit') html = editorHtml();
    else html = stripHtml();
    root.innerHTML = html;
    var body = root.querySelector('.mx-body');
    if (body && P.keepScroll) body.scrollTop = top;
    P.keepScroll = false;
    if (P.view === 'browse') { var s = root.querySelector('[data-a="search"]'); if (s && !A.isTouchUI()) s.focus(); }
    drawViz();
  }

  /* -------------------------------------------------------- strip view */

  function ownerTabs() {
    var p = proj(), html = '<div class="mx-owners" role="tablist" aria-label="Choose a channel">';
    p.tracks.forEach(function (t) { html += tab(t.id, t.name, t.fx.length); });
    html += tab('master', 'Master', p.master.fx.length);
    p.buses.forEach(function (b) { html += tab(b.id, b.name + ' bus', b.fx.length); });
    return html + '</div>';
    function tab(key, name, n) {
      return '<button type="button" role="tab" class="mx-owner' + (key === P.owner ? ' on' : '') + '" aria-selected="' + (key === P.owner) + '" data-a="owner" data-key="' + esc(key) + '">' +
        esc(name) + (n ? ' <i>' + n + '</i>' : '') + '</button>';
    }
  }

  function header(title, back) {
    return '<div class="mx-top">' +
      (back ? '<button type="button" class="mx-back" data-a="back" aria-label="Back">‹</button>' : '') +
      '<h3 class="mx-title">' + esc(title) + '</h3>' +
      '<button type="button" class="mx-rec' + (P.rec ? ' on' : '') + '" data-a="rec" aria-pressed="' + P.rec + '" title="Record automation: while this is on and the song plays, moving a control writes its movement into an automation lane">● Auto</button>' +
      '<button type="button" class="ed-icon mx-x" data-a="close" aria-label="Close the mixer" title="Close (Esc)">✕</button>' +
      '</div>';
  }

  function slotSummary(slot) {
    var d = D.PLUGINS[slot.type];
    if (!d) return 'Unknown effect';
    if (slot.m && d.macros.length) return d.macros.map(function (mc) { return mc.label + ' ' + mc.fmt(slot.m[mc.k] != null ? slot.m[mc.k] : mc.def); }).join(' · ');
    var q = D.resolve(slot), pr = d.presets.filter(function (x) { return Object.keys(x.p).every(function (k) { return q[k] === x.p[k]; }); })[0];
    return pr ? pr.name : 'Custom settings';
  }

  function stripHtml() {
    var p = proj(), key = P.owner, kind = ownerKind(key), o = M.owner(p, key);
    var html = header(ownerName(key) + (kind === 'bus' ? ' bus' : '')) + ownerTabs() + '<div class="mx-body">';

    html += '<section class="mx-sec"><div class="mx-sec-h"><h4>Effects</h4><button type="button" class="ed-btn" data-a="patches">Patches…</button></div>';
    if (!o.fx.length) {
      html += '<p class="mx-empty">' + (kind === 'master' ? 'Effects here shape the whole mix. Try the <strong>Streaming master</strong> patch.' :
        kind === 'bus' ? 'Tracks send to this bus with their Send knobs. Whatever is here processes all of them together.' :
        'No effects yet. Pick a <strong>patch</strong> for a whole sound in one tap, or add effects one at a time.') + '</p>';
    }
    html += '<ol class="mx-slots">';
    o.fx.forEach(function (slot, i) {
      var d = D.PLUGINS[slot.type] || { name: slot.type };
      var auto = Object.keys(o.auto || {}).some(function (pth) { return pth.indexOf('fx:' + slot.id + ':') === 0; });
      html += '<li class="mx-slot' + (slot.on === false ? ' off' : '') + '" data-fx="' + slot.id + '">' +
        '<button type="button" class="mx-pow" data-a="power" aria-pressed="' + (slot.on !== false) + '" title="' + (slot.on === false ? 'Turn on' : 'Bypass') + '" aria-label="' + (slot.on === false ? 'Turn on ' : 'Bypass ') + esc(d.name) + '">⏻</button>' +
        '<button type="button" class="mx-slot-name" data-a="edit"><strong>' + esc(d.name) + (auto ? ' <i class="mx-autodot" title="Automated">A</i>' : '') + '</strong><small>' + esc(slotSummary(slot)) + '</small></button>' +
        '<span class="mx-slot-btns">' +
        '<button type="button" class="mx-mini" data-a="up" aria-label="Move up"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
        '<button type="button" class="mx-mini" data-a="down" aria-label="Move down"' + (i === o.fx.length - 1 ? ' disabled' : '') + '>↓</button>' +
        '<button type="button" class="mx-mini" data-a="remove" aria-label="Remove ' + esc(d.name) + '">✕</button>' +
        '</span></li>';
    });
    html += '</ol><button type="button" class="mx-add" data-a="add">＋ Add an effect</button></section>';

    if (kind === 'track') {
      html += '<section class="mx-sec"><div class="mx-sec-h"><h4>Sends</h4><button type="button" class="ed-linkbtn" data-a="newbus">New bus</button></div>';
      p.buses.forEach(function (b) {
        var v = o.sends[b.id] > -60 ? o.sends[b.id] : -60, lane = !!o.auto['send:' + b.id];
        html += fader('send:' + b.id, b.name, v, -60, 6, fmtSend(v), lane, '<button type="button" class="ed-linkbtn" data-a="owner" data-key="' + esc(b.id) + '">edit</button>');
      });
      html += '<p class="mx-hint">A send copies this track to a shared effect, so several tracks can sit in one reverb.</p></section>';
    }

    html += '<section class="mx-sec"><div class="mx-sec-h"><h4>Level</h4><span class="mx-meter" aria-hidden="true"><i data-meter="level"></i></span></div>';
    html += fader('vol', 'Volume', o.volDb || 0, -60, 12, fmtDb(o.volDb || 0), !!(o.auto && o.auto.vol));
    if (kind === 'track') html += fader('pan', 'Pan', o.pan || 0, -1, 1, panLabel(o.pan || 0), !!o.auto.pan);
    html += '</section>';

    if (kind === 'master') {
      html += '<section class="mx-sec"><div class="mx-sec-h"><h4>Tempo</h4></div>' +
        '<div class="mx-row"><span>' + p.bpm + ' BPM</span><button type="button" class="ed-btn" data-a="tempo">Set tempo…</button></div>' +
        '<p class="mx-hint">Synced delays, tremolos and sweeps follow it.</p></section>';
    }
    if (kind === 'bus') {
      html += '<section class="mx-sec"><div class="mx-row">' +
        '<button type="button" class="ed-btn" data-a="renamebus">Rename</button>' +
        '<button type="button" class="ed-btn mx-danger" data-a="delbus">Delete bus</button></div></section>';
    }
    return html + '</div>';
  }

  function fader(k, label, v, min, max, text, lane, extra) {
    return '<div class="mx-fader" data-f="' + esc(k) + '">' +
      '<label><span>' + esc(label) + (lane ? ' <i class="mx-autodot" title="Follows its automation lane">A</i>' : '') + '</span>' +
      '<output>' + esc(text) + '</output>' + (extra || '') + '</label>' +
      '<input type="range" min="' + min + '" max="' + max + '" step="' + (max - min > 10 ? 0.5 : 0.02) + '" value="' + v + '" data-fader="' + esc(k) + '" aria-label="' + esc(label) + '">' +
      '</div>';
  }
  function fmtDb(v) { return v <= -60 ? '−∞' : (v > 0 ? '+' : '') + v.toFixed(1) + ' dB'; }
  function fmtSend(v) { return v <= -60 ? 'off' : fmtDb(v); }
  function panLabel(p) { return Math.abs(p) < 0.03 ? 'centre' : (p < 0 ? Math.round(-p * 100) + '% L' : Math.round(p * 100) + '% R'); }

  /* ------------------------------------------------------- browser view */

  function browserHtml() {
    var q = P.q.toLowerCase().trim();
    var html = header('Add an effect to ' + ownerName(P.owner), true) + '<div class="mx-body">';
    html += '<input type="search" class="mx-search" data-a="search" placeholder="Search: reverb, de-ess, lo-fi…" value="' + esc(P.q) + '" aria-label="Search effects">';
    html += '<div class="mx-cats"><button type="button" class="mx-cat' + (!P.cat ? ' on' : '') + '" data-a="cat" data-cat="">All</button>' +
      D.CATS.map(function (c) { return '<button type="button" class="mx-cat' + (P.cat === c[0] ? ' on' : '') + '" data-a="cat" data-cat="' + c[0] + '">' + esc(c[1]) + '</button>'; }).join('') + '</div>';
    D.CATS.forEach(function (c) {
      if (P.cat && P.cat !== c[0]) return;
      var list = D.ORDER.filter(function (k) {
        var d = D.PLUGINS[k];
        if (d.cat !== c[0]) return false;
        if (!q) return true;
        return (d.name + ' ' + d.desc + ' ' + d.presets.map(function (x) { return x.name; }).join(' ')).toLowerCase().indexOf(q) !== -1;
      });
      if (!list.length) return;
      html += '<h4 class="mx-cat-h">' + esc(c[1]) + '</h4><div class="mx-plugs">';
      list.forEach(function (k) {
        var d = D.PLUGINS[k];
        html += '<button type="button" class="mx-plug" data-a="pick" data-type="' + k + '"><strong>' + esc(d.name) + '</strong><small>' + esc(d.desc) + '</small></button>';
      });
      html += '</div>';
    });
    return html + '</div>';
  }

  /* -------------------------------------------------------- editor view */

  function editorHtml() {
    var slot = slotOf(P.owner, P.fxId), d = D.PLUGINS[slot.type], q = D.resolve(slot);
    var o = M.owner(proj(), P.owner);
    var html = header(d.name, true) + '<div class="mx-body">';
    html += '<p class="mx-where">on ' + esc(ownerName(P.owner)) + ' · <span>' + esc(d.desc) + '</span></p>';

    // Preset, bypass, A/B.
    var ab = P.ab[slot.id] || { cur: 'A' };
    html += '<div class="mx-bar">' +
      '<button type="button" class="mx-pow big" data-a="power" aria-pressed="' + (slot.on !== false) + '">' + (slot.on === false ? 'Off' : 'On') + '</button>' +
      '<select class="mx-preset" data-a="preset" aria-label="Preset"><option value="">Presets…</option>' +
      d.presets.map(function (x) { return '<option value="f:' + esc(x.name) + '">' + esc(x.name) + '</option>'; }).join('') +
      (userPresets(slot.type).length ? '<optgroup label="Yours">' + userPresets(slot.type).map(function (x) { return '<option value="u:' + esc(x.name) + '">' + esc(x.name) + '</option>'; }).join('') + '</optgroup>' : '') +
      '</select>' +
      '<span class="mx-ab" role="group" aria-label="Compare two settings">' +
      '<button type="button" data-a="ab" data-v="A" aria-pressed="' + (ab.cur === 'A') + '" title="Compare two settings: tweak one, switch, tweak the other">A</button>' +
      '<button type="button" data-a="ab" data-v="B" aria-pressed="' + (ab.cur === 'B') + '">B</button></span>' +
      '<button type="button" class="ed-icon mx-more" data-a="more" aria-label="More">⋯</button>' +
      '</div>';

    // Picture.
    var viz = vizKind(slot.type);
    html += '<div class="mx-viz' + (viz ? '' : ' mx-viz-meters') + '">' +
      (viz ? '<canvas class="mx-canvas" data-viz="' + viz + '" height="150"></canvas>' : '') +
      '<div class="mx-io"><span title="Input level"><b>in</b><u><i data-meter="in"></i></u></span><span title="Output level"><b>out</b><u><i data-meter="out"></i></u></span>' +
      (d.meter === 'gr' ? '<span class="mx-gr" title="Gain reduction"><b>GR</b><u><i data-meter="gr"></i></u><em data-gr></em></span>' : '') + '</div>' +
      '</div>';
    html += '<p class="mx-note" data-note hidden></p>';

    // Smart controls.
    if (d.macros.length) {
      html += '<section class="mx-sec mx-smart"><div class="mx-sec-h"><h4>Smart controls</h4>' + (slot.m ? '' : '<span class="ed-chip" title="Set by hand or by a preset; turning a knob takes over again">custom</span>') + '</div>';
      d.macros.forEach(function (mc) {
        var v = slot.m && slot.m[mc.k] != null ? slot.m[mc.k] : null;
        html += '<div class="mx-macro"><label><span>' + esc(mc.label) + '</span><output>' + (v == null ? '—' : esc(mc.fmt(v))) + '</output></label>' +
          '<input type="range" min="0" max="1000" value="' + Math.round((v == null ? mc.def : v) * 1000) + '" data-macro="' + mc.k + '" aria-label="' + esc(mc.label) + '"' + (v == null ? ' class="is-custom"' : '') + '></div>';
      });
      html += '</section>';
    }

    // Things that need choosing before anything else works.
    d.params.filter(function (pd) { return pd.kind === 'track'; }).forEach(function (pd) { html += paramRow(slot, pd, q, o); });

    // Mix and output are always here.
    var always = ['mix', 'out'].filter(function (k) { return d.byKey[k]; });
    html += '<section class="mx-sec">' + always.map(function (k) { return paramRow(slot, d.byKey[k], q, o); }).join('') + '</section>';

    // Everything.
    var rest = d.params.filter(function (pd) { return always.indexOf(pd.k) === -1 && pd.kind !== 'track'; });
    if (rest.length) {
      html += '<button type="button" class="mx-expand" data-a="full" aria-expanded="' + P.full + '">' + (P.full ? 'Hide' : 'Show') + ' all ' + rest.length + ' controls</button>';
      if (P.full) {
        var groups = {}, order = [];
        rest.forEach(function (pd) { var g = pd.group || ''; if (!groups[g]) { groups[g] = []; order.push(g); } groups[g].push(pd); });
        html += '<div class="mx-params">' + order.map(function (g) {
          return '<section class="mx-group">' + (g ? '<h5>' + esc(g) + '</h5>' : '') + groups[g].map(function (pd) { return paramRow(slot, pd, q, o); }).join('') + '</section>';
        }).join('') + '</div>';
      }
    }
    return html + '</div>';
  }

  function paramRow(slot, pd, q, o) {
    var path = 'fx:' + slot.id + ':' + pd.k, lane = o && o.auto && o.auto[path];
    var canAuto = !pd.opts && ownerKind(P.owner) === 'track';
    var head = '<label for="mxp-' + pd.k + '"><span>' + esc(pd.label) + '</span>' +
      (pd.opts ? '' : '<button type="button" class="mx-val" data-a="type" data-k="' + pd.k + '" title="Type a value">' + esc(D.fmtValue(pd, q[pd.k])) + '</button>') +
      (canAuto ? '<button type="button" class="mx-autobtn' + (lane ? ' on' : '') + '" data-a="automate" data-k="' + pd.k + '" title="' + (lane ? 'Show its automation lane' : 'Automate: draw how it changes over time') + '" aria-label="Automate ' + esc(pd.label) + '">A</button>' : '') +
      '</label>';
    var ctl;
    if (pd.kind === 'track') {
      var tracks = proj().tracks.filter(function (t) { return t.id !== P.owner; });
      ctl = '<select id="mxp-' + pd.k + '" data-k="' + pd.k + '"><option value="">Choose a track…</option>' +
        tracks.map(function (t) { return '<option value="' + esc(t.id) + '"' + (q[pd.k] === t.id ? ' selected' : '') + '>' + esc(t.name) + '</option>'; }).join('') + '</select>';
    } else if (pd.opts && pd.opts.length <= 3) {
      ctl = '<span class="mx-seg" role="group" id="mxp-' + pd.k + '">' + pd.opts.map(function (op) {
        return '<button type="button" data-a="enum" data-k="' + pd.k + '" data-v="' + esc(op[0]) + '" aria-pressed="' + (String(q[pd.k]) === String(op[0])) + '">' + esc(op[1]) + '</button>';
      }).join('') + '</span>';
    } else if (pd.opts) {
      ctl = '<select id="mxp-' + pd.k + '" data-k="' + pd.k + '">' + pd.opts.map(function (op) {
        return '<option value="' + esc(op[0]) + '"' + (String(q[pd.k]) === String(op[0]) ? ' selected' : '') + '>' + esc(op[1]) + '</option>';
      }).join('') + '</select>';
    } else {
      ctl = '<input type="range" id="mxp-' + pd.k + '" min="0" max="1000" value="' + Math.round(D.toNorm(pd, q[pd.k]) * 1000) + '" data-k="' + pd.k + '">';
    }
    return '<div class="mx-p' + (lane ? ' has-lane' : '') + '" data-p="' + pd.k + '">' + head + ctl + (pd.hint ? '<small>' + esc(pd.hint) + '</small>' : '') + '</div>';
  }

  /* ------------------------------------------------------------- events */

  function onClick(e) {
    var b = e.target.closest('[data-a]');
    if (!b || b.tagName === 'SELECT' || b.tagName === 'INPUT') return;
    var a = b.getAttribute('data-a'), li = b.closest('[data-fx]'), fxId = li ? li.getAttribute('data-fx') : P.fxId, key = P.owner;
    switch (a) {
      case 'close': close(); return;
      case 'back': P.view = 'strip'; render(); return;
      case 'owner': P.owner = b.getAttribute('data-key'); P.view = 'strip'; if (ownerKind(P.owner) === 'track') { A.S.selTrack = P.owner; A.refresh(); } render(); return;
      case 'rec': P.rec = !P.rec; render(); A.toast(P.rec ? 'Automation recording on: move a control while it plays' : 'Automation recording off'); return;
      case 'add': P.view = 'browse'; P.q = ''; render(); return;
      case 'cat': P.cat = b.getAttribute('data-cat'); render(); return;
      case 'pick': {
        var type = b.getAttribute('data-type'), f = D.fresh(type), id;
        if (type === 'ducker') {
          var other = proj().tracks.filter(function (t) { return t.id !== key; })[0];
          if (other) f.params.src = other.id;
        }
        commit(function (p) { id = M.addFx(p, key, type, f.params, null, f.m); });
        P.view = 'edit'; P.fxId = id; render();
        A.toast(D.PLUGINS[type].name + ' added');
        return;
      }
      case 'edit': P.view = 'edit'; P.fxId = fxId; render(); return;
      case 'power': {
        var s = slotOf(key, fxId);
        commit(function (p) { M.setFx(p, key, fxId, { on: s.on === false }); });
        P.keepScroll = true; render(); return;
      }
      case 'up': case 'down': {
        var ch = M.chainOf(proj(), key), i = ch.map(function (x) { return x.id; }).indexOf(fxId);
        commit(function (p) { M.moveFx(p, key, fxId, i + (a === 'up' ? -1 : 1)); });
        P.keepScroll = true; render(); return;
      }
      case 'remove': {
        var nm = D.PLUGINS[slotOf(key, fxId).type].name;
        commit(function (p) { M.removeFx(p, key, fxId); });
        P.keepScroll = true; render(); A.toast(nm + ' removed — undo brings it back'); return;
      }
      case 'patches': patchSheet(); return;
      case 'newbus': {
        var bid;
        commit(function (p) { bid = M.addBus(p, 'Bus ' + (p.buses.length + 1)); });
        P.owner = bid; render(); A.toast('New bus — add effects to it, then turn up a send'); return;
      }
      case 'renamebus': renameBus(); return;
      case 'delbus': {
        var gone = key;
        P.owner = proj().tracks[0] ? proj().tracks[0].id : 'master';
        commit(function (p) { M.removeBus(p, gone); });
        render(); A.toast('Bus deleted — undo brings it back'); return;
      }
      case 'tempo': A.tempoSheet(); return;
      case 'full': P.full = !P.full; try { localStorage.setItem('as_ed_fxfull', P.full ? '1' : '0'); } catch (err) {} P.keepScroll = true; render(); return;
      case 'enum': setParam(b.getAttribute('data-k'), b.getAttribute('data-v'), true); return;
      case 'ab': abSwitch(b.getAttribute('data-v')); return;
      case 'more': moreSheet(); return;
      case 'type': typeValue(b); return;
      case 'automate': automate(b.getAttribute('data-k')); return;
    }
  }

  function onKey(e) {
    if (e.key === 'Escape' && P.open) {
      if (P.view !== 'strip') { P.view = 'strip'; render(); } else close();
      e.stopPropagation();
    }
    if (e.target.getAttribute('data-a') === 'search') setTimeout(function () {
      P.q = e.target.value;
      var pos = e.target.selectionStart;
      render();
      var s = root.querySelector('[data-a="search"]');
      if (s) { s.focus(); try { s.setSelectionRange(pos, pos); } catch (err) {} }
    }, 0);
  }

  function onInput(e) {
    var t = e.target;
    if (t.hasAttribute('data-fader')) return onFader(t, false);
    if (t.hasAttribute('data-macro')) {
      var slot = slotOf(P.owner, P.fxId), mk = t.getAttribute('data-macro'), v = +t.value / 1000;
      var patch = D.macroPatch(slot.type, mk, v), m = {};
      m[mk] = v;
      if (!slot.m) {
        // Taking over from custom: the other knobs start from where they rest.
        D.PLUGINS[slot.type].macros.forEach(function (mc) { if (mc.k !== mk) m[mc.k] = mc.def; });
      }
      live(function (p) { M.setFx(p, P.owner, P.fxId, { params: patch, m: m }); });
      var mc = D.PLUGINS[slot.type].macros.filter(function (x) { return x.k === mk; })[0];
      t.classList.remove('is-custom');
      t.parentNode.querySelector('output').textContent = mc.fmt(v);
      Object.keys(patch).forEach(function (k) { recordParam(k, patch[k]); });
      updateParamViews();
      drawViz();
      return;
    }
    if (t.type === 'range' && t.hasAttribute('data-k')) {
      var sl = slotOf(P.owner, P.fxId), pd = D.PLUGINS[sl.type].byKey[t.getAttribute('data-k')];
      setParam(pd.k, D.fromNorm(pd, +t.value / 1000), false);
    }
  }

  function onChange(e) {
    var t = e.target;
    if (t.hasAttribute('data-fader')) { onFader(t, true); return; }
    if (t.getAttribute('data-a') === 'preset') { applyPreset(t.value); return; }
    if (t.tagName === 'SELECT' && t.hasAttribute('data-k')) { setParam(t.getAttribute('data-k'), t.value, true); return; }
    if (t.type === 'range' && (t.hasAttribute('data-k') || t.hasAttribute('data-macro'))) {
      finishRecord();
      endLive();
    }
  }

  // Set one plugin parameter. Hand-setting anything but Mix and Output
  // leaves the smart controls showing "custom".
  function setParam(k, v, discrete) {
    var slot = slotOf(P.owner, P.fxId);
    if (!slot) return;
    var patch = {};
    patch[k] = v;
    var ch = { params: patch };
    if (k !== 'mix' && k !== 'out' && slot.m) ch.m = null;
    if (discrete) {
      commit(function (p) { M.setFx(p, P.owner, P.fxId, ch); });
      P.keepScroll = true; render();
      return;
    }
    live(function (p) { M.setFx(p, P.owner, P.fxId, ch); });
    recordParam(k, v);
    var row = root.querySelector('[data-p="' + k + '"] .mx-val');
    if (row) row.textContent = D.fmtValue(D.PLUGINS[slot.type].byKey[k], D.resolve(slotOf(P.owner, P.fxId))[k]);
    if (ch.m === null) root.querySelectorAll('[data-macro]').forEach(function (x) { x.classList.add('is-custom'); var out = x.parentNode.querySelector('output'); if (out) out.textContent = '—'; });
    drawViz();
  }

  function updateParamViews() {
    var slot = slotOf(P.owner, P.fxId);
    if (!slot) return;
    var d = D.PLUGINS[slot.type], q = D.resolve(slot);
    root.querySelectorAll('.mx-p').forEach(function (row) {
      var k = row.getAttribute('data-p'), pd = d.byKey[k];
      if (!pd || pd.opts) return;
      var inp = row.querySelector('input[type=range]'), val = row.querySelector('.mx-val');
      if (inp && document.activeElement !== inp) inp.value = Math.round(D.toNorm(pd, q[k]) * 1000);
      if (val) val.textContent = D.fmtValue(pd, q[k]);
    });
  }

  function onFader(t, done) {
    var k = t.getAttribute('data-fader'), v = +t.value, key = P.owner, kind = ownerKind(key);
    var out = t.parentNode.querySelector('output');
    if (!done) {
      live(function (p) {
        if (k === 'vol') { if (kind === 'track') M.setTrack(p, key, { volDb: v }); else if (kind === 'master') M.setMaster(p, { volDb: v }); else M.setBus(p, key, { volDb: v }); }
        else if (k === 'pan') M.setTrack(p, key, { pan: v });
        else if (k.indexOf('send:') === 0) M.setSend(p, key, k.slice(5), v);
      });
      if (out) out.textContent = k === 'pan' ? panLabel(v) : k.indexOf('send:') === 0 ? fmtSend(v) : fmtDb(v);
      recordLevel(k, v);
      if (kind === 'track') A.buildHeads();
      return;
    }
    finishRecord();
    endLive();
  }

  /* ------------------------------------------------ automation recording */

  // While "● Auto" is on and the song plays, a control being moved writes
  // its values into its lane. On release the take is thinned to the fewest
  // points that stay within 1% of what was played, and replaces whatever the
  // lane held over the same stretch of time.
  function recordParam(k, v) {
    if (!P.rec || !E.isPlaying() || ownerKind(P.owner) !== 'track') { laneHint('fx:' + P.fxId + ':' + k); return; }
    var path = 'fx:' + P.fxId + ':' + k;
    var pd = D.PLUGINS[slotOf(P.owner, P.fxId).type].byKey[k];
    take(path, path, (pd.max - pd.min) * 0.01).push([E.position(), v]);
  }
  function recordLevel(k, v) {
    var ok = ownerKind(P.owner) === 'track' || (P.owner === 'master' && k === 'vol');
    if (!P.rec || !E.isPlaying() || !ok) { laneHint(k); return; }
    take(k, P.owner + '|' + k, k === 'pan' ? 0.01 : 0.5).push([E.position(), v]);
  }
  // One gesture can move several lanes at once (a smart control drives
  // several parameters), so a take holds a lane per path until release.
  function take(path, holdKey, tol) {
    if (P.recBuf && P.recBuf.owner !== P.owner) finishRecord();
    if (!P.recBuf) P.recBuf = { owner: P.owner, lanes: {} };
    var L = P.recBuf.lanes[path];
    if (!L) { L = P.recBuf.lanes[path] = { hold: holdKey, tol: tol, pts: [] }; E.hold(holdKey, true); }
    return L.pts;
  }
  function finishRecord() {
    var r = P.recBuf;
    if (!r) return;
    P.recBuf = null;
    var n = 0, shown = null;
    Object.keys(r.lanes).forEach(function (path) {
      var L = r.lanes[path];
      E.hold(L.hold, false);
      if (L.pts.length < 2) return;
      var pts = M.thinPoints(L.pts, L.tol), t0 = pts[0][0], t1 = pts[pts.length - 1][0];
      var o = M.owner(proj(), r.owner), old = (o.auto && o.auto[path]) || [];
      var kept = old.filter(function (pt) { return pt[0] < t0 - 1e-3 || pt[0] > t1 + 1e-3; });
      M.setAutoPoints(proj(), r.owner, path, kept.concat(pts));
      n += pts.length;
      shown = path;
    });
    if (shown && ownerKind(r.owner) === 'track') A.S.autoLanes[r.owner] = shown;
    E.relane(proj());
    E.syncFx(proj());
    if (n) A.toast('Automation recorded — ' + n + ' points');
  }

  // Moving a control that has a lane, without recording, changes the value
  // under the lane, which the lane then overrides. Say so once.
  var hinted = false;
  function laneHint(path) {
    if (hinted || !E.isPlaying()) return;
    var o = M.owner(proj(), P.owner);
    if (!o || !o.auto || !o.auto[path]) return;
    hinted = true;
    A.toast('This control follows its automation lane. Turn on ● Auto to re-record it.');
  }

  /* --------------------------------------------------------- automation */

  function automate(k) {
    var key = P.owner, path = 'fx:' + P.fxId + ':' + k;
    var o = M.owner(proj(), key);
    if (!o.auto[path]) {
      var v = D.resolve(slotOf(key, P.fxId))[k];
      commit(function (p) { M.setAutoPoints(p, key, path, [[Math.max(0, A.S.playhead), v]]); });
      A.toast('Lane added under the track — tap it to add points, drag them to shape it');
    }
    A.S.autoLanes[key] = path;
    A.refresh();
    render();
  }

  // Everything that can carry a lane on a track, for the lane picker.
  function lanePaths(track) {
    var out = [['vol', 'Volume'], ['pan', 'Pan']];
    proj().buses.forEach(function (b) { out.push(['send:' + b.id, 'Send: ' + b.name]); });
    track.fx.forEach(function (s) {
      var d = D.PLUGINS[s.type];
      if (!d) return;
      d.params.forEach(function (pd) { if (!pd.opts) out.push(['fx:' + s.id + ':' + pd.k, d.name + ': ' + pd.label]); });
    });
    return out;
  }

  // Range, scale and formatting for a lane, so the timeline can draw and
  // edit it in the units of the thing it controls.
  function laneInfo(track, path) {
    if (path === 'vol') return scale('Volume', -60, 12, 0, track.volDb || 0, fmtDb);
    if (path === 'pan') return scale('Pan', -1, 1, 0, track.pan || 0, panLabel);
    if (path.indexOf('send:') === 0) {
      var b = proj().buses.filter(function (x) { return x.id === path.slice(5); })[0];
      return scale('Send: ' + (b ? b.name : '?'), -60, 6, -60, track.sends[path.slice(5)] > -60 ? track.sends[path.slice(5)] : -60, fmtSend);
    }
    var m = /^fx:([^:]+):(.+)$/.exec(path);
    if (m) {
      var slot = track.fx.filter(function (s) { return s.id === m[1]; })[0], d = slot && D.PLUGINS[slot.type], pd = d && d.byKey[m[2]];
      if (!pd) return null;
      return {
        label: d.name + ': ' + pd.label, min: pd.min, max: pd.max, value: D.resolve(slot)[pd.k],
        toNorm: function (v) { return D.toNorm(pd, v); }, fromNorm: function (n) { return D.fromNorm(pd, n); },
        fmt: function (v) { return D.fmtValue(pd, v); }
      };
    }
    return null;
    function scale(label, min, max, def, value, fmt) {
      return {
        label: label, min: min, max: max, value: value, fmt: fmt,
        toNorm: function (v) { return clamp((v - min) / (max - min), 0, 1); },
        fromNorm: function (n) { var v = min + (max - min) * clamp(n, 0, 1); return Math.round(v * 100) / 100; }
      };
    }
  }

  /* ------------------------------------------------------- presets, A/B */

  function applyPreset(v) {
    if (!v) return;
    var slot = slotOf(P.owner, P.fxId), name = v.slice(2), params;
    if (v[0] === 'f') params = D.presetSlot(slot.type, name).params;
    else {
      var u = userPresets(slot.type).filter(function (x) { return x.name === name; })[0];
      if (!u) return;
      params = Object.assign(D.defaults(slot.type), u.p);
    }
    commit(function (p) { M.setFx(p, P.owner, P.fxId, { params: params, m: null }); });
    render();
    A.toast(name);
  }

  function abSwitch(to) {
    var slot = slotOf(P.owner, P.fxId);
    var ab = P.ab[slot.id] || (P.ab[slot.id] = { cur: 'A' });
    if (ab.cur === to) return;
    var here = { params: JSON.parse(JSON.stringify(slot.params)), m: slot.m ? JSON.parse(JSON.stringify(slot.m)) : null };
    var there = ab[to] || here;
    ab[ab.cur] = here;
    ab.cur = to;
    commit(function (p) {
      var s = slotOf(P.owner, P.fxId);
      s.params = JSON.parse(JSON.stringify(there.params));
      if (there.m) s.m = JSON.parse(JSON.stringify(there.m)); else delete s.m;
    });
    render();
    A.toast(to === 'B' && !ab.B ? 'B is a copy of A — change it, then switch back to compare' : 'Setting ' + to);
  }

  function moreSheet() {
    var slot = slotOf(P.owner, P.fxId), d = D.PLUGINS[slot.type];
    var mine = userPresets(slot.type);
    A.openSheet(d.name, A.menuHtml([
      { v: 'save', label: 'Save these settings as a preset' },
      { v: 'reset', label: 'Reset to default' },
      { v: 'copy', label: 'Duplicate this effect' }
    ].concat(mine.length ? ['-'].concat(mine.map(function (x) { return { v: 'del:' + x.name, label: 'Delete preset “' + x.name + '”', danger: true }; })) : [])
      .concat(['-', { v: 'remove', label: 'Remove from ' + ownerName(P.owner), danger: true }])), function (v) {
      if (v === 'save') { askName('Preset name', d.name + ' ' + (mine.length + 1), function (name) { saveUserPreset(slot.type, name, D.resolve(slotOf(P.owner, P.fxId))); render(); A.toast('Saved “' + name + '”'); }); return; }
      A.closeSheet();
      if (v === 'reset') { var f = D.fresh(slot.type); commit(function (p) { var s = slotOf(P.owner, P.fxId); s.params = f.params; if (f.m) s.m = f.m; else delete s.m; }); render(); }
      if (v === 'copy') {
        var id, i = M.chainOf(proj(), P.owner).indexOf(slot);
        commit(function (p) { id = M.addFx(p, P.owner, slot.type, slot.params, i + 1, slot.m); });
        P.fxId = id; render();
      }
      if (v === 'remove') { commit(function (p) { M.removeFx(p, P.owner, P.fxId); }); P.view = 'strip'; render(); }
      if (v.indexOf('del:') === 0) { deleteUserPreset(slot.type, v.slice(4)); render(); }
    });
  }

  function askName(title, def, done) {
    A.openSheet(title, '<div class="ed-form"><label>Name <input type="text" data-k="name" maxlength="40" value="' + esc(def) + '"></label></div>' +
      '<div class="ed-sheet-actions"><button type="button" class="ed-btn" data-v="cancel">Cancel</button><button type="button" class="ed-btn ed-btn-primary" data-v="ok">Save</button></div>', function (v) {
      var inp = A.el.sheetBody.querySelector('[data-k="name"]');
      var name = inp && inp.value.trim();
      A.closeSheet();
      if (v === 'ok' && name) done(name);
    });
    var inp = A.el.sheetBody.querySelector('[data-k="name"]');
    if (inp) { inp.select(); inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { var n = inp.value.trim(); A.closeSheet(); if (n) done(n); } }); }
  }

  function renameBus() {
    var key = P.owner;
    askName('Rename bus', ownerName(key), function (name) { commit(function (p) { M.setBus(p, key, { name: name }); }); render(); });
  }

  function typeValue(btn) {
    var k = btn.getAttribute('data-k'), slot = slotOf(P.owner, P.fxId), pd = D.PLUGINS[slot.type].byKey[k], q = D.resolve(slot);
    var inp = document.createElement('input');
    inp.type = 'number'; inp.step = 'any'; inp.min = pd.min; inp.max = pd.max; inp.value = +(+q[k]).toFixed(3);
    inp.className = 'mx-typed';
    inp.setAttribute('aria-label', pd.label + ' (' + pd.min + ' to ' + pd.max + (pd.unit ? ' ' + pd.unit : '') + ')');
    btn.replaceWith(inp);
    inp.focus(); inp.select();
    var done = false;
    function finish(ok) {
      if (done) return;
      done = true;
      var v = parseFloat(inp.value);
      if (ok && isFinite(v)) setParam(k, clamp(v, pd.min, pd.max), true);
      else render();
    }
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') { e.stopPropagation(); finish(false); } });
    inp.addEventListener('blur', function () { finish(true); });
  }

  /* ------------------------------------------------------------ patches */

  function patchSheet() {
    var key = P.owner, kind = ownerKind(key) === 'master' ? 'master' : 'track';
    var list = D.PATCHES.filter(function (x) { return x.for === kind || x.for === 'both'; });
    var mine = userPatches().filter(function (x) { return x.for === kind || x.for === 'both'; });
    var items = list.map(function (x, i) { return { v: 'f' + D.PATCHES.indexOf(x), label: x.name, hint: x.desc }; });
    if (mine.length) items = items.concat(['-'], mine.map(function (x) { return { v: 'u' + x.name, label: x.name, hint: 'yours · ' + x.chain.length + ' effects' }; }));
    items = items.concat(['-', { v: 'save', label: 'Save this chain as a patch', disabled: !M.chainOf(proj(), key).length },
      { v: 'clear', label: 'Remove every effect here', danger: true, disabled: !M.chainOf(proj(), key).length }]);
    A.openSheet('Patches for ' + ownerName(key), '<p class="ed-sheet-note mx-sheet-lead">A patch replaces the whole effect chain. Undo puts the old one back.</p>' + A.menuHtml(items), function (v) {
      if (v === 'save') {
        askName('Patch name', ownerName(key) + ' chain', function (name) {
          var all = userPatches().filter(function (x) { return x.name !== name; });
          all.push({ name: name, for: kind, chain: M.chainOf(proj(), key).map(function (s) { return { type: s.type, on: s.on !== false, params: s.params, m: s.m || null }; }) });
          save('as_ed_patches', all);
          A.toast('Saved patch “' + name + '”');
        });
        return;
      }
      A.closeSheet();
      var chain = null, name = '';
      if (v === 'clear') chain = [];
      else if (v[0] === 'f') { var pt = D.PATCHES[+v.slice(1)]; chain = D.patchChain(pt); name = pt.name; }
      else if (v[0] === 'u') {
        var up = userPatches().filter(function (x) { return x.name === v.slice(1); })[0];
        if (up) { chain = up.chain; name = up.name; }
      }
      if (!chain) return;
      // The ducker listens to another track; point it at the first one.
      chain.forEach(function (s) {
        if (s.type === 'ducker' && !(s.params && s.params.src)) {
          var other = proj().tracks.filter(function (t) { return t.id !== key; })[0];
          if (other) s.params.src = other.id;
        }
      });
      commit(function (p) { M.setChain(p, key, chain); });
      P.view = 'strip';
      render();
      A.toast(name ? name + ' loaded' : 'Effects cleared');
    }, 'ed-sheet-wide');
  }

  /* ---------------------------------------------------------- pictures */

  function vizKind(type) {
    if (type === 'eq' || type === 'filter') return 'curve';
    if (type === 'comp') return 'transfer';
    if (type === 'analyzer') return 'spectrum';
    if (type === 'multiband') return 'bands';
    return null;
  }

  var FREQS = null;
  function freqs(n) {
    if (FREQS && FREQS.length === n) return FREQS;
    FREQS = [];
    for (var i = 0; i < n; i++) FREQS.push(20 * Math.pow(1000, i / (n - 1)));
    return FREQS;
  }
  function fx2x(f, w) { return Math.log(f / 20) / Math.log(1000) * w; }
  function x2f(x, w) { return 20 * Math.pow(1000, clamp(x / w, 0, 1)); }
  var DBR = 24;
  function db2y(db, h) { return h / 2 - db / DBR * (h / 2 - 8); }
  function y2db(y, h) { return (h / 2 - y) / (h / 2 - 8) * DBR; }

  function colors() {
    var s = getComputedStyle(document.documentElement);
    function v(n, d) { return (s.getPropertyValue(n) || '').trim() || d; }
    return { ink: v('--ink', '#1a1814'), muted: v('--muted', '#6b6152'), rule: v('--rule', '#d8cbb2'), amber: v('--amber', '#c2410c'), paper: v('--paper', '#fbf6ed'), mono: v('--mono', 'monospace') };
  }

  var specBuf = null;
  function drawViz(probe) {
    var cv = root && root.querySelector('.mx-canvas');
    if (!cv) return;
    var slot = slotOf(P.owner, P.fxId);
    if (!slot) return;
    var dpr = global.devicePixelRatio || 1, w = cv.clientWidth || 300, h = 150;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    var g = cv.getContext('2d'), c = colors(), kind = cv.getAttribute('data-viz'), q = D.resolve(slot);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.font = '10px ' + c.mono;
    g.fillStyle = c.muted;

    if (kind === 'curve' || kind === 'spectrum' || kind === 'bands') {
      // Grid: octaves and 6 dB lines.
      g.strokeStyle = c.rule; g.lineWidth = 1;
      [50, 100, 200, 500, 1000, 2000, 5000, 10000].forEach(function (f) {
        var x = Math.round(fx2x(f, w)) + 0.5;
        g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
        g.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), x + 2, h - 3);
      });
      if (kind !== 'spectrum') [-12, 0, 12].forEach(function (d) {
        var y = Math.round(db2y(d, h)) + 0.5;
        g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
        g.fillText((d > 0 ? '+' : '') + d, 2, y - 2);
      });
    }

    // Live spectrum behind the curve.
    if (probe && probe.spectrum && (kind === 'curve' || kind === 'spectrum')) {
      if (!specBuf || specBuf.length !== probe.bins) specBuf = new Float32Array(probe.bins);
      probe.spectrum(specBuf);
      g.beginPath();
      var nyq = probe.sampleRate / 2;
      for (var x = 0; x <= w; x += 2) {
        var f = x2f(x, w), bin = Math.min(specBuf.length - 1, Math.round(f / nyq * specBuf.length));
        var v = specBuf[bin];
        var y = h - clamp((v + 100) / 90, 0, 1) * (h - 12);
        if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.lineTo(w, h); g.lineTo(0, h); g.closePath();
      g.fillStyle = 'rgba(194,65,12,0.14)'; g.fill();
    } else if (kind === 'spectrum') {
      g.fillStyle = c.muted; g.font = '12px sans-serif';
      g.fillText('Play to see the spectrum', 12, h / 2);
    }

    if (kind === 'curve') {
      var fs = freqs(Math.max(64, Math.round(w / 2))), r = D.response(slot.type, q, fs, 48000);
      g.beginPath();
      fs.forEach(function (f, i) { var xx = fx2x(f, w), yy = clamp(db2y(r[i], h), -2, h + 2); if (i) g.lineTo(xx, yy); else g.moveTo(xx, yy); });
      g.strokeStyle = slot.on === false ? c.muted : c.amber; g.lineWidth = 2; g.stroke();
      handles(slot, q, w, h).forEach(function (hd) {
        g.beginPath(); g.arc(hd.x, hd.y, 7, 0, Math.PI * 2);
        g.fillStyle = hd.active ? c.amber : c.paper; g.fill();
        g.strokeStyle = c.amber; g.lineWidth = 2; g.stroke();
        g.fillStyle = hd.active ? '#fff' : c.ink; g.font = '600 9px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(hd.label, hd.x, hd.y + 0.5);
        g.textAlign = 'left'; g.textBaseline = 'alphabetic';
      });
    }

    if (kind === 'transfer') {
      // Input level across, output level up, -60..0 dB.
      var toX = function (dB) { return (dB + 60) / 60 * (w - 20) + 10; }, toY = function (dB) { return h - 10 - (dB + 60) / 60 * (h - 20); };
      g.strokeStyle = c.rule; g.lineWidth = 1;
      [-48, -36, -24, -12, 0].forEach(function (dB) {
        g.beginPath(); g.moveTo(toX(dB), 10); g.lineTo(toX(dB), h - 10); g.stroke();
        g.beginPath(); g.moveTo(10, toY(dB)); g.lineTo(w - 10, toY(dB)); g.stroke();
      });
      g.setLineDash([4, 4]); g.beginPath(); g.moveTo(toX(-60), toY(-60)); g.lineTo(toX(0), toY(0)); g.stroke(); g.setLineDash([]);
      var mk = q.makeup + (q.auto === 'on' ? Math.max(0, -(q.thresh * (1 - 1 / q.ratio)) * 0.5) : 0);
      g.beginPath();
      for (var i2 = 0; i2 <= 120; i2++) {
        var L = -60 + i2 / 2, over = L - q.thresh, W = q.knee, gr;
        if (2 * over < -W) gr = 0;
        else if (W > 0 && 2 * Math.abs(over) <= W) gr = (1 / q.ratio - 1) * (over + W / 2) * (over + W / 2) / (2 * W);
        else gr = (1 / q.ratio - 1) * over;
        var out = L + gr + mk;
        if (i2) g.lineTo(toX(L), clamp(toY(out), 0, h)); else g.moveTo(toX(L), clamp(toY(out), 0, h));
      }
      g.strokeStyle = c.amber; g.lineWidth = 2; g.stroke();
      g.fillStyle = c.muted; g.fillText('in →', w - 38, h - 14); g.fillText('out ↑', 12, 20);
      var tx = toX(q.thresh);
      g.fillStyle = c.amber; g.fillRect(tx - 0.5, 10, 1, h - 20);
    }

    if (kind === 'bands') {
      [q.x1, q.x2].forEach(function (f) { var xx = fx2x(f, w); g.fillStyle = c.amber; g.fillRect(xx - 1, 0, 2, h); });
      var bands = probe && probe.bands ? probe.bands : [0, 0, 0];
      var edges = [20, q.x1, q.x2, 20000];
      ['Low', 'Mid', 'High'].forEach(function (nm, i) {
        var a = fx2x(edges[i], w), b = fx2x(edges[i + 1], w), gr = Math.min(0, bands[i] || 0);
        var bh = clamp(-gr / 24, 0, 1) * (h - 30);
        g.fillStyle = 'rgba(194,65,12,0.35)'; g.fillRect(a + 4, 14, b - a - 8, bh);
        g.fillStyle = c.ink; g.font = '600 11px sans-serif'; g.fillText(nm, a + 8, h - 16);
        g.fillStyle = c.muted; g.font = '10px ' + c.mono; g.fillText(gr < -0.05 ? gr.toFixed(1) + ' dB' : '', a + 8, h - 30);
      });
    }
  }

  // Draggable dots on the EQ or filter curve.
  function handles(slot, q, w, h) {
    var out = [];
    if (slot.type === 'filter') {
      out.push({ x: fx2x(q.freq, w), y: db2y(clamp(q.res, 0, 24) * 0.5, h), label: '•', kf: 'freq', kg: 'res', gScale: 2, active: true });
      return out;
    }
    out.push({ x: fx2x(q.hpFreq, w), y: db2y(0, h), label: 'L', kf: 'hpFreq', on: 'hpOn', active: q.hpOn === 'on' });
    out.push({ x: fx2x(q.lsFreq, w), y: db2y(q.lsGain, h), label: 'S', kf: 'lsFreq', kg: 'lsGain', active: Math.abs(q.lsGain) > 0.05 });
    [1, 2, 3, 4].forEach(function (i) {
      out.push({ x: fx2x(q['p' + i + 'Freq'], w), y: db2y(q['p' + i + 'Gain'], h), label: String(i), kf: 'p' + i + 'Freq', kg: 'p' + i + 'Gain', active: Math.abs(q['p' + i + 'Gain']) > 0.05 });
    });
    out.push({ x: fx2x(q.hsFreq, w), y: db2y(q.hsGain, h), label: 'S', kf: 'hsFreq', kg: 'hsGain', active: Math.abs(q.hsGain) > 0.05 });
    out.push({ x: fx2x(q.lpFreq, w), y: db2y(0, h), label: 'H', kf: 'lpFreq', on: 'lpOn', active: q.lpOn === 'on' });
    return out;
  }

  var vdrag = null;
  function onVizDown(e) {
    var cv = e.target.closest && e.target.closest('.mx-canvas[data-viz="curve"]');
    if (!cv) return;
    var slot = slotOf(P.owner, P.fxId), q = D.resolve(slot), r = cv.getBoundingClientRect(), w = r.width, h = 150;
    var x = e.clientX - r.left, y = e.clientY - r.top, best = null, bd = e.pointerType === 'mouse' ? 14 : 24;
    handles(slot, q, w, h).forEach(function (hd) { var d = Math.hypot(hd.x - x, hd.y - y); if (d < bd) { bd = d; best = hd; } });
    if (!best) return;
    e.preventDefault();
    cv.setPointerCapture(e.pointerId);
    vdrag = { hd: best, cv: cv, w: w, h: h };
    function move(ev) {
      if (!vdrag) return;
      var rr = cv.getBoundingClientRect(), xx = ev.clientX - rr.left, yy = ev.clientY - rr.top, patch = {};
      var s = slotOf(P.owner, P.fxId), d = D.PLUGINS[s.type];
      patch[vdrag.hd.kf] = D.snapStep(d.byKey[vdrag.hd.kf], x2f(xx, vdrag.w));
      if (vdrag.hd.kg) patch[vdrag.hd.kg] = D.snapStep(d.byKey[vdrag.hd.kg], y2db(yy, vdrag.h) * (vdrag.hd.gScale || 1));
      if (vdrag.hd.on) patch[vdrag.hd.on] = 'on';
      live(function (p) { M.setFx(p, P.owner, P.fxId, { params: patch, m: null }); });
      Object.keys(patch).forEach(function (k) { if (typeof patch[k] === 'number') recordParam(k, patch[k]); });
      updateParamViews();
      drawViz();
    }
    function up() {
      cv.removeEventListener('pointermove', move);
      cv.removeEventListener('pointerup', up);
      cv.removeEventListener('pointercancel', up);
      vdrag = null;
      finishRecord();
      endLive();
    }
    cv.addEventListener('pointermove', move);
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
  }

  /* ------------------------------------------------------------- meters */

  var raf = 0;
  function loop() {
    if (raf) return;
    raf = requestAnimationFrame(function tick() {
      raf = 0;
      if (!P.open) return;
      frame();
      raf = requestAnimationFrame(tick);
    });
  }
  function bar(el, peak) {
    if (!el) return;
    el.style.transform = 'scaleX(' + Math.min(1, Math.pow(peak, 0.5)) + ')';
    el.classList.toggle('hot', peak > 0.98);
  }
  var lastNote = null, vizTick = 0;
  function frame() {
    var playing = E.isPlaying();
    bar(root.querySelector('[data-meter="level"]'), playing ? E.trackPeak(P.owner) : 0);
    if (P.view !== 'edit') return;
    var pr = playing ? E.probe(P.fxId) : null;
    bar(root.querySelector('[data-meter="in"]'), pr ? pr.inPeak : 0);
    bar(root.querySelector('[data-meter="out"]'), pr ? pr.outPeak : 0);
    var grEl = root.querySelector('[data-meter="gr"]');
    if (grEl) {
      var gr = pr && pr.gr != null ? Math.min(0, pr.gr) : 0;
      grEl.style.transform = 'scaleX(' + clamp(-gr / 24, 0, 1) + ')';
      var t = root.querySelector('[data-gr]');
      if (t) t.textContent = gr < -0.05 ? gr.toFixed(1) + ' dB' : '';
    }
    var note = pr && pr.note ? pr.note : null, nel = root.querySelector('[data-note]');
    if (nel && note !== lastNote) { lastNote = note; nel.hidden = !note; nel.textContent = note || ''; }
    // The picture only needs redrawing when there is live data for it.
    if (pr && ++vizTick % 2 === 0 && !vdrag) drawViz(pr);
    // Sliders with automation follow the playhead.
    if (playing) {
      var slot = slotOf(P.owner, P.fxId), o = M.owner(proj(), P.owner);
      if (slot && o && o.auto) {
        var t2 = E.position(), d = D.PLUGINS[slot.type];
        Object.keys(o.auto).forEach(function (path) {
          if (path.indexOf('fx:' + slot.id + ':') !== 0) return;
          var k = path.split(':')[2], pd = d.byKey[k], inp = root.querySelector('input[data-k="' + k + '"]');
          if (!pd || !inp || document.activeElement === inp) return;
          var v = M.autoValueAt(o.auto[path], t2);
          inp.value = Math.round(D.toNorm(pd, v) * 1000);
          var vb = root.querySelector('[data-p="' + k + '"] .mx-val');
          if (vb) vb.textContent = D.fmtValue(pd, v);
        });
      }
    }
  }

  global.ASEditFxUI = {
    init: init, open: open, close: close, isOpen: isOpen, refresh: refresh,
    lanePaths: lanePaths, laneInfo: laneInfo, finishRecord: finishRecord
  };
})(window);
