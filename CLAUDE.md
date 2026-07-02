# actually-for-you — working agreements

## What this is

A single-user X (Twitter) feed re-ranker. A Chrome extension sensor on x.com captures behavioral
signals (dwell, detail-opens, engagements) + tweet content; an ingest server (`ingest/`) stores
them append-only in sqlite and serves a ranked daily digest.

**Status lives in [PROGRESS.md](PROGRESS.md) — read its "RESUME HERE" block, don't trust
milestone claims here.** (M0–M6 done; M6 verdict: HOLD — learned ranker doesn't beat the
keyword baseline on the non-circular gate.)

## Critical invariants — never violate

- Raw events are **append-only**. Labels re-derive from raw; never mutate events.
- Never train the ranker on the ranker's own output. Labels come from observed behavior only.
- Hand-signed 👍/👎 reviews are the ONLY non-circular gold labels. The `AI_LEXICON` keyword list
  is a **baseline to beat**, never a label source — anything it touches is circular for eval.
- `char_len` / `media_present` / `is_thread` are **confounder controls**: regressed in during
  training, dropped at predict. Never reward features.
- The `explore` lane must exist in every ranker version (anti-filter-bubble + low-bias data).
- `afy.db`, `model.json`, `.env.local` are personal data — gitignored, never commit them.
  `ducky-cli/` is an unrelated project accidentally nested here — never commit it.

## Ship gate (M6, eval.ts)

A learned ranker ships ONLY if it beats the keyword baseline on the **review-only pool**
(hand-signed labels) on NDCG@10 AND MAP. Same-era and full pools are supplementary — both
are confounded (keyword-circular / era-detectable). At n≈44 test labels the gate is noisy:
pair any verdict with the bootstrap CI (`ranker_emb.ts` prints it); a CI straddling 0 = tied,
not a win. Don't tune hyperparameters against this gate until n grows — that's fitting noise.

## Two packages, different toolchains (don't mix them up)

- **`extension/`** — esbuild bundling (NOT WXT — that scaffold was removed), **vitest** tests,
  `web-ext` dev runner. MV3: service worker is ephemeral, durable state in IndexedDB.
- **`ingest/`** — zero-dependency Node (`node --experimental-strip-types`), **node:test** (NOT
  vitest, despite the stray vitest.config.ts). Scripts: `npm test`, `npm run eval` (ship gate),
  `labels`, `digest`, `daily`, `probe`. DB path via `AFY_DB` (default `afy.db`); run from
  `ingest/`. Embeddings (`ranker_emb.ts`) need local ollama serving `nomic-embed-text`
  (cached in `emb_cache` table, so re-runs work offline).

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
