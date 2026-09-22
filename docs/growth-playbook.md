# Growth playbook — what shipped, what is still open

Source: the exebrowser.com growth read (28 Aug 2026). That document is a
*method*, not a diagnosis — it says so itself. The sister site's 2.2× did not
come from the fixes it lists; it came from getting indexed. What follows is the
method applied to AudioSaw, with the parts that were already true here marked
as such.

## §1 — Verify the instruments (closed 21 Sep 2026)

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

## §2 — Which engine are you on? (answered 21 Sep 2026 — see §9)

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
from `tools/build-llms.js` — edit the generator, never the file.

**Corrected 21 Sep 2026.** Two faults, both found once §9 established that this
is the main channel rather than a side bet:

- It still said *"The site is funded by display advertising, and that is the
  whole of the catch."* The ad script was removed on 5 Sep (§5b) and every page
  on the site says "no ads". So the one file written specifically to be quoted
  by assistants was the only place still carrying the old claim, in the answer
  most likely to be quoted verbatim. When a claim changes, grep for it — the
  page copy was updated and this was not, because nothing links them.
- Five tools shipped on 6 Sep — `/bpm-finder`, `/audio-to-midi`, `/autotune`,
  `/loudness-normalizer`, `/auto-cut-silence` — existed here only as one-line
  directory entries. They now have full FAQ answers, because they are exactly
  the shape of tool assistants recommend (§9). Each states its limitation in the
  answer: monophonic only, one dry voice not a mix, no key detection. An
  assistant that repeats the limitation saves somebody feeding a full mix into
  the MIDI tool and concluding the site is broken. The FAQ answers
the questions an assistant actually receives ("how do I convert without
installing anything", "does it upload my files", "what is the catch") in
self-contained paragraphs an assistant can lift whole, and it answers the two
awkward ones honestly: the site is ad-funded, and it is not a DAW.

## §4 — Chase the modifier, not the noun (shipped; closed 22 Sep — see §9)

**Read §9 before spending more time here.** Google and Bing together send 144
sessions a week against ChatGPT's 819. Title CTR is a real mechanism but it is
now being applied to a sixth of the traffic, and effort spent on `llms.txt` and
on the tool pages themselves reaches the other five sixths. Bing Webmaster Tools
flags 48 titles as over its 65-character limit, and that is a genuine
truncation — the ~82-character budget below is too generous — but it is a small
lever on a small channel. Do it when there is nothing better to do, not first.

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

## §9 — What the consoles actually said (21 Sep 2026)

§1 and §2 were both blocked on account access. Both are now done. The property
is **"Audio Saw", 538578494** — note that the same Google account holds
exebrowser (539318036) and six other properties, and the picker opens on
whichever was used last, so check the name before reading a number.

### The instruments were not recording

Two configuration faults, both found and fixed:

**Zero custom dimensions were registered.** Every parameter `flow.js` has been
carefully attaching — `tool`, `error_type`, `to_tool`, `placement`, `from_tool`,
`target_format`, `file_ext`, `pick_method`, the size buckets — was arriving at
GA4 and being **discarded**. The dropdown in the custom-dimension dialog listed
them all, which means collection was never the problem; nothing had ever been
promoted to a reportable dimension. So "which tool fails most" and "why do
conversions fail" were unanswerable, not merely unasked.

Registered: `tool`, `error_type`, `placement`, `rail`, `to_tool`. Still worth
adding when convenient: `file_ext`, `target_format`, `from_tool`, `pick_method`.

**Custom dimensions are not retroactive.** The 1,996 errors below can never be
broken down by type. Data starts from 21 Sep. This is the argument for
registering a parameter the day you start sending it, not the day you need it.
`rail` was registered *before* the homepage rails shipped, for that reason.

**Key events were the three GA4 ships by default** — `purchase`, `qualify_lead`,
`close_convert_lead` — all reading "No stream data detected", exactly the
failure §1b predicted. Now starred: `convert_success`, `next_step_click`,
`chain_continue`. `file_selected` deliberately left unstarred.

### §1a, §1c — the checks that passed

Window processing is fine: 5,560 `page_view` against 2,227 total users is 98.9%
coverage, above the ~99% bar for a settled window. No per-user rate is anywhere
near the ~10 that would indicate a loop; the highest is `convert_error` at 4.71,
and that is a real number rather than an artefact.

### The event table, 28 days (24 Aug – 20 Sep 2026)

| Event | Count | Users | Per user |
|---|---|---|---|
| `page_view` | 5,560 | 2,203 | 2.53 |
| `convert_start` | 3,445 | 1,207 | 2.85 |
| `session_start` | 3,126 | 2,198 | 1.43 |
| `file_selected` | 3,105 | 1,132 | 2.74 |
| `user_engagement` | 3,065 | 1,347 | 2.30 |
| `convert_success` | 2,925 | 876 | 3.34 |
| `first_visit` | 2,163 | 2,161 | 1.00 |
| `convert_error` | 1,996 | 424 | 4.71 |
| `download_again` | 873 | 215 | 4.06 |
| `preview_play` | 572 | 246 | 2.33 |
| `next_step_click` | 446 | 278 | 1.60 |
| `scroll` | 405 | 306 | 1.33 |
| `chain_continue` | 58 | 43 | 1.35 |

### Three things that fall out of it

**1. A third of everyone who starts a conversion hits an error.** 424 of the
1,207 users who fired `convert_start` also fired `convert_error`, and they
averaged 4.71 errors each. By event count that is 1,996 failures against 2,925
successes. This is the largest single number on the site and nobody had seen it,
because without `error_type` registered there was nothing to look at.

There is no retry loop — §1 verified that in the code — so 4.71 is 424 people
trying again, by hand, five times. That is not a measurement artefact. It is the
shape of somebody who wanted the thing to work.

The first guess is `wrong_type`, for the reason in point 3, and the recovery for
it has been improved (see below). The real distribution lands after a week of
data. **Do not act further on this until `error_type` has a week behind it** —
the fix for `decode` is nothing like the fix for `memory`.

**2. Retention is approximately zero.** 2,161 of 2,227 users fired `first_visit`:
**97% of everyone in the window was new.** `chain_continue`, the playbook's
retention proxy, reached 43 users — 1.9%. The PWA work in §5 shipped 5 Sep and
has produced 10 `pwa / standalone` sessions in the last 7 days.

Read that as: the PWA is not the lever it was hoped to be *yet*, and §5's own
honest failure mode ("installs happen and return visits do not follow") is the
one that is happening. §5 said to give it a month before judging. That month is
up on 5 Oct. Judge it then, on returning-user share, not on install count.

**3. The channel expectation in §2 is inverted, and not in the predicted way.**
§2 guessed this would invert *toward Google*, on the theory that Google ranks
utilities. It did not. Sessions, last 7 days:

| Channel | Sessions |
|---|---|
| `chatgpt.com / ai-assistant` | **819** |
| `(direct) / (none)` | 198 |
| `google / organic` | 91 |
| `bing / organic` | 53 |
| `pwa / standalone` | 10 |
| `duckduckgo / organic` | 6 |

ChatGPT alone sends **five times more traffic than every search engine
combined**. The AI-assistant work in §3 — naming the retrieval agents in
`robots.txt`, rewriting `llms.txt` to lead with liftable answers — is not a side
bet on a speculative channel. It is the main channel, and the title work in §4 is
optimising the small one.

It also changes what the top pages are. Most-viewed, last 7 days: the homepage
(412), then `/voice-recorder` (321), `/stem-splitter` (289), `/split-audio`
(130), `/mp3-tag-editor` (94), `/noise-reduction` (72). **Not one format pair in
the list.** Assistants recommend the distinctive tool, not the commodity
conversion — which is the opposite of what the site's page count is weighted
toward, and worth remembering before building the twenty-second `x-to-mp3` page.

### What shipped off the back of this

`wrong_type` used to offer "Use the universal converter", pointing at `/`. When
two thirds of arrivals land on a page an assistant chose for them, the assistant
choosing wrong is a common event, and answering it with "go back to the
homepage" asks a person whose file was just refused to start the hunt over.

`EXT_TOOL` in `js/tool-graph.js` now maps an input extension to the tool that
takes it, and the error panel names that page: drop an `.m4a` on `/wav-to-mp3`
and the first chip is "M4A to MP3". Unrecognised extensions still fall back to
the universal converter rather than guessing — a wrong suggestion costs more than
no suggestion when something has already failed. Clicks land on the existing
`next_step_click` / `placement: error`, so the fix is measurable with no new
event.

### The chain was dead-ending, and the metric could not see it

Tested end to end in a browser for the first time on 21 Sep, with a real WAV
rather than a stub. The sequence `/wav-to-mp3` → convert → "MP3 at 320 kbps" →
"continue with tone.mp3" → **"Wrong file type: .mp3"**. The tool that had just
invited you in refused the file it was handed.

`nextStepsPanel` carried the output to every suggested tool, but **26 of the
graph's `next` edges point at a tool that cannot accept the source tool's
output**. Most of those are good links with the wrong file behind them —
`/mp4-to-mp3` suggesting `/mov-to-mp3` as "same job for a .mov" is sound advice
you follow with a *different* file. Carrying the MP3 there was never right.

Two consequences worth keeping in mind when reading old numbers:

- It burned the strongest retention moment on the site. The panel appears
  immediately after a success, which is the one instant somebody is definitely
  still there and definitely pleased.
- It fed the error rate. Every dead-ended chain produced a `wrong_type`
  `convert_error`, so some unknown share of the 1,996 errors in the table above
  was the site tripping its own users.

Fixed on the **receiving** side, in `offerHandoff`: the landing page checks the
carried file against its own accept list and simply does not offer the chip if
it will not take it. That side is the only one that reliably knows the answer —
the accept list lives in each page's `AS_TOOL` config or in the argument a
bespoke tool passes to `CV.bindDropzone`, and never reached the graph. The
pending record is left in place, so a tool further along the chain can still
offer it.

Verified both directions: `/mp3-320kbps` (refuses mp3) now shows no chip;
`/normalize-audio` (accepts it) still runs the full chain —
`convert_success → next_step_click → chain_continue → convert_start →
convert_success`, ending "+7.7 dB applied".

Eight `next` reasons were also rewritten. They pointed at a different bitrate
preset with copy like "Lock the bitrate to 320 kbps for the best quality",
which you cannot reach by re-encoding the MP3 you just made — you have to run
the original again. They now say "again".

**One thing this does not fix.** `chain_continue` fires on *both* buttons: "use
it" sends `accepted: true`, "start fresh" sends `accepted: false`. It is now a
starred key event, so declines are being counted as conversions, and `accepted`
is not a registered custom dimension — so the two cannot be separated. Either
register `accepted`, or stop firing the event on the decline branch. Until then
read the 43 as "saw the chip and chose", not "continued the chain".

### Search Console, 22 Sep — the CTR question answered by killing it

Asked "what can we do to improve SEO and CTR". The console says: **nothing, on
CTR.** Three months of data:

| Metric | Value |
|---|---|
| Total clicks | 356 |
| Total impressions | 544 |
| Average CTR | 65.4% |
| Average position | 10.3 |

A 65.4% CTR looks like a triumph and is an artefact. Here is every query the
site received in three months — all ten of them:

| Query | Clicks | Impressions | CTR | Position |
|---|---|---|---|---|
| audiosaw | 296 | 351 | 84.3% | 1.0 |
| audiosaw voice recorder | 8 | 13 | 61.5% | 1.2 |
| audio saw | 2 | 2 | 100% | 1.0 |
| audiosaw official website | 0 | 17 | 0% | 2.0 |
| audioswap | 0 | 4 | 0% | 60.5 |
| sound saver | 0 | 2 | 0% | 99.5 |
| convert iphone voice memo to wav | 0 | 1 | 0% | 62.0 |
| mp3 to earrape converter | 0 | 1 | 0% | 79.0 |
| shorts to wav | 0 | 1 | 0% | 86.0 |
| audio sha | 0 | 1 | 0% | 88.0 |

**306 of 356 clicks — 86% — are people typing the brand name.** That is
bookmark-replacement behaviour, not search performance. Every non-brand query
sits at position 60 to 99: page six to page ten. The only non-brand terms with
any impressions at all are adjacent brands and misspellings.

`/mp4-to-mp3` showing 230 impressions at position 1.3 with 0.4% CTR is the same
artefact one level down: it is appearing as a secondary result on *brand*
searches, where the clicker takes the homepage.

So there is no CTR to win. 84% on your own name is the ceiling, and no title
rewrite improves on a result that is never shown for anything else.

### Why: 61 of 63 pages are not indexed

| | |
|---|---|
| Indexed | **2** |
| Not indexed | **61** |
| Reason, all 61 | **Discovered – currently not indexed** |

The sitemap is healthy — submitted 14 Aug, last read 21 Sep, status Success, all
63 URLs discovered. Google finds every page and declines to crawl them.

Everything on-page has been audited and is clean: no duplicate titles or
descriptions, every page canonical and `lang`-tagged, one `h1` each, no missing
alt text, 700–1,200 unique words per page, FAQPage + BreadcrumbList +
SoftwareApplication schema, robots.txt permissive and naming the agents
explicitly. There is no technical fault left to find.

"Discovered – currently not indexed" at this ratio, on a technically clean site,
is Google saying the domain has not earned the crawl. **Bing said the same thing
independently the day before**: "Your site does not have enough inbound links
from high quality domains." Two engines, one diagnosis, and it is the one thing
that cannot be fixed from inside the repo.

The one technical item still outstanding that bears on it is the **www duplicate
host** — every page currently exists on two hostnames with no redirect, which
splits whatever crawl signal there is. It will not by itself index 61 pages, but
it is the only remaining on-site contributor, and it is a five-minute Cloudflare
rule.

### What this settles

**§4 is not deprioritised, it is closed.** The 48 over-length titles are a real
truncation and it does not matter: you cannot improve the click-through rate of
a result that is never served. Revisit only if indexing moves.

**The AI-assistant channel is not a side bet or a hedge — it is the business.**
Google sends about 30 clicks a week, 86% of them from people who already knew
the name. ChatGPT sends 819 sessions a week to people who did not. The channel
that works is precisely the one that does not need Google's index, because
assistants crawl directly and read `llms.txt` rather than waiting to be ranked.
That is why §3 deserves the effort §4 was getting.

### Bing Webmaster Tools, same day

Two recommendations showing. "Some of your important new pages are missing from
your sitemaps" is real and diagnosed: Bing last crawled `sitemap.xml` on 18 Aug
and recorded 55 URLs; the live file has 63, and the eight new ones all shipped
5–6 Sep. **IndexNow last ran 6 Sep.** Run `node tools/indexnow.js` after the next
deploy and the gap closes.

The second, "not enough inbound links from high quality domains", is off-site and
has no repo-side fix.

Also found, and not flagged by Bing: **`www.audiosaw.com` serves the whole site
at HTTP 200 with no redirect to the apex**, and Bing is tracking a second sitemap
there (45 URLs, last crawled 21 Jun). Canonicals on the www copy do point at the
apex, so this is diluted crawl budget rather than duplicate content proper.
`_redirects` cannot fix it — Cloudflare Pages matches paths, not hostnames — so
it needs a Redirect Rule: match `http.host eq "www.audiosaw.com"`, 301 to
`concat("https://audiosaw.com", http.request.uri.path)`, dynamic rather than
static or every URL lands on the homepage.

Site Scan has never been run on the property. Worth starting once the rails are
live, so its first crawl sees the new homepage.

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
4. `node tools/indexnow.js` once the deploy is live. **Every deploy, not when
   you remember** — it was last run on 6 Sep, and by 21 Sep that had become a
   live error in Bing Webmaster Tools: eight pages shipped 5–6 Sep that Bing's
   copy of the sitemap did not know about. The gap is silent; nothing warns you.
5. Google gets nothing from IndexNow. For the retitled pages, the sitemap plus
   the `lastmod` bump is the mechanism; expect ~10 days before CTR moves.

## What is unproven

The title rewrite is a real bet on a real mechanism, but it is a bet. It moves
CTR at unchanged rank or it does nothing; the failure mode is a modifier that
does not match intent. Give it ten days of Search Console data at the same
average position before judging, and compare CTR rather than clicks — clicks
will move for reasons that have nothing to do with the titles.

## §10 — The 1,000-a-day plan (22 Sep 2026)

Baseline, read from GA4 "Audio Saw" on 22 Sep (last 7 days = 15–21 Sep):

| | |
|---|---|
| Users, last 7 days | ~800 (≈ **115 / day**) |
| Active users, last 30 days | 2.3K, +620% on the previous 30 |
| Sessions, last 7 days | 1,156 |
| AI Assistant (chatgpt.com) | 719 sessions, **62%** |
| Direct | 187 |
| Organic search (google 81, bing 47, ddg 5) | 142 |
| pwa / standalone | 8 |
| Top pages | / 355, /voice-recorder 320, /stem-splitter 256, /split-audio 141, /mp3-tag-editor 87, /noise-reduction 71, /pitch-shifter 40 |

Target is ~8.5×. That is new demand, not tuning. Three engines:

| Engine | Lever | Who |
|---|---|---|
| **A. AI assistants** (62%) | more distinctive tools, each with a liftable `llms.txt` answer; presence in Perplexity / Claude (Brave) / Gemini (Google) / Copilot (Bing) indexes | repo |
| **B. Get indexed** (2 of 63) | inbound links — public repo, Product Hunt, Show HN, Reddit, AlternativeTo; www→apex 301; Request Indexing; IndexNow every deploy | repo prepares, Andrew posts |
| **C. Keep what arrives** | fix the top `error_type`s once data lands (~28 Sep); judge the PWA 5 Oct; the handoff chain | repo |

Decisions taken 22 Sep: the repo goes public under **AGPL-3.0** (vendored
libraries keep their own licences; the ffmpeg core is a GPL build because of
libx264); Andrew posts the launches from a kit in `docs/launch/`; pushes and
console actions (Request indexing, Bing Site Scan, GA4 dimensions) no longer
wait for a go-ahead.

Two things checked and dropped: `HowTo` schema on the 41 pages without it —
Google retired HowTo rich results in 2023, so it is markup for nobody — and
the §4 titles, closed above.

### Milestones (users/day, 7-day average)

| | Target | By | Disproved if |
|---|---|---|---|
| M1 | 200 | ~15 Oct | the new pages get no assistant referrals in their first 3 weeks (Landing page × session source) |
| M2 | 400 | ~15 Nov | Search Console indexed count is still under 10 four weeks after the links exist |
| M3 | 1,000 | no date | re-planned at M2 on real numbers; needs assistant referrals across ~10 distinctive tools *and* long-tail Google traffic to the converters |

A launch day can spike 5–20K visitors. That is not the 1,000; the links it
leaves behind are.

### Build order

1. `/slowed-reverb` + `/nightcore` (reuse `pitchShiftSpeed` from `audio-speed.js`; synthesised IR through a ConvolverNode, rendered offline).
2. `/record-computer-audio` — `getDisplayMedia` tab audio; Chrome/Edge only and the page says so.
3. `/8d-audio` + `/bass-booster` — the booster must differ in substance from `/audio-eq` (a limiter stage, not a fixed pull-down) or it is the duplicate-content failure again.
4. `/audio-to-text` — Whisper via transformers.js on the `/stem-splitter` pattern. Spike first; go/no-go is ≥ 2× realtime on 7-thread WASM. This is the highest-ceiling page on the list: the site currently answers "transcribe without uploading" by sending people away.

Every page: 800+ real words, `<details>` FAQ, graph entry, one rail, an
`llms.txt` paragraph that states the limitation, `?v=` and `Q` bumped,
`check-all.js` green, a real file through it in a browser before the push.

### Weekly read

GA4 Home cards (source/medium, pages), Search Console Pages (indexed count),
Bing WMT (indexed count, Site Scan). Update the milestone table here. A bet
that misses its "disproved if" line gets dropped, not defended.
