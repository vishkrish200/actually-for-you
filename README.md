# actually-for-you

**A single-user re-ranker for the X (Twitter) timeline.** A Chrome extension quietly captures how
I actually read my feed — dwell time, detail-opens, likes, bookmarks — and a local pipeline uses
those signals to rank tweets by *my* revealed taste instead of X's engagement-maximizing
algorithm. It delivers a calibrated daily digest to my phone, runs a blind A/B between rankers
inside every slate it serves, and grades itself against my hand votes.

> The most interesting part isn't any model. It's the **eval stack** — the gate that told me not
> to ship my first model, and the later discovery that the gate itself had become the wrong
> instrument. Both stories below.

---

## Demo

![The digest reader — tweets re-ranked by taste-match to my likes, with time-window tabs](docs/demo.gif)

_The digest reader: every card carries a **✦ score** — a blend of taste-match to my ~2,900
curated likes, an LLM grade against my written rubric, and an author prior — with All / 7-day /
48h windows and in-flow 👍/👎 that feed the eval's gold labels. Two rankers are secretly
interleaved in every slate; nothing in the UI reveals which arm picked a card._

---

## Why

X optimizes for *its* objective (time-on-site, ads), not mine. I wanted a feed ranked by what I
actually engage with thoughtfully — long dwells, opened threads, saved posts — with an `explore`
lane so it never collapses into a filter bubble. Single-user by design: no accounts, no cloud, my
data never leaves my machine.

## How it works

```
 x.com ──────────► Chrome extension (MV3) ─────────► local ingest server ──► SQLite
  scroll/read       · GraphQL network hook             (Node, node:sqlite,     (append-only
  + a 30-min        · dwell state machine               zero deps)              raw events)
  poller tab        · IndexedDB durable queue                   │
                                                                ▼
                labels ───► mix ranker ───► interleaved digest ───► 8am iMessage
             (re-derived    taste + LLM rubric    two arms blind-split     (launchd)
              from raw)     + author prior;       each slate; serves,
                            ~10% explore, MMR     opens, votes logged
```

- **Capture** (`extension/`) — a content script + a `MAIN`-world network hook. It intercepts X's
  GraphQL timeline responses and walks the nested tweet shape; a separate `IntersectionObserver`
  state machine tracks dwell/opens/engagements. The two streams have independent failure
  boundaries so a capture bug in one never silently takes down the other. An ephemeral background
  tab also polls `x.com/home` every 30 minutes through the *same* capture path — perfect
  first-party traffic, no API replay, nothing to rot when X rotates its GraphQL internals. Polled
  tweets are **candidates only**: they can never mint dwell or engagement signals.
- **Ingest** (`ingest/server.ts`) — an HTTP server on `:2727`, append-only writes to SQLite via
  Node's built-in `node:sqlite`. **Zero runtime dependencies.** Raw events are immutable; every
  label is *re-derived* from them, never edited in place.
- **Rank** (`ingest/digest.ts`) — a named-knob blend: `0.5·z(taste) + 0.3·z(rubric) +
  0.2·z(author)`, z-scores winsorized at ±2. *Taste* is TF-IDF cosine to a centroid of my curated
  likes (length-normalized, so long tweets can't buy score). *Rubric* is an LLM grading each
  tweet 0–10 against a personal `RUBRIC.md` — text-only, no author or metrics, so quality can't
  proxy fame — by shelling out to the local `claude` CLI in headless mode: still zero deps, no
  API key, and if the CLI is missing or out of quota the run skips loudly and missing scores rank
  neutral. *Author prior* derives from my engagement history only. ~10% of every digest is an
  **explore** lane sampled from tweets the ranker did *not* pick, plus token-overlap MMR so
  near-duplicate takes don't cluster.
- **Deliver + instrument** (`ingest/daily.ts`, `server.ts`) — a launchd job texts the digest at
  8am; the server auto-starts at login. Every serve is logged with its rank, lane, drafting arm,
  and serve-time score parts; opens and in-flow votes flow back. The loop closes: what I read
  today is tomorrow's eval data.

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
- The nightly LLM scorer decayed to partial coverage. Root cause: the `claude` CLI ignores
  SIGTERM while riding out API backoff, so a 120s timeout left 14-minute zombie processes and the
  batch aborted. Fixed with a 600s deadline + SIGKILL — and the eval prints its coverage next to
  every rubric verdict, so a starved judge can never masquerade as a confident one.

**3. The eval stack — a gate that said "don't ship," then got rebuilt when *it* became the
suspect.** This is the part I'm proudest of.

*Act one: the gate kills my model.* I built a learned ranker (logistic regression, hashing-trick
bag-of-words) with an offline replay harness as the ship gate: beat a keyword baseline on held-out
data or don't ship. Before I could trust its verdict I had to catch three eval bugs — a `random`
baseline scoring a perfect 1.0 (tweet IDs are time-ordered snowflakes; any function of the ID
leaks the label), a test pool so imbalanced the metric saturated under *any* scorer, and a
near-circular baseline (my labels were partly curated *by* those keywords). On the fair gate the
model honestly lost — on clean human labels it ranked *below random* — so the learned-ranker
thread is **closed by evidence**, and the confounder discipline it forced survives everywhere:
`char_len`/`media` are controls, never reward features, so length can't earn score.

*Act two: the instrument becomes the suspect.* The replacement rankers (LLM rubric, taste cosine,
the blend) kept reading "statistically tied with keyword" on that gate, week after week. The tie
turned out to be the metric, not the rankers: pooled MAP threw away ~20% of my hand votes to
class-balancing, mostly scored the head of one giant ranked pile, and quietly handed keyword every
pair its integer word-counts couldn't order — **27% of all 👍/👎 pairs**, concentrated exactly
where a taste ranker earns its keep (good-AI vs AI-flavored junk). I rebuilt the gate as
**pairwise preference accuracy**: AUC over every hand-signed pair, a paired item-level bootstrap
for the (arm − keyword) CI, plus advisory cuts for keyword-tied pairs and for serve-bias-free
explore votes. Same votes, honest ruler: the rubric orders my preferences at **0.71 AUC vs
keyword's 0.63**, CI excluding zero. The weeks of "tie" were the ruler's fault — a claim I only
trust because the same tracing discipline from act one got pointed at the gate itself.

*Act three: offline is only a guardrail.* The deciding eval runs on the live product: **blind
team-draft interleaving**. Two rankers secretly split every digest slate (deterministic seeded
draft, pixel-identical UI, drafting arm logged per card); credits are net judgments
(opens + 👍 − 👎); verdicts come from a day-paired bootstrap CI; and the report *refuses* to print
a lean below a judged-event floor. Around it: a per-version **judge calibration** table (did
editing my rubric actually move the LLM toward my votes? generic 0.69 → personalized 0.72), a
daily **scorecard** (junk@10 per digest day), and a **recall probe** (organic likes the digest
never served me first — the system's only miss-detector).

The circularity rules are the spine of all of it: hand-signed 👍/👎 are the *only* gold labels;
the keyword lexicon and the LLM's scores may **rank** but may never **label**; nothing ever trains
on reviews; and the explore lane doubles as an audit pool no ranker selected, so serve-selection
bias has a control group.

## Deliberately out of scope

Naming what I chose *not* to build:
- **Multi-user / cloud deploy.** It scrapes a private GraphQL surface keyed to one person's
  behavior; multi-tenant is a ToS and privacy minefield that adds no engineering value here.
- **A general recommender.** Candidates come only from my own logged-in surface — what I scrolled
  plus a background poll of my own home timeline. No crawling, no firehose, no unseen-corpus
  indexing.
- **Bigger models.** LR, embeddings, and a behavioral ranker each lost on a non-circular gate —
  closed by evidence, not deferred by laziness. Today's champions are judges, not trained models.
  GBTs, bandits, and online weight-learning stay out until an eval says capacity is the
  bottleneck (it's labels).

## Stack

| Layer | Choice | Why |
|---|---|---|
| Extension | esbuild + MV3, TypeScript | a 4-line build script; the WXT scaffold was removed once it earned nothing |
| Ingest | Node + `node:sqlite` | built-in SQLite, **zero runtime deps**, no native compile |
| Ranking | Pure TypeScript | TF-IDF cosine + author prior + weighted blend, no ML framework |
| LLM judge | local `claude` CLI, headless | rubric scoring with zero deps and no API key; degrades gracefully to neutral |
| Evals | AUC pair gate + team-draft interleave | offline guardrail, online verdict-maker; seeded PRNGs, reproducible run-to-run |
| Tests | vitest (extension) + `node:test` (ingest) | 38 + 98 green: golden DOM fixtures, dwell machine, metric fixtures, draft-determinism snapshots |
| Scheduling | macOS launchd | native, no cron daemon, survives reboot |

## Status

Thirteen milestones in: capture → ingest → read loop → labels → the learned-ranker HOLD → daily
delivery → background poller → LLM rubric → weighted mix → serve telemetry → online interleaving →
the eval rebuild. ~47k tweets, ~66k impressions, and 465 hand-signed votes captured and counting.
The learned ranker is retired by evidence; the LLM-rubric and mix arms both clear the offline gate
(AUC 0.71 / 0.70 vs keyword's 0.63, CIs excluding zero), and a live mix-vs-keyword interleave is
accumulating toward its first online verdict. Full build log in [`PROGRESS.md`](./PROGRESS.md);
the spec is [`PRD.md`](./PRD.md).
