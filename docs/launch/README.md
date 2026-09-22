# The launch kit

Everything needed to post AudioSaw in the places that leave a link behind.
Copy and paste; nothing here needs rewriting first.

## Why this exists

Search Console has indexed **2 of 63 pages**. The other 61 all read "Discovered
– currently not indexed", which on a technically clean site means Google has
found every page and decided the domain has not earned the crawl. Bing said the
same thing in plain words the day before: *not enough inbound links from high
quality domains.*

That is the one constraint on this site that cannot be fixed from inside the
repo, and it gates the entire search channel. AI assistants already send five
times what every search engine combined does, precisely because they crawl
directly and do not wait to be ranked.

**The spike is not the point.** A Show HN or a Product Hunt day can send 5,000
to 20,000 visitors and then stop. The links it leaves — on news.ycombinator.com,
producthunt.com, alternativeto.net, and on whoever writes it up — are what move
the indexing number, and they keep working.

## Order and spacing

One per week, so each gets its own day and its own audience. Suggested:

| Week | What | Prerequisite |
|---|---|---|
| 1 | Make the repo public | `README.md` and `LICENSE` are already committed |
| 2 | [Show HN](show-hn.md) | repo public — HN will look |
| 3 | [Product Hunt](product-hunt.md) | screenshots from the gallery brief |
| 4 | [Directories](directories.md) | none; can be done any time, in parallel |
| 5+ | [Reddit](reddit.md) | answer threads as they come up, not on a schedule |

Do the directories early if you want something running in the background —
they are the lowest effort and several of them are followed links.

## Before any of it

- [ ] Repo is public at `github.com/andrewnakas/audiosaw`
- [ ] `https://www.audiosaw.com` 301s to the apex (Cloudflare redirect rule,
      **dynamic**: `concat("https://audiosaw.com", http.request.uri.path)` —
      a static rule sends every URL to the homepage)
- [ ] `node tools/indexnow.js` has been run since the last deploy
- [ ] The site works in a private window on a phone

## After each one

Add the resulting URL to `sameAs` in the homepage `Organization` block in
`index.html`, so the entity graph connects. Then note the date here:

| Channel | Posted | URL |
|---|---|---|
| GitHub public | | |
| Show HN | | |
| Product Hunt | | |
| AlternativeTo | | |
| Reddit | | |
