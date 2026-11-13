/*
 * /webamp page controller. The player is Webamp (Jordan Eldredge, MIT), the
 * Winamp 2 interface rebuilt in JavaScript, in its bundle with Butterchurn
 * (Jordan Berg, MIT) for the MilkDrop window. Both come from
 * /vendor/webamp/2.3.1/, unmodified; the bundle fetches nothing itself.
 *
 * This file only feeds it: files from the drop zone become its playlist, a
 * .wsz becomes its skin. Webamp plays through an <audio> element, so it
 * plays what the browser plays and nothing is decoded here.
 *
 * Three seconds of playing is this page's success (target_format 'play'),
 * once, as on /tone-generator: nothing is downloaded, so CV.downloadBlob
 * never runs.
 */
(function (global) {
  'use strict';
  var CV = global.CV;
  if (!CV) { console.error('[webamp] the /js/* includes must come before webamp-page.js'); return; }
  var $ = CV.$;
  var SRC = '/vendor/webamp/2.3.1/webamp.butterchurn-bundle.min.mjs';
  var el = {
    dropzone: $('#dropzone'), fileInput: $('#fileInput'), status: $('#status'), stage: $('#wampStage'),
    reopen: $('#wampReopen'), note: $('#wampNote')
  };
  if (!el.dropzone || !el.stage) return;

  var player = null, loading = null, hadTracks = false, started = false, counted = false, playedMs = 0, timer = 0, closed = false;

  function isSkin(f) { return /\.(wsz|zip)$/i.test(f.name); }

  // One import and one instance, however many times files arrive while it loads.
  function ready() {
    if (loading) return loading;
    loading = import(SRC).then(function (m) {
      var Webamp = m.default || m.Webamp;
      player = new Webamp({ enableHotkeys: true, zIndex: 50 });
      player.onClose(function () { closed = true; el.reopen.hidden = false; });
      return player.renderWhenReady(el.stage).then(function () {
        el.stage.classList.add('is-on');
        if (el.note) el.note.hidden = true;
        return player;
      });
    });
    loading.catch(function (e) {
      loading = null;
      CV.setStatus(el.status, 'error', 'The player did not start. ' + (e.message || e), e);
    });
    return loading;
  }

  function tick() {
    if (counted || !player) return;
    if (player.getMediaStatus() === 'PLAYING') {
      playedMs += 500;
      if (playedMs >= 3000) {
        counted = true;
        clearInterval(timer);
        CV.track('convert_success', { tool: 'webamp', target_format: 'play' });
      }
    }
  }

  CV.bindDropzone(el.dropzone, el.fileInput, function (files) {
    if (!files.length) return;
    var skins = files.filter(isSkin), songs = files.filter(function (f) { return !isSkin(f); });
    ready().then(function (p) {
      CV.clearStatus(el.status);
      // reopen() on a player that is already open stops the song.
      if (closed) { closed = false; el.reopen.hidden = true; p.reopen(); }
      // The object URL has to outlive this handler: Webamp reads the skin later.
      if (skins.length) p.setSkinFromUrl(URL.createObjectURL(skins[skins.length - 1]));
      if (!songs.length) return;
      var tracks = songs.map(function (f) { return { blob: f, defaultName: f.name.replace(/\.[^.]+$/, '') }; });
      // The first drop replaces Webamp's empty playlist and starts playing;
      // later drops queue behind what is already there.
      if (hadTracks) p.appendTracks(tracks); else p.setTracksToPlay(tracks);
      hadTracks = true;
      if (!started) {
        started = true;
        CV.track('convert_start', { tool: 'webamp', target_format: 'play' });
        timer = setInterval(tick, 500);
      }
    }, function () {});
  });

  el.reopen.addEventListener('click', function () {
    if (!player) return;
    closed = false;
    player.reopen();
    el.reopen.hidden = true;
  });

  // For the check: the player's own word on whether it is playing.
  global.__wamp = { status: function () { return player ? player.getMediaStatus() : null; } };

  // The page is the player, so it starts without waiting for a file. On a
  // slow link the two megabytes arrive after the text is readable.
  if (document.readyState === 'complete') ready(); else global.addEventListener('load', function () { ready(); });
})(window);
