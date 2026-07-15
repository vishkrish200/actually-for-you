// M6 — Offline replay eval = the ship gate (PRD §9), a GUARDRAIL: the online interleave
// (interleave.ts) is the verdict-maker; this gate answers "does any candidate arm beat the
// STRONGEST baseline on the hand-signed review pool". The reference is picked per pool by point
// AUC among random/recency/char_len/keyword/author-prior — keyword alone was too soft a bar
// (char_len beats it on the live pool), so beating whichever dumb arm is best is the floor.
//
// WHY AUC, not pooled MAP (rebuilt 2026-07-08): the old gate ranked ONE 50/50-balanced pool by MAP.
// Three faults, all fixed here:
//   (1) balancing DISCARDS ~20% of the hand-signed gold (it downsamples the majority class) — the
//       scarcest, most expensive labels we own, thrown away just to make one list.
//   (2) MAP is top-heavy — it scores the head of a single ranking, not the decision the ranker is
//       actually asked to make on this surface.
//   (3) it silently credits arbitrary tiebreaks: keyword's integer scores TIE on ~28% of 👍/👎
//       pairs, and MAP's stable-sort tiebreak (on tweet_id) hands those pairs to whoever sorts
//       first — noise dressed as signal.
// Pairwise preference accuracy — AUC = P[score(👍) > score(👎)] + ½·P[tie] — fixes all three: it
// uses EVERY hand label (no balancing; AUC is prevalence-invariant), it IS the ranker's job (order a
// liked tweet above a disliked one), and ties enter as an explicit ½, never a lucky sort. Measured
// this way rubric (~0.705) beats keyword (~0.626) with a paired diff CI excluding 0 — the pooled-MAP
// "tie" was the instrument, not the arms. The gate stays a guardrail; the interleave stays the
// verdict-maker (doctrine unchanged — do NOT tune weights/hyperparameters against this).
//
// eval.ts no longer TRAINS anything: reviews are 100% test by doctrine (no arm trains on gold).
// But "never trained on" is not "never looked at": the metric (MAP→AUC), the credit formula, and
// the strongest-baseline policy were all chosen WHILE inspecting the accumulated votes — so that
// pool is a DEVELOPMENT set, and no bootstrap CI on it accounts for those choices. Hence the
// PROSPECTIVE split (GATE_CUTOFF below): votes cast before the cutoff are the dev pool — printed
// as an advisory regression read, never a verdict; only votes cast after the cutoff feed the ship
// gate, because nothing about the gate was tuned looking at them. The v1 LR arms and the same-era /
// full supplementary pools were LR-era scaffolding (era-confounded / keyword-circular) and are gone.
import type { LabeledRow } from "./labels.ts";
import { buildLabels, AI_LEXICON } from "./labels.ts";
import { loadRubricScores, loadRubricScoresBySha, type RubricScores, type ShaScores } from "./rubric.ts";
import { scoreText, mixFinal, type TasteModel } from "./digest.ts";

export { loadRubricScores, type RubricScores }; // re-export: pre-M9 home of these was eval.ts

// ---- probe metrics (probe.ts imports ndcgAt/averagePrecision from here) ----
// This gate no longer uses NDCG/MAP, but the behavioral probe (probe.ts) does, so the exports stay.
// rels: relevance of each item in RANKED order (1 = positive, 0 = negative).
export function ndcgAt(rels: number[], k: number): number {
  const dcg = (xs: number[]) =>
    xs.slice(0, k).reduce((s, r, i) => s + r / Math.log2(i + 2), 0);
  const ideal = [...rels].sort((a, b) => b - a);
  const idcg = dcg(ideal);
  return idcg === 0 ? 0 : dcg(rels) / idcg;
}

// Average precision for a single ranked list (MAP over one query == AP).
export function averagePrecision(rels: number[]): number {
  let hits = 0, sum = 0;
  for (let i = 0; i < rels.length; i++) {
    if (rels[i]) { hits++; sum += hits / (i + 1); }
  }
  return hits === 0 ? 0 : sum / hits;
}

// ---- arm scorers ----
const lexiconScore = (r: LabeledRow) => {
  const text = r.text.toLowerCase();
  return AI_LEXICON.reduce((n, kw) => n + (text.includes(kw) ? 1 : 0), 0);
};
const recencyScore = (r: LabeledRow) => Date.parse(r.created_at) || 0;
const charLenScore = (r: LabeledRow) => r.char_len;             // confound check: a real arm must beat this

// LABEL-INDEPENDENT random baseline. NOT hashStr(tweet_id): tweet_id is a time-ordered snowflake and
// positives (older harvested likes) vs negs live in different id ranges, so any function of the id
// correlates with the label and fakes a perfect "random" score. Instead assign a seeded-PRNG value
// per row in array order — the PRNG never sees the label, so its AUC is ≈0.5 by construction.
function randomScorer(rows: LabeledRow[]): (r: LabeledRow) => number {
  let s = 0x9e3779b9;
  const m = new Map<string, number>();
  for (const r of rows) { s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) >>> 0; m.set(r.tweet_id, s); }
  return (r) => m.get(r.tweet_id) ?? 0;
}

// The rubric scorer as a LabeledRow scorer: an unscored tweet gets -1 so it sorts BELOW every real
// 0–10 score, deterministically. This is the "missing scores rank last, deterministically" contract
// from the plan — the PURE-rubric arm only. (The mix arm treats a missing rubric as z=0 pool-neutral
// INSIDE mixFinal, never -1 — the unchanged M9 contract.)
function rubricScorer(rs: RubricScores): (r: LabeledRow) => number {
  return (r) => rs.scores.get(r.tweet_id) ?? -1;
}

// ---- AUC: pairwise preference accuracy over the hand-signed pool ----
// (wins + ½·ties) / (nPos·nNeg) over ALL pos×neg pairs — the fraction of 👍/👎 pairs the scorer
// orders correctly, ties counted as half a win. This IS the Mann–Whitney statistic; computed by the
// definition (double loop) because it is dead-obvious to verify and the pool is small (nPos·nNeg is
// ~50k on the live db — one pass is near-instant). An empty side has no pairs → 0.5 (neutral: there
// is no gate to read, and 0.5 keeps it from spuriously "beating" anything downstream).
export function auc(pos: LabeledRow[], neg: LabeledRow[], score: (r: LabeledRow) => number): number {
  const ps = pos.map(score), ns = neg.map(score);
  const denom = ps.length * ns.length;
  if (denom === 0) return 0.5;
  let wins = 0, ties = 0;
  for (let a = 0; a < ps.length; a++) {
    const p = ps[a];
    for (let b = 0; b < ns.length; b++) {
      if (p > ns[b]) wins++;
      else if (p === ns[b]) ties++;
    }
  }
  return (wins + 0.5 * ties) / denom;
}

// AUC over the subset of pairs where the KEYWORD baseline ties (lexiconScore(pos) === lexiconScore
// (neg)) — the pairs keyword is structurally blind on (~28% of the live pool). Advisory: a candidate
// that scores well HERE is separating exactly where the champion cannot. Returns the restricted AUC
// AND the pair count (the count is arm-independent — the header prints it once). No tied pairs → NaN
// (the formatter renders "—"); keyword itself is all-ties here, so its own column is 0.5 by
// construction — a built-in sanity check.
export function aucOnKeywordTies(
  pos: LabeledRow[], neg: LabeledRow[], score: (r: LabeledRow) => number,
): { auc: number; pairs: number } {
  const kwP = pos.map(lexiconScore), kwN = neg.map(lexiconScore);
  const sP = pos.map(score), sN = neg.map(score);
  let wins = 0, ties = 0, pairs = 0;
  for (let a = 0; a < pos.length; a++) {
    for (let b = 0; b < neg.length; b++) {
      if (kwP[a] !== kwN[b]) continue;
      pairs++;
      if (sP[a] > sN[b]) wins++;
      else if (sP[a] === sN[b]) ties++;
    }
  }
  return { auc: pairs === 0 ? NaN : (wins + 0.5 * ties) / pairs, pairs };
}

// Baselines never ship — they exist to be beaten. The gate reference is the strongest of them per
// pool (evalCut picks it). Everything else is a CANDIDATE that can clear the gate. author prior is
// a baseline, not a candidate: "who posted it" with zero content modeling — if a candidate can't
// beat it, the content features are decoration.
const BASELINES = new Set(["random", "recency", "char_len", "author prior (behavior only)"]);
const isCandidate = (name: string) => !BASELINES.has(name) && !name.startsWith("keyword");

// M8 rubric coverage: how much of the review pool the LLM has actually scored, at the latest sha —
// a verdict is only as trustworthy as its coverage, so we print it next to the arm.
export interface RubricCoverage { scored: number; total: number; sha: string | null }

// M9 mix arm inputs — built from the db by the caller (runEval itself stays db-free). The taste
// model comes from digest.buildTaste (reviewed tweets excluded — the leak guard); the prior from
// digest.buildAuthorPrior (engagement_labels ONLY, never reviews).
export interface MixInputs { taste: TasteModel; authorPrior: Map<string, number> }

// M8 rubric arm + M9 mix/taste arms, built per pool. rubric = the pure LLM judge (-1 rank-last
// sentinel for missing). taste = the pre-M9 shipped ranker (digest cosine) — the status quo the mix
// must justify itself against, not just keyword. mix = THE digest formula (digest.mixFinal, weights
// and all), z-scored over the pool being ranked (its own definition, matching buildDigest) then
// frozen per-row; a missing rubric is z=0 pool-neutral here, never -1. random and mix are
// pool-dependent, so the arm list is rebuilt for every cut over that cut's own rows.
// CAVEAT: this replays TODAY's taste profile / author prior / weights over ONE pooled review set —
// production normalized each day's candidate slate and then ran MMR + the team draft. So a pool AUC
// approximates the current formula's preference ordering; it is NOT the measured performance of the
// historical ranker that served these cards, and it says nothing about top-K quality. The
// interleave is the product-truth read.
function armsFor(
  pool: LabeledRow[], rubric?: RubricScores, mix?: MixInputs,
): [string, (r: LabeledRow) => number][] {
  const named: [string, (r: LabeledRow) => number][] = [
    ["random", randomScorer(pool)],
    ["recency", recencyScore],
    ["char_len", charLenScore],
    ["keyword (lexicon)", lexiconScore],
  ];
  if (rubric) named.push(["rubric (LLM judge)", rubricScorer(rubric)]);
  if (mix) {
    // Behavior-only baseline: the M9 author prior run solo. Non-circular (engagement_labels only,
    // never reviews) — the bar that answers "does content modeling add anything over WHO posted?"
    named.push(["author prior (behavior only)", (r) => mix.authorPrior.get(r.author_id) ?? 0]);
    const tasteOf = (r: LabeledRow) => scoreText(r.text, mix.taste);
    named.push(["taste (digest cosine)", tasteOf]);
    const finals = mixFinal(pool.map(r => ({
      taste: tasteOf(r),
      rubric: rubric?.scores.get(r.tweet_id) ?? null,
      author: mix.authorPrior.get(r.author_id) ?? 0,
    })));
    const byId = new Map(pool.map((r, i) => [r.tweet_id, finals[i].final]));
    named.push(["mix (M9 digest blend)", (r) => byId.get(r.tweet_id) ?? 0]);
  }
  return named;
}

export interface PoolResult {
  pool: string;
  nPos: number;
  nNeg: number;
  pairs: number;       // nPos·nNeg — every hand label participates (no balancing)
  tiedPairs: number;   // pairs on which keyword ties (the kw-blind subset)
  baseline: string;    // the gate reference: strongest baseline arm by point AUC (keyword on ties)
  rows: {
    name: string;
    auc: number;                 // ALL pairs — THE gate metric
    aucTied: number;             // AUC on the keyword-tied subset (advisory; NaN if no tied pairs)
    aucCI?: [number, number];    // per-arm 95% bootstrap CI on all-pairs AUC
    diffVsBase?: [number, number]; // paired (arm − baseline) AUC CI — every arm but the baseline
  }[];
  ships: boolean;      // a CANDIDATE beats the baseline all-pairs AUC AND its diff CI excludes 0 (lo > 0)
  champion?: string;   // highest-AUC clearer
}

// PROSPECTIVE gate cutoff, frozen 2026-07-14. Votes with review_ts BEFORE this date are the DEV
// pool: the AUC metric, the strongest-baseline reference, and the interleave credit formula were
// all chosen while looking at them, so they can regression-test the gate but never issue a verdict.
// Votes from this date on are untouched by any design decision — THE ship gate reads only those.
// Move this date only FORWARD, and only when re-freezing after a deliberate gate-design change
// (moving it back would launder dev votes into the gate). Rows with no review_ts (fixtures) are
// treated as post-cutoff.
export const GATE_CUTOFF = "2026-07-15";

// Floor below which the gate is too thin to trust either way: fewer than REVIEW_MIN_N total hand
// labels, OR fewer than MIN_PER_CLASS of either sign (a lopsided pool can't estimate the minority
// side). Below the floor there is NO verdict — not SHIP, not HOLD — just "sign more".
const REVIEW_MIN_N = 40;
const MIN_PER_CLASS = 10;
const belowFloor = (nPos: number, nNeg: number) =>
  nPos + nNeg < REVIEW_MIN_N || Math.min(nPos, nNeg) < MIN_PER_CLASS;

// ---- advisory cut: the length band where char_len is structurally blind ----
// char_len wins the pools above on essentially ONE coarse call — "is this a sub-200-char one-liner?
// → 👎". The 👍-rate climbs 12%→32% below 200 chars, then FLATTENS (48/49/50% across 200–600), and
// char_len's own AUC inside 200–600 is 0.518 — chance. So the headline AUC mostly rewards a length
// threshold, and says almost nothing about the band where 45% of the votes actually live.
// This cut asks the question the headline cannot: does a candidate separate 👍 from 👎 WHERE LENGTH
// ALONE CANNOT? char_len's own row here lands at ~0.5 by construction — the same built-in sanity
// check keyword's 0.5 gives on the kw-tied column.
//
// ADVISORY, NEVER A GATE — two independently disqualifying reasons:
//   1. the band edges were read off the DEV pool's up-rate curve, so the cut is dev-derived; and
//   2. it was invented AFTER the gate returned HOLD. Promoting it to a bar a candidate must clear is
//      a deliberate gate-design change — it costs a re-freeze with GATE_CUTOFF moved FORWARD.
// It tells you WHERE the ranker fails. It can never tell you WHETHER it ships.
const BAND_LO = 200, BAND_HI = 600;

const pctile = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor(p * (xs.length - 1))];

// Paired bootstrap over ITEMS — pos indices and neg indices resampled with replacement — NOT over
// pairs, which are not independent (each item appears in many pairs). Every arm's AUC is recomputed
// on the SAME resample, so the per-arm CIs and the (arm − baseline) diff CI share sampling noise.
// Seeded PRNG (0x243f6a88), no Math.random / Date.now — the gate is reproducible run-to-run.
function bootstrapAUC(
  pos: LabeledRow[], neg: LabeledRow[], named: [string, (r: LabeledRow) => number][],
  refIdx: number, B = 2000,
): { ci: [number, number][]; diff: ([number, number] | null)[] } {
  const nP = pos.length, nN = neg.length, denom = nP * nN;
  const posScores = named.map(([, sc]) => pos.map(sc)); // frozen per-row scores (bootstrap resamples these)
  const negScores = named.map(([, sc]) => neg.map(sc));
  let s = 0x243f6a88;
  const rand = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const aucs: number[][] = named.map(() => []);
  const diffs: number[][] = named.map(() => []);
  const pi = new Int32Array(nP), ni = new Int32Array(nN);
  const cur = new Array<number>(named.length);
  for (let b = 0; b < B; b++) {
    for (let a = 0; a < nP; a++) pi[a] = (rand() * nP) | 0; // resample pos items
    for (let c = 0; c < nN; c++) ni[c] = (rand() * nN) | 0; // then neg items
    for (let i = 0; i < named.length; i++) {
      const P = posScores[i], N = negScores[i];
      let wins = 0, ties = 0;
      for (let a = 0; a < nP; a++) {
        const p = P[pi[a]];
        for (let c = 0; c < nN; c++) {
          const n = N[ni[c]];
          if (p > n) wins++;
          else if (p === n) ties++;
        }
      }
      cur[i] = (wins + 0.5 * ties) / denom;
      aucs[i].push(cur[i]);
    }
    const ref = cur[refIdx];
    for (let i = 0; i < named.length; i++) if (i !== refIdx) diffs[i].push(cur[i] - ref);
  }
  const ci = aucs.map(xs => [pctile(xs, 0.025), pctile(xs, 0.975)] as [number, number]);
  const diff = named.map((_, i) =>
    i === refIdx ? null : [pctile(diffs[i], 0.025), pctile(diffs[i], 0.975)] as [number, number]);
  return { ci, diff };
}

// Score one cut (pos vs neg) on every arm: all-pairs AUC, keyword-tied AUC, and — when both classes
// are present — the paired bootstrap CIs. The gate reference is the STRONGEST baseline by point AUC
// (keyword wins ties — stable when everything is 0.5). Picking the max of several noisy baselines
// raises the bar slightly (selection bias runs conservative) — the right direction for a guardrail.
// `ships` is true only when a CANDIDATE beats that reference on all-pairs AUC AND its
// (arm − baseline) diff CI excludes 0 (lo > 0); below the floor there is no win regardless.
function evalCut(
  poolName: string, pos: LabeledRow[], neg: LabeledRow[],
  rubric?: RubricScores, mix?: MixInputs, withCI = true,
): PoolResult {
  const pool = [...pos, ...neg];
  const named = armsFor(pool, rubric, mix);
  let tiedPairs = 0;
  const rows: PoolResult["rows"] = named.map(([name, sc], i) => {
    const tied = aucOnKeywordTies(pos, neg, sc);
    if (i === 0) tiedPairs = tied.pairs; // arm-independent — grab it once
    return { name, auc: auc(pos, neg, sc), aucTied: tied.auc };
  });
  // random is reference-INELIGIBLE: its point AUC deviates from 0.5 by pure seed luck, and "beat
  // the seed's luck" would make the gate seed-dependent. It stays in the table as a sanity row.
  const kwIdx = rows.findIndex(r => r.name.startsWith("keyword"));
  const baseIdx = rows.reduce((best, r, i) =>
    !isCandidate(r.name) && r.name !== "random" && r.auc > rows[best].auc ? i : best, kwIdx);
  const base = rows[baseIdx];
  if (withCI && pos.length > 0 && neg.length > 0) {
    const { ci, diff } = bootstrapAUC(pos, neg, named, baseIdx);
    rows.forEach((r, i) => { r.aucCI = ci[i]; if (diff[i]) r.diffVsBase = diff[i]!; });
  }
  const clearers = belowFloor(pos.length, neg.length) ? [] : rows.filter(r =>
    isCandidate(r.name) && r.auc > base.auc && r.diffVsBase && r.diffVsBase[0] > 0);
  const champion = clearers.sort((a, b) => b.auc - a.auc)[0]?.name;
  return {
    pool: poolName, nPos: pos.length, nNeg: neg.length, pairs: pos.length * neg.length,
    tiedPairs, baseline: base.name, rows, ships: clearers.length > 0, champion,
  };
}

// ---- judge calibration: rubric grade vs hand votes, per RUBRIC.md version ----
export interface ShaCalibration {
  sha: string; firstTs: string;
  scored: number; total: number;      // review-pool coverage under THIS sha
  meanPos: number; meanNeg: number;   // mean rubric grade on 👍 / 👎 (rows scored under this sha; NaN if none)
  auc: number;                        // rubric-vs-votes AUC on pairs where BOTH tweets scored (NaN if none)
  pairs: number;
}

function calibrationFor(sh: ShaScores, pos: LabeledRow[], neg: LabeledRow[]): ShaCalibration {
  const has = (r: LabeledRow) => sh.scores.has(r.tweet_id);
  const val = (r: LabeledRow) => sh.scores.get(r.tweet_id)!;
  const sp = pos.filter(has), sn = neg.filter(has);
  const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
  const pairs = sp.length * sn.length;
  return {
    sha: sh.sha, firstTs: sh.firstTs,
    scored: sp.length + sn.length, total: pos.length + neg.length,
    meanPos: mean(sp.map(val)), meanNeg: mean(sn.map(val)),
    // only pairs where BOTH tweets have a score under this sha == sp × sn (all present by construction).
    auc: pairs === 0 ? NaN : auc(sp, sn, val), pairs,
  };
}

export interface EvalResult {
  reviewOnly: PoolResult;   // ALL hand-signed pairs — the DEV pool (advisory regression read)
  reviewGate: PoolResult;   // post-GATE_CUTOFF votes ONLY — THE prospective ship gate
  // M12: votes attributed to ✧ explore-lane serves ONLY. The main review pool is serve-selected —
  // most votes land on cards the mix ranked up, so 👎s concentrate in the serving arm's own
  // high-score region and the pool drifts toward "the mix's audit log". Explore cards are
  // day-hash-sampled from what the rankers did NOT pick, so no arm scored them into the slate —
  // a blind-spot read, though NOT an unbiased sample of the full candidate pool (eligibility is
  // conditioned on the rankers rejecting the card). Diagnostic.
  reviewAudit: PoolResult;
  // Every hand-signed vote whose tweet falls in the 200–600 char band — the region where char_len
  // is at chance (see BAND_LO/BAND_HI). Advisory diagnostic: "does the ranker have any content
  // signal where length carries none?" Never read by the verdict.
  reviewBand: PoolResult;
  rubricCoverage?: RubricCoverage;
  // Rubric coverage ON THE GATE POOL specifically. The scorer runs on its own cadence, so a gate read
  // taken right after a voting session sees freshly-signed tweets the LLM has not graded yet: the
  // rubric arm ranks them by the -1 rank-last sentinel and mix loses one of its three inputs. That
  // renders a spurious HOLD — the arms lose on missing FEATURES, not on bad ranking. Coverage on the
  // full review pool (rubricCoverage) cannot catch this: it is dominated by the older, fully-scored
  // votes and reads ~100% while the gate pool sits at 3%. Measure the pool that issues the verdict.
  gateCoverage?: RubricCoverage;
  calibration: ShaCalibration[]; // per RUBRIC.md version, oldest first ([] when no scores passed)
}

// runEval is db-FREE: the caller reads rubric scores / per-sha scores / mix inputs from the db and
// passes them in. `shaScores` (loadRubricScoresBySha) drives the judge-calibration table.
export function runEval(
  rows: LabeledRow[], rubric?: RubricScores, mix?: MixInputs, shaScores: ShaScores[] = [],
): EvalResult {
  const reviewPos = rows.filter(r => r.kind === "review_pos");
  const reviewNeg = rows.filter(r => r.kind === "review_neg");

  // DEV pool: every hand-signed 👍 vs 👎 — no balancing (reviews still train nothing). Advisory:
  // the gate's own design was chosen looking at these votes, so they regression-test, never verdict.
  const reviewOnly = evalCut(
    "REVIEW-DEV (all hand-signed 👍 vs 👎; pre-cutoff included) — ADVISORY, NEVER A VERDICT",
    reviewPos, reviewNeg, rubric, mix);

  // THE gate: votes cast at-or-after GATE_CUTOFF only — no design decision has seen them.
  // Rows without a review_ts (fixtures) count as post-cutoff.
  const isDev = (r: LabeledRow) => !!r.review_ts && r.review_ts < GATE_CUTOFF;
  const gatePos = reviewPos.filter(r => !isDev(r)), gateNeg = reviewNeg.filter(r => !isDev(r));
  const reviewGate = evalCut(
    `REVIEW-PROSPECTIVE (votes since ${GATE_CUTOFF}) — NON-CIRCULAR SHIP GATE`,
    gatePos, gateNeg, rubric, mix);

  // M12 audit: votes attributed to ✧ explore-lane serves ONLY — cards no ranker scored into the
  // slate (sampled from the rankers' rejects; ranker-conditioned, not an unbiased sample).
  // Diagnostic; it grows exactly as fast as ✧ cards get voted.
  const auditPos = reviewPos.filter(r => r.served_lane === "explore");
  const auditNeg = reviewNeg.filter(r => r.served_lane === "explore");
  const reviewAudit = evalCut(
    "REVIEW-EXPLORE (✧-lane votes only) — RANKER-BLIND-SPOT AUDIT", auditPos, auditNeg, rubric, mix);

  // Length-band cut: ALL votes (pre- and post-cutoff) whose tweet sits in the band where char_len is
  // blind. Pooled deliberately — this is already advisory-only, and the whole point is to see where
  // the ranker's content signal is, which wants every label we have.
  const inBand = (r: LabeledRow) => r.char_len >= BAND_LO && r.char_len <= BAND_HI;
  const reviewBand = evalCut(
    `REVIEW-LENGTH-BAND (${BAND_LO}–${BAND_HI} chars — where char_len is blind) — ADVISORY, NEVER A VERDICT`,
    reviewPos.filter(inBand), reviewNeg.filter(inBand), rubric, mix);

  // M8 coverage on the FULL review pool at the latest sha — the number that qualifies the rubric
  // verdict (measured against the same rows the arm ranks, so it can't over-claim).
  const reviewAll = [...reviewPos, ...reviewNeg];
  const rubricCoverage: RubricCoverage | undefined = rubric && {
    scored: reviewAll.filter(r => rubric.scores.has(r.tweet_id)).length,
    total: reviewAll.length,
    sha: rubric.sha,
  };
  // Same measure, restricted to the rows that actually issue the verdict — see EvalResult.gateCoverage.
  const gateAll = [...gatePos, ...gateNeg];
  const gateCoverage: RubricCoverage | undefined = rubric && {
    scored: gateAll.filter(r => rubric.scores.has(r.tweet_id)).length,
    total: gateAll.length,
    sha: rubric.sha,
  };

  // Judge calibration: for every RUBRIC.md version ever run, how close the LLM's grades came to the
  // hand votes — mean grade on 👍 / 👎 and the rubric-vs-votes AUC, both on rows scored under THAT
  // sha only. Ordered oldest→newest so you read down and watch the AUC move (or not) per edit.
  const calibration = [...shaScores]
    .sort((a, b) => (a.firstTs < b.firstTs ? -1 : a.firstTs > b.firstTs ? 1 : 0))
    .map(sh => calibrationFor(sh, reviewPos, reviewNeg));

  return { reviewOnly, reviewGate, reviewAudit, reviewBand, rubricCoverage, gateCoverage, calibration };
}

// ---- formatting (▼-table aesthetic preserved) ----
const comma = (n: number) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function formatPool(p: PoolResult): string {
  const sgn = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(3)}`;
  const ci = (c?: [number, number]) => c ? `[${c[0].toFixed(3)}, ${c[1].toFixed(3)}]` : "";
  const share = p.pairs ? ` (${Math.round((100 * p.tiedPairs) / p.pairs)}% of pairs)` : "";
  const head =
    `${"model".padEnd(28)} ${"AUC".padStart(7)}  ${"AUC 95% CI".padEnd(18)} ${"Δ vs base CI".padEnd(20)} ${"AUC(kw-tied)".padStart(12)}`;
  const body = p.rows.map(r => {
    const diff = r.diffVsBase
      ? `[${sgn(r.diffVsBase[0])}, ${sgn(r.diffVsBase[1])}]${r.diffVsBase[0] > 0 || r.diffVsBase[1] < 0 ? " *" : ""}`
      : "";
    const tied = Number.isNaN(r.aucTied) ? "—" : r.aucTied.toFixed(4);
    return `${r.name.padEnd(28)} ${r.auc.toFixed(4).padStart(7)}  ${ci(r.aucCI).padEnd(18)} ${diff.padEnd(20)} ${tied.padStart(12)}`;
  });
  return [
    `▼ ${p.pool}  (${p.nPos} 👍 × ${p.nNeg} 👎 = ${comma(p.pairs)} pairs; ${comma(p.tiedPairs)} keyword-tied${share}; base = ${p.baseline})`,
    head, ...body,
  ].join("\n");
}

// M8 coverage line. The rubric arm ranks the review pool, but its verdict means nothing at low
// coverage (an unscored tweet is dumped to the bottom via -1, so a mostly-unscored pool "ranks" on
// where the missing rows land, not on the LLM's judgment). Print X/Y explicitly and flag it loud
// below half, so the number itself tells you how much to trust the rubric row above.
function formatRubricCoverage(cov?: RubricCoverage): string {
  if (!cov) return "";
  const shaShort = cov.sha ? `${cov.sha.slice(0, 6)}…` : "none";
  const weak = cov.total === 0 || cov.scored < cov.total / 2
    ? `  ⚠ LOW COVERAGE — the rubric verdict above is weak; run \`npm run rubric\` to score the pool.`
    : "";
  return `rubric coverage: ${cov.scored}/${cov.total} review-pool tweets scored (sha ${shaShort})${weak}`;
}

function formatCalibration(cal: ShaCalibration[]): string {
  if (cal.length === 0) return "";
  const num = (x: number, d = 2) => Number.isNaN(x) ? "—" : x.toFixed(d);
  const head =
    `${"sha".padEnd(10)} ${"coverage".padStart(9)}  ${"mean👍".padStart(6)} ${"mean👎".padStart(6)}  ${"rubric-vs-votes AUC".padStart(19)}`;
  const body = cal.map(c =>
    `${c.sha.slice(0, 8).padEnd(10)} ${`${c.scored}/${c.total}`.padStart(9)}  ${num(c.meanPos).padStart(6)} ${num(c.meanNeg).padStart(6)}  ${num(c.auc, 4).padStart(19)}`);
  return [
    `▼ JUDGE CALIBRATION — did the LLM grade move toward your votes? (per RUBRIC.md version, oldest first)`,
    head, ...body,
    `⚠ do NOT iterate RUBRIC.md against this table — a rubric edit must come from lived digest ` +
      `experience, not from chasing this AUC (that would be tuning against the gate).`,
  ].join("\n");
}

// Default output is the dev pool (advisory) + the prospective gate + judge calibration + audit
// pool + verdict. The VERDICT reads only the post-cutoff gate pool. No supplementary pools, no
// `--all` flag — those were LR-era confounded reads that only added noise.
export function formatEval(res: EvalResult): string {
  const r = res.reviewGate;
  const total = r.nPos + r.nNeg;
  const gate = belowFloor(r.nPos, r.nNeg)
    ? `⏳ INCONCLUSIVE — only ${total} post-cutoff labels (${r.nPos} 👍 / ${r.nNeg} 👎 since ${GATE_CUTOFF}; need ` +
      `${REVIEW_MIN_N}+ total AND ≥${MIN_PER_CLASS} of each sign). The prospective gate is accumulating — keep voting; ` +
      `pre-cutoff votes are dev-only and can never verdict.`
    : r.ships
      ? `SHIP ✅  ${r.champion} beats ${r.baseline} (the strongest baseline) on the PROSPECTIVE review gate (post-cutoff votes only; all-pairs AUC AND a diff CI excluding 0) at ${r.nPos} 👍 / ${r.nNeg} 👎.`
      : `HOLD ⛔  no candidate beats ${r.baseline} (the strongest baseline) on the PROSPECTIVE review gate at ${r.nPos} 👍 / ${r.nNeg} 👎 — the baselines stay champion.`;
  // Summarize the strongest candidate's diff CI (the table has every arm's) — tied vs real gap.
  const best = [...r.rows].filter(x => isCandidate(x.name) && x.diffVsBase).sort((a, b) => b.auc - a.auc)[0];
  const ciNote = best?.diffVsBase
    ? best.diffVsBase[0] < 0 && best.diffVsBase[1] > 0
      ? `\n   best candidate (${best.name}): (arm − ${r.baseline}) AUC CI [${best.diffVsBase[0].toFixed(3)}, ${best.diffVsBase[1].toFixed(3)}] straddles 0 → statistically TIED at n=${total}.`
      : `\n   best candidate (${best.name}): (arm − ${r.baseline}) AUC CI [${best.diffVsBase[0].toFixed(3)}, ${best.diffVsBase[1].toFixed(3)}] excludes 0 → the gap is real at n=${total}, not sampling noise.`
    : "";
  const coverage = formatRubricCoverage(res.rubricCoverage);
  const calibration = formatCalibration(res.calibration);

  // STALE-FEATURE GUARD. A verdict is only meaningful if the arms had their features. When the gate
  // pool is under-scored, the rubric arm ranks on the -1 sentinel and mix runs a third blind — both
  // lose on missing data and the gate prints a HOLD that says nothing about ranking quality. This is
  // a false-HOLD detector, not a bar: it never changes what clears, it only refuses to let a
  // feature-starved read pass for a verdict. Fix is `npm run rubric`, then re-run — no gate change.
  const gc = res.gateCoverage;
  const staleFeatures = gc && gc.total > 0 && gc.scored < gc.total / 2
    ? `⚠ STALE FEATURES — the rubric has scored only ${gc.scored}/${gc.total} of the GATE pool ` +
      `(sha ${gc.sha?.slice(0, 6)}…). Unscored tweets rank last (-1 sentinel) for the rubric arm and go ` +
      `pool-neutral inside mix, so those arms are being judged on missing data, not on bad ranking. ` +
      `The verdict below is NOT trustworthy — run \`npm run rubric\` and re-run the eval.\n`
    : "";

  // M12 audit pool: print the table only when it has both classes (an all-0.5 degenerate table is
  // noise), but ALWAYS print the note — refuse to let a thin n read as a verdict, same doctrine as
  // the interleave's judged-event floor.
  const a = res.reviewAudit;
  const auditNote = belowFloor(a.nPos, a.nNeg)
    ? `⏳ audit pool too thin to trust (${a.nPos} 👍 / ${a.nNeg} 👎, below floor) — keep voting ✧ explore cards; this is the ranker-blind-spot read growing.`
    : `audit pool at ${a.nPos} 👍 / ${a.nNeg} 👎 — large enough to read; where it disagrees with the pools above, weight it: no arm scored these cards into the slate (though the sample is still conditioned on the rankers rejecting them).`;

  // Dev pool: print only when it actually differs from the gate pool (on a fixture db with no
  // review timestamps the two are identical — one table is enough).
  const dev = res.reviewOnly;
  const devDiffers = dev.nPos !== r.nPos || dev.nNeg !== r.nNeg;
  const devNote = `dev pool: advisory ONLY — the AUC metric, strongest-baseline policy and credit formula were ` +
    `chosen while inspecting these votes, so no CI here accounts for those choices. Regression read, never a verdict.`;

  // Length-band cut: same doctrine as the audit pool — always print the note, print the table only
  // when both classes are present. The note names the ONE thing this cut is for and the one thing it
  // must never become.
  const b = res.reviewBand;
  const bandNote = belowFloor(b.nPos, b.nNeg)
    ? `⏳ length-band cut too thin to read (${b.nPos} 👍 / ${b.nNeg} 👎, below floor) — keep voting.`
    : `length band: char_len scores ~0.5 HERE by construction (that's the point — 👍-rate is flat across ` +
      `${BAND_LO}–${BAND_HI}), so an arm above 0.5 is finding signal that length cannot. ADVISORY ONLY: the band ` +
      `edges were read off the dev pool AND this cut postdates a HOLD — it says WHERE the ranker fails, never ` +
      `whether it ships. Making it a bar to clear = a gate-design change = re-freeze, GATE_CUTOFF forward.`;

  return [
    ...(devDiffers ? [formatPool(dev), devNote, ""] : []),
    // an empty gate pool prints no degenerate all-0.5 table — the verdict line carries the state
    ...(r.pairs > 0 ? [formatPool(r)] : []),
    ...(coverage ? [coverage] : []),
    ...(calibration ? ["", calibration] : []),
    "",
    ...(a.pairs > 0 ? [formatPool(a), ""] : []),
    auditNote, "",
    ...(b.pairs > 0 ? [formatPool(b), ""] : []),
    bandNote, "",
    ...(staleFeatures ? [staleFeatures] : []),
    gate + ciNote,
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { DatabaseSync } = await import("node:sqlite");
  const { buildTaste, buildAuthorPrior } = await import("./digest.ts");
  const db = new DatabaseSync(process.env.AFY_DB ?? "afy.db");
  // eval stays strictly read-only: loadRubricScores / loadRubricScoresBySha tolerate a missing
  // rubric_scores table (return empty) and NEVER create it — the scorer/server own the CREATE.
  // MixInputs mirror exactly what buildDigest ships: same taste profile, same author prior.
  console.log(formatEval(runEval(
    buildLabels(db), loadRubricScores(db),
    { taste: buildTaste(db), authorPrior: buildAuthorPrior(db) },
    loadRubricScoresBySha(db),
  )));
}
