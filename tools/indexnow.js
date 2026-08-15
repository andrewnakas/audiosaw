#!/usr/bin/env node
/*
 * Submits every URL in sitemap.xml to IndexNow.
 *
 * IndexNow notifies Bing, Yandex, Seznam and Naver at once. Unlike Google's
 * "Request Indexing" button — which is capped at a couple of URLs a day on a new
 * property — this accepts the whole site in one call and typically results in a
 * crawl within hours.
 *
 * Worth doing here specifically because Bing already sends ~13% of sessions
 * while having only the homepage indexed, and Bing's index feeds several answer
 * engines.
 *
 * Google does not participate in IndexNow. For Google, the sitemap plus the
 * internal link graph is the mechanism.
 *
 * Run after a deploy:  node tools/indexnow.js
 *      dry run:        node tools/indexnow.js --dry
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const HOST = 'audiosaw.com';
const DRY = process.argv.includes('--dry');

// The key file must be reachable at https://HOST/<key>.txt and contain the key.
const keyFile = fs.readdirSync(ROOT)
  .find((f) => /^[0-9a-f]{32,128}\.txt$/.test(f));
if (!keyFile) {
  console.error('No IndexNow key file found in the repo root.');
  console.error('Create one with:  node -e "const c=require(\'crypto\'),k=c.randomBytes(16).toString(\'hex\');require(\'fs\').writeFileSync(k+\'.txt\',k)"');
  process.exit(1);
}
const key = keyFile.replace(/\.txt$/, '');
const stored = fs.readFileSync(path.join(ROOT, keyFile), 'utf8').trim();
if (stored !== key) {
  console.error(`${keyFile} must contain exactly the key ${key} (found ${JSON.stringify(stored)})`);
  process.exit(1);
}

const sitemap = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
const urlList = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
if (!urlList.length) {
  console.error('No <loc> entries in sitemap.xml — run tools/build-sitemap.js first.');
  process.exit(1);
}

const payload = JSON.stringify({
  host: HOST,
  key: key,
  keyLocation: `https://${HOST}/${keyFile}`,
  urlList: urlList,
});

console.log(`IndexNow: ${urlList.length} URLs, key ${key}`);
if (DRY) {
  console.log(payload.slice(0, 400) + '...');
  process.exit(0);
}

// Verify the key file is actually live before submitting — a 404 here is the
// usual reason a submission is silently rejected.
https.get(`https://${HOST}/${keyFile}`, (res) => {
  let body = '';
  res.on('data', (c) => { body += c; });
  res.on('end', () => {
    if (res.statusCode !== 200 || body.trim() !== key) {
      console.error(`Key file not live yet: https://${HOST}/${keyFile} returned ${res.statusCode}`);
      console.error('Deploy first, then re-run.');
      process.exit(1);
    }
    submit();
  });
}).on('error', (e) => { console.error('Key check failed:', e.message); process.exit(1); });

function submit() {
  const req = https.request({
    hostname: 'api.indexnow.org',
    path: '/indexnow',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
    },
  }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => {
      // 200 = accepted, 202 = accepted, key validation pending.
      const ok = res.statusCode === 200 || res.statusCode === 202;
      console.log(`IndexNow responded ${res.statusCode}${body ? ' ' + body.trim() : ''}`);
      console.log(ok ? `Submitted ${urlList.length} URLs.` : 'Submission rejected.');
      process.exit(ok ? 0 : 1);
    });
  });
  req.on('error', (e) => { console.error('Submit failed:', e.message); process.exit(1); });
  req.write(payload);
  req.end();
}
