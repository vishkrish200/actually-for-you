# actually-for-you

**A single-user re-ranker for the X (Twitter) timeline.** A Chrome extension quietly captures how
I actually read my feed — dwell time, detail-opens, likes, bookmarks — and a local pipeline uses
those signals to re-rank the same tweets by *my* revealed taste instead of X's engagement-maximizing
algorithm. It delivers a calibrated daily digest to my phone.

> The most interesting part isn't the model. It's the **eval gate that told me not to ship my
> model** — and why listening to it was the right call. More on that below.

---

## Demo

![The digest reader — tweets re-ranked by taste-match to my likes, with time-window tabs](docs/demo.gif)

_The digest reader: every tweet carries a **✦ taste-match %** (cosine similarity to my ~2,900
likes), with All / 7-day / 48h windows. Ranked by me, not the algorithm._

---

## Why

X optimizes for *its* objective (time-on-site, ads), not mine. I wanted a feed ranked by what I
actually engage with thoughtfully — long dwells, opened threads, saved posts — with an `explore`
lane so it never collapses into a filter bubble. Single-user by design: no accounts, no cloud, my
data never leaves my machine.

## How it works

```
  x.com  ─────────────►  Chrome extension (MV3)  ─────────►  local ingest server  ──►  SQLite
          scroll/read      · network hook (GraphQL)            (Node, node:sqlite,      (append-only
                           · dwell state machine                zero deps)               raw events)
                           · IndexedDB durable queue                    │
                                                                        ▼
                                              labels ──► ranker ──► digest ──► 8am iMessage
                                           (re-derived   (lanes +   (taste-match   (launchd)
                                            from raw)     MMR)       to your likes)
```

- **Capture** (`extension/`) — a content script + a `MAIN`-world network hook. It intercepts X's
  GraphQL timeline responses and walks the nested tweet shape; a separate `IntersectionObserver`
  state machine tracks dwell/opens/engagements. The two streams have independent failure boundaries
  so a capture bug in one never silently takes down the other.
- **Ingest** (`ingest/server.ts`) — an HTTP server on `:2727`, append-only writes to SQLite via
  Node's built-in `node:sqlite`. **Zero runtime dependencies.** Raw events are immutable; every
  label is *re-derived* from them, never edited in place.
- **Rank** (`ingest/ranker.ts`, `digest.ts`) — a lane-based scorer (bookmark / liked-author / fresh
  / backlog / resurface / **explore**) with MMR for diversity, plus a taste-profile digest that
  scores tweets by TF-IDF cosine similarity to my ~2,900 liked tweets.
- **Deliver** (`ingest/daily.ts`) — a launchd job texts a daily digest link at 8am. The server
  auto-starts at login, so the whole thing runs hands-off.

## The hard parts (what I'd talk about in an interview)

**1. Reverse-engineering X's capture surface.** X is a hostile capture target and it fights you in
specific ways:
- GraphQL operations must be matched by **operation name**, never the numeric query ID (it rotates).
- DOM selectors anchor on `data-testid`, never CSS classes (obfuscated, high-churn).
- The timeline **virtualizes** — nodes are recycled as you scroll — so dwell must accumulate by
  `tweet_id`, never by DOM element, or you cross-attribute reading time.
- MV3 service workers are **ephemeral**, so all durable state lives in IndexedDB, drained on a
  natural session boundary.

**2. Bugs I caught by tracing, not guessing.** A few that made the notebook:
- Capture silently stopped. Root cause: a malformed diagnostic (`capture_health`) row with an
  unbindable field was throwing *inside the write transaction* and rolling back the real data with
  it — a diagnostic stream taking down the payload it was meant to observe. Found it by adding
  freshness telemetry and logging the swallowed exception, not by staring at code.
- Dwell timers leaked minutes when fast-scrolling dropped the exit event; caught it via *identical
  dwell values shared across distinct tweets* (several leaked timers draining at once on tab-blur).
  Fixed with a per-interval cap.

**3. The eval that said "don't ship."** This is the part I'm proudest of. I built a learned ranker
(logistic regression, hashing-trick bag-of-words) and an offline replay harness as the ship gate:
it only ships if it beats a simple keyword baseline on held-out data.

It didn't. So I didn't ship it — and the harness itself is the deliverable:

- **First "SHIP ✅" was a lie.** The random baseline scored a *perfect* 1.0 — the tweet IDs are
  time-ordered snowflakes, so any function of the ID leaked the label. Fixed with a
  label-independent shuffle.
- **The gate was saturated.** After a time-split the "same-era" test pool was ~86% positive, so
  NDCG@10 was maxed out under *any* scoring — `random` and `char_len` both hit 1.0. The metric
  wasn't measuring anything. I balanced the pool 50/50 so `random → ~0.5` and the gate could
  actually discriminate.
- **On a fair gate, the model honestly loses:** keyword baseline MAP **0.735** vs learned model
  **0.559**. And `char_len` alone (0.732) nearly matches keyword — a tell that the baseline is
  near-circular (my labels were curated partly *by* those keywords). Chasing a model to beat a
  circular baseline is the wrong move, so I stopped. **HOLD is the gate working, not a failure.**

The confounder discipline is baked in: `char_len` / `media_present` are **controls** — included in
training to absorb confounding, then zeroed at predict so tweet length can never *earn* score.

## Deliberately out of scope

Naming what I chose *not* to build:
- **Multi-user / cloud deploy.** It scrapes a private GraphQL surface keyed to one person's
  behavior; multi-tenant is a ToS and privacy minefield that adds no engineering value here.
- **A discovery engine.** This re-ranks tweets I've *seen*, by design — a re-ranker, not a
  recommender for unseen content.
- **Shipping a learned ranker.** The honest eval says the keyword/similarity baseline wins today;
  the learned model waits for denser behavioral data.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Extension | WXT / MV3, TypeScript | HMR + content-script bundling, no hand-rolled build |
| Ingest | Node + `node:sqlite` | built-in SQLite, **zero runtime deps**, no native compile |
| Ranker | Pure TypeScript | logistic regression + TF-IDF, no ML framework |
| Tests | vitest + `node:test` | golden DOM fixtures, dwell state machine, eval metric fixtures |
| Scheduling | macOS launchd | native, no cron daemon, survives reboot |

## Status

M0–M4 shipped (capture → ingest → read loop → ranker v0). Digest and daily delivery shipped.
Learned ranker v1 built, evaluated, and **held** on an honest gate. ~25k tweets / 35k impressions
captured and counting. Full build log in [`PROGRESS.md`](./PROGRESS.md); the spec is
[`PRD.md`](./PRD.md).
