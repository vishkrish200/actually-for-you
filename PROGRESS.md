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

## Current milestone: M1 — Hardened capture

**Goal:** Both streams (content + behavior), batched, independent failure modes.

**Verification gate (must pass before M1 is done):**
- Golden DOM fixture test: record a real session's HTML, assert exact events parsed.
- Tab-blur + fast-scroll + node-recycling as explicit test cases.

**Start with:** `/plan` against PRD §5 + §9.

---

## Milestones at a glance

| # | Status | Description |
|---|---|---|
| M0 | ✅ done | Capture spike — extension sensor scaffold |
| M1 | next | Hardened capture: golden DOM fixture + edge case tests |
| M2 | — | Ingest + state: worker + SQLite, append-only |
| M3 | — | Read loop: minimal client, start dogfooding |
| M4 | — | Ranker v0: lanes + weighted scorer + MMR |
| GATE | — | ~2 weeks dogfood, accumulate real labels |
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
