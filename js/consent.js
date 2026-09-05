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
 * There are no ads on this site, so nothing here touches ad tags; the ad_* keys
 * stay in the consent signal because Google Signals reads them for analytics.
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
        '<p>We use one analytics cookie to count visits. Nothing else, and no ads. ' +
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
    if (state.eu && !stored()) build();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
