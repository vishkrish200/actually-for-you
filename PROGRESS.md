# actually-for-you — build progress

Point new sessions at this file + the PRD for full context.
`/plan` against PRD §<n> before touching each milestone.

---

## Current state (2026-06-23) — dogfood reset, accumulating clean data

M0–M4 done. In an extended dogfood/verification pass the **data** (not the code structure) was
found to be the problem; root-caused and fixed several capture/ranker correctness bugs, then
**flushed the corpus** to re-accumulate clean. The system is now a **re-ranker of what you actually
saw**, not a discovery engine.

**Live now:**
- Ingest server on `http://localhost:2727` (run `cd ingest && npm start`; auto-loads `.env.local`).
- `afy.db` is **empty** (flushed); old corpus backed up to `ingest/backups/afy-pre-flush-<ts>.db`.
- **iMessage notifier**: after each flush, rate-limited, texts the top-ranked digest (`AFY_IMESSAGE_TO`).
- All tests green: **12 extension + 19 ingest**.

**Active correctness fixes (this session):** screen_name capture (`core` not `legacy`) + `author_name`;
dwell-timer cap (30 s) for leaked IO exit events; trusted-dwell lanes (MAX-not-SUM, flick/velocity
filtered); **viewed-gate** (candidate only if some impression hit ≥50% visible); IDB queue purge.
Details in the dated sections below.

**To activate after a pull:** reload the extension in Chrome (`extension/dist/`) + restart the server.

**Open / next:** keep dogfooding until strong positives are in the hundreds; `position_in_feed`
semantics still undecided for IPW (see pre-M5 note); latent capture risks logged (quote-tweet
`extractTweetId`, hovercard attribution). Then M5 (labels) → M6 (learned ranker).

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

## Pre-M5 review (2026-06-23) — capture-quality fixes before opening the GATE

Comprehensive review of M0–M4 against the PRD. Code is sound; the dogfood **data** was the
problem. Audited `afy.db` (14,405 impressions / 62 sessions): only **18 strong positives**
(17 opened, 1 liked, 0 bookmark/rt/reply) and **85% zero-dwell**. The GATE elapsed but did
not produce trainable labels. Root causes found and fixed:

| Fix | File | What was wrong |
|---|---|---|
| **Engagement via DOM state-flip** | `dwell-tracker.ts` | likes/rts/bookmarks were logged on *click* only — missed keyboard `L`/`T`/`B` entirely, and never confirmed the toggle (PRD §5.6). Now read from the button's `data-testid` flip (`like→unlike`, etc.), input-agnostic, with an entry-baseline so pre-existing likes aren't re-counted. Likely explains the near-zero engagement counts. |
| **Re-impression on scroll-back** | `dwell-tracker.ts` | a tweet that fully exited then re-entered the **same un-recycled node** got no new state (the `afyObserved` guard blocked re-add) — second-view dwell *and* engagement were silently dropped (violated PRD §5.5). `handleIntersection` now lazily creates a fresh impression on re-entry past the visibility gate (only on real re-entry, so hidden nodes don't leak 0ms rows). |
| **Ranker lane join** | `ranker.ts` | `buildFeed` anchored its candidate query `FROM impressions`, so `fresh`/`liked_author` tweets with content but **no impression row** were selected by the lane then dropped by the join (1,837 such tweets). Re-anchored on the lane-selected id list via a `VALUES` CTE; live feed grew 129→145, 16 genuinely-unseen tweets now surface. |

Tests: 11 extension (added engagement-flip, re-impression, pre-existing-like cases) +
15 ingest (added 2 `buildFeed` join regression tests). All pass, typecheck clean.

**⚠️ Open design decision for M5 (recommendation #3 — needs your call, left as-is):**
`position_in_feed` is a monotonic counter that **never resets** (max 4,537 in the data) — it
measures session-scroll-depth, not screen rank, and the data shows no dwell decay by position.
PRD §5.7 defines it this way literally, but IPW (§7.2) wants rank-in-view as the propensity
input. **Decide what "position" means for the propensity model before building M5** — likely
bucket it, reset per session, or capture viewport rank instead. Not changed yet (it depends on
the IPW design that doesn't exist).

**GATE still not met in substance:** keep dogfooding with the fixed capture until strong
positives are in the hundreds, not 18. M5 (label plumbing) can be built in parallel; M6
(learned ranker) will starve until the labels are dense enough.

---

## Dogfood tooling (2026-06-23) — flush notifier + handle-capture fix + UI

Built to make the accelerated dogfood loop verifiable.

| Change | File | What / why |
|---|---|---|
| **screen_name capture fix** | `network-hook.ts` | X moved `screen_name`/`name` from `user.legacy` into `user.core`; hook still read `legacy` → **all 6,091 tweets had empty `author_handle`** (the "shows user id, not username" bug). Now reads `core` first, `legacy` fallback; also captures display `author_name`. The test fixture used the *old* schema so it passed while real data was empty — fixture updated to current shape. Historical handles are unrecoverable (no API). |
| **`author_name` column** | `types.ts`, `server.ts`, `ranker.ts`, `client.html` | Additive (`ALTER TABLE … ADD COLUMN`, append-only safe). Carried through ingest → tweets table → ranked feed → UI. |
| **Flush notifier** | `notify.ts` (new), `server.ts` | After each `/ingest` flush, rate-limited (`AFY_NOTIFY_COOLDOWN_MS`, default 15m), builds top-N ranked (`AFY_NOTIFY_TOP_N`, default 5) and sends a digest. Channel precedence: **`AFY_IMESSAGE_TO` → native macOS iMessage** (osascript/Messages.app, the working channel) · else `POKE_API_KEY` → Poke · else stdout. Fire-and-forget; never throws into ingest. **Poke abandoned for delivery:** its `inbound/api-message` endpoint only injects into the Poke conversation (returns `success:true` but pushes no outbound iMessage), so it never reached the phone despite correct key/account/number. iMessage via AppleScript sends straight to the number — needs Messages signed in + one-time Automation grant. |
| **Digest highlights new captures** | `notify.ts` | Ranked items captured *with a handle* (= captured after the screen_name fix; historical data has none, so handle-presence is an exact proxy) get a `✦` marker, plus a `🆕 newest captures with handle` section listing the most recent handle-bearing tweets — so the capture fix is verifiable from the phone. |
| **Key storage** | `ingest/.env.local` (gitignored), `package.json` | `POKE_API_KEY` lives in `ingest/.env.local` (matched by `.env.*` in `.gitignore`), loaded natively via `node --env-file-if-exists=.env.local` in the `start` script. No dotenv dep, never committed. |
| **Twitter-like UI** | `client.html` | Avatar (derived from handle via `unavatar.io/x/<handle>`, no storage; gray SVG fallback for handle-less rows), bold display name + muted `@handle` + time. |

Tests: 11 extension (fixture now asserts `author_name` on current schema) + 17 ingest (added `notify.test.ts` ×2: digest formatting, handle→name fallback, 100-char cap). All pass, extension typecheck clean. Chain verified end-to-end in-process (handle+name through `buildFeed` → digest).

**To activate:** (1) reload the extension in Chrome (already rebuilt) for the capture fix; (2) restart the ingest server (`npm start` — key auto-loads from `.env.local`) for the notifier + `author_name`. The old server (PID was 89098) is still running pre-change code.

---

## Dwell-leak root cause + ranker hardening (2026-06-23) — "tweets I never saw, claiming dwell"

**Symptom:** digest surfaced never-seen tweets in the `resurface`/`backlog` (dwell) lanes.

**Root cause — dwell-timer leak (capture):** `dwell-tracker` accumulates time between an
IntersectionObserver entry (ratio ≥0.5 → `startTimer`) and exit (ratio <0.5 → `stopTimer`).
Under fast scroll + X's node virtualization, **exit events are dropped**, so the timer runs while
the tweet is off-screen until `pauseAll()` (tab blur) drains every still-running timer at once.

**Evidence in `afy.db`:** max single-impression dwell **855 s**; 12 impressions >60 s; and the
smoking gun — **identical dwell values shared across distinct tweets** (179.4 s ×3, 424.7 s ×2),
i.e. several leaked timers all drained at the same tab-blur instant. Not cross-tweet
misattribution — each tweet kept its own (leaked) timer.

**Fixes:**
| Fix | File | What |
|---|---|---|
| Cap per visible interval | `dwell-tracker.ts` | `stopTimer` clamps one interval to `MAX_INTERVAL_MS=30s`. A leaked timer can no longer credit minutes. Test: visible 60 s with no exit event → dwell ≤30 s. |
| Trusted dwell in lanes | `ranker.ts` | `resurface`/`backlog` + candidate `total_dwell` now use **`MAX`** (not `SUM`) of per-impression dwell, each capped 60 s, excluding flicks and fast-scroll entries (`scroll_velocity_at_entry < 5`). MAX kills re-impression double-counting (one tweet had 75 impressions); the cap+velocity filter kills leak signatures. Test: a 179 s @vel 8.6 impression scores 0 trusted dwell; a genuine 8 s @vel 1 read still promotes. |

**Result on real data:** `resurface` 3 → 1; the `@Tomi_Tapio "no"` tweet (179 s on two words)
and the repeated-glance inflations dropped out. Remaining resurface item is a single 60 s
low-velocity view (plausibly genuine).

**Caveat:** historical pre-fix dwell is corrupt and **append-only** — it can't be retroactively
cleaned, but it ages out of the recency windows and clean 30 s-capped data now flows in.

**Other weak points found (not the active bug, left as-is):** `extractTweetId` returns the
*first* `/status/` link (latent quote-tweet misattribution risk — held up in this data);
`handleHovercard` blanket-marks every tracked tweet `profile_expanded="hovercard"` (over-broad,
but unused by the current scorer); `position_in_feed` still a non-resetting counter (pre-M5 note).

---

## Viewed-gate + flush (2026-06-23) — "re-rank what was in front of me"

Deeper diagnosis after the dwell fix: **52% of the feed was tweets never ≥50% on screen.** The
capture records every tweet in X's GraphQL payload, including ~2.4k pure *prefetch* tweets (zero
impressions). The `fresh`/`liked_author`/`explore` lanes then surfaced those + same-author tweets
the user never saw. Product decision: this is a **re-ranker of what the user actually saw**, not a
discovery engine.

| Change | File | What |
|---|---|---|
| Viewed-gate | `ranker.ts` | A tweet is a candidate only if some impression reached `VIEWED_PCT=0.5` visibility. `bookmark` exempt. Excludes prefetch + never-seen same-author tweets. `explore` invariant preserved but now samples only seen tweets. |
| Queue purge | `idb-queue.ts` | `DB_NAME` bumped `afy-queue`→`afy-queue-v2` and old DB deleted on open, so pre-fix queued events don't drain into the clean DB. |
| DB flush | `afy.db` | Backed up 7,084 tweets / 18,463 impressions → `ingest/backups/afy-pre-flush-<ts>.db` (gitignored), then started empty. Re-accumulating clean, viewed-gated, 30 s-capped data. |

Tests: 19 ingest (added viewed-gate exclusion test; retweet-gap test now requires a *seen*
impression) + 12 extension. All pass.

---

## Milestones at a glance

| # | Status | Description |
|---|---|---|
| M0 | ✅ done | Capture spike — extension sensor scaffold |
| M1 | ✅ done | Hardened capture: golden DOM fixture + edge case tests |
| M2 | ✅ done | Ingest + state: worker + SQLite, append-only |
| M3 | ✅ done | Read loop: minimal client, dogfooding started |
| M4 | ✅ done | Ranker v0: lanes + weighted scorer + MMR |
| GATE | in progress | Dogfood **reset 2026-06-23** (corpus flushed after capture/ranker fixes); re-accumulating clean viewed-gated data toward hundreds of strong positives |
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
