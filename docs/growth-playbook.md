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

### What shipped, and the one that did not (22 Sep)

`/slowed-reverb`, `/nightcore` and `/8d-audio`, plus an `fx` category and rail.
All three are the same shape: a Web Audio graph rendered offline, no codec
download, verified against measurement in a real browser before the copy was
written.

**`/bass-booster` was designed, built, measured and dropped.** The plan was a
low shelf plus a limiter, on the theory that `audio-eq.js` compensates for a
boost by pulling the whole signal down in proportion (`-maxBoost * 0.6 dB`), so
a +12 dB bass boost there hands back a file 7 dB quieter and the user
experiences it as "nothing happened". A limiter should have caught the peaks
instead and left the average alone.

It does not. Measured on a full-scale master, four limiter settings from gentle
(-1 dBFS, 4:1, 3 ms) to harsh (-3 dBFS, 20:1, 1 ms):

| Requested | 60 Hz | 1 kHz | bass-to-mid |
|---|---|---|---|
| +6 dB | +1.8 to +2.4 dB | −3.8 to −4.4 dB | **6.3 dB, every design** |
| +12 dB | +2.9 to +3.7 dB | −7.3 to −8.1 dB | **11.0 dB, every design** |

The bass-to-mid ratio is identical whatever the limiter does, because the work
is being done by the peak scaling afterwards, not by the limiter. You cannot
add 12 dB of bass to a full-scale master without either clipping or lowering
everything else; that is arithmetic, not an implementation choice. A dedicated
page would therefore have been `/audio-eq` with fewer controls, which is
precisely the duplicate-content failure CLAUDE.md records from the eight
templated pages Google indexed none of.

The one real finding worth keeping: `audio-eq.js` scales **unconditionally**,
so it quietens a file even when the boost would not have clipped. Conditional
scaling — pull down only on overshoot — is strictly better and is what the
three new pages do. Worth porting to `audio-eq.js` as a quality fix, not as a
new page.

## §11 — The Whisper spike (22 Sep 2026): go, with a pinned version

`/audio-to-text` is the highest-ceiling page on the list — "transcribe audio
free without uploading" is a question assistants field constantly, and the site
currently answers it by sending people *away*, to `/audio-for-whisper` and
`/audio-to-text-prep`, which only prepare a file for somebody else's tool.

Spiked before writing anything, on this machine (Apple GPU, 8 cores), against a
33.9 s speech clip with known ground truth. **It works, and comfortably.**

| Path | dtype | Time for 33.9 s | vs realtime |
|---|---|---|---|
| WebGPU | fp32 encoder + q4 decoder | 5.4 s | **0.16x** |
| WASM, 7 threads | q4 | 9.8 s | **0.29x** |

Both are several times faster than realtime, so a podcast episode is minutes
rather than an afternoon. Accuracy on the test clip was effectively perfect,
including "MDX-Net" and "ITU recommendation BS.1770". `return_timestamps` gives
per-chunk timings, so SRT and VTT are straightforward.

Unknowns that are now known:

- Cross-origin isolation, a module worker under COEP, and fetching the model
  from huggingface.co under `require-corp` **all work**. Model load is a one-off
  ~28 s cold and cached afterwards, the same deal as the 64 MB stem model.
- Threads work with the existing `/vendor/ort/*` COEP header pattern.

### The version pin, which is the whole finding

**transformers.js 4.3.0 cannot be hosted on Cloudflare Pages.** It requires
`ort-wasm-simd-threaded.asyncify.wasm` from ORT 1.31-dev, which is **26,861,777
bytes — over the 25 MiB per-file limit**. Removing it does not fall back to the
smaller JSPI build; the session fails outright.

Serving that one file from a CDN, the way `ffmpeg-core.wasm` already is, **does
not work here**: the page is cross-origin isolated, and jsDelivr's response is
rejected under `require-corp` with a bare network error. The ffmpeg precedent
does not transfer, because that core is loaded from pages that are *not*
isolated.

**Pin transformers.js 4.2.0**, which uses ORT 1.26-dev, where every file fits:

| File | Bytes | |
|---|---|---|
| `ort-wasm-simd-threaded.wasm` | 12,942,611 | fits |
| `ort-wasm-simd-threaded.jspi.wasm` | 14,555,814 | fits |
| `ort-wasm-simd-threaded.asyncify.wasm` | 23,567,050 | fits |
| `ort-wasm-simd-threaded.jsep.wasm` | 26,101,073 | fits, by 113 KB |

One catch found by testing rather than by reading: on 4.2.0 the **CPU path
fails on `q8`, `int8` and `fp16`** with `TransposeDQWeightsForMatMulNBits
Missing required scale` — an ORT 1.26 regression on that decoder export. `q4`
works. So the dtypes are not a preference: **q4 on WASM, fp32 encoder + q4
decoder on WebGPU.** Re-test both if the version is ever bumped.

Cost to carry: about 60 MB of vendored runtime, alongside the existing ORT 1.22
that `/stem-splitter` uses. They are different major versions and cannot be
shared.

## §12 — The 10,000-a-month read (1 Oct 2026)

Andrew's target: 10,000 users a month. Read from GA4 "Audio Saw" and Search
Console on 1 Oct:

| | |
|---|---|
| Active users, last 30 days | **3.3K** (+367%); new users 3.2K |
| Sessions, last 30 days | 4.9K (+391%) |
| Sessions by channel, last 7 days | AI Assistant ~1K, Organic 273 (+46%), Direct 218, Unassigned 158 |
| First-user source, last 7 days | chatgpt.com 681, direct 158, google 86, bing 62 (+72%), duckduckgo 16 |
| Views by page, last 7 days | / 429, **/audio-editor 406 (+652%)**, /voice-recorder 342, /stem-splitter 342, /split-audio 190, /mp3-tag-editor 111, /noise-reduction 74 |
| Countries, last 7 days | US 142, India 119, Iran 66, Brazil 45, Singapore 37, Japan 29 |
| Search Console | 407 clicks / 28 d, **343 of them "audiosaw"**; indexed 2 of 63 (report last updated 20 Sep) |

10K a month is ~3x where the site is. The diagnosis in §9 holds: Google is
still a navigational channel (people who were told the name by an
assistant), and assistants send the traffic. The editor's 6.5x week is the
clearest evidence yet that a distinctive tool gets picked up within days.

**Errors, now attributable** (28 days; the dimensions were registered 21 Sep,
so most rows are "(not set)"): 418 users hit `convert_error`. Of attributed
events: `other` 220 (86 users), `decode` 112 (36), `wrong_type` 68 (30),
`codec_load` 8. By tool: split-audio 91 events / 32 users, audio-editor 74 /
18, stem-splitter 56 / 27, voice-recorder 44 / 16, index 31 / 15,
audio-cutter 19 / 12. `other` being the largest bucket means the classifier,
not the data, was the gap.

**What shipped on 1 Oct:**

- `/audio-to-text`: Whisper in the browser (§11's spike, built). The highest-
  ceiling page on the list: "transcribe without uploading" is an assistant
  question the site used to answer by sending people elsewhere.
- `/record-computer-audio`: tab audio through `getDisplayMedia`, lossless.
- **llms.txt was wrong, not just stale.** Its "What can AudioSaw not do?"
  told assistants there was "no multitrack timeline, no mixing, no plugins and
  no project that you save" — all four false since 23 Sep — and the BPM answer
  said the site does not detect key, a week after /key-finder shipped. That is
  the file assistants quote. Rewritten, with new answers for the editor,
  transcription, key/chords, tuner/metronome and the slicer.
- Homepage jobs row re-derived from the week's views: the editor (the
  second-most-viewed page) was not in it at all.
- Error classification split so `other` stops hiding causes (see flow.js).

**Watch next:** Landing page × session source for /audio-to-text and
/audio-editor from chatgpt.com over the next two weeks; `error_type`
after the new buckets have a week of data; returning-user share on 5 Oct
(the PWA judgement, §5).

## §13 — Keyword targeting for the voice tools (2 Oct 2026)

Andrew asked for the voice pages to compete on head and long-tail keywords.
§9 still holds: Google indexes 2 of 63 pages and every non-brand query sits
at position 60–99, so head terms ("text to speech", "voice changer") are not
winnable until the domain earns links. The work was aimed at what is
winnable now: the long tail, and the assistant channel that does not wait
for Google.

**Method.** Google (`suggestqueries.google.com/complete/search?client=firefox`)
and Bing (`api.bing.com/osjson.aspx`) autocomplete for ~80 seeds, 1,367
unique suggestions, kept in the session only. Real demand, not guessed.
The same modifiers recur on every feature: free, online, no sign-up / no
login, unlimited / no limit / unlimited words, download MP3, commercial
use. The site meets all of them; the pages did not say so where it counts.

**One owner per intent** (so pages do not compete):

| Page | Head | Long tail |
|---|---|---|
| /text-to-speech | text to speech, AI voice generator, text to MP3 | free no sign-up, unlimited, download MP3, commercial use, Hindi/Spanish TTS, Kokoro TTS online |
| /voice-changer | voice changer for audio files | deep voice, male to female, chipmunk/robot, make voice deeper (in video) |
| /text-to-audiobook | EPUB/PDF to audiobook | EPUB to MP3, ebook to audiobook, PDF to audiobook, TXT to MP3 |
| /dictation | speech to text online, voice typing | voice to text, talk to text, online dictation |
| /audio-to-text | transcribe audio to text | MP3/video to text, transcribe interview, speaker identification, Whisper online |
| /video-dubbing | AI dubbing, AI video translator | translate video to English/Spanish, dub a video in another language free |
| /voice-cloning | voice cloning, clone my voice | free no sign-up, how much audio is needed, clone from audio file, open-source ElevenLabs alternative |

"Voice changer" alone means live apps (Discord, calls), which the site does
not do; "voice changer for recorded audio / audio file" is the winnable
form and is heavily suggested. "Dictation" alone is ambiguous (school
exercises, card games); "speech to text online" and "voice typing" are
the real heads.

**What shipped.** Titles ≤65 characters (Bing truncates past that) with the
modifiers; H1s with the head term instead of a slogan; keyword-bearing H2s
instead of "How it works"; FAQ entries phrased as the actual queries;
`alternateName` synonyms in the SoftwareApplication schema; tool-graph
titles (the anchor text of every footer, breadcrumb and related link) made
keyword-bearing; llms.txt answers for every voice tool, including "Is there
a free, open-source alternative to ElevenLabs?"; `next` edges into the voice
tools from the most viewed pages. Two product gaps the long tail exposed
were built rather than written around: **PDF to audiobook** and **video in,
video out on the voice changer**. Two stale claims were found on the way
(the audiobook page said "English only"; the diarization FAQ said 96%).

**Not done, and why.** No per-language TTS landing pages ("text to speech
Hindi" is large, and India is the #2 country): the site's eight swapped-
name pages were never indexed (§7), and a Hindi page would need to be
written in Hindi to be more than that. No "ElevenLabs alternative" page:
the answer lives in llms.txt and the cloning FAQ, where assistants read it.

**What moves the head terms is off-site:** links. The voice tools are the
most link-worthy thing the site has (voice cloning and dubbing running
entirely in a browser tab is a Show HN / r/LocalLLaMA / Hugging Face
community story). That, and the www→apex redirect (§9), are Andrew's.

## §14 — The growth read, and where it leaks (5 Oct 2026)

Andrew: "results look good — maximise the growth." Read from GA4 "Audio
Saw", Search Console and Bing on 5 Oct, week 27 Sep–3 Oct against 20–26 Sep.

| | This week | Last week |
|---|---|---|
| Sessions | **2,066** (+40%) | 1,474 |
| Active users / new | 1,463 / 1,391 (+44% / +46%) | 1,014 / 950 |
| AI Assistant sessions | 1,386 (+43%), 67% of all | 972 |
| Organic / Direct | 331 (+32%) / 300 (+70%) | 251 / 176 |
| chatgpt.com · google · bing | 1,393 · 168 · 101 | 1,014 · 136 · 78 |
| Users who started a tool / finished | 791 / 530 (**67%**) | 544 / 424 (78%) |
| convert_error events | 442 (+93%), 150 users | 229, 98 users |

28 days: 5,626 sessions, 3,815 from assistants. This week's 1,463 users is
about 6,300 a month: the 10K target of §12 is about 1.6x away.

**Assistants pick up a new page in about a day, if the job is common.**
ChatGPT landings this week: /voice-recorder 265, /stem-splitter 186,
**/audio-to-text 141** (shipped 1 Oct), /audio-editor 132, / 100,
/split-audio 87, **/text-to-speech 83** (shipped 2 Oct). Pages for
narrower jobs got nothing: /voice-cloning 1, /dictation and
/add-subtitles-to-video 0, /text-to-audiobook 6, /video-dubbing 13.
Same build quality, opposite results; the difference is how many people
ask an assistant for that job. So new pages should be chosen by how often
the task is asked for, not by how impressive the model is.

**The growth leaks after the click.** Completion fell from 78% to 67% as the
new AI pages took traffic. By users, this week:

| Page | Viewed | Started | Succeeded | Errored |
|---|---|---|---|---|
| /audio-to-text | 145 | 107 | 14 | 24 |
| /stem-splitter | 193 | 97 | 32 | 26 |
| /text-to-speech | 103 | 63 | 26 | 3 |
| /voice-recorder | 237 | 139 | 138 | 20 |
| /video-dubbing | 14 | 9 | 0 | 2 |

`error_type` since the 1 Oct buckets (1–4 Oct, 261 events, 104 users):
unsupported_api 71 (19 users), other 50 (28), wrong_type 35 (16), memory 29
(16), mic_denied 16, codec_load 14, decode 13. /audio-to-text alone: 96
events from 34 users — unsupported_api 52 (16), memory 18 (10), other 15 (6).
Its visitors are 43% phones (Android 47 users, iOS 38).

Two of those numbers were partly the instrument. /audio-to-text counted a
success only on a download, so copying the transcript looked like giving
up, and a failed model load posted two errors. /text-to-speech has the same
shape (success = download; listening in the page is not counted); left as
is, but read its rate as a floor.

**Retention (the §5 one-month judgement).** Of this week's 1,463 users,
1,391 were new: about 5% came back, and the installed app ("pwa" source)
opened 11 sessions (15 the week before). The PWA and recents work keeps
the people who return, but return visits are not where growth comes from;
nothing more is planned there.

**Search.** Google is unchanged: 470 clicks in 28 days, 401 of them
"audiosaw"; the indexing report still says 2 of 63 (and has not refreshed
since ~19 Sep). Bing is the search channel that works: clicks rose from about
8 a day in early September to 35 on 3 Oct, non-brand at positions 3–9
(flac to wav, autotune online, audio joiner, m4b to mp3, stereo to mono).
"how to remove background noise audio" has 1.1K impressions at 6.2 and no
clicks; /noise-reduction as a page, 1.3K and 0.4%. **Bing lists most pages as
www.audiosaw.com/…**: the missing www→apex 301 (§9, Andrew's) now visibly
splits the site's Bing presence.

**Shipped 5 Oct:**

- /audio-to-text: a model that fails to load for a non-network reason is
  retried once in a new worker on the plain CPU build, one thread, no
  WebGPU (ORT refuses every initWasm() after a failed one). Every iOS
  browser gets the WebKit build: CriOS/FxiOS slipped past the Safari test.
  Phones default to Whisper tiny. One failure, one error event. Copy counts
  as `convert_success` with `target_format: copy`. `?backend=wasm`.
- flow.js: ORT's "no available backend" wrapping an allocation failure is
  `memory`, not `unsupported_api`.
- /stem-splitter: browsers with no `navigator.gpu` at all were never shown
  an estimate (the cost was only set after an adapter probe). Past five
  minutes' estimate the page offers "just the first 30 seconds first",
  ticked by default past ten, and links the cutter and the instant vocal
  remover.
- **/mp3-to-mp4**: audio plus a picture into an MP4 for YouTube, Instagram
  and TikTok. The first page chosen by the rule above: putting audio on
  YouTube is a question people ask assistants every day, and the answers
  today are upload-and-watermark sites. A 4-minute 1080p video in ~20 s,
  by encoding two seconds of the still and looping it by stream copy.
- Bing descriptions for /noise-reduction and /audio-reverser now answer the
  query people type.

**Strategy from here, in order:**

1. **Conversion before acquisition.** Every visitor ChatGPT sends to a page
   that fails is a recommendation it may stop making. Re-read the funnel
   table above on ~12 Oct: /audio-to-text success users should be well over
   14 a week with copy counted and the retry in; /stem-splitter over 32.
   If /audio-to-text's `unsupported_api` persists, the next step is a
   coarse `error_detail` enumeration for the backend failures, registered
   as a dimension the same day.
2. **New pages for common jobs.** Pick by how often the task is asked for.
   Judge /mp3-to-mp4 by chatgpt.com landings in its first week, against
   /audio-to-text's 141 and /voice-cloning's 1.
3. **Bing, not Google, for search.** Descriptions that answer the query on
   pages at positions 5–9 with impressions and no clicks; IndexNow after
   every deploy.
4. **Done 5 Oct:** the www→apex 301 is live (Cloudflare Redirect Rule from
   the "Redirect from WWW to root" template, query string kept; the dashboard
   warns that www may not be proxied, which is wrong for this zone: www is
   served by Cloudflare and the rule matches). Journey by Mediavine ads went
   on the same day (CLAUDE.md, Analytics). **Andrew's one:** the
   launch kit (`docs/launch/`, still the only thing that can move Google's
   2 of 63). (`file_ext`, `target_format` and `pick_method` were registered
   on 5 Oct; data starts that day.)

## §15 — "Did the ads cost us?" and the next four pages (9–10 Oct 2026)

Andrew: "my numbers seemed to go down yesterday, is it the ads?" Read from GA4
"Audio Saw" on 9 Oct.

**It was GA4 processing, not visitors.** 8 Oct was still "mostly complete":
402 sessions, 291 of them with no source yet ("(not set)" 191, "(data not
available)" 100) and engaged sessions reading 100. Key events that day: 305,
against 205 the Wednesday before. Complete days tell the trend: 5–7 Oct had
1,259 users against 537 on 28–30 Sep (+134%), first visits +148%; 6 Oct
598 sessions, 7 Oct 555, both ~69% engaged. **Read a day only once GA4 stops
calling it partial (~48 h).**

Journey started filling around 6–8 Oct, so there was at most one complete
day with ads. What could be seen: a ~90 px bottom adhesion bar that sat on
the tool on a 690 px laptop screen, Journey's TCF CMP beside our banner in
Europe, and ~110 third-party requests per page. Completion fell from 78% to
61%, but mostly from the mix moving to the AI pages.

**Funnel by tool, Oct 2–7 (users started → succeeded / errored):**
text-to-speech 237 → 102 / 11 · audio-to-text 259 → 59 / 56 · stem-splitter
74 → 31 / 15 · voice-cloning 29 → 2 / 18 · video-dubbing 21 → 3 / 6 ·
text-to-audiobook 24 → 3 / 5 · voice-recorder 118 → 115.

**Shipped:**
- Ads off the homepage (Andrew's call); the tool now starts at ~340 px on
  a 690 px screen; one consent banner in Europe (check-consent).
- Instruments: `convert_start` was firing twice per click on the five voice
  pages (event counts halve from 9 Oct; users were always right); TTS counts
  a result heard to the end (`target_format: play`); audio-to-text errors
  carry their name and land in codec_load / codec_crash / too_long instead
  of `other`; voice-cloning checks for a GPU adapter before anyone waits.
- TTS starts on the 92 MB model, with instant pre-rendered voice samples.
- Four pages for jobs people ask assistants for every day:
  /add-audio-to-video, /remove-filler-words, /audio-to-sheet-music,
  /lyrics-from-song. Each was built to a measured check first.

**Re-read ~16 Oct:** completion by tool against the table above (TTS with
`play` counted; audio-to-text's error mix now that `other` is split; the
voice-cloning error count); homepage engagement time with ads off (was 52 s,
down from 1m16s); chatgpt.com landings on the four new pages in their first
week, against /audio-to-text's 141 and /voice-cloning's 1.
