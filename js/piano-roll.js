/*
 * A small piano roll: draw, select, move, stretch, add and delete notes, on a
 * beat grid, with undo. Used by /audio-to-midi to check and fix a
 * transcription before it is written out, because a pitch tracker's typical
 * mistakes (a stray blip on a breath, a note split in two by vibrato, one
 * octave slip) take seconds to fix by eye and are painful to find in a DAW.
 *
 * Notes are {midi, start, duration, velocity} in seconds; the grid is in
 * beats at `bpm`. Snapping is to the grid division when one is set.
 *
 *   var roll = new ASPianoRoll(canvas, { bpm, division, onChange });
 *   roll.setNotes(notes); roll.notes(); roll.quantize(); roll.undo();
 *   roll.playhead = t; roll.draw();
 */
(function (global) {
  'use strict';

  var NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  var BLACK = [1, 3, 6, 8, 10];
  var KEYW = 38, ROWH = 12, EDGE = 6;

  function Roll(canvas, opts) {
    this.cv = canvas;
    this.opts = opts || {};
    this.bpm = this.opts.bpm || 120;
    this.division = this.opts.division || 4;       // grid lines per beat
    this.list = [];
    this.sel = -1;
    this.undoStack = [];
    this.playhead = null;
    this.pxPerSec = 120;
    this.scrollX = 0;
    this.drag = null;
    this.bind();
  }

  Roll.prototype.setNotes = function (notes) {
    this.list = notes.map(function (n) { return { midi: n.midi, start: n.start, duration: n.duration, velocity: n.velocity || 96 }; });
    this.sel = -1;
    this.undoStack = [];
    this.rng = null;
    this.fit();
    this.draw();
  };
  Roll.prototype.notes = function () {
    return this.list.slice().sort(function (a, b) { return a.start - b.start; }).map(function (n) { return Object.assign({}, n); });
  };
  Roll.prototype.setBpm = function (bpm, division) { this.bpm = bpm; if (division != null) this.division = division; this.draw(); };

  // Pitch range: the notes plus a little room, at least two octaves. Fixed
  // when notes are loaded, so rows do not rescale under a note being
  // dragged, and widened only when a note goes past the edge.
  Roll.prototype.range = function () {
    if (!this.rng) this.rng = this.computeRange();
    var self = this;
    this.list.forEach(function (n) {
      if (n.midi < self.rng.lo) self.rng.lo = n.midi - 1;
      if (n.midi > self.rng.hi) self.rng.hi = n.midi + 1;
    });
    return this.rng;
  };
  Roll.prototype.computeRange = function () {
    var lo = 60, hi = 72;
    if (this.list.length) {
      lo = Infinity; hi = -Infinity;
      this.list.forEach(function (n) { lo = Math.min(lo, n.midi); hi = Math.max(hi, n.midi); });
    }
    lo -= 3; hi += 3;
    while (hi - lo < 24) { lo--; hi++; }
    return { lo: lo, hi: hi };
  };

  Roll.prototype.fit = function () {
    var end = 1;
    this.list.forEach(function (n) { end = Math.max(end, n.start + n.duration); });
    var w = this.cv.clientWidth - KEYW;
    this.pxPerSec = Math.max(20, Math.min(400, w / (end + 0.5)));
    this.scrollX = 0;
    var r = this.range();
    this.cv.style.height = Math.min(520, (r.hi - r.lo + 1) * ROWH) + 'px';
  };

  Roll.prototype.snap = function (t) {
    if (!this.division) return t;
    var step = 60 / this.bpm / this.division;
    return Math.round(t / step) * step;
  };
  Roll.prototype.step = function () { return this.division ? 60 / this.bpm / this.division : 0.05; };

  Roll.prototype.xOf = function (t) { return KEYW + (t - this.scrollX) * this.pxPerSec; };
  Roll.prototype.tOf = function (x) { return (x - KEYW) / this.pxPerSec + this.scrollX; };
  Roll.prototype.yOf = function (m) { var r = this.range(); return (r.hi - m) * this.rowH(); };
  Roll.prototype.mOf = function (y) { var r = this.range(); return r.hi - Math.floor(y / this.rowH()); };
  Roll.prototype.rowH = function () { var r = this.range(); return this.cv.clientHeight / (r.hi - r.lo + 1); };

  Roll.prototype.draw = function () {
    var cv = this.cv, dpr = global.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    var g = cv.getContext('2d'), r = this.range(), rh = this.rowH(), self = this;
    var css = getComputedStyle(document.documentElement);
    function v(n, d) { return (css.getPropertyValue(n) || '').trim() || d; }
    var paper = v('--paper', '#fbf6ed'), paper2 = v('--paper-2', '#f5ede0'), rule = v('--rule', '#d8cbb2'),
      ink = v('--ink', '#1a1814'), muted = v('--muted', '#6b6152'), amber = v('--amber', '#c2410c'), mono = v('--mono', 'monospace');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = paper; g.fillRect(0, 0, w, h);
    // Rows: black-key rows shaded.
    for (var m = r.lo; m <= r.hi; m++) {
      var y = this.yOf(m);
      if (BLACK.indexOf(((m % 12) + 12) % 12) >= 0) { g.fillStyle = paper2; g.fillRect(KEYW, y, w - KEYW, rh); }
      if (((m % 12) + 12) % 12 === 0) { g.fillStyle = rule; g.fillRect(KEYW, y + rh - 1, w - KEYW, 1); }
    }
    // Grid: bar lines strong, beats lighter, divisions faint.
    var beat = 60 / this.bpm, t0 = this.tOf(KEYW), t1 = this.tOf(w);
    var sub = this.division ? beat / this.division : beat;
    for (var k = Math.floor(t0 / sub); k * sub <= t1; k++) {
      var x = Math.round(this.xOf(k * sub)) + 0.5, isBeat = this.division ? k % this.division === 0 : true;
      var isBar = isBeat && Math.round(k * sub / beat) % 4 === 0;
      if (sub * this.pxPerSec < 4 && !isBeat) continue;
      g.fillStyle = isBar ? 'rgba(122,112,95,0.45)' : isBeat ? 'rgba(122,112,95,0.22)' : 'rgba(122,112,95,0.08)';
      g.fillRect(x, 0, 1, h);
    }
    // Notes.
    this.list.forEach(function (n, i) {
      var x0 = self.xOf(n.start), x1 = self.xOf(n.start + n.duration), yy = self.yOf(n.midi);
      if (x1 < KEYW || x0 > w) return;
      g.fillStyle = i === self.sel ? ink : amber;
      g.fillRect(Math.max(KEYW, x0) + 0.5, yy + 1, Math.max(3, x1 - Math.max(KEYW, x0) - 1), rh - 2);
      if (x1 - x0 > 28 && rh >= 10) {
        g.fillStyle = paper; g.font = '600 ' + Math.min(10, rh - 3) + 'px ' + mono; g.textBaseline = 'middle';
        g.fillText(NAMES[((n.midi % 12) + 12) % 12] + (Math.floor(n.midi / 12) - 1), Math.max(KEYW, x0) + 3, yy + rh / 2 + 0.5);
      }
    });
    // Playhead.
    if (this.playhead != null) {
      var px = this.xOf(this.playhead);
      if (px >= KEYW && px <= w) { g.fillStyle = ink; g.fillRect(Math.round(px), 0, 1.5, h); }
    }
    // Keyboard on the left, drawn last so notes scroll under it.
    for (m = r.lo; m <= r.hi; m++) {
      var yk = this.yOf(m), black = BLACK.indexOf(((m % 12) + 12) % 12) >= 0;
      g.fillStyle = black ? '#3a342b' : '#fffaf1';
      g.fillRect(0, yk, KEYW, rh);
      g.fillStyle = rule; g.fillRect(0, yk + rh - 0.5, KEYW, 0.5);
      if (((m % 12) + 12) % 12 === 0 && rh >= 8) {
        g.fillStyle = muted; g.font = Math.min(10, rh) + 'px ' + mono; g.textBaseline = 'middle';
        g.fillText('C' + (Math.floor(m / 12) - 1), 4, yk + rh / 2);
      }
    }
    g.fillStyle = rule; g.fillRect(KEYW - 1, 0, 1, h);
  };

  Roll.prototype.hit = function (x, y) {
    var t = this.tOf(x), m = this.mOf(y);
    for (var i = this.list.length - 1; i >= 0; i--) {
      var n = this.list[i];
      if (n.midi === m && t >= n.start && t <= n.start + n.duration) {
        var edge = this.xOf(n.start + n.duration) - x < EDGE;
        return { i: i, edge: edge };
      }
    }
    return null;
  };

  Roll.prototype.push = function () {
    this.undoStack.push(JSON.stringify(this.list));
    if (this.undoStack.length > 100) this.undoStack.shift();
  };
  Roll.prototype.undo = function () {
    if (!this.undoStack.length) return;
    this.list = JSON.parse(this.undoStack.pop());
    this.sel = -1;
    this.changed();
  };
  Roll.prototype.changed = function () { this.draw(); if (this.opts.onChange) this.opts.onChange(this.notes()); };

  Roll.prototype.remove = function (i) {
    if (i < 0 || i >= this.list.length) return;
    this.push();
    this.list.splice(i, 1);
    this.sel = -1;
    this.changed();
  };

  // Snap every start and length to the grid.
  Roll.prototype.quantize = function () {
    if (!this.division || !this.list.length) return;
    this.push();
    var st = this.step(), self = this;
    this.list.forEach(function (n) {
      var end = self.snap(n.start + n.duration);
      n.start = self.snap(n.start);
      n.duration = Math.max(st, end - n.start);
    });
    this.changed();
  };

  Roll.prototype.bind = function () {
    var self = this, cv = this.cv, lastTap = 0;
    function pos(e) { var r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    cv.addEventListener('pointerdown', function (e) {
      var p = pos(e);
      if (p.x < KEYW) { if (self.opts.onKey) self.opts.onKey(self.mOf(p.y)); return; }
      var h = self.hit(p.x, p.y), now = Date.now(), dbl = now - lastTap < 350;
      lastTap = now;
      if (dbl) {
        // Double: delete a note, or add one where there is none.
        if (h) { self.remove(h.i); return; }
        self.push();
        var start = self.snap(self.tOf(p.x) - self.step() / 2);
        self.list.push({ midi: self.mOf(p.y), start: Math.max(0, start), duration: 60 / self.bpm, velocity: 96 });   // one beat
        self.sel = self.list.length - 1;
        self.changed();
        return;
      }
      self.sel = h ? h.i : -1;
      if (h) {
        var n = self.list[h.i];
        self.drag = { i: h.i, edge: h.edge, x0: p.x, y0: p.y, start: n.start, midi: n.midi, dur: n.duration, moved: false };
        cv.setPointerCapture(e.pointerId);
        if (self.opts.onKey && !h.edge) self.opts.onKey(n.midi, n.duration);
      } else {
        self.drag = { pan: true, x0: p.x, scroll: self.scrollX };
        cv.setPointerCapture(e.pointerId);
      }
      self.draw();
    });
    cv.addEventListener('pointermove', function (e) {
      var d = self.drag;
      if (!d) { var p0 = pos(e), hh = self.hit(p0.x, p0.y); cv.style.cursor = hh ? (hh.edge ? 'ew-resize' : 'grab') : 'crosshair'; return; }
      var p = pos(e), dx = (p.x - d.x0) / self.pxPerSec;
      if (d.pan) { self.scrollX = Math.max(0, d.scroll - dx); self.draw(); return; }
      if (!d.moved && Math.abs(p.x - d.x0) < 3 && Math.abs(p.y - d.y0) < 3) return;
      if (!d.moved) { self.push(); d.moved = true; }
      var n = self.list[d.i];
      if (d.edge) n.duration = Math.max(self.step(), self.snap(d.start + d.dur + dx) - d.start);
      else {
        n.start = Math.max(0, self.snap(d.start + dx));
        var m = d.midi + Math.round((d.y0 - p.y) / self.rowH());
        if (m !== n.midi) { n.midi = m; if (self.opts.onKey) self.opts.onKey(m, 0.15); }
      }
      self.draw();
    });
    function up() { if (self.drag && self.drag.moved) self.changed(); self.drag = null; }
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('wheel', function (e) {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        var p = pos(e), t = self.tOf(p.x);
        self.pxPerSec = Math.max(10, Math.min(1200, self.pxPerSec * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
        self.scrollX = Math.max(0, t - (p.x - KEYW) / self.pxPerSec);
        self.draw();
      } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        self.scrollX = Math.max(0, self.scrollX + e.deltaX / self.pxPerSec);
        self.draw();
      }
    }, { passive: false });
    cv.tabIndex = 0;
    cv.addEventListener('keydown', function (e) {
      if ((e.key === 'Delete' || e.key === 'Backspace') && self.sel >= 0) { e.preventDefault(); self.remove(self.sel); }
      else if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); self.undo(); }
      else if (self.sel >= 0 && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault(); self.push();
        self.list[self.sel].midi += (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1);
        if (self.opts.onKey) self.opts.onKey(self.list[self.sel].midi, 0.2);
        self.changed();
      }
    });
    var lastW = 0;
    global.addEventListener('resize', function () {
      // A new width (a phone turned sideways) refits the whole take.
      var w = cv.clientWidth;
      if (w && w !== lastW && self.list.length) { lastW = w; self.fit(); }
      self.draw();
    });
  };

  global.ASPianoRoll = Roll;
})(window);
