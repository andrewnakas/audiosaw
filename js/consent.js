/*
 * Consent banner UI. Pairs with the inline consent-mode bootstrap in
 * each page's <head>. Stores choice in localStorage under 'fex_consent_v1'.
 *
 * For production at scale in EU/UK/CH, swap this for a Google-certified CMP.
 */
(function () {
  var KEY = 'fex_consent_v1';
  var stored = null;
  try { stored = localStorage.getItem(KEY); } catch (e) {}

  if (stored === 'all' || stored === 'essential') return;

  function build() {
    var bar = document.createElement('div');
    bar.id = 'fbc-consent';
    bar.setAttribute('role', 'dialog');
    bar.setAttribute('aria-label', 'Cookie consent');
    bar.innerHTML =
      '<div class="fbc-consent-inner">' +
        '<p>We use cookies for basic analytics and to serve ads that keep this site free. ' +
        'Your files never leave your device &mdash; see our <a href="/privacy">Privacy Policy</a>.</p>' +
        '<div class="fbc-consent-actions">' +
          '<button type="button" class="btn btn-secondary" data-c="essential">Essential only</button>' +
          '<button type="button" class="btn" data-c="all">Accept all</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(bar);

    bar.addEventListener('click', function (e) {
      var choice = e.target && e.target.getAttribute('data-c');
      if (!choice) return;
      try { localStorage.setItem(KEY, choice); } catch (err) {}
      if (choice === 'all') {
        window.adsbygoogle = window.adsbygoogle || [];
        window.adsbygoogle.requestNonPersonalizedAds = 0;
        if (typeof window.gtag === 'function') {
          window.gtag('consent', 'update', {
            ad_storage: 'granted',
            ad_user_data: 'granted',
            ad_personalization: 'granted',
            analytics_storage: 'granted'
          });
        }
      }
      bar.parentNode.removeChild(bar);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
