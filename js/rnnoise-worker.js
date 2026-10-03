/*
 * The AI method on /noise-reduction: RNNoise (Xiph's recurrent denoiser, the
 * Apache-2.0 WebAssembly build by Shiguredo, vendor/rnnoise/) in a module
 * worker, so a long file does not freeze the page.
 *
 * RNNoise works on 480-sample frames at 48 kHz, in 16-bit PCM units, and
 * its output lags its input by exactly 960 samples (20 ms; measured on
 * speech, correlation 0.990). The page resamples to 48 kHz and back; this
 * worker scales, runs the frames, and returns each channel delay-compensated
 * and the same length it came in, so a video stays in sync.
 *
 * Protocol
 *   in : { type: 'run', channels: [Float32Array (48 kHz)] }
 *   out: { type: 'progress', pct }
 *        { type: 'done', channels: [Float32Array], vad: number (mean voice probability) }
 *        { type: 'error', message }
 */

var AS_V = (/[?&]v=([^&]+)/.exec(self.location.search || '') || [])[1] || '';
var FRAME = 480, DELAY = 960, SCALE = 32768;
var lib = null;

function load() {
  if (!lib) lib = import('/vendor/rnnoise/rnnoise.js?v=2025.1.5').then(function (m) { return m.Rnnoise.load(); });
  return lib;
}

async function run(channels) {
  var R = await load(), out = [], vadSum = 0, vadN = 0;
  var total = channels.reduce(function (a, c) { return a + c.length; }, 0), done = 0, lastPost = 0;
  for (var ch = 0; ch < channels.length; ch++) {
    var x = channels[ch], n = x.length;
    // Room for the delay: run DELAY samples of silence past the end, then
    // drop the first DELAY samples of output.
    var len = Math.ceil((n + DELAY) / FRAME) * FRAME, y = new Float32Array(len), f = new Float32Array(FRAME);
    var st = R.createDenoiseState();
    for (var a = 0; a < len; a += FRAME) {
      for (var i = 0; i < FRAME; i++) { var k = a + i; f[i] = k < n ? x[k] * SCALE : 0; }
      var v = st.processFrame(f);
      if (a < n) { vadSum += v; vadN++; }
      for (var j = 0; j < FRAME; j++) y[a + j] = f[j] / SCALE;
      done += FRAME;
      if (done - lastPost > 48000 * 5) { lastPost = done; self.postMessage({ type: 'progress', pct: Math.min(99, 100 * done / (total + DELAY * channels.length)) }); }
    }
    st.destroy();
    out.push(y.slice(DELAY, DELAY + n));
  }
  return { channels: out, vad: vadN ? vadSum / vadN : 0 };
}

self.onmessage = async function (e) {
  var m = e.data || {};
  try {
    if (m.type === 'run') {
      var r = await run(m.channels);
      self.postMessage({ type: 'done', channels: r.channels, vad: r.vad }, r.channels.map(function (c) { return c.buffer; }));
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: (err && err.message) || String(err) });
  }
};
void AS_V;
