# actually-for-you — working agreements

## What this is

A single-user X (Twitter) feed re-ranker. A Chrome extension sensor on x.com captures behavioral
signals (dwell, detail-opens, engagements) + tweet content; an ingest server (`ingest/`) stores
them append-only in sqlite and serves a ranked daily digest.

**Status lives in [PROGRESS.md](PROGRESS.md) — read its "RESUME HERE" block, don't trust
milestone claims here.** Work proceeds one phase at a time; the user approves between phases.

## Critical invariants — never violate

- Raw events are **append-only**. Labels re-derive from raw; never mutate events.
- Never train the ranker on the ranker's own output. Labels come from observed behavior only.
- Hand-signed 👍/👎 reviews at-or-after `GATE_CUTOFF` are the ONLY non-circular gold labels —
  untouchable, nothing trains on them. Pre-cutoff reviews are **spent dev currency** (amendment
  2026-07-15): usable as training labels for dev-trained arms (`review-lr`), never for verdicts —
  any dev-pool read of such an arm is a train-set read. If `GATE_CUTOFF` moves forward, the train
  set is re-cut with it. The `AI_LEXICON` keyword list is a **baseline to beat**, never a label
  source — anything it touches is circular for eval.
- `char_len` / `media_present` / `is_thread` are **confounder controls**: regressed in during
  training, dropped at predict. Never reward features.
- The `explore` lane must exist in every ranker version (anti-filter-bubble + low-bias data).
- Background-polled tweets (`tweets.source='poll'`, M7) are **candidates only** — they must never
  mint impressions, dwell, or engagement labels, and `'poll'` never overwrites an organic
  `'net'`/`'dom'` source row.
- LLM rubric scores (M8) are ranking **features**, never label sources — the AI_LEXICON rule one
  layer up: an LLM-labeled eval pool is circular for any LLM-scored ranker.
- Author priors (M9) derive from `engagement_labels` ONLY, never from `reviews` — reviews are
  eval-only gold; features built from them leak the gate into the model. (Features from reviews
  still leak; distinct from `review-lr`'s *labels*, which are pre-cutoff-only per the 2026-07-15
  amendment.)
- `afy.db`, `model.json`, `.env.local` are personal data — gitignored, never commit them.
  `ducky-cli/` is an unrelated project accidentally nested here — never commit it.

## Ship gate (M13 rebuild 2026-07-08; prospective freeze 2026-07-14 — eval.ts)

The offline gate is a **guardrail**; the online interleave (`npm run interleave`, M11 — net
credit = opens + 👍 − 👎, may go negative) is the verdict-maker. Gate metric: **pairwise
preference accuracy (AUC)** over hand-signed 👍/👎 pairs — no balancing, nothing trains on
reviews. A candidate clears ONLY by beating the **strongest baseline**
(recency/char_len/keyword/author-prior — picked per pool by point AUC, keyword on ties; random is
reference-ineligible, its deviation from 0.5 is seed luck) on all-pairs AUC **with a paired
(arm − baseline) item-bootstrap diff CI excluding 0** — a CI straddling 0 = TIED, not a win.

**Prospective split (frozen 2026-07-14, `GATE_CUTOFF = 2026-07-15`):** every vote cast before
the cutoff is the **DEV pool** — the metric (MAP→AUC), the credit formula, and the
strongest-baseline policy were all chosen while inspecting those votes, so no CI on them
accounts for that; they print as an advisory regression read and can NEVER verdict. Only
post-cutoff votes feed the gate. Move the cutoff only forward, and only when re-freezing after
a deliberate gate-design change.

**Interleave confirmatory window (frozen 2026-07-14, `WINDOW_START = 2026-07-15`,
`HORIZON_DAYS = 14`):** everything before the window is the pilot (the credit formula changed
mid-flight watching it; final pilot read: TIED at n=83). In-window, the CI prints ONCE, at the
predeclared horizon — never "run until it excludes 0" (optional stopping manufactures leans).
If the 30-judged-event floor isn't met at the horizon the window extends on n, never on the
lean. Opens AND votes both key to a tweet's arm-attributed FIRST serve (a cross-arm re-serve
must not split numerator and denominator). Changing matchup/formula/floor restarts the window.

The author-prior arm (M9 prior run solo, engagement_labels only) is the behavior-only bar:
"does content modeling add anything over WHO posted?" — a baseline, never a shipper.
Advisory cuts printed alongside, never the gate: keyword-tied pairs (where keyword is
structurally blind) and the ✧ explore-audit pool — a **ranker-blind-spot** read (cards sampled
from what the rankers did NOT pick; no arm scored them into the slate, but it is NOT an
unbiased sample of the candidate pool — eligibility is conditioned on rejection). The
judge-calibration table (per-`rubric_sha` AUC vs votes) evaluates RUBRIC.md edits directly —
NEVER iterate the rubric against it or tune weights against any offline pool; the interleave is
where rankers earn their keep. Offline pool AUC replays TODAY's formula over pooled votes — it
is not the historical ranker's measured performance and says nothing about top-K. v1 LR arms
and the same-era/full pools are deleted (LR-era scaffolding; git remembers; `ranker_v1.ts`
survives only as the hashStr home). Product pulse: `npm run scorecard` — junk@K is 👎 **among
judged** cards at the cut with coverage printed beside it (a no-vote day reads "no votes",
never 0%); recall side: `npm run recall` (organic engagements the digest never served —
lower-bound).

## Two packages, different toolchains (don't mix them up)

- **`extension/`** — esbuild via `build.sh` (cleans `dist/`, bakes `AFY_TOKEN` into the SW;
  NOT WXT — that scaffold was removed), **vitest** tests, `web-ext` dev runner. MV3: service
  worker is ephemeral, durable state in IndexedDB.
- **`ingest/`** — zero-dependency Node (`node --experimental-strip-types`), **node:test**.
  Scripts: `npm test`, `npm run eval` (ship gate), `labels`, `digest`, `daily`, `probe`, `funnel`,
  `interleave`, `scorecard`, `recall`, `rubric`.
  DB path via `AFY_DB` (default `afy.db`); run from `ingest/`. Stays zero-dep: the M8 rubric
  scorer shells out to the local **`claude` CLI in headless mode** (`claude -p`, billed to the
  user's Claude subscription — NO API key, no SDK, node:child_process is stdlib). Binary via
  `CLAUDE_BIN` in `.env.local` (default `claude`; launchd contexts need the absolute path,
  `~/.local/bin/claude`). Scoring must degrade gracefully: CLI missing / quota exhausted → skip
  the run loudly, never block the digest; missing scores are neutral at rank time.
- Write endpoints are token-authed: `AFY_TOKEN` in `ingest/.env.local`, same value baked into
  the extension by `build.sh`. After rotating it: rebuild + reload the extension BEFORE
  restarting the server, or capture 401-wedges (batches wait safely in IDB, but it's a stall).

## Capture surface gotchas (PRD §5)

- Match GraphQL ops by **operation name**, never numeric query ID (rotates).
- Anchor DOM selectors on `data-testid`, never CSS classes (obfuscated, high-churn).
- Accumulate dwell by `tweet_id`, never by DOM element — X virtualizes scroll, recycles nodes.
- Content vs. behavior capture must have **independent failure boundaries** (separate try/catch).
- Emit `capture_health` events on schema/selector mismatch — breakage must be loud.

## Verification (never claim done without proof)

- Run the affected package's tests before claiming done; commit only on green.
- Ranker/label changes: also run `npm run eval` and report the gate verdict honestly —
  a HOLD is a real result, print it, don't ship around it.
- Order-sensitive code (rankers): snapshot tests — fixed candidates + weights → asserted order.

## Review subagents

Point them at the PRD: "check the diff against PRD §<n>; report only correctness/requirement
gaps, not style." On ML code, insist on this — adversarial reviewers over-report and chasing
everything over-engineers a logistic regression.
