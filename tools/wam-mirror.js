/*
 * A local mirror of the community WAM2 plugins, for the checks.
 *
 * A plugin is a tree of ES modules, worklet scripts, wasm, JSON, images and
 * sometimes samples, fetched relative to each other and to other hosts.
 * Nobody can list that tree statically (some are webpack dev builds that
 * import from eval'd strings). So the mirror records it instead: with
 * WAM_DOWNLOAD=1 a check runs against the network and every https response
 * the page receives is saved under ~/.cache/audiosaw/wam/. Without it, the
 * same requests are answered from the mirror through CDP Fetch, and anything
 * the mirror does not hold fails and is listed in `misses`, so a check never
 * depends on a third-party host being up.
 *
 *   const mirror = require('./wam-mirror');
 *   const m = await mirror.attach(page);        // before page.goto
 *   ... m.misses, m.recording, mirror.have()
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(os.homedir(), '.cache', 'audiosaw', 'wam');
const MANIFEST = path.join(DIR, 'manifest.json');
const INDEX = 'https://www.webaudiomodules.com/community/plugins.json';

function load() { try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch (e) { return {}; } }
function have() { return !!load()[INDEX]; }

async function attach(page, opts) {
  opts = opts || {};
  const recording = !!(opts.record != null ? opts.record : process.env.WAM_DOWNLOAD);
  const manifest = load();
  const misses = [];
  let saved = 0;
  fs.mkdirSync(DIR, { recursive: true });
  const flush = () => fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 0));

  page.listen('Fetch.requestPaused', async (p) => {
    const url = p.request.url;
    const id = p.requestId;
    try {
      if (recording) {
        if (p.responseStatusCode == null) { await page.send('Fetch.continueRequest', { requestId: id }); return; }
        const headers = (p.responseHeaders || []).filter((h) => /^(content-type|location)$/i.test(h.name));
        if (p.responseStatusCode >= 300 && p.responseStatusCode < 400) {
          manifest[url] = { status: p.responseStatusCode, headers };
          flush();
          await page.send('Fetch.continueRequest', { requestId: id });
          return;
        }
        const r = await page.send('Fetch.getResponseBody', { requestId: id });
        const body = r.result ? Buffer.from(r.result.body, r.result.base64Encoded ? 'base64' : 'utf8') : null;
        if (body && p.responseStatusCode === 200) {
          const file = crypto.createHash('sha1').update(url).digest('hex');
          fs.writeFileSync(path.join(DIR, file), body);
          manifest[url] = { status: 200, headers, file };
          saved++;
          flush();
        }
        // Reading the body does not consume it: the response goes on as it
        // came.
        await page.send('Fetch.continueRequest', { requestId: id });
        return;
      }
      const hit = manifest[url];
      if (!hit) { misses.push(url); await page.send('Fetch.failRequest', { requestId: id, errorReason: 'InternetDisconnected' }); return; }
      const headers = hit.headers.concat([
        { name: 'Access-Control-Allow-Origin', value: '*' },
        { name: 'Cross-Origin-Resource-Policy', value: 'cross-origin' }
      ]);
      const body = hit.file ? fs.readFileSync(path.join(DIR, hit.file)) : Buffer.alloc(0);
      await page.send('Fetch.fulfillRequest', { requestId: id, responseCode: hit.status, responseHeaders: headers, body: body.toString('base64') });
    } catch (e) {
      try { await page.send('Fetch.continueRequest', { requestId: id }); } catch (e2) {}
    }
  });
  await page.send('Fetch.enable', {
    patterns: [{ urlPattern: 'https://*', requestStage: recording ? 'Response' : 'Request' }]
  });
  return { recording, misses, get saved() { return saved; } };
}

module.exports = { attach, have, DIR, INDEX };
