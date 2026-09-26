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
  var D = global.ASEditDsp, FXUI = global.ASEditFxUI, LINK = global.ASEditLink, L = global.ASLink, MIDI = global.ASEditMidi;
  if (!CV || !M || !E || !V || !FX || !ST || !D || !FXUI || !LINK || !L) {
    console.error('[audio-editor] a script is missing or loaded out of order; the editor cannot start.');
    return;
  }
  var $ = CV.$;

  var ACCEPT = ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus', '.aif', '.aiff',
    '.m4b', '.m4r', '.wma', '.caf', '.ac3', '.weba', '.amr', '.3gp',
    '.mp4', '.mov', '.webm', '.mkv', '.avi', '.audiosaw', '.mid', '.midi'];

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
    viewTop: 0, viewH: 400,
    autoLanes: {}            // trackId -> the automation path shown on it
  };
  var hist = new M.History(200);
  var files = new Map();     // sourceId -> original File, for autosave and project files
  var clipboard = null;
  var playStart = 0;         // where the current playback began

  var el = {
    ed: $('#ed'), stage: $('#edStage'), scroll: $('#edScroll'), heads: $('#edHeads'),
    ruler: $('#edRuler'), corner: $('#edCorner'), lanes: $('#edLanes'), empty: $('#dropzone'), fileInput: $('#fileInput'),
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
  function endLive(opts) {
    if (liveSnap === null) return;
    var was = liveSnap;
    liveSnap = null;
    if (M.serialize(S.project) !== was) { hist.push(was); changed(opts); }
  }
  function isLive() { return liveSnap !== null; }
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
  //
  // Looping itself happens in the engine, which schedules each pass ahead
  // on the audio clock; this only tells it what to loop, since Loop can be
  // switched and the range redrawn while playing.
  function checkEnd() {
    if (!E.isPlaying() || (S.rec && !S.rec.loop)) return E.position();
    E.setLoop(wantLoop());
    var pos = E.position();
    if (S.rec && S.rec.loop) {
      // A new pass has begun: start its waveform afresh.
      var L = S.rec.loop, n = E.passes().length;
      if (n > L.seen) {
        L.seen = n;
        S.rec.peaks = []; S.rec.length = 0; S.rec.acc = 0; S.rec.accN = 0;
        status('info', 'Loop recording — pass ' + n + '. Press stop when you have a take you like.');
      }
    }
    if (E.isLooping() || pos < E.playEnd() - 0.005) return pos;
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

  // In bars mode the big readout is bar.beat.sixteenth and the small one is
  // the same moment in minutes and seconds.
  function updateTime() {
    var bars = S.project.ruler === 'bars';
    el.time.textContent = bars ? M.fmtBars(S.project, S.playhead) : fmt(S.playhead);
    var d = M.duration(S.project);
    if (el.total) {
      el.total.textContent = bars ? fmt(S.playhead) : fmt(d, false);
      el.total.classList.toggle('is-now', bars);
    }
    // The ruler's corner names what the ruler counts and opens the tempo sheet.
    var pk = S.project.key, K = global.ASKey;
    var corner = (bars ? '' : 'time · ') + S.project.bpm + ' BPM · ' + S.project.sig.join('/') + (pk && K ? ' · ' + K.keyName(pk.pc, pk.mode) : '');
    if (el.corner && el.corner.textContent !== corner) el.corner.textContent = corner;
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
    FXUI.refresh();
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
      var lane = S.autoLanes[t.id], info = lane ? FXUI.laneInfo(t, lane) : null;
      var hasAuto = Object.keys(t.auto || {}).length > 0;
      html += '<div class="' + cls + '" style="height:' + h + 'px" data-track="' + t.id + '">' +
        '<button type="button" class="ed-head-name" data-act="track" title="Track settings">' + esc(t.name) + '</button>' +
        '<div class="ed-head-btns">' +
        '<button type="button" class="ed-ms' + (t.mute ? ' on' : '') + '" data-act="mute" aria-pressed="' + t.mute + '" title="Mute">M</button>' +
        '<button type="button" class="ed-ms ed-solo' + (t.solo ? ' on' : '') + '" data-act="solo" aria-pressed="' + t.solo + '" title="Solo">S</button>' +
        '<button type="button" class="ed-ms ed-fxb' + (t.fx.length ? ' on' : '') + '" data-act="fx" title="Effects and sends (F)" aria-label="Effects on ' + esc(t.name) + (t.fx.length ? ', ' + t.fx.length + ' in use' : '') + '">FX</button>' +
        '<button type="button" class="ed-ms ed-autob' + (lane ? ' on' : hasAuto ? ' has' : '') + '" data-act="auto" aria-pressed="' + !!lane + '" title="Automation lane (A)" aria-label="Automation on ' + esc(t.name) + '">A</button>' +
        '</div>' +
        (info
          ? '<button type="button" class="ed-lane" data-act="lane" title="Choose what this lane automates">' + esc(info.label) + ' ▾</button>'
          : '<label class="ed-vol"><span class="sr-only">Volume of ' + esc(t.name) + '</span>' +
            '<input type="range" min="-30" max="12" step="0.5" value="' + t.volDb + '" data-act="vol" aria-label="Volume of ' + esc(t.name) + '"></label>') +
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
    if (act === 'fx') { S.selTrack = id; FXUI.open(id); refresh(); }
    if (act === 'auto') toggleAuto(id);
    if (act === 'lane') laneSheet(id);
  });
  el.heads.addEventListener('input', function (e) {
    if (e.target.getAttribute('data-act') !== 'vol') return;
    var id = e.target.closest('[data-track]').getAttribute('data-track');
    beginLive();
    M.setTrack(S.project, id, { volDb: +e.target.value });
    E.updateTracks(S.project);
  });
  el.heads.addEventListener('change', function (e) {
    if (e.target.getAttribute('data-act') === 'vol') { endLive({ noRestart: true }); }
  });

  /* ------------------------------------------------------- automation */

  // Show or hide a track's automation lane. It opens on whatever was last
  // automated there, or on volume.
  function toggleAuto(id) {
    var t = S.project.tracks[M.trackIndex(S.project, id)];
    if (!t) return;
    if (S.autoLanes[id]) { delete S.autoLanes[id]; refresh(); return; }
    var paths = Object.keys(t.auto);
    S.autoLanes[id] = paths.length ? paths[paths.length - 1] : 'vol';
    S.selTrack = id;
    refresh();
    toast(isTouchUI() ? 'Tap the lane to add a point, drag a point to move it, double-tap to delete' : 'Click the lane to add a point, drag to move, double-click to delete');
  }

  function laneSheet(id) {
    var t = S.project.tracks[M.trackIndex(S.project, id)];
    if (!t) return;
    var cur = S.autoLanes[id];
    var items = FXUI.lanePaths(t).map(function (x) {
      return { v: 'p' + x[0], label: (x[0] === cur ? '✓ ' : '') + x[1], hint: t.auto[x[0]] ? t.auto[x[0]].length + ' pts' : '' };
    });
    items.push('-');
    if (cur && t.auto[cur]) items.push({ v: 'clear', label: 'Clear this lane', danger: true });
    items.push({ v: 'hide', label: 'Hide automation' });
    openSheet('Automate on ' + t.name, menuHtml(items), function (v) {
      closeSheet();
      if (v === 'hide') { delete S.autoLanes[id]; refresh(); return; }
      if (v === 'clear') { edit(function (p) { M.clearAuto(p, id, cur); }, { noRestart: true }); E.relane(S.project); E.syncFx(S.project); return; }
      S.autoLanes[id] = v.slice(1);
      refresh();
    });
  }

  function laneOf(track) {
    var path = S.autoLanes[track.id];
    if (!path) return null;
    var info = FXUI.laneInfo(track, path);
    if (!info) { delete S.autoLanes[track.id]; return null; }
    return { path: path, info: info, pts: track.auto[path] || null };
  }
  function laneTop(ti) { return ti * S.trackH + 10; }
  function laneH() { return S.trackH - 20; }
  function laneY(info, v, ti) { return laneTop(ti) + (1 - info.toNorm(v)) * laneH(); }
  function laneV(info, y, ti) { return info.fromNorm(1 - (y - laneTop(ti)) / laneH()); }

  // Drawn by the view over the clips of a track whose lane is showing.
  S.autoDraw = function (g, track, ti, y, th, w, css) {
    var L = laneOf(track);
    if (!L) return;
    g.fillStyle = 'rgba(251,246,237,0.62)';
    g.fillRect(0, y, w, th - 1);
    var col = '#2f6f4f';
    g.strokeStyle = col; g.lineWidth = 2;
    g.beginPath();
    if (!L.pts) {
      g.setLineDash([6, 5]);
      var y0 = laneY(L.info, L.info.value, ti);
      g.moveTo(0, y0); g.lineTo(w, y0); g.stroke(); g.setLineDash([]);
    } else {
      g.moveTo(0, laneY(L.info, L.pts[0][1], ti));
      L.pts.forEach(function (pt) { g.lineTo(view.x(pt[0]), laneY(L.info, pt[1], ti)); });
      g.lineTo(w, laneY(L.info, L.pts[L.pts.length - 1][1], ti));
      g.stroke();
      var r = view.touch ? 6 : 4.5;
      L.pts.forEach(function (pt, i) {
        var x = view.x(pt[0]);
        if (x < -10 || x > w + 10) return;
        var hot = S.autoHot && S.autoHot.track === track.id && S.autoHot.i === i;
        g.beginPath(); g.arc(x, laneY(L.info, pt[1], ti), hot ? r + 2 : r, 0, Math.PI * 2);
        g.fillStyle = hot ? col : '#fff'; g.fill(); g.stroke();
      });
    }
    g.font = '600 11px ' + css.sans; g.textBaseline = 'top';
    var label = L.info.label + (S.autoHot && S.autoHot.track === track.id && S.autoHot.text ? '  ·  ' + S.autoHot.text : '') + (L.pts ? '' : '  ·  ' + (view.touch ? 'tap' : 'click') + ' to add a point');
    var tw = g.measureText(label).width;
    g.fillStyle = 'rgba(47,111,79,0.92)'; g.fillRect(6, y + 4, tw + 12, 17);
    g.fillStyle = '#fff'; g.fillText(label, 12, y + 7);
  };

  // A press on a track that is showing its lane edits the lane, not the clips.
  // Returns true when it took the gesture.
  function autoDown(e, h, p, touch) {
    var L = laneOf(h.track);
    if (!L) return false;
    var ti = h.ti, pts = L.pts || [], r = touch ? 18 : 9, hit = -1, bd = r;
    pts.forEach(function (pt, i) {
      var d = Math.hypot(view.x(pt[0]) - p.x, laneY(L.info, pt[1], ti) - p.y);
      if (d <= bd) { bd = d; hit = i; }
    });
    var now = Date.now();
    if (hit >= 0 && lastAutoTap && lastAutoTap.track === h.track.id && lastAutoTap.i === hit && now - lastAutoTap.at < 380) {
      // Double tap: delete the point.
      lastAutoTap = null;
      edit(function (pp) {
        var t = pp.tracks[M.trackIndex(pp, h.track.id)];
        var next = (t.auto[L.path] || []).filter(function (x, i) { return i !== hit; });
        M.setAutoPoints(pp, h.track.id, L.path, next);
      }, { noRestart: true });
      E.relane(S.project); E.syncFx(S.project);
      down = null;
      return true;
    }
    lastAutoTap = hit >= 0 ? { track: h.track.id, i: hit, at: now } : null;
    if (hit >= 0) {
      beginLive();
      down.mode = 'autoPoint'; down.lane = L; down.i = hit;
      S.autoHot = { track: h.track.id, i: hit, text: L.info.fmt(pts[hit][1]) };
      draw();
      return true;
    }
    if (touch) { down.mode = 'pending-auto'; down.lane = L; return true; }
    // Mouse: add a point where it landed and keep dragging it.
    beginLive();
    var idx = addAutoPoint(h.track, L, view.t(p.x), laneV(L.info, p.y, ti));
    down.mode = 'autoPoint'; down.lane = L; down.i = idx;
    return true;
  }
  var lastAutoTap = null;

  function addAutoPoint(track, L, t, v) {
    var pts = (track.auto[L.path] || []).slice();
    // The first point of a new lane keeps the current setting everywhere
    // else, so drawing one point does not jump the whole song to it.
    if (!pts.length && Math.abs(t) > 0.01) pts.push([0, L.info.value]);
    pts.push([Math.max(0, t), v]);
    M.setAutoPoints(S.project, track.id, L.path, pts);
    var arr = track.auto[L.path];
    var idx = 0;
    for (var i = 0; i < arr.length; i++) if (Math.abs(arr[i][0] - Math.max(0, t)) < 1e-9 && arr[i][1] === v) idx = i;
    S.autoHot = { track: track.id, i: idx, text: L.info.fmt(v) };
    E.relane(S.project); E.syncFx(S.project);
    draw();
    return idx;
  }

  function autoMove(p) {
    var f = M.trackIndex(S.project, down.hit.track.id), track = S.project.tracks[f];
    var pts = track && track.auto[down.lane.path];
    if (!pts || !pts[down.i]) return;
    var lo = down.i > 0 ? pts[down.i - 1][0] + 0.001 : 0, hi = down.i < pts.length - 1 ? pts[down.i + 1][0] - 0.001 : Infinity;
    var t = Math.min(hi, Math.max(lo, snapT(view.t(p.x), null, true)));
    var v = laneV(down.lane.info, Math.max(laneTop(f), Math.min(laneTop(f) + laneH(), p.y)), f);
    pts[down.i] = [t, v];
    S.autoHot = { track: track.id, i: down.i, text: down.lane.info.fmt(v) + ' @ ' + fmt(t) };
    E.relane(S.project); E.syncFx(S.project);
    draw();
  }

  el.scroll.addEventListener('scroll', function () {
    S.viewTop = el.scroll.scrollTop; S.viewH = el.scroll.clientHeight; draw();
  });

  /* ------------------------------------------------------------ transport */

  // What the engine should loop right now, or null.
  function wantLoop() {
    if (S.rec) return S.rec.loop ? [S.rec.loop.r0, S.rec.loop.r1] : null;
    return S.loop ? loopRange() : null;
  }

  function loopRange() {
    if (S.range) return [Math.min(S.range.t0, S.range.t1), Math.max(S.range.t0, S.range.t1)];
    return [0, M.duration(S.project)];
  }

  function startPlayback(from, to, opts) {
    E.unlock();
    playStart = from;
    var ok = E.play(S.project, from, { to: to, countIn: opts && opts.countIn, loop: wantLoop() });
    S.playhead = from;
    clearTimeout(endTimer);
    if (ok && isFinite(to)) endTimer = setTimeout(function tick() {
      checkEnd();
      if (E.isPlaying() && (!S.rec || S.rec.loop)) endTimer = setTimeout(tick, 250);
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

  // The clip's source as it really is, and whether the engine converts it to
  // play it. Exports convert with the sinc resampler, not this path.
  function sourceLine(c) {
    var s = S.project.sources[c.sourceId], b = buffers.get(c.sourceId);
    if (!s) return '';
    var fmtTxt = s.format || [(s.sampleRate / 1000) + ' kHz', s.kind === 'recording' || s.kind === 'derived' ? '32-bit float' : '', s.channels === 1 ? 'mono' : 'stereo'].filter(Boolean).join(' · ');
    if (s.kind === 'midi') fmtTxt = 'MIDI notes, played by the track’s instrument';
    var er = E.currentRate(), note = er && b && b.sampleRate !== er ? ' · played through the ' + (er / 1000) + ' kHz engine (exports keep ' + (b.sampleRate / 1000) + ' kHz)' : '';
    return '<p class="ed-insp-src">' + esc((s.kind === 'recording' ? 'Recording' : s.kind === 'derived' ? 'Processed' : 'Source') + ': ' + fmtTxt + note) + '</p>';
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
    var rb = $('#edRate');
    if (rb) { var er = E.currentRate(); rb.textContent = er ? (er / 1000) + ' kHz' : 'Device rate'; rb.disabled = !!S.rec; }
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
    mixer: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3v18M12 3v18M18 3v18" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" opacity=".5"/><rect x="3.5" y="13" width="5" height="3.5" rx="1" fill="currentColor"/><rect x="9.5" y="6" width="5" height="3.5" rx="1" fill="currentColor"/><rect x="15.5" y="10" width="5" height="3.5" rx="1" fill="currentColor"/></svg>',
    click: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 21h8l-3-17h-2zM12 14l6-8" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round" stroke-linecap="round"/></svg>',
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
    { id: 'mixer', label: 'Mixer', icon: 'mixer', key: 'F' },
    { id: 'fx', label: 'Process', icon: 'fx' },
    { id: 'marker', label: 'Marker', icon: 'marker', key: 'M' },
    { id: 'zoomout', label: 'Zoom out', icon: 'zout', key: '−' },
    { id: 'zoomin', label: 'Zoom in', icon: 'zin', key: '+' },
    { id: 'fit', label: 'Fit', icon: 'fit', key: '0' },
    { id: 'snap', label: 'Snap', icon: 'snap', key: 'N', toggle: true },
    { id: 'click', label: 'Click', icon: 'click', key: 'K', toggle: true }
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
      case 'mixer': if (FXUI.isOpen()) FXUI.close(); else FXUI.open(S.selTrack); break;
      case 'marker': edit(function (p) { M.addMarker(p, S.playhead); }, { noRestart: true }); toast('Marker added'); break;
      case 'zoomin': zoomAt(1.6, view.x(S.playhead) >= 0 && view.x(S.playhead) <= lanesWidth() ? view.x(S.playhead) : lanesWidth() / 2); break;
      case 'zoomout': zoomAt(1 / 1.6, view.x(S.playhead) >= 0 && view.x(S.playhead) <= lanesWidth() ? view.x(S.playhead) : lanesWidth() / 2); break;
      case 'fit': zoomFit(); break;
      case 'snap': S.snap = !S.snap; updateToolbar(); toast(S.snap ? 'Snapping on' : 'Snapping off'); break;
      case 'click': setClick(!clickOn); toast(clickOn ? 'Metronome on — ' + S.project.bpm + ' BPM, ' + S.project.sig.join('/') : 'Metronome off'); break;
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
      mixer: S.project.tracks.length > 0,
      marker: any,
      zoomin: any, zoomout: any, fit: any, snap: true, click: true
    };
    Array.prototype.forEach.call(el.tools.querySelectorAll('[data-tool]'), function (b) {
      var id = b.getAttribute('data-tool');
      b.disabled = !can[id];
      if (id === 'snap') b.setAttribute('aria-pressed', String(S.snap));
      if (id === 'click') b.setAttribute('aria-pressed', String(clickOn));
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
        '<button type="button" class="ed-btn" data-i="fx" title="Render an effect into this part of the audio">Process…</button>' +
        '<button type="button" class="ed-btn" data-i="tool" title="Open one of the site’s tools with this part of the audio, and bring the result back">Send to a tool…</button>' +
        '<button type="button" class="ed-btn" data-i="rangeExport">Export selection</button>' +
        '<button type="button" class="ed-btn ed-btn-ghost" data-i="clear">Clear</button>' +
        '</div>';
    } else if (ids.length === 1) {
      var f = M.findClip(S.project, ids[0]), c = f.clip;
      html = sourceLine(c) + '<div class="ed-insp-head"><label class="ed-name"><span class="sr-only">Clip name</span><input type="text" data-i="name" value="' + esc(c.name) + '" maxlength="80"></label>' +
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
        '<button type="button" class="ed-btn" data-i="trackfx" title="Live effects on the whole track: adjustable any time">Track effects</button>' +
        '<button type="button" class="ed-btn" data-i="fx" title="Render an effect into this clip">Process…</button>' +
        '<button type="button" class="ed-btn" data-i="tool" title="Open one of the site’s tools with this clip, and bring the result back">Send to a tool…</button>' +
        '<button type="button" class="ed-btn" data-i="rippleDelete">Delete (close gap)</button>' +
        '<button type="button" class="ed-btn" data-i="newTrack">Move to new track</button>' +
        '<button type="button" class="ed-btn" data-i="clipExport">Export this clip</button>' +
        '</div>';
    } else if (ids.length > 1) {
      html = '<div class="ed-insp-head"><strong>' + ids.length + ' clips selected</strong></div>' +
        '<div class="ed-insp-btns">' +
        '<button type="button" class="ed-btn" data-i="fx">Process all…</button>' +
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
      case 'tool': if (!S.range && refuseMidi('Sending to a tool')) break; LINK.toolSheet(S.range ? 'range' : 'clip'); break;
      case 'trackfx': { var ff = M.findClip(S.project, ids[0]); if (ff) FXUI.open(ff.track.id); break; }
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
    if (MIDI.isMidiClip(clipId)) { midiClipMenu(clipId); return; }
    openSheet(c.name, menuHtml([
      { v: 'split', label: 'Split at playhead', hint: 'S' },
      { v: 'dup', label: 'Duplicate', hint: '⌘D' },
      { v: 'copy', label: 'Copy', hint: '⌘C' },
      { v: 'cut', label: 'Cut', hint: '⌘X' },
      { v: 'trackfx', label: 'Track effects…', hint: 'live' },
      { v: 'fx', label: 'Process…', hint: 'renders' },
      { v: 'tool', label: 'Send to a tool…', hint: 'and back' },
      { v: 'fittempo', label: 'Fit to the project tempo…', hint: S.project.bpm + ' BPM' },
      { v: 'takes', label: 'Takes…', hint: M.takesAt(S.project, M.findClip(S.project, clipId).track.id, c.start, M.clipEnd(c)).length + ' kept', disabled: !M.takesAt(S.project, M.findClip(S.project, clipId).track.id, c.start, M.clipEnd(c)).length },
      { v: 'slice', label: 'Slice at the hits', hint: 'splits the clip' },
      { v: 'chords', label: (S.project.sources[c.sourceId] || {}).chords ? 'Detect chords again' : 'Detect chords', hint: 'shown on the clip' },
      { v: 'fitkey', label: 'Match the project key…', hint: S.project.key && global.ASKey ? global.ASKey.keyName(S.project.key.pc, S.project.key.mode) : 'set a key first' },
      { v: 'tomidi', label: 'Convert to MIDI', hint: 'one voice or instrument' },
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
      if (v === 'tool') LINK.toolSheet('clip');
      if (v === 'fittempo') fitTempoSheet(clipId);
      if (v === 'fitkey') matchKeySheet(clipId);
      if (v === 'chords') detectChords(clipId);
      if (v === 'slice') sliceAtHits(clipId);
      if (v === 'takes') takesSheet(clipId);
      if (v === 'tomidi') MIDI.convert(clipId);
      if (v === 'trackfx') FXUI.open(M.findClip(S.project, clipId).track.id);
      if (v === 'fadein') quickFade('in');
      if (v === 'fadeout') quickFade('out');
      if (v === 'export') openExport('clip');
      if (v === 'del') doDelete(false);
      if (v === 'ripple') doDelete(true);
    });
  }

  // A MIDI clip's menu: the same clip edits, with the MIDI ones in place of
  // those that need samples (Process, tools, tempo fit, slicing, chords).
  function midiClipMenu(clipId) {
    var f = M.findClip(S.project, clipId), c = f.clip, nk = M.takesAt(S.project, f.track.id, c.start, M.clipEnd(c)).length;
    openSheet(c.name, menuHtml([
      { v: 'notes', label: 'Edit notes…', hint: M.clipNotes(S.project, c).length + ' notes' },
      { v: 'inst', label: 'Instrument…', hint: MIDI.instLabel(MIDI.instOf(f.track, S.project.sources[c.sourceId])) },
      { v: 'mid', label: 'Download .mid' },
      { v: 'bounce', label: 'Bounce to audio', hint: 'for effects and tools' },
      '-',
      { v: 'split', label: 'Split at playhead', hint: 'S' },
      { v: 'dup', label: 'Duplicate', hint: '⌘D' },
      { v: 'copy', label: 'Copy', hint: '⌘C' },
      { v: 'cut', label: 'Cut', hint: '⌘X' },
      { v: 'trackfx', label: 'Track effects…', hint: 'live' },
      { v: 'takes', label: 'Takes…', hint: nk + ' kept', disabled: !nk },
      { v: 'fadein', label: c.fadeIn ? 'Remove fade in' : 'Fade in' },
      { v: 'fadeout', label: c.fadeOut ? 'Remove fade out' : 'Fade out' },
      { v: 'export', label: 'Export this clip as audio' },
      '-',
      { v: 'del', label: 'Delete', hint: 'Del', danger: true },
      { v: 'ripple', label: 'Delete and close the gap', hint: '⇧Del', danger: true }
    ]), function (v) {
      closeSheet();
      if (v === 'notes') MIDI.editNotes(clipId);
      if (v === 'inst') MIDI.instrumentSheet(f.track.id);
      if (v === 'mid') MIDI.downloadMid(clipId);
      if (v === 'bounce') MIDI.bounce(clipId);
      if (v === 'split') doSplit();
      if (v === 'dup') doDuplicate();
      if (v === 'copy') doCopy();
      if (v === 'cut') doCopy(true);
      if (v === 'trackfx') FXUI.open(f.track.id);
      if (v === 'takes') takesSheet(clipId);
      if (v === 'fadein') quickFade('in');
      if (v === 'fadeout') quickFade('out');
      if (v === 'export') openExport('clip');
      if (v === 'del') doDelete(false);
      if (v === 'ripple') doDelete(true);
    });
  }

  // Process and "Send to a tool" work on samples. A MIDI clip in the
  // selection has none until it is bounced, so say that instead of failing.
  function midiInSelection() {
    if (S.range) {
      var r = loopRange(), tr = S.range.tracks;
      return S.project.tracks.some(function (t) {
        if (tr && tr.length && tr.indexOf(t.id) < 0) return false;
        return t.clips.some(function (c) { return c.start < r[1] && M.clipEnd(c) > r[0] && M.isMidi(S.project, c.sourceId); });
      });
    }
    return MIDI.anyMidi(selIds());
  }
  function refuseMidi(what) {
    if (!midiInSelection()) return false;
    status('warn', what + ' works on audio. Right-click the MIDI clip and choose Bounce to audio first; undo turns it back into notes.');
    return true;
  }

  /* ------------------------------------------------ fit a clip to the song */

  function only(clipId) { S.sel = {}; S.sel[clipId] = true; S.range = null; }

  // Stretch a clip to the project tempo without changing its pitch. The
  // clip's own tempo is detected (or remembered, if it was fitted before, or
  // typed), and half and double are one click away, as on /bpm-finder.
  function fitTempoSheet(clipId) {
    var f = M.findClip(S.project, clipId);
    if (!f) return;
    var c = f.clip, src = S.project.sources[c.sourceId], buf = buffers.get(c.sourceId), target = S.project.bpm;
    openSheet('Fit to the project tempo', '<div class="ed-form"><label>Tempo of “' + esc(c.name) + '” <input type="number" min="20" max="400" step="0.1" data-k="bpm" value="' + (src && src.bpm ? src.bpm : '') + '" inputmode="decimal"></label></div>' +
      '<div class="ed-insp-btns"><button type="button" class="ed-btn" data-v="half">Half</button><button type="button" class="ed-btn" data-v="double">Double</button>' +
      '<button type="button" class="ed-btn" data-v="detect">Detect again</button></div>' +
      '<p class="ed-sheet-note" data-fit-note></p>' +
      '<div class="ed-sheet-actions"><button type="button" class="ed-btn ed-btn-primary" data-v="ok">Fit to ' + target + ' BPM</button></div>', function (v) {
      var inp = el.sheetBody.querySelector('[data-k="bpm"]');
      if (v === 'half') { inp.value = (parseFloat(inp.value) / 2).toFixed(1); explain(); return; }
      if (v === 'double') { inp.value = (parseFloat(inp.value) * 2).toFixed(1); explain(); return; }
      if (v === 'detect') { detect(); return; }
      if (v === 'ok') {
        var from = parseFloat(inp.value);
        if (!(from >= 20 && from <= 400)) { note('Type the clip’s tempo, or press Detect.'); return; }
        var rate = target / from;
        closeSheet();
        if (Math.abs(rate - 1) < 0.0005) { toast('Already at ' + target + ' BPM'); return; }
        only(clipId);
        applyFx('tempoFit', rate.toFixed(6) + '@' + target);
      }
    });
    var inp = el.sheetBody.querySelector('[data-k="bpm"]');
    function note(t) { var n = el.sheetBody.querySelector('[data-fit-note]'); if (n) n.textContent = t; }
    function explain(extra) {
      var from = parseFloat(inp.value);
      if (!(from >= 20 && from <= 400)) { note(extra || ''); return; }
      var rate = target / from;
      note((extra ? extra + ' ' : '') + (rate > 1 ? rate.toFixed(3) + '× faster' : (1 / rate).toFixed(3) + '× slower') +
        ': ' + c.duration.toFixed(2) + ' s becomes ' + (c.duration / rate).toFixed(2) + ' s, at the same pitch.' +
        (rate > 1.5 || rate < 0.67 ? ' That is a big stretch and will sound processed; check half or double.' : ''));
    }
    function detect() {
      if (!buf || !global.ASBpm) return;
      note('Listening…');
      setTimeout(function () {
        var res = global.ASBpm.analyse(slice(buf, c.offset, Math.min(c.duration, 90)));
        if (!res || res.confidence < 0.06) { note('No steady beat found in “' + c.name + '”. Type its tempo if you know it.'); return; }
        // Of the reading, half and double, offer the one nearest the target:
        // a 70 BPM loop going into a 140 project is a 140 loop.
        var best = [res.bpm, res.bpm / 2, res.bpm * 2].sort(function (a, b) { return Math.abs(Math.log(a / target)) - Math.abs(Math.log(b / target)); })[0];
        inp.value = best.toFixed(1);
        explain('Read ' + res.bpm.toFixed(1) + ' BPM' + (best !== res.bpm ? ', using ' + best.toFixed(1) + ' as nearer the project' : '') + '.');
      }, 30);
    }
    inp.addEventListener('input', function () { explain(); });
    if (src && src.bpm) explain('Fitted before at ' + src.bpm + ' BPM.'); else detect();
  }

  // Split a clip at every hit, with the same detector as /sample-slicer:
  // cuts land just before each attack, on a zero crossing, so the pieces
  // can be moved or duplicated without clicks. One undo step.
  function sliceAtHits(clipId) {
    var f = M.findClip(S.project, clipId), SLR = global.ASSlicer;
    if (!f || !SLR) return;
    var c = f.clip, buf = buffers.get(c.sourceId);
    if (!buf) return;
    var part = slice(buf, c.offset, c.duration), ch = [];
    for (var i = 0; i < part.numberOfChannels; i++) ch.push(part.getChannelData(i));
    var hits = SLR.onsets(ch, part.sampleRate).filter(function (t) { return t > M.MIN_LEN && t < c.duration - M.MIN_LEN; });
    if (!hits.length) { status('warn', 'No hits found inside “' + c.name + '” to slice at.'); return; }
    var ids = [clipId];
    edit(function (p) {
      hits.forEach(function (t) { ids = ids.concat(M.splitAt(p, c.start + t, ids)); });
    });
    S.sel = {};
    ids.forEach(function (id) { if (M.findClip(S.project, id)) S.sel[id] = true; });
    refresh();
    status('success', 'Sliced “' + c.name + '” into ' + (hits.length + 1) + ' pieces at the hits. Undo puts it back together.');
  }

  // Chords for the whole of the clip's source, so trimming the clip later
  // does not lose them. With the bars ruler on, the analysis is cut at the
  // project's beats, so chord changes land on the grid.
  function detectChords(clipId) {
    var K = global.ASKey, f = M.findClip(S.project, clipId);
    if (!K || !f) return;
    var c = f.clip, buf = buffers.get(c.sourceId);
    if (!buf) return;
    status('info', 'Listening for chords in “' + c.name + '”…');
    setTimeout(function () {
      var p = S.project, beats = null;
      if (p.ruler === 'bars') {
        // Beats in source time: the grid is on the timeline, the source starts
        // at clip.start - clip.offset.
        var s0 = c.start - c.offset;
        beats = M.gridLines(p, s0, s0 + buf.duration, 1).map(function (g) { return g.t - s0; });
      }
      var ch = [];
      for (var i = 0; i < buf.numberOfChannels; i++) ch.push(buf.getChannelData(i));
      var list = K.chords(ch, buf.sampleRate, { beats: beats });
      if (!list.length || list.every(function (x) { return x.name === 'N'; })) { status('warn', 'No clear chords in “' + c.name + '”.'); return; }
      edit(function (pp) {
        var src = pp.sources[c.sourceId];
        if (src) src.chords = list.map(function (x) { return { t0: Math.round(x.t0 * 1000) / 1000, t1: Math.round(x.t1 * 1000) / 1000, name: x.name }; });
      }, { noRestart: true });
      var names = [];
      list.forEach(function (x) { if (x.name !== 'N' && names[names.length - 1] !== x.name) names.push(x.name); });
      status('success', 'Chords in “' + c.name + '”: ' + names.slice(0, 12).join(' – ') + (names.length > 12 ? ' …' : '') + '. They are drawn along the bottom of the clip.');
    }, 30);
  }

  // Detect a clip's key and move it into the project key by the shortest
  // shift. Relative keys count as the same (A minor needs nothing to sit in
  // C major); the other direction is offered too, since +5 and -7 land on
  // the same notes an octave apart.
  function matchKeySheet(clipId) {
    var K = global.ASKey, pk = S.project.key;
    if (!K) return;
    if (!pk) { toast('Set the project key first'); tempoSheet(); return; }
    var f = M.findClip(S.project, clipId);
    if (!f) return;
    var c = f.clip, buf = buffers.get(c.sourceId), res = null, use = null;
    openSheet('Match the project key', '<p class="ed-sheet-note" data-key-note>Listening for the key of “' + esc(c.name) + '”…</p><div class="ed-insp-btns" data-key-btns></div>', function (v) {
      if (v === 'alt') { use = use === res ? res.runnerUp : res; render(); return; }
      if (/^[-0-9]+$/.test(v)) { closeSheet(); only(clipId); applyFx('pitch', v); }
    });
    function render() {
      var st = K.shiftBetween(use, pk), other = st > 0 ? st - 12 : st + 12;
      var noteEl = el.sheetBody.querySelector('[data-key-note]'), btns = el.sheetBody.querySelector('[data-key-btns]');
      if (!noteEl) return;
      noteEl.textContent = '“' + c.name + '” reads ' + use.name + ' (' + use.camelot + ')' + (use === res ? '' : ', the alternative reading') +
        '. The project is in ' + K.keyName(pk.pc, pk.mode) + '.' + (st === 0 ? ' They already share their notes, so nothing needs to move.' : '');
      var sem = function (n) { return (n > 0 ? 'Up ' : 'Down ') + Math.abs(n) + ' semitone' + (Math.abs(n) === 1 ? '' : 's'); };
      btns.innerHTML = (st ? '<button type="button" class="ed-btn ed-btn-primary" data-v="' + st + '">' + sem(st) + '</button>' +
        '<button type="button" class="ed-btn" data-v="' + other + '">' + sem(other) + '</button>' : '') +
        '<button type="button" class="ed-btn" data-v="alt">It is ' + (use === res ? res.runnerUp.name : res.name) + '</button>';
    }
    setTimeout(function () {
      if (!buf) return;
      var part = slice(buf, c.offset, Math.min(c.duration, 240)), ch = [];
      for (var i = 0; i < part.numberOfChannels; i++) ch.push(part.getChannelData(i));
      res = K.analyse(ch, part.sampleRate);
      var n = el.sheetBody.querySelector('[data-key-note]');
      if (!res) { if (n) n.textContent = 'Nothing tonal in “' + c.name + '” to read a key from.'; return; }
      use = res;
      render();
    }, 30);
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
        { v: 'inst', label: 'Instrument for MIDI…', hint: MIDI.instLabel(t.inst || 'keys') },
        { v: 'midi', label: 'New MIDI clip here', hint: 'at the playhead' },
        '-',
        { v: 'remove', label: 'Delete track', danger: true }
      ]);
    html = html.replace('<div class="ed-menu">', '<div class="ed-menu">' +
      '<button type="button" class="ed-menu-item" data-v="fx"><span>Effects and sends…</span><small>' + (t.fx.length ? t.fx.length + ' in use' : 'F') + '</small></button>' +
      '<button type="button" class="ed-menu-item" data-v="auto"><span>' + (S.autoLanes[id] ? 'Hide automation' : 'Show automation') + '</span><small>A</small></button>' +
      (S.autoLanes[id] ? '<button type="button" class="ed-menu-item" data-v="lane"><span>Choose what the lane automates…</span></button>' : '') + '<hr>');
    openSheet('Track', html, function (v) {
      if (v === 'fx') { closeSheet(); FXUI.open(id); return; }
      if (v === 'auto') { closeSheet(); toggleAuto(id); return; }
      if (v === 'lane') { closeSheet(); laneSheet(id); return; }
      if (v === 'inst') { closeSheet(); MIDI.instrumentSheet(id); return; }
      if (v === 'midi') { closeSheet(); S.selTrack = id; MIDI.newClip(); return; }
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
    body.addEventListener('change', function () { endLive({ noRestart: true }); });
  }
  function panLabel(p) { return Math.abs(p) < 0.03 ? 'centre' : (p < 0 ? Math.round(-p * 100) + '% left' : Math.round(p * 100) + '% right'); }

  function keysSheet() {
    var rows = [
      ['Space', 'Play / pause'], ['S or ⌘B', 'Split at the playhead'], ['Delete', 'Delete (a range closes up)'],
      ['⇧ Delete', 'Delete clips and close the gap'], ['⌘Z / ⇧⌘Z', 'Undo / redo'], ['⌘C ⌘X ⌘V', 'Copy, cut, paste at the playhead'],
      ['⌘D', 'Duplicate'], ['⌘A', 'Select every clip'], ['Esc', 'Clear the selection'], ['← →', 'Nudge clips 10 ms (⇧ for 1 s), or move the playhead'],
      ['+ / −  or ⌘ wheel', 'Zoom'], ['0', 'Zoom to fit'], ['M', 'Add a marker'], ['L', 'Loop on / off'], ['R', 'Record'], ['N', 'Snap on / off'], ['K', 'Metronome on / off'], ['G', 'Ruler in bars and beats / in time'],
      ['Home / End', 'Jump to start / end'], ['Double-click the ruler', 'Select that bar (bars ruler)'], ['Alt while dragging', 'Drag without snapping'],
      ['F', 'Mixer and effects for the selected track'], ['A', 'Show the selected track’s automation lane']
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
    if (refuseMidi('Process')) return;
    var html = '<div class="ed-fx-grid">' + FX.ORDER.map(function (id) {
      var f = FX.FX[id];
      return '<button type="button" class="ed-fx" data-v="' + id + '"><strong>' + esc(f.label) + '</strong><small>' + esc(f.hint) + '</small></button>';
    }).join('') + '</div>';
    html = '<p class="ed-sheet-note mx-sheet-lead">These render new audio into the ' + (S.range ? 'selection' : 'clip') + ' (undo takes them off). For effects you can keep adjusting, use <button type="button" class="ed-linkbtn" data-v="__mixer">Track effects</button>.</p>' + html;
    openSheet(S.range ? 'Process the selection' : 'Process', html, function (id) {
      if (id === '__mixer') {
        closeSheet();
        var ff = selIds().length ? M.findClip(S.project, selIds()[0]) : null;
        FXUI.open(ff ? ff.track.id : S.selTrack);
        return;
      }
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
        if (out._meta) Object.keys(out._meta).forEach(function (k) { S.project.sources[sid][k] = out._meta[k]; });
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
      return global.AudioSaw.convert(file, 'wav32f', {}, function (pct, msg) {
        progress(pct);
        if (msg && onProgress) onProgress(msg);
      }).then(function (wav) {
        return global.AudioSaw.decodeToAudioBuffer(new File([wav], baseName(file.name) + '.wav', { type: 'audio/wav' }));
      });
    });
  }
  ST.decode = function (f) { return decodeFile(f); };

  // .mid files: each part on a new track, starting at the playhead or where
  // the file was dropped (at 0:00 into an empty project).
  function importMidi(mids, place) {
    busy = true;
    var before = M.serialize(S.project), added = [], notes = 0, chain = Promise.resolve();
    mids.forEach(function (f) {
      chain = chain.then(function () {
        return MIDI.importFile(f, { t: place.mode === 'at' || place.mode === 'tracks' ? place.t : 0 }).then(function (r) {
          added = added.concat(r.ids); notes += r.notes;
        }).catch(function (err) {
          status('error', 'Could not open ' + f.name + ': ' + ((err && err.message) || 'not a MIDI file') + '.');
        });
      });
    });
    return chain.then(function () {
      busy = false;
      if (M.serialize(S.project) === before) return;
      hist.push(before);
      S.sel = {}; added.forEach(function (id) { S.sel[id] = true; });
      var wasEmpty = M.parse(before).tracks.every(function (t) { return !t.clips.length; });
      changed();
      if (wasEmpty) zoomFit();
      status('success', 'Added ' + notes + ' notes on ' + added.length + ' MIDI track' + (added.length === 1 ? '' : 's') + '. Right-click a clip to edit its notes or choose the instrument.');
    });
  }

  // place: { mode: 'end' | 'tracks' | 'at', t, ti }
  function importFiles(list, place) {
    list = list.filter(Boolean);
    if (!list.length) return;
    var proj = list.filter(function (f) { return /\.audiosaw$/i.test(f.name); });
    if (proj.length) { openProjectFile(proj[0]); return; }
    if (busy) return;
    var mids = list.filter(MIDI.isMidiFile);
    if (mids.length) {
      list = list.filter(function (f) { return !MIDI.isMidiFile(f); });
      importMidi(mids, place).then(function () { if (list.length) importFiles(list, place); });
      return;
    }
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
          name: baseName(f.name), duration: buf.duration, channels: buf.numberOfChannels, sampleRate: buf.sampleRate, kind: 'file',
          format: buf.srcInfo ? global.AudioSaw.describeFormat(buf.srcInfo) : null
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
    if (split.rejected.length) status('error', 'Wrong file type: .' + split.rejected[0].name.split('.').pop() + ' — the editor takes audio, video and MIDI files.');
    if (!split.ok.length) return;
    var rect = el.lanes.getBoundingClientRect();
    var h = view.hitTest(e.clientX - rect.left, e.clientY - rect.top, {});
    var t = Math.max(0, view.t(e.clientX - rect.left));
    if (S.snap) { var sn = M.snap(t, M.snapPoints(S.project, null, snapExtras(t)), 10 / S.pps); if (sn != null) t = sn; }
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
    // With the bars ruler the grid is not magnetic but absolute: anything
    // not pulled to a clip edge, marker or the playhead lands on the grid.
    if (hit == null && S.project.ruler === 'bars') hit = gridNear(t);
    if (hit != null) { S.snapAt = hit; return hit; }
    return t;
  }

  // The playhead, plus the nearest line of the ruler's grid: bars and beats
  // (down to the finest division drawn at this zoom) when the ruler shows
  // them, otherwise the minor tick of the seconds ruler.
  function snapExtras(t) {
    return [S.playhead, gridNear(t)];
  }
  function gridNear(t) {
    if (S.project.ruler === 'bars') return M.nearestGrid(S.project, t, V.barSteps(S.pps, S.project).minor);
    var step = V.gridStep(S.pps) / 5;
    return Math.round(t / step) * step;
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
    if (h.track && S.autoLanes[h.track.id] && e.button !== 2 && autoDown(e, h, p, touch)) return;

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
      case 'autoPoint': autoMove(p); break;
      case 'pending-auto':
        down.mode = 'pan';
        S.scrollT = Math.max(0, down.scrollT0 - (e.clientX - down.cx) / S.pps);
        clampScroll();
        el.scroll.scrollTop = down.scrollTop0 - (e.clientY - down.cy);
        updateHbar();
        draw();
        break;
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
          var pts = M.snapPoints(S.project, S.drag.ids, [S.playhead, gridNear(minStart + dt), gridNear(maxEnd + dt)]);
          var a = M.snap(minStart + dt, pts, tol), b = M.snap(maxEnd + dt, pts, tol);
          if (a != null && (b == null || Math.abs(a - minStart - dt) <= Math.abs(b - maxEnd - dt))) { dt = a - minStart; S.snapAt = a; }
          else if (b != null) { dt = b - maxEnd; S.snapAt = b; }
          else if (S.project.ruler === 'bars') { a = Math.max(0, gridNear(minStart + dt)); dt = a - minStart; S.snapAt = a; }
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
      S.autoHot = null;
      if (liveSnap !== null) endLive();
      draw();
      return;
    }
    switch (g.mode) {
      case 'autoPoint':
        S.autoHot = null;
        endLive({ noRestart: true });
        E.relane(S.project); E.syncFx(S.project);
        draw();
        break;
      case 'pending-auto':
        edit(function () { addAutoPoint(g.hit.track, g.lane, view.t(g.x0), laneV(g.lane.info, g.y0, g.hit.ti)); }, { noRestart: true });
        setTimeout(function () { S.autoHot = null; draw(); }, 900);
        break;
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
    if (h.track && S.autoLanes[h.track.id]) return;
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
    var inMixer = e.target.closest && e.target.closest('.ed-mixer');
    // In the mixer a slider or a button keeps focus after it is used; Space
    // must still play rather than nudge the slider or press the button again.
    if (inMixer && (e.key === ' ' || e.key === 'Spacebar') && (tag === 'button' || (tag === 'input' && e.target.type === 'range'))) {
      e.preventDefault();
      togglePlay();
      return;
    }
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (inMixer && e.key !== 'Escape') {
      if (e.key !== 'z' && e.key !== 'Z' && e.key !== 'y' && e.key !== 'Y') return;
    }
    if (!el.sheet.hidden || !el.exportSheet.hidden) {
      if (e.key === 'Escape') { closeSheet(); closeExport(); }
      return;
    }
    if (e.key === 'Escape' && FXUI.isOpen() && !Object.keys(S.sel).length && !S.range) { FXUI.close(); e.preventDefault(); return; }
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
    else if (k === 'k' || k === 'K') runTool('click');
    else if (k === 'g' || k === 'G') toggleRuler();
    else if (k === 'f' || k === 'F') runTool('mixer');
    else if ((k === 'a' || k === 'A') && S.selTrack) toggleAuto(S.selTrack);
    else if (k === 'Home') { seek(0); S.scrollT = 0; updateHbar(); }
    else if (k === 'End') seek(M.duration(S.project));
    else if (k === '?') keysSheet();
    else handled = false;
    if (handled) e.preventDefault();
  });

  /* ------------------------------------------------------------ recording */

  // Count-in is in bars (0, 1 or 2); the old on/off setting stored '1',
  // which reads as one bar. The metronome and its level are preferences of
  // the person, not of the project, so they live in localStorage too.
  var countIn = 0, clickOn = false, clickVol = 0.6;
  try {
    countIn = Math.max(0, Math.min(2, parseInt(localStorage.getItem('as_ed_countin'), 10) || 0));
    clickOn = localStorage.getItem('as_ed_click') === '1';
    var cv0 = parseFloat(localStorage.getItem('as_ed_clickvol'));
    if (cv0 >= 0 && cv0 <= 1) clickVol = cv0;
  } catch (e) {}
  E.setClick({ on: clickOn, vol: clickVol });

  function setClick(on, vol) {
    if (on != null) clickOn = !!on;
    if (vol != null) clickVol = vol;
    E.setClick({ on: clickOn, vol: clickVol });
    try { localStorage.setItem('as_ed_click', clickOn ? '1' : '0'); localStorage.setItem('as_ed_clickvol', String(clickVol)); } catch (e) {}
    updateToolbar();
  }
  function setCountIn(n) {
    countIn = n;
    try { localStorage.setItem('as_ed_countin', String(n)); } catch (e) {}
  }

  function toggleRuler() {
    edit(function (p) { M.setRuler(p, p.ruler === 'bars' ? 'time' : 'bars'); }, { noRestart: true });
    toast(S.project.ruler === 'bars' ? 'Ruler in bars and beats — ' + S.project.bpm + ' BPM, ' + S.project.sig.join('/') : 'Ruler in minutes and seconds');
  }

  var countTimer = 0;
  function showCountIn(t0) {
    // Beats left in the count-in, 3-2-1 in 3/4. Capped at the bar length
    // because the timeline starts ~60 ms after the call, not on a beat.
    var box = $('#edCount'), beat = M.beatSec(S.project), total = countIn * S.project.sig[0];
    clearInterval(countTimer);
    box.hidden = false;
    (function tick() {
      var left = t0 - E.now();
      if (left <= 0.005 || !S.rec) { box.hidden = true; clearInterval(countTimer); return; }
      box.textContent = Math.min(total, Math.ceil(left / beat - 1e-3));
    })();
    countTimer = setInterval(function () {
      var left = t0 - E.now();
      if (left <= 0.005 || !S.rec) { box.hidden = true; clearInterval(countTimer); if (S.rec) status('info', 'Recording — press stop or Space when you are done.'); return; }
      box.textContent = Math.min(total, Math.ceil(left / beat - 1e-3));
    }, 30);
  }

  // Recording input and quality: preferences of the person and the machine,
  // not the project, so they live in localStorage. rate 0 is the device's own.
  var recPrefs = { deviceId: '', channels: 2, rate: 0 };
  try {
    recPrefs.deviceId = localStorage.getItem('as_ed_indev') || '';
    recPrefs.channels = localStorage.getItem('as_ed_inch') === '1' ? 1 : 2;
    recPrefs.rate = parseInt(localStorage.getItem('as_ed_rate'), 10) || 0;
  } catch (e) {}
  if (recPrefs.rate) E.setSampleRate(recPrefs.rate);
  var lastDelivered = null;

  function kHz(r) { return (r / 1000).toString() + ' kHz'; }
  function describeInput(d) {
    if (!d) return '';
    return (d.label ? '“' + d.label + '”, ' : '') +
      (d.channels === 1 ? 'mono' : d.channels === 2 ? 'stereo' : (d.channels ? d.channels + ' channels' : 'stereo')) +
      ' at ' + kHz(d.engineRate) + (d.processing ? ', with the browser’s voice processing on' : '');
  }

  function inputSheet() {
    if (S.rec) { toast('Stop recording first.'); return; }
    var md = navigator.mediaDevices;
    var listing = md && md.enumerateDevices ? md.enumerateDevices().catch(function () { return []; }) : Promise.resolve([]);
    listing.then(function (devs) {
      var ins = devs.filter(function (d) { return d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications'; });
      var named = ins.some(function (d) { return d.label; });
      var devOpts = '<option value="">The default input</option>' + ins.map(function (d, i) {
        return '<option value="' + esc(d.deviceId) + '"' + (d.deviceId === recPrefs.deviceId ? ' selected' : '') + '>' + esc(d.label || 'Input ' + (i + 1)) + '</option>';
      }).join('');
      var now = E.sampleRate();
      var RATES = [[0, 'The device’s own rate'], [44100, '44.1 kHz'], [48000, '48 kHz'], [88200, '88.2 kHz'], [96000, '96 kHz'], [176400, '176.4 kHz'], [192000, '192 kHz']];
      openSheet('Recording input and quality', '<div class="ed-form">' +
        '<label>Input <select data-k="dev">' + devOpts + '</select></label>' +
        '<label>Channels <select data-k="ch">' +
          '<option value="2"' + (recPrefs.channels === 2 ? ' selected' : '') + '>Stereo: both inputs of an interface, or a stereo mic</option>' +
          '<option value="1"' + (recPrefs.channels === 1 ? ' selected' : '') + '>Mono</option>' +
        '</select></label>' +
        '<label>Engine sample rate <select data-k="rate">' + RATES.map(function (r) {
          return '<option value="' + r[0] + '"' + (r[0] === recPrefs.rate ? ' selected' : '') + '>' + r[1] + (r[0] === 0 && !recPrefs.rate ? ' (now ' + kHz(now) + ')' : '') + '</option>';
        }).join('') + '</select></label>' +
        '</div>' +
        '<p class="ed-sheet-note">Takes are captured as 32-bit float with echo cancellation, noise suppression and automatic gain off. ' +
        'The browser converts the input to the engine rate, so to record at your interface’s own rate (96 kHz, say) set the engine to it. ' +
        'Playback and export are unaffected: export can still be any rate.' +
        (named ? '' : ' Input names appear once the browser has been allowed to use the microphone.') + '</p>' +
        (lastDelivered ? '<p class="ed-sheet-note">Last take: ' + esc(describeInput(lastDelivered)) + (lastDelivered.sampleRate && lastDelivered.sampleRate !== lastDelivered.engineRate ? '; the input itself runs at ' + kHz(lastDelivered.sampleRate) : '') + '.</p>' : '') +
        '<div class="ed-sheet-actions"><button type="button" class="ed-btn ed-btn-primary" data-v="ok">Done</button></div>', function (v) {
        if (v !== 'ok') return;
        var q = function (k) { return el.sheetBody.querySelector('[data-k="' + k + '"]'); };
        recPrefs.deviceId = q('dev').value;
        recPrefs.channels = q('ch').value === '1' ? 1 : 2;
        var rate = parseInt(q('rate').value, 10) || 0;
        try {
          localStorage.setItem('as_ed_indev', recPrefs.deviceId);
          localStorage.setItem('as_ed_inch', String(recPrefs.channels));
          localStorage.setItem('as_ed_rate', String(rate));
        } catch (e) {}
        closeSheet();
        if (rate !== recPrefs.rate) {
          recPrefs.rate = rate;
          E.setSampleRate(rate || null);
          E.unlock();
          updateTransport();
          toast('Engine at ' + kHz(E.sampleRate()));
        }
      });
    });
  }
  $('#edRecSet').addEventListener('click', inputSheet);
  $('#edRate').addEventListener('click', inputSheet);

  function startRecording() {
    if (S.rec || busy) return;
    if (!global.isSecureContext || !navigator.mediaDevices) { status('error', 'Recording needs a secure (https) page and microphone support.'); return; }
    E.unlock();
    // With Loop on and a range selected, recording goes round the range and
    // every pass becomes a take.
    var loopRec = S.loop && S.range ? loopRange() : null;
    if (loopRec && loopRec[1] - loopRec[0] < 0.5) loopRec = null;
    if (loopRec) S.playhead = loopRec[0];
    var begin = function () {
      var p = S.project, target = null;
      if (loopRec && S.selTrack && M.trackIndex(p, S.selTrack) >= 0) target = S.selTrack;
      else if (S.selTrack) {
        var st = p.tracks[M.trackIndex(p, S.selTrack)];
        if (st && !st.clips.some(function (c) { return M.clipEnd(c) > S.playhead; })) target = st.id;
      }
      var before = M.serialize(p);
      if (!target) target = M.addTrack(p, { name: 'Recording ' + (p.tracks.filter(function (t) { return /^Recording/.test(t.name); }).length + 1) });
      var sr = E.sampleRate();
      S.rec = { trackId: target, start: S.playhead, length: 0, peaks: [], peakHop: 1024, sr: sr, acc: 0, accN: 0, before: before,
        loop: loopRec ? { r0: loopRec[0], r1: loopRec[1], passes: [], seen: 1 } : null };
      S.selTrack = target;
      status('info', 'Waiting for the microphone…');
      return E.startRecording(function (chans) {
        var r = S.rec;
        // Nothing is drawn until the timeline is moving: during a count-in
        // the take has not started yet.
        if (!r || !r.info || E.now() < r.info.t0) return;
        var d = chans[0];
        for (var i = 0; i < d.length; i++) {
          var v = d[i] < 0 ? -d[i] : d[i];
          if (v > r.acc) r.acc = v;
          if (++r.accN >= r.peakHop) { r.peaks.push(r.acc); r.acc = 0; r.accN = 0; }
        }
        r.length += d.length / r.sr;
        if (r.loop) r.length = Math.min(r.length, r.loop.r1 - r.loop.r0);
      }, { deviceId: recPrefs.deviceId, channels: recPrefs.channels }).then(function (delivered) {
        S.rec.delivered = delivered;
        // Always run the timeline, even over an empty project: the click and
        // the count-in are scheduled on it, and the take is placed by it.
        var pre = countIn * M.barSec(S.project);
        if (S.rec.loop) startPlayback(S.rec.loop.r0, S.rec.loop.r1, { countIn: pre });
        else startPlayback(S.playhead, Math.max(M.duration(S.project), S.playhead) + 3600, { countIn: pre });
        S.rec.playing = E.isPlaying();
        S.rec.info = E.playInfo();
        if (pre && S.rec.info) { status('info', 'Count-in — recording starts on the downbeat.'); showCountIn(S.rec.info.t0); }
        else status('info', 'Recording ' + describeInput(delivered) + ' — press stop or Space when you are done.');
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
    begin();
  }

  // What is worth saying about a take beyond its length.
  function takeNote(res) {
    var d = res.delivered || {}, out = '';
    if (res.dualMono) out += 'Both input channels carried the same signal, so the take is mono. ';
    if (d.sampleRate && d.sampleRate > res.buffer.sampleRate) out += 'Your input runs at ' + kHz(d.sampleRate) + '; set the engine to it in recording settings to record at that rate. ';
    return out;
  }

  function stopRecording() {
    if (!S.rec) return;
    var r = S.rec;
    var info = r.info;
    // Every pass the engine started, each with the audio-clock time it began.
    if (r.loop) r.loop.passes = E.passes();
    E.stop();
    E.stopRecording().then(function (res) {
      S.rec = null;
      if (!res) { S.project = M.parse(r.before); refresh(); status('warn', 'Nothing was recorded.'); return; }
      if (r.loop) { placeLoopTakes(r, res); return; }
      var start = r.start, trimHead = 0;
      if (info && res.firstT != null) {
        // Where the first sample belongs on the timeline, less the hardware
        // round trip: you heard the backing late by the output latency and the
        // microphone delivered late by the input latency.
        start = info.from + (res.firstT - info.t0) - res.latency;
      }
      // The take starts where recording was asked to start. The microphone
      // opens a little before the timeline moves, and a count-in is whole
      // bars before it; that audio would otherwise carve into whatever sits
      // before the playhead on this track.
      if (start < r.start) { trimHead = r.start - start; start = r.start; }
      if (trimHead >= res.buffer.duration - 0.05) { S.project = M.parse(r.before); refresh(); status('warn', 'Stopped during the count-in — nothing was recorded.'); return; }
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
      lastDelivered = res.delivered;
      status('success', 'Recorded ' + res.buffer.duration.toFixed(1) + ' s, ' + (res.buffer.numberOfChannels === 1 ? 'mono' : 'stereo') + ' at ' + kHz(res.buffer.sampleRate) + '. ' + takeNote(res) + 'Press play to hear it with everything else.');
    }).catch(function (err) {
      S.rec = null;
      refresh();
      status('error', 'Recording failed: ' + ((err && err.message) || 'unknown error'));
    });
    updateTransport();
  }

  // One recording, cut into a clip per pass. Pass k's audio for timeline
  // time tau sits at buffer time (tau - r0) + (t0_k - firstT) + latency, the
  // same placement as a single take, once per pass. The last pass that got
  // at least halfway round plays; the others become takes, and so does
  // whatever was on the track in that range before.
  function placeLoopTakes(r, res) {
    var L = r.loop, len = L.r1 - L.r0, dur = res.buffer.duration, p = S.project;
    var pieces = [];
    L.passes.forEach(function (info, k) {
      if (!info || res.firstT == null) return;
      var off = (info.t0 - res.firstT) + res.latency, avail = dur - off;
      if (off < 0 || avail < Math.min(len, 0.5)) return;
      if (avail < len * 0.5 && k > 0) return;          // stopped just after coming round
      pieces.push({ off: off, len: Math.min(len, avail), n: k + 1 });
    });
    if (!pieces.length) { S.project = M.parse(r.before); refresh(); status('warn', 'Stopped before a pass was recorded.'); return; }
    var n = p.tracks.reduce(function (a, t) { return a + t.clips.filter(function (c) { return /^Take/.test(c.name); }).length; }, 0) + 1;
    var sid = M.addSource(p, { name: 'Loop take ' + n, duration: dur, channels: res.buffer.numberOfChannels, sampleRate: res.buffer.sampleRate, kind: 'recording' });
    buffers.set(sid, res.buffer);
    V.buildPeaks(sid, res.buffer);
    var last = pieces[pieces.length - 1], track = p.tracks[M.trackIndex(p, r.trackId)];
    var before = M.clipsIn(track.clips, L.r0, L.r0 + last.len);
    if (before.length) M.addTake(p, r.trackId, before, 'Before recording');
    pieces.slice(0, -1).forEach(function (pc) {
      M.addTake(p, r.trackId, [{ sourceId: sid, name: 'Take ' + n + '.' + pc.n, start: L.r0, offset: pc.off, duration: pc.len }], 'Pass ' + pc.n);
    });
    var cid = M.addClip(p, r.trackId, { sourceId: sid, start: L.r0, offset: last.off, duration: last.len, name: 'Take ' + n + '.' + last.n });
    hist.push(r.before);
    S.sel = {}; S.sel[cid] = true;
    S.playhead = L.r0;
    changed();
    var kept = pieces.slice(0, -1).map(function (pc) { return 'pass ' + pc.n; });
    if (before.length) kept.push('what was there before');
    status('success', 'Recorded ' + pieces.length + ' pass' + (pieces.length === 1 ? '' : 'es') + '. Pass ' + last.n + ' is playing' +
      (kept.length ? '. Kept as takes: ' + kept.join(', ') + '. Right-click or hold the clip and choose Takes to swap one in.' : '.'));
  }

  // Listen to each take of a clip's stretch and choose one, for the whole
  // clip or just the selected range. Choosing swaps, so nothing is lost.
  function takesSheet(clipId) {
    var f = M.findClip(S.project, clipId);
    if (!f) return;
    var c = f.clip, t0 = c.start, t1 = M.clipEnd(c);
    if (S.range && (!S.range.tracks || S.range.tracks.indexOf(f.track.id) >= 0)) {
      var rr = loopRange();
      if (rr[0] < t1 && rr[1] > t0) { t0 = Math.max(t0, rr[0]); t1 = Math.min(t1, rr[1]); }
    }
    var ks = M.takesAt(S.project, f.track.id, t0, t1);
    if (!ks.length) { toast('No takes under this clip'); return; }
    var part = t0 > c.start + 1e-6 || t1 < M.clipEnd(c) - 1e-6;
    openSheet('Takes for ' + fmt(t0) + '–' + fmt(t1), '<p class="ed-sheet-note">Listen to each, then use one for ' + (part ? 'the selected range' : 'this clip') +
      '. What is playing now moves into that take, so you can always swap back.' + (part ? '' : ' Select a range first to use a take for just part of it.') + '</p>' +
      '<div class="ed-takes">' + ks.map(function (k) {
        return '<div class="ed-take"><strong>' + esc(k.name) + '</strong>' +
          '<button type="button" class="ed-btn" data-v="hear:' + k.id + '">Listen</button>' +
          '<button type="button" class="ed-btn ed-btn-primary" data-v="use:' + k.id + '">Use</button>' +
          '<button type="button" class="ed-btn" data-v="del:' + k.id + '">Delete</button></div>';
      }).join('') + '</div>' +
      '<p class="ed-sheet-note"><button type="button" class="ed-btn" data-v="hear:main">Listen to what is playing</button></p>', function (v) {
      var parts = v.split(':'), id = parts[1];
      if (parts[0] === 'hear') {
        var lane = id === 'main' ? f.track : S.project.tracks[f.ti].takes.filter(function (k) { return k.id === id; })[0];
        var piece = lane && M.clipsIn(lane.clips, t0, t1)[0];
        if (piece) { E.unlock(); E.audition(piece.sourceId, piece.offset, Math.min(piece.duration, 20)); }
        return;
      }
      if (parts[0] === 'use') {
        closeSheet();
        edit(function (p) { M.useTake(p, f.track.id, id, t0, t1); });
        toast('Take used — what was there is kept as that take');
        return;
      }
      if (parts[0] === 'del') {
        closeSheet();
        edit(function (p) { var tr = p.tracks[M.trackIndex(p, f.track.id)]; tr.takes = tr.takes.filter(function (k) { return k.id !== id; }); });
        toast('Take deleted — undo brings it back');
      }
    });
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
    var fmtv = $('#edExFmt').value, what = $('#edExWhat').value;
    $('#edExBitrateWrap').hidden = !/^(mp3|m4a|ogg)$/.test(fmtv);
    // Name the rate "Match the audio" stands for, and warn that MP3 stops at 48 kHz.
    var opt = $('#edExRate').querySelector('option[value="project"]'), pr = E.projectRate(S.project);
    if (opt) opt.textContent = 'Match the audio · ' + (pr / 1000) + ' kHz';
    $('#edExStemMasterWrap').hidden = what !== 'stems';
    var anyFx = S.project.master.fx.length || S.project.tracks.some(function (t) { return t.fx.length || Object.keys(t.sends).length; });
    $('#edExTailsWrap').hidden = what === 'markers' || !anyFx;
  }
  $('#edExWhat').addEventListener('change', syncExportForm);
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
  CV.remember($('#edExTails'), 'ed_tails');

  // The mix is rendered in 32-bit float and goes to the encoder as it is:
  // PCM and FLAC are dithered to their depth, LAME and the ffmpeg codecs take
  // the float directly. `bitrate` is the select's raw value ('v0' picks LAME).
  function encode(buf, fmtv, bitrate, onProgress) {
    return global.AudioSaw.encode(buf, global.AudioSaw.resolveFormat(fmtv, bitrate), {
      bitrate: global.AudioSaw.bitrateOf(bitrate), onProgress: onProgress
    });
  }
  function extFor(fmtv) { return global.AudioSaw.extFor(fmtv); }
  // The format of the last file written, as audio-core read it back.
  var lastExport = '';
  document.addEventListener('as:encoded', function (e) {
    var d = e.detail || {};
    lastExport = (d.text || '') + (d.notes && d.notes.length ? ' · ' + d.notes.join(' · ') : '');
  });

  // One track on its own. For stems the others stay in the project, muted,
  // so a ducker on this track still hears what it listens to.
  function soloProject(trackId, keepOthers) {
    var p = M.copy(S.project);
    if (!keepOthers) p.tracks = p.tracks.filter(function (t) { return t.id === trackId; });
    p.tracks.forEach(function (t) { t.solo = false; t.mute = t.id !== trackId; });
    return p;
  }

  $('#edExGo').addEventListener('click', function () {
    if (busy) return;
    var what = $('#edExWhat').value, fmtv = $('#edExFmt').value;
    var bitrate = $('#bitrate').value;
    var sr = $('#edExRate').value === 'project' ? 'project' : (parseInt($('#edExRate').value, 10) || 'project');
    var name = ($('#edExName').value || 'audiosaw-mix').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'audiosaw-mix';
    var protect = $('#edExProtect').checked;
    var channels = $('#edExMono').checked ? 1 : 2;
    var tails = what !== 'markers' && $('#edExTails').checked;
    var noMaster = what === 'stems' && !$('#edExStemMaster').checked;
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
        if (t.clips.length) jobs.push({ project: soloProject(t.id, true), t0: 0, t1: d, name: name + '-' + t.name.replace(/[\\/:*?"<>|]+/g, '-') });
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
        return E.render(job.project, job.t0, job.t1, { sampleRate: sr, channels: channels, protect: protect, tails: tails, noMaster: noMaster });
      }).then(function (res) {
        status('info', 'Encoding ' + extFor(fmtv).toUpperCase() + (jobs.length > 1 ? ' ' + (idx + 1) + ' of ' + jobs.length : '') + '…');
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
      status('success', 'Exported ' + out.name + ' (' + CV.fmtBytes(out.blob.size) + (lastExport && !out.many ? ', ' + lastExport : '') + ')' +
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
      { v: 'midi', label: 'New MIDI clip', hint: 'at the playhead' },
      { v: 'save', label: 'Save project file (.audiosaw)', hint: '⌘S', disabled: !hasClips() },
      { v: 'open', label: 'Open project file…' },
      '-',
      { v: 'full', label: el.ed.classList.contains('ed-full') ? 'Exit full screen' : 'Full screen editor' },
      { v: 'tempo', label: 'Tempo, key and metronome…', hint: S.project.bpm + ' BPM · ' + S.project.sig.join('/') },
      { v: 'ruler', label: (S.project.ruler === 'bars' ? '✓ ' : '') + 'Ruler in bars and beats', hint: 'G' },
      { v: 'mixer', label: 'Mixer and master effects', hint: 'F' },
      { v: 'mixtool', label: 'Send the whole mix to a tool…', hint: 'and back', disabled: !hasClips() },
      { v: 'keys', label: 'Keyboard shortcuts', hint: '?' },
      '-',
      { v: 'new', label: 'New project', hint: 'Clears the timeline — undo still works', danger: true }
    ]), function (v) {
      closeSheet();
      if (v === 'add') el.fileInput.click();
      if (v === 'track') edit(function (p) { S.selTrack = M.addTrack(p); });
      if (v === 'midi') MIDI.newClip();
      if (v === 'save') saveProjectFile();
      if (v === 'open') $('#edProjectInput').click();
      if (v === 'full') toggleFull();
      if (v === 'ruler') toggleRuler();
      if (v === 'keys') keysSheet();
      if (v === 'tempo') tempoSheet();
      if (v === 'mixer') FXUI.open('master');
      if (v === 'mixtool') LINK.toolSheet('mix');
      if (v === 'new') {
        if (E.isPlaying()) togglePlay();
        // A new identity too, so a tool result meant for the old project is
        // not applied to this one.
        edit(function (p) { p.tracks = []; p.markers = []; p.name = 'Untitled project'; p.id = M.uid('p'); });
        S.sel = {}; S.range = null; S.playhead = 0; S.scrollT = 0; S.pps = 40;
        refresh();
        toast('New project — undo brings the old one back');
      }
    });
  });

  /* ---------------------------------------------------------------- tempo */

  // Tempo, time signature, where bar 1 is, and the metronome. Synced
  // delays, tremolos and filter sweeps follow the tempo too. Type it, tap it,
  // or let the BPM finder read it off the audio.
  var SIGS = [[2, 4], [3, 4], [4, 4], [5, 4], [6, 4], [7, 4], [3, 8], [5, 8], [6, 8], [7, 8], [9, 8], [12, 8]];
  // The selected clip, or the longest; audio only, since detection listens.
  function audioClipToRead() {
    var ids = selIds().filter(function (id) { return !MIDI.isMidiClip(id); }), f = ids.length ? M.findClip(S.project, ids[0]) : null, clip = f ? f.clip : null;
    if (!clip) M.allClips(S.project).forEach(function (c) { if (buffers.get(c.clip.sourceId) && (!clip || c.clip.duration > clip.duration)) clip = c.clip; });
    return clip;
  }

  function tempoSheet() {
    var taps = [], p0 = S.project, offset = p0.gridOffset, sigNow = p0.sig.join('/'), K = global.ASKey;
    var keyNow = p0.key ? p0.key.pc + '-' + p0.key.mode : '';
    var keyOpts = '<option value="">Not set</option>' + (K ? ['major', 'minor'].map(function (mode) {
      var o = '';
      for (var pc = 0; pc < 12; pc++) o += '<option value="' + pc + '-' + mode + '"' + (keyNow === pc + '-' + mode ? ' selected' : '') + '>' + K.keyName(pc, mode) + ' (' + K.camelot(pc, mode) + ')</option>';
      return o;
    }).join('') : '');
    if (!SIGS.some(function (x) { return x.join('/') === sigNow; })) SIGS.push(p0.sig.slice());
    openSheet('Tempo, key and metronome', '<div class="ed-form">' +
      '<label>Beats per minute <input type="number" min="20" max="400" step="0.1" data-k="bpm" value="' + p0.bpm + '" inputmode="decimal"></label>' +
      '<label>Time signature <select data-k="sig">' + SIGS.map(function (x) {
        var v = x.join('/');
        return '<option value="' + v + '"' + (v === sigNow ? ' selected' : '') + '>' + v + '</option>';
      }).join('') + '</select></label>' +
      '<label>Key <select data-k="key">' + keyOpts + '</select></label>' +
      '<label class="ed-check"><input type="checkbox" data-k="ruler"' + (p0.ruler === 'bars' ? ' checked' : '') + '> Show bars and beats on the ruler, and snap to them</label>' +
      '</div>' +
      '<div class="ed-insp-btns"><button type="button" class="ed-btn" data-v="tap">Tap along</button>' +
      '<button type="button" class="ed-btn" data-v="detect"' + (hasClips() ? '' : ' disabled') + '>Detect from the audio</button>' +
      '<button type="button" class="ed-btn" data-v="bar1">Bar 1 at the playhead</button>' +
      (K ? '<button type="button" class="ed-btn" data-v="detectkey"' + (hasClips() ? '' : ' disabled') + '>Detect the key</button>' : '') + '</div>' +
      '<p class="ed-sheet-note" data-tempo-note>Tap in time with the music, four or more times. Detection reads the longest clip, or the selected one. ' +
      'If the song does not start on a downbeat at 0:00, put the playhead on one and press “Bar 1 at the playhead”.</p>' +
      '<div class="ed-form">' +
      '<label class="ed-check"><input type="checkbox" data-k="click"' + (clickOn ? ' checked' : '') + '> Metronome click while playing and recording (K)</label>' +
      '<label>Click level <input type="range" min="0" max="1" step="0.05" data-k="clickvol" value="' + clickVol + '"></label>' +
      '<label>Count-in before recording <select data-k="countin">' +
      [[0, 'None'], [1, 'One bar'], [2, 'Two bars']].map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === countIn ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') +
      '</select></label></div>' +
      '<p class="ed-sheet-note">The click goes to your speakers only. It is never in an export, a bounce or anything sent to a tool. Wear headphones when recording or the microphone will hear it.</p>' +
      '<div class="ed-sheet-actions"><button type="button" class="ed-btn ed-btn-primary" data-v="ok">Done</button></div>', function (v) {
      var q = function (k) { return el.sheetBody.querySelector('[data-k="' + k + '"]'); };
      var inp = q('bpm'), note = el.sheetBody.querySelector('[data-tempo-note]');
      if (v === 'tap') {
        var now = performance.now();
        if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
        taps.push(now);
        if (taps.length >= 3) {
          var iv = [];
          for (var i = 1; i < taps.length; i++) iv.push(taps[i] - taps[i - 1]);
          iv.sort(function (a, b) { return a - b; });
          inp.value = (60000 / iv[Math.floor(iv.length / 2)]).toFixed(1);
          note.textContent = taps.length + ' taps';
        }
        return;
      }
      if (v === 'bar1') {
        offset = S.playhead;
        q('ruler').checked = true;
        note.textContent = 'Bar 1 will start at ' + fmt(offset) + '. The grid runs back from there too, so earlier audio still lines up.';
        return;
      }
      if (v === 'detectkey') {
        var kclip = audioClipToRead();
        var kbuf = kclip && buffers.get(kclip.sourceId);
        if (!kbuf) { note.textContent = 'Detection listens to audio clips, and there are none to read a key from.'; return; }
        note.textContent = 'Listening for the key…';
        setTimeout(function () {
          var part = slice(kbuf, kclip.offset, Math.min(kclip.duration, 240)), ch = [];
          for (var c = 0; c < part.numberOfChannels; c++) ch.push(part.getChannelData(c));
          var res = K.analyse(ch, part.sampleRate);
          if (!res) { note.textContent = 'Nothing tonal in “' + kclip.name + '” to read a key from.'; return; }
          q('key').value = res.pc + '-' + res.mode;
          note.textContent = 'Read ' + res.name + ' (' + res.camelot + ') from “' + kclip.name + '”' +
            (res.confidence === 'clear' ? '.' : ' — or possibly ' + res.runnerUp.name + '; pick it above if that sounds right.');
        }, 30);
        return;
      }
      if (v === 'detect') {
        var clip = audioClipToRead();
        var buf = clip && buffers.get(clip.sourceId);
        if (!buf || !global.ASBpm) { note.textContent = 'Detection listens to audio clips, and there are none. Tap along instead.'; return; }
        note.textContent = 'Listening…';
        setTimeout(function () {
          var res = global.ASBpm.analyse(slice(buf, clip.offset, Math.min(clip.duration, 90)));
          if (!res) { note.textContent = 'No steady beat found in “' + clip.name + '”. Tap along instead.'; return; }
          inp.value = res.bpm.toFixed(1);
          var ph = res.confidence >= 0.06 && global.ASBpm.phase ? global.ASBpm.phase(slice(buf, clip.offset, Math.min(clip.duration, 90)), res.bpm, parseInt(q('sig').value, 10) || 4) : null;
          if (ph) {
            // Line the grid up with the beats. The beat itself is measured;
            // which beat is "one" is a guess, and the note says so.
            offset = clip.start + ph.downbeat;
            q('ruler').checked = true;
          }
          note.textContent = 'Read ' + res.bpm.toFixed(1) + ' BPM from “' + clip.name + '”' + (res.confidence < 0.5 ? ' — not certain; tap along to check. Half or double is common.' : '.') +
            (ph ? ' The grid will line up with its beats. Bar 1 is a guess at ' + fmt(offset) + '; if it is off by a beat, put the playhead on the real downbeat and press “Bar 1 at the playhead”.' : '');
        }, 30);
        return;
      }
      if (v === 'ok') {
        var b = parseFloat(inp.value), sig = q('sig').value.split('/').map(Number), ruler = q('ruler').checked ? 'bars' : 'time';
        var kv = q('key').value, key = kv ? { pc: parseInt(kv, 10), mode: kv.split('-')[1] } : null;
        var keyChanged = JSON.stringify(key) !== JSON.stringify(S.project.key);
        setClick(q('click').checked, parseFloat(q('clickvol').value));
        setCountIn(parseInt(q('countin').value, 10) || 0);
        closeSheet();
        var p = S.project, tempoChanged = b >= 20 && b <= 400 && b !== p.bpm;
        if (tempoChanged || keyChanged || sig.join('/') !== p.sig.join('/') || ruler !== p.ruler || offset !== p.gridOffset) {
          edit(function (p) {
            if (key) M.setKey(p, key.pc, key.mode); else M.setKey(p, null);
            if (b >= 20 && b <= 400) M.setBpm(p, b);
            M.setSig(p, sig[0], sig[1]);
            M.setRuler(p, ruler);
            M.setGridOffset(p, offset);
          }, { noRestart: true });
          E.syncFx(S.project);
          // Synced times are computed when a plugin is built or set, and the
          // click is scheduled from the tempo; nudge them.
          if (E.isPlaying()) restartPlayback();
          toast(S.project.bpm + ' BPM · ' + S.project.sig.join('/') + (S.project.key && K ? ' · ' + K.keyName(S.project.key.pc, S.project.key.mode) : ''));
        }
      }
    });
  }

  el.corner.addEventListener('click', tempoSheet);

  // In bars mode, a double-click on the ruler selects that whole bar, so
  // looping a bar is a double-click and L.
  el.ruler.addEventListener('dblclick', function (e) {
    if (S.project.ruler !== 'bars' || !hasClips()) return;
    var p = S.project, bar = M.barSec(p), t = view.t(localXY(e, el.ruler).x);
    var a = p.gridOffset + Math.floor((t - p.gridOffset) / bar) * bar;
    S.sel = {};
    S.range = { t0: Math.max(0, a), t1: a + bar, tracks: null };
    seek(Math.max(0, a));
    updateInspector(); updateToolbar(); draw();
    toast('Bar ' + M.fmtBars(p, a, p.sig[0]) + ' selected — L to loop it');
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
    var p = M.normalize(res.project);
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
  // Another tab owns the project (editor-link.js holds a Web Lock). Two tabs
  // saving one project is last-write-wins at best, and at worst one tab's
  // clean-up deletes audio the other still points at.
  var saveBlocked = false;
  var saveWaiters = [];      // flushSave() callers, settled when the last queued save lands
  function scheduleSave() {
    if (saveDisabled || saveBlocked) return;
    clearTimeout(saveTimer);
    setSaved('pending');
    saveTimer = setTimeout(doSave, 1200);
  }
  function doSave() {
    saveTimer = 0;
    if (saveBlocked) return;
    if (saving) { saveAgain = true; return; }
    saving = true;
    setSaved('saving');
    var failure = null;
    ST.save(S.project, buffers, files).then(function () {
      setSaved('saved');
      // Tell tool pages there is a project, without them opening its database.
      if (hasClips()) L.setFlag({ id: S.project.id, name: S.project.name, at: Date.now() });
    }).catch(function (err) {
      failure = err || new Error('not saved');
      setSaved('failed');
      if (err && /quota/i.test(err.name + ' ' + err.message)) {
        saveDisabled = true;
        status('warn', 'This project is too big for the browser to keep between visits. Use Project → Save project file to keep it.');
      }
    }).then(function () {
      saving = false;
      if (saveAgain) { saveAgain = false; doSave(); return; }
      var w = saveWaiters; saveWaiters = [];
      w.forEach(function (x) { if (failure) x.reject(failure); else x.resolve(); });
    });
  }
  // Save now and resolve once it is on disk. The pagehide flush cannot be
  // relied on before a navigation: it starts IndexedDB work the page may not
  // live to finish, and a tool round trip needs the project to be there.
  function flushSave() {
    if (saveDisabled) return Promise.reject(new Error('autosave is off for this project'));
    if (saveBlocked) return Promise.reject(new Error('this project is open in another tab'));
    clearTimeout(saveTimer);
    return new Promise(function (resolve, reject) {
      saveWaiters.push({ resolve: resolve, reject: reject });
      doSave();
    });
  }
  function setSaved(state) {
    if (!el.saved) return;
    el.saved.dataset.state = state;
    el.saved.textContent = { pending: 'Unsaved changes', saving: 'Saving…', saved: 'Saved in this browser', failed: 'Not saved', blocked: 'Not saving: open in another tab' }[state] || '';
  }

  // Resolves true once the stored project is loaded.
  function restoreSession() {
    if (busy) return Promise.resolve(false);
    busy = true;
    status('info', 'Restoring your last session…');
    progress(5);
    return ST.load(function (i, n) { progress(i / n * 100); }).then(function (res) {
      if (!res) { status('warn', 'Nothing to restore.'); return false; }
      adopt(res);
      el.restore.hidden = true;
      status('success', 'Restored — everything is where you left it.');
      return true;
    }).catch(function (err) {
      status('error', 'Could not restore the last session: ' + err.message);
      return false;
    }).then(function (ok) { progress(null); busy = false; return ok; });
  }

  function offerRestore(info) {
    if (!info || hasClips() || !el.restore) return;
    var ago = info.savedAt ? Math.round((Date.now() - info.savedAt) / 60000) : null;
    var when = ago == null ? '' : ago < 2 ? 'just now' : ago < 90 ? ago + ' min ago' : ago < 60 * 36 ? Math.round(ago / 60) + ' h ago' : Math.round(ago / 1440) + ' days ago';
    el.restore.querySelector('[data-restore-text]').textContent =
      '“' + (info.project.name || 'Untitled') + '” · ' + info.clips + ' clip' + (info.clips > 1 ? 's' : '') + (when ? ' · ' + when : '');
    el.restore.hidden = false;
  }

  /* ------------------------------------------------------------ layout */

  function applyLayout() {
    var small = global.matchMedia('(max-width: 700px)').matches;
    var th = small ? 90 : 96;
    if (S.trackH !== th) { S.trackH = th; }
    S.viewH = el.scroll.clientHeight;
    refresh();
  }
  if (global.ResizeObserver) new ResizeObserver(function () { applyLayout(); }).observe(el.stage);
  else global.addEventListener('resize', applyLayout);
  global.addEventListener('pagehide', function () { if (saveTimer) { clearTimeout(saveTimer); doSave(); } });

  FXUI.init({
    S: S, el: el, esc: esc, edit: edit, beginLive: beginLive, endLive: endLive, isLive: isLive,
    refresh: refresh, buildHeads: buildHeads, toast: toast, openSheet: openSheet, closeSheet: closeSheet,
    menuHtml: menuHtml, isTouchUI: isTouchUI, layout: applyLayout, tempoSheet: tempoSheet
  });
  $('#edMixerBtn').addEventListener('click', function () { if (FXUI.isOpen()) FXUI.close(); else FXUI.open(S.selTrack); });

  MIDI.init({
    S: S, buffers: buffers, edit: edit, status: status, toast: toast, openSheet: openSheet, closeSheet: closeSheet, menuHtml: menuHtml,
    isBusy: function () { return busy; }, setBusy: function (b) { busy = b; },
    select: function (cid) { if (cid) { S.sel = {}; S.sel[cid] = true; S.range = null; refresh(); } }
  });

  LINK.init({
    S: S, buffers: buffers, esc: esc, edit: edit, refresh: refresh, status: status,
    openSheet: openSheet, closeSheet: closeSheet, menuHtml: menuHtml, selIds: selIds, slice: slice,
    decodeFile: decodeFile, importFiles: importFiles, flushSave: flushSave, restore: restoreSession,
    isBusy: function () { return busy; }, setBusy: function (b) { busy = b; }, loopRange: loopRange,
    saveDisabled: function () { return saveDisabled; },
    setSaveBlocked: function (b) {
      saveBlocked = b;
      if (b) { clearTimeout(saveTimer); saveTimer = 0; setSaved('blocked'); }
      else if (el.saved && el.saved.dataset.state === 'blocked') setSaved('');
    },
    hasClips: hasClips,
    stopPlayback: function () { if (E.isPlaying()) togglePlay(); }
  });

  // A tool's result waiting to come back takes precedence over the restore
  // banner: it restores the project itself. "Back to the editor" from a tool
  // page (?resume=1) restores without asking, since that is what it said.
  LINK.checkReturn().then(function (handled) {
    if (handled) return;
    return ST.peek().then(function (info) {
      if (info && !hasClips() && /[?&]resume=1/.test(global.location.search)) {
        restoreSession();
        try { global.history.replaceState(null, '', global.location.pathname); } catch (e) {}
        return;
      }
      offerRestore(info);
    });
  });

  applyLayout();
  updateTransport();
})(window);
