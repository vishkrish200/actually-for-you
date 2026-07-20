# M15 spec — chronological List polling + wake catch-up

> **PIVOT (2026-07-18, as built):** the user rejected the List (manual creation/maintenance).
> Shipped design instead: **For You home stays the primary poll target** (steady-state ticks are
> byte-for-byte M7, no autoscroll — the watermark stop rule assumes time order); a tick waking
> from a **>1h gap** opens the chronological catch-up surface
> `x.com/search?q=filter%3Afollows&f=live` (user-verified on-account; account-relative, so
> nothing to configure — `AFY_POLL_LIST_ID` was removed) and autoscrolls to the watermark.
> Policy is pure (`catchupPlan` in poll-source.ts). Everything below stands except the List
> prereq/config sections; the autoscroll mechanics, invariants, ban-surface note, and success
> metrics are unchanged. Known ceiling: search excludes native RTs by default — append
> `include:nativeretweets` to the query once verified on-account.

## Problem (measured 2026-07-17, 25 days of afy.db)

Overnight-posted tweets DO get captured (~80% of the alive-hour rate: 89.7/h vs 113.4/h)
but arrive too late: only 38% within 2h of wake, median 4.1h after wake, median 8.1h old.
Overnight (22:00–01:00 IST = US daytime) is the *peak* posting window, and the digest is
read right after wake — so the freshest, densest supply misses the morning read and shows
up a day stale. Root cause: the M7 poller loads `x.com/home` (For You), which trickles
backlog out over hours and dedupes what the phone already consumed.

Loss is secondary to latency, but the ~20% rate deficit is a lower bound (never-captured
tweets are invisible; overnight supply is peak, so true loss is likely somewhat larger).

## Change (two parts, extension-only)

1. **Poller target**: For You home → a private X **List** timeline
   (`https://x.com/i/lists/<id>`, GraphQL op `ListLatestTweetsTimeline`). Chronological,
   stable URL, and reading it does not touch the For You serve-state the phone shares.
2. **Watermark autoscroll**: in poller mode the content script scrolls until it has seen
   tweets older than the last poll tick, so the first tick after a sleep gap pulls the
   whole backlog in one tab-life. Regular 30-min ticks hit the watermark in 1–2 loads.

## What does NOT change (M7 invariants hold by construction)

- GraphQL hook: already op-agnostic (`TIMELINE_OP_PATTERNS = /\/graphql\//`,
  `network-hook.ts:8`) — List responses are captured with zero hook changes.
- Manifest: content script already matches `x.com/*`, which covers `/i/lists/`.
- `source:'poll'` tagging + zero impressions: keyed on poller **tab id**, not URL
  (`poll-source.ts` untouched). Server precedence `net > dom > poll` unchanged.
- Digest, labels, eval: untouched. Polled tweets stay candidates-only.

## Prereq (manual, one-time)

Create a **private** X List (e.g. "afy-poll") and add follows — at minimum the authors
you actually engage with. Private lists don't notify members. Drift accepted: top up
occasionally; authors missing from the list degrade to today's behavior (organic + For You
capture still run).

## Config

`AFY_POLL_LIST_ID` in the extension build env, baked by `build.sh` exactly like
`AFY_TOKEN`. Unset/empty → poller uses `x.com/home` as today (safe rollout AND rollback).

## background/index.ts

- `POLLER_HOME` becomes computed: list URL if an id was baked, else `x.com/home`.
- At each tick start, store `lastPollTickTs` in `chrome.storage.local` (**local**, not
  session — it must survive browser restarts to size the overnight gap).
- The existing "am I the poller?" handshake response gains `scrollUntil =
  lastPollTickTs − 15 min` slack (first-ever tick: `now − 24h` cap).
- `TAB_LIFE_MIN` 2 → 4: a full overnight catch-up is ~40 timeline fetches at human scroll
  pace (~2.5 s/scroll ≈ 100 s) plus page load. Regular ticks stop scrolling early on the
  watermark and just idle until the close alarm — idle tab-minutes are free.

## content script (poller mode only)

- If `isPoller && scrollUntil`: autoscroll loop — `scrollBy` one viewport every ~2.5 s
  until STOP or tab close.
- **STOP rule** (pure function, unit-tested): stop after **3 consecutive** rendered
  tweets whose `<time datetime>` is older than `scrollUntil`. Consecutive-3 guards
  against retweets, which render the *original* tweet's (possibly old) timestamp inside
  an otherwise-fresh chronological stream. Hard cap: 40 scrolls.
- Timestamps read from the semantic `<time>` element (not CSS classes — PRD §5 anchor
  rule). If 3 consecutive scrolls surface zero `<time>` elements: emit `capture_health`
  and stop — never spin blind.
- Everything else in poller mode is unchanged: impressions dropped, tweets tagged `poll`.

## Ban-surface note

~48 ticks/day × 1–2 fetches + ~1 deep catch-up × ≤40 fetches ≈ 130 list-timeline
fetches/day — the volume of a human reading a list, in the user's own logged-in browser,
via the page's own fetches (no forged API calls, no query-ID handling). Strictly less
suspicious than the status quo plus it stops polluting For You state.

## Rejected alternatives

- **Click the "Following" tab on /home**: no stable URL; the tab choice is server-sticky
  and shared with the phone session; adds DOM automation for navigation.
- **Cloud scraper**: captures zero behavior by construction; logged-in automation from a
  datacenter IP is the max-ban-risk way to touch the only account the project has;
  `afy.db` leaves the machine.
- **Prevent laptop sleep**: battery/thermal cost for a 2-min-per-30-min need.

## Verification (no done without proof)

1. vitest: STOP-rule pure function — consecutive counting, retweet-timestamp fake-out,
   scroll cap, page with no `<time>` elements.
2. Existing `poll-source.test.ts` green, untouched.
3. Dogfood: sleep the laptop overnight, wake, then assert via sqlite that
   `source='poll'` tweets with `created_at` inside the gap land within ~5 min of wake.
4. After a week, re-run the gap analysis (`notes/gap-analysis.ts`, run with
   `node --experimental-strip-types` from `ingest/`).
   Success = **%-captured-within-2h-of-wake: 38% → >80%** and
   **median lag-past-wake: 4.1h → <0.5h** for dead-window posts.
   (Age-at-capture barely moves by definition — a 1am tweet captured at a 10am wake is
   9h old no matter what; lag-past-wake is the metric this change controls.)
