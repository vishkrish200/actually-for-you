# actually-for-you — working agreements

## What this is

A single-user X (Twitter) feed re-ranker. A Chrome extension sensor on x.com captures behavioral
signals (dwell, detail-opens, engagements) + tweet content; an ingest server (`ingest/`) stores
them append-only in sqlite and serves a ranked daily digest.

**Status lives in [PROGRESS.md](PROGRESS.md) — read its "RESUME HERE" block, don't trust
milestone claims here.** (M0–M6 done; M6 verdict: HOLD — learned ranker doesn't beat the
keyword baseline on the non-circular gate. M7–M10 "backscroll build-out" in flight: the roadmap
section in PROGRESS.md is the plan of record; one phase at a time, user approves between phases.)

## Critical invariants — never violate

- Raw events are **append-only**. Labels re-derive from raw; never mutate events.
- Never train the ranker on the ranker's own output. Labels come from observed behavior only.
- Hand-signed 👍/👎 reviews are the ONLY non-circular gold labels. The `AI_LEXICON` keyword list
  is a **baseline to beat**, never a label source — anything it touches is circular for eval.
- `char_len` / `media_present` / `is_thread` are **confounder controls**: regressed in during
  training, dropped at predict. Never reward features.
- The `explore` lane must exist in every ranker version (anti-filter-bubble + low-bias data).
- Background-polled tweets (`tweets.source='poll'`, M7) are **candidates only** — they must never
  mint impressions, dwell, or engagement labels, and `'poll'` never overwrites an organic
  `'net'`/`'dom'` source row.
- LLM rubric scores (M8) are ranking **features**, never label sources — the AI_LEXICON rule one
  layer up: an LLM-labeled eval pool is circular for any LLM-scored ranker.
- Author priors (M9) derive from `engagement_labels` ONLY, never from `reviews` — reviews are
  eval-only gold; features built from them leak the gate into the model.
- `afy.db`, `model.json`, `.env.local` are personal data — gitignored, never commit them.
  `ducky-cli/` is an unrelated project accidentally nested here — never commit it.

## Ship gate (M13 rebuild 2026-07-08 — eval.ts)

The offline gate is a **guardrail**; the online interleave (`npm run interleave`, M11 — net
credit = opens + 👍 − 👎, may go negative) is the verdict-maker. Gate metric: **pairwise
preference accuracy (AUC)** over ALL hand-signed 👍/👎 pairs — no balancing, no split, nothing
trains (reviews are 100% test). A candidate clears ONLY by beating keyword on all-pairs AUC
**with a paired (arm − keyword) item-bootstrap diff CI excluding 0** — a CI straddling 0 = TIED,
not a win. Advisory cuts printed alongside, never the gate: keyword-tied pairs (where keyword is
structurally blind) and the ✧ explore-audit pool (serve-bias-free; where it disagrees with the
main pool at real n, trust the audit). The judge-calibration table (per-`rubric_sha` AUC vs
votes) evaluates RUBRIC.md edits directly — NEVER iterate the rubric against it or tune weights
against any offline pool; the interleave is where rankers earn their keep. v1 LR arms and the
same-era/full pools are deleted (LR-era scaffolding; git remembers; `ranker_v1.ts` survives only
as the hashStr home). Product pulse: `npm run scorecard` (per-digest-day junk@K/hits/lanes);
recall side: `npm run recall` (organic engagements the digest never served — lower-bound).

## Two packages, different toolchains (don't mix them up)

- **`extension/`** — esbuild via `build.sh` (cleans `dist/`, bakes `AFY_TOKEN` into the SW;
  NOT WXT — that scaffold was removed), **vitest** tests, `web-ext` dev runner. MV3: service
  worker is ephemeral, durable state in IndexedDB.
- **`ingest/`** — zero-dependency Node (`node --experimental-strip-types`), **node:test**.
  Scripts: `npm test`, `npm run eval` (ship gate), `labels`, `digest`, `daily`, `probe`, `funnel`,
  `interleave`, `scorecard`, `recall`.
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
