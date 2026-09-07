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

## §5 — Retention (shipped 5 Sep 2026)

The playbook's email capture stays declined, and the reason still holds: "no
signup, no email" appears in thirty-odd page titles and is the first thing
`llms.txt` says. That claim does conversion work an email field would cost.

What shipped instead is the utility-site equivalent, an installable PWA:

- `manifest.webmanifest`, an icon set, and `sw.js` at the root.
- The service worker makes the "kill your wifi and it still works" claim true on
  a **return** visit. It was previously true only for a tab you already had open,
  which is not what the sentence implies to a reader.
- A `share_target`, so a voice memo shared from a phone lands directly in the
  right tool with the file already loaded. This is the mobile job the site is
  pitched at — `m4a-to-mp3` and `opus-to-mp3` exist for it — and there was
  previously no path into it at all short of opening Safari and finding the page.
- An install chip in the post-conversion panel, on the **second** success rather
  than the first, snoozed for 30 days if dismissed and 90 if the native prompt is
  refused.
- Dropdowns remember their last setting, and the homepage, 404 and offline pages
  offer back the last five tools used.

### What to watch, and what would disprove it

PWA launches carry `utm_source=pwa`, so they appear in GA4 acquisition as
`pwa / standalone` with no new event. Shortcut launches are `pwa / shortcut`.

- `chain_continue` was already the best retention signal and should rise: the
  handoff record used to be deleted on read, so reloading the landing page lost
  the carried file permanently and the chip never returned.
- `next_step_click` with `to_tool: install` counts accepted installs;
  `install_later` counts dismissals. If dismissals swamp accepts, the threshold
  is wrong, not the feature — raise it above two successes before removing it.
- The honest failure mode: installs happen and return visits do not follow. Give
  it a month, then compare returning-user share against the pre-PWA baseline
  rather than counting installs, which measure intent and not behaviour.

## §5b — Ads removed (5 Sep 2026)

AdSense loaded on 55 pages and there was never a single `<ins>` unit on the
site, so it earned nothing and cost every visitor the largest third-party script
on the page. Removed entirely, along with the prose that claimed the site had
ads. `ads.txt` stays.

Consent became region-aware at the same time. Everyone worldwide was previously
served a banner with analytics denied by default, which is the European
requirement applied to jurisdictions that are opt-out. Outside Europe the
default is now granted with a footer opt-out, so those sessions are counted
properly instead of arriving pre-declined. **Expect reported users to rise
without traffic changing** — that is measurement catching up, not growth, and
comparing across the change will mislead.

## §7 — Content depth and new surface (6 Sep 2026)

Two levers pulled after the completion and retention work.

**Every thin page rewritten.** `mp4-to-mp3` — the highest-intent query on the
site — was also its thinnest tool page at 418 words, and two of its seven FAQ
answers were the same question. Seven pages were under 700 words; none are now,
and the median is about 940. The new material is the part a SERP snippet cannot
answer: why an MP3 sounds quieter than its WAV, the semitone ratios for
pitch-shifted speed changes, where a silence threshold sits against a room's
noise floor.

**Four new tools**, taking the site from 49 to 53:

| Page | Why it exists |
|---|---|
| `wma-to-mp3` | Old Windows Media Player CD rips that a Mac or phone refuses |
| `caf-to-mp3` | Apple Core Audio out of GarageBand iOS and Logic |
| `ac3-to-mp3` | DVD and broadcast soundtracks, 5.1 downmixed to stereo |
| `bpm-finder` | Tempo detection — a new capability, not another format pair |

Formats were verified decodable in a real browser before any page was written.
The BPM detector was validated against click tracks and drum patterns at six
known tempos and lands within 0.2 BPM on musical material.

Note for reading the numbers: `bpm-finder` produces no download, so it emits
`convert_start` and never `convert_success`. Do not read its zero as failure.

## §8 — Building from the site's own admissions (6 Sep 2026)

A cheap way to find real unmet needs without analytics access: grep the site
for places it tells users it cannot do something. Those are documented demand,
written in our own words.

That search produced a short list. The clearest was on `/normalize-audio`:
**"There is no LUFS mode here yet"**, sitting in the middle of several
paragraphs explaining why peak normalization is not what anyone publishing to
Spotify wants. Built as `/loudness-normalizer`, and that sentence is now a link.

Three built so far: `/loudness-normalizer`, `/auto-cut-silence` — the "we don't yet remove silence between phrases"
admission on `silence-remover`. and `/audio-to-midi`. The source pages now link to
the new tools instead of apologising.

`/audio-to-midi` came from a different route — a direct request — but the same
discipline applies: monophonic only, and the page says so in the first
paragraph rather than letting people discover it by feeding it a mix.
Polyphonic transcription is an open research problem and pretending otherwise
would waste more of a user's time than declining does.

Still open, roughly in order of demand:

| Admission | Where | Note |
|---|---|---|
| No multi-region delete | `audio-cutter` | Currently two steps, cut then join |
| Tags do not survive conversion | several converters | `mp3-tag-editor` exists but nothing carries tags across a conversion |
| Cannot choose which audio track | `ac3-to-mp3`, `mp4-to-mp3` | Browsers give no reliable stream picker |
| No key detection | `bpm-finder` | Declined deliberately — a confident wrong key is worse than none |
| No reverb | `audio-reverser` | Declined deliberately — needs a mixing context |

## §6 — Deploy traps

AudioSaw deploys from a `main` push via Cloudflare Pages' git integration, so
the `wrangler pages deploy --branch` trap does not apply. The second half does:
curl the real domain after a deploy, never the `*.pages.dev` URL.

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://audiosaw.com/mp4-to-mp3
```

## Order of operations for the next deploy

1. `node tools/check-all.js` — it must exit 0.
2. Push to `main`.
3. Re-run `node tools/build-sitemap.js` and `node tools/build-dates.js`
   **after** committing — both read each file's last git commit, so running them
   on a dirty tree writes the previous commit's date for pages you just changed.
   Commit that as a follow-up.
4. `node tools/indexnow.js` once the deploy is live.
4. Google gets nothing from IndexNow. For the retitled pages, the sitemap plus
   the `lastmod` bump is the mechanism; expect ~10 days before CTR moves.

## What is unproven

The title rewrite is a real bet on a real mechanism, but it is a bet. It moves
CTR at unchanged rank or it does nothing; the failure mode is a modifier that
does not match intent. Give it ten days of Search Console data at the same
average position before judging, and compare CTR rather than clicks — clicks
will move for reasons that have nothing to do with the titles.
