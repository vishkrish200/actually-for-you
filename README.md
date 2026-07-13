# actually-for-you

**A single-user re-ranker for the X (Twitter) timeline.** A Chrome extension captures how I
actually read — dwell, opens, likes, bookmarks — and a local pipeline re-ranks my feed by that
revealed taste. It texts me a digest at 8am; every digest secretly A/Bs two rankers; my hand
votes grade everything. One user, no cloud, no API keys, zero server dependencies — nothing
leaves my machine.

![The digest reader — tweets re-ranked by taste-match to my likes](docs/demo.gif)

_Every card: a **✦ score** (taste + LLM rubric + author prior) and 👍/👎 votes that become the
eval's gold labels. Two rankers are secretly interleaved in every slate._

## Why

X ranks for time-on-site. I want the feed ranked by what I actually read thoughtfully — with a
permanent `explore` lane so it never collapses into a filter bubble.

## Architecture

![Architecture: x.com → extension → ingest → mix ranker → interleaved digest → 8am iMessage, with votes feeding an eval stack that gates the ranker](docs/architecture.png)

**Sensor** (`extension/`) — built around how X fights capture:
- Content (GraphQL hook) and behavior (dwell machine) in **independent failure boundaries**;
  `capture_health` events make breakage loud.
- GraphQL matched by **operation name** (IDs rotate) · selectors on **`data-testid`** (classes
  churn) · dwell keyed by **`tweet_id`** (X recycles DOM nodes).
- Engagements read from **button-state flips**, not clicks — keyboard shortcuts count.
- Durable state in **IndexedDB** (MV3 workers die constantly).
- A 30-min **poller tab** feeds candidates through the same path — never behavioral labels.

**Pipeline** (`ingest/`) — Node + built-in `node:sqlite`, zero deps, token-authed writes.
Events are append-only; labels re-derive from raw. Every serve logs its rank, lane, and
drafting arm; votes and opens flow back. Today's reading is tomorrow's eval data.

## Ranking signals

`score = 0.5·z(taste) + 0.3·z(rubric) + 0.2·z(author)`, winsorized at ±2:

| Signal | What it is | Guardrail |
|---|---|---|
| **Taste** | TF-IDF cosine to ~2,900 curated likes | Length-normalized |
| **Rubric** | LLM grades tweets 0–10 vs my `RUBRIC.md` (local `claude` CLI) | Text-only — quality can't proxy fame; missing scores rank neutral |
| **Author prior** | Per-author engagement rate | From behavior only, never hand votes |
| **Explore lane** | ~10% the ranker did *not* pick | Anti-bubble + unbiased audit pool |
| **MMR** | Near-duplicate penalty | Takes don't cluster |
| **Confounders** | `char_len`, `media`, `is_thread` | Controls, never reward features |

## How it grades itself

Hand votes are the **only** gold labels. Keyword and LLM scores may rank, never label. Nothing
trains on reviews.

**Offline gate** (`npm run eval`) — one question: across every 👍/👎 pair, how often does the
ranker put the 👍 on top? A ranker clears only by beating keyword with a bootstrap CI that
excludes zero — a straddle is a TIE.

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

The shipped blend clears. The rubric hovers just short, its coverage printed beside it — a
starved judge can't pose as confident. Even tweet-*length* beats keyword, which is why
`char_len` is a control and keyword is a baseline, not a champion.

**Online interleave** (`npm run interleave`) — the verdict-maker. Two rankers team-draft every
slate, blind and pixel-identical; credit = opens + 👍 − 👎, and it goes negative.

```
TIED at n=36 judged events — the (keyword − mix) credit-rate CI [-0.077, 0.047] contains 0.
No ranker leads yet; keep serving.
```

A report that says "keep serving" instead of inventing a winner is the point.

**Also standing:** judge calibration — rubric edits scored against my votes, 0.687 → 0.724,
observe-only · scorecard — junk@10 per day, 72.7% → 0% in a week · recall probe — what I
engaged with that the digest never served first.

## Field notes

- A malformed diagnostic event rolled back the data it monitored — found by logging the
  swallowed exception, not reading code.
- Leaked dwell timers showed up as *identical* values across distinct tweets. Per-interval cap.
- X moved a field; the test fixture had the old shape. Green tests, empty handles. A green test
  on a stale fixture is worse than none.
- The `claude` CLI ignores SIGTERM during backoff — timeouts minted 14-min zombies. Hard
  deadline + SIGKILL; coverage now prints beside every verdict.
- The first gate rightly killed my learned model (after its own bugs: a "random" baseline
  scoring 1.0 off snowflake IDs, an 86%-positive pool). Later the gate itself went suspect —
  it was discarding votes and crediting keyword on un-orderable pairs. The pairwise rebuild
  separated the arms on the same votes.

## Deliberately out of scope

**Multi-user/cloud** (one person's private surface) · **general recommender** (candidates only
from my own timeline) · **bigger models** (each lost on a fair gate; the bottleneck is labels).

## Stack

| Layer | Choice | Why |
|---|---|---|
| Extension | esbuild + MV3, TypeScript | 4-line build; WXT removed once it earned nothing |
| Ingest | Node + `node:sqlite` | **zero runtime deps** |
| Ranking | Pure TypeScript | no ML framework |
| LLM judge | local `claude` CLI | no API key; degrades to neutral |
| Evals | AUC gate + interleave | offline guardrail, online verdict; seeded, reproducible |
| Tests | vitest + `node:test` | 38 + 98 green |
| Scheduling | macOS launchd | survives reboot |

## Running it

```sh
cd ingest && echo "AFY_TOKEN=$(openssl rand -hex 16)" > .env.local && npm start   # Node ≥22; reader at :2727
cd extension && ./build.sh    # bakes the token; chrome://extensions → Load unpacked → dist/
npm test                      # either package · npm run eval = the ship gate
```

8am delivery is a launchd plist running `npm run daily`. `CLAUDE_BIN` in `.env.local` points at
the `claude` binary (optional — everything degrades without it).

## History

Thirteen milestones: capture → ingest → read loop → labels → the learned-ranker HOLD → daily
delivery → poller → LLM rubric → mix → serve telemetry → interleaving → the eval rebuild.
~63k tweets, ~88k impressions, ~600 hand votes. [`PROGRESS.md`](./PROGRESS.md) ·
[`PRD.md`](./PRD.md) · [the blog post](./docs/blog-post.md).

## Inspirations

[noscroll](https://x.com/noscroll) and [backscroll](https://sdan.io/projects/backscroll) — the
two projects that seeded the idea of taking your own feed back.
