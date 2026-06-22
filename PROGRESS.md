# actually-for-you — build progress

Point new sessions at this file + the PRD for full context.
`/plan` against PRD §<n> before touching each milestone.

---

## M0 — Capture spike ✅ DONE (2026-06-20)

**Goal:** log `{tweet_id, dwell_ms, opened_detail}` for ~20 tweets from a real session.

**What was built:**

| File | Role |
|---|---|
| `extension/src/injected/network-hook.ts` | Wraps `fetch`+XHR in page context (MAIN world); intercepts X GraphQL ops by name; walks nested tweet shape; emits `capture_health` on schema miss |
| `extension/src/content/dwell-tracker.ts` | `IntersectionObserver` dwell state machine keyed by `tweet_id` (not DOM node); handles tab blur, scroll velocity, recycled nodes, SPA nav, engagements, hovercard |
| `extension/src/content/idb-queue.ts` | IndexedDB durable event queue (SW drains in M2) |
| `extension/src/content/index.ts` | Wires all modules; bridges postMessage → SW |
| `extension/src/background/index.ts` | SW stub: logs `[afy] tweets captured:` to console (real drain in M2) |
| `extension/src/types.ts` | `TweetRecord`, `ImpressionEvent`, `CaptureHealthEvent` matching PRD §6 schema |
| `extension/src/injected/network-hook.test.ts` | Golden-fixture test for GraphQL extractor |

**Build:**
```bash
cd extension
npm run build   # esbuild → dist/
npm test        # vitest — 2 tests pass
```

**Verified on:** Chrome (launched with `--load-extension`) + Comet (daily driver).
- SW console shows `[afy] tweets captured: Array(33–37)` on first timeline load.
- No errors in either browser after all fixes below.

---

## Bugs found & fixed during M0

### 1. ESM format on content/injected scripts
- **Symptom:** Extension silent-failed to register SW.
- **Fix:** `--format=iife` for `content.js` and `injected.js`; only `background.js` uses `--format=esm`.

### 2. `document.body` null at `document_start`
- **Symptom:** `TypeError: Failed to execute 'observe' on 'MutationObserver': parameter 1 is not of type 'Node'`
- **Fix:** `document.documentElement` instead of `document.body` in both MutationObserver calls in `dwell-tracker.ts`.

### 3. X.com CSP blocking `<script src="chrome-extension://...">` injection
- **Symptom:** `fetch` was not wrapped (native) despite content script running; injected.js silently blocked.
- **Fix:** Removed manual script injection. Added `"world": "MAIN"` to the injected script's `content_scripts` entry in `manifest.json`. Bypasses CSP entirely.

### 4. `Extension context invalidated` on SW reload
- **Symptom:** After extension reload, `chrome.runtime.sendMessage` in content script threw.
- **Fix:** Wrapped all `sendMessage` calls in a `try/catch` helper `send()` in `content/index.ts`.

---

## Key architectural decisions (locked)

- **`world: "MAIN"`** for `injected.js` — necessary for X.com CSP. Do not revert to manual injection.
- **`document.documentElement`** for MutationObserver — never `document.body` (null at `document_start`).
- **Accumulate dwell by `tweet_id`**, never DOM element — X virtualizes scroll, nodes recycle.
- **IndexedDB queue** is the durable store; SW holds NO state (MV3 ephemeral).

---

## M1 — Hardened capture ✅ DONE (2026-06-21)

**Goal:** Both streams (content + behavior), batched, independent failure modes.

**What was built:**

| File | Role |
|---|---|
| `extension/src/content/dwell-tracker.test.ts` | 6-case state machine test: golden dwell, tab-blur, flick detection, fast-scroll (no-flick), node-recycling, double-finalize guard |

**Test environment:** switched `vitest.config.ts` to `happy-dom` (was `node`) to enable DOM APIs.

**Key fix discovered:** `scrollVelocityAtEntry` is captured at state creation (observeTimeline), not at intersection time — test must set velocity before observeTimeline.

**Build:**
```bash
cd extension && npm test   # 8 tests pass (2 files)
```

**Verification gates met:**
- ✅ Golden DOM fixture: tweet article → `dwell_ms`, `tweet_id`, `flicked`, `opened_detail` all asserted
- ✅ Tab-blur: `pauseAll()` + time advance + `resumeAll()` → blurred time excluded
- ✅ Fast-scroll / flick: `scrollVelocity=10, dwell=100ms` → `flicked=true`; `dwell=400ms` → `flicked=false`
- ✅ Node-recycling: finalize on href change, correct `tweet_id` emitted, no state leak

---

## M2 — Ingest + state ✅ DONE (2026-06-22)

**Goal:** Drain IndexedDB queue → local ingest server → SQLite (append-only).

**What was built:**

| File | Role |
|---|---|
| `ingest/server.ts` | HTTP server on port 2727, POST /ingest → SQLite via `node:sqlite` (built-in, no deps) |
| `ingest/server.test.ts` | 5 tests via `node:test`: persist, idempotency ×2, append-only grep, health events |
| `ingest/package.json` | Zero runtime deps; `node --experimental-strip-types` for TS |
| `extension/src/background/index.ts` | SW relay: receives "tweets"/"impressions" messages, POSTs to /ingest |
| `extension/public/manifest.json` | Added `http://localhost:2727/*` host permission |

**Build & test:**
```bash
# Ingest server tests
cd ingest && npm test   # 5 tests pass (node:test runner)

# Extension
cd extension && npm run build && npm run typecheck && npm test  # 8 tests pass
```

**Verification gates met:**
- ✅ Fixture POST → rows in SQLite asserted
- ✅ Idempotency: same impression_id / tweet_id twice → 1 row (INSERT OR IGNORE)
- ✅ Append-only: grep test confirms no UPDATE/DELETE in server.ts
- ✅ Extension build + typecheck clean
- ✅ Live: 1734 tweets + 7860 impressions in SQLite after real session

**To run locally:**
```bash
cd ingest && npm start   # starts server on http://localhost:2727
# then toggle extension off/on in chrome://extensions, refresh x.com tab
# scroll, switch tabs → impressions flush
# check: curl http://localhost:2727/status
```

**Key decisions:**
- `node:sqlite` (Node 22+ built-in) over `better-sqlite3` — zero native compile, no deps
- Local HTTP over native messaging — debuggable with curl, simpler setup
- **Content script owns IDB drain** — SW and content script have different IndexedDB origins (page vs extension); content script drains on visibilitychange and sends "impressions" message to SW, which relays to /ingest
- `pauseAll()` now finalizes tweets with accumulated dwell — tab switch is a natural session boundary
- Node recycling MO watches `childList: true` — X replaces children, not attributes

---

## M3 — Read loop ✅ DONE (2026-06-22)

**Goal:** Minimal client rendering the tweet corpus in chronological order. Start dogfooding.

**What was built:**

| File | Role |
|---|---|
| `ingest/client.html` | Single-file dark-mode feed reader served at `http://localhost:2727` |
| `ingest/server.ts` | Added `GET /feed` (sort by dwell or newest, stable pagination) and `GET /` (serves client.html) and `GET /impressions/:id` (per-tweet drill-down) |
| `extension/src/injected/network-hook.ts` | Fixed RT content gap: walk `retweeted_status_result` so original tweet ID is captured |

**Key decisions:**
- Feed query bases on `impressions` table (not `tweets`) — surfaces all 4,430 tweet_ids including the 2,762 that had impressions but no content
- "Newest" sorts by `MAX(impression.ts) DESC` (last-seen time), not `captured_at` (batch timestamp) — more accurate and stable
- Stable pagination: `tweet_id DESC` tiebreaker prevents skips/repeats across pages
- RT bug: network hook captured RT wrapper's `rest_id`; dwell tracker read original tweet's ID from DOM — fixed by recursing into `legacy.retweeted_status_result` after parsing each tweet

**Bug found & fixed:**
- 2,762 impressions had no matching tweet content — root cause: retweets. The RT wrapper and the original tweet have different IDs; dwell tracker always sees the original. Fixed going forward; historical gap is unrecoverable.

**Verification gates met:**
- ✅ Manual: feed renders, tweets clickable, dwell sort works, drill-down shows per-impression breakdown
- ✅ Feed coverage: 4,430 tweet_ids (up from 2,260 tweet rows)
- ✅ 8 extension tests still passing after RT fix

---

## M4 — Ranker v0 ✅ DONE (2026-06-22)

**Goal:** Lanes + weighted scorer + MMR diversity.

**What was built:**

| File | Role |
|---|---|
| `ingest/ranker.ts` | Pure ranker: `score()` + `mmr()` + `buildFeed(db)` |
| `ingest/ranker.test.ts` | 8 snapshot tests: score ordering, MMR diversity, limit |
| `ingest/server.ts` | `GET /feed?sort=ranked` calls `buildFeed(db, 200)` |
| `ingest/client.html` | Ranked sort added (default); lane badge shown per tweet |

**Lanes** (priority order, first-lane-wins dedup):
- `bookmark` → explicitly bookmarked
- `liked_author` → tweets from authors you've opened/liked
- `fresh` → captured last 48h, not yet engaged
- `backlog` → seen but not opened, dwell > 1.5s
- `resurface` → high-dwell (>5s) from >2h ago
- `explore` → RANDOM() sample (non-negotiable, anti-filter-bubble)

**Scorer weights:**
- `opened_detail=10`, `liked=8`, `bookmarked=7`, `replied=6`, `dwell_norm=3` (capped 60s), `flicked=-5`

**MMR:** Jaccard token overlap, λ=0.7 (relevance-heavy).

**Build:**
```bash
cd ingest && npm test   # 13 tests pass
```

**Verification gates met:**
- ✅ Order snapshot: opened > liked > dwell > baseline (exact order asserted)
- ✅ Flicked penalty asserted
- ✅ Dwell cap at 60s asserted
- ✅ MMR λ=1.0 = pure score order
- ✅ MMR diversity: diverse tweet beats near-duplicate at equal score
- ✅ All 5 ingest server tests still passing

---

## Milestones at a glance

| # | Status | Description |
|---|---|---|
| M0 | ✅ done | Capture spike — extension sensor scaffold |
| M1 | ✅ done | Hardened capture: golden DOM fixture + edge case tests |
| M2 | ✅ done | Ingest + state: worker + SQLite, append-only |
| M3 | ✅ done | Read loop: minimal client, dogfooding started |
| M4 | ✅ done | Ranker v0: lanes + weighted scorer + MMR |
| GATE | next | ~2 weeks dogfood, accumulate real labels |
| M5 | — | Label pipeline: session reconstruction + IPW debias |
| M6 | — | Ranker v1: GBT/LR + offline eval (NDCG@k / MAP) |
| M7 | — | Online weight updating |

---

## Extension load instructions (for new sessions)

```bash
cd extension && npm run build
```

Then in Comet/Chrome:
- `chrome://extensions` → Developer mode on → Load unpacked → `extension/dist/`
- Or reload existing extension via the reload button if already loaded.

Extension ID (Comet + Chrome): `jdboppmgleafhofleecllpnjooojkpfi`
