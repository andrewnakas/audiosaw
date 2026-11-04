#!/usr/bin/env node
/*
 * Checks js/tone-gen.js (ASTone), behind /tone-generator. Node only.
 *
 * Frequencies are measured with a Goertzel filter, not trusted from the
 * input: a steady tone must put its energy at the asked frequency, a
 * band-limited square must leave nothing between its harmonics (a naive one
 * is measured beside it, for the figure the page quotes), a log sweep must
 * pass the geometric middle at half time, and the noises must have their
 * slopes (white flat, pink -3 dB per octave, brown about -6).
 */
const T = require('../js/tone-gen.js');

let failed = 0;
const ok = (c, m) => { console.log((c ? '  ok  ' : '  FAIL ') + m); if (!c) failed++; };
const db = (x) => 20 * Math.log10(x);

// Amplitude of the component at f in x (Hann-windowed Goertzel).
function amp(x, rate, f, from, len) {
  from = from || 0; len = len || x.length - from;
  const w = 2 * Math.cos(2 * Math.PI * f / rate);
  let s1 = 0, s2 = 0, wsum = 0;
  for (let i = 0; i < len; i++) {
    const h = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (len - 1));
    const s = x[from + i] * h + w * s1 - s2; s2 = s1; s1 = s; wsum += h;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - w * s1 * s2) * 2 / wsum;
}
function peak(x) { let p = 0; for (const v of x) p = Math.max(p, Math.abs(v)); return p; }
function rms(x) { let s = 0; for (const v of x) s += v * v; return Math.sqrt(s / x.length); }
function crossings(x, a, b) { let n = 0; for (let i = a + 1; i < b; i++) if (x[i - 1] < 0 && x[i] >= 0) n++; return n; }

const R = 48000;

console.log('steady tones');
{
  const [L, Rt] = T.render({ wave: 'sine', freq: 1000, seconds: 2, rate: R, amp: 0.5 });
  ok(Math.abs(peak(L) - 0.5) < 1e-6 && Math.abs(rms(L) - 0.5 / Math.SQRT2) < 1e-4, 'sine: peak 0.5, RMS 0.3536 (' + peak(L).toFixed(6) + ', ' + rms(L).toFixed(4) + ')');
  ok(crossings(L, 0, R) === 1000 || crossings(L, 0, R) === 999, '1 kHz has 1,000 cycles a second (' + crossings(L, 0, R) + ')');
  let same = true; for (let i = 0; i < R; i++) if (L[i] !== Rt[i]) { same = false; break; }
  ok(same, 'both channels identical by default');
  const a = amp(L, R, 1000), off = amp(L, R, 1003);
  ok(db(a / 0.5) > -0.05 && db(off / a) < -100, 'energy at 1 kHz (' + db(a / 0.5).toFixed(3) + ' dB), 3 Hz off is ' + db(off / a).toFixed(0) + ' dB down');
}
{
  // Band-limited square at 5 kHz: harmonics 5, 15 kHz only (25 kHz is over
  // Nyquist). A naive square folds the 9th (45 kHz) to 3 kHz.
  const [L] = T.render({ wave: 'square', freq: 5000, seconds: 1, rate: R, amp: 0.5 });
  const f1 = amp(L, R, 5000), f3 = amp(L, R, 15000);
  const naive = new Float32Array(R); for (let i = 0; i < R; i++) naive[i] = ((i * 5000 / R) % 1) < 0.5 ? 0.5 : -0.5;
  // The naive square at exactly 5 kHz lands its aliases on harmonics, so it
  // is measured at 5,100 Hz, where the 9th folds to 2,100 Hz.
  for (let i = 0; i < R; i++) naive[i] = ((i * 5100 / R) % 1) < 0.5 ? 0.5 : -0.5;
  const nf = amp(naive, R, 5100), nAlias = amp(naive, R, 48000 - 45900);
  const [B] = T.render({ wave: 'square', freq: 5100, seconds: 1, rate: R, amp: 0.5 });
  const bAlias = amp(B, R, 48000 - 45900), bf = amp(B, R, 5100);
  ok(Math.abs(db(f3 / f1) - db(1 / 3)) < 0.2, 'square: 3rd harmonic at 1/3 (' + db(f3 / f1).toFixed(2) + ' dB, ideal ' + db(1 / 3).toFixed(2) + ')');
  ok(db(bAlias / bf) < -100, 'band-limited 5.1 kHz square: nothing at 2.1 kHz (' + db(bAlias / bf).toFixed(0) + ' dB); a naive one has its 9th harmonic folded there at ' + db(nAlias / nf).toFixed(1) + ' dB');
  console.log('       (quote: naive square alias ' + db(nAlias / nf).toFixed(1) + ' dB)');
  ok(Math.abs(peak(L) - 0.5) < 1e-6, 'square peak is the asked level, Gibbs overshoot included (' + peak(L).toFixed(4) + ')');
}
{
  for (const w of ['sawtooth', 'triangle']) {
    const [L] = T.render({ wave: w, freq: 220, seconds: 1, rate: R, amp: 0.5 });
    const h2 = amp(L, R, 440), h1 = amp(L, R, 220), half = amp(L, R, 330);
    const want2 = w === 'sawtooth' ? 1 / 2 : 0;
    ok(Math.abs(peak(L) - 0.5) < 1e-6 && (w === 'sawtooth' ? Math.abs(db(h2 / h1) - db(want2)) < 0.2 : db(h2 / h1) < -100) && db(half / h1) < -100,
      w + ': harmonics as expected (2nd ' + db(h2 / h1).toFixed(1) + ' dB), nothing in between');
  }
}

console.log('sweeps, channels, fades');
{
  const [L] = T.render({ wave: 'sine', freq: 20, freq2: 20000, seconds: 10, rate: R, amp: 0.5 });
  // Instantaneous frequency at the middle of a log sweep: sqrt(20 * 20000).
  const mid = 5 * R, win = R / 10, n = crossings(L, mid - win / 2, mid + win / 2) * 10;
  ok(Math.abs(n - 632.5) < 15, 'log sweep 20 Hz-20 kHz passes 632 Hz at half time (' + n + ' Hz)');
  let jump = 0; for (let i = 1; i < L.length; i++) jump = Math.max(jump, Math.abs(L[i] - L[i - 1]));
  ok(jump < 0.5 * 2 * Math.PI * 20000 / R * 1.01, 'no discontinuity anywhere in the sweep (largest step ' + jump.toFixed(3) + ')');
  const [Ln] = T.render({ wave: 'sine', freq: 100, freq2: 1100, sweep: 'lin', seconds: 4, rate: R, amp: 0.5 });
  const nl = crossings(Ln, 2 * R - R / 20, 2 * R + R / 20) * 10;
  ok(Math.abs(nl - 600) < 15, 'linear sweep passes the arithmetic middle at half time (' + nl + ' Hz)');
}
{
  const [L, Rr] = T.render({ wave: 'sine', freq: 440, seconds: 1, rate: R, channel: 'left' });
  ok(peak(Rr) === 0 && peak(L) > 0, 'left only: the right channel is silent');
  const [L2, R2] = T.render({ wave: 'sine', freq: 200, beat: 10, seconds: 2, rate: R });
  // The crossing at sample 0 itself is not counted, hence the 1 of slack.
  ok(Math.abs(crossings(L2, 0, R) - 200) <= 1 && Math.abs(crossings(R2, 0, R) - 210) <= 1, 'binaural: left 200 Hz, right 210 Hz (' + crossings(L2, 0, R) + ', ' + crossings(R2, 0, R) + ')');
  const [F] = T.render({ wave: 'sine', freq: 1000, seconds: 1, rate: R, amp: 0.5, fade: 0.01 });
  ok(F[0] === 0 && Math.abs(F[F.length - 1]) < 1e-6 && Math.abs(F[R / 2]) <= 0.5, 'fades start and end at zero');
}

console.log('noise');
{
  const slope = (x) => {
    // Level in octave bands around 250, 500, ... 8000 Hz, by the mean of
    // Goertzel amplitudes at 8 frequencies inside each band.
    const out = [];
    for (let fc = 250; fc <= 8000; fc *= 2) {
      let s = 0; for (let k = 0; k < 16; k++) { const f = fc * Math.pow(2, (k / 16 - 0.5)); s += amp(x, R, f, 0, 65536) ** 2; }
      out.push(10 * Math.log10(s / 16 * fc));      // power in the octave, ~ density x bandwidth
    }
    return (out[out.length - 1] - out[0]) / (out.length - 1);
  };
  const n = 2 * R;
  const [W] = T.render({ wave: 'white', seconds: n / R, rate: R, amp: 0.5 });
  const [P] = T.render({ wave: 'pink', seconds: n / R, rate: R, amp: 0.5 });
  const [Bn] = T.render({ wave: 'brown', seconds: n / R, rate: R, amp: 0.5 });
  const sw = slope(W), sp = slope(P), sb = slope(Bn);
  // Octave-band power: white rises 3 dB/octave, pink is flat, brown falls 3.
  ok(Math.abs(sw - 3) < 1.2, 'white: +3 dB per octave in octave bands, i.e. flat per Hz (' + sw.toFixed(2) + ')');
  ok(Math.abs(sp) < 1.2, 'pink: flat in octave bands, -3 dB/octave per Hz (' + sp.toFixed(2) + ')');
  ok(Math.abs(sb + 3) < 1.5, 'brown: -3 dB per octave band, -6 per Hz (' + sb.toFixed(2) + ')');
  ok(Math.abs(peak(W) - 0.5) < 1e-6 && Math.abs(peak(P) - 0.5) < 1e-6, 'noise peaks at the asked level');
  const [W2] = T.render({ wave: 'white', seconds: 1, rate: R });
  const [W3] = T.render({ wave: 'white', seconds: 1, rate: R });
  ok(W2.every((v, i) => v === W3[i]), 'the same noise every time');
}

console.log('notes');
{
  ok(T.noteOf(440).name === 'A4' && T.noteOf(261.63).name === 'C4' && T.noteOf(445).cents === 20, 'note names and cents (A4, C4, 445 Hz = A4 +20)');
}

// The page: live play (the oscillator really runs and reaches the asked
// level), the play success counted once, and each download format written
// at 48 kHz with the tone at the asked frequency and level.
async function browser() {
  const { withPage, findChrome } = require('./chrome-harness');
  if (!findChrome()) { console.log('  skip: no Chrome'); return; }
  console.log('page');
  await withPage({}, async (page) => {
    await page.goto('/tone-generator', 600);
    const r = await page.eval('(function () { var e = document.getElementById("tgPlay"); e.scrollIntoView({ block: "center" }); var b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()');
    await page.eval(`(function () {
      window.__ev = []; var g = window.gtag; window.gtag = function (a, b, c) { if (a === 'event') window.__ev.push([b, c]); return g && g.apply(this, arguments); };
      // Tap the page's output: every node the page connects to the
      // destination is also fed to an analyser.
      var orig = AudioNode.prototype.connect;
      AudioNode.prototype.connect = function (dest) {
        if (dest instanceof AudioDestinationNode && !dest.__tap) { dest.__tap = dest.context.createAnalyser(); dest.__tap.fftSize = 32768; window.__tap = dest.__tap; }
        if (dest instanceof AudioDestinationNode) orig.call(this, dest.__tap);
        return orig.apply(this, arguments);
      };
    })()`);
    await page.eval('document.getElementById("tgFreq").value = "1000"; document.getElementById("tgFreq").dispatchEvent(new Event("input"))');
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', buttons: 1, clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', buttons: 0, clickCount: 1 });
    await new Promise((res) => setTimeout(res, 3600));
    const live = await page.eval(`(function () {
      var a = window.__tap, d = new Float32Array(a.fftSize); a.getFloatTimeDomainData(d);
      var pk = 0, n = 0; for (var i = 0; i < d.length; i++) { pk = Math.max(pk, Math.abs(d[i])); if (i && d[i - 1] < 0 && d[i] >= 0) n++; }
      return { pk: pk, hz: n * a.context.sampleRate / d.length, ev: window.__ev.filter(function (e) { return e[1] && e[1].tool === 'tone-generator'; }).map(function (e) { return e[0] + ':' + e[1].target_format; }) };
    })()`);
    ok(Math.abs(20 * Math.log10(live.pk) + 20) < 0.5 && Math.abs(live.hz - 1000) < 5, 'live: 1 kHz at -20 dBFS reaches the output (' + live.hz.toFixed(0) + ' Hz, ' + (20 * Math.log10(live.pk)).toFixed(2) + ' dBFS)');
    ok(live.ev.filter((e) => e === 'convert_success:play').length === 1 && live.ev.includes('convert_start:play'), 'three seconds of play is one success (' + live.ev.join(', ') + ')');
    await page.eval('window.__tone.stop()');
    for (const fmt of ['wav16', 'wav24', 'wav32f', 'mp3-320']) {
      const res = await page.eval(`(async function () {
        document.getElementById('tgFormat').value = '${fmt}';
        document.getElementById('tgSecs').value = '2';
        document.getElementById('tgChan').value = 'left';
        var got = null, orig = CV.downloadBlob; CV.downloadBlob = function (b, n) { got = { b: b, n: n }; };
        document.getElementById('convertBtn').click();
        for (var i = 0; i < 300 && !got; i++) await new Promise(function (r) { setTimeout(r, 100); });
        CV.downloadBlob = orig;
        if (!got) return { err: document.getElementById('status').textContent };
        var c = new OfflineAudioContext(2, 48000, 48000);
        var buf = await c.decodeAudioData(await got.b.arrayBuffer());
        var L = buf.getChannelData(0), pk = 0, n = 0, R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null, rp = 0;
        for (var j = 24000; j < 72000; j++) { pk = Math.max(pk, Math.abs(L[j])); if (L[j - 1] < 0 && L[j] >= 0) n++; if (R) rp = Math.max(rp, Math.abs(R[j])); }
        return { name: got.n, rate: buf.sampleRate, ch: buf.numberOfChannels, secs: buf.duration, pk: pk, hz: n, rp: rp };
      })()`);
      ok(res && !res.err && res.rate === 48000 && res.ch === 2 && Math.abs(res.hz - 1000) <= 1 && Math.abs(20 * Math.log10(res.pk) + 20) < 0.3 && res.rp === 0 && Math.abs(res.secs - 2) < 0.06,
        fmt + ': ' + (res.err || res.name + ', ' + res.rate + ' Hz, ' + res.ch + ' ch, ' + res.secs.toFixed(3) + ' s, ' + res.hz + ' Hz, ' + (20 * Math.log10(res.pk)).toFixed(2) + ' dBFS, right ' + (res.rp ? (20 * Math.log10(res.rp)).toFixed(0) + ' dB' : 'silent')));
    }
    const errs = page.logs.filter((l) => !/scriptwrapper|ERR_CONNECTION_REFUSED|favicon/.test(l));
    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ').slice(0, 300) : ''));
  });
}

browser().then(() => {
  if (failed) { console.log('\ncheck-tone: ' + failed + ' failed'); process.exit(1); }
  console.log('\ncheck-tone: all good');
}).catch((e) => { console.error(e); process.exit(1); });
