# actually-for-you — build progress

Point new sessions at this file + the PRD for full context.
`/plan` against PRD §<n> before touching each milestone.

---

## ▶ RESUME HERE (2026-07-14)

**M14 prospective freeze SHIPPED: the eval stack stopped grading its own homework.** Triggered
by an external methodology review (all six of its checkable findings verified against the code).
Ingest tests 98 → **113** green (extension untouched at 38). The 07-08 block below is
superseded — its "SHIP ✅" was a dev-pool read and is now advisory-only by construction.

- **The core problem:** reviews never *trained* anything, but the metric (MAP→AUC), the credit
  formula (opens+👍 → opens+👍−👎), and the baseline policy (keyword → strongest) were all chosen
  while looking at the accumulated votes. That makes the whole review pool a DEVELOPMENT set —
  no bootstrap CI on it accounts for those choices. Honest current reads, dev pool n=825
  (290👍/535👎): strongest baseline is **char_len 0.6930**; mix 0.7090 (diff CI [-0.019, +0.047])
  and rubric 0.7095 ([-0.026, +0.057]) are both statistically **TIED** with it. Interleave pilot
  final read: **TIED** at n=83 (keyword − mix CI [-0.096, 0.156]).
- **Prospective gate (eval.ts, `GATE_CUTOFF = 2026-07-15`):** votes before the cutoff print as
  REVIEW-DEV (advisory, never a verdict); only post-cutoff votes feed the SHIP/HOLD verdict.
  Cutoff moves only forward, re-frozen only on deliberate gate-design changes. Rows without a
  review_ts (fixtures) count post-cutoff; labels.ts now threads `review_ts` through LabeledRow.
- **Confirmatory interleave window (interleave.ts, `WINDOW_START = 2026-07-15`,
  `HORIZON_DAYS = 14`):** pre-window serves are the pilot and are excluded. The CI prints ONCE,
  at the horizon — the old "keep serving until the CI excludes 0" language was optional stopping
  and is gone. Floor not met at horizon → extend on n, never on the lean. TIED at the horizon is
  the window's ANSWER (freeze a new matchup to try again), not a prompt to keep running.
- **Interleave attribution fix:** votes now key to a tweet's arm-attributed FIRST serve — the
  same row opens key to. The old latest-serve-before-vote join could credit an open to arm A and
  the vote to arm B after a cross-arm re-serve (latent, hadn't corrupted the pilot votes; test
  added). Same-votes-qualify proof: "first serve ≤ vote" ⟺ "some serve ≤ vote" (scorecard's
  doctrine).
- **Scorecard honesty fix:** junk@K is now 👎/**judged** at the cut (a no-vote day reads
  "no votes", never a fake 0%), with a `judged` coverage column (98/648 lifetime — read every
  rate with it). Honest lifetime junk@10: 51.5% (17/33 judged) — the old per-serve number
  understated it by ~3×.
- **Renamed, not just relabeled:** the ✧ audit pool is a ranker-BLIND-SPOT read (sampled from
  what the rankers rejected — no arm scored those cards into the slate), NOT "serve-bias-free":
  eligibility is conditioned on non-selection. Still the read the ranker can't flatter; still
  thin (2👍/5👎).
- **User's parallel jobs:** vote daily (✧ cards especially); DON'T peek at the interleave lean
  before the day-14 read; the gate verdict returns when ~40 post-cutoff votes accumulate.

### OPEN DESIGN QUESTIONS — for the NEXT deliberate re-freeze, NOT this window

These are recorded to preserve the thought, not to act on. Each was raised **after** seeing a
result, so acting on any of them now = laundering a loss into a metric change (the exact thing the
prospective freeze exists to stop). Resolve only at a deliberate re-freeze: decide on principle,
write the reasoning **before** re-running, move `GATE_CUTOFF` forward, and re-earn the verdict on
fresh post-cutoff votes.

1. **Is `char_len` a fair strongest-baseline? (raised 2026-07-15, after the n=210 HOLD)**
   `char_len` is a confounder *control* — regressed in at train, **dropped at predict**, so the
   ranker is forbidden from using length. The gate then makes it the bar to beat. Question: is
   "beat a signal you're banned from using" the right guardrail, or should `char_len` be demoted to
   a *reported confound* with the bar set to the ranker's own domain (keyword / recency /
   author-prior)?
   - **Evidence that motivated it (so a future reviewer can weigh the bias):** over all 1,147
     votes, `rubric` beats `char_len` in *every* length band — <200: 0.667 vs 0.632; 200–600:
     0.636 vs 0.523 — yet **ties in aggregate** (0.721 vs 0.703). Classic Simpson's paradox: the
     all-pairs metric is dominated by the between-band length axis, which `char_len` owns for free
     and the ranker (banned from length) can only approximate. The length-band advisory cut shows
     the same thing (`rubric` diff-CI vs recency excludes 0 in-band).
   - **The counter-argument that keeps it as-is:** if a dumb length heuristic predicts the votes as
     well as the model, then on *this* pool the model isn't adding predictive value, and a
     conservative guardrail is right to say so. Both sides are legitimate — this is a genuine design
     call, not a bug.
   - **Honesty check before acting:** would this critique have been written down *before* it was
     known to be the thing beating the ranker? If it can't be answered yes, weight it accordingly.
   - **Does not block anything now:** the interleave uses a different baseline (keyword) and metric
     (served credit), is not length-dominated, and remains the verdict-maker regardless.

2. **Is the review UI biasing the votes? — blind the judge (raised 2026-07-15)**
   The judge is not blind: at vote time the UI displays cues correlated with exactly the axes
   under debate. Channels found in code, not hypothesized: (a) review mode prints "⏱ Xs lingered"
   above the vote buttons (client.html) — dwell is mechanically length-correlated, so every
   review-mode vote is anchored on a length proxy; (b) in-flow digest votes see the rank number,
   ✦ score percentile, and mix-parts tooltip — anchoring on the arm's own opinion inflates the
   arm's measured AUC (note: this one biases FOR the ranker); (c) ✧ cards are labeled "outside
   your taste profile" at vote time, so the blind-spot pool is judged knowing the ranker rejected
   it; (d) selection: the review queue is the extreme tail of trusted-dwell sorted DESC over a
   backlog thousands deep — the 12%→50%→94% up-rate-by-length curve is measured on a pool
   already selected by a length-correlated variable.
   - **Pre-registered prediction (written before any post-change data exists):** if the anchoring
     is real, blinding the judge — hide the dwell line, score badge, rank, and lane label until
     after the vote — should FLATTEN the length–uprate curve and shrink char_len's aggregate AUC
     on post-blinding votes. If votes are pure taste, the curve should not move. Direction is
     declared now precisely because this change would help the ranker against char_len — the
     motivated-reasoning risk is the same as question 1 and gets the same treatment.
   - **What shipped now (2026-07-15, observational only):** every vote now records what the judge
     saw — `reviews.ui_context` JSON: surface (`digest`/`explore`/`review`), rank/pos,
     shown_score, shown_dwell. Metadata for future stratification; nothing reads it at rank,
     label, or eval time. Votes before today have `ui_context = NULL` (unknowable, kept honest).
   - **What waits for the re-freeze (post-horizon):** the actual blinding. Votes feed interleave
     credit, so a mid-window UI change touches the verdict-maker's inputs; ship it when moving
     `GATE_CUTOFF`, note the date, and treat pre/post-blinding votes as separate strata.
   - **Comfort:** the interleave compares arms under the SAME UI, so presentation bias mostly
     cancels arm-vs-arm; the contamination story mainly touches the gate's length contest.

3. **"Spent dev currency" amendment — pre-cutoff reviews become training labels for a dev-trained
   arm (recorded 2026-07-15, BEFORE the review-lr eval run per this block's own rule).**
   CLAUDE.md's gold-label invariant is amended: hand-signed 👍/👎 votes at-or-after `GATE_CUTOFF`
   remain the ONLY non-circular gold, untouchable, nothing trains on them. Pre-cutoff votes —
   previously read-only dev/advisory rows — are now also usable as TRAINING labels for arms
   explicitly named as dev-trained (first instance: `review-lr`, a logistic regression over
   [MiniLM embedding + rubric + taste cosine + author prior], char_len/media/thread as train-only
   confounder controls, `review_lr.py`). The arm is scored over the whole review pool and gated
   the normal prospective way: its dev-pool (`REVIEW-DEV`) row is a train-set read (the arm has
   literally seen those labels) and can never verdict; only its post-cutoff `REVIEW-PROSPECTIVE`
   row is non-circular, because `review_lr.py` asserts (hard fail, not a soft check) that its
   train set is a strict subset of pre-cutoff rows only.
   - **`GATE_CUTOFF` does NOT move.** The gate design itself — the AUC metric, the credit formula,
     the strongest-baseline policy — is unchanged and untouched by this amendment. This only adds
     one new arm whose training labels are strictly pre-cutoff; the prospective gate's non-circularity
     argument for every existing arm (none of which train on anything) is undisturbed.
   - **Why this doesn't reopen the freeze:** the freeze's purpose was "no design decision may see
     the votes it is later judged against." `review-lr`'s design (feature set, C grid, standardization)
     was fixed before dev labels were fit; only the LR *weights* see pre-cutoff votes, and the
     prospective split still keeps post-cutoff votes untouched by that fit. Same boundary, one more
     kind of thing sitting on the dev side of it.

---

## 2026-07-08 state (M13 rebuild) — superseded by the 2026-07-14 prospective freeze

**M13 evals rebuild SHIPPED (user-approved): AUC pair gate + net-credit interleave + scorecard /
judge table / recall probe.** Ingest tests 79 → **98** green (extension untouched at 38). Built by
three parallel Opus subagents with the main session orchestrating and independently verifying
(merged full suite, real-db read-only runs, numbers reconciled against a pre-build probe).
CLAUDE.md's ship-gate section rewritten to the new contract. The M11 interleave clock is UNTOUCHED
and stays the verdict-maker — ~2 weeks + the 30-judged-event floor (16/30 as of today).

- **Why the gate was rebuilt:** pooled-MAP discarded ~20% of gold to 50/50 balancing, scored only
  the head of one shuffled pool, and silently credited tweet_id tiebreaks — keyword's integer
  scores TIE on ~27% of 👍/👎 pairs (and 52% of 👎s are keyword-topical junk it promotes). New
  gate = pairwise preference accuracy: AUC = P[score(👍) > score(👎)] over ALL hand-signed pairs,
  paired item bootstrap (B=2000), three cuts (ALL = gate; keyword-tied = advisory "value keyword
  can't see"; ✧ audit = serve-bias-free, M12 doctrine intact). Pre-build probe evidence: on the
  same votes where MAP said "tightest tie yet", rubric AUC 0.705 vs keyword 0.626, diff CI
  [+0.023, +0.132] — the tie was the instrument, not the arms.
- **Gate reading (n=465: 191👍/274👎, coverage 465/465): SHIP ✅ — TWO clearers, rubric champion.**
  rubric 0.7077, diff CI **[+0.025, +0.129]**; mix 0.6963, diff CI [+0.006, +0.125]; taste tied
  with keyword; both clearers also beat char_len (0.6748) point-wise. Guardrail read ONLY — do
  NOT re-weight or tune against it; the interleave decides (early lean agrees — mix 12 credits
  vs keyword 2, both day-wins — but 16/30 judged events = officially insufficient). Pure rubric
  edging the mix is an ONLINE question for a future matchup (rubric vs mix) after the current
  mix-vs-keyword read concludes — not a weight-tuning prompt.
- **Coverage gap CLOSED same day:** `npm run rubric` scored 500 (26 review-pool + 474 candidates,
  one batch retry) → 465/465 at sha `95de0c7e`; the −1 sentinel drag is gone (rubric arm 0.672 →
  0.7077). The gate line above IS the post-scoring read.
- **Judge table (new, per rubric_sha):** generic `dd6304` AUC 0.687 → personalized `8ff3d8ea`
  **0.724** → latest `95de0c7e` 0.708 (the only row at full 465/465 coverage; v1's 0.724 sits on
  its own 421-row subset, so the v1-vs-v2 gap is suggestive, not comparable). Personalization
  genuinely helped over generic. OBSERVE ONLY — the printed warning is the doctrine: never
  iterate RUBRIC.md against this table.
- **Interleave credits fixed (same clock, same floor):** credits = opens + 👍 **− 👎**, may go
  negative. Downs are ~60% of all judgments and opens are structurally rare (7 ever) — the old
  formula collapsed days toward 0–0 ties. Floor/CI/TIED doctrine unchanged.
- **New daily instruments:** `npm run scorecard` — per-digest-day report card (junk@10/@20 with
  their n, hits, opens, ✧-vs-core votes; day-1 story: junk@10 72.7% on 07-06 → 12.5% on 07-07).
  `npm run recall [-- --days=N]` — the miss detector; day-1 finding: 49 organic engagements in
  7d, 100% captured, **0 ever served by the digest first** (partly structural — 3 days of
  digest_log, and engaged tweets are excluded from future digests — watch the trend, not the
  absolute).
- **User's parallel jobs:** vote daily (✧ explore cards especially — the audit pool is 0👍/2👎);
  let the interleave accumulate before believing any lean.

---

## 2026-07-07 state (pre-M13 rebuild) — superseded

**Models/evals rethink SHIPPED (user-approved), M11 interleave LIVE, M12 audit pool in place.**
The offline gate is now a guardrail; the interleave is the verdict-maker. Let data accumulate
~2 weeks — do NOT re-weight or tune against any pool meanwhile.

- **Rethink phase ✅ 2026-07-07** — (1) reviews are 100% test (no arm trains on gold; v1 LR
  demoted to behavioral-only training): balanced gate n=88 → **n=290**. (2) Every review-pool arm
  gets a paired (arm − keyword) bootstrap diff CI; SHIP generalized to any candidate and requires
  the diff CI to exclude 0. (3) `zscores` winsorize at ±2 (`Z_CLAMP`): the zero-inflated author
  prior minted ±5σ outliers that swamped the blend (M10 live evidence: rank-1 at 78% author part);
  landed BEFORE interleave activation so the experiment measures the fixed mix. (4) Default eval
  output = review gate only; `npm run eval -- --all` prints the confounded supplementary pools.
- **Gate verdict (2026-07-07, n=290, rubric coverage 290/290): HOLD ⛔ stands.** Keyword MAP
  0.6493 [0.574, 0.724], NDCG@10 1.0000. **v1 LR is dead for real** — MAP 0.3918, diff CI
  [−0.328, −0.180] excludes 0 (below random; five losses running, now at real n). **Rubric is the
  best candidate: MAP 0.6351 [0.553, 0.726], diff CI [−0.082, +0.061] → statistically TIED with
  keyword on the GENERIC starter rubric.** Taste 0.6052, mix 0.6066, both tied-ish. The n=88
  "recency beats keyword" scare washed out at n=290 (pool-composition artifact, as suspected).
- **Rubric scorer stall root-caused + fixed ✅** — at the 08:00 window the claude CLI rides out
  multi-minute API backoff; the 120s SIGTERM killed healthy-but-throttled calls (CLI ignores
  SIGTERM — 14-min zombie sessions observed), two kills tripped the abort, coverage decayed.
  Fix: `CALL_TIMEOUT_MS` 120s → 600s + `killSignal: SIGKILL`. Review pool re-scored to 290/290.
  OPTIONAL second daily scoring window: a ready-made `com.afy.rubric.plist` (20:00, idempotent
  retry) was drafted but NOT installed (permission classifier flagged new launchd persistence —
  correctly); user installs by hand if wanted (see chat 2026-07-07).
- **M11 ✅ ACTIVATED 2026-07-07** — server restarted; live serve verified: digest_log rows carry
  `arm` (22 mix / 23 keyword drafted, explore stays arm=null). The interleave clock starts NOW;
  `npm run interleave` reads a verdict after ~2 weeks + the 30-judged-event floor.
- **M12 ✅ built 2026-07-07** — review labels carry `served_lane` (VOTE_SERVE convention);
  eval prints a REVIEW-EXPLORE audit pool: votes on ✧ day-hash-sampled cards are the only labels
  no ranker selected → immune to serve-selection bias (the main pool drifts toward the serving
  arm's own audit log as digest votes accumulate). Diagnostic for now (REVIEW_MIN_N floor);
  today n=0 balanced — it grows exactly as fast as ✧ cards get voted (~5 served/day).
- **RUBRIC.md personalized ✅ 2026-07-07 (sha 8ff3d8ea)** — derived from the owner's OWN curation
  (harvested likes/bookmarks + prune reasons; NEVER the review pool — that would leak the gate).
  Key deltas: curated resource/reading lists are top-tier (the generic anti-listicle rule fought a
  demonstrated bookmark habit); agent-tooling craft + frontier-lab career intel first-class; hard
  0–2 topic floor on crypto/memecoin/trading. Re-scored 540 tweets (review pool first).
  **Verdict at n=352, coverage 339/352: HOLD stands; rubric MAP 0.6442 vs keyword 0.6490, diff CI
  [−0.066, +0.067] — the tightest tie yet, still not a win.** Personalized ≈ generic ≈ keyword
  offline; the discriminating tests are ONLINE (interleave) and the audit pool. Doctrine: do NOT
  iterate RUBRIC.md against the gate — next rubric edit should come from lived digest experience,
  not from chasing MAP.
- **User's parallel jobs:** vote daily, ✧ explore cards especially (they are the audit pool —
  still n=0 balanced); optionally install the second scoring-window plist (see chat 2026-07-07).

Token auth + read-receipt digest are LIVE. M7–M11 history below; CLAUDE.md's ship-gate section
was updated to the new contract (guardrail + CI-gated SHIP + interleave as verdict-maker).

- **Gap 5 ✅ live** — in-flow 👍/👎 on digest cards; reviewed tweets leave the feed. Vote on
  ✧ explore cards too, or the review pool skews toward taste-lane picks.
- **M7 ✅ live-verified 2026-07-04** — poller at 30-min cadence; 700+ `source='poll'`
  candidates on day one; invariant holds (0 impressions on polled tweets). Dogfood verdict on the
  pinned tab: **rejected** (user kept closing it; poller kept recreating it — four `created`
  ticks in 2 h on 2026-07-04). Reworked same day to an **ephemeral tab**: each tick opens an
  unpinned background x.com/home tab and a `afy-poll-close` alarm closes it ~2 min later
  (skipped if the user grabbed it — then it's disowned and becomes organic). Needs
  build.sh + extension reload to go live.
- **M8 ✅ built + activated 2026-07-04** — rubric scorer runs on the user's Claude subscription
  (`claude -p`, CLAUDE_BIN pinned in .env.local); daily 08:00 job scores before the digest;
  review pool fully scored (52/52, starter rubric sha dd6304). RUBRIC.md personalization still
  pending (free re-score lever whenever the user edits it).
- **M9 ✅ built + live 2026-07-05** — digest ranks by the weighted mix (see the M9 section note);
  server restarted, live payload verified (parts sum to score; unscored rubric renders +0.00).
- **M10 ✅ built + live 2026-07-06** — every `/digest` serve appends digest_log rows
  (rank/lane/channel + serve-time score/parts); `openTweet()` fires token-authed open receipts;
  daily.ts's teaser logs as channel `imessage`; `npm run funnel` reports opens + votes by
  lane/rank and mean mix parts by verdict. Server restarted, first live serve verified logging.
  Pre-M10 votes (n=70) have no serve context — from today, votes land attributable.
- **M11 🔨 in flight 2026-07-07** — team-draft interleaving (mix vs keyword) on the live digest,
  blind + deterministic, `arm` column on digest_log, `npm run interleave` verdict with CI +
  judged-event floor. See the M11 roadmap section. While it builds and after: let funnel +
  interleave data accumulate over dogfood days — verdicts need ~2 weeks and the judged-event
  floor; do NOT re-weight against the n=70 pool.
- **User's parallel jobs:** personalize RUBRIC.md (then `npm run rubric` re-scores under the new
  sha), and vote daily — ✧ explore cards especially (the serve-bias antidote).

**Gate verdicts (2026-07-06, balanced n=70, rubric coverage 70/70):** dogfood day 1 added 71
hand-signed reviews (30👍/41👎) — the pool jumped 52 → 70 and got HARDER for everyone: keyword MAP
0.7449 → **0.6646** [0.506, 0.806] (NDCG@10 0.8512), still the champion, HOLD ⛔ stands. Rubric
(still the GENERIC starter, sha dd6304) nearly ties keyword on MAP now: **0.6564** [0.486, 0.820].
**Mix slipped BELOW its own components: MAP 0.6025 vs rubric 0.6564 / taste 0.6273** (at n=52 it
beat both). Two candidate explanations, unresolved: (a) **serve-selection bias** — the new reviews
were signed ON mix-ranked digest cards, so 👎s concentrate in the mix's own high-scoring region;
the served ranker gets penalized hardest by its own served mistakes, an asymmetry the other arms
don't face (M10's digest_log is what would let us quantify this); (b) the author prior over-serves
prolific liked authors and ate 👎s. ALL CIs overlap heavily — still statistically tied territory.
Do NOT re-weight against this pool (n=70 is still fitting-noise range); the principled levers are
M10 (serve attribution), RUBRIC.md personalization (free, untouched), and more ✧ explore votes
(counteracts the serve bias). At n=52 the mix beat all components (MAP 0.7296) — that reading
stands in the M9 note. Tests: **52 ingest** green (extension untouched at 38).

---

## M7–M10 roadmap (2026-07-03) — the backscroll build-out

Gap analysis vs [backscroll](https://sdan.io/projects/backscroll): Surya's blocker is the honest
eval — which we already have (the M6 gate). Our gaps are acquisition and scoring breadth. Four
phases, in order; each phase ends tests-green and stops for user approval. Fine-grained file-level
choices are re-derived from live code at build time; this section fixes goals, design decisions,
invariants, and acceptance.

### M7 — Independent candidate acquisition (poller tab)  ✅ BUILT 2026-07-03 (live dogfood pending)

> Built by Opus subagent, independently verified: extension 33/33 (was 28), ingest 30/30 (was 25),
> `build.sh` clean, poller wiring confirmed in `dist/`. Deviations from plan, all sound:
> (1) NO `tabs` permission needed — host_permissions already exposes `tab.url` for x.com tabs;
> (2) poll policy lives in a new pure module `content/poll-source.ts` (tagTweets/shouldEmitImpression),
> wired at the emit seams in `content/index.ts` — injected hook untouched;
> (3) server upgrade uses INSERT OR REPLACE gated by strict source-rank comparison (net>dom>poll),
> which also closed the old cross-batch dom→net ponytail gap. SW alarm/tab plumbing has no unit
> tests (would need a chrome mock harness) — verified by live dogfood instead.
> Activation = the same two pending steps below; to force a fast tick, in the SW devtools console:
> `chrome.alarms.create("afy-poll",{periodInMinutes:0.1})` (reverts to 30 min on next SW restart).
> Verify: background x.com tab appears unfocused and self-closes ~2 min later; `poll_tick` rows in
> capture_health (each `created` followed by a `closed`);
> `SELECT COUNT(*) FROM tweets WHERE source='poll'` climbs; impressions JOIN poll-tweets stays 0.
> **2026-07-04 dogfood rework:** permanent pinned tab rejected in dogfood (closing it triggered
> recreate-next-tick, forever). Now ephemeral: tick creates unpinned background tab → 2-min
> `afy-poll-close` alarm closes it (never if active; then it's disowned → organic). Known hole,
> accepted: quit Chrome inside the 2-min window + session restore → one orphan tab, once, closable.

**Problem:** we only rank tweets the user happened to scroll past — X's algorithm is still the
upstream gatekeeper of what's even eligible. Backscroll pulls ~2,600/day on its own.

**Design (lazy path: reuse the ENTIRE existing capture pipeline; zero API replay):**
- SW alarm (~30 min; `alarms` permission already granted) opens a short-lived, never-focused
  background `x.com/home` tab (id in `chrome.storage.session`); a second one-shot alarm closes
  it ~2 min later — skipped (and the tab disowned) when `tab.active`. The page fetches its own
  timeline with perfect first-party headers; the injected hook captures it exactly like an
  organic visit. No query-ID forgery, no bot-pattern API calls, nothing to rot when X rotates
  GraphQL internals (capture invariants hold: op-name matching stays untouched).
  *(v1 kept one permanent pinned tab and reloaded it — rejected in dogfood 2026-07-04, see above.)*
- Content script asks the SW at `document_start` "am I the poller tab?" (sender.tab.id vs stored
  id). If yes: tag outgoing tweets `source:'poll'` and DROP all impressions from that tab (belt;
  the existing `document.hidden → dwell.pauseAll()` gate is the suspenders). The ms-scale race
  before the answer arrives is harmless — dwell is visibility-gated anyway.
- `tweets.source` already exists (`'net'|'dom'`): add `'poll'` at the BOTTOM of the clobber
  precedence — organic capture upgrades a polled row, poll NEVER overwrites `net`/`dom`.
- Poll health: emit a `capture_health` event per tick (`kind:'poll_tick'`, tweet count) —
  breakage must be loud, silence must be diagnosable.

**Acceptance:** both suites green incl. new tests (poller tag + impression drop; source
precedence; server stores `'poll'`); after reload+restart, `afy.db` accumulates `source='poll'`
rows within an hour of normal laptop use.
**Non-goals:** Following-vs-ForYou tab control, cursor pagination, poll-rate tuning, night idling.

### M8 — LLM rubric scorer (the qualityWeight)  ✅ BUILT + ACTIVATED 2026-07-04

> Built by Opus subagent, independently verified: 47/47 ingest tests, real-db schema/integrity
> confirmed clean post-build, live smoke on a scratch copy before touching the real db. Activated:
> `CLAUDE_BIN` pinned in `.env.local`, review pool scored 52/52 + ~200 candidates (sha dd6304,
> model haiku, ~20 tweets/call sequential). First honest verdict in the RESUME block above —
> generic rubric already ~doubles the learned models' MAP but keyword keeps the gate. Next lever
> is FREE: personalize RUBRIC.md → `npm run rubric` (sha changes → full re-score) → `npm run eval`.
> M9 note: eval's missing-score sentinel (−1, ranks-last) is EVAL-ONLY — the M9 mix must treat
> missing rubric scores as z=0 neutral, never −1.

**Problem:** TF-IDF cosine can only say "familiar", never "good" — a great tweet on a novel topic
scores ~0 and only the explore lottery can surface it. Backscroll's `qualityWeight` is an LLM
grading each tweet against a personal rubric.

**Design:**
- `RUBRIC.md` (committed — taste philosophy, not a secret): starter scaffold, user edits freely.
- `ingest/rubric.ts` CLI (`npm run rubric`): scores UNSCORED tweets **text-only** (no author, no
  metrics — quality must not proxy fame) in sequential batches of ~20/call by shelling out to the
  local **`claude` CLI headless** (`claude --model haiku -p …` — the user's Claude subscription;
  NO API key; zero-dep via node:child_process). Verified live 2026-07-04: haiku answers but wraps
  JSON in ```-fences — parser strips fences before JSON.parse, one retry per bad batch, then skip
  loudly. `CLAUDE_BIN` in `.env.local` overrides the binary (launchd PATH lacks `~/.local/bin` —
  pin the absolute path there). Quota exhausted / CLI missing → run skips loudly, resumes next
  time; scores are optional everywhere downstream. Integer 0–10. Scoring ORDER: review-pool
  tweets FIRST (the eval arm is meaningless without coverage — eval prints rubric coverage % next
  to its verdict), then recent candidates newest-first. Quote tweets (2026-07-04 `quoted_id`
  work): the scoring payload includes the quoted text when captured (`attachQuoted` pattern) —
  a "this." quote-tweet is meaningless text-only, its substance IS the quote. Quoted AUTHOR
  still excluded (no fame proxy). Append-only `rubric_scores(tweet_id, score, model, rubric_sha, ts)` —
  `rubric_sha` keys each score to the rubric version that produced it; re-scoring after a rubric
  edit is a new append, never an update.
- `daily.ts`: score new tweets before the digest builds (cap ~500/run; Haiku cost ≈ pennies/day).
- `eval.ts`: new arm **"rubric"** — rank the review pool by rubric score, print vs keyword with
  the same bootstrap CIs. THE question this phase answers: does an LLM judge beat keyword on the
  honest gate, where the bigram LR and embeddings both lost?
- NOT in this phase: wiring rubric into the digest. That's M9 — measure before shipping.

**Invariant (now in CLAUDE.md):** rubric scores are FEATURES, never label sources — the
AI_LEXICON rule one layer up. An LLM-labeled eval pool would be circular for any LLM-scored ranker.
**Acceptance:** tests green (scorer parses/appends on a mocked API; schema; eval arm on fixture
db); `npm run eval` prints the rubric verdict honestly — a HOLD is a real result.

### M9 — Weighted mix with named knobs (the recipe)  ✅ BUILT + LIVE 2026-07-05

> Built in the main session (inverse of the M7/M8 pattern), adversarially reviewed by a subagent
> against this section + CLAUDE.md: **PASS, zero findings** (it independently re-derived the
> snapshot-test math and attacked the leak-guard SQL). 51/51 ingest tests green. Key build facts:
> (1) `mixFinal` in digest.ts is THE formula — eval's mix arm calls the same function, so digest
> and gate can't diverge; z-scores are pool-relative, missing rubric → exactly 0 (eval's −1
> rank-last sentinel stays confined to the pure-rubric arm). (2) **Leak guard added:** 18 tweets
> are both liked AND hand-reviewed; buildTaste + buildAuthorPrior now exclude reviewed tweets
> (verdict-blind membership exclusion — labels.ts precedent), else the eval taste/mix arms score
> gate rows against their own profile text. Costs ≤18 of ~1,900 profile texts. (3) Taste-lane
> entry filter generalized `cosine>0` → `mix z>0` (above pool mean); explore mechanics untouched.
> (4) The eval also gained a "taste (digest cosine)" arm — the pre-M9 status quo the mix must
> justify itself against. Deferred, flagged by review: no (mix − keyword) bootstrap diff CI yet —
> add one BEFORE ever treating the mix line as a gate verdict. Author-prior /max normalization
> skipped as a documented no-op (z downstream is scale-invariant). The pre-existing
> liked+bookmarked double-count in the taste profile (40 tweets, ~1.4%) was FIXED same-day in the
> follow-up: buildTaste GROUP BY tweet_id + profile_size COUNT(DISTINCT) — positives are a SET
> (labels.ts convention); gate re-run: mix unchanged at 4dp, HOLD stands, 52/52 tests.

**Problem:** one score = no knobs. Backscroll ranks by a weighted blend plus lane shares.

**Design:**
- Author prior from `engagement_labels` ONLY (`log1p(count)` per author, normalized) — **NEVER
  from `reviews`**: reviews are eval-only gold; features derived from them leak the gate.
- `digest.ts`: `final = W.taste·z(cosine) + W.rubric·z(rubric) + W.author·z(author_prior)` with
  weights as named consts (start 0.5/0.3/0.2). Missing rubric score → z=0 (pool-neutral).
  Explore lane unchanged (~10%, interleaved).
- `eval.ts` arm **"mix"** (same formula on the review pool). Gate discipline: pick defaults,
  eval ONCE, report — no weight grid-search against the small-n pool (that's fitting noise).
- Client: taste badge tooltip shows the component breakdown (tiny).
- Stretch (default SKIP): bookmark-similarity lane à la backscroll's 18% — only if bookmark
  labels are plentiful by then.

**Acceptance:** snapshot test (fixed candidates + weights → asserted order); eval prints keyword /
v1 / rubric / mix side by side; tests green.

### M10 — Digest feedback instrumentation (own-feed telemetry)

> **Built + live 2026-07-06.** As specced, plus serve-time `score`/`parts` on every digest_log
> row: component attribution ("were the 👎s on high-author-prior cards?") is NOT reconstructable
> later — profile/prior/rubric all drift daily — so it's captured at serve. No second write path
> for iMessage: daily.ts's teaser fetch tags `?channel=imessage` (that one-card serve IS the send
> list). Funnel semantics: exposure = FIRST logged serve per tweet (reloads re-log, the report
> dedupes); opens count only at-or-after first serve; a vote attributes to the latest serve
> at-or-before it, latest verdict per tweet (labels.ts convention); votes with no prior serve
> (review mode, all n=70 pre-M10 votes) are excluded as context-free. First live serve
> immediately produced signal: rank-1's score was 78% author part (z-blowup — most of the pool
> has prior 0, so any liked author is a huge outlier), serve-time evidence for hypothesis (b) in
> the day-1 gate reading; the funnel's parts-by-verdict table now measures it. Tests 52 → 62.

**Design (append-only, additive schema):**
- `digest_log(digest_date, channel 'web'|'imessage', tweet_id, rank, lane, ts)`: written on every
  `/digest` serve and by `daily.ts` for the iMessage send list.
- `digest_opens(tweet_id, ts)`: `client.html` `openTweet()` fires a token-authed
  `POST /digest/open` (fire-and-forget, same pattern as votes).
- `npm run funnel`: opens/impressions by lane, rank curve (position bias), votes by lane.
- NOT in this phase: interleaved A/B ranker comparison — that's the M11 candidate, and it needs
  M10's data first.

**Acceptance:** tests green (serve logs rows; open endpoint appends; funnel runs on a fixture
db); a day of dogfood shows web serves + opens accumulating in `afy.db`.

### M11 — Interleaved online comparison (team-draft on the live digest)  ✅ BUILT 2026-07-07

> Built by Opus subagent. **Activation-pending** (needs a server restart — the additive `arm` column
> only lands on `afy.db` when the running server re-execs its schema block). Ingest tests **62 → 74**
> green (new `interleave.test.ts` = 11: team-draft determinism snapshot + arm attributions, MATCHUP=null
> byte-identical regression, explore-survives, no-cross-team-dup, and the report math — credit counts,
> day-wins, floor refusal <30, TIED-when-CI-contains-0, LEAN-when-it-excludes-0, arm-null explore never
> credited, arm-less-db tolerated; + 1 server.test.ts row proving digest_log serves carry `arm`). The
> M9 `digest.test.ts` snapshots were pinned to `matchup:null` (they assert M9 *mix* order; the
> interleaved slate has its own snapshot) — that pinning IS the byte-identical proof the plan wanted.
> Key build facts / deviations, all sound:
> (1) `MATCHUP: readonly [Arm,Arm] | null` in digest.ts, set `["mix","keyword"]`; `buildDigest` gained
>     an optional `matchup` override (defaults to the const) purely for testability — `null` runs the
>     literal pre-M11 code path, arm=null everywhere.
> (2) Arm registry `ARM_SCORERS` over the SAME filtered pool: `mix`=mixScores final, `keyword`=AI_LEXICON
>     hit count (imported from labels.ts — a RANKING signal, never a label), `taste`=the taste part
>     alone. Each arm's list is MMR-`diversify`d (borrowing `.score` for the relevance term, then the
>     true mix score/parts are restored — blind serving intact), then team-drafted. Stable tweet_id
>     tiebreak (eval.ts convention) so the integer-valued keyword arm's many ties order deterministically.
> (3) `teamDraft` seeds a mulberry32 PRNG off the digest `seed` (same determinism doctrine as the
>     explore-lane hash — NO Math.random/Date.now); per round the PRNG picks which team drafts first,
>     each team takes its top not-yet-taken candidate, the drafting arm is stamped on the slot, a `taken`
>     set guarantees no tweet is drafted twice. Explore lane, fragment filter, exclusions, attachQuoted,
>     read receipts: UNTOUCHED (explore stays arm=null, ~10%, interleaved).
> (4) server.ts: additive `arm TEXT` on digest_log (CREATE + the ALTER migration pattern), threaded
>     through `logServes`; the /digest handler passes item.arm; daily.ts unchanged (its teaser serves
>     through the same path, so `arm` flows into its imessage rows automatically — verified).
> (5) `interleave.ts` + `npm run interleave` (read-only): per-arm serves/opens/👍/👎 via the funnel's
>     FIRST_SERVE/VOTE_SERVE conventions scoped to arm-attributed rows; credits = opens + 👍; day-level
>     wins; paired seeded-bootstrap CI over DAYS on the credit-rate diff (eval.ts's PRNG shape); prints
>     TIED when the CI contains 0 (incl. the degenerate [0,0] of identical arms), refuses any verdict
>     below **30 judged events** (opens+votes) with a loud line, always prints coverage. Tolerates a db
>     predating the `arm` column read-only (PRAGMA check → empty report, like eval's missing-table guard)
>     — so day-one `npm run interleave` on the real db prints the insufficient-data line, verified.
> **Activation:** restart the server (`launchctl kickstart -k gui/$(id -u)/com.afy.ingest`); the next
> `/digest` serve writes arm-attributed rows. After ~2 weeks of dogfood + the 30-judged-event floor,
> `npm run interleave` prints the first lean. (Client UNCHANGED — blind serving; the ✦ badge is mix
> score/parts computed pool-wide, so it can't leak which arm drafted a card.) Do NOT re-weight against
> the n=88 review pool meanwhile.

**Problem:** the gate is offline and small-n; the funnel is observational. Neither answers "which
ranker serves ME better, on my own feed, judged by my actual reading?" — the online eval
backscroll's last paragraph wants. Interleaving answers it with position bias cancelled by
construction, weeks sooner than the review pool can grow.

**Design (team-draft interleaving, blind, deterministic):**
- **Matchup pinned by a named const in digest.ts**: `MATCHUP: [armA, armB] | null` (null = plain
  mix digest, today's behavior). Arms come from a tiny registry over the SAME candidate pool +
  exclusions: `'mix'` (current mixScores final) | `'keyword'` (AI_LEXICON hit count — reuse the
  lexicon from labels.ts) | `'taste'` (cosine part alone). **First matchup: mix vs keyword** —
  the offline champion meets the product ranker online.
- **Team-draft over the non-explore slots**: each arm ranks the pool (each list diversified with
  the existing MMR first); per round the pick order comes from a PRNG seeded on the digest
  `seed` (= digest_date — deterministic per day, same pattern as the explore hash; no
  Math.random); each team drafts its top not-yet-picked candidate; the slot records which arm
  drafted it. **Explore lane untouched** (~10%, interleaved, arm=NULL — the invariant survives).
- **Blind serving — no UI difference between arms.** Every candidate gets mix score/parts
  computed pool-wide regardless of drafting arm, so the ✦ badge renders identically; nothing in
  client.html may reveal (or vary by) the drafting arm, or the votes it collects are biased.
- **Attribution**: `digest_log` gains a nullable `arm` TEXT column (the additive-migration
  pattern in server.ts already exists for exactly this). Serve rows carry it; opens/votes join
  through the funnel's existing FIRST_SERVE / VOTE_SERVE conventions.
- **`npm run interleave`** (new interleave.ts, read-only): per-arm serves, opens, 👍/👎 with the
  funnel's join semantics; credits = opens + 👍 on arm-attributed serves; day-level wins;
  paired seeded-bootstrap CI on the credit-rate diff (eval.ts pattern). Prints TIED when the CI
  straddles 0, and refuses a verdict under a floor (<30 judged events → "insufficient data",
  loudly). Coverage counts always printed.
- daily.ts untouched: the iMessage teaser serves from the same slate; `arm` flows into its
  digest_log rows automatically.

**Invariants:** interleaving COMPARES rankers, it never mints labels (votes stay the only gold,
opens stay comparison-only signal); the keyword arm on the product surface is still never a label
source; explore lane survives; schema changes additive only; deterministic per digest_date.

**Acceptance:** ingest tests green incl. new ones (team-draft determinism snapshot — fixed
candidates + seed → asserted slate AND arm attributions; explore lane unchanged; report math on
a fixture db with synthetic opens/votes; verdict floor honored). Live: a served digest writes
arm-attributed rows; `npm run interleave` on the real db prints insufficient-data (expected on
day one). Verdict timeline: ~2 weeks of dogfood, judged-event floor before any lean is printed.

**Non-goals:** >2 arms per matchup, bandits/adaptive traffic, weight learning, opens-as-labels,
propensity-corrected training, any client UI change.

### M12 — Models/evals rethink + serve-bias-free audit pool  ✅ BUILT + LIVE 2026-07-07

> Built in the main session, user-approved as a package ("rethink the current models and evals").
> Ingest tests 74 → 79 green. Four commits: M11 commit, rethink phase, rubric scorer fix, M12.

**Problem:** the gate starved (70% of gold spent training an LR that lost five straight readings,
below random), the review pool inherits the serving ranker's selection bias (votes land on served
cards → the pool drifts toward "the mix's audit log" — the n=88 "recency beats keyword" scare was
this), the author prior z-blew-up (M10: rank-1 at 78% author part), and rubric coverage silently
decayed when the 08:00 scorer died (120s SIGTERM vs multi-minute API backoff).

**Design (mostly deletions / demotions):**
- Reviews 100% test (`splitByTime` routes review kinds to test); v1 LR trains behavioral-only.
  No arm trains on reviews (M9 leak guard already excluded them from taste/prior) → n 88 → 290.
- Per-arm paired (arm − keyword) MAP diff CIs; SHIP = any candidate, point-wise better on both
  metrics AND diff CI excludes 0. Gate = guardrail; interleave = verdict-maker (CLAUDE.md updated).
- `Z_CLAMP = 2` winsorized z in the mix — bounds any component at W·2; landed pre-activation so
  the interleave measures the fixed mix from day one.
- `served_lane` on review labels (VOTE_SERVE convention, read-only, tolerates missing digest_log);
  eval prints REVIEW-EXPLORE — ✧ votes are the only labels no ranker selected. Floor: REVIEW_MIN_N.
- rubric.ts: 600s call deadline + SIGKILL (CLI ignores SIGTERM mid-backoff — observed 14-min
  zombies). Optional second daily scoring window plist drafted, NOT installed (user's call).

**Invariants:** reviews stay eval-only gold (now literally 100% test); explore stays arm-null and
doubles as the audit sampler; the audit pool is diagnostic until it clears the n floor — the gate
verdict stays driven by REVIEW-ONLY; no weight tuning against any offline pool.

**Non-goals (explicitly rejected in the rethink):** new model families (embeddings lost in M6,
GBT stays deferred — labels, not capacity, are the bottleneck), weight grid-search, boosting the
explore share (revisit only if the audit pool is still starved in a month).

Repo-wide over-engineering audit, then applied in full. The product decision: **one delivery
channel.** The per-flush v0-ranked iMessage texts duplicated the 08:00 digest text with a ranker
built on signals the M6 probe showed don't predict what you value — and muddied dogfood complaint
attribution. Deleted with it: `ranker.ts` (235) + `ranker.test.ts` (233) + `GET /feed` + notify's
`maybeNotify`/`formatDigest`/✦-freshness block (`notify.ts` is now just `send()`, daily.ts its
only caller).

- **Explore lane moved into `digest.ts`** (the invariant survives the v0 deletion): ~10% of each
  digest is sampled from candidates the taste head did NOT pick (zero-score included), by a
  day-seeded hash — rotates daily, deterministic in tests, interleaved (never appended) so it
  actually gets read. Client badges them **✧ explore** instead of a fake taste-%.
- **Bootstrap CI ported into `eval.ts`** from the embedding experiment, then `ranker_emb.ts`
  deleted (its verdict — emb ≈ bigram ≈ still loses to keyword — is recorded in the M6 sections;
  git keeps the code). Review pool now prints per-model MAP CIs + the (v1 − keyword) diff CI, and
  the gate line says TIED when the diff CI straddles 0.
- **Ingest auth (PRD §5.8):** `AFY_TOKEN` in `.env.local`; `x-afy-token` required on the write
  endpoints (`/ingest`, `/review`, `/prune`) when set. Extension: `build.sh` bakes it into the SW.
  Review pages get it injected at serve time (they write the gold labels — the thing most worth
  protecting). ALL CORS headers removed: the SW is CORS-exempt via host_permissions, the client is
  same-origin (Mac + phone-on-LAN), so cross-origin readers were only ever other people's webpages.
- **Deleted debug leftovers:** hovercard MutationObserver (document-wide observer writing a
  blanket-attributed signal nothing consumed), `POST /log`, `GET /impressions/<id>`, stale Jun-20
  `dist/` subdirs (`build.sh` now cleans dist every build), vitest config + devDep in ingest
  (tests are node:test; −43 packages).

Net: ~800 lines + 1 dep removed; ingest tests 41 → 24 (the 17 deleted tests covered deleted code;
digest gained an explore-lane test). CLAUDE.md updated to match (CI pointer, toolchains, token).

### M13 — Evals rebuild: AUC pair gate, net-credit interleave, scorecard/judge/recall  ✅ BUILT + LIVE 2026-07-08

> Built by three parallel Opus subagents (eval gate / interleave credits / new tools) with the main
> session orchestrating: disjoint file ownership, per-package tests during build, then a merged
> full-suite run (**98 green**, was 79), real-db read-only runs of every CLI, and gate numbers
> reconciled against an independent pre-build probe (AUC parity within 0.003 after same-day pool
> growth). No schema changes, no server restart needed, no db writes.

**Problem:** the pooled-MAP gate structurally could not see within-topic taste — it discarded ~20%
of gold to balancing, scored the head of one shuffled pool, and handed keyword's ~27% tied pairs
to the tweet_id tiebreak. The interleave credit ignored 👎 (60% of judgments; 7 opens ever exist)
and starved toward TIED. And nothing measured per-day digest quality, judge quality per rubric
version, or recall.

**Design:**
- `eval.ts` (rebuilt, trains nothing): gate = AUC over all 👍/👎 pairs (Mann–Whitney by
  definition; empty side → 0.5 neutral), paired item-level bootstrap (B=2000, seeded) → per-arm
  CI + (arm − keyword) diff CI; SHIP = candidate all-pairs AUC > keyword AND diff-CI lo > 0;
  floor = 40 total labels AND ≥10 per class, below it NO verdict either way. Cuts: ALL (gate) /
  keyword-tied (advisory; keyword pins 0.5 there by construction — built-in sanity) / ✧ audit
  (M12 doctrine intact). Judge calibration per `rubric_sha` (`loadRubricScoresBySha` in
  rubric.ts, read-only): coverage, mean👍/👎, rubric-vs-votes AUC, oldest→newest, printed with a
  do-not-iterate warning. DELETED: v1 arms + training, `splitByTime`, `balancePool`, same-era and
  full pools, `--all`, NDCG@50 (`ndcgAt`/`averagePrecision` stay exported — probe.ts uses them;
  `ranker_v1.ts` stays as the hashStr home).
- `interleave.ts`: net credit = opens + 👍 − 👎, may go negative, never clamped; per-day downs
  mirror `dayUp` exactly (incl. the NUL map-key delimiter); judged floor, day-wins rule, paired
  day bootstrap, TIED/LEAN doctrine all unchanged.
- `scorecard.ts` (`npm run scorecard`): per-digest-day report card — served/up/down, junk@10/@20
  (each rate printed with its n), opens, ✧-vs-core votes, TOTAL line. Keyed to FIRST serve
  throughout so every column in a row describes the same tweets (vote INCLUSION identical to
  funnel's VOTE_SERVE; bucketing deliberately first-serve — documented and test-locked).
- `recall.ts` (`npm run recall [-- --days=N]`, default 7): organic engagements (minus prunes) →
  captured → served/MISSED with snippets; prints the lower-bound caveat (organic likes are biased
  toward what X already showed you).

**Invariants held:** reviews stay eval-only gold; no tuning against any offline pool (now
explicitly including the judge table); explore lane untouched; every report CLI read-only
(sqlite_master probes, never CREATE); seeded PRNG in all deterministic paths (recall's wall-clock
window is CLI-only and pinned in tests).

**First readings (2026-07-08, n=465):** gate SHIP ✅ mix (marginal diff CI [+0.002, +0.121] —
guardrail read only); judge table 0.687 → 0.724 → 0.706 across rubric versions; scorecard junk@10
72.7% → 12.5% day-over-day; recall 0/49 served-first. Details + doctrine in the RESUME block.

---

## Pre-M5 label curation (2026-06-27) — positive labels are ready

The product model that emerged: **Twitter stays the user's raw casual scroll (untouched);
"actually for you" is a SEPARATE calibrated AI-focused digest.** Labels for the digest are
curated; the user's actual X likes are NEVER modified (all "pruning" is rows in our DB only —
no X mutations were ever made).

**Positive labels for the digest** = `engagement_labels` (source `like`|`bookmark`) **minus**
`label_prunes`. Current state:
- **1,554 kept like-labels + 355 bookmarks ≈ 1,909 positives** (AI/tech-calibrated)
- `label_prunes` (2,309, append-only, NOT negatives — these are "not a current positive";
  the negative class stays reserved for report/mute/block): reasons = `age` (pre-2024 cut, 1855),
  `crypto` (130), `noise` (humor/entertainment/link-only, 261), `non-ai-topic` (finance/politics/
  sports, 61), `reviewed` (per-tweet drops, 2).

**How labels got here:** harvested the user's full Likes (3,863) + Bookmarks (355) via X GraphQL
pagination → `engagement_labels`. Tweet TEXT for all kept likes is imported into `tweets`
(source `dom`) so classification/pruning is durable + server-side (no re-scraping). Age cut to
2024+, then keyword + heuristic + semantic-ish topic/noise pruning.

**Tables:** `engagement_labels(tweet_id,source,ts)`, `label_prunes(tweet_id,reason,ts)`,
`reviews(tweet_id,verdict,ts)`. `/prune` review page exists. Counts visible at `GET /status`
(likes/bookmarks/pruned).

**M5 starting point:** build the label pipeline + offline-replay ranker on these ~1,909 positives.
IPW/propensity deferred (explicit engagement labels are position-robust — see the IPW note below).
✅ ONGOING capture: **FIXED 2026-06-28** — see the "Capture FIXED" section below. A real server-side
bug (malformed `capture_health` rows rolling back whole batches) was silently dropping all capture;
fixed, the stuck backlog drained (impressions 10,983 → 21,160), and the server now auto-starts via
launchd. `/status` reports live freshness (`capture_live`). Daily use is hands-off.

---

## Personalized digest SHIPPED (2026-06-28) — `digest.ts`, the actual product

The learned ranker (v1) is gated on data, but **the product isn't** — shipped a personalized AI
digest that needs zero new data and no training gate. It ranks the corpus by **similarity to your
~1,900 likes** (TF-IDF cosine to a taste-profile centroid). Because it's similarity, not a trained
classifier, the "v1 must beat keyword" gate doesn't apply; cosine's length-normalization also
neutralizes the char_len confounder for free (PRD §7.2).

- `ingest/digest.ts` — `buildTaste(db)` (IDF over corpus + centroid of unit-normalized liked-tweet
  vectors), `scoreText`, `buildDigest({limit,days})` with MMR diversify + a 4-token fragment filter.
  CLI: `npm run digest`.
- `GET /digest?limit=N&days=N` endpoint (days=0 = all corpus, else recent captures only).
- `ingest/digest.test.ts` — 3 tests (AI≫off-topic, excludes already-liked + ranks AI first, length
  doesn't earn score). `npm test` = **40 ingest**.
- Verified on real data: top results are squarely on-taste (agentic coding, Anthropic/Opus, GPT,
  LLMs, voice models). Scores are small/clustered (short-text TF-IDF) but ordering is sound.

**Reading client REDESIGNED (2026-06-28):** `/` (`client.html`) rebuilt as a **Twitter-style dark
digest** for the blog (an editorial/light version was tried first, rejected). Dark theme, action
rows with real metrics (`/digest` now selects likes/rts/replies/views), per-tweet blue **✦ taste-match
badge** (cosine → 60–99% band), tabs (All/7d/48h via `/digest?days=`), review mode preserved.
`/digest` returns `profile_size` (grew to **2,881** as captured text backfilled liked tweets).
Two bugs found via live browser inspection + fixed: (1) **nested `<a>`** — the card was an `<a>` and
`linkify` put `<a>` links inside it; browsers forbid nested anchors so URL-bearing tweets split into
orphan fragments (72 cards for 50 items). Card is now a clickable `<div>`. (2) **avatars** — see below.

**Avatars — real X photos via captured CDN URLs (2026-06-28):** unavatar.io free tier 429-rate-limits
hard (can't serve ~50 avatars; even `?fallback=false` is the worse-limited path — use the plain
endpoint). Solution: capture X's **own** avatar URL from the GraphQL we already hook
(`network-hook.ts`: `user.avatar.image_url` new schema / `user.legacy.profile_image_url_https` old →
`TweetRecord.author_avatar` → `tweets.author_avatar` column). Server `/avatar/<handle>` proxy
(`server.ts serveAvatar`) prefers the stored pbs.twimg.com URL (no rate limit, `_normal`→`_400x400`),
caches to `.avatars/` (gitignored), falls back to unavatar only if no captured URL; negative-caches
genuine 404s only (not 429/5xx). Client renders a colored-initial circle with the cached photo
layered over it (graceful: real photo where available, initial otherwise, never a broken image).
**Fills in as you scroll** (only authors captured after this change get a URL; one avatar-bearing
tweet resolves all that author's tweets). Extension rebuilt + typecheck + 28 tests; 40 ingest tests.
**Needs one extension reload to activate.**

Next ship option (not built): daily auto-delivery (lean on `notify.ts`) to push the digest each morning.

---

## Capture FIXED (2026-06-28) — real server-side bug found via live tracing

The "broken live-sync" was **a real code bug**, not just operational (an earlier note in this file
guessed "operational only" — that was wrong; corrected here). Found it by live-tracing, not guessing:

1. Added `/status` **freshness** fields (`last_impression`, `minutes_since_last_impression`,
   `capture_live` ≤10 min, `impressions_last_hour/today`, `last_net_tweet`) → showed capture dead.
2. Added a `POST /ingest` log line → showed the browser **was** reaching the server
   (`impressions=303 tweets=615 health=39`) but the **same batch re-sent every 15s** with the DB
   count frozen → server was receiving and *failing to write*, so the extension retried forever.
3. Logged the swallowed catch → **`TypeError: value cannot be bound to SQLite parameter 1`** at the
   health insert.

**Root cause:** the injected hook emits `capture_health` **without a `ts`** field
(`network-hook.ts:17` → `detail: { kind, detail }`). `h.ts` was `undefined`, which `node:sqlite`
can't bind → throw → **whole transaction rolled back**, so 39 junk health rows nuked 303 impressions
+ 615 tweets every batch. Classic violation of PRD §5.1 independent failure boundaries: a diagnostic
stream took down the real data.

**Fix (server-side, `ingestBatch`):** coerce every health field to a bindable type and guard each
health insert in its own try/catch — a malformed diagnostic row is skipped, never rolls back
behavior/content. **No extension rebuild needed**: deploying this drained the entire stuck IDB
backlog on the next retry — **impressions 10,983 → 21,160**, `capture_live: true`, 936/hr. Verified,
37 ingest tests green.

**Remaining (capture-quality follow-up, NOT blocking):** the hook threw 257 `graphql_schema_miss`
health events — it's failing to parse many timeline GraphQL responses (tweets still partly flow).
Worth investigating whether the walker misses a current response shape. Also `network-hook.ts:17`
should stamp `ts` at source (server now backfills receive-time, fine for a diagnostic).

**Server now auto-starts (2026-06-28) — zero recurring effort.** A macOS LaunchAgent
(`~/Library/LaunchAgents/com.afy.ingest.plist`, label `com.afy.ingest`) runs the ingest server at
login with `RunAtLoad` + `KeepAlive` (verified: killing the process respawns it in ~2s). So the
server is always up; the extension's IDB buffer drains on its own. Native launchd, no new deps.
- Restart after a `server.ts` change: `launchctl kickstart -k gui/$(id -u)/com.afy.ingest`
- Logs: `/tmp/afy-ingest.out.log`, `/tmp/afy-ingest.err.log`
- Disable: `launchctl bootout gui/$(id -u)/com.afy.ingest`

**Daily use is now hands-off:** open laptop → server already running → visit x.com → the
(already-loaded, auto-injecting) extension captures and flushes. Nothing to start.

**Only needed when WE change extension code** (not daily): `chrome://extensions` → reload AFY →
**refresh the x.com tab**. Confirm any time with `curl -s localhost:2727/status` → `capture_live: true`.

---

## M5 + M6 (2026-06-28) — label pipeline + learned ranker + replay harness. Verdict: **HOLD on v1.**

Built the full label→model→eval chain. The harness is **honest and it says do not ship v1 yet** —
which is the ship gate working, not a failure of the build.

**Key reframe (forced by the data):** the dense clean signal is **text, not behavior**. Of the ~1,883
calibrated positives only **112** ever got an impression row, so a behavioral dwell-model would
starve. v1 is therefore a **content relevance model** — `P(I'd-engage | text + author)` — a different
surface from the v0 behavioral re-ranker in `ranker.ts` (which re-ranks "what you saw"). v1 powers
the digest; v0 stays the live feed.

| File | Role |
|---|---|
| `ingest/labels.ts` | `buildLabels(db)` → re-derivable labeled set. Positives = labels−prunes; **hard negs** = topical prunes (crypto/noise/non-ai, *same era* as positives); **easy negs** = sampled `net` timeline (later era), tagged `kind`. Age prunes excluded. IPW deferred (uniform weight, hook left). `labelReport()` = the §7.2 distribution-sanity gate. |
| `ingest/ranker_v1.ts` | Logistic regression, hashing-trick BoW + author. char_len/media/thread are **controls**: included in training to absorb confounding, **zeroed at predict** so length never earns score (PRD invariant). Pure TS, no deps. `npm run` trains → `model.json` (gitignored). |
| `ingest/eval.ts` | Offline replay = ship gate. NDCG@10/@50 + MAP, time-split stratified by `kind`. Two pools: **same-era** (pos vs hard_neg — the gate) and **full** (vs all negs — era-confounded, supplementary). Baselines: random/recency/char_len/keyword + v1 (author-ablated too). |
| `ingest/m5m6.test.ts` | 12 tests: metric fixtures, LR learns separable set, **confounder-not-rewarded**, **random-is-label-independent**, split stratification. `npm test` = 37 ingest. |

**Three eval bugs caught & fixed before trusting any number** (this is why the first "SHIP ✅" was a lie):
1. `random` baseline scored a perfect 1.0 — `hashStr(tweet_id)` inherited the snowflake/era ordering
   (positives `174…`, easy-negs `206…`). Fixed: seeded label-independent shuffle.
2. **Era confound** — positives (2024–26 harvested likes) and easy-negs (recent timeline) are
   temporally disjoint, so a model can win by detecting *era*, not relevance. Mitigated by the
   **same-era pool** (pos vs topical-prune hard-negs, both same era) as the real gate.
3. Same-era pool came back all-positives — `splitByTime` stratified by `label`, dumping every
   (older) hard-neg into train. Fixed: stratify by `kind`.

**Honest verdict (same-era gate):** keyword MAP **0.891** vs v1 **0.832** → **v1 loses.** On the full
pool v1 wins NDCG@10 (0.82 vs 0.70) but its **MAP ≈ random** (0.296 vs 0.289) — floats a few
positives to the top, orders the rest no better than chance. Why: **89% of training negatives are
era-confounded easy-negs**, so the LR learns era/style, not the AI-vs-off-topic boundary; and the
labels were curated partly *by* topic keywords, making the keyword baseline near-circular and very
strong. Not shipping v1 is the correct call per PRD §8 ("v1 ships only if eval is honest AND wins").

**Cheap levers TRIED (2026-06-28) — did not flip the verdict:** added **bigram features** (kept:
same-era NDCG@50 0.972→1.0, MAP 0.832→0.847) and **upweighted hard-negs** to un-drown the topical
boundary (**reverted**: neutral on the gate, hurt full-pool NDCG@10 0.82→0.53). v1 same-era MAP
**0.847 still < keyword 0.891** → HOLD stands. The evidence now says the gate's weakness is
**structural, not model capacity**: the same-era pool is only ~135 hard-negs and 79% positive (so
`char_len`=0.92 and `recency`=0.92 also "beat" v1 — the metric is barely discriminative), and the
keyword baseline is near-circular (labels were curated partly *by* topic keywords). More model
tuning is the wrong direction (PRD §9: don't over-engineer the LR).

**Real next move (needs your call):** either (a) **densify same-era negatives** — harvest/label more
engaged-but-off-topic tweets so the gate has teeth — or (b) **accept a keyword-prior + LR hybrid** as
the honest digest scorer and skip a pure learned v1. Revisit a behavioral v1 once live-sync is fixed
and dwell/engagement data densifies (only 112 positives currently carry impressions).

Untouched: live-sync (separate follow-up), `ranker.ts` v0, capture surface.

---

## Daily delivery SHIPPED (2026-06-30) — the digest now comes to you

Decision: stop tuning the ranker on faith and **dogfood the shipped digest** first. Built the
missing piece — delivery — so daily use generates the real complaint that tells us if the ranker
even needs more work.

- `ingest/daily.ts` — fetches the top item from the live `/digest?limit=1&days=2`, texts a one-line
  teaser + a link to the reading client. Reuses `notify.ts send` (now exported): iMessage→poke→stdout.
  No new ranker, no new deps. CLI: `npm run daily`.
- `~/Library/LaunchAgents/com.afy.daily.plist` (label `com.afy.daily`) — fires `daily.ts` at **08:00
  local** daily (`StartCalendarInterval`, no KeepAlive; runs at next wake if asleep). Verified the
  full launchd→node→iMessage chain end-to-end (`launchctl kickstart` → text delivered, `/tmp/afy-daily.*.log`).
- Knobs (env, in `.env.local`): `AFY_CLIENT_URL` (set to the Mac's LAN IP to tap from your phone on
  same wifi — localhost only opens on the Mac), `AFY_DAILY_DAYS` (teaser window, default 48h).
- Manage: `launchctl bootout gui/$(id -u)/com.afy.daily` to disable; edit the `<integer>` hour to
  reschedule then re-`bootstrap`.

**Dogfood now:** read it for a week. If it's consistently good → cosine ranker is done, learned-v1
thread stays closed. If it's off in a specific way → that complaint picks the next ranker work
(likely behavioral). Don't touch the ranker until then. 40 ingest tests green.

NOTE while dogfooding: the first teaser pulled a low-taste item (score 0.02) from the 48h window —
recent casual-scroll captures may be thin on on-taste content. Watch whether `days=2` surfaces good
stuff; if not, the lever is the window or scoring, and that's a real dogfood finding, not a guess.

---

## v1 revisit on densified data (2026-06-30) — fixed a broken gate; HOLD now well-founded

Re-ran the M6 ship gate on the grown corpus (positives 1,883→**2,842**, behavioral positives
112→**273**, hard-negs 135→**452**). Found the gate itself was lying and fixed it:

**The gate was saturated, not passing.** Same-era test pool was ~86% positive (853 pos vs ~136
hard-neg after the 70/30 time-split), so NDCG@10/MAP saturated — `random` scored **1.0 NDCG@10 /
0.86 MAP** and `char_len` a perfect NDCG. The metric couldn't discriminate anything; every prior
same-era number was noise. Fix: `balancePool()` in `eval.ts` deterministically downsamples the
majority class to 50/50 so `random`→~0.5 and the metric has teeth (locked by an updated m5m6 test:
balanced random MAP must land in 0.35–0.65, catching both id-leak AND re-saturation).

**Honest verdict on the now-fair gate — HOLD confirmed, no longer an artifact:**
| model | NDCG@10 | MAP |
|---|---|---|
| keyword (baseline) | **1.00** | **0.735** |
| char_len | 0.864 | 0.732 |
| v1 LR (full) | 0.797 | 0.559 |
| random | 0.489 | 0.489 |

v1 genuinely loses. Two structural reasons this gate is the wrong thing to chase: (1) `char_len`
alone (0.732) ≈ keyword (0.735) — the baseline is barely a content signal; (2) the keyword baseline
is **near-circular** (labels were curated partly *by* the AI lexicon), so a text LR is being asked
to beat the rule that defined its own labels. PRD §9 warned against over-engineering the LR for
exactly this. **Pure-LR-v1-vs-keyword is a dead end.**

**Real forward options (needs your call):**
- (a) **Behavioral re-ranker** — the surface the HOLD actually deferred. Capture is now live:
  **199** opened_detail, **278** engaged impressions, **3,728** tweets with dwell>3s. Eval = does
  dwell/opened predict held-out likes better than recency? Non-circular, genuinely new — but the
  dense positive signal (~200 opens) is still thin.
- (b) **Accept the shipped digest** (cosine-to-your-2,842-likes) as the product scorer and stop
  chasing a learned v1. It already beats a hand lexicon conceptually, no circularity, and is live.
- (c) **Densify same-era negatives** — harvest engaged-but-off-AI tweets to give the content gate
  real teeth. Most upfront work.

Recommendation: **(b) is already true today** + run **(a)** as the next cheap probe to see if live
behavioral data now carries a learnable re-rank signal. Don't tune the LR further (PRD §9).

---

## M6 SOLIDIFIED (2026-07-01) — behavioral probe run; learned ranker is a dead end, both paths. CLOSED.

Ran the one deferred, genuinely-non-circular probe (option a from the prior section) to turn M6's
open "HOLD" into a firm verdict. `ingest/probe.ts` (+`npm run probe`) asks: among tweets we actually
put on screen (viewed-gate ≥50%), does passive behavior — dwell, opened_detail — rank the ones you
**liked** above the ones you didn't, beating recency and random? No circularity (label = harvested
like; score = passive signals only, never the like/rt/bookmark flips), no era confound (every
candidate has a recent impression). Balanced 50/50 (240 liked vs 240 sampled not-liked), reuses the
eval.ts metrics + the v0 ranker's trusted-dwell definition.

**Verdict — DEAD ⛔ (balanced 240v240):**
| model | NDCG@10 | MAP |
|---|---|---|
| recency (artifact, see below) | 0.780 | 0.893 |
| dwell only | 0.776 | 0.445 |
| behavioral (dwell+opened) | 0.637 | 0.444 |
| random | 0.473 | 0.487 |
| opened_detail only | 0.563 | 0.844 |

**Passive behavior does not predict likes.** dwell MAP (0.445) is *below* random (0.487) — a faint
top-k whiff (NDCG@10 0.78) but no signal across the ranking. Adding opened_detail makes it *worse*:
only **5 of 240 liked tweets were ever opened**, so opened_detail is noise that pushes non-liked
tweets up. Physical reason, not an artifact: **liking on X is a fast double-tap that doesn't
correlate with long dwell**, and opening detail (reading replies) is a different intent than liking.
The 240 liked-and-seen tweets are casual-scroll likes; the sensor's passive signals capture a
different interaction moment. (The recency=0.89 line is a mild artifact — some impression `ts` are
0/null — and is irrelevant: behavior loses to *random* regardless of what recency does.)

**M6 is now CLOSED, not on hold.** Both learnable surfaces are exhausted:
- **Content LR** — loses to a near-circular keyword baseline; `char_len` alone ≈ keyword (dead end,
  documented in the M5+M6 sections; re-confirmed on the grown 2,842-positive corpus).
- **Behavioral** — no signal predicts likes (this probe).

**UPDATE (2026-07-01, same day) — closed the circularity loophole for good with a NON-circular gate.**
The one open objection to "content LR is dead" was that its baseline (keyword) was near-circular, so
maybe the LR was only losing to a rigged rule. Killed that objection: wired the reading client's
hand-signed 👍/👎 (`reviews` table — verdict is a *human* call, not the AI lexicon) into `labels.ts`
as `review_pos`/`review_neg` kinds, and added a **REVIEW-ONLY ship gate** to `eval.ts` (balanced
👍-vs-👎, no keyword touching the labels). Signed the pool up to 208 (71 👍 / 130 👎) so the gate
clears its n≥40 trust threshold. Verdict at balanced test n=44:

| model | NDCG@10 | MAP |
|---|---|---|
| keyword | **0.931** | **0.811** |
| char_len | 0.848 | 0.787 |
| random | 0.433 | 0.498 |
| v1 LR (full) | 0.290 | 0.442 |

**v1 LR is WORSE than random on clean labels** — a 0.37 MAP gap to keyword, not a close call. Trained
on harvested likes, it can't separate good-AI from bad-AI, so it ranks thumbed-*down* tweets above
thumbed-*up*. And keyword predicting the hand-signed prefs at 0.81 MAP means the real preference IS
"AI topical relevance" — exactly what the cosine digest embodies non-circularly. The learned LR is now
dead on a gate with zero circularity. Every future 👍/👎 flows straight into `npm run eval`; re-run to
reconfirm as the pool grows. `m5m6.test.ts` unchanged (toy set has no review rows → gate reads
INCONCLUSIVE, correct). `npm test` = 41 ingest.

The shipped **cosine-to-your-likes digest** (`digest.ts`) stays the product ranker: non-circular,
length-normalized (neutralizes the char_len confounder for free), live, and needs no training gate.
This is option (b) made official. Revisit a learned v1 only if a **denser, non-circular** signal
appears (e.g. explicit thumbs-up/down in the reading client, or opened-in-digest events) — model
tuning is the wrong lever (PRD §9). `ranker_v1.ts`/`eval.ts` kept as the honest gate that said no.

Tests: `m5m6.test.ts` +1 probe wiring test (detects dwell signal when present, random stays ~0.5).
`npm test` = **41 ingest**. Untouched: capture, v0 `ranker.ts`, live-sync.

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
| GATE | capture live | Capture FIXED 2026-06-28 (server auto-starts, backlog drained); behavioral data now accumulating hands-off |
| M5 | ✅ built | Label pipeline `labels.ts` (text-based labels; IPW deferred, session-recon n/a for harvested likes) |
| M6 | ✅ closed | Ranker v1 gate honest & complete. Both learnable paths dead — content LR loses to keyword, behavioral probe (`probe.ts`) shows dwell/opened don't predict likes. Product ranker = cosine digest (`digest.ts`). See "M6 SOLIDIFIED" section. |
| M7 | ✅ built 2026-07-03 | Independent candidate acquisition — pinned poller tab, `source='poll'`, capture pipeline reused. Live dogfood + user approval pending |
| M8 | ✅ built 2026-07-04 | LLM rubric scorer on the Claude subscription (`claude -p`): `rubric.ts` + `RUBRIC.md` + eval arm. First verdict (generic rubric, 52/52): MAP 0.683 vs keyword 0.745 — closest challenger yet, gate still keyword's. Personalize RUBRIC.md → re-score → re-eval |
| M9 | ✅ built + live 2026-07-05 | Weighted mix: taste + rubric + author knobs in `digest.ts`, eval arm "mix" |
| M10 | ✅ built + live 2026-07-06 | Own-feed telemetry: `digest_log` + `digest_opens` + `npm run funnel` (prereq for interleaving/M11); serve rows carry score/parts for component attribution |
| M11 | 🔨 in flight 2026-07-07 | Interleaved online comparison: team-draft mix vs keyword on the live digest, blind + deterministic, `npm run interleave` verdict with CI + judged-event floor |

---

## Extension load instructions (for new sessions)

```bash
cd extension && npm run build
```

Then in Comet/Chrome:
- `chrome://extensions` → Developer mode on → Load unpacked → `extension/dist/`
- Or reload existing extension via the reload button if already loaded.

Extension ID (Comet + Chrome): `jdboppmgleafhofleecllpnjooojkpfi`
