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

## Ship gate (M6, rethought 2026-07-07 — eval.ts)

The offline gate is a **guardrail**; the online interleave (`npm run interleave`, M11) is the
verdict-maker. A candidate arm clears the gate ONLY by beating keyword on the **review-only pool**
(hand-signed labels) on NDCG@10 AND MAP **with a paired (arm − keyword) diff CI excluding 0** — a
CI straddling 0 = tied, not a win. Every review-pool arm gets that diff CI. Reviews are 100% test:
no arm trains on them (v1 LR trains on behavioral labels only), so all hand-signed gold feeds the
gate. Same-era and full pools are confounded LR-era reads, hidden behind `npm run eval -- --all`.
Don't tune weights/hyperparameters against the gate — that's fitting noise; the interleave is
where rankers earn their keep.

## Two packages, different toolchains (don't mix them up)

- **`extension/`** — esbuild via `build.sh` (cleans `dist/`, bakes `AFY_TOKEN` into the SW;
  NOT WXT — that scaffold was removed), **vitest** tests, `web-ext` dev runner. MV3: service
  worker is ephemeral, durable state in IndexedDB.
- **`ingest/`** — zero-dependency Node (`node --experimental-strip-types`), **node:test**.
  Scripts: `npm test`, `npm run eval` (ship gate), `labels`, `digest`, `daily`, `probe`, `funnel`.
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
