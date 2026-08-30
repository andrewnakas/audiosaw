# Growth playbook — what shipped, what is still open

Source: the exebrowser.com growth read (28 Aug 2026). That document is a
*method*, not a diagnosis — it says so itself. The sister site's 2.2× did not
come from the fixes it lists; it came from getting indexed. What follows is the
method applied to AudioSaw, with the parts that were already true here marked
as such.

## §1 — Verify the instruments (open: needs the GA4 console)

Two of the four faults **cannot occur here**, verified in the code:

- No heartbeat exists. `grep -rn "setInterval\|heartbeat\|visibilitychange" js/`
  returns only the voice-recorder's 200 ms UI clock, which is not sent to GA4.
  So the background-tab inflation bug has nothing to inflate.
- No retry loop exists. `flow.js` fires `convert_error` exactly once per failed
  conversion, from the `CV.setStatus` wrapper. There is no catch-and-retry
  anywhere, so the "1,307 errors from 7 users" pattern has no source here.

Two still need checking in the GA4 UI, and only you can do them:

**a. Is the window finished processing?** Explore → any report → compare
`page_view` event count against total users. Below ~99% coverage the window is
still landing and a dip is not real. Do this *before* reading anything else.

**b. Are the starred key events real?** Admin → Data display → Events. GA4 ships
`purchase`, `qualify_lead` and `close_convert_lead` pre-marked; AudioSaw emits
none of them, so a property showing "Key events 0" while looking configured is
the expected failure. The complete list of events this site can actually send —
every one of them from `js/flow.js` — is:

| Event | Fires when | Worth starring |
|---|---|---|
| `convert_success` | a file finishes and downloads | **yes — this is the conversion** |
| `convert_start` | the action button is clicked | no (denominator, not outcome) |
| `convert_error` | `CV.setStatus(el,'error',…)` runs | no |
| `file_selected` | a file is dropped or picked | no |
| `next_step_click` | a related/footer/error-panel link is clicked | yes |
| `chain_continue` | a file is carried into the next tool | **yes — the retention proxy** |
| `preview_play` | the post-conversion player is played | no |
| `download_again` | the same blob is re-downloaded | no |

Star `convert_success`, `next_step_click`, `chain_continue`. Do not star
`file_selected` — it fires per drop and would inflate every conversion figure
the same way a heartbeat would.

**c. Per-user event rates.** Divide any event count by users. Anything above
~10 per user per session is a bug, not engagement. `download_again` is the one
to watch: it is deliberately separated from `convert_success` so a user clicking
"download again" five times cannot be read as five conversions.

## §2 — Which engine are you on? (open: needs Bing Webmaster Tools)

audiosaw.com is already imported into the same Bing account as exebrowser.com.
Open it next to Search Console and compare the query lists. The playbook expects
this to **invert** for AudioSaw: a utility is what Google is willing to rank,
whereas the sister site was a games site Google refused to read as one.

IndexNow is already wired: `node tools/indexnow.js` submits every sitemap URL to
Bing, Yandex, Seznam and Naver. Run it **after** the deploy is live — the script
verifies the key file over HTTPS first and refuses to submit if it 404s.

## §3 — The AI-assistant channel (shipped)

`robots.txt` already names the retrieval agents explicitly, which is the part
that matters most.

`llms.txt` now leads with an FAQ instead of a link catalogue. It is generated
from `tools/build-llms.js` — edit the generator, never the file. The FAQ answers
the questions an assistant actually receives ("how do I convert without
installing anything", "does it upload my files", "what is the catch") in
self-contained paragraphs an assistant can lift whole, and it answers the two
awkward ones honestly: the site is ad-funded, and it is not a DAW.

## §4 — Chase the modifier, not the noun (shipped)

Eighteen titles rewritten, all within the ~82-character SERP budget:

- Thirteen pages were still on the old `— runs in your browser | AudioSaw`
  formula. That carries no intent modifier and wasted 20+ characters of budget
  each on the brand suffix.
- Five titles were over budget and were being truncated.

Guard rail applied: `mp4-to-mp3` briefly claimed "no size limit", which the page
itself contradicts (~500 MB, bounded by browser memory). It says "no daily
limit" instead, which is true. Only claim what survives contact with the page.

Four tool pages — `audio-cutter`, `audio-joiner`, `audio-reverser`,
`normalize-audio` — carried a visible FAQ but no `FAQPage` schema, so they were
the only tool pages invisible to FAQ rich results and to assistants that read
schema. The JSON-LD is generated from the page's own `<details>` markup so the
two cannot drift.

## §5 — Retention (deliberately not shipped)

The playbook's email capture was declined, and there is a real reason beyond
preference: "no signup, no email" now appears in thirty-odd page titles and is
the first thing `llms.txt` says. That claim is doing conversion work. An email
capture would cost it.

If retention is revisited, the utility-site equivalent is an installable PWA —
manifest, offline service worker, and an install prompt after a successful
conversion. It puts an icon on the dock, needs no backend, and keeps the claim
intact. `chain_continue` is already the best retention signal the site has.

## §6 — Deploy traps

AudioSaw deploys from a `main` push via Cloudflare Pages' git integration, so
the `wrangler pages deploy --branch` trap does not apply. The second half does:
curl the real domain after a deploy, never the `*.pages.dev` URL.

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://audiosaw.com/mp4-to-mp3
```

## Order of operations for the next deploy

1. Push to `main`.
2. Re-run `node tools/build-sitemap.js` **after** committing — `lastmod` comes
   from each file's last git commit, so running it on a dirty tree writes the
   previous commit's date for pages you just changed.
3. `node tools/indexnow.js` once the deploy is live.
4. Google gets nothing from IndexNow. For the retitled pages, the sitemap plus
   the `lastmod` bump is the mechanism; expect ~10 days before CTR moves.

## What is unproven

The title rewrite is a real bet on a real mechanism, but it is a bet. It moves
CTR at unchanged rank or it does nothing; the failure mode is a modifier that
does not match intent. Give it ten days of Search Console data at the same
average position before judging, and compare CTR rather than clicks — clicks
will move for reasons that have nothing to do with the titles.
