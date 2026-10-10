/*
 * Consent banner UI. Pairs with the inline consent-mode bootstrap in each
 * page's <head>, which sets the defaults before gtag.js loads and leaves its
 * verdict on window.AS_CONSENT as { eu, choice }.
 *
 * The banner is shown only where prior consent is actually required. It used to
 * interrupt every visitor on earth and deny analytics storage by default, which
 * outside the EEA/UK/CH bought nothing: those jurisdictions are opt-out, and the
 * cost was that most sessions reported as cookieless pings.
 *
 * Anyone can still change their mind — the footer carries a "Cookie settings"
 * link, which is also the mechanism the CCPA-style opt-out needs. That link
 * works everywhere, including where the banner never appeared.
 *
 * Ads come from Journey by Mediavine (the AS:ads tag in each page's head,
 * written by build-nav.js), which runs its own consent handling for ads. This
 * file governs Google Analytics; the ad_* keys stay in the consent signal
 * because Google Signals reads them for analytics.
 */
(function (global) {
  'use strict';

  var KEY = 'fex_consent_v1';
  var state = global.AS_CONSENT || {};

  function stored() {
    if (state.choice !== undefined) return state.choice;
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }

  function apply(choice) {
    try { localStorage.setItem(KEY, choice); } catch (e) {}
    state.choice = choice;
    if (typeof global.gtag !== 'function') return;
    var v = choice === 'all' ? 'granted' : 'denied';
    global.gtag('consent', 'update', {
      ad_storage: v,
      ad_user_data: v,
      ad_personalization: v,
      analytics_storage: v
    });
  }

  function close(bar) {
    if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
  }

  function build() {
    if (document.getElementById('fbc-consent')) return;
    var bar = document.createElement('div');
    bar.id = 'fbc-consent';
    bar.setAttribute('role', 'dialog');
    bar.setAttribute('aria-label', 'Cookie settings');
    bar.innerHTML =
      '<div class="fbc-consent-inner">' +
        '<p>We use an analytics cookie to count visits, and our ad partner uses cookies to choose the ads. ' +
        'Your files never leave your device &mdash; see our <a href="/privacy">Privacy Policy</a>.</p>' +
        '<div class="fbc-consent-actions">' +
          '<button type="button" class="btn btn-secondary" data-c="essential">Decline</button>' +
          '<button type="button" class="btn" data-c="all">Allow analytics</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(bar);

    bar.addEventListener('click', function (e) {
      var choice = e.target && e.target.getAttribute('data-c');
      if (!choice) return;
      apply(choice);
      close(bar);
    });
  }

  // Exposed so the footer link can reopen the choice anywhere on the site.
  global.AS_openConsent = build;

  function init() {
    var link = document.getElementById('consentSettings');
    if (link) {
      link.addEventListener('click', function (e) {
        e.preventDefault();
        build();
      });
    }
    // Only interrupt where prior consent is the legal requirement, and only
    // until a choice exists.
    if (state.eu && !stored()) waitForCmp();
  }

  // Journey brings its own TCF consent dialog to European visitors. Showing
  // ours on top of it put two banners at the bottom of the page, beside the
  // ad bar. So where its CMP is running and says GDPR applies, its answer is
  // the answer: analytics is granted with purpose 1 (store on the device) plus
  // 8 or 9 (measurement), and is stored so the <head> default matches next
  // time. Ours appears only when no CMP turns up (the ad-free pages, an ad
  // blocker) or the CMP decides GDPR does not apply where the clock says Europe.
  var CMP_WAIT_MS = 4000;

  function waitForCmp() {
    var t0 = Date.now();
    (function poll() {
      if (typeof global.__tcfapi === 'function') return listenTcf();
      if (Date.now() - t0 > CMP_WAIT_MS) return build();
      setTimeout(poll, 200);
    })();
  }

  function listenTcf() {
    var settled = false;
    var timer = setTimeout(function () { if (!settled) { settled = true; build(); } }, CMP_WAIT_MS);
    try {
      global.__tcfapi('addEventListener', 2, function (tc, ok) {
        if (!ok || !tc) return;
        if (tc.gdprApplies === false) {
          if (!settled) { settled = true; clearTimeout(timer); build(); }
          return;
        }
        if (tc.eventStatus === 'cmpuishown') { settled = true; clearTimeout(timer); return; }
        if (tc.eventStatus !== 'tcloaded' && tc.eventStatus !== 'useractioncomplete') return;
        settled = true;
        clearTimeout(timer);
        var p = (tc.purpose && tc.purpose.consents) || {};
        apply(p[1] && (p[8] || p[9]) ? 'all' : 'essential');
      });
    } catch (e) {
      if (!settled) { settled = true; clearTimeout(timer); build(); }
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
