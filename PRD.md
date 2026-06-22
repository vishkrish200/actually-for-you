# PRD — Personal X Feed-Ranker

**Status:** ready for build · **Audience:** Claude Code (+ the one human who uses this)
**Companion files:** `CLAUDE.md` (lean always-loaded working agreements) · this PRD is the detailed spec you point plan mode and review subagents at.

---

## 1. Summary

A single-user system that re-ranks the X (Twitter) home timeline using the user's own
captured behavioral signals — dwell time, detail-opens, profile-expands, and explicit
engagement (likes/RTs/bookmarks) — instead of X's native algorithm. It is **not** a
multi-user recommender; there is exactly one user, which removes most distributed-systems
and scale concerns by design.

## 2. The core insight (read this before designing anything)

The hard part is **not** the ranking model. It is the **capture surface** and the
**labels**. Dwell time, detail-opens, and profile-expands do not exist in any scrape of a
timeline — they are first-party interaction telemetry that X collects and does not expose.
They must be captured at the moment of interaction. Two consequences drive the whole design:

1. **Capture is a sensor problem.** We instrument the user's real behavior on x.com via a
   browser extension. We do not re-render the timeline to read it.
2. **Implicit signals are biased.** Dwell ≠ relevance. Position bias (top-of-feed gets
   attention regardless of quality) and presentation bias (threads/media get more dwell)
   will poison a naive ranker. The label pipeline must debias before any model trains.

## 3. Scope

**In (v1):** capture surface (extension sensor), ingest + state, label pipeline,
ranking engine (deterministic v0 → learned v1), serve + reading client, feedback loop.

**Out (v1):** multi-user, large-scale serving, A/B-test infrastructure, mobile,
Firefox support. Chrome-only first.

## 4. System architecture

```
[Capture surface]  x.com extension — two streams: behavior events + tweet content
        │
        ▼
[Ingest + state]   worker → SQLite; raw events APPEND-ONLY; tweet corpus
        │
        ▼
[Label pipeline]   session reconstruction · position debiasing (IPW) · relevance labels
        │
        ▼
[Ranking engine]   candidate lanes → scorer (v0 heuristic → v1 learned) → MMR diversity
        │
        ▼
[Serve]            cron-compiled cached feed → reading client
        │
        └──────────── feedback loop: what you read → new events ───────────▲
```

The five stages are deliberately separable. The middle three (ingest, label, serve) are
largely solved patterns; the engineering risk and novelty live in **capture** and **ranking**.

---

## 5. CAPTURE SURFACE (detailed — the centerpiece)

Target: a browser extension (MV3) on x.com acting as a passive **sensor**. It emits two
independent streams — `tweets` (content) and `impressions` (behavior) — joined on `tweet_id`.

### 5.1 Two mechanisms, by design

| Stream | Source | Mechanism | Why |
|---|---|---|---|
| `tweets` (content) | X's own GraphQL responses | hook `fetch` + `XMLHttpRequest` in page context | clean structured JSON, stable schema, robust to DOM churn |
| `impressions` (behavior) | the rendered DOM + user input | `IntersectionObserver` + event listeners | dwell/clicks/expands are the user's behavior, only observable in the DOM |

Run as separate modules with separate try/catch boundaries. **A DOM change must not break
content capture; a GraphQL schema change must not break behavior capture.**

### 5.2 Component architecture (MV3)

```
page context (injected script)         isolated content script            service worker (background)
 ├─ fetch / XHR hook  ──emits──▶ window.postMessage ──▶ content script ──▶ chrome.runtime ──▶ SW
 │   (captures GraphQL tweet JSON)                       ├─ IntersectionObserver (dwell)        ├─ dedupe + transport
 │                                                       ├─ click / nav listeners               ├─ retry w/ backoff
 │                                                       ├─ hovercard observer                  └─ POST batches to ingest
 │                                                       └─ writes events ─▶ IndexedDB queue
 └────────────────────────────────────────────────────────────────────────▲
                                                          durable buffer ───┘
```

- **Injected page script:** content scripts run in an isolated world and cannot see the
  page's `fetch`. To hook network calls, inject a `<script>` into the *page* context,
  capture GraphQL responses there, and `postMessage` them to the content script.
- **Content script:** owns all DOM observation + the IndexedDB event queue.
- **Service worker:** ephemeral under MV3 — can be killed anytime, holds NO state. The
  durable queue lives in **IndexedDB**. The SW only drains the queue to the ingest endpoint.
- **IndexedDB queue:** events written immediately (durable), marked sent on ack, dropped after.

### 5.3 Content stream — the GraphQL hook

X loads the timeline via GraphQL calls (operation names like `HomeTimeline`,
`HomeLatestTimeline`; tweet detail via `TweetDetail`). The numeric query IDs in the URL
**rotate** — match on the operation name / URL pattern, never a hardcoded id.

- Wrap `window.fetch` and `XMLHttpRequest.prototype.open/send` in the injected script.
- For matching responses, clone and parse the JSON. Tweet objects are deeply nested
  (`data → … → instructions → entries → content → itemContent → tweet_results → result → legacy`).
  Write one extractor that walks this and yields normalized `TweetRecord`s.
- **Schema-validate** on extract. On mismatch, emit a `capture_health` event (§5.8) rather
  than silently dropping — this is the early warning that X changed something.
- This is the user's own logged-in traffic, observed passively. No extra requests; nothing automated.

### 5.4 Behavior stream — tweet identity & node mapping

- Anchor on `data-testid` attributes, NOT CSS classes (classes are obfuscated and churn).
  Tweet container: `article[data-testid="tweet"]`. Permalink `a[href*="/status/"]` → `tweet_id`.
- X recycles DOM nodes (virtualized scroll): the same `<article>` is reused for a different
  tweet. **All accumulators key by `tweet_id`, never by element.** Track recycling explicitly.

### 5.5 Behavior stream — dwell state machine (the hard part)

Per visible tweet, accumulate focused-and-visible time:

```
ENTER (>=50% visible; IntersectionObserver thresholds [0, .5, 1]):
  start timer for tweet_id (record entry ts, position_in_feed, scroll velocity)
EXIT (<50% visible) OR node detaches OR tab hidden OR window blur:
  stop timer, add elapsed to accumulator
FINALIZE (node detaches OR full exit OR session end):
  emit one `impression` event; reset accumulator for that tweet_id
```

Edge cases that MUST be handled:
- **Tab visibility:** `document.visibilitychange` → pause all timers when hidden, resume on visible.
- **Window blur:** `blur`/`focus` on window → same as above (another app focused).
- **Scroll-velocity gate:** if entry→exit is very short and scroll velocity high, set
  `flicked = true` (down-weighted downstream; not a read).
- **Virtualization / node recycling:** flush + reset on node detach (MutationObserver on the
  timeline container, or IO `isIntersecting=false` + node gone). Never carry an accumulator
  into a recycled node.
- **Re-impressions:** scrolling back up to a tweet that fully left view = a NEW `impression_id`
  for the same `tweet_id`. Impression-level rows; total dwell = sum across impressions.

### 5.6 Behavior stream — clicks & expands

- **Detail-open:** X is an SPA. Detect via SPA navigation (`history.pushState` patch +
  `popstate`), attributing the open to the tweet whose `tweet_id` matches the new
  `/status/{id}` URL. Distinguish from outbound link clicks, media lightbox, and button clicks.
- **Profile-expand (two strengths):** `hovercard` shown (`[data-testid="HoverCard"]`) is a
  weak signal (could be accidental hover); `clickthrough` (nav to `/{handle}`) is strong.
  Capture both, tagged distinctly; the label pipeline decides weighting.
- **Engagement:** `data-testid` = `like`/`unlike`, `retweet`/`unretweet`, `reply`, `bookmark`.
  Listen for clicks AND confirm the state flip (aria-label change) before logging, to avoid
  logging an opened-then-cancelled menu.

### 5.7 Session & context fields

- `session_id`: new on tab open or after a long idle gap (default 30 min inactive).
- `position_in_feed`: ordinal of the tweet at impression time — increment a counter as new
  entries insert. **Essential** for position-debiasing.
- `ts`, `scroll_velocity_at_entry`, `max_visible_pct`.

### 5.8 Robustness

- `data-testid` over classes; operation-name over query-id — the more stable anchors.
- Schema/selector validation + `capture_health` events so breakage is loud, not silent.
- Independent failure modes (content vs behavior modules wrapped separately).
- Buffering: IndexedDB first; flush in batches (every N events / T seconds, and on
  `visibilitychange=hidden` / `beforeunload` via `navigator.sendBeacon`); SW retries with backoff.
- Auth the ingest with a token in header/body. **Never put data in URL/query params.**
- Anti-bot is a non-issue: passive observer in the user's own session. Never inject synthetic
  interactions or automate actions — do not over-engineer stealth.

---

## 6. Data schema (TypeScript — source of truth)

```ts
type TweetId = string;
type ImpressionId = string; // uuid per (tweet enters view) event

interface TweetRecord {          // content stream
  tweet_id: TweetId;
  author_handle: string;
  author_id: string;
  text: string;
  media: { type: "photo" | "video" | "gif"; url: string }[];
  is_thread: boolean;
  created_at: string;
  metrics: { likes: number; rts: number; replies: number; views?: number };
  captured_at: string;
}

interface ImpressionEvent {      // behavior stream
  impression_id: ImpressionId;
  tweet_id: TweetId;
  session_id: string;
  ts: string;                    // entry time
  position_in_feed: number;
  dwell_ms: number;              // focused + >=50% visible, accumulated
  max_visible_pct: number;
  scroll_velocity_at_entry: number;
  flicked: boolean;
  opened_detail: boolean;
  profile_expanded: "none" | "hovercard" | "clickthrough";
  liked: boolean;
  rt: boolean;
  bookmarked: boolean;
  replied: boolean;
  // confounders — CONTROL features, never reward features:
  media_present: boolean;
  is_thread: boolean;
  char_len: number;
}

interface CaptureHealthEvent {
  ts: string;
  kind: "graphql_schema_miss" | "selector_miss" | "hook_error";
  detail: string;
}
```

---

## 7. Downstream stages (build after capture works)

### 7.1 Ingest + state
Worker accepts both streams, persists to SQLite. **Raw events are append-only** — labels are
re-derived from raw events whenever labeling logic changes; never delete or mutate them.

### 7.2 Label pipeline
Session reconstruction → position-propensity debiasing (inverse-propensity weighting) →
relevance label construction. Starting label: `opened_detail OR liked OR bookmarked` = strong
positive; dwell = graded weak signal *after* debiasing; `flicked` = negative. `char_len` /
`media_present` are confounders to control for, never features that earn score.

### 7.3 Ranking engine
- **Candidate lanes** (SQL): `fresh / backlog / resurface / liked_author / explore / bookmark`.
  The `explore` lane is non-negotiable — anti-filter-bubble AND the source of low-bias training data.
- **Scorer:** v0 weighted heuristic (works day one, zero labels) → v1 learned model predicting
  `P(meaningful_engagement)` (GBT/LR) → v2 online updating.
- **Diversity:** token-overlap MMR penalty so near-duplicate takes don't cluster.
- **Hard rule:** NEVER train the learned ranker on the ranker's own output. Labels come from
  observed behavior only. This is how the system would poison itself.

### 7.4 Serve
Cron compiles a fresh ranked session in the background; the client reads the cached session
(instant). What the user reads becomes new events — the loop closes.

---

## 8. Build plan (risk-first milestones)

Build risk-first, not pipeline-order. De-risk capture before anything else. A usable
heuristic ranker ships mid-plan; the learned ranker comes only after a real dogfooding period.

| # | Milestone | Deliverable | Verification | CC mode |
|---|---|---|---|---|
| **M0** | Capture spike (throwaway) | log `{tweet_id, dwell_ms, opened_detail}` for ~20 tweets | scroll a real session; eyeball events vs. actual behavior | exploratory + investigation subagent |
| **M1** | Capture surface (hardened) | both streams, batched, independent failure modes | **golden DOM fixture**: record a session, assert exact events parsed; tab-blur + fast-scroll are explicit cases | plan mode |
| **M2** | Ingest + state | worker + SQLite, append-only events + tweet corpus | fixture tests + idempotency; assert raw events never mutate | plan mode |
| **M3** | Read loop (chronological) | minimal client rendering corpus in time order | manual — renders + pleasant to read; **start dogfooding** | default |
| **M4** | Ranker v0 (deterministic) | lanes + weighted scorer + MMR | **order snapshot tests** (fixed candidates + weights → asserted order) | plan mode |
| **GATE** | dogfood ~2 weeks | — | accumulate real labeled behavior; do NOT skip with synthetic labels | — |
| **M5** | Label pipeline | session reconstruction, IPW debias, labels | debiasing unit tests + label-distribution sanity vs. naive dwell | plan mode |
| **M6** | Ranker v1 (learned) | trained GBT/LR + **offline eval harness** | held-out replay scored NDCG@k / MAP vs. v0 baseline; v1 ships only if eval is honest AND wins | plan mode (Opus design / Sonnet impl) |
| **M7** | Iterate / online | online weight updating | only after offline eval is trustworthy | — |

**M0 kill criterion:** if signals can't be reliably extracted from the DOM, switch to the
own-client capture approach *before* investing in M1.

## 9. Verification strategy (CC: never claim done without proof)

Every change ships with a check Claude Code can run. By layer:
- **Capture:** golden DOM fixture + tab-blur/fast-scroll/virtualization cases.
- **Ingest/lanes:** fixture tests + append-only assertion.
- **Ranker v0:** order snapshot tests.
- **Label pipeline:** debiasing unit tests + distribution sanity check.
- **Ranker v1:** offline replay eval (NDCG@k / MAP) beating the v0 baseline — the gate.

> For ML code, an adversarial reviewer subagent over-reports gaps. Tell it to flag only
> correctness/requirement issues; chasing every finding over-engineers a logistic regression.

## 10. Tooling

- MV3 extension via **WXT** or **Plasmo** (TS, HMR, manifest gen, content-script bundling) —
  don't hand-roll the scaffold.
- `dev` = framework dev server · `test` = vitest (extractor + dwell logic + fixtures) ·
  `typecheck` = tsc · plus the golden-DOM-fixture test.

## 11. Resolved decisions
- Capture via **browser extension** on x.com (sensor), not an own-client reader.
- **Chrome-only** first (skip Firefox MV3 tax).
- **Impression-level** rows (re-impressions are new rows; total dwell = sum).
- Capture **both** profile-expand strengths, tagged; defer weighting to the label pipeline.

## 12. Open / tunable (settle during M0)
- Flick threshold (dwell/velocity cutoff for `flicked`).
- Session idle gap (default 30 min).
- Ingest batch size N and flush interval T.

## 13. Building this with Claude Code
1. Don't `/init` an empty repo — seed `CLAUDE.md` from the companion file (carries §5.8 + §7.3 gotchas).
2. For each milestone: plan mode → review the plan against this PRD → implement → run the
   milestone's verification → `/clear` before the next milestone.
3. Delegate DOM/codebase investigation to subagents to keep the main context clean.
4. Point review subagents at this PRD: "check the diff against PRD §<n>; report only
   correctness/requirement gaps."
5. The first real action is the M0 spike. The risk from here is polishing docs instead of
   shipping the spike — go build it.
