# actually-for-you

**A single-user re-ranker for the X (Twitter) timeline.** A Chrome extension quietly captures how
I actually read my feed — dwell time, detail-opens, likes, bookmarks — and a local pipeline ranks
tweets by *my* revealed taste instead of X's engagement-maximizing algorithm. Every morning at
8am it texts me a calibrated digest; every digest secretly runs a blind A/B between two rankers;
and the whole system grades itself against my hand votes, continuously.

No accounts, no cloud, no API keys. One user, one laptop, zero runtime dependencies on the
server. My data never leaves my machine.

---

## Demo

![The digest reader — tweets re-ranked by taste-match to my likes, with time-window tabs](docs/demo.gif)

_The digest reader: every card carries a **✦ score** — a blend of taste-match to my ~2,900
curated likes, an LLM grade against my written rubric, and an author prior — with All / 7-day /
48h windows and in-flow 👍/👎 votes that feed the eval's gold labels. Two rankers are secretly
interleaved in every slate; nothing in the UI reveals which arm picked a card._

---

## Why

X optimizes for *its* objective (time-on-site, ads), not mine. I wanted a feed ranked by what I
actually engage with thoughtfully — long dwells, opened threads, saved posts — with a permanent
`explore` lane so it never collapses into a filter bubble. Single-user by design: multi-tenant
would be a ToS and privacy minefield, and the interesting problems (honest capture, honest
labels, honest evals) don't need it.

## Architecture

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

### The sensor (`extension/`)

X is a hostile capture surface, and the extension is built around the specific ways it fights
back:

- **Two independent capture streams.** Content comes from a `MAIN`-world hook on X's own GraphQL
  responses; behavior (dwell, opens, engagements) comes from an `IntersectionObserver` state
  machine over the DOM. Separate failure boundaries — a schema change on one side can never
  silently take down the other, and `capture_health` events make any breakage loud.
- **GraphQL ops matched by operation name**, never numeric query ID (it rotates on deploy).
- **DOM selectors anchored on `data-testid`**, never CSS classes (obfuscated, high-churn).
- **Dwell accumulates by `tweet_id`, never by DOM node** — X virtualizes scroll and recycles
  elements, so per-element timing smears one tweet's attention onto whatever renders next.
- **Engagement detection is input-agnostic**: it watches the button's `data-testid` flip
  (`like` → `unlike`) instead of click events, so keyboard shortcuts count and a cancelled menu
  doesn't.
- **MV3 service workers are ephemeral**, so durable state lives in an IndexedDB queue drained on
  natural session boundaries. Batches survive server restarts and token rotations.
- **A background poller tab** loads `x.com/home` every 30 minutes through the *same* capture
  path — perfect first-party traffic, no API replay, nothing to rot when X rotates internals.
  Polled tweets are **candidates only**: they can never mint dwell or engagement labels.

### The pipeline (`ingest/`)

An HTTP server on `:2727` — Node's built-in `node:sqlite`, **zero runtime dependencies**, write
endpoints token-authed. Raw events are immutable and append-only; every label is *re-derived*
from them, never edited in place. A launchd job builds and texts the digest at 8am; the server
auto-starts at login. Every serve is logged with its rank, lane, drafting arm, and serve-time
score parts; opens and in-flow votes flow back. The loop closes: what I read today is tomorrow's
eval data.

## Ranking signals

The digest score is a named-knob blend — `0.5·z(taste) + 0.3·z(rubric) + 0.2·z(author)`,
z-scores winsorized at ±2:

| Signal | What it is | Guardrail |
|---|---|---|
| **Taste** | TF-IDF cosine to a centroid of ~2,900 curated likes | Length-normalized — long tweets can't buy score |
| **Rubric** | An LLM grades each tweet 0–10 against my personal `RUBRIC.md`, via the local `claude` CLI in headless mode | Text-only: no author, no metrics, so quality can't proxy fame. CLI missing / out of quota → the run skips loudly and missing scores rank neutral |
| **Author prior** | Per-author rate derived from my engagement history | Derived from behavior only, never from hand votes — votes are eval-only gold |
| **Explore lane** | ~10% of every digest sampled from tweets the ranker did *not* pick | Anti-filter-bubble, and a serve-bias-free audit pool for the eval |
| **MMR diversity** | Token-overlap penalty at slate assembly | Near-duplicate takes don't cluster |
| **Confounder controls** | `char_len`, `media_present`, `is_thread` | Regressed in during any training, dropped at predict — never reward features, so length and media can't earn score |

## How it grades itself

The system carries its own eval stack — four standing instruments plus a gate, all runnable
from `ingest/`:

**Offline gate** (`npm run eval`) — pairwise preference accuracy: AUC = P[score(👍) > score(👎)]
over *every* hand-signed vote pair, no balancing, no split — reviews are 100% test, nothing ever
trains on them. A candidate ranker clears only by beating the keyword baseline with a paired
item-bootstrap CI on the (arm − keyword) difference that excludes zero; a CI straddling zero is
a TIE, not a win. Two advisory cuts print alongside: keyword-tied pairs (where the baseline is
structurally blind — 27% of all pairs) and the ✧ explore-audit pool (serve-bias-free). Current
reading on 465 votes at full rubric coverage: **rubric 0.71 and mix 0.70 vs keyword's 0.63, both
CIs excluding zero**.

**Online interleave** (`npm run interleave`) — the verdict-maker. Two rankers team-draft every
digest slate (deterministic seeded draft, pixel-identical UI, drafting arm logged per card).
Credit is a net judgment — opens + 👍 − 👎, negatives count — verdicts come from a day-paired
bootstrap CI, and the report *refuses* to print a lean below a judged-event floor. The offline
gate is a guardrail; this is where rankers earn their keep. A matchup is always running.

**Judge calibration** (per-`rubric_sha` table in the eval) — did editing my rubric actually move
the LLM toward my votes? Generic rubric 0.69 AUC → personalized 0.72. Observe-only by doctrine:
the rubric is never iterated against this table.

**Scorecard** (`npm run scorecard`) — per-digest-day product pulse: junk@10/@20, hits, opens,
explore-vs-core votes.

**Recall probe** (`npm run recall`) — the miss detector: organic engagements the digest never
served me first.

The circularity rules are the spine of all of it: hand-signed 👍/👎 are the *only* gold labels;
the keyword lexicon and the LLM's scores may **rank** but may never **label**; nothing ever
trains on reviews; and the explore lane doubles as an audit pool no ranker selected, so
serve-selection bias has a control group.

## Field notes (bugs worth the scar tissue)

- **The diagnostic that killed its patient.** Capture silently stopped. Root cause: a malformed
  `capture_health` row — the event type that exists to make breakage loud — was throwing
  *inside the write transaction* and rolling back the real data with it. Found by adding
  freshness telemetry and logging the swallowed exception, not by staring at code.
- **Dwell timers that leaked minutes.** Fast scrolling dropped IntersectionObserver exit events,
  so leaked timers drained together on tab-blur — the tell was *identical* dwell values shared
  across distinct tweets (179.4s on three different tweets). Fixed with a per-interval cap.
- **The green test that lied.** X moved `screen_name` between GraphQL shapes; the test fixture
  used the old shape, so tests stayed green while every captured handle came back empty. A green
  test against a stale fixture is worse than no test.
- **The zombie judge.** The nightly LLM scorer decayed to partial coverage because the `claude`
  CLI ignores SIGTERM while riding out API backoff — 120s timeouts left 14-minute zombie
  processes. Fixed with a hard deadline + SIGKILL, and the eval now prints coverage next to
  every rubric verdict so a starved judge can't masquerade as a confident one.
- **The eval that had to be rebuilt.** The first ship gate (pooled MAP) killed my learned ranker
  honestly — but only after I caught a "random" baseline scoring a perfect 1.0 (tweet IDs are
  time-ordered snowflakes; any function of the ID leaks the label) and a test pool so imbalanced
  the metric saturated. Later, the *replacement* rankers kept reading "tied with keyword" on
  that gate, week after week — and the tie turned out to be the metric: pooled MAP discarded
  ~20% of my votes to class-balancing and silently handed keyword every pair its integer
  word-counts couldn't order, concentrated exactly where a taste ranker earns its keep. The
  rebuilt pairwise gate, on the same votes, separated the arms cleanly. The instrument was the
  suspect; the same tracing discipline that debugged capture debugged the eval.

The learned ranker (logistic regression, hashing-trick bag-of-words) lost on a fair gate and is
retired by evidence — today's champions are judges and similarity, not trained models. The
confounder discipline it forced survives everywhere.

## Deliberately out of scope

- **Multi-user / cloud deploy.** It scrapes a private GraphQL surface keyed to one person's
  behavior; multi-tenant adds no engineering value here.
- **A general recommender.** Candidates come only from my own logged-in surface — what I
  scrolled plus a background poll of my own home timeline. No crawling, no firehose.
- **Bigger models.** LR, embeddings, and a behavioral ranker each lost on a non-circular gate —
  closed by evidence, not deferred by laziness. GBTs, bandits, and online weight-learning stay
  out until an eval says capacity is the bottleneck (it's labels).

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

## Running it

Built for an audience of one, but everything is reproducible:

```sh
# ingest server (Node ≥ 22 — node:sqlite + type stripping are built in)
cd ingest
echo "AFY_TOKEN=$(openssl rand -hex 16)" > .env.local   # write-endpoint auth
npm start                                                # reader at http://localhost:2727

# extension
cd extension
./build.sh              # bakes AFY_TOKEN into the service worker
# then: chrome://extensions → Load unpacked → extension/dist

npm test                # in either package
npm run eval            # the ship gate, from ingest/
```

The 8am delivery runs via a launchd plist calling `npm run daily`; `CLAUDE_BIN` in `.env.local`
points at the `claude` binary for rubric scoring (optional — everything degrades gracefully
without it).

## Project history

Thirteen milestones: capture → ingest → read loop → labels → the learned-ranker HOLD → daily
delivery → background poller → LLM rubric → weighted mix → serve telemetry → online
interleaving → the eval rebuild. ~47k tweets, ~66k impressions, and 465 hand-signed votes so
far. The full build log is [`PROGRESS.md`](./PROGRESS.md); the spec is [`PRD.md`](./PRD.md);
the longer story is [the blog post](./docs/blog-post.md).
