# actually-for-you — working agreements

## What this is

A single-user X (Twitter) feed re-ranker. Captures behavioral signals (dwell, detail-opens,
profile-expands, engagements) via a Chrome extension sensor on x.com, injects them into a
ranking pipeline that replaces X's native algorithm.

## Build order (risk-first)

M0 → M1 → M2 → M3 → M4 → [dogfood gate] → M5 → M6 → M7

**Current milestone: M0 (capture spike)**

## Critical invariants — never violate

- Raw events are **append-only**. Labels re-derive from raw; never mutate events.
- Never train the ranker on the ranker's own output. Labels come from observed behavior only.
- `char_len` / `media_present` are **confounder controls**, never reward features.
- The `explore` lane must exist in every ranker version (anti-filter-bubble + low-bias training data).

## Capture surface gotchas (§5 of PRD)

- Match GraphQL ops by **operation name**, never by numeric query ID (rotates).
- Anchor DOM selectors on `data-testid`, never CSS classes (obfuscated, high-churn).
- Accumulate dwell by `tweet_id`, never by DOM element — X virtualizes the scroll and recycles nodes.
- Service worker is **ephemeral under MV3** — all durable state lives in IndexedDB.
- Content vs. behavior capture modules must have **independent failure boundaries** (separate try/catch).
- `capture_health` events on schema/selector mismatch — breakage must be loud, not silent.

## Verification gates (never claim done without proof)

- **Capture:** golden DOM fixture + tab-blur / fast-scroll / node-recycling cases.
- **Ingest/lanes:** fixture tests + append-only assertion.
- **Ranker v0:** order snapshot tests (fixed candidates + weights → asserted output order).
- **Label pipeline:** IPW debiasing unit tests + label-distribution sanity vs. naive dwell.
- **Ranker v1:** offline replay NDCG@k / MAP beating v0 baseline — this is the ship gate.

## Tooling

- Extension scaffold: **WXT** (TS, HMR, MV3, content-script bundling) — do not hand-roll.
- Tests: **vitest** (extractor logic, dwell state machine, fixture tests).
- `dev` = WXT dev server · `test` = vitest · `typecheck` = tsc.

## Review subagent instruction

Point review subagents at the PRD with: "check the diff against PRD §<n>; report only
correctness/requirement gaps, not style."

## Ranker v1 adversarial review note

An adversarial reviewer over-reports on ML code. Tell it to flag only correctness /
requirement gaps — chasing everything over-engineers a logistic regression.
