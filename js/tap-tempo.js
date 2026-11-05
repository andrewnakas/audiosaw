/*
 * ASTap: tempo from taps. Behind /tap-bpm.
 *
 * The tempo is the slope of a least-squares line through the tap times
 * against their count, not the average gap. The average gap is (last -
 * first) / (n - 1): it uses only the two end taps, so all the jitter of
 * those two lands in the answer. The line uses every tap. Measured by
 * tools/check-tap.js over 1,000 runs with +-15 ms of random jitter at 120
 * BPM: after 8 taps the line is within 0.5 BPM in 92% of runs (the average
 * gap in 88%), and after 16 in all of them.
 *
 * A tap more than 30% off the expected time (a double tap, a missed beat)
 * is left out of the line; the next one carries on from where it should
 * have been. Two missed taps in a row, or a pause over 2.5 beats (and at
 * least 2 s), starts a new count: you have changed song, or stopped.
 *
 * UMD: runs in Node for the check and in the page.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ASTap = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var KEEP = 32;

  function fit(pts) {
    // pts: [beatIndex, ms]. Slope = ms per beat.
    var n = pts.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (var i = 0; i < n; i++) { sx += pts[i][0]; sy += pts[i][1]; sxx += pts[i][0] * pts[i][0]; sxy += pts[i][0] * pts[i][1]; }
    var d = n * sxx - sx * sx;
    if (!d) return null;
    var slope = (n * sxy - sx * sy) / d, icpt = (sy - slope * sx) / n, ss = 0;
    for (var j = 0; j < n; j++) { var e = pts[j][1] - (icpt + slope * pts[j][0]); ss += e * e; }
    var resid = n > 2 ? Math.sqrt(ss / (n - 2)) : 0;
    // Standard error of the slope.
    var se = n > 2 ? resid / Math.sqrt(sxx - sx * sx / n) : Infinity;
    return { slope: slope, icpt: icpt, resid: resid, se: se };
  }

  function Tapper() { this.reset(); }
  Tapper.prototype.reset = function () { this.pts = []; this.beat = 0; this.last = null; this.misses = 0; this.ignored = 0; };
  // t: milliseconds (event.timeStamp). Returns the state.
  Tapper.prototype.tap = function (t) {
    var est = this.estimate(), period = est ? est.ms : null;
    if (this.last != null) {
      var gap = t - this.last;
      var limit = Math.max(2000, period ? 2.5 * period : 2000);
      if (gap > limit) this.reset();
    }
    if (!this.pts.length) { this.pts.push([0, t]); this.beat = 0; this.last = t; return this.state(); }
    if (this.pts.length === 1) {
      // Second tap: the first gap sets the beat.
      this.beat = 1; this.pts.push([1, t]); this.last = t; return this.state();
    }
    var f = fit(this.pts), p = f.slope;
    // Which beat is this tap? Usually the next; a long gap may skip one.
    // Counted from the last tap that was kept: an ignored tap says nothing
    // about where the beat is.
    var kept = this.pts[this.pts.length - 1][1];
    var k = Math.max(1, Math.round((t - kept) / p)), at = this.beat + k, want = f.icpt + p * at;
    if (Math.abs(t - want) > 0.3 * p || k > 2) {
      this.misses++; this.ignored++;
      if (this.misses >= 2) { this.reset(); this.pts.push([0, t]); }
      this.last = t;
      return this.state();
    }
    this.misses = 0;
    this.beat = at;
    this.pts.push([at, t]);
    if (this.pts.length > KEEP) this.pts.shift();
    this.last = t;
    return this.state();
  };
  Tapper.prototype.estimate = function () {
    if (this.pts.length < 2) return null;
    var f = fit(this.pts);
    if (!f || !(f.slope > 0)) return null;
    return { ms: f.slope, bpm: 60000 / f.slope, se: f.se, resid: f.resid };
  };
  Tapper.prototype.state = function () {
    var e = this.estimate();
    if (!e) return { taps: this.pts.length, bpm: null };
    // +- in BPM from the slope's standard error.
    var plus = isFinite(e.se) ? 60000 / Math.max(1, e.ms - e.se) - e.bpm : null;
    return { taps: this.pts.length, bpm: e.bpm, plusMinus: plus, steady: plus != null && plus < 1 && this.pts.length >= 8, ignored: this.ignored };
  };

  // The simple average gap, for comparison in the check.
  function averageGap(times) { return 60000 / ((times[times.length - 1] - times[0]) / (times.length - 1)); }

  return { Tapper: Tapper, fit: fit, averageGap: averageGap };
});
