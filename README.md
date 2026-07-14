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

Every tweet is scored by three signals, blended with fixed hand-set weights — no learned
weights, every knob legible:

`score = 0.5·taste + 0.3·rubric + 0.2·author` (each z-scored, winsorized at ±2)

- **Taste (0.5)** — how similar the tweet's text is to the ~2,900 tweets I've liked (TF-IDF
  cosine). Length-normalized, so a tweet can't buy score by being long.
- **Rubric (0.3)** — an LLM reads the tweet and grades it 0–10 against `RUBRIC.md`, a short
  written description of what I want more of. It sees only the text — no author, no like
  counts — so "high quality" can't quietly become "already famous". Runs on the local `claude`
  CLI; if scoring fails, tweets rank neutral instead of blocking the digest.
- **Author prior (0.2)** — how often I've actually engaged with this author before. Computed
  from behavior only, never from my votes — those are reserved for grading rankers (below).

Two adjustments after the blend:

- **Explore lane** — ~10% of every digest is tweets the ranker did *not* choose, so the feed
  never becomes an echo of itself. My votes on these cards double as a blind-spot audit: labels
  on exactly the cards the ranker rejected (not an unbiased sample — but the one read the
  ranker can't flatter).
- **Diversity pass (MMR)** — near-duplicate takes get penalized, so the top of the digest
  isn't five versions of the same story.

Tweet length, media, and thread-ness are treated as **confounders**: regressed out during any
training, never used as reward. A tweet can't earn rank for being long or having a picture.

## How it grades itself

Three layers, ground truth up: my hand votes are the only ground truth, an **offline gate**
screens rankers, and a **live A/B test** inside the daily digest picks winners. One rule holds
everywhere: keyword scores and LLM scores may *rank* tweets, but only my 👍/👎 votes may
*judge* rankers — anything else would be a model grading its own homework.

**The offline gate** (`npm run eval`) asks one question: take every pair of tweets where I
voted 👍 on one and 👎 on the other — how often does the ranker put the 👍 tweet higher? That
fraction is the AUC below: 0.5 is a coin flip, 1.0 is perfect. A ranker passes only if it
beats the **strongest** dumb baseline by a margin the bootstrap confidence interval says is
real; an interval containing zero is a tie, not a win.

The gate is also **prospective**. Every vote cast up to 2026-07-14 is a *development* pool:
I changed the metric, the credit formula, and the baseline policy while looking at those
votes, so no confidence interval on them accounts for my own choices. They print as an
advisory regression read; only votes cast after the freeze can ever say SHIP.

```
▼ REVIEW-DEV (all hand-signed 👍 vs 👎) — ADVISORY, NEVER A VERDICT  (290 👍 × 535 👎)
model                            AUC  Δ vs base CI
char_len (strongest baseline) 0.6930
keyword (lexicon)             0.6380  [-0.095, -0.014] *
rubric (LLM judge)            0.7095  [-0.026, +0.057]     718/825 scored
mix (M9 digest blend)         0.7090  [-0.019, +0.047]

⏳ INCONCLUSIVE — only 0 post-cutoff labels. The prospective gate is accumulating;
   pre-cutoff votes are dev-only and can never verdict.
```

Reading it honestly: on the dev pool, `mix` is statistically **tied** with `char_len` —
ranking by sheer tweet length. That's why length is a confounder control, why the reference is
the strongest baseline rather than the flattering one, and why the verdict now waits for votes
the gate's design has never seen.

**The live A/B** (`npm run interleave`) is the deciding vote. Every morning's digest is
secretly drafted by two rankers taking turns, like picking teams — the UI is identical either
way, and nothing reveals which ranker picked which card. A ranker earns credit when I open or
👍 its picks, and loses credit when I 👎 them.

The first three weeks were a **pilot** — the credit formula changed mid-flight, so its numbers
tune the instrument, they don't rank the rankers. Final pilot read: TIED at n=83 judged events
(keyword − mix CI [-0.096, 0.156]). The confirmatory window opened 2026-07-15 with everything
frozen — matchup, credit formula, floor — and one rule against fooling myself: the CI prints
**once**, at a predeclared 14-day horizon. No peeking, no "run until it's significant".

Three smaller instruments run alongside:

- **Judge calibration** — every edit to `RUBRIC.md` is scored on whether the LLM's grades
  moved closer to my votes (0.687 → 0.724 after personalizing it). Observe-only: tuning the
  rubric against this table would make the judge grade itself.
- **Scorecard** — junk among the *judged* top-10 cards each day, with vote coverage printed
  beside it (51.5% of 33 judged so far). An earlier version divided by all serves, so a day I
  didn't vote read as 0% junk — quality "improving" because I stopped grading. Now a no-vote
  day reads "no votes", never 0%.
- **Recall probe** — tweets I organically liked that the digest never showed me first: the
  detector for what the system *misses*, not just what it mis-ranks.

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
- The A/B keyed opens to a tweet's *first* drafting arm but votes to its *latest* — a
  cross-arm re-serve could put an arm's numerator on one ranker and its denominator on
  another. First-serve keying everywhere now; caught by an external review before it bit.
- ~800 votes accumulated while I changed the metric, the credit formula, and the baseline
  policy. "Never trained on" is not "never looked at" — those votes are a dev set now, and
  the verdict waits for votes cast after the freeze.

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
| Tests | vitest + `node:test` | 38 + 113 green |
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
