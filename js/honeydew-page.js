/*
 * /honeydew page controller. Honeydew is daijro's clean-room music studio
 * modelled on FL Studio Mobile (GPL-3.0-or-later, github.com/daijro/honeydew);
 * its web build is in /vendor/honeydew/0.5.3/, the code unmodified.
 *
 * Same arrangement as /soundcraft: nothing loads until Start (15 MB of
 * WebAssembly), and the app runs in an iframe sandboxed to an opaque origin,
 * so it cannot read this site's storage and nothing here reaches into it.
 * The frame's host page posts one message when the app is up, which is this
 * page's convert_success (target_format 'app'), once.
 *
 * The opaque origin also means the app has no Cache Storage or localStorage:
 * its sounds are fetched again each visit and a song lives only until the
 * tab closes, unless it is saved to a file from the app's own menu.
 */
(function (global) {
  'use strict';
  var CV = global.CV;
  if (!CV) { console.error('[honeydew] the /js/* includes must come before honeydew-page.js'); return; }
  var $ = CV.$;
  var SRC = '/vendor/honeydew/0.5.3/frame';
  var el = { start: $('#hdStart'), stage: $('#hdStage'), status: $('#status'), full: $('#hdFull'), webgl: $('#hdWebgl'), bar: $('#hdBar') };
  if (!el.start || !el.stage) return;
  var frame = null, counted = false, slow = 0;

  global.addEventListener('message', function (e) {
    if (!frame || e.source !== frame.contentWindow || !e.data) return;
    if (e.data.as === 'honeydew-unsupported') {
      clearTimeout(slow);
      CV.setStatus(el.status, 'error', 'Honeydew needs WebAssembly SIMD: Chrome 96, Firefox 113 or Safari 16.4, or later.', new Error('unsupported: WebAssembly SIMD is not supported'));
      return;
    }
    if (e.data.as !== 'honeydew-started') return;
    clearTimeout(slow);
    CV.clearStatus(el.status);
    if (!counted) { counted = true; CV.track('convert_success', { tool: 'honeydew', target_format: 'app' }); }
  });

  function open(webgl) {
    if (frame) frame.remove();
    frame = document.createElement('iframe');
    frame.title = 'Honeydew';
    // No allow-same-origin: see the note at the top.
    frame.setAttribute('sandbox', 'allow-scripts allow-downloads');
    frame.setAttribute('allow', 'autoplay; fullscreen');
    frame.src = SRC;
    el.stage.innerHTML = '';
    el.stage.appendChild(frame);
    el.stage.classList.add('is-on');
    el.bar.hidden = false;
    el.start.hidden = true;
    CV.setStatus(el.status, 'info', 'Loading Honeydew (about 15 MB the first time, then it is cached)…');
    clearTimeout(slow);
    slow = setTimeout(function () {
      CV.setStatus(el.status, 'warn', 'Still loading. On a slow connection the download takes a while; if the frame stays blank, press "Reload the app".');
    }, 45000);
  }

  el.start.addEventListener('click', function () {
    CV.track('convert_start', { tool: 'honeydew', target_format: 'app' });
    open(false);
  });
  el.webgl.addEventListener('click', function () { open(true); });
  el.full.addEventListener('click', function () {
    var s = el.stage;
    (s.requestFullscreen || s.webkitRequestFullscreen || function () {}).call(s);
  });
})(window);
