/*
 * The audio editor's controller: state, gestures, keyboard, menus, import,
 * export, recording and autosave. The model (editor-model.js) decides what an
 * edit means, the engine plays it, the view draws it; this file decides what a
 * tap, a drag or a key press is asking for.
 *
 * Touch and mouse deliberately behave differently in one place. With a mouse,
 * pressing on a clip and dragging moves it. With a finger, a clip usually fills
 * most of a phone screen, so "drag to move" would leave nowhere to scroll from;
 * an unselected clip therefore pans, and only a selected one moves. Tap selects,
 * long-press opens the clip menu, two fingers zoom. Everything else — handles,
 * snapping, the bottom toolbar — is the same code for both.
 */
(function (global) {
  'use strict';

  var CV = global.CV, M = global.ASEditModel, E = global.ASEditEngine;
  var V = global.ASEditView, FX = global.ASEditFx, ST = global.ASEditStore;
  if (!CV || !M || !E || !V || !FX || !ST) {
    console.error('[audio-editor] a script is missing or loaded out of order; the editor cannot start.');
    return;
  }
  var $ = CV.$;

  var ACCEPT = ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus', '.aif', '.aiff',
    '.m4b', '.m4r', '.wma', '.caf', '.ac3', '.weba', '.amr', '.3gp',
    '.mp4', '.mov', '.webm', '.mkv', '.avi', '.audiosaw'];

  /* ----------------------------------------------------------------- state */

  var S = {
    project: M.create(),
    sel: {},                 // clipId -> true
    selTrack: null,
    range: null,             // { t0, t1, tracks: [ids] | null }
    playhead: 0,
    scrollT: 0,
    pps: 40,
    trackH: 96,
    loop: false,
    snap: true,
    drag: null,
    rec: null,
    snapAt: null,
    viewTop: 0, viewH: 400
  };
  var hist = new M.History(200);
  var files = new Map();     // sourceId -> original File, for autosave and project files
  var clipboard = null;
  var playStart = 0;         // where the current playback began

  var el = {
    ed: $('#ed'), stage: $('#edStage'), scroll: $('#edScroll'), heads: $('#edHeads'),
    ruler: $('#edRuler'), lanes: $('#edLanes'), empty: $('#dropzone'), fileInput: $('#fileInput'),
    play: $('#edPlay'), time: $('#edTime'), total: $('#edTotal'), rec: $('#edRec'),
    undo: $('#edUndo'), redo: $('#edRedo'), loop: $('#edLoop'), tools: $('#edTools'),
    insp: $('#edInspector'), status: $('#status'), progWrap: $('#progressWrap'), prog: $('#progressBar'),
    sheet: $('#edSheet'), sheetTitle: $('#edSheetTitle'), sheetBody: $('#edSheetBody'),
    exportSheet: $('#edExportSheet'), hbar: $('#edHbar'), thumb: $('#edThumb'),
    meterL: $('#edMeterL'), meterR: $('#edMeterR'), saved: $('#edSaved'), restore: $('#edRestore')
  };
  if (!el.ed || !el.lanes) return;

  var view = new V.View({ ruler: el.ruler, lanes: el.lanes, state: S });
  view.touch = isTouchUI();
  E.buffers = E.buffers || new Map();
  var buffers = E.buffers;

  /* --------------------------------------------------------------- helpers */

  function fmt(t, withMs) {
    t = Math.max(0, t || 0);
    var h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t - Math.floor(t / 60) * 60;
    var ss = withMs === false ? String(Math.floor(s)) : s.toFixed(2);
    if (s < 10) ss = '0' + ss;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + ss;
  }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function selIds() { return Object.keys(S.sel).filter(function (id) { return M.findClip(S.project, id); }); }
  function hasClips() { return M.allClips(S.project).length > 0; }
  function isTouchUI() { return global.matchMedia && global.matchMedia('(pointer: coarse)').matches; }
  function lanesWidth() { return el.lanes.clientWidth || 600; }
  function status(kind, msg) { CV.setStatus(el.status, kind, msg); }
  function clearStatus() { CV.clearStatus(el.status); }
  function progress(pct) {
    if (pct == null) { el.progWrap.style.display = 'none'; CV.setProgress(el.prog, 0); return; }
    el.progWrap.style.display = '';
    CV.setProgress(el.prog, pct);
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }
  function baseName(n) { return String(n || 'audio').replace(/\.[^.]+$/, ''); }

  /* ------------------------------------------------------------- editing */

  // Every edit goes through here: snapshot, mutate, and record the snapshot
  // only if something actually changed.
  function edit(fn, opts) {
    var before = M.serialize(S.project);
    var out = fn(S.project);
    if (M.serialize(S.project) !== before) {
      hist.push(before);
      changed(opts);
    }
    return out;
  }

  // For gestures that mutate live (trim, fade, sliders): take the snapshot at
  // the start and commit it once at the end.
  var liveSnap = null;
  function beginLive() { if (liveSnap === null) liveSnap = M.serialize(S.project); }
  function endLive() {
    if (liveSnap === null) return;
    if (M.serialize(S.project) !== liveSnap) { hist.push(liveSnap); changed(); }
    liveSnap = null;
  }
  function cancelLive() {
    if (liveSnap === null) return;
    S.project = M.parse(liveSnap);
    liveSnap = null;
    refresh();
  }

  function changed(opts) {
    pruneSelection();
    if (E.isPlaying() && !(opts && opts.noRestart)) restartPlayback();
    scheduleSave();
    refresh();
  }

  function pruneSelection() {
    Object.keys(S.sel).forEach(function (id) { if (!M.findClip(S.project, id)) delete S.sel[id]; });
    if (S.selTrack && M.trackIndex(S.project, S.selTrack) < 0) S.selTrack = null;
    if (S.range && S.range.tracks) {
      S.range.tracks = S.range.tracks.filter(function (id) { return M.trackIndex(S.project, id) >= 0; });
      if (!S.range.tracks.length) S.range.tracks = null;
    }
  }

  function undo() {
    var prev = hist.undo(M.serialize(S.project));
    if (prev === null) return;
    S.project = M.parse(prev);
    changed();
    toast('Undone');
  }
  function redo() {
    var next = hist.redo(M.serialize(S.project));
    if (next === null) return;
    S.project = M.parse(next);
    changed();
    toast('Redone');
  }

  /* ------------------------------------------------------------ rendering */

  var raf = 0, endTimer = 0;
  function draw() { view.dirty = true; if (!raf) raf = requestAnimationFrame(frame); }

  // Stop or loop at the end. Called from the animation loop and from a timer,
  // because a background tab gets no animation frames at all and would
  // otherwise never stop, or never come round again when looping.
  function checkEnd() {
    if (!E.isPlaying() || S.rec) return E.position();
    var pos = E.position();
    if (pos < E.playEnd() - 0.005) return pos;
    if (S.loop) {
      var r = loopRange();
      startPlayback(r[0], r[1]);
      return r[0];
    }
    E.stop();
    S.playhead = playStart;
    updateTransport();
    draw();
    return playStart;
  }

  function frame() {
    raf = 0;
    var keep = false;
    if (E.isPlaying()) {
      keep = true;
      var pos = checkEnd();
      S.playhead = pos;
      follow();
      var m = E.meter();
      setMeter(m[0], m[1]);
    } else {
      setMeter(0, 0);
    }
    if (S.rec) { keep = true; follow(); }
    view.draw();
    updateTime();
    if (keep) raf = requestAnimationFrame(frame);
  }

  function setMeter(l, r) {
    if (!el.meterL) return;
    el.meterL.style.transform = 'scaleX(' + Math.min(1, Math.pow(l, 0.5)) + ')';
    el.meterR.style.transform = 'scaleX(' + Math.min(1, Math.pow(r, 0.5)) + ')';
    el.meterL.classList.toggle('hot', l > 0.98);
    el.meterR.classList.toggle('hot', r > 0.98);
  }

  // Keep the playhead on screen by paging, not by continuous scrolling: a
  // waveform that slides under a fixed line is harder to read.
  function follow() {
    if (S.drag) return;
    var w = lanesWidth(), x = view.x(S.playhead);
    if (x > w * 0.9 || x < 0) { S.scrollT = Math.max(0, S.playhead - (w * 0.1) / S.pps); updateHbar(); }
  }

  function updateTime() {
    el.time.textContent = fmt(S.playhead);
    var d = M.duration(S.project);
    if (el.total) el.total.textContent = fmt(d, false);
  }

  function refresh() {
    buildHeads();
    view.resize();
    updateToolbar();
    updateInspector();
    updateTransport();
    updateEmpty();
    updateHbar();
    draw();
  }

  /* ---------------------------------------------------------------- zoom */

  function zoomLimits() {
    var w = lanesWidth();
    var d = Math.max(20, M.duration(S.project) * 1.25);
    return [Math.min(w / d, 5), 48000];
  }
  function zoomAt(factor, x) {
    var lim = zoomLimits();
    var t = view.t(x);
    S.pps = clamp(S.pps * factor, lim[0], lim[1]);
    S.scrollT = Math.max(0, t - x / S.pps);
    clampScroll();
    updateHbar();
    draw();
  }
  function zoomFit() {
    var w = lanesWidth(), d = M.duration(S.project);
    if (d <= 0) { S.pps = 40; S.scrollT = 0; draw(); return; }
    S.pps = clamp((w - 24) / d, zoomLimits()[0], 48000);
    S.scrollT = 0;
    updateHbar();
    draw();
  }
  function clampScroll() {
    var w = lanesWidth();
    var maxT = Math.max(0, M.duration(S.project) + (w * 0.5) / S.pps - w / S.pps);
    S.scrollT = clamp(S.scrollT, 0, Math.max(maxT, S.playhead - (w * 0.5) / S.pps, 0));
  }

  // The horizontal scrollbar under the timeline. A trackpad or a finger pans
  // the canvas directly; this is for a mouse wheel that only scrolls vertically.
  function updateHbar() {
    if (!el.hbar) return;
    var w = lanesWidth(), vis = w / S.pps;
    var total = Math.max(M.duration(S.project) + vis * 0.5, S.scrollT + vis, vis);
    var frac = Math.min(1, vis / total);
    el.hbar.hidden = !hasClips() || (S.scrollT <= 0 && M.duration(S.project) <= vis);
    var bw = el.hbar.clientWidth || w;
    el.thumb.style.width = Math.max(28, frac * bw) + 'px';
    el.thumb.style.transform = 'translateX(' + ((S.scrollT / total) * bw) + 'px)';
  }

  /* ---------------------------------------------------------- track heads */

  function buildHeads() {
    var h = S.trackH, p = S.project;
    var html = '';
    p.tracks.forEach(function (t, i) {
      var cls = 'ed-head' + (S.selTrack === t.id ? ' is-sel' : '') + (t.mute ? ' is-muted' : '');
      html += '<div class="' + cls + '" style="height:' + h + 'px" data-track="' + t.id + '">' +
        '<button type="button" class="ed-head-name" data-act="track" title="Track settings">' + esc(t.name) + '</button>' +
        '<div class="ed-head-btns">' +
        '<button type="button" class="ed-ms' + (t.mute ? ' on' : '') + '" data-act="mute" aria-pressed="' + t.mute + '" title="Mute">M</button>' +
        '<button type="button" class="ed-ms ed-solo' + (t.solo ? ' on' : '') + '" data-act="solo" aria-pressed="' + t.solo + '" title="Solo">S</button>' +
        '</div>' +
        '<label class="ed-vol"><span class="sr-only">Volume of ' + esc(t.name) + '</span>' +
        '<input type="range" min="-30" max="12" step="0.5" value="' + t.volDb + '" data-act="vol" aria-label="Volume of ' + esc(t.name) + '"></label>' +
        '</div>';
    });
    html += '<div class="ed-head ed-head-add" style="height:' + h + 'px"><button type="button" class="ed-addtrack" data-act="addtrack">+ Track</button></div>';
    el.heads.innerHTML = html;
  }

  el.heads.addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]');
    if (!b) return;
    var act = b.getAttribute('data-act');
    var head = b.closest('[data-track]');
    var id = head && head.getAttribute('data-track');
    if (act === 'addtrack') { edit(function (p) { S.selTrack = M.addTrack(p); }); return; }
    if (!id) return;
    var t = S.project.tracks[M.trackIndex(S.project, id)];
    if (act === 'mute') { edit(function (p) { M.setTrack(p, id, { mute: !t.mute }); }, { noRestart: true }); E.updateTracks(S.project); }
    if (act === 'solo') { edit(function (p) { M.setTrack(p, id, { solo: !t.solo }); }, { noRestart: true }); E.updateTracks(S.project); }
    if (act === 'track') { S.selTrack = id; refresh(); trackSheet(id); }
  });
  el.heads.addEventListener('input', function (e) {
    if (e.target.getAttribute('data-act') !== 'vol') return;
    var id = e.target.closest('[data-track]').getAttribute('data-track');
    beginLive();
    M.setTrack(S.project, id, { volDb: +e.target.value });
    E.updateTracks(S.project);
  });
  el.heads.addEventListener('change', function (e) {
    if (e.target.getAttribute('data-act') === 'vol') { endLive(); }
  });
  el.scroll.addEventListener('scroll', function () {
    S.viewTop = el.scroll.scrollTop; S.viewH = el.scroll.clientHeight; draw();
  });

  /* ------------------------------------------------------------ transport */

  function loopRange() {
    if (S.range) return [Math.min(S.range.t0, S.range.t1), Math.max(S.range.t0, S.range.t1)];
    return [0, M.duration(S.project)];
  }

  function startPlayback(from, to) {
    E.unlock();
    playStart = from;
    var ok = E.play(S.project, from, { to: to });
    S.playhead = from;
    clearTimeout(endTimer);
    if (ok && isFinite(to)) endTimer = setTimeout(function tick() {
      checkEnd();
      if (E.isPlaying() && !S.rec) endTimer = setTimeout(tick, 250);
    }, Math.max(50, (to - from) * 1000 - 200));
    updateTransport();
    draw();
    return ok;
  }

  function restartPlayback() {
    var pos = E.position();
    var end = E.playEnd();
    if (pos == null) return;
    var keepStart = playStart;
    startPlayback(pos, S.range ? Math.max(pos, end) : M.duration(S.project));
    playStart = keepStart;
  }

  function togglePlay() {
    if (S.rec) { stopRecording(); return; }
    if (E.isPlaying()) {
      S.playhead = E.position();
      E.stop();
      updateTransport();
      draw();
      return;
    }
    if (!hasClips()) return;
    var from = S.playhead, to = M.duration(S.project);
    if (S.range) {
      var r = loopRange();
      if (S.playhead < r[0] || S.playhead >= r[1] - 0.01) from = r[0];
      to = r[1];
    } else if (from >= to - 0.01) {
      from = 0;
    }
    startPlayback(from, to);
  }

  function seek(t) {
    S.playhead = Math.max(0, t);
    if (E.isPlaying()) startPlayback(S.playhead, S.range ? loopRange()[1] : M.duration(S.project));
    draw();
  }

  function updateTransport() {
    var playing = E.isPlaying();
    el.play.classList.toggle('is-playing', playing);
    el.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    el.play.innerHTML = playing ? ICON.pause : ICON.play;
    el.play.disabled = !hasClips() && !S.rec;
    el.undo.disabled = !hist.canUndo();
    el.redo.disabled = !hist.canRedo();
    el.loop.setAttribute('aria-pressed', String(S.loop));
    el.loop.classList.toggle('on', S.loop);
    el.rec.classList.toggle('is-rec', !!S.rec);
    el.rec.innerHTML = S.rec ? ICON.stop + '<span>Stop</span>' : ICON.rec + '<span>Record</span>';
  }

  el.play.addEventListener('click', togglePlay);
  $('#edHome').addEventListener('click', function () { seek(0); S.scrollT = 0; updateHbar(); draw(); });
  el.loop.addEventListener('click', function () { S.loop = !S.loop; updateTransport(); draw(); });
  el.undo.addEventListener('click', undo);
  el.redo.addEventListener('click', redo);

  /* -------------------------------------------------------------- toolbar */

  var ICON = {
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l13-7.5z" fill="currentColor"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h4.5v16H6zM13.5 4H18v16h-4.5z" fill="currentColor"/></svg>',
    stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor"/></svg>',
    rec: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="6.5" fill="currentColor"/></svg>',
    split: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M5 8l-2 4 2 4M19 8l2 4-2 4" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    del: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/></svg>',
    dup: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="7" width="11" height="11" rx="2" stroke="currentColor" stroke-width="2" fill="none"/><path d="M10 4h9a2 2 0 0 1 2 2v9" stroke="currentColor" stroke-width="2" fill="none"/></svg>',
    copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" stroke="currentColor" stroke-width="2" fill="none"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" stroke="currentColor" stroke-width="2" fill="none"/></svg>',
    paste: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6v3H9zM7 5.5H5v15h14v-15h-2" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/></svg>',
    fadein: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 19C9 19 12 5 21 5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>',
    fadeout: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5c9 0 12 14 18 14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>',
    fx: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linejoin="round"/></svg>',
    marker: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 21V4h11l-2.5 4L17 12H6" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/></svg>',
    zin: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" stroke-width="2" fill="none"/><path d="M15.5 15.5L21 21M7.5 10.5h6M10.5 7.5v6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    zout: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" stroke-width="2" fill="none"/><path d="M15.5 15.5L21 21M7.5 10.5h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    fit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>',
    snap: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3v8a6 6 0 0 0 12 0V3M6 7h4M14 7h4" stroke="currentColor" stroke-width="2" fill="none"/></svg>',
    cut: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="18" r="3" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="18" cy="18" r="3" stroke="currentColor" stroke-width="2" fill="none"/><path d="M8 16L19 4M16 16L5 4" stroke="currentColor" stroke-width="2"/></svg>'
  };

  var TOOLS = [
    { id: 'split', label: 'Split', icon: 'split', key: 'S' },
    { id: 'delete', label: 'Delete', icon: 'del', key: 'Del' },
    { id: 'duplicate', label: 'Duplicate', icon: 'dup', key: '⌘D' },
    { id: 'copy', label: 'Copy', icon: 'copy', key: '⌘C' },
    { id: 'paste', label: 'Paste', icon: 'paste', key: '⌘V' },
    { id: 'fadein', label: 'Fade in', icon: 'fadein' },
    { id: 'fadeout', label: 'Fade out', icon: 'fadeout' },
    { id: 'fx', label: 'Effects', icon: 'fx' },
    { id: 'marker', label: 'Marker', icon: 'marker', key: 'M' },
    { id: 'zoomout', label: 'Zoom out', icon: 'zout', key: '−' },
    { id: 'zoomin', label: 'Zoom in', icon: 'zin', key: '+' },
    { id: 'fit', label: 'Fit', icon: 'fit', key: '0' },
    { id: 'snap', label: 'Snap', icon: 'snap', key: 'N', toggle: true }
  ];

  el.tools.innerHTML = TOOLS.map(function (t) {
    return '<button type="button" class="ed-tool" data-tool="' + t.id + '"' +
      (t.toggle ? ' aria-pressed="true"' : '') +
      ' title="' + t.label + (t.key ? ' (' + t.key + ')' : '') + '">' + ICON[t.icon] + '<span>' + t.label + '</span></button>';
  }).join('');

  el.tools.addEventListener('click', function (e) {
    var b = e.target.closest('[data-tool]');
    if (b && !b.disabled) runTool(b.getAttribute('data-tool'));
  });

  function runTool(id) {
    switch (id) {
      case 'split': doSplit(); break;
      case 'delete': doDelete(false); break;
      case 'duplicate': doDuplicate(); break;
      case 'copy': doCopy(); break;
      case 'paste': doPaste(); break;
      case 'fadein': quickFade('in'); break;
      case 'fadeout': quickFade('out'); break;
      case 'fx': fxSheet(); break;
      case 'marker': edit(function (p) { M.addMarker(p, S.playhead); }, { noRestart: true }); toast('Marker added'); break;
      case 'zoomin': zoomAt(1.6, view.x(S.playhead) >= 0 && view.x(S.playhead) <= lanesWidth() ? view.x(S.playhead) : lanesWidth() / 2); break;
      case 'zoomout': zoomAt(1 / 1.6, view.x(S.playhead) >= 0 && view.x(S.playhead) <= lanesWidth() ? view.x(S.playhead) : lanesWidth() / 2); break;
      case 'fit': zoomFit(); break;
      case 'snap': S.snap = !S.snap; updateToolbar(); toast(S.snap ? 'Snapping on' : 'Snapping off'); break;
    }
  }

  function updateToolbar() {
    var ids = selIds(), any = hasClips();
    var underPlayhead = M.allClips(S.project).some(function (c) {
      return S.playhead > c.clip.start + M.MIN_LEN && S.playhead < M.clipEnd(c.clip) - M.MIN_LEN;
    });
    var can = {
      split: any && (!!S.range || underPlayhead),
      delete: ids.length > 0 || !!S.range,
      duplicate: ids.length > 0,
      copy: ids.length > 0,
      paste: !!clipboard,
      fadein: ids.length > 0,
      fadeout: ids.length > 0,
      fx: ids.length > 0 || !!S.range,
      marker: any,
      zoomin: any, zoomout: any, fit: any, snap: true
    };
    Array.prototype.forEach.call(el.tools.querySelectorAll('[data-tool]'), function (b) {
      var id = b.getAttribute('data-tool');
      b.disabled = !can[id];
      if (id === 'snap') b.setAttribute('aria-pressed', String(S.snap));
    });
  }

  /* -------------------------------------------------------------- actions */

  function doSplit() {
    if (S.range) {
      var r = loopRange(), tracks = S.range.tracks;
      edit(function (p) {
        var ids = M.allClips(p).filter(function (c) { return !tracks || tracks.indexOf(c.track.id) !== -1; })
          .map(function (c) { return c.clip.id; });
        var a = M.splitAt(p, r[0], ids);
        ids = ids.concat(a);
        M.splitAt(p, r[1], ids);
        // Select what is inside the range, which is usually the next thing wanted.
        S.sel = {};
        M.allClips(p).forEach(function (c) {
          if ((!tracks || tracks.indexOf(c.track.id) !== -1) && c.clip.start >= r[0] - 1e-6 && M.clipEnd(c.clip) <= r[1] + 1e-6) S.sel[c.clip.id] = true;
        });
      });
      S.range = null;
      refresh();
      return;
    }
    var ids = selIds();
    if (!ids.length && S.selTrack) {
      var t = S.project.tracks[M.trackIndex(S.project, S.selTrack)];
      ids = t ? t.clips.map(function (c) { return c.id; }) : [];
    }
    var made = edit(function (p) { return M.splitAt(p, S.playhead, ids.length ? ids : null); });
    if (made && made.length) {
      S.sel = {};
      made.forEach(function (id) { S.sel[id] = true; });
      toast('Split');
    } else {
      toast('Put the playhead over a clip to split it');
    }
    refresh();
  }

  function doDelete(ripple) {
    if (S.range) {
      var r = loopRange();
      // A deleted range closes up by default, the way deleting text does. The
      // inspector offers "keep the gap" for multitrack work.
      var close = ripple !== 'gap';
      edit(function (p) { M.deleteRange(p, r[0], r[1], S.range.tracks, close); });
      S.playhead = r[0];
      S.range = null;
      refresh();
      toast(close ? 'Deleted, gap closed' : 'Deleted');
      return;
    }
    var ids = selIds();
    if (!ids.length) return;
    edit(function (p) { M.deleteClips(p, ids, ripple === true); });
    S.sel = {};
    refresh();
    toast(ripple === true ? 'Deleted, gap closed' : 'Deleted');
  }

  function doDuplicate() {
    var ids = selIds();
    if (!ids.length) return;
    var made = edit(function (p) { return M.duplicate(p, ids); });
    S.sel = {};
    (made || []).forEach(function (id) { S.sel[id] = true; });
    refresh();
  }

  function doCopy(cut) {
    var ids = selIds();
    if (!ids.length) return;
    clipboard = M.copyClips(S.project, ids);
    if (cut) doDelete(false);
    toast(cut ? 'Cut' : 'Copied ' + ids.length + ' clip' + (ids.length > 1 ? 's' : ''));
    updateToolbar();
  }

  function doPaste() {
    if (!clipboard) return;
    var ti = S.selTrack ? M.trackIndex(S.project, S.selTrack) : clipboard.originTrack;
    if (ti < 0) ti = 0;
    var made = edit(function (p) {
      if (!p.tracks.length) M.addTrack(p);
      return M.paste(p, clipboard, S.playhead, ti);
    });
    S.sel = {};
    (made || []).forEach(function (id) { S.sel[id] = true; });
    refresh();
  }

  function quickFade(which) {
    var ids = selIds();
    if (!ids.length) return;
    // Toggle: a second press takes the fade off again.
    var has = ids.every(function (id) {
      var c = M.findClip(S.project, id).clip;
      return (which === 'in' ? c.fadeIn : c.fadeOut) > 0;
    });
    edit(function (p) {
      ids.forEach(function (id) {
        var c = M.findClip(p, id).clip;
        M.setFade(p, id, which, has ? 0 : Math.min(1.5, c.duration / 3));
      });
    });
    toast(has ? 'Fade removed' : (which === 'in' ? 'Fade in added — drag the dot to change it' : 'Fade out added — drag the dot to change it'));
  }

  function selectAll() {
    S.sel = {};
    M.allClips(S.project).forEach(function (c) { S.sel[c.clip.id] = true; });
    S.range = null;
    refresh();
  }

  function clearSelection() {
    S.sel = {}; S.range = null;
    refresh();
  }

  function nudge(dt) {
    var ids = selIds();
    if (!ids.length) { seek(S.playhead + dt); return; }
    edit(function (p) { M.moveClips(p, ids, dt, 0); });
  }

  /* --------------------------------------------------------------- toast */

  var toastTimer = 0;
  function toast(msg) {
    var t = $('#edToast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 1600);
  }

  /* ------------------------------------------------------------ inspector */

  function updateInspector() {
    var ids = selIds(), html = '';
    if (S.rec) {
      html = '<p class="ed-insp-note"><strong>Recording.</strong> Press stop (or Space) when you are done. Headphones stop the other tracks bleeding into the microphone.</p>';
    } else if (S.range) {
      var r = loopRange();
      html = '<div class="ed-insp-head"><strong>Selection</strong> <span class="ed-mono">' + fmt(r[0]) + ' → ' + fmt(r[1]) + ' · ' + (r[1] - r[0]).toFixed(2) + ' s</span>' +
        (S.range.tracks ? ' <span class="ed-chip">' + S.range.tracks.length + ' track' + (S.range.tracks.length > 1 ? 's' : '') + '</span>' : ' <span class="ed-chip">all tracks</span>') + '</div>' +
        '<div class="ed-insp-btns">' +
        '<button type="button" class="ed-btn" data-i="rangePlay">Play it</button>' +
        '<button type="button" class="ed-btn" data-i="rangeDelete">Delete (close gap)</button>' +
        '<button type="button" class="ed-btn" data-i="rangeGap">Delete, keep gap</button>' +
        '<button type="button" class="ed-btn" data-i="rangeCrop">Keep only this</button>' +
        '<button type="button" class="ed-btn" data-i="rangeSplit">Split at edges</button>' +
        '<button type="button" class="ed-btn" data-i="rangeSilence">Insert silence here</button>' +
        '<button type="button" class="ed-btn" data-i="fx">Effects…</button>' +
        '<button type="button" class="ed-btn" data-i="rangeExport">Export selection</button>' +
        '<button type="button" class="ed-btn ed-btn-ghost" data-i="clear">Clear</button>' +
        '</div>';
    } else if (ids.length === 1) {
      var f = M.findClip(S.project, ids[0]), c = f.clip;
      html = '<div class="ed-insp-head"><label class="ed-name"><span class="sr-only">Clip name</span><input type="text" data-i="name" value="' + esc(c.name) + '" maxlength="80"></label>' +
        '<span class="ed-mono">' + fmt(c.start) + ' · ' + c.duration.toFixed(2) + ' s</span></div>' +
        '<div class="ed-insp-grid">' +
        '<label>Volume <output data-o="gain">' + (c.gainDb > 0 ? '+' : '') + (c.gainDb || 0).toFixed(1) + ' dB</output>' +
        '<input type="range" min="-24" max="24" step="0.5" value="' + (c.gainDb || 0) + '" data-i="gain"></label>' +
        '<label>Fade in <output data-o="fadeIn">' + (c.fadeIn || 0).toFixed(2) + ' s</output>' +
        '<input type="range" min="0" max="' + Math.min(30, c.duration).toFixed(2) + '" step="0.01" value="' + (c.fadeIn || 0) + '" data-i="fadeIn"></label>' +
        '<label>Fade out <output data-o="fadeOut">' + (c.fadeOut || 0).toFixed(2) + ' s</output>' +
        '<input type="range" min="0" max="' + Math.min(30, c.duration).toFixed(2) + '" step="0.01" value="' + (c.fadeOut || 0) + '" data-i="fadeOut"></label>' +
        '</div>' +
        '<div class="ed-insp-btns">' +
        '<button type="button" class="ed-btn" data-i="fx">Effects…</button>' +
        '<button type="button" class="ed-btn" data-i="rippleDelete">Delete (close gap)</button>' +
        '<button type="button" class="ed-btn" data-i="newTrack">Move to new track</button>' +
        '<button type="button" class="ed-btn" data-i="clipExport">Export this clip</button>' +
        '</div>';
    } else if (ids.length > 1) {
      html = '<div class="ed-insp-head"><strong>' + ids.length + ' clips selected</strong></div>' +
        '<div class="ed-insp-btns">' +
        '<button type="button" class="ed-btn" data-i="fx">Effects on all…</button>' +
        '<button type="button" class="ed-btn" data-i="rippleDelete">Delete (close gaps)</button>' +
        '<button type="button" class="ed-btn" data-i="butt">Butt together</button>' +
        '<button type="button" class="ed-btn ed-btn-ghost" data-i="clear">Clear</button>' +
        '</div>';
    } else if (hasClips()) {
      html = '<p class="ed-insp-note">' + (isTouchUI()
        ? '<strong>Tap</strong> a clip to select it · <strong>drag</strong> a selected clip to move it · <strong>drag its edges</strong> to trim · <strong>drag along the ruler</strong> to select a range · <strong>pinch</strong> to zoom · <strong>hold</strong> a clip for more.'
        : '<strong>Click</strong> a clip to select it, <strong>drag</strong> to move it, drag its <strong>edges</strong> to trim and the <strong>dots</strong> to fade. <strong>Drag on empty space or the ruler</strong> to select a range. Right-click for more. <button type="button" class="ed-linkbtn" data-i="keys">Keyboard shortcuts</button>') + '</p>';
    }
    el.insp.innerHTML = html;
    el.insp.hidden = !html;
  }

  el.insp.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-i]');
    if (!b) return;
    var act = b.getAttribute('data-i'), r = S.range ? loopRange() : null, ids = selIds();
    switch (act) {
      case 'rangePlay': S.playhead = r[0]; startPlayback(r[0], r[1]); break;
      case 'rangeDelete': doDelete(true); break;
      case 'rangeGap': doDelete('gap'); break;
      case 'rangeCrop':
        edit(function (p) { M.cropTo(p, r[0], r[1]); });
        S.range = null; S.playhead = 0; S.scrollT = 0; refresh(); toast('Kept the selection'); break;
      case 'rangeSplit': doSplit(); break;
      case 'rangeSilence':
        edit(function (p) { M.insertGap(p, r[0], r[1] - r[0], S.range.tracks); });
        toast('Inserted ' + (r[1] - r[0]).toFixed(2) + ' s of silence'); break;
      case 'rangeExport': openExport('range'); break;
      case 'clipExport': openExport('clip'); break;
      case 'fx': fxSheet(); break;
      case 'clear': clearSelection(); break;
      case 'rippleDelete': doDelete(true); break;
      case 'keys': keysSheet(); break;
      case 'newTrack':
        edit(function (p) {
          var f = M.findClip(p, ids[0]);
          var idx = M.trackIndex(p, M.addTrack(p));
          M.moveClips(p, ids, 0, idx - f.ti);
        });
        break;
      case 'butt':
        // Close the gaps between the selected clips on each track, in order.
        edit(function (p) {
          p.tracks.forEach(function (t) {
            var mine = t.clips.filter(function (c) { return S.sel[c.id]; });
            for (var i = 1; i < mine.length; i++) {
              var gap = mine[i].start - M.clipEnd(mine[i - 1]);
              if (gap > 1e-6) M.moveClips(p, [mine[i].id], -gap, 0);
            }
          });
        });
        break;
    }
  });

  el.insp.addEventListener('input', function (e) {
    var k = e.target.getAttribute('data-i'), ids = selIds();
    if (!ids.length || !k) return;
    beginLive();
    if (k === 'name') { M.setClip(S.project, ids[0], { name: e.target.value }); draw(); return; }
    var v = +e.target.value;
    var o = el.insp.querySelector('[data-o="' + k + '"]');
    if (k === 'gain') {
      M.setClip(S.project, ids[0], { gainDb: v });
      if (o) o.textContent = (v > 0 ? '+' : '') + v.toFixed(1) + ' dB';
    } else if (k === 'fadeIn' || k === 'fadeOut') {
      M.setFade(S.project, ids[0], k === 'fadeIn' ? 'in' : 'out', v);
      var c = M.findClip(S.project, ids[0]).clip;
      if (o) o.textContent = c[k].toFixed(2) + ' s';
    }
    draw();
  });
  el.insp.addEventListener('change', function (e) {
    if (e.target.getAttribute('data-i')) { endLive(); updateInspector(); }
  });

  /* ---------------------------------------------------------------- sheets */

  var sheetOpen = null, lastFocus = null;

  function openSheet(title, html, onClick, cls) {
    closeExport();
    lastFocus = document.activeElement;
    el.sheetTitle.textContent = title;
    el.sheetBody.innerHTML = html;
    el.sheet.className = 'ed-sheet' + (cls ? ' ' + cls : '');
    el.sheet.hidden = false;
    sheetOpen = onClick;
    var first = el.sheetBody.querySelector('button, input, select');
    if (first && !isTouchUI()) first.focus();
  }
  function closeSheet() {
    if (el.sheet.hidden) return;
    el.sheet.hidden = true;
    sheetOpen = null;
    if (lastFocus && lastFocus.focus) try { lastFocus.focus(); } catch (e) {}
  }
  el.sheet.addEventListener('click', function (e) {
    if (e.target === el.sheet || e.target.closest('[data-close]')) { closeSheet(); return; }
    var b = e.target.closest('button[data-v]');
    if (b && sheetOpen) sheetOpen(b.getAttribute('data-v'), b);
  });

  function menuHtml(items) {
    return '<div class="ed-menu">' + items.map(function (it) {
      if (it === '-') return '<hr>';
      return '<button type="button" class="ed-menu-item' + (it.danger ? ' danger' : '') + '" data-v="' + it.v + '"' + (it.disabled ? ' disabled' : '') + '>' +
        '<span>' + esc(it.label) + '</span>' + (it.hint ? '<small>' + esc(it.hint) + '</small>' : '') + '</button>';
    }).join('') + '</div>';
  }

  function clipMenu(clipId) {
    if (!S.sel[clipId]) { S.sel = {}; S.sel[clipId] = true; S.range = null; refresh(); }
    var c = M.findClip(S.project, clipId).clip;
    openSheet(c.name, menuHtml([
      { v: 'split', label: 'Split at playhead', hint: 'S' },
      { v: 'dup', label: 'Duplicate', hint: '⌘D' },
      { v: 'copy', label: 'Copy', hint: '⌘C' },
      { v: 'cut', label: 'Cut', hint: '⌘X' },
      { v: 'fx', label: 'Effects…' },
      { v: 'fadein', label: c.fadeIn ? 'Remove fade in' : 'Fade in' },
      { v: 'fadeout', label: c.fadeOut ? 'Remove fade out' : 'Fade out' },
      { v: 'export', label: 'Export this clip' },
      '-',
      { v: 'del', label: 'Delete', hint: 'Del', danger: true },
      { v: 'ripple', label: 'Delete and close the gap', hint: '⇧Del', danger: true }
    ]), function (v) {
      closeSheet();
      if (v === 'split') doSplit();
      if (v === 'dup') doDuplicate();
      if (v === 'copy') doCopy();
      if (v === 'cut') doCopy(true);
      if (v === 'fx') fxSheet();
      if (v === 'fadein') quickFade('in');
      if (v === 'fadeout') quickFade('out');
      if (v === 'export') openExport('clip');
      if (v === 'del') doDelete(false);
      if (v === 'ripple') doDelete(true);
    });
  }

  function trackSheet(id) {
    var t = S.project.tracks[M.trackIndex(S.project, id)];
    if (!t) return;
    var html = '<div class="ed-form">' +
      '<label>Name <input type="text" data-k="name" value="' + esc(t.name) + '" maxlength="40"></label>' +
      '<label>Volume <output data-o="vol">' + t.volDb.toFixed(1) + ' dB</output><input type="range" min="-30" max="12" step="0.5" value="' + t.volDb + '" data-k="volDb"></label>' +
      '<label>Pan <output data-o="pan">' + panLabel(t.pan) + '</output><input type="range" min="-1" max="1" step="0.05" value="' + t.pan + '" data-k="pan"></label>' +
      '</div>' + menuHtml([
        { v: 'mute', label: t.mute ? 'Unmute' : 'Mute' },
        { v: 'solo', label: t.solo ? 'Unsolo' : 'Solo (hear only this)' },
        { v: 'up', label: 'Move up' },
        { v: 'down', label: 'Move down' },
        { v: 'selall', label: 'Select all clips on this track' },
        '-',
        { v: 'remove', label: 'Delete track', danger: true }
      ]);
    openSheet('Track', html, function (v) {
      if (v === 'mute') edit(function (p) { M.setTrack(p, id, { mute: !t.mute }); }, { noRestart: true });
      if (v === 'solo') edit(function (p) { M.setTrack(p, id, { solo: !t.solo }); }, { noRestart: true });
      if (v === 'up') edit(function (p) { M.moveTrack(p, id, -1); });
      if (v === 'down') edit(function (p) { M.moveTrack(p, id, 1); });
      if (v === 'selall') { S.sel = {}; t.clips.forEach(function (c) { S.sel[c.id] = true; }); refresh(); }
      if (v === 'remove') { edit(function (p) { M.removeTrack(p, id); }); toast('Track deleted — undo brings it back'); }
      E.updateTracks(S.project);
      closeSheet();
    });
    var body = el.sheetBody;
    body.addEventListener('input', function (e) {
      var k = e.target.getAttribute('data-k');
      if (!k) return;
      beginLive();
      var patch = {};
      patch[k] = k === 'name' ? e.target.value : +e.target.value;
      M.setTrack(S.project, id, patch);
      if (k === 'volDb') body.querySelector('[data-o="vol"]').textContent = (+e.target.value).toFixed(1) + ' dB';
      if (k === 'pan') body.querySelector('[data-o="pan"]').textContent = panLabel(+e.target.value);
      E.updateTracks(S.project);
      buildHeads();
    });
    body.addEventListener('change', function () { endLive(); });
  }
  function panLabel(p) { return Math.abs(p) < 0.03 ? 'centre' : (p < 0 ? Math.round(-p * 100) + '% left' : Math.round(p * 100) + '% right'); }

  function keysSheet() {
    var rows = [
      ['Space', 'Play / pause'], ['S or ⌘B', 'Split at the playhead'], ['Delete', 'Delete (a range closes up)'],
      ['⇧ Delete', 'Delete clips and close the gap'], ['⌘Z / ⇧⌘Z', 'Undo / redo'], ['⌘C ⌘X ⌘V', 'Copy, cut, paste at the playhead'],
      ['⌘D', 'Duplicate'], ['⌘A', 'Select every clip'], ['Esc', 'Clear the selection'], ['← →', 'Nudge clips 10 ms (⇧ for 1 s), or move the playhead'],
      ['+ / −  or ⌘ wheel', 'Zoom'], ['0', 'Zoom to fit'], ['M', 'Add a marker'], ['L', 'Loop on / off'], ['R', 'Record'], ['N', 'Snap on / off'],
      ['Home / End', 'Jump to start / end'], ['Alt while dragging', 'Drag without snapping']
    ];
    openSheet('Keyboard shortcuts', '<table class="ed-keys">' + rows.map(function (r) {
      return '<tr><th><kbd>' + esc(r[0]) + '</kbd></th><td>' + esc(r[1]) + '</td></tr>';
    }).join('') + '</table>', null);
  }

  /* --------------------------------------------------------------- effects */

  function fxTargets() {
    // A range: split clips at its edges and apply to what is inside it.
    if (S.range) {
      var r = loopRange(), tracks = S.range.tracks, inside = [];
      edit(function (p) {
        var ids = M.allClips(p).filter(function (c) {
          return (!tracks || tracks.indexOf(c.track.id) !== -1) && c.clip.start < r[1] && M.clipEnd(c.clip) > r[0];
        }).map(function (c) { return c.clip.id; });
        ids = ids.concat(M.splitAt(p, r[0], ids));
        M.splitAt(p, r[1], ids);
        M.allClips(p).forEach(function (c) {
          if ((!tracks || tracks.indexOf(c.track.id) !== -1) && c.clip.start >= r[0] - 1e-6 && M.clipEnd(c.clip) <= r[1] + 1e-6) inside.push(c.clip.id);
        });
      });
      return inside;
    }
    return selIds();
  }

  function fxSheet() {
    var html = '<div class="ed-fx-grid">' + FX.ORDER.map(function (id) {
      var f = FX.FX[id];
      return '<button type="button" class="ed-fx" data-v="' + id + '"><strong>' + esc(f.label) + '</strong><small>' + esc(f.hint) + '</small></button>';
    }).join('') + '</div>';
    openSheet(S.range ? 'Effects on the selection' : 'Effects', html, function (id) {
      var f = FX.FX[id];
      if (!f) return;
      if (f.options) {
        openSheet(f.label, menuHtml(f.options.map(function (o) { return { v: o[0], label: o[1] }; })) +
          (f.ffmpeg ? '<p class="ed-sheet-note">Runs ffmpeg in your browser. The first time, that is a one-off 30 MB download.</p>' : ''),
          function (opt) { closeSheet(); applyFx(id, opt); });
      } else {
        closeSheet();
        applyFx(id, null);
      }
    }, 'ed-sheet-wide');
  }

  var busy = false;
  function applyFx(id, opt) {
    if (busy) return;
    var f = FX.FX[id];
    var ids = fxTargets();
    if (!ids.length) { status('warn', 'Select a clip or a range first.'); return; }
    busy = true;
    var before = M.serialize(S.project);   // one undo step for the whole batch
    var notes = [];
    var i = 0;
    progress(0);
    status('info', f.label + '…');
    function next() {
      if (i >= ids.length) return Promise.resolve();
      var id2 = ids[i++];
      var found = M.findClip(S.project, id2);
      if (!found) return next();
      var c = found.clip, src = buffers.get(c.sourceId);
      if (!src) return next();
      var seg = slice(src, c.offset, c.duration);
      return FX.apply(id, seg, opt, function (pct, msg) {
        progress(((i - 1) + pct / 100) / ids.length * 100);
        if (msg) status('info', f.label + ': ' + msg);
      }).then(function (out) {
        if (!out || !out.length) return;
        var ripple = true;
        if (f.tail) {
          // Let a reverb or echo ring out into empty space, but never over the
          // next clip on the track and never shoving everything after it along.
          var nb = found.track.clips.filter(function (o) { return o.start >= M.clipEnd(c) - 1e-6 && o !== c; })[0];
          var room = nb ? nb.start - c.start : Infinity;
          out = FX.fitTail(out, Math.max(seg.length, Math.floor(Math.min(room, out.duration) * out.sampleRate)));
          ripple = false;
        } else if (!f.changesLength && Math.abs(out.duration - c.duration) < 0.05) {
          ripple = false;
        }
        if (out._note) notes.push(out._note);
        var sid = M.addSource(S.project, {
          name: c.name, duration: out.duration, channels: out.numberOfChannels, sampleRate: out.sampleRate, kind: 'derived'
        });
        buffers.set(sid, out);
        V.buildPeaks(sid, out);
        M.replaceSource(S.project, id2, sid, out.duration, ripple);
        draw();
      }).then(next);
    }
    return next().then(function () {
      if (M.serialize(S.project) !== before) { hist.push(before); changed(); }
      S.sel = {};
      ids.forEach(function (x) { if (M.findClip(S.project, x)) S.sel[x] = true; });
      S.range = null;
      refresh();
      progress(null);
      status('success', f.label + ' applied' + (ids.length > 1 ? ' to ' + ids.length + ' clips' : '') +
        (notes.length === 1 ? ' — ' + notes[0] : '') + '. Undo takes it off again.');
    }).catch(function (err) {
      progress(null);
      if (M.serialize(S.project) !== before) { hist.push(before); changed(); }
      status('error', f.label + ' failed: ' + ((err && err.message) || 'unknown error'));
    }).then(function () { busy = false; });
  }

  // Copy [offset, offset + dur) of a buffer out as a new buffer.
  function slice(buf, offset, dur) {
    var sr = buf.sampleRate;
    var a = Math.max(0, Math.round(offset * sr));
    var b = Math.min(buf.length, a + Math.max(1, Math.round(dur * sr)));
    var out = E.createBuffer(buf.numberOfChannels, b - a, sr);
    for (var c = 0; c < buf.numberOfChannels; c++) out.copyToChannel(buf.getChannelData(c).subarray(a, b), c);
    return out;
  }

  /* ---------------------------------------------------------------- import */

  function decodeFile(file, onProgress) {
    return global.AudioSaw.decodeToAudioBuffer(file).catch(function () {
      // Video containers, WMA, AC3 and friends: let ffmpeg pull the audio out.
      if (onProgress) onProgress('Opening ' + file.name + ' with ffmpeg (first time: a 30 MB download)…');
      return global.AudioSaw.convert(file, 'wav', {}, function (pct, msg) {
        progress(pct);
        if (msg && onProgress) onProgress(msg);
      }).then(function (wav) {
        return global.AudioSaw.decodeToAudioBuffer(new File([wav], baseName(file.name) + '.wav', { type: 'audio/wav' }));
      });
    });
  }
  ST.decode = function (f) { return decodeFile(f); };

  // place: { mode: 'end' | 'tracks' | 'at', t, ti }
  function importFiles(list, place) {
    list = list.filter(Boolean);
    if (!list.length) return;
    var proj = list.filter(function (f) { return /\.audiosaw$/i.test(f.name); });
    if (proj.length) { openProjectFile(proj[0]); return; }
    if (busy) return;
    busy = true;
    var before = M.serialize(S.project);
    var added = [];
    var i = 0;
    clearStatus();
    progress(5);
    function next() {
      if (i >= list.length) return Promise.resolve();
      var f = list[i++];
      status('info', 'Opening ' + f.name + '…');
      return decodeFile(f, function (m) { status('info', m); }).then(function (buf) {
        var sid = M.addSource(S.project, {
          name: baseName(f.name), duration: buf.duration, channels: buf.numberOfChannels, sampleRate: buf.sampleRate, kind: 'file'
        });
        buffers.set(sid, buf);
        files.set(sid, f);
        V.buildPeaks(sid, buf);
        var p = S.project, ti, start;
        if (place.mode === 'at') {
          while (p.tracks.length <= place.ti) M.addTrack(p);
          ti = place.ti; start = Math.max(0, place.t);
          place.t = start + buf.duration;          // several dropped files line up
        } else if (place.mode === 'tracks') {
          // Reuse a lone empty track rather than leaving it above the new one.
          var reuse = p.tracks.length === 1 && !p.tracks[0].clips.length;
          ti = reuse ? 0 : M.trackIndex(p, M.addTrack(p));
          start = place.t || 0;
        } else {
          if (!p.tracks.length) M.addTrack(p);
          ti = clamp(place.ti || 0, 0, p.tracks.length - 1);
          var tr = p.tracks[ti];
          start = tr.clips.length ? M.clipEnd(tr.clips[tr.clips.length - 1]) : 0;
        }
        var cid = M.addClip(p, p.tracks[ti].id, { sourceId: sid, start: start, name: baseName(f.name) });
        added.push(cid);
        if (!p.name || p.name === 'Untitled project') p.name = baseName(f.name);
        progress(i / list.length * 100);
      }).catch(function (err) {
        status('error', 'Could not open ' + f.name + ': ' + ((err && err.message) || 'unsupported file') + '. If it is a video or an unusual format, converting it to WAV first usually works.');
        throw err;
      }).then(next);
    }
    return next().then(function () {
      if (M.serialize(S.project) !== before) { hist.push(before); }
      S.sel = {};
      added.forEach(function (id) { S.sel[id] = true; });
      var wasEmpty = M.parse(before).tracks.every(function (t) { return !t.clips.length; });
      changed();
      if (wasEmpty) zoomFit();
      progress(null);
      status('success', 'Added ' + (added.length === 1 ? M.findClip(S.project, added[0]).clip.name : added.length + ' files') +
        '. Press play, or ' + (isTouchUI() ? 'tap' : 'click') + ' a clip to edit it.');
    }).catch(function () {
      progress(null);
      if (M.serialize(S.project) !== before) { hist.push(before); changed(); }
    }).then(function () { busy = false; });
  }

  // Picker / dropzone intake. Ask where to put it only when the answer is not
  // obvious: an empty project takes a single file without a question.
  function onPicked(list) {
    if (!list || !list.length) return;
    if (list.some(function (f) { return /\.audiosaw$/i.test(f.name); })) { importFiles(list, {}); return; }
    var empty = !hasClips();
    if (empty && list.length === 1) { importFiles(list, { mode: 'end', ti: 0 }); return; }
    var selTi = S.selTrack ? M.trackIndex(S.project, S.selTrack) : 0;
    var items = [];
    if (list.length > 1) {
      items.push({ v: 'end', label: 'One after another', hint: empty ? 'Joined end to end on one track' : 'At the end of ' + (S.project.tracks[selTi] || { name: 'track 1' }).name });
      items.push({ v: 'tracks', label: 'Each on its own track', hint: 'Stacked, starting together — for mixing' });
    } else {
      items.push({ v: 'tracks', label: 'On a new track', hint: 'Starts at the playhead, ' + fmt(S.playhead) });
      items.push({ v: 'end', label: 'At the end of ' + (S.project.tracks[selTi] || { name: 'track 1' }).name, hint: 'Joins it on' });
      items.push({ v: 'at', label: 'At the playhead on ' + (S.project.tracks[selTi] || { name: 'track 1' }).name, hint: 'Overwrites anything already there' });
    }
    openSheet('Where should ' + (list.length > 1 ? 'these ' + list.length + ' files' : list[0].name) + ' go?', menuHtml(items), function (v) {
      closeSheet();
      if (v === 'end') importFiles(list, { mode: 'end', ti: empty ? 0 : selTi });
      if (v === 'tracks') importFiles(list, { mode: 'tracks', t: empty ? 0 : S.playhead });
      if (v === 'at') importFiles(list, { mode: 'at', t: S.playhead, ti: selTi });
    });
  }

  CV.bindDropzone(el.empty, el.fileInput, onPicked, ACCEPT);
  $('#edAdd').addEventListener('click', function () { el.fileInput.click(); });

  // Dropping onto the timeline itself puts the file where it lands.
  el.stage.addEventListener('dragover', function (e) {
    if (!hasClips()) return;
    e.preventDefault();
    el.stage.classList.add('dragover');
  });
  el.stage.addEventListener('dragleave', function () { el.stage.classList.remove('dragover'); });
  el.stage.addEventListener('drop', function (e) {
    el.stage.classList.remove('dragover');
    if (!hasClips()) return;
    e.preventDefault();
    var split = CV.filterAccepted(Array.from(e.dataTransfer.files || []), ACCEPT);
    if (split.rejected.length) status('error', 'Wrong file type: .' + split.rejected[0].name.split('.').pop() + ' — the editor takes audio and video files.');
    if (!split.ok.length) return;
    var rect = el.lanes.getBoundingClientRect();
    var h = view.hitTest(e.clientX - rect.left, e.clientY - rect.top, {});
    var t = Math.max(0, view.t(e.clientX - rect.left));
    if (S.snap) { var sn = M.snap(t, M.snapPoints(S.project, null, [S.playhead]), 10 / S.pps); if (sn != null) t = sn; }
    importFiles(split.ok, { mode: 'at', t: t, ti: h.track ? h.ti : S.project.tracks.length });
  });

  /* ---------------------------------------------------------- empty state */

  function updateEmpty() {
    var empty = !hasClips() && !S.rec;
    el.empty.hidden = !empty;
    el.ed.classList.toggle('is-empty', empty);
  }

  // A short two-track demo, synthesised here, for anyone who wants to try the
  // editor before trusting it with their own audio.
  function demo() {
    var sr = 44100, bars = 4, beat = 0.5, len = Math.round(bars * 4 * beat * sr);
    var drums = new Float32Array(len), synth = new Float32Array(len);
    function kick(at) {
      for (var i = 0; i < sr * 0.35 && at + i < len; i++) {
        var t = i / sr, f = 45 + 90 * Math.exp(-t * 30);
        drums[at + i] += Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 9) * 0.55;
      }
    }
    function noise(at, dur, amp, decay) {
      var prev = 0;
      for (var i = 0; i < sr * dur && at + i < len; i++) {
        var n = Math.random() * 2 - 1, hp = n - prev; prev = n;
        drums[at + i] += hp * amp * Math.exp(-i / sr * decay);
      }
    }
    for (var b = 0; b < bars * 4; b++) {
      var at = Math.round(b * beat * sr);
      kick(at);
      if (b % 2 === 1) noise(at, 0.25, 0.35, 18);
      noise(at + Math.round(beat * sr / 2), 0.05, 0.18, 60);
    }
    var chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
    for (var bar = 0; bar < bars; bar++) {
      for (var s = 0; s < 8; s++) {
        var note = chords[bar][s % 3] + (s >= 4 ? 12 : 0);
        var hz = 440 * Math.pow(2, (note - 69) / 12);
        var st = Math.round((bar * 4 * beat + s * beat / 2) * sr), dl = Math.round(beat / 2 * sr * 0.95);
        for (var i = 0; i < dl && st + i < len; i++) {
          var t = i / sr, env = Math.min(1, t * 200) * Math.exp(-t * 5);
          synth[st + i] += (Math.sin(2 * Math.PI * hz * t) + 0.3 * Math.sin(4 * Math.PI * hz * t) + 0.12 * Math.sin(6 * Math.PI * hz * t)) * env * 0.2;
        }
      }
    }
    var before = M.serialize(S.project);
    [['Demo drums', drums], ['Demo synth', synth]].forEach(function (d) {
      var buf = E.createBuffer(1, len, sr);
      buf.copyToChannel(d[1], 0);
      var sid = M.addSource(S.project, { name: d[0], duration: buf.duration, channels: 1, sampleRate: sr, kind: 'derived' });
      buffers.set(sid, buf);
      V.buildPeaks(sid, buf);
      var tid = M.addTrack(S.project, { name: d[0].replace('Demo ', '').replace(/^./, function (x) { return x.toUpperCase(); }) });
      M.addClip(S.project, tid, { sourceId: sid, start: 0, name: d[0] });
    });
    S.project.name = 'Demo';
    hist.push(before);
    changed();
    zoomFit();
    status('info', 'A demo loop on two tracks. Press play, then try splitting, dragging and fading.');
  }

  el.empty.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-empty]');
    if (!b) return;
    var act = b.getAttribute('data-empty');
    if (act === 'demo') demo();
    if (act === 'record') startRecording();
    if (act === 'restore') restoreSession();
  });

  /* ------------------------------------------------------------- pointers */

  var pointers = new Map();
  var pinch = null;
  var down = null;          // the gesture in progress on the lanes
  var longPressTimer = 0;
  var LONG_PRESS = 480;

  function localXY(e, canvas) {
    var r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function snapT(t, excludeIds, altKey) {
    S.snapAt = null;
    if (!S.snap || altKey) return t;
    var hit = M.snap(t, M.snapPoints(S.project, excludeIds, snapExtras(t)), 10 / S.pps);
    if (hit != null) { S.snapAt = hit; return hit; }
    return t;
  }

  // The playhead, plus the nearest line of the ruler's grid.
  function snapExtras(t) {
    var step = V.gridStep(S.pps) / 5;
    return [S.playhead, Math.round(t / step) * step];
  }

  el.lanes.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  el.ruler.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  el.lanes.addEventListener('pointerdown', function (e) {
    if (S.rec) return;
    // A primary pointer means no other finger is down. Start clean, or an
    // up/cancel the browser never delivered leaves a ghost finger in the map
    // and every later touch is read as the second half of a pinch.
    if (e.isPrimary) { pointers.clear(); pinch = null; }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { el.lanes.setPointerCapture(e.pointerId); } catch (err) {}
    if (pointers.size === 2) { beginPinch(); return; }
    if (pointers.size > 2) return;

    var p = localXY(e, el.lanes);
    var touch = e.pointerType !== 'mouse';
    view.touch = touch;
    var h = view.hitTest(p.x, p.y, { touch: touch });
    down = { id: e.pointerId, x0: p.x, y0: p.y, cx: e.clientX, cy: e.clientY, hit: h, touch: touch, moved: false, mode: null, shift: e.shiftKey || e.metaKey || e.ctrlKey, scrollT0: S.scrollT, scrollTop0: el.scroll.scrollTop };

    if (e.button === 2 && h.clip) { e.preventDefault(); clipMenu(h.clip.id); down = null; return; }

    if (h.type === 'fadeIn' || h.type === 'fadeOut' || h.type === 'trimStart' || h.type === 'trimEnd') {
      down.mode = h.type;
      if (!S.sel[h.clip.id]) { S.sel = {}; S.sel[h.clip.id] = true; S.range = null; }
      beginLive();
      refresh();
      return;
    }

    if (h.type === 'clip') {
      if (touch && !S.sel[h.clip.id]) {
        down.mode = 'pending-pan';
      } else {
        if (down.shift) {
          if (S.sel[h.clip.id]) delete S.sel[h.clip.id]; else S.sel[h.clip.id] = true;
          down.toggled = true;
        } else if (!S.sel[h.clip.id]) {
          S.sel = {}; S.sel[h.clip.id] = true;
        }
        S.range = null;
        S.selTrack = h.track.id;
        down.mode = 'pending-move';
        refresh();
      }
      longPressTimer = setTimeout(function () {
        if (down && !down.moved && down.hit.clip) {
          var id = down.hit.clip.id;
          down = null;
          clipMenu(id);
        }
      }, LONG_PRESS);
      return;
    }

    // Empty lane: a mouse selects a range, a finger pans.
    down.mode = touch ? 'pending-pan' : 'pending-range';
  });

  el.lanes.addEventListener('pointermove', function (e) {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch) { updatePinch(); return; }
    if (!down || down.id !== e.pointerId) {
      if (e.pointerType === 'mouse' && !down) hoverCursor(e);
      return;
    }
    var p = localXY(e, el.lanes);
    var dx = p.x - down.x0, dy = p.y - down.y0;
    var dist = Math.hypot(e.clientX - down.cx, e.clientY - down.cy);
    var threshold = down.touch ? 8 : 4;
    if (!down.moved && dist < threshold) return;
    if (!down.moved) { down.moved = true; clearTimeout(longPressTimer); }

    var h = down.hit, t = view.t(p.x);
    switch (down.mode) {
      case 'pending-move':
        down.mode = 'move';
        var ids = {};
        selIds().forEach(function (id) { ids[id] = true; });
        S.drag = { kind: 'move', ids: ids, dt: 0, dTrack: 0 };
        /* falls through */
      case 'move':
        var group = Object.keys(S.drag.ids).map(function (id) { return M.findClip(S.project, id); }).filter(Boolean);
        var minStart = Math.min.apply(null, group.map(function (f) { return f.clip.start; }));
        var maxEnd = Math.max.apply(null, group.map(function (f) { return M.clipEnd(f.clip); }));
        var minTi = Math.min.apply(null, group.map(function (f) { return f.ti; }));
        var maxTi = Math.max.apply(null, group.map(function (f) { return f.ti; }));
        var dt = Math.max(-minStart, dx / S.pps);
        S.snapAt = null;
        if (S.snap && !e.altKey) {
          var tol = 10 / S.pps;
          var pts = M.snapPoints(S.project, S.drag.ids, [S.playhead]);
          var a = M.snap(minStart + dt, pts, tol), b = M.snap(maxEnd + dt, pts, tol);
          if (a != null && (b == null || Math.abs(a - minStart - dt) <= Math.abs(b - maxEnd - dt))) { dt = a - minStart; S.snapAt = a; }
          else if (b != null) { dt = b - maxEnd; S.snapAt = b; }
        }
        var dTrack = Math.round(dy / S.trackH);
        // A single-track group may go one lane past the last track: that
        // creates a new track on release.
        var maxDown = S.project.tracks.length - 1 - maxTi + (minTi === maxTi ? 1 : 0);
        dTrack = clamp(dTrack, -minTi, maxDown);
        S.drag.dt = dt; S.drag.dTrack = dTrack;
        edgeScroll(p.x);
        draw();
        break;
      case 'trimStart':
        M.trimStart(S.project, h.clip.id, snapT(t, idMap(h.clip.id), e.altKey));
        edgeScroll(p.x); draw(); break;
      case 'trimEnd':
        M.trimEnd(S.project, h.clip.id, snapT(t, idMap(h.clip.id), e.altKey));
        edgeScroll(p.x); draw(); break;
      case 'fadeIn':
        var c1 = M.findClip(S.project, h.clip.id).clip;
        M.setFade(S.project, c1.id, 'in', t - c1.start); draw(); break;
      case 'fadeOut':
        var c2 = M.findClip(S.project, h.clip.id).clip;
        M.setFade(S.project, c2.id, 'out', M.clipEnd(c2) - t); draw(); break;
      case 'pending-range':
        down.mode = 'range';
        S.sel = {};
        S.range = { t0: snapT(view.t(down.x0), null, e.altKey), t1: down.x0, tracks: [] };
        /* falls through */
      case 'range':
        S.range.t1 = Math.max(0, snapT(t, null, e.altKey));
        var ti0 = Math.floor(down.y0 / S.trackH), ti1 = Math.floor(p.y / S.trackH);
        var lo = clamp(Math.min(ti0, ti1), 0, S.project.tracks.length - 1), hi = clamp(Math.max(ti0, ti1), 0, S.project.tracks.length - 1);
        S.range.tracks = S.project.tracks.slice(lo, hi + 1).map(function (tr) { return tr.id; });
        if (S.range.tracks.length === S.project.tracks.length) S.range.tracks = null;
        edgeScroll(p.x);
        updateToolbar(); updateInspector(); draw();
        break;
      case 'pending-pan':
        down.mode = 'pan';
        /* falls through */
      case 'pan':
        S.scrollT = Math.max(0, down.scrollT0 - (e.clientX - down.cx) / S.pps);
        clampScroll();
        el.scroll.scrollTop = down.scrollTop0 - (e.clientY - down.cy);
        updateHbar();
        draw();
        break;
    }
  });

  function idMap(id) { var o = {}; o[id] = true; return o; }

  function endPointer(e) {
    pointers.delete(e.pointerId);
    clearTimeout(longPressTimer);
    if (pinch) { if (pointers.size < 2) pinch = null; down = null; return; }
    if (!down || down.id !== e.pointerId) return;
    var g = down;
    down = null;
    S.snapAt = null;
    if (e.type === 'pointercancel') {
      if (g.mode === 'move') S.drag = null;
      if (liveSnap !== null) endLive();
      draw();
      return;
    }
    switch (g.mode) {
      case 'move':
        var drag = S.drag;
        S.drag = null;
        edit(function (p) {
          var ids = Object.keys(drag.ids);
          var f = M.findClip(p, ids[0]);
          if (f && f.ti + drag.dTrack >= p.tracks.length) M.addTrack(p);
          M.moveClips(p, ids, drag.dt, drag.dTrack);
          var moved = M.findClip(p, ids[0]);
          if (moved) S.selTrack = moved.track.id;
        });
        refresh();
        break;
      case 'trimStart': case 'trimEnd': case 'fadeIn': case 'fadeOut':
        endLive();
        refresh();
        break;
      case 'range':
        if (Math.abs(view.x(S.range.t1) - view.x(S.range.t0)) < 4) { S.range = null; seek(view.t(g.x0)); }
        refresh();
        break;
      case 'pending-move':
        // A click on a clip: select it (done on down) and put the playhead
        // where it landed, so "click, then Split" cuts right there.
        if (!g.toggled && !g.shift) {
          S.sel = {}; S.sel[g.hit.clip.id] = true;
        }
        seek(snapT(g.hit.t, null, true));
        refresh();
        break;
      case 'pending-pan':
        // A tap: on an unselected clip select it, on empty space clear.
        if (g.hit.clip) {
          S.sel = {}; S.sel[g.hit.clip.id] = true; S.range = null; S.selTrack = g.hit.track.id;
        } else {
          S.sel = {}; S.range = null;
          if (g.hit.track) S.selTrack = g.hit.track.id;
        }
        seek(g.hit.t);
        refresh();
        break;
      case 'pending-range':
        S.sel = {}; S.range = null;
        if (g.hit.track) S.selTrack = g.hit.track.id;
        seek(snapT(g.hit.t, null, true));
        refresh();
        break;
      default:
        draw();
    }
  }
  el.lanes.addEventListener('pointerup', endPointer);
  el.lanes.addEventListener('pointercancel', endPointer);

  el.lanes.addEventListener('dblclick', function (e) {
    var p = localXY(e, el.lanes), h = view.hitTest(p.x, p.y, {});
    if (h.clip) { S.range = { t0: h.clip.start, t1: M.clipEnd(h.clip), tracks: [h.track.id] }; S.sel = {}; refresh(); }
  });

  function hoverCursor(e) {
    var p = localXY(e, el.lanes), h = view.hitTest(p.x, p.y, {});
    var cur = { trimStart: 'ew-resize', trimEnd: 'ew-resize', fadeIn: 'grab', fadeOut: 'grab', clip: 'grab', empty: 'text', newlane: 'default' }[h.type] || 'default';
    el.lanes.style.cursor = cur;
  }

  // While dragging near either edge, scroll the timeline along.
  var edgeTimer = 0;
  function edgeScroll(x) {
    var w = lanesWidth(), zone = 36;
    var v = x < zone ? -(zone - x) : x > w - zone ? (x - (w - zone)) : 0;
    if (!v) return;
    S.scrollT = Math.max(0, S.scrollT + v * 0.35 / S.pps);
    updateHbar();
  }

  function beginPinch() {
    clearTimeout(longPressTimer);
    if (down) {
      if (down.mode === 'move') S.drag = null;
      if (liveSnap !== null) cancelLive();
      if (down.mode === 'range') S.range = null;
    }
    down = null;
    var pts = Array.from(pointers.values());
    var r = el.lanes.getBoundingClientRect();
    var mid = (pts[0].x + pts[1].x) / 2 - r.left;
    pinch = { d0: Math.max(20, Math.abs(pts[0].x - pts[1].x)), pps0: S.pps, midT: view.t(mid), top0: el.scroll.scrollTop, my0: (pts[0].y + pts[1].y) / 2 };
  }
  function updatePinch() {
    var pts = Array.from(pointers.values());
    if (pts.length < 2) return;
    var r = el.lanes.getBoundingClientRect();
    var d = Math.max(20, Math.abs(pts[0].x - pts[1].x));
    var mid = (pts[0].x + pts[1].x) / 2 - r.left;
    var lim = zoomLimits();
    S.pps = clamp(pinch.pps0 * d / pinch.d0, lim[0], lim[1]);
    S.scrollT = Math.max(0, pinch.midT - mid / S.pps);
    el.scroll.scrollTop = pinch.top0 - ((pts[0].y + pts[1].y) / 2 - pinch.my0);
    updateHbar();
    draw();
  }

  // Wheel: ⌘/ctrl (and trackpad pinch, which arrives as ctrl+wheel) zooms,
  // horizontal or shift scrolls time, plain vertical scrolls the tracks.
  el.stage.addEventListener('wheel', function (e) {
    if (!hasClips()) return;
    var r = el.lanes.getBoundingClientRect();
    var x = e.clientX - r.left;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      zoomAt(Math.exp(-e.deltaY * 0.01), clamp(x, 0, lanesWidth()));
      return;
    }
    var dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
    if (Math.abs(dx) > Math.abs(e.deltaY) || (e.shiftKey && dx)) {
      e.preventDefault();
      S.scrollT = Math.max(0, S.scrollT + dx / S.pps);
      clampScroll();
      updateHbar();
      draw();
    }
  }, { passive: false });

  /* ---------------------------------------------------------------- ruler */

  var rdown = null;
  el.ruler.addEventListener('pointerdown', function (e) {
    if (!hasClips() || S.rec) return;
    try { el.ruler.setPointerCapture(e.pointerId); } catch (err) {}
    var p = localXY(e, el.ruler), t = view.t(p.x);
    var mk = null;
    S.project.markers.forEach(function (m) { if (Math.abs(view.x(m.t) - p.x) < (e.pointerType === 'mouse' ? 7 : 14) && p.y < 22) mk = m; });
    rdown = { x0: p.x, cx: e.clientX, t0: t, moved: false, marker: mk, touch: e.pointerType !== 'mouse' };
    if (mk && e.button === 2) { rdown = null; markerSheet(mk.id); return; }
    if (mk) {
      beginLive();
      longPressTimer = setTimeout(function () { if (rdown && !rdown.moved) { var id = rdown.marker.id; rdown = null; endLive(); markerSheet(id); } }, LONG_PRESS);
    }
  });
  el.ruler.addEventListener('pointermove', function (e) {
    if (!rdown) return;
    var p = localXY(e, el.ruler);
    if (!rdown.moved && Math.abs(e.clientX - rdown.cx) < (rdown.touch ? 8 : 3)) return;
    rdown.moved = true;
    clearTimeout(longPressTimer);
    var t = Math.max(0, view.t(p.x));
    if (rdown.marker) {
      var m = S.project.markers.filter(function (x) { return x.id === rdown.marker.id; })[0];
      if (m) m.t = snapT(t, null, e.altKey);
    } else {
      S.sel = {};
      S.range = { t0: snapT(rdown.t0, null, e.altKey), t1: snapT(t, null, e.altKey), tracks: null };
      updateInspector(); updateToolbar();
    }
    edgeScroll(p.x);
    draw();
  });
  function rulerUp(e) {
    clearTimeout(longPressTimer);
    if (!rdown) return;
    var g = rdown;
    rdown = null;
    S.snapAt = null;
    if (g.marker) {
      S.project.markers.sort(function (a, b) { return a.t - b.t; });
      endLive();
      if (!g.moved) seek(g.marker.t);
      refresh();
      return;
    }
    if (!g.moved || e.type === 'pointercancel') {
      S.range = null;
      seek(snapT(g.t0, null, true));
      refresh();
      return;
    }
    if (S.range && Math.abs(S.range.t1 - S.range.t0) * S.pps < 4) S.range = null;
    refresh();
  }
  el.ruler.addEventListener('pointerup', rulerUp);
  el.ruler.addEventListener('pointercancel', rulerUp);

  function markerSheet(id) {
    var m = S.project.markers.filter(function (x) { return x.id === id; })[0];
    if (!m) return;
    openSheet('Marker at ' + fmt(m.t), '<div class="ed-form"><label>Label <input type="text" data-k="label" value="' + esc(m.label) + '" maxlength="40"></label></div>' +
      menuHtml([{ v: 'go', label: 'Move the playhead here' }, { v: 'del', label: 'Delete marker', danger: true }]), function (v) {
      if (v === 'go') seek(m.t);
      if (v === 'del') edit(function (p) { M.removeMarker(p, id); }, { noRestart: true });
      closeSheet();
    });
    el.sheetBody.querySelector('[data-k="label"]').addEventListener('change', function (e) {
      var val = e.target.value;
      edit(function (p) { p.markers.forEach(function (x) { if (x.id === id) x.label = val; }); }, { noRestart: true });
    });
  }

  /* ---------------------------------------------------------- scrollbar */

  (function () {
    if (!el.hbar) return;
    var drag = null;
    el.hbar.addEventListener('pointerdown', function (e) {
      el.hbar.setPointerCapture(e.pointerId);
      var r = el.hbar.getBoundingClientRect(), w = lanesWidth(), vis = w / S.pps;
      var total = Math.max(M.duration(S.project) + vis * 0.5, S.scrollT + vis, vis);
      if (e.target !== el.thumb) S.scrollT = Math.max(0, ((e.clientX - r.left) / r.width) * total - vis / 2);
      drag = { x: e.clientX, s: S.scrollT, total: total, bw: r.width };
      updateHbar(); draw();
    });
    el.hbar.addEventListener('pointermove', function (e) {
      if (!drag) return;
      S.scrollT = Math.max(0, drag.s + (e.clientX - drag.x) / drag.bw * drag.total);
      clampScroll(); updateHbar(); draw();
    });
    el.hbar.addEventListener('pointerup', function () { drag = null; });
    el.hbar.addEventListener('pointercancel', function () { drag = null; });
  })();

  /* ------------------------------------------------------------- keyboard */

  document.addEventListener('keydown', function (e) {
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (!el.sheet.hidden || !el.exportSheet.hidden) {
      if (e.key === 'Escape') { closeSheet(); closeExport(); }
      return;
    }
    // Only take keys when the editor is on screen, so Space still scrolls the
    // article below it.
    var r = el.ed.getBoundingClientRect();
    if (r.bottom < 60 || r.top > global.innerHeight - 60) return;
    var mod = e.metaKey || e.ctrlKey, k = e.key;
    var handled = true;
    if (k === ' ' || k === 'Spacebar') togglePlay();
    else if (mod && (k === 'z' || k === 'Z')) { if (e.shiftKey) redo(); else undo(); }
    else if (mod && (k === 'y' || k === 'Y')) redo();
    else if (mod && (k === 'c' || k === 'C')) doCopy();
    else if (mod && (k === 'x' || k === 'X')) doCopy(true);
    else if (mod && (k === 'v' || k === 'V')) doPaste();
    else if (mod && (k === 'd' || k === 'D')) doDuplicate();
    else if (mod && (k === 'a' || k === 'A')) selectAll();
    else if (mod && (k === 'b' || k === 'B')) doSplit();
    else if (mod && (k === 's' || k === 'S')) saveProjectFile();
    else if (mod) handled = false;
    else if (k === 's' || k === 'S') doSplit();
    else if (k === 'Delete' || k === 'Backspace') doDelete(e.shiftKey ? true : false);
    else if (k === 'Escape') clearSelection();
    else if (k === 'ArrowLeft') nudge(e.shiftKey ? -1 : (selIds().length ? -0.01 : -1));
    else if (k === 'ArrowRight') nudge(e.shiftKey ? 1 : (selIds().length ? 0.01 : 1));
    else if (k === '+' || k === '=') runTool('zoomin');
    else if (k === '-' || k === '_') runTool('zoomout');
    else if (k === '0') zoomFit();
    else if (k === 'm' || k === 'M') runTool('marker');
    else if (k === 'l' || k === 'L') { S.loop = !S.loop; updateTransport(); draw(); toast(S.loop ? 'Loop on' : 'Loop off'); }
    else if (k === 'r' || k === 'R') { if (S.rec) stopRecording(); else startRecording(); }
    else if (k === 'n' || k === 'N') runTool('snap');
    else if (k === 'Home') { seek(0); S.scrollT = 0; updateHbar(); }
    else if (k === 'End') seek(M.duration(S.project));
    else if (k === '?') keysSheet();
    else handled = false;
    if (handled) e.preventDefault();
  });

  /* ------------------------------------------------------------ recording */

  var countIn = false;
  try { countIn = localStorage.getItem('as_ed_countin') === '1'; } catch (e) {}

  function startRecording() {
    if (S.rec || busy) return;
    if (!global.isSecureContext || !navigator.mediaDevices) { status('error', 'Recording needs a secure (https) page and microphone support.'); return; }
    E.unlock();
    var begin = function () {
      var p = S.project, target = null;
      if (S.selTrack) {
        var st = p.tracks[M.trackIndex(p, S.selTrack)];
        if (st && !st.clips.some(function (c) { return M.clipEnd(c) > S.playhead; })) target = st.id;
      }
      var before = M.serialize(p);
      if (!target) target = M.addTrack(p, { name: 'Recording ' + (p.tracks.filter(function (t) { return /^Recording/.test(t.name); }).length + 1) });
      var sr = E.sampleRate();
      S.rec = { trackId: target, start: S.playhead, length: 0, peaks: [], peakHop: 1024, sr: sr, acc: 0, accN: 0, before: before };
      S.selTrack = target;
      status('info', 'Waiting for the microphone…');
      return E.startRecording(function (chans) {
        var r = S.rec;
        if (!r) return;
        var d = chans[0];
        for (var i = 0; i < d.length; i++) {
          var v = d[i] < 0 ? -d[i] : d[i];
          if (v > r.acc) r.acc = v;
          if (++r.accN >= r.peakHop) { r.peaks.push(r.acc); r.acc = 0; r.accN = 0; }
        }
        r.length += d.length / r.sr;
      }).then(function () {
        if (hasClips()) startPlayback(S.playhead, Math.max(M.duration(S.project), S.playhead) + 3600);
        S.rec.playing = E.isPlaying();
        S.rec.info = E.playInfo();
        status('info', 'Recording — press stop or Space when you are done.');
        refresh();
      }).catch(function (err) {
        S.project = M.parse(before);
        S.rec = null;
        refresh();
        status('error', err && err.name === 'NotAllowedError'
          ? 'Microphone permission was refused. Allow it in the address bar and try again.'
          : 'Could not start recording: ' + ((err && err.message) || 'no microphone found') + '.');
      });
    };
    if (countIn) {
      var n = 3, box = $('#edCount');
      box.hidden = false;
      (function tick() {
        box.textContent = n;
        if (n-- <= 0) { box.hidden = true; begin(); return; }
        setTimeout(tick, 700);
      })();
    } else {
      begin();
    }
  }

  function stopRecording() {
    if (!S.rec) return;
    var r = S.rec;
    var info = r.info;
    E.stop();
    E.stopRecording().then(function (res) {
      S.rec = null;
      if (!res) { S.project = M.parse(r.before); refresh(); status('warn', 'Nothing was recorded.'); return; }
      var start = r.start, trimHead = 0;
      if (info && res.firstT != null) {
        // Where the first sample belongs on the timeline, less the hardware
        // round trip: you heard the backing late by the output latency and the
        // microphone delivered late by the input latency.
        start = info.from + (res.firstT - info.t0) - res.latency;
      }
      if (start < 0) { trimHead = -start; start = 0; }
      var p = S.project;
      var n = p.tracks.reduce(function (a, t) { return a + t.clips.filter(function (c) { return /^Take/.test(c.name); }).length; }, 0) + 1;
      var sid = M.addSource(p, { name: 'Take ' + n, duration: res.buffer.duration, channels: res.buffer.numberOfChannels, sampleRate: res.buffer.sampleRate, kind: 'recording' });
      buffers.set(sid, res.buffer);
      V.buildPeaks(sid, res.buffer);
      var cid = M.addClip(p, r.trackId, { sourceId: sid, start: start, offset: trimHead, name: 'Take ' + n });
      hist.push(r.before);
      S.sel = {}; S.sel[cid] = true;
      S.playhead = r.start;
      changed();
      status('success', 'Recorded ' + res.buffer.duration.toFixed(1) + ' s. Press play to hear it with everything else.');
    }).catch(function (err) {
      S.rec = null;
      refresh();
      status('error', 'Recording failed: ' + ((err && err.message) || 'unknown error'));
    });
    updateTransport();
  }

  el.rec.addEventListener('click', function () { if (S.rec) stopRecording(); else startRecording(); });

  /* ---------------------------------------------------------------- export */

  var exportMode = 'mix';
  function openExport(mode) {
    closeSheet();
    exportMode = mode || 'mix';
    var what = $('#edExWhat');
    Array.prototype.forEach.call(what.options, function (o) {
      if (o.value === 'range') o.disabled = !S.range;
      if (o.value === 'clip') o.disabled = selIds().length !== 1;
      if (o.value === 'markers') o.disabled = !S.project.markers.length;
      if (o.value === 'stems') o.disabled = S.project.tracks.filter(function (t) { return t.clips.length; }).length < 2;
    });
    what.value = exportMode;
    if (what.selectedOptions[0] && what.selectedOptions[0].disabled) what.value = 'mix';
    $('#edExName').value = S.project.name || 'audiosaw-mix';
    syncExportForm();
    el.exportSheet.hidden = false;
    if (!isTouchUI()) $('#edExGo').focus();
  }
  function closeExport() { if (el.exportSheet) el.exportSheet.hidden = true; }
  function syncExportForm() {
    var fmtv = $('#edExFmt').value;
    $('#edExBitrateWrap').hidden = !/^(mp3|m4a|ogg)$/.test(fmtv);
  }
  $('#edExport').addEventListener('click', function () {
    if (!hasClips()) { status('warn', 'Add some audio first.'); return; }
    openExport(S.range ? 'range' : 'mix');
  });
  $('#edExFmt').addEventListener('change', syncExportForm);
  el.exportSheet.addEventListener('click', function (e) {
    if (e.target === el.exportSheet || e.target.closest('[data-close]')) closeExport();
  });
  CV.remember($('#edExFmt'), 'ed_fmt');
  CV.remember($('#bitrate'), 'ed_bitrate');
  CV.remember($('#edExRate'), 'ed_rate');

  function encode(buf, fmtv, bitrate, onProgress) {
    if (fmtv === 'mp3') return global.AudioSaw.audioBufferToMp3(buf, bitrate, onProgress);
    if (fmtv === 'wav') return Promise.resolve(global.AudioSaw.audioBufferToWav(buf));
    if (fmtv === 'wav32') return Promise.resolve(ST.floatWav(buf));
    var wav = global.AudioSaw.audioBufferToWav(buf);
    return global.AudioSaw.convertViaFFmpeg(new File([wav], 'mix.wav', { type: 'audio/wav' }), fmtv,
      fmtv === 'flac' ? {} : { bitrate: bitrate }, onProgress);
  }
  function extFor(fmtv) { return fmtv === 'wav32' ? 'wav' : fmtv; }

  function soloProject(trackId) {
    var p = M.copy(S.project);
    p.tracks = p.tracks.filter(function (t) { return t.id === trackId; });
    p.tracks.forEach(function (t) { t.mute = false; t.solo = false; });
    return p;
  }

  $('#edExGo').addEventListener('click', function () {
    if (busy) return;
    var what = $('#edExWhat').value, fmtv = $('#edExFmt').value;
    var bitrate = parseInt($('#bitrate').value, 10) || 192;
    var sr = parseInt($('#edExRate').value, 10) || 44100;
    var name = ($('#edExName').value || 'audiosaw-mix').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'audiosaw-mix';
    var protect = $('#edExProtect').checked;
    var channels = $('#edExMono').checked ? 1 : 2;
    closeExport();
    if (E.isPlaying()) togglePlay();

    var jobs = [];   // { project, t0, t1, name }
    var d = M.duration(S.project);
    if (what === 'range' && S.range) {
      var r = loopRange();
      jobs.push({ project: S.project, t0: r[0], t1: r[1], name: name + '-selection' });
    } else if (what === 'clip' && selIds().length === 1) {
      var f = M.findClip(S.project, selIds()[0]);
      var p1 = soloProject(f.track.id);
      p1.tracks[0].clips = p1.tracks[0].clips.filter(function (c) { return c.id === f.clip.id; });
      jobs.push({ project: p1, t0: f.clip.start, t1: M.clipEnd(f.clip), name: f.clip.name });
    } else if (what === 'markers' && S.project.markers.length) {
      var cuts = [0].concat(S.project.markers.map(function (m) { return m.t; }).filter(function (t) { return t > 0.05 && t < d - 0.05; }), [d]);
      for (var i = 0; i < cuts.length - 1; i++) {
        var label = i === 0 ? 'start' : S.project.markers.filter(function (m) { return Math.abs(m.t - cuts[i]) < 1e-6; }).map(function (m) { return m.label; })[0] || ('part ' + (i + 1));
        jobs.push({ project: S.project, t0: cuts[i], t1: cuts[i + 1], name: name + '-' + String(i + 1).padStart(2, '0') + '-' + label.replace(/[\\/:*?"<>|]+/g, '-') });
      }
    } else if (what === 'stems') {
      S.project.tracks.forEach(function (t) {
        if (t.clips.length) jobs.push({ project: soloProject(t.id), t0: 0, t1: d, name: name + '-' + t.name.replace(/[\\/:*?"<>|]+/g, '-') });
      });
    } else {
      jobs.push({ project: S.project, t0: 0, t1: d, name: name });
    }

    busy = true;
    progress(0);
    var outputs = [];
    var chain = Promise.resolve();
    jobs.forEach(function (job, idx) {
      chain = chain.then(function () {
        status('info', 'Mixing' + (jobs.length > 1 ? ' ' + (idx + 1) + ' of ' + jobs.length : '') + '…');
        return E.render(job.project, job.t0, job.t1, { sampleRate: sr, channels: channels, protect: protect });
      }).then(function (res) {
        status('info', 'Encoding ' + fmtv.replace('wav32', 'WAV') .toUpperCase() + (jobs.length > 1 ? ' ' + (idx + 1) + ' of ' + jobs.length : '') + '…');
        return encode(res.buffer, fmtv, bitrate, function (pct) {
          progress(((idx + Math.min(99, pct) / 100) / jobs.length) * 100);
        }).then(function (blob) {
          outputs.push({ name: job.name + '.' + extFor(fmtv), blob: blob, peak: res.peak });
        });
      });
    });
    chain.then(function () {
      if (outputs.length === 1) return outputs[0];
      status('info', 'Zipping ' + outputs.length + ' files…');
      return global.AudioSaw.zipBlobs(outputs).then(function (zip) { return { name: name + '.zip', blob: zip, many: outputs.length }; });
    }).then(function (out) {
      progress(100);
      CV.downloadBlob(out.blob, out.name);
      var clipped = outputs.some(function (o) { return o.peak > Math.pow(10, -1 / 20); });
      status('success', 'Exported ' + out.name + ' (' + CV.fmtBytes(out.blob.size) + ')' +
        (clipped && protect ? '. The mix peaked above 0 dB, so it was turned down to peak at -1 dB instead of clipping.' : '.'));
      setTimeout(function () { progress(null); }, 600);
    }).catch(function (err) {
      progress(null);
      status('error', 'Export failed: ' + ((err && err.message) || 'unknown error'));
    }).then(function () { busy = false; });
  });

  /* ---------------------------------------------------------- more menu */

  $('#edMore').addEventListener('click', function () {
    openSheet('Project', menuHtml([
      { v: 'add', label: 'Add audio…' },
      { v: 'track', label: 'Add an empty track' },
      { v: 'save', label: 'Save project file (.audiosaw)', hint: '⌘S', disabled: !hasClips() },
      { v: 'open', label: 'Open project file…' },
      '-',
      { v: 'full', label: el.ed.classList.contains('ed-full') ? 'Exit full screen' : 'Full screen editor' },
      { v: 'countin', label: (countIn ? '✓ ' : '') + 'Count in before recording', hint: '3, 2, 1' },
      { v: 'keys', label: 'Keyboard shortcuts', hint: '?' },
      '-',
      { v: 'new', label: 'New project', hint: 'Clears the timeline — undo still works', danger: true }
    ]), function (v) {
      closeSheet();
      if (v === 'add') el.fileInput.click();
      if (v === 'track') edit(function (p) { S.selTrack = M.addTrack(p); });
      if (v === 'save') saveProjectFile();
      if (v === 'open') $('#edProjectInput').click();
      if (v === 'full') toggleFull();
      if (v === 'countin') { countIn = !countIn; try { localStorage.setItem('as_ed_countin', countIn ? '1' : '0'); } catch (e) {} toast(countIn ? 'Count-in on' : 'Count-in off'); }
      if (v === 'keys') keysSheet();
      if (v === 'new') {
        if (E.isPlaying()) togglePlay();
        edit(function (p) { p.tracks = []; p.markers = []; p.name = 'Untitled project'; });
        S.sel = {}; S.range = null; S.playhead = 0; S.scrollT = 0; S.pps = 40;
        refresh();
        toast('New project — undo brings the old one back');
      }
    });
  });

  function toggleFull() {
    var on = !el.ed.classList.contains('ed-full');
    el.ed.classList.toggle('ed-full', on);
    document.documentElement.classList.toggle('ed-locked', on);
    $('#edFull').setAttribute('aria-pressed', String(on));
    setTimeout(function () { refresh(); zoomFit(); }, 30);
  }
  $('#edFull').addEventListener('click', toggleFull);

  function saveProjectFile() {
    if (!hasClips()) return;
    status('info', 'Packing the project…');
    ST.exportProject(S.project, buffers, files).then(function (zip) {
      // Straight to the browser's download, not CV.downloadBlob: a project file
      // is not a conversion and must not count as one.
      var url = URL.createObjectURL(zip), a = document.createElement('a');
      a.href = url; a.download = (S.project.name || 'project').replace(/[\\/:*?"<>|]+/g, '-') + '.audiosaw';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      status('success', 'Saved ' + a.download + ' (' + CV.fmtBytes(zip.size) + '). Drop it back on this page to carry on editing.');
    }).catch(function (err) { status('error', 'Could not save the project: ' + err.message); });
  }

  function openProjectFile(file) {
    if (busy) return;
    busy = true;
    status('info', 'Opening ' + file.name + '…');
    progress(5);
    ST.importProject(file, function (i, n) { progress(i / n * 100); }).then(function (res) {
      adopt(res);
      status('success', 'Opened ' + file.name + '.');
    }).catch(function (err) {
      status('error', 'Could not open that project: ' + err.message);
    }).then(function () { progress(null); busy = false; });
  }
  $('#edProjectInput').addEventListener('change', function (e) {
    var f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) openProjectFile(f);
  });

  // Take over a project loaded from storage or a file.
  function adopt(res) {
    var before = M.serialize(S.project);
    res.buffers.forEach(function (b, id) { buffers.set(id, b); V.buildPeaks(id, b); });
    res.files.forEach(function (f, id) { files.set(id, f); });
    var p = res.project;
    // A restored file may decode a sample longer or shorter than it did before
    // (a different output device means a different sample rate).
    Object.keys(p.sources).forEach(function (id) {
      var b = buffers.get(id);
      if (b) p.sources[id].duration = b.duration;
    });
    p.tracks.forEach(function (t) {
      t.clips = t.clips.filter(function (c) { return buffers.has(c.sourceId); });
      t.clips.forEach(function (c) {
        var sd = p.sources[c.sourceId].duration;
        if (c.offset + c.duration > sd) c.duration = Math.max(M.MIN_LEN, sd - c.offset);
      });
    });
    S.project = p;
    if (hasClips() || M.parse(before).tracks.length) hist.push(before);
    S.sel = {}; S.range = null; S.playhead = 0;
    changed();
    zoomFit();
  }

  /* -------------------------------------------------------------- autosave */

  var saveTimer = 0, saving = false, saveAgain = false, saveDisabled = false;
  function scheduleSave() {
    if (saveDisabled) return;
    clearTimeout(saveTimer);
    setSaved('pending');
    saveTimer = setTimeout(doSave, 1200);
  }
  function doSave() {
    if (saving) { saveAgain = true; return; }
    saving = true;
    setSaved('saving');
    ST.save(S.project, buffers, files).then(function () {
      setSaved('saved');
    }).catch(function (err) {
      setSaved('failed');
      if (err && /quota/i.test(err.name + ' ' + err.message)) {
        saveDisabled = true;
        status('warn', 'This project is too big for the browser to keep between visits. Use Project → Save project file to keep it.');
      }
    }).then(function () {
      saving = false;
      if (saveAgain) { saveAgain = false; doSave(); }
    });
  }
  function setSaved(state) {
    if (!el.saved) return;
    el.saved.dataset.state = state;
    el.saved.textContent = { pending: 'Unsaved changes', saving: 'Saving…', saved: 'Saved in this browser', failed: 'Not saved' }[state] || '';
  }

  function restoreSession() {
    if (busy) return;
    busy = true;
    status('info', 'Restoring your last session…');
    progress(5);
    ST.load(function (i, n) { progress(i / n * 100); }).then(function (res) {
      if (!res) { status('warn', 'Nothing to restore.'); return; }
      adopt(res);
      el.restore.hidden = true;
      status('success', 'Restored — everything is where you left it.');
    }).catch(function (err) {
      status('error', 'Could not restore the last session: ' + err.message);
    }).then(function () { progress(null); busy = false; });
  }

  ST.peek().then(function (info) {
    if (!info || hasClips() || !el.restore) return;
    var ago = info.savedAt ? Math.round((Date.now() - info.savedAt) / 60000) : null;
    var when = ago == null ? '' : ago < 2 ? 'just now' : ago < 90 ? ago + ' min ago' : ago < 60 * 36 ? Math.round(ago / 60) + ' h ago' : Math.round(ago / 1440) + ' days ago';
    el.restore.querySelector('[data-restore-text]').textContent =
      '“' + (info.project.name || 'Untitled') + '” · ' + info.clips + ' clip' + (info.clips > 1 ? 's' : '') + (when ? ' · ' + when : '');
    el.restore.hidden = false;
  });

  /* ------------------------------------------------------------ layout */

  function applyLayout() {
    var small = global.matchMedia('(max-width: 700px)').matches;
    var th = small ? 80 : 96;
    if (S.trackH !== th) { S.trackH = th; }
    S.viewH = el.scroll.clientHeight;
    refresh();
  }
  if (global.ResizeObserver) new ResizeObserver(function () { applyLayout(); }).observe(el.stage);
  else global.addEventListener('resize', applyLayout);
  global.addEventListener('pagehide', function () { if (saveTimer) { clearTimeout(saveTimer); doSave(); } });

  applyLayout();
  updateTransport();
})(window);
