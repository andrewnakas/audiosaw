/*
 * Service worker registration and the install prompt.
 *
 * Separate from flow.js on purpose: five pages here load no other JavaScript,
 * flow.js needs common.js and tool-graph.js before it, and this is
 * infrastructure rather than post-conversion behaviour.
 *
 * No new analytics events. CLAUDE.md fixes the site at eight, so the install
 * outcome rides on next_step_click with a to_tool value, the same way every
 * other "they went somewhere" signal does.
 */
(function (global) {
  'use strict';

  var SNOOZE_KEY = 'as_install_snooze';
  var INSTALLED_KEY = 'as_installed';
  var SHOWN_KEY = 'as_install_shown';
  var COUNT_KEY = 'as_success_count';
  var DAY = 86400000;

  var deferred = null;

  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  function track(name, params) {
    try {
      if (global.CV && global.CV.track) global.CV.track(name, params);
      else if (typeof global.gtag === 'function') global.gtag('event', name, params || {});
    } catch (e) {}
  }

  /* ------------------------------------------------------ registration */

  if ('serviceWorker' in navigator) {
    global.addEventListener('load', function () {
      // No ?v= on the URL: the browser byte-compares the script itself, and the
      // no-cache header on /sw.js is what makes an update land promptly.
      navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
        .then(function (reg) {
          // Cloudflare Pages forces a four-hour browser TTL on any .js file and
          // will not accept a shorter one (see the /sw.js note in _headers).
          // updateViaCache:'none' already makes this fetch bypass the HTTP
          // cache; asking explicitly once per load means a returning visitor
          // picks up a new worker on their next navigation rather than
          // whenever the browser decides to look.
          try { reg.update(); } catch (e) {}
        })
        .catch(function () { /* offline support is a bonus, never a blocker */ });
    });
  }

  /* ----------------------------------------------------- install prompt */

  function standalone() {
    try {
      return (global.matchMedia && global.matchMedia('(display-mode: standalone)').matches) ||
        navigator.standalone === true;
    } catch (e) { return false; }
  }

  function isIOS() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent) && !/crios|fxios/i.test(navigator.userAgent);
  }

  function snoozed() {
    var t = parseInt(get(SNOOZE_KEY), 10);
    return !!t && Date.now() < t;
  }

  function shownThisSession() {
    try { return sessionStorage.getItem(SHOWN_KEY) === '1'; } catch (e) { return false; }
  }
  function markShown() {
    try { sessionStorage.setItem(SHOWN_KEY, '1'); } catch (e) {}
  }

  function shouldOffer() {
    if (standalone() || get(INSTALLED_KEY) || snoozed() || shownThisSession()) return false;
    // Not on the first success: at that moment the download, the preview player
    // and three next-step chips are already competing for attention, and
    // "you'll want this next time" is not yet true. The second one is the
    // earliest point the pitch is honest, and it catches the return visit.
    if ((parseInt(get(COUNT_KEY), 10) || 0) < 2) return false;
    return !!deferred || isIOS();
  }

  global.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
  });

  global.addEventListener('appinstalled', function () {
    set(INSTALLED_KEY, '1');
    var chip = document.getElementById('installChip');
    if (chip) chip.remove();
  });

  function dismiss(chip, days, label) {
    set(SNOOZE_KEY, String(Date.now() + days * DAY));
    track('next_step_click', { tool: toolName(), to_tool: label, placement: 'post_convert' });
    if (chip) chip.remove();
  }

  function toolName() {
    try { return (global.CV && global.CV.flow) ? global.CV.flow.tool() : 'index'; }
    catch (e) { return 'index'; }
  }

  function chipFor(host) {
    var chip = document.createElement('div');
    chip.className = 'handoff-chip install-chip';
    chip.id = 'installChip';

    var text = document.createElement('span');
    text.className = 'handoff-text';
    var actions = document.createElement('span');
    actions.className = 'handoff-actions';

    if (deferred) {
      text.textContent = 'Install AudioSaw and skip the search next time. Works offline.';
      var yes = document.createElement('button');
      yes.type = 'button';
      yes.className = 'btn btn-small';
      yes.textContent = 'install';
      yes.addEventListener('click', function () {
        var prompt = deferred;
        deferred = null;
        chip.remove();
        if (!prompt) return;
        prompt.prompt();
        prompt.userChoice.then(function (choice) {
          var accepted = choice && choice.outcome === 'accepted';
          track('next_step_click', {
            tool: toolName(), to_tool: 'install', placement: 'post_convert', accepted: !!accepted
          });
          // Chrome suppresses the native prompt for months after a dismissal;
          // matching that here keeps us from re-asking into a dead end.
          if (!accepted) set(SNOOZE_KEY, String(Date.now() + 90 * DAY));
        }).catch(function () {});
      });
      actions.appendChild(yes);
    } else {
      text.textContent = 'Keep AudioSaw one tap away: Share, then Add to Home Screen.';
    }

    var no = document.createElement('button');
    no.type = 'button';
    no.className = 'btn btn-small btn-secondary';
    no.textContent = 'not now';
    no.addEventListener('click', function () { dismiss(chip, 30, 'install_later'); });
    actions.appendChild(no);

    chip.appendChild(text);
    chip.appendChild(actions);
    host.appendChild(chip);
    markShown();
  }

  // flow.js fires this once a conversion has actually produced a download.
  document.addEventListener('as:converted', function () {
    if (!shouldOffer()) return;
    var host = document.getElementById('nextSteps');
    if (!host) return;
    if (document.getElementById('installChip')) return;
    chipFor(host);
  });
})(window);
