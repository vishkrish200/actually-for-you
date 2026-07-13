# actually-for-you

**A single-user re-ranker for the X (Twitter) timeline.** A Chrome extension captures how I
actually read my feed — dwell, detail-opens, likes, bookmarks — and a local pipeline ranks
tweets by my revealed taste instead of X's engagement-maximizing algorithm. Every morning at
8am it texts me a digest; every digest secretly runs a blind A/B between two rankers; the whole
system grades itself against my hand votes. No accounts, no cloud, no API keys, zero runtime
dependencies on the server. My data never leaves my machine.

![The digest reader — tweets re-ranked by taste-match to my likes](docs/demo.gif)

_Every card carries a **✦ score** (taste + LLM rubric + author prior); in-flow 👍/👎 votes are
the eval's gold labels. Two rankers are secretly interleaved in every slate._

## Why

X optimizes for its objective (time-on-site, ads), not mine. I wanted a feed ranked by what I
engage with thoughtfully, with a permanent `explore` lane so it never collapses into a filter
bubble. Single-user by design — the interesting problems (honest capture, honest labels, honest
evals) don't need multi-tenant.

## Architecture

![Architecture: x.com → extension → ingest → mix ranker → interleaved digest → 8am iMessage, with votes feeding an eval stack that gates the ranker](docs/architecture.png)

**The sensor** (`extension/`) — X is a hostile capture surface; the extension is built around
how it fights back. Content (a `MAIN`-world GraphQL hook) and behavior (an
`IntersectionObserver` dwell machine) run in independent failure boundaries, with
`capture_health` events so breakage is loud. GraphQL ops matched by name (IDs rotate);
selectors anchored on `data-testid` (classes churn); dwell keyed by `tweet_id` (X recycles DOM
nodes); engagement read from the button's `data-testid` flip, not clicks (keyboard shortcuts
count). MV3 workers are ephemeral, so durable state lives in an IndexedDB queue. A background
tab polls `x.com/home` every 30 minutes through the same path — those tweets are **candidates
only**, never behavioral labels.

**The pipeline** (`ingest/`) — an HTTP server on `:2727`, Node's built-in `node:sqlite`,
token-authed writes. Raw events are append-only; labels re-derive from them, never edit in
place. Every serve logs its rank, lane, drafting arm, and score parts; opens and votes flow
back. What I read today is tomorrow's eval data.

## Ranking signals

Score = `0.5·z(taste) + 0.3·z(rubric) + 0.2·z(author)`, winsorized at ±2:

| Signal | What it is | Guardrail |
|---|---|---|
| **Taste** | TF-IDF cosine to ~2,900 curated likes | Length-normalized — long tweets can't buy score |
| **Rubric** | LLM grades each tweet 0–10 vs my `RUBRIC.md`, via local `claude` CLI headless | Text-only (no author/metrics); CLI missing → skip loudly, rank neutral |
| **Author prior** | Per-author rate from engagement history | Never from hand votes — those are eval-only gold |
| **Explore lane** | ~10% sampled from tweets the ranker did *not* pick | Anti-filter-bubble + serve-bias-free audit pool |
| **MMR** | Token-overlap penalty at assembly | Near-duplicates don't cluster |
| **Confounder controls** | `char_len`, `media_present`, `is_thread` | Regressed in training, dropped at predict — never rewards |

## How it grades itself

Hand-signed 👍/👎 are the **only** gold labels; keyword and LLM scores may rank but never
label; nothing trains on reviews; the explore lane audits for serve bias.

**Offline gate** (`npm run eval`) — pairwise preference accuracy: AUC = P[score(👍) >
score(👎)] over every hand-signed pair, no balancing, no split. A ranker clears only by beating
keyword with a paired-bootstrap CI excluding zero — a straddle is a TIE, not a win. As of this
write-up:

```
▼ NON-CIRCULAR SHIP GATE  (233 👍 × 358 👎 = 83,414 pairs)
model                            AUC  Δ vs keyword CI
random                        0.4995  [-0.194, -0.064] *
char_len                      0.6796  [+0.006, +0.098] *
keyword (baseline to beat)    0.6282
rubric (LLM judge)            0.6784  [-0.006, +0.107]   483/591 scored
taste (digest cosine)         0.6540  [-0.035, +0.086]
mix (M9 digest blend)         0.6959  [+0.011, +0.123] *

SHIP ✅  mix beats keyword on all-pairs AUC with a diff CI excluding 0.
```

The shipped blend clears; the rubric hovers just short *with its coverage printed beside it* —
a starved judge can't pose as a confident one. Even tweet-*length* beats the keyword counter,
which is exactly why `char_len` is a confounder control and keyword is a baseline, not a champion.

**Online interleave** (`npm run interleave`) — the verdict-maker. Two rankers team-draft every
slate (seeded draft, pixel-identical UI, arm logged per card); credit = opens + 👍 − 👎;
verdicts need a day-paired bootstrap CI past a judged-event floor. Current matchup:

```
TIED at n=36 judged events — the (keyword − mix) credit-rate CI [-0.077, 0.047] contains 0.
No ranker leads yet; keep serving.
```

A report that says "keep serving" instead of manufacturing a winner is the point.

Three more instruments, one line each: **judge calibration** — per-`RUBRIC.md`-version AUC vs
my votes (generic 0.687 → personalized 0.724; observe-only, never tune against it).
**Scorecard** — per-day junk@10: 72.7% on day one, 0% the last three days. **Recall probe** —
the miss detector: 23/23 organic engagements captured this week, none served by the digest
first (structural for now; the trend is the signal).

## Field notes

- A malformed `capture_health` diagnostic threw *inside the write transaction* and rolled back
  the data it existed to observe. Found by logging the swallowed exception, not reading code.
- Dropped IntersectionObserver exits leaked dwell timers — the tell was identical dwell values
  across distinct tweets, all draining on the same tab-blur. Fixed with a per-interval cap.
- X moved `screen_name` in its GraphQL shape; my fixture used the old shape, so tests stayed
  green while every captured handle came back empty. A green test on a stale fixture is worse
  than no test.
- The `claude` CLI ignores SIGTERM during API backoff — 120s timeouts minted 14-minute zombies
  and starved the judge. Fixed with a hard deadline + SIGKILL; coverage now prints beside every
  rubric verdict.
- The first ship gate (pooled MAP) rightly killed my learned ranker — after I caught a "random"
  baseline scoring 1.0 (snowflake IDs leak time) and a saturated 86%-positive pool. Later the
  gate itself became the suspect: it discarded ~20% of votes to balancing and silently credited
  keyword on the ~25% of pairs its integer scores can't order. The pairwise rebuild separated
  the arms on the same votes. The learned ranker stays retired by evidence; the confounder
  discipline it forced survives everywhere.

## Deliberately out of scope

**Multi-user/cloud** (private surface, one person's behavior), **a general recommender**
(candidates come only from my own logged-in surface), **bigger models** (LR, embeddings, and a
behavioral ranker each lost on a non-circular gate — the bottleneck is labels, not capacity).

## Stack

| Layer | Choice | Why |
|---|---|---|
| Extension | esbuild + MV3, TypeScript | 4-line build script; WXT removed once it earned nothing |
| Ingest | Node + `node:sqlite` | **zero runtime deps**, no native compile |
| Ranking | Pure TypeScript | TF-IDF + priors + weighted blend, no ML framework |
| LLM judge | local `claude` CLI, headless | no API key; degrades gracefully to neutral |
| Evals | AUC pair gate + team-draft interleave | offline guardrail, online verdict; seeded, reproducible |
| Tests | vitest + `node:test` | 38 + 98 green; golden fixtures, draft-determinism snapshots |
| Scheduling | macOS launchd | native, survives reboot |

## Running it

```sh
cd ingest && echo "AFY_TOKEN=$(openssl rand -hex 16)" > .env.local && npm start   # Node ≥22; reader at :2727
cd extension && ./build.sh    # bakes the token; then chrome://extensions → Load unpacked → dist/
npm test                      # in either package · npm run eval = the ship gate
```

The 8am delivery is a launchd plist calling `npm run daily`; `CLAUDE_BIN` in `.env.local`
points at the `claude` binary (optional — everything degrades without it).

## History

Thirteen milestones: capture → ingest → read loop → labels → the learned-ranker HOLD → daily
delivery → poller → LLM rubric → mix → serve telemetry → interleaving → the eval rebuild.
~63k tweets, ~88k impressions, ~600 hand votes. Build log: [`PROGRESS.md`](./PROGRESS.md) ·
spec: [`PRD.md`](./PRD.md) · the long story: [the blog post](./docs/blog-post.md).

## Inspirations

[noscroll](https://x.com/noscroll) and [backscroll](https://sdan.io/projects/backscroll) — the
two projects that seeded the idea of taking your own feed back.
