# M16 spec — online-lr: closing the label loop without breaking the gate

> STATUS: BUILT 2026-07-27 (branch m16-online-lr); freeze recorded in PROGRESS before any
> in-window serve. Decisions as built: `GATE_CUTOFF = 2026-07-28`, `SPLIT_SALT = "m16-v1"`,
> gold ratio 1/3, `HORIZON_DAYS = 7`, matchup review_lr vs online_lr. Deviation from draft:
> the split is piped per-row to the python (`train_ok` + `split`) and the old strict-subset
> assert became two precise leak canaries (it false-fired on the fresh-freeze state).

## Problem

Every ranker today trains on a label set frozen at `GATE_CUTOFF = 2026-07-15`
(eval.ts:215). The system adapts online at the *feature* level (taste corpus, author
priors, rubric scores drift daily) but no model ever learns from a vote cast after the
freeze — new votes only judge. That was the right call for proving the eval; it also means
the system is not an online learner, and the one experiment the whole project points at —
"does closing the loop on fresh labels actually beat the frozen model, measured honestly?"
— has never been run.

The blocker is structural, not mechanical: online learning and honest evaluation compete
for the same scarce resource (hand votes). Training on 100% of incoming votes leaves zero
gold and kills the prospective gate. The fix is a declared, deterministic split of the
vote stream.

## Change (one amendment + one new arm + one new window)

### 1. The split amendment (gate-design change → re-freeze)

- **`GATE_CUTOFF` moves forward one final planned time**, to the amendment date
  (placeholder: `2026-07-29` — set to the actual freeze day). Everything before it
  becomes spendable training currency, consistent with the 2026-07-15 "spent dev
  currency" precedent. The current n=337 post-07-15 pool is spent too: this amendment
  was designed while reading its aggregate CIs, so it can never verdict the design it
  provoked. Gold restarts at zero and re-accumulates (~337 votes arrived in 12 days;
  the n≥40 gate-trust floor is days away, not weeks).
- **Every vote at-or-after the new cutoff is assigned at birth, permanently:**
  - `split(vote) = "gold"` when `hashStr(splitKey) % 3 === 0` (~1/3) — eval-only,
    NOTHING ever trains on it. This is the new untouchable pool.
  - otherwise `"train"` (~2/3) — flows into online training, can NEVER verdict.
- **The split is a pure function, not a stored column.** `hashStr` (ranker_v1.ts:20)
  over `splitKey`, computed identically in eval.ts and review_lr_dump.ts from one shared
  helper. No migration, nothing mutable, nothing to reassign after seeing a result —
  deterministic is tamper-evident. A `SPLIT_SALT` string constant lives next to
  `GATE_CUTOFF` and is frozen with it (changing the salt = gate-design change).
- **`splitKey` is the content-twin key, not tweet_id:** `author_handle + "\n" +
  normalized text` (the same identity digest.ts dedups candidates on), falling back to
  `tweet_id` when text is missing. Rationale: X mints several tweet_ids for one posting
  event; hashing tweet_id could put identical text in both pools — train/gold text
  leakage that inflates the gate. Twins must land in the same pool by construction.

### 2. The `online-lr` arm (new recipe, same machinery)

- Identical to `review-lr` in features, C-grid, confounder controls, mean-fallback, and
  failure semantics (uv/python missing → degrade to neutral, never block the digest).
  The ONLY difference is the label set: **all train-split votes to date** instead of
  pre-2026-07-15 votes only.
- `review_lr_dump.ts` grows a `--labels frozen|online` flag: `frozen` emits today's
  behavior (rows labeled from pre-2026-07-15 votes — the incumbent recipe, untouched);
  `online` emits pre-cutoff votes PLUS post-cutoff train-split votes with
  `ts < <this morning's run>`. daily.ts runs the dump→train→score pipeline twice
  (~2 extra lines), writing to separate score tables
  (`review_lr_scores`, `online_lr_scores`) so neither arm can read the other's output.
- **Temporal causality is the new honesty guarantee** (prequential / test-then-train):
  the model that drafts a morning's digest trained only on votes cast before that
  morning. A serve is judged by the interleave before its own outcome can reach
  training. daily.ts already orders retrain → digest build, so this holds by
  construction; the dump's `ts <` filter makes it explicit and testable.
- `eval.ts` gains the arm and the split filter: the PROSPECTIVE gate reads ONLY
  gold-split votes after the new cutoff. Post-cutoff train-split votes may print as one
  more advisory row (train-set read, labeled as such), same as the dev pool today.

### 3. The confirmatory window (predeclared here, frozen in PROGRESS before first serve)

- **Matchup: `MATCHUP = ["review_lr", "online_lr"]`** (digest.ts:107) — frozen-label
  incumbent vs closed-loop challenger. This is the experiment: a win says online
  learning helps; TIED says it bought nothing at this n. Either is a real result.
- Credit formula (opens + 👍 − 👎), 30-judged-event floor, tweet-bootstrap CI
  (stratified, seed 0x243f6a88, B=2000): **all UNCHANGED** from the 07-15 freeze.
- `HORIZON_DAYS = 7` (recommendation, user decides): the 2-day horizon produced a
  TIED-at-n=49 that mostly measured low usage. 7 days at recent voting rates projects
  n≈150–250 judged events. Floor not met at horizon → extend on n, never on the lean.
  CI prints ONCE, at the horizon.
- `WINDOW_START` = first serve date after freeze. Changing matchup/formula/floor/split
  restarts the window, as always.

### Pre-req hygiene fix (fold into the same commit)

interleave.ts currently prints a live CI at n=117 for the window that CLOSED 2026-07-18
at its n=49 horizon read. Post-horizon reads violate the window's own one-read rule.
Guard: when `today > WINDOW_START + HORIZON_DAYS` and the horizon read was taken, print
the recorded verdict ("window closed 2026-07-18: TIED at n=49") and the raw tallies,
never a fresh CI.

## What does NOT change (invariants hold by construction)

- Raw events append-only; labels re-derive from raw.
- Behavioral signals (dwell/opens/engagements) NEVER become training labels — the ~0.44
  below-chance result stands; the loop closes on hand votes only.
- Never train on the ranker's own output: votes are human; rubric/keyword scores rank
  but never label; AI_LEXICON stays a baseline.
- Confounder controls (char_len/media_present/is_thread) regressed in at train, dropped
  at predict — both arms.
- **Explore lane survives in every version** — and matters MORE now: once a model trains
  on votes cast on cards it served, it shapes its own training distribution; explore
  votes are the least serve-biased labels in the stream. (Over-weighting explore votes
  in training is a real future knob — OUT of v1; adding it later = recipe change = new
  window.)
- Author priors from `engagement_labels` only; reviews still never become features.
- Gate mechanics: pairwise AUC, strongest-baseline policy, paired item-bootstrap diff CI.

## CLAUDE.md amendments required (same commit as the freeze)

- "Hand-signed reviews at-or-after GATE_CUTOFF are the ONLY non-circular gold" →
  scoped to **gold-split** votes at-or-after the (new) cutoff; train-split votes are
  declared training currency at birth and can never verdict.
- The `review-lr` recipe description gains its sibling: `online-lr`, labels = pre-cutoff
  + post-cutoff train-split, retrained daily, prequential.
- Ship-gate section: record the new cutoff, `SPLIT_SALT`, the 1/3 gold ratio, the
  content-twin split key, and the new window params.

## Acceptance

- Shared `voteSplit(splitKey)` helper; property test: deterministic, ~1/3 gold on a
  seeded sample, content twins (same author+text, different tweet_id) always same pool.
- Dump `--labels online` excludes: gold-split votes (any date), train-split votes with
  `ts >=` the run boundary. Test both exclusions with fixture rows.
- eval.ts prospective gate counts only gold-split votes ≥ new cutoff (fixture: a
  train-split post-cutoff vote must NOT appear in the gate n).
- Separate score tables; digest.ts serves the new matchup blind (existing armRanking
  snapshot test pattern, new fixture).
- interleave.ts closed-window guard: fixture where horizon passed → prints recorded
  verdict, no fresh CI.
- Both suites green; `npm run eval` runs end-to-end with the new arm and prints the
  (initially empty) new-gold gate as INCONCLUSIVE below floor, loudly.
- PROGRESS freeze entry written BEFORE first in-window serve, verified zero in-window
  digest_log rows at freeze time (07-15 precedent).

## Open decisions for review

1. New `GATE_CUTOFF` date (proposal: the day you approve this, +1 to be safe).
2. Gold ratio 1/3 (proposal) vs 1/4 — more gold = faster gate trust, less training data.
3. `HORIZON_DAYS = 7` (proposal) vs keeping 2 — 2 re-risks another "no large effect" read.
4. Matchup `review_lr vs online_lr` (proposal) vs `mix vs online_lr` — the former
   isolates the label-loop question; the latter answers "should the product switch?"
   but confounds recipe vs loop.
5. `SPLIT_SALT` value (any fixed string; committed, never changed).
