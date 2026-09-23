/*
 * The audio editor's timeline drawing: ruler, lanes, clips, waveforms, fades,
 * selection, markers and playhead, on two canvases (the ruler stays put while
 * the lanes scroll vertically underneath it).
 *
 * Waveforms are drawn from a min/max peak pyramid built once per source: level
 * 0 holds one min/max pair per 256 samples and each level above merges four of
 * the one below. At any zoom the renderer picks the coarsest level that still
 * has at least one pair per pixel, so drawing an hour-long file costs about the
 * same as drawing a ten-second one. Zoomed in past 256 samples a pixel, it
 * reads the samples themselves.
 *
 * Nothing here knows about pointer events. hitTest() turns a position into
 * "the fade handle of clip X" and editor-ui.js decides what that means.
 */
(function (global) {
  'use strict';

  var M = global.ASEditModel;

  var BASE = 256, FAN = 4, LEVELS = 6;
  var peaks = new Map();   // sourceId -> { levels: [Float32Array(min,max,...)], sr, len }

  function buildPeaks(sourceId, buffer) {
    var nch = buffer.numberOfChannels, len = buffer.length;
    var chans = [];
    for (var c = 0; c < nch; c++) chans.push(buffer.getChannelData(c));
    var n0 = Math.ceil(len / BASE);
    var l0 = new Float32Array(n0 * 2);
    for (var b = 0; b < n0; b++) {
      var mn = 0, mx = 0, s = b * BASE, e = Math.min(len, s + BASE);
      for (var ch = 0; ch < nch; ch++) {
        var d = chans[ch];
        for (var i = s; i < e; i++) { var v = d[i]; if (v < mn) mn = v; else if (v > mx) mx = v; }
      }
      l0[b * 2] = mn; l0[b * 2 + 1] = mx;
    }
    var levels = [l0];
    for (var L = 1; L < LEVELS; L++) {
      var prev = levels[L - 1], pn = prev.length / 2, nn = Math.ceil(pn / FAN);
      var cur = new Float32Array(nn * 2);
      for (var k = 0; k < nn; k++) {
        var a = 0, z = 0;
        for (var j = k * FAN; j < Math.min(pn, k * FAN + FAN); j++) {
          if (prev[j * 2] < a) a = prev[j * 2];
          if (prev[j * 2 + 1] > z) z = prev[j * 2 + 1];
        }
        cur[k * 2] = a; cur[k * 2 + 1] = z;
      }
      levels.push(cur);
    }
    var entry = { levels: levels, sr: buffer.sampleRate, len: len, buffer: buffer };
    peaks.set(sourceId, entry);
    return entry;
  }

  /* --------------------------------------------------------------- layout */

  function View(opts) {
    this.ruler = opts.ruler;
    this.lanes = opts.lanes;
    this.state = opts.state;          // shared with the UI; read-only here
    this.rulerH = 30;
    this.touch = false;
    this.dirty = true;
  }

  View.prototype.x = function (t) { return (t - this.state.scrollT) * this.state.pps; };
  View.prototype.t = function (x) { return x / this.state.pps + this.state.scrollT; };
  View.prototype.trackH = function () { return this.state.trackH; };
  View.prototype.width = function () { return this.lanes.clientWidth; };

  View.prototype.resize = function () {
    var dpr = global.devicePixelRatio || 1;
    var w = this.lanes.clientWidth;
    var rows = this.state.project.tracks.length + 1;   // +1: the empty "new track" lane
    var h = rows * this.state.trackH;
    this.lanes.style.height = h + 'px';
    [[this.ruler, w, this.rulerH], [this.lanes, w, h]].forEach(function (a) {
      var cv = a[0];
      if (cv.width !== Math.round(a[1] * dpr) || cv.height !== Math.round(a[2] * dpr)) {
        cv.width = Math.round(a[1] * dpr);
        cv.height = Math.round(a[2] * dpr);
      }
    });
    this.dpr = dpr;
    this.dirty = true;
  };

  /* ---------------------------------------------------------------- ruler */

  // A tick spacing that leaves at least ~80 px between labels.
  var STEPS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
  function pickStep(pps) {
    for (var i = 0; i < STEPS.length; i++) if (STEPS[i] * pps >= 80) return STEPS[i];
    return 3600;
  }

  // The same idea in beats, for the bars ruler: a labelled step (a
  // sixteenth up to many bars) at least ~60 px apart, and the finer division
  // drawn between labels and used for snapping. The finer division is the
  // largest musical unit below the label step, so four-bar labels get bar
  // lines and one-bar labels get beat lines.
  function barSteps(pps, p) {
    var num = p.sig[0], beatPx = M.beatSec(p) * pps;
    var C = [0.25, 0.5, 1, num, 2 * num, 4 * num, 8 * num, 16 * num, 32 * num, 64 * num, 128 * num];
    var label = C[C.length - 1];
    for (var i = 0; i < C.length; i++) if (C[i] * beatPx >= 60) { label = C[i]; break; }
    var minor = label;
    [0.25, 0.5, 1, num].forEach(function (d) {
      var k = label / d;
      if (d < label && d * beatPx >= 10 && Math.abs(k - Math.round(k)) < 1e-9) minor = d;
    });
    return { label: label, minor: minor };
  }
  function onStep(p, t, div) {
    var k = (t - p.gridOffset) / M.beatSec(p) / div;
    return Math.abs(k - Math.round(k)) < 1e-6;
  }

  function fmtRuler(t, step) {
    var m = Math.floor(t / 60), s = t - m * 60;
    var dec = step < 0.01 ? 3 : step < 0.1 ? 2 : step < 1 ? 1 : 0;
    var ss = s.toFixed(dec);
    if (s < 10) ss = '0' + ss;
    return m + ':' + ss;
  }

  View.prototype.drawRuler = function (css) {
    var cv = this.ruler, g = cv.getContext('2d'), dpr = this.dpr;
    var w = cv.width / dpr, h = this.rulerH, st = this.state;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = css.paper2; g.fillRect(0, 0, w, h);
    g.fillStyle = css.rule; g.fillRect(0, h - 1, w, 1);

    var step = pickStep(st.pps);
    var t0 = Math.floor(st.scrollT / step) * step;
    var tEnd = this.t(w);
    g.font = '11px ' + css.mono;
    g.textBaseline = 'top';
    if (st.project.ruler === 'bars') {
      var p = st.project, bs = barSteps(st.pps, p);
      M.gridLines(p, Math.max(0, st.scrollT - 1), tEnd, bs.minor).forEach(function (l) {
        if (l.t < 0) return;
        var x = Math.round(this.x(l.t)) + 0.5;
        g.fillStyle = css.muted;
        if (onStep(p, l.t, bs.label)) {
          g.fillRect(x, h - 10, 1, 9);
          g.fillText(M.fmtBars(p, l.t, bs.label), x + 3, 4);
        } else {
          g.fillRect(x, h - (l.level === 2 ? 8 : 5), 1, l.level === 2 ? 7 : 4);
        }
      }, this);
      t0 = tEnd + 1;   // skip the seconds ticks
    }
    for (var t = t0; t <= tEnd; t += step) {
      var x = Math.round(this.x(t)) + 0.5;
      g.fillStyle = css.muted;
      g.fillRect(x, h - 10, 1, 9);
      g.fillText(fmtRuler(Math.max(0, t), step), x + 3, 4);
      for (var k = 1; k < 5; k++) {
        var xs = Math.round(this.x(t + step * k / 5)) + 0.5;
        g.fillRect(xs, h - 5, 1, 4);
      }
    }

    // Range selection band.
    if (st.range) {
      var a = this.x(Math.min(st.range.t0, st.range.t1)), b = this.x(Math.max(st.range.t0, st.range.t1));
      g.fillStyle = css.rangeFill; g.fillRect(a, 0, b - a, h);
      g.fillStyle = css.amber; g.fillRect(a, 0, 2, h); g.fillRect(b - 2, 0, 2, h);
    }
    if (st.loop && st.range) {
      g.fillStyle = css.amber;
      g.font = '600 10px ' + css.mono;
      g.fillText('LOOP', this.x(Math.min(st.range.t0, st.range.t1)) + 5, h - 13);
    }

    // Markers as small flags.
    st.project.markers.forEach(function (m) {
      var x = this.x(m.t);
      if (x < -60 || x > w + 2) return;
      g.fillStyle = css.marker;
      g.beginPath(); g.moveTo(x, h); g.lineTo(x, 8); g.lineTo(x + 9, 12); g.lineTo(x, 16); g.fill();
      g.fillRect(x, 8, 1.5, h - 8);
    }, this);

    this.drawPlayhead(g, h, css, true);
  };

  View.prototype.drawPlayhead = function (g, h, css, head) {
    var x = Math.round(this.x(this.state.playhead)) + 0.5;
    if (x < -10 || x > g.canvas.width / this.dpr + 10) return;
    g.fillStyle = css.playhead;
    g.fillRect(x - 0.75, 0, 1.5, h);
    if (head) {
      g.beginPath(); g.moveTo(x - 6, 0); g.lineTo(x + 6, 0); g.lineTo(x, 8); g.fill();
    }
  };

  /* ---------------------------------------------------------------- lanes */

  View.prototype.drawLanes = function (css) {
    var cv = this.lanes, g = cv.getContext('2d'), dpr = this.dpr, st = this.state;
    var w = cv.width / dpr, h = cv.height / dpr, th = st.trackH;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = css.paper; g.fillRect(0, 0, w, h);

    // Only draw lanes that are on screen; the canvas can be much taller than
    // the viewport when there are many tracks.
    var vTop = st.viewTop || 0, vBot = vTop + (st.viewH || h);

    var audible = M.audibleTracks(st.project);
    var step = pickStep(st.pps);
    var t0 = Math.floor(st.scrollT / step) * step, tEnd = this.t(w);
    // In bars mode the lane grid is the musical one: bar lines stronger than
    // the beats between them, the way a DAW draws it.
    var bars = st.project.ruler === 'bars'
      ? M.gridLines(st.project, Math.max(0, st.scrollT - 1), tEnd, barSteps(st.pps, st.project).minor).filter(function (l) { return l.t >= 0; })
      : null;

    st.project.tracks.forEach(function (track, ti) {
      var y = ti * th;
      if (y + th < vTop || y > vBot) return;
      g.fillStyle = ti % 2 ? css.laneAlt : css.lane;
      if (st.selTrack === track.id) g.fillStyle = css.laneSel;
      g.fillRect(0, y, w, th);
      // Faint grid.
      g.fillStyle = css.grid;
      if (bars) {
        bars.forEach(function (l) {
          g.fillStyle = l.level === 2 ? css.gridBar : css.grid;
          g.fillRect(Math.round(this.x(l.t)), y, 1, th);
        }, this);
      } else {
        for (var t = t0; t <= tEnd; t += step) g.fillRect(Math.round(this.x(t)), y, 1, th);
      }
      g.fillStyle = css.rule; g.fillRect(0, y + th - 1, w, 1);

      var dim = !audible[track.id];
      track.clips.forEach(function (c) {
        if (st.drag && st.drag.kind === 'move' && st.drag.ids[c.id]) return;   // drawn as ghost below
        this.drawClip(g, c, y, th, css, st.sel[c.id], dim);
      }, this);

      if (st.rec && st.rec.trackId === track.id) this.drawRecording(g, y, th, css);
      // An automation lane, when the track is showing one. The UI owns the
      // lane's scale and drawing; the view only says where the track is.
      if (st.autoDraw && st.autoLanes && st.autoLanes[track.id]) st.autoDraw(g, track, ti, y, th, w, css);
    }, this);

    // The spare lane at the bottom, where dropping creates a new track.
    var ny = st.project.tracks.length * th;
    g.fillStyle = css.paper; g.fillRect(0, ny, w, th);
    g.strokeStyle = css.rule; g.setLineDash([5, 5]);
    g.strokeRect(8.5, ny + 8.5, w - 17, th - 17);
    g.setLineDash([]);
    g.fillStyle = css.muted; g.font = '13px ' + css.sans; g.textBaseline = 'middle';
    g.fillText(st.project.tracks.length ? 'Drop audio or drag a clip here for a new track' : '', 20, ny + th / 2);

    // Clips being dragged, drawn at their destination.
    if (st.drag && st.drag.kind === 'move') {
      g.globalAlpha = 0.85;
      Object.keys(st.drag.ids).forEach(function (id) {
        var f = M.findClip(st.project, id);
        if (!f) return;
        var ti = f.ti + st.drag.dTrack;
        var ghost = Object.assign({}, f.clip, { start: Math.max(0, f.clip.start + st.drag.dt) });
        this.drawClip(g, ghost, ti * th, th, css, true, false);
      }, this);
      g.globalAlpha = 1;
    }

    // Range selection across lanes.
    if (st.range) {
      var a = this.x(Math.min(st.range.t0, st.range.t1)), b = this.x(Math.max(st.range.t0, st.range.t1));
      g.fillStyle = css.rangeFill;
      if (st.range.tracks) {
        st.project.tracks.forEach(function (t, ti) {
          if (st.range.tracks.indexOf(t.id) !== -1) g.fillRect(a, ti * th, b - a, th - 1);
        });
      } else {
        g.fillRect(a, 0, b - a, st.project.tracks.length * th);
      }
      g.fillStyle = css.amber;
      g.fillRect(a, 0, 1, ny); g.fillRect(b - 1, 0, 1, ny);
    }

    // Markers run down through the lanes as hairlines.
    g.fillStyle = css.marker;
    st.project.markers.forEach(function (m) { g.fillRect(Math.round(this.x(m.t)), 0, 1, ny); }, this);

    // Snap indicator.
    if (st.snapAt != null) {
      g.fillStyle = css.snap;
      g.fillRect(Math.round(this.x(st.snapAt)) - 0.5, 0, 2, ny);
    }

    this.drawPlayhead(g, h, css, false);
  };

  View.prototype.drawClip = function (g, c, y, th, css, selected, dim) {
    var x0 = this.x(c.start), x1 = this.x(M.clipEnd(c));
    var w = this.width();
    if (x1 < -2 || x0 > w + 2) return;
    var pad = 3, top = y + pad, hh = th - pad * 2;
    var cx0 = Math.max(x0, -4), cx1 = Math.min(x1, w + 4);

    g.fillStyle = dim ? css.clipDim : (selected ? css.clipSel : css.clip);
    roundRect(g, x0, top, x1 - x0, hh, 4); g.fill();

    // Waveform, clipped to the clip body.
    g.save();
    roundRect(g, x0, top, x1 - x0, hh, 4); g.clip();
    var labelH = hh > 44 ? 16 : 0;
    this.drawWave(g, c, cx0, cx1, top + labelH, hh - labelH, dim ? css.waveDim : (selected ? css.waveSel : css.wave));

    // Fade shading: the region under the gain curve stays clear, above it is shaded.
    var st = this;
    [['in', c.fadeIn], ['out', c.fadeOut]].forEach(function (f) {
      if (!f[1]) return;
      var a = f[0] === 'in' ? c.start : M.clipEnd(c) - f[1];
      var b = a + f[1];
      var xa = st.x(a), xb = st.x(b);
      g.fillStyle = css.fadeShade;
      g.beginPath();
      g.moveTo(xa, top);
      var n = Math.max(8, Math.min(80, Math.round(xb - xa)));
      for (var i = 0; i <= n; i++) {
        var t = a + (b - a) * i / n;
        var gain = M.clipGainAt(Object.assign({}, c, { gainDb: 0 }), t - c.start);
        g.lineTo(st.x(t), top + hh - gain * hh);
      }
      g.lineTo(xb, top);
      g.closePath(); g.fill();
      g.strokeStyle = css.fadeLine; g.lineWidth = 1.25;
      g.beginPath();
      for (var j = 0; j <= n; j++) {
        var t2 = a + (b - a) * j / n;
        var g2 = M.clipGainAt(Object.assign({}, c, { gainDb: 0 }), t2 - c.start);
        var yy = top + hh - g2 * hh;
        if (j) g.lineTo(st.x(t2), yy); else g.moveTo(st.x(t2), yy);
      }
      g.stroke();
    });

    // The chord lane: chords detected on this clip's source, as a strip along
    // the bottom. Stored in source time, so a trimmed or moved clip still
    // shows the chords of the audio it plays.
    var src = st.state.project.sources[c.sourceId];
    if (src && src.chords && src.chords.length && hh > 30) {
      var sh = 15, sy = top + hh - sh;
      g.fillStyle = css.chordStrip; g.fillRect(cx0, sy, cx1 - cx0, sh);
      g.font = '600 10px ' + css.mono; g.textBaseline = 'middle';
      src.chords.forEach(function (ch) {
        var a0 = Math.max(ch.t0, c.offset), b0 = Math.min(ch.t1, c.offset + c.duration);
        if (b0 <= a0) return;
        var xa = st.x(c.start + a0 - c.offset), xb = st.x(c.start + b0 - c.offset);
        if (xb < 0 || xa > w) return;
        g.fillStyle = css.clipEdge; g.fillRect(Math.round(xa), sy + 2, 1, sh - 4);
        if (ch.name === 'N') return;
        var tw = g.measureText(ch.name).width;
        if (xb - xa < tw + 6) return;
        g.fillStyle = selected ? css.labelSel : css.label;
        g.fillText(ch.name, Math.max(xa, 0) + 4, sy + sh / 2 + 0.5);
      });
    }

    // Name and gain label.
    if (labelH && x1 - x0 > 30) {
      g.fillStyle = selected ? css.labelSel : css.label;
      g.font = '600 11px ' + css.sans; g.textBaseline = 'top';
      var label = c.name + (c.gainDb ? '  ' + (c.gainDb > 0 ? '+' : '') + c.gainDb.toFixed(1) + ' dB' : '');
      g.fillText(label, Math.max(x0, 0) + 6, top + 3, Math.max(10, x1 - Math.max(x0, 0) - 12));
    }
    g.restore();

    g.lineWidth = selected ? 2 : 1;
    g.strokeStyle = selected ? css.amber : css.clipEdge;
    roundRect(g, x0 + 0.5, top + 0.5, x1 - x0 - 1, hh - 1, 4); g.stroke();

    // Handles for the selected clip: fade dots at the top corners, grips on the edges.
    if (selected && x1 - x0 > 16) {
      var r = this.touch ? 7 : 5;
      var fx0 = this.x(c.start + (c.fadeIn || 0)), fx1 = this.x(M.clipEnd(c) - (c.fadeOut || 0));
      g.fillStyle = css.paper; g.strokeStyle = css.amber; g.lineWidth = 2;
      [fx0, fx1].forEach(function (fx) {
        g.beginPath(); g.arc(fx, top + r + 1, r, 0, Math.PI * 2); g.fill(); g.stroke();
      });
      g.fillStyle = css.amber;
      var gh = Math.min(28, hh * 0.4), gy = top + hh / 2 - gh / 2;
      roundRect(g, x0 + 2, gy, 4, gh, 2); g.fill();
      roundRect(g, x1 - 6, gy, 4, gh, 2); g.fill();
    }
  };

  View.prototype.drawWave = function (g, c, px0, px1, top, h, color) {
    var pk = peaks.get(c.sourceId);
    if (!pk || h < 6) return;
    var sr = pk.sr, pps = this.state.pps;
    var spp = sr / pps;               // samples per pixel
    var mid = top + h / 2, amp = (h / 2) * 0.92 * Math.min(4, M.dbToGain(c.gainDb || 0));
    g.fillStyle = color;
    var startPx = Math.floor(Math.max(px0, this.x(c.start)));
    var endPx = Math.ceil(Math.min(px1, this.x(M.clipEnd(c))));

    if (spp < BASE) {
      // Close zoom: straight from the samples.
      var d = pk.buffer.getChannelData(0);
      if (spp < 1.5) {
        g.strokeStyle = color; g.lineWidth = 1.25; g.beginPath();
        var sA = Math.max(0, Math.floor((this.t(startPx) - c.start + c.offset) * sr) - 1);
        var sB = Math.min(pk.len - 1, Math.ceil((this.t(endPx) - c.start + c.offset) * sr) + 1);
        for (var s = sA; s <= sB; s++) {
          var xx = this.x(c.start + s / sr - c.offset), yy = mid - d[s] * amp;
          if (s === sA) g.moveTo(xx, yy); else g.lineTo(xx, yy);
        }
        g.stroke();
        return;
      }
      for (var px = startPx; px < endPx; px++) {
        var a = Math.floor((this.t(px) - c.start + c.offset) * sr);
        var b = Math.floor((this.t(px + 1) - c.start + c.offset) * sr);
        a = Math.max(0, a); b = Math.min(pk.len, Math.max(b, a + 1));
        var mn = 0, mx = 0;
        for (var i = a; i < b; i++) { var v = d[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
        var fg2 = fadeAt(c, this.t(px + 0.5) - c.start);
        g.fillRect(px, mid - mx * amp * fg2, 1, Math.max(1, (mx - mn) * amp * fg2));
      }
      return;
    }

    var L = 0, block = BASE;
    while (L < LEVELS - 1 && block * FAN <= spp) { L++; block *= FAN; }
    var lv = pk.levels[L], nb = lv.length / 2;
    for (var p = startPx; p < endPx; p++) {
      var s0 = (this.t(p) - c.start + c.offset) * sr / block;
      var s1 = (this.t(p + 1) - c.start + c.offset) * sr / block;
      var i0 = Math.max(0, Math.floor(s0)), i1 = Math.min(nb, Math.max(Math.ceil(s1), i0 + 1));
      var lo = 0, hi = 0;
      for (var k = i0; k < i1; k++) { if (lv[k * 2] < lo) lo = lv[k * 2]; if (lv[k * 2 + 1] > hi) hi = lv[k * 2 + 1]; }
      var fg = fadeAt(c, this.t(p + 0.5) - c.start);
      g.fillRect(p, mid - Math.min(1, hi) * amp * fg, 1, Math.max(1, (Math.min(1, hi) - Math.max(-1, lo)) * amp * fg));
    }
  };

  // The fade part of a clip's gain, so the waveform shrinks under a fade the
  // way the sound does.
  function fadeAt(c, tl) {
    if (!c.fadeIn && !c.fadeOut) return 1;
    return M.clipGainAt({ gainDb: 0, duration: c.duration, fadeIn: c.fadeIn, fadeOut: c.fadeOut }, tl);
  }

  View.prototype.drawRecording = function (g, y, th, css) {
    var r = this.state.rec;
    var x0 = this.x(r.start), x1 = this.x(r.start + r.length);
    var top = y + 3, hh = th - 6;
    g.fillStyle = css.recFill;
    roundRect(g, x0, top, Math.max(2, x1 - x0), hh, 4); g.fill();
    g.fillStyle = css.rec;
    var mid = top + hh / 2, per = r.peakHop / r.sr;
    for (var i = 0; i < r.peaks.length; i++) {
      var x = this.x(r.start + i * per);
      if (x < -1 || x > this.width() + 1) continue;
      var v = Math.min(1, r.peaks[i]);
      g.fillRect(x, mid - v * hh / 2, Math.max(1, per * this.state.pps), Math.max(1, v * hh));
    }
    g.font = '600 11px ' + css.sans; g.textBaseline = 'top';
    g.fillText('● recording', Math.max(0, x0) + 6, top + 3);
  };

  function roundRect(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    if (r < 0) r = 0;
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  View.prototype.draw = function () {
    var css = this.css || (this.css = readColors());
    this.drawRuler(css);
    this.drawLanes(css);
    this.dirty = false;
  };

  function readColors() {
    var s = getComputedStyle(document.documentElement);
    function v(n, d) { return (s.getPropertyValue(n) || '').trim() || d; }
    return {
      paper: v('--paper', '#fbf6ed'), paper2: v('--paper-2', '#f5ede0'),
      rule: v('--rule', '#d8cbb2'), muted: v('--muted', '#6b6152'),
      amber: v('--amber', '#c2410c'), ink: v('--ink', '#1a1814'),
      mono: v('--mono', 'monospace'), sans: v('--sans', 'sans-serif'),
      lane: '#fbf6ed', laneAlt: '#f7f0e4', laneSel: '#fcefdc',
      grid: 'rgba(122,112,95,0.10)', gridBar: 'rgba(122,112,95,0.30)', chordStrip: 'rgba(251,246,237,0.82)',
      clip: '#f1e2c8', clipSel: '#fde8ce', clipDim: '#ece6dc', clipEdge: 'rgba(122,112,95,0.55)',
      wave: '#6b5a3f', waveSel: '#9a3412', waveDim: '#b8ad9b',
      label: '#4a4338', labelSel: '#7c2d12',
      fadeShade: 'rgba(26,24,20,0.13)', fadeLine: '#c2410c',
      rangeFill: 'rgba(194,65,12,0.13)',
      playhead: '#1a1814', marker: '#2f6f4f', snap: 'rgba(47,111,79,0.8)',
      rec: '#b91c1c', recFill: 'rgba(185,28,28,0.12)'
    };
  }

  /* ------------------------------------------------------------ hit test */

  // What is under (x, y) in lane-canvas CSS pixels.
  View.prototype.hitTest = function (x, y, opts) {
    opts = opts || {};
    var st = this.state, th = st.trackH;
    var ti = Math.floor(y / th);
    var t = this.t(x);
    var res = { t: t, ti: ti, track: st.project.tracks[ti] || null, type: 'empty' };
    if (!res.track) { res.type = ti >= st.project.tracks.length ? 'newlane' : 'empty'; return res; }
    var top = ti * th + 3, hh = th - 6;
    var touch = opts.touch;
    var edge = touch ? 16 : 7, dotR = touch ? 18 : 9;

    var clips = res.track.clips;
    // Selected clips get first claim on their handles, which extend a little
    // outside the clip so a thumb does not have to land exactly on the edge.
    for (var pass = 0; pass < 2; pass++) {
      for (var i = clips.length - 1; i >= 0; i--) {
        var c = clips[i], sel = !!st.sel[c.id];
        if (pass === 0 && !sel) continue;
        var x0 = this.x(c.start), x1 = this.x(M.clipEnd(c));
        var slack = sel ? edge : 0;
        if (x < x0 - slack || x > x1 + slack) continue;
        res.clip = c;
        var handles = sel || !touch;
        if (handles && x1 - x0 > 16) {
          var fx0 = this.x(c.start + (c.fadeIn || 0)), fx1 = this.x(M.clipEnd(c) - (c.fadeOut || 0));
          var dy = y - (top + 8);
          if (sel && Math.hypot(x - fx0, dy) <= dotR) { res.type = 'fadeIn'; return res; }
          if (sel && Math.hypot(x - fx1, dy) <= dotR) { res.type = 'fadeOut'; return res; }
        }
        var w = x1 - x0, e = Math.min(edge, w / 3);
        if (handles && x <= x0 + e) { res.type = 'trimStart'; return res; }
        if (handles && x >= x1 - e) { res.type = 'trimEnd'; return res; }
        if (x >= x0 && x <= x1) { res.type = 'clip'; return res; }
        delete res.clip;
      }
    }
    return res;
  };

  global.ASEditView = { View: View, buildPeaks: buildPeaks, peaks: peaks, fmtRuler: fmtRuler, gridStep: pickStep, barSteps: barSteps };
})(window);
