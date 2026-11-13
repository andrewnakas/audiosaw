/*
 * /soundcraft page controller. SoundCraft is ArtCraft's clean-room digital
 * audio workstation (Apache-2.0, github.com/storytold/soundcraft); its web
 * build is in /vendor/soundcraft/0.20.1/, unmodified.
 *
 * It is 18 MB of WebAssembly, so nothing loads until the button is pressed.
 * It then runs in an iframe sandboxed to an opaque origin (no
 * allow-same-origin): the app cannot read this site's storage, cookies or
 * pages, and nothing here reaches into it. The frame's host page posts one
 * message when the app has started, which is this page's convert_success
 * (target_format 'app'), once.
 */
(function (global) {
  'use strict';
  var CV = global.CV;
  if (!CV) { console.error('[soundcraft] the /js/* includes must come before soundcraft-page.js'); return; }
  var $ = CV.$;
  var SRC = '/vendor/soundcraft/0.20.1/frame';
  var el = { start: $('#scStart'), stage: $('#scStage'), status: $('#status'), full: $('#scFull'), webgl: $('#scWebgl'), bar: $('#scBar') };
  if (!el.start || !el.stage) return;
  var frame = null, counted = false, slow = 0;

  global.addEventListener('message', function (e) {
    if (!frame || e.source !== frame.contentWindow || !e.data || e.data.as !== 'soundcraft-started') return;
    clearTimeout(slow);
    CV.clearStatus(el.status);
    if (!counted) { counted = true; CV.track('convert_success', { tool: 'soundcraft', target_format: 'app' }); }
  });

  function open(webgl) {
    if (frame) frame.remove();
    frame = document.createElement('iframe');
    frame.title = 'SoundCraft';
    // No allow-same-origin: see the note at the top.
    frame.setAttribute('sandbox', 'allow-scripts allow-downloads');
    frame.setAttribute('allow', 'autoplay; fullscreen');
    frame.src = SRC + (webgl ? '?webgl' : '');
    el.stage.innerHTML = '';
    el.stage.appendChild(frame);
    el.stage.classList.add('is-on');
    el.bar.hidden = false;
    el.start.hidden = true;
    CV.setStatus(el.status, 'info', 'Loading SoundCraft (about 18 MB the first time, then it is cached)…');
    clearTimeout(slow);
    slow = setTimeout(function () {
      CV.setStatus(el.status, 'warn', 'Still loading. On a slow connection the download takes a while; if the frame stays blank, try "Use WebGL".');
    }, 45000);
  }

  el.start.addEventListener('click', function () {
    CV.track('convert_start', { tool: 'soundcraft', target_format: 'app' });
    open(false);
  });
  el.webgl.addEventListener('click', function () { open(true); });
  el.full.addEventListener('click', function () {
    var s = el.stage;
    (s.requestFullscreen || s.webkitRequestFullscreen || function () {}).call(s);
  });
})(window);
