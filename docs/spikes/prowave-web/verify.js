// Serves dist/ through AudioSaw's chrome harness, starts the app in headless Chrome,
// screenshots it and listens to its AudioContext. node verify.js
const fs = require('fs'), path = require('path');
const { withPage } = require('../../../tools/chrome-harness');
const DIST = path.join(__dirname, 'dist');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const routes = {
  '/pw/': fs.readFileSync(path.join(DIST, 'index.html'), 'utf8'),
  '/pw/prowave.js': () => fs.readFileSync(path.join(DIST, 'prowave.js')),
  '/pw/prowave_bg.wasm': () => fs.readFileSync(path.join(DIST, 'prowave_bg.wasm')),
};
(async () => {
  await withPage({ routes, args: ['--enable-unsafe-swiftshader', '--window-size=1280,800'] }, async (page) => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(function () {
      window.__ac = []; var O = window.AudioContext;
      function W(o) { var c = new O(o); c.__an = c.createAnalyser(); c.__an.fftSize = 2048; window.__ac.push(c); return c; }
      W.prototype = O.prototype; window.AudioContext = W;
      var conn = AudioNode.prototype.connect;
      AudioNode.prototype.connect = function (d) { if (d && d === this.context.destination && this.context.__an) conn.call(this, this.context.__an); return conn.apply(this, arguments); };
    })()` });
    const shot = async (name) => { const r = await page.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(__dirname, name), Buffer.from(r.result.data, 'base64')); };
    await page.goto('/pw/', 1500);
    let up = false;
    for (let i = 0; i < 600 && !up; i++) { await sleep(200); up = await page.eval('!!window.wasmBindings'); }
    console.log('module loaded:', up);
    await sleep(8000);
    await shot('shot-1-started.png');
    console.log('isolated:', await page.eval('self.crossOriginIsolated'), 'SAB:', await page.eval('typeof SharedArrayBuffer'));
    const peak = `(function () { var c = window.__ac[0]; if (!c) return { n: 0 }; var a = new Float32Array(2048), m = 0; c.__an.getFloatTimeDomainData(a); for (var i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i])); return { n: window.__ac.length, state: c.state, peak: m, rate: c.sampleRate }; })()`;
    console.log('before click:', JSON.stringify(await page.eval(peak)));
    const X = +(process.env.CX || 640), Y = +(process.env.CY || 400);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: X, y: Y, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: X, y: Y, button: 'left', clickCount: 1 });
    await sleep(1500);
    await page.eval('(function(){ window.__ac.forEach(function(c){ if (c.state !== "running") c.resume(); }); })()');
    await sleep(500);
    const idle = await page.eval(peak);
    console.log('after click:', JSON.stringify(idle));
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', text: ' ', windowsVirtualKeyCode: 32 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
    let loud = 0;
    for (let i = 0; i < 40; i++) { await sleep(250); const p = await page.eval(peak); loud = Math.max(loud, p.peak || 0); }
    console.log('after Space: output peak', loud.toFixed(4));
    await shot('shot-2-playing.png');
    console.log('page errors:', page.logs.length, page.logs.slice(0, 8).join('\n').slice(0, 2500));
  });
})().catch((e) => { console.error(e); process.exit(1); });
