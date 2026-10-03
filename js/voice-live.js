/*
 * The live half of /voice-changer: the microphone through a voice effect as
 * you speak, heard in headphones and recordable.
 *
 * One AudioWorklet does all of it, so what is recorded is exactly what is
 * heard: a delay-line pitch shifter (two read heads 40 ms apart on a
 * circular buffer, each sliding at 1 - ratio samples per sample and faded
 * in and out with complementary sin²/cos² windows, so the sum is constant),
 * then ring modulation (robot, alien), two biquads (radio, telephone), soft
 * drive and an optional bit-crush.
 *
 * It is rougher than the file mode on purpose: PSOLA needs the whole
 * waveform to find each cycle, so live shifting cannot hold the formants and
 * "deeper" sounds bigger as well as lower. About 40 ms of the shifter's
 * window plus the browser's own audio latency separate speaking from
 * hearing.
 *
 * A browser tab cannot feed Discord, Zoom or a game directly; the page says
 * so, and how a virtual audio cable does it.
 */
(function () {
  'use strict';
  if (typeof CV === 'undefined' || typeof AudioSaw === 'undefined') return;
  var $ = CV.$;
  var btn = $('#liveBtn'), recBtn = $('#liveRec'), presetSel = $('#livePreset'), pitchEl = $('#livePitch'), pitchOut = $('#livePitchVal');
  var monitorEl = $('#liveMonitor'), statusEl = $('#liveStatus'), meterEl = $('#liveMeter');
  if (!btn) return;

  var PRESETS = {
    natural: { pitch: 0 },
    deeper: { pitch: -4 },
    higher: { pitch: 4 },
    chipmunk: { pitch: 9 },
    monster: { pitch: -9, drive: 2.5 },
    robot: { pitch: 0, ring: 50, ringMix: 1 },
    alien: { pitch: 2, ring: 180, ringMix: 0.6 },
    radio: { pitch: 0, hp: 300, lp: 3400, drive: 1.6 },
    telephone: { pitch: 0, hp: 400, lp: 3000, crush: 6 }
  };

  // The worklet, shipped as a Blob URL (no extra file to version).
  function workletSource() {
    /* global sampleRate, registerProcessor, AudioWorkletProcessor */
    class ASLiveVoice extends AudioWorkletProcessor {
      constructor() {
        super();
        this.N = 1 << 13; this.buf = new Float32Array(this.N); this.w = 0;
        this.win = Math.round(sampleRate * 0.04); this.ph = 0; this.t = 0;
        this.p = { ratio: 1, ring: 0, ringMix: 0, drive: 0, crush: 0, hp: null, lp: null };
        this.z = [0, 0, 0, 0, 0, 0, 0, 0]; this.rec = false; this.peak = 0; this.n = 0;
        this.port.onmessage = (e) => { const d = e.data || {}; if (d.params) this.p = Object.assign(this.p, d.params); if ('rec' in d) this.rec = d.rec; };
      }
      read(d) {
        const N = this.N, pos = this.w - d - 2, i = Math.floor(pos), f = pos - i;
        const a = this.buf[(i % N + N) % N], b = this.buf[((i + 1) % N + N) % N];
        return a + (b - a) * f;
      }
      bq(c, x, k) {
        if (!c) return x;
        const z = this.z, y = c[0] * x + c[1] * z[k] + c[2] * z[k + 1] - c[3] * z[k + 2] - c[4] * z[k + 3];
        z[k + 1] = z[k]; z[k] = x; z[k + 3] = z[k + 2]; z[k + 2] = y;
        return y;
      }
      process(inputs, outputs) {
        const inp = inputs[0] && inputs[0][0], out = outputs[0][0];
        if (!out) return true;
        const p = this.p, W = this.win, r = p.ratio, N = this.N;
        for (let i = 0; i < out.length; i++) {
          const x = inp ? inp[i] : 0;
          this.buf[this.w] = x;
          let y = x;
          if (Math.abs(r - 1) > 1e-3) {
            this.ph += 1 - r;
            if (this.ph >= W) this.ph -= W; else if (this.ph < 0) this.ph += W;
            const d1 = this.ph, d2 = (this.ph + W / 2) % W, g = Math.sin(Math.PI * d1 / W);
            y = g * g * this.read(d1) + (1 - g * g) * this.read(d2);
          }
          this.w = (this.w + 1) % N;
          if (p.ring) { this.t += p.ring / sampleRate; if (this.t > 1) this.t -= 1; y *= 1 - p.ringMix + p.ringMix * Math.sin(2 * Math.PI * this.t); }
          y = this.bq(p.hp, y, 0); y = this.bq(p.lp, y, 4);
          if (p.drive) y = Math.tanh(y * p.drive) / Math.tanh(p.drive);
          if (p.crush) { const q = Math.pow(2, p.crush); y = Math.round(y * q) / q; }
          out[i] = y;
          const a = Math.abs(y); if (a > this.peak) this.peak = a;
        }
        for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
        if (this.rec) this.port.postMessage({ block: out.slice() });
        if ((this.n += out.length) >= sampleRate / 15) { this.port.postMessage({ peak: this.peak }); this.peak = 0; this.n = 0; }
        return true;
      }
    }
    registerProcessor('as-live-voice', ASLiveVoice);
  }

  // RBJ biquads, normalised: [b0, b1, b2, a1, a2].
  function biquad(type, f, sr) {
    var w = 2 * Math.PI * f / sr, cs = Math.cos(w), al = Math.sin(w) / (2 * Math.SQRT1_2), a0 = 1 + al;
    var b = type === 'hp' ? [(1 + cs) / 2, -(1 + cs), (1 + cs) / 2] : [(1 - cs) / 2, 1 - cs, (1 - cs) / 2];
    return [b[0] / a0, b[1] / a0, b[2] / a0, -2 * cs / a0, (1 - al) / a0];
  }

  var ctx = null, node = null, stream = null, src = null, out = null, rec = null;

  function params() {
    var pr = PRESETS[presetSel.value] || PRESETS.natural, sr = ctx ? ctx.sampleRate : 48000;
    var st = parseFloat(pitchEl.value) || 0;
    return { ratio: Math.pow(2, st / 12), ring: pr.ring || 0, ringMix: pr.ringMix || 0, drive: pr.drive || 0, crush: pr.crush || 0,
      hp: pr.hp ? biquad('hp', pr.hp, sr) : null, lp: pr.lp ? biquad('lp', pr.lp, sr) : null };
  }
  function push() { if (node) node.port.postMessage({ params: params() }); }
  function showPitch() { var st = +pitchEl.value || 0; pitchOut.textContent = (st > 0 ? '+' : '') + st + ' semitones'; }

  presetSel.addEventListener('change', function () { pitchEl.value = (PRESETS[presetSel.value] || {}).pitch || 0; showPitch(); push(); });
  pitchEl.addEventListener('input', function () { showPitch(); push(); });
  monitorEl.addEventListener('change', function () { if (out) out.gain.value = monitorEl.checked ? 1 : 0; });
  CV.remember(presetSel, 'as_vc_live');
  presetSel.dispatchEvent(new Event('change'));

  async function start() {
    btn.disabled = true;
    // Made inside the click, before getUserMedia: made after the permission
    // prompt, an AudioContext can stay suspended and deliver silence.
    var C = window.AudioContext || window.webkitAudioContext;
    ctx = new C({ latencyHint: 'interactive' });
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false, channelCount: 1 } });
      var url = URL.createObjectURL(new Blob(['(' + workletSource.toString() + ')()'], { type: 'text/javascript' }));
      await ctx.audioWorklet.addModule(url);
      if (ctx.state === 'suspended') await ctx.resume();
      src = ctx.createMediaStreamSource(stream);
      node = new AudioWorkletNode(ctx, 'as-live-voice', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      out = ctx.createGain(); out.gain.value = monitorEl.checked ? 1 : 0;
      src.connect(node); node.connect(out); out.connect(ctx.destination);
      node.port.onmessage = function (e) {
        var d = e.data || {};
        if (d.block && rec) { rec.parts.push(d.block); rec.n += d.block.length; if (rec.n > ctx.sampleRate * 600) stopRec(); }
        if (d.peak != null && meterEl) meterEl.style.width = Math.min(100, Math.round(Math.sqrt(d.peak) * 100)) + '%';
      };
      push();
      btn.textContent = 'Stop the microphone';
      recBtn.disabled = false;
      CV.setStatus(statusEl, 'success', 'Live. Speak and you hear the changed voice' + (monitorEl.checked ? '' : ' (hearing is off)') + '. Use headphones, or the speakers feed back into the microphone.');
    } catch (e) {
      stop();
      CV.setStatus(statusEl, 'error', 'The microphone could not be opened. ' + ((e && e.message) || e), e);
    }
    btn.disabled = false;
  }

  function stop() {
    if (rec) stopRec();
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    if (ctx) try { ctx.close(); } catch (e) {}
    ctx = node = stream = src = out = null;
    btn.textContent = 'Start the microphone';
    recBtn.disabled = true;
    if (meterEl) meterEl.style.width = '0';
  }

  btn.addEventListener('click', function () { if (ctx) { stop(); CV.clearStatus(statusEl); } else start(); });

  function startRec() {
    rec = { parts: [], n: 0, t0: Date.now(), sr: ctx.sampleRate };
    node.port.postMessage({ rec: true });
    recBtn.textContent = '■ Stop and save';
    CV.setStatus(statusEl, 'info', 'Recording the changed voice…');
  }
  async function stopRec() {
    var r = rec; rec = null;
    if (node) node.port.postMessage({ rec: false });
    recBtn.textContent = '● Record';
    if (!r || !r.n) return;
    var all = new Float32Array(r.n), o = 0;
    r.parts.forEach(function (b) { all.set(b, o); o += b.length; });
    var sr = r.sr;
    try {
      var blob = await AudioSaw.encode(AudioSaw.makeBuffer([all], sr), 'mp3', { bitrate: 192 });
      window.__liveVoice = { samples: all, sampleRate: sr, preset: presetSel.value };
      CV.downloadBlob(blob, 'live-voice-' + presetSel.value + '.mp3');
      CV.setStatus(statusEl, 'success', 'Saved ' + (r.n / sr).toFixed(1) + ' s of your changed voice as MP3.');
    } catch (e) {
      CV.setStatus(statusEl, 'error', 'Could not save the recording. ' + ((e && e.message) || e), e);
    }
  }
  recBtn.addEventListener('click', function () { if (!node) return; if (rec) stopRec(); else startRec(); });

  window.__voiceLive = { start: start, stop: stop, startRec: startRec, stopRec: stopRec, params: params };
})();
