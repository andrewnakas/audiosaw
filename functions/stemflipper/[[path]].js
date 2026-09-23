/**
 * Serve StemFlipper at /stemflipper/ from its own repo.
 *
 * StemFlipper is a Vite app that lives in andrewnakas/stemflipper and is built and
 * deployed by that repo's GitHub Pages workflow. Rather than copying its build output in
 * here on every change — two repos, one artifact, guaranteed to drift — this proxies the
 * path to Pages and keeps one source of truth.
 *
 * A Pages Function runs BEFORE static assets and before _redirects, so this wins over the
 * `/* -> /404.html` catch-all. _routes.json keeps every other request off Functions
 * entirely.
 *
 * Note for anyone reading this after using the rest of the site: unlike every other tool
 * here, StemFlipper uploads the audio to a GPU server. That is stated on its own page.
 */

const UPSTREAM = "https://andrewnakas.github.io/stemflipper/";

/** Sent on the proxied response, since _headers does not apply to Function output. */
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  // The app records an AudioContext and fetches from the Hugging Face Space; it needs no
  // camera, microphone or location.
  "permissions-policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
};

/**
 * Headers from GitHub/Fastly that would be wrong or misleading on audiosaw.com.
 *
 * content-encoding and content-length MUST be dropped: the runtime hands us a decoded
 * body, so passing the upstream's "gzip" through tells the browser to gunzip bytes that
 * already are gunzipped, and the page arrives as binary noise. (Found by running this
 * under `wrangler pages dev` before shipping it.)
 */
const DROP = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "content-security-policy",
  "permissions-policy",
  "referrer-policy",
  "server",
  "strict-transport-security",
  "via",
  "x-fastly-request-id",
  "x-frame-options",
  "x-github-request-id",
  "x-served-by",
  "x-cache",
  "x-cache-hits",
  "x-timer",
  "age",
]);

export async function onRequest({ request, params }) {
  const url = new URL(request.url);
  const rest = Array.isArray(params.path) ? params.path.join("/") : params.path || "";
  const target = UPSTREAM + rest + url.search;

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }

  // /stemflipper must become /stemflipper/ before anything is served. The app references
  // its assets relatively, and without the trailing slash the browser resolves them
  // against the site root, so every one of them 404s.
  if (!rest && !url.pathname.endsWith("/")) {
    url.pathname += "/";
    return Response.redirect(url.toString(), 301);
  }

  const upstream = await fetch(target, {
    method: request.method,
    headers: forwarded(request.headers),
    redirect: "follow",
    // Hashed assets are immutable; the HTML is short-lived. 300 s matches the site's
    // own /*.html rule, so a StemFlipper deploy shows up within five minutes.
    cf: { cacheTtl: rest.includes(".") && !rest.endsWith(".html") ? 86400 : 300, cacheEverything: true },
  });

  const headers = new Headers();
  for (const [k, v] of upstream.headers) {
    if (!DROP.has(k.toLowerCase())) headers.set(k, v);
  }
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);

  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}

/** Pass through only what the upstream needs; drop cookies and hop-by-hop headers. */
function forwarded(incoming) {
  const out = new Headers();
  // Deliberately NOT accept-encoding: let the runtime negotiate compression end to end
  // rather than trying to pass an encoded body through with its header intact.
  for (const name of ["accept", "accept-language", "range", "if-none-match", "if-modified-since", "user-agent"]) {
    const v = incoming.get(name);
    if (v) out.set(name, v);
  }
  return out;
}
