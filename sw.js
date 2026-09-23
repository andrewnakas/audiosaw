/*
 * AudioSaw service worker.
 *
 * Two jobs: make the "it keeps working offline" claim true on a return visit
 * (until now it held only for the tab you already had open), and answer the
 * share-target POST so a file shared from a phone lands in a tool.
 *
 * Deliberately narrow. Three things are bypassed entirely rather than handled:
 *
 *  - Everything cross-origin. The 30 MB ffmpeg core is fetched and cached by
 *    audio-core.js, which hands the worker a blob: URL this file never sees;
 *    opaque responses from anything else are unbounded quota padding.
 *  - /stem-splitter and /vendor/ort/*. Those must arrive with their real
 *    COOP/COEP/CORP headers or ONNX Runtime's nested pthread workers hang
 *    session creation forever. A synthesised or fallback response drops the
 *    headers, and the failure is silent and intermittent — the exact bug
 *    CLAUDE.md documents, made harder to find.
 *  - Non-GET, except the share POST.
 *
 * Q must match the ?v= token in the HTML. CLAUDE.md's bump command includes
 * this file for that reason.
 */
'use strict';

var Q = '?v=2026-09-23n';
var V = Q.slice(3);

var STATIC = 'audiosaw-static-' + V;   // immutable assets, keyed on the full URL
var PAGES = 'audiosaw-pages';          // HTML, keyed on pathname, kept across versions
var OFFLINE = '/offline';

// Short on purpose: one 404 here fails the whole install and the worker never
// activates. Vendor files (lamejs, the ffmpeg loader) fill in at first use.
var PRECACHE = [
  '/',
  '/manifest.webmanifest',
  '/favicon.ico',
  '/assets/icons/icon-192.png',
  '/assets/icons/icon-512.png',
  '/assets/icons/icon-maskable-192.png',
  '/assets/icons/icon-maskable-512.png',
  '/css/style.css' + Q,
  '/js/common.js' + Q,
  '/js/tool-graph.js' + Q,
  '/js/flow.js' + Q,
  '/js/audio-core.js' + Q,
  '/js/consent.js' + Q,
  '/js/pwa.js' + Q,
  '/js/tool-converter.js' + Q,
  '/js/universal-converter.js' + Q
];

var STATIC_PATHS = /^\/(css|js|vendor|assets)\//;
// /stemflipper is a separate single-page app proxied in by functions/stemflipper/. It
// owns its own routing and its own asset versioning, so this worker must stay out of the
// way entirely — caching its HTML here would pin visitors to a stale build.
var BYPASS = /^\/(stemflipper(\/|$)|stem-splitter(\.html)?$|js\/stem-worker\.js|js\/stem-separator\.js|vendor\/ort\/)/;

// Where a shared file should land. Anything unlisted goes to the homepage,
// whose converter accepts everything and picks a target.
var LANDING = {
  mp4: '/mp4-to-mp3', m4v: '/mp4-to-mp3', webm: '/mp4-to-mp3', mkv: '/mp4-to-mp3', avi: '/mp4-to-mp3',
  mov: '/mov-to-mp3', qt: '/mov-to-mp3',
  m4a: '/m4a-to-mp3', aac: '/aac-to-mp3', m4b: '/m4b-to-mp3',
  opus: '/opus-to-mp3', ogg: '/ogg-to-mp3', oga: '/ogg-to-mp3',
  flac: '/flac-to-mp3', aif: '/aiff-to-mp3', aiff: '/aiff-to-mp3', wav: '/wav-to-mp3'
};

function landingFor(name) {
  var m = /\.([a-z0-9]+)$/i.exec(name || '');
  return (m && LANDING[m[1].toLowerCase()]) || '/';
}

/* ------------------------------------------------------------- lifecycle */

// cache.addAll is atomic: one 404 rejects the whole batch, the install fails and
// the worker never activates, so a single mistyped path silently disables
// offline support for everyone. Fetch them individually and keep what we get.
// The offline page is stored under one canonical key whichever URL served it.
// Cloudflare Pages serves it at /offline and 308s /offline.html to it; a local
// static server does the opposite. Cache whichever answers, keyed on /offline,
// so the fallback lookup is the same in both.
async function cacheOfflinePage(cache) {
  var candidates = [OFFLINE, OFFLINE + '.html'];
  for (var i = 0; i < candidates.length; i++) {
    try {
      var res = await fetch(candidates[i], { cache: 'reload' });
      if (res && res.ok) {
        var body = await res.arrayBuffer();
        await cache.put(OFFLINE, new Response(body, {
          status: 200,
          headers: { 'Content-Type': res.headers.get('Content-Type') || 'text/html; charset=utf-8' }
        }));
        return true;
      }
    } catch (e) { /* try the next spelling */ }
  }
  return false;
}

self.addEventListener('install', function (event) {
  event.waitUntil((async function () {
    var cache = await caches.open(STATIC);
    await cacheOfflinePage(cache);
    var results = await Promise.allSettled(PRECACHE.map(async function (url) {
      var res = await fetch(url, { cache: 'reload' });
      if (!res.ok) throw new Error(url + ' -> ' + res.status);
      await cache.put(url, res);
    }));
    var failed = results.filter(function (r) { return r.status === 'rejected'; });
    if (failed.length) {
      console.warn('sw: ' + failed.length + ' of ' + PRECACHE.length + ' precache entries failed',
        failed.map(function (r) { return String(r.reason); }));
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    var names = await caches.keys();
    await Promise.all(names.map(function (n) {
      // Drop previous versions' static caches; leave PAGES and the ffmpeg core
      // bucket (owned by audio-core.js) alone.
      if (n.indexOf('audiosaw-static-') === 0 && n !== STATIC) return caches.delete(n);
      return null;
    }));
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch (e) {}
    }
    await self.clients.claim();
  })());
});

/* ------------------------------------------------------------ share target */

// Mirror of the handoff store in js/flow.js. The database name, version and
// store name must match that file exactly or one side throws VersionError.
function putHandoff(payload) {
  return new Promise(function (resolve, reject) {
    var req = indexedDB.open('audiosaw', 1);
    req.onupgradeneeded = function () {
      if (!req.result.objectStoreNames.contains('handoff')) req.result.createObjectStore('handoff');
    };
    req.onerror = function () { reject(req.error); };
    req.onsuccess = function () {
      var db = req.result;
      var tx = db.transaction('handoff', 'readwrite');
      tx.objectStore('handoff').put(payload, 'pending');
      tx.oncomplete = function () { db.close(); resolve(); };
      tx.onerror = function () { db.close(); reject(tx.error); };
    };
  });
}

async function handleShare(request) {
  var dest = '/';
  try {
    var form = await request.formData();
    var files = form.getAll('media').filter(function (f) { return f && f.size; });
    if (files.length) {
      dest = landingFor(files[0].name);
      await putHandoff({ name: files[0].name, blob: files[0], from: 'share' });
    }
  } catch (e) {
    // Land them on a working page regardless; an empty dropzone beats an error.
  }
  return Response.redirect(dest + (dest.indexOf('?') > -1 ? '&' : '?') + 'from=share', 303);
}

/* ----------------------------------------------------------------- fetch */

async function networkFirstPage(event) {
  var request = event.request;
  try {
    var preload = event.preloadResponse ? await event.preloadResponse : null;
    var res = preload || await fetch(request);
    if (res && res.ok && res.type !== 'opaqueredirect') {
      // Re-wrap: Cloudflare Pages 308-redirects /x.html to /x, and handing a
      // Response with redirected=true back to a navigation makes the browser
      // reject it outright.
      var body = await res.clone().arrayBuffer();
      var copy = new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
      var key = new URL(res.url || request.url).pathname;
      var cache = await caches.open(PAGES);
      await cache.put(key, copy);
    }
    return res;
  } catch (e) {
    var hit = await caches.match(new URL(request.url).pathname, { ignoreSearch: true });
    if (hit) return hit;
    var off = await caches.match(OFFLINE);
    if (off) return off;
    throw e;
  }
}

async function cacheFirst(request) {
  var hit = await caches.match(request);
  if (hit) return hit;
  var res = await fetch(request);
  if (res && res.ok) {
    var cache = await caches.open(STATIC);
    cache.put(request, res.clone());
  }
  return res;
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  var url;
  try { url = new URL(request.url); } catch (e) { return; }

  if (request.method === 'POST' && url.origin === self.location.origin && url.pathname === '/share') {
    event.respondWith(handleShare(request));
    return;
  }

  if (request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (BYPASS.test(url.pathname)) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstPage(event));
    return;
  }

  if (STATIC_PATHS.test(url.pathname) || url.pathname === '/favicon.ico') {
    event.respondWith(cacheFirst(request));
  }
});
