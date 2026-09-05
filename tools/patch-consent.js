/*
 * One-shot: make the inline Consent Mode bootstrap region-aware.
 *
 * Before this, every visitor on earth got analytics_storage denied by default,
 * so most sessions outside the EEA were cookieless pings for no legal reason —
 * GDPR-style prior consent is a European requirement, and the rest of the world
 * is opt-out. The banner is now shown only where it is actually needed, and a
 * footer link lets anyone change their mind.
 *
 * The timezone test is a heuristic. It is the only signal available to a static
 * site with no edge function, and it errs toward showing the banner: an unknown
 * or unreadable timezone is treated as European.
 *
 * Safe to delete once it has run.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const OLD = `(function(){var s=null;try{s=localStorage.getItem('fex_consent_v1');}catch(e){}
var g=s==='all'?'granted':'denied';
gtag('consent','default',{ad_storage:g,ad_user_data:g,ad_personalization:g,analytics_storage:g,wait_for_update:500});
})();`;

const NEW = `(function(){var s=null;try{s=localStorage.getItem('fex_consent_v1');}catch(e){}
var eu=true;try{var tz=(Intl.DateTimeFormat().resolvedOptions().timeZone)||'';
eu=/^Europe\\//.test(tz)||/^Atlantic\\/(Reykjavik|Canary|Madeira|Azores|Faroe)/.test(tz);}catch(e){}
var g=s?(s==='all'?'granted':'denied'):(eu?'denied':'granted');
gtag('consent','default',{ad_storage:g,ad_user_data:g,ad_personalization:g,analytics_storage:g,wait_for_update:500});
window.AS_CONSENT={eu:eu,choice:s};})();`;

let touched = 0;
let missing = [];
for (const f of fs.readdirSync(root).filter((x) => x.endsWith('.html'))) {
  const p = path.join(root, f);
  const before = fs.readFileSync(p, 'utf8');
  if (!before.includes(OLD)) {
    if (before.includes('AS_CONSENT')) continue; // already patched
    missing.push(f);
    continue;
  }
  fs.writeFileSync(p, before.replace(OLD, NEW));
  touched++;
}
console.log(`patch-consent: rewrote ${touched} files`);
if (missing.length) {
  console.error(`did NOT match in ${missing.length}: ${missing.join(', ')}`);
  process.exit(1);
}
