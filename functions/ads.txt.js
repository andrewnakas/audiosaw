/**
 * /ads.txt: Journey by Mediavine's managed file, served from our own domain.
 *
 * It used to be a 301 to adstxt.journeymv.com. Browsers and curl follow that,
 * but Mediavine's dashboard reported the file missing (11 Oct 2026): an ads.txt
 * crawler may refuse a redirect to another domain. So this fetches their file
 * and answers 200 here, which every crawler accepts, while their partner list
 * still updates without a deploy. Cached at the edge for an hour.
 *
 * If their host is down, it falls back to the old redirect rather than serve
 * nothing.
 */

const UPSTREAM = "https://adstxt.journeymv.com/sites/8d9c72aa-0358-4c00-b603-0ec44530c303/ads.txt";

export async function onRequest() {
  try {
    const res = await fetch(UPSTREAM, { cf: { cacheTtl: 3600, cacheEverything: true } });
    const body = res.ok ? await res.text() : "";
    if (!/journeymv\.com/i.test(body)) throw new Error("unexpected ads.txt from upstream (" + res.status + ")");
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "public, max-age=3600",
        "x-content-type-options": "nosniff"
      }
    });
  } catch (e) {
    return Response.redirect(UPSTREAM, 302);
  }
}
