// M6 — Offline replay eval = the ship gate (PRD §9), M12-rethought into a GUARDRAIL: the online
// interleave (interleave.ts) is the verdict-maker; this gate answers "does any candidate arm beat
// the keyword baseline on the hand-signed review pool" — beating random/recency/char_len is
// necessary but not sufficient. A candidate clears only if it beats keyword point-wise on NDCG@10
// AND MAP *and* its paired-bootstrap (arm − keyword) MAP CI excludes 0 — a CI straddling 0 means
// TIED, not a win. Every review-pool arm gets that diff CI, not just v1 (the M9 review's deferred
// requirement). If everything loses, that's a real result; we print it, we don't ship.
//
// Note on v0: the existing behavioral ranker (ranker.ts) scores dwell/opened/liked — the
// held-out candidates here are text-only harvested likes with no impressions, so v0 scores them
// all ~0. It is NOT a meaningful comparator on this surface; the content baselines below are.
import type { LabeledRow } from "./labels.ts";
import { buildLabels, AI_LEXICON } from "./labels.ts";
import { train, predict, hashStr, type Model } from "./ranker_v1.ts";
import { loadRubricScores, type RubricScores } from "./rubric.ts";
import { scoreText, mixFinal, type TasteModel } from "./digest.ts";

export { loadRubricScores, type RubricScores }; // re-export: pre-M9 home of these was eval.ts

// ---- metrics ----
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

// Rank the test pool by `score` desc (stable tiebreak on tweet_id), return relevance sequence.
function ranked(test: LabeledRow[], score: (r: LabeledRow) => number): number[] {
  return [...test]
    .map(r => ({ label: r.label, s: score(r), id: r.tweet_id }))
    .sort((a, b) => b.s - a.s || (a.id < b.id ? -1 : 1))
    .map(x => x.label);
}

function metrics(test: LabeledRow[], score: (r: LabeledRow) => number) {
  const rels = ranked(test, score);
  return { ndcg10: ndcgAt(rels, 10), ndcg50: ndcgAt(rels, 50), map: averagePrecision(rels) };
}

// ---- baselines (content, like-for-like with v1) ----
const lexiconScore = (r: LabeledRow) => {
  const text = r.text.toLowerCase();
  return AI_LEXICON.reduce((n, kw) => n + (text.includes(kw) ? 1 : 0), 0);
};
const recencyScore = (r: LabeledRow) => Date.parse(r.created_at) || 0;
const charLenScore = (r: LabeledRow) => r.char_len;             // confound check: v1 must beat this

// LABEL-INDEPENDENT random baseline. NOT hashStr(tweet_id): tweet_id is a time-ordered snowflake,
// and positives (older harvested likes) vs easy-negs (recent timeline) live in different id ranges,
// so any function of the id correlates with the label and fakes a perfect "random" score. Instead
// assign a seeded-PRNG value per row in array order — the PRNG never sees the label.
function randomScorer(rows: LabeledRow[]): (r: LabeledRow) => number {
  let s = 0x9e3779b9;
  const m = new Map<string, number>();
  for (const r of rows) { s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) >>> 0; m.set(r.tweet_id, s); }
  return (r) => m.get(r.tweet_id) ?? 0;
}

// Time-based split, stratified BY KIND (pos / hard_neg / easy_neg) so each appears in train and
// test. Stratifying by label would be wrong: hard_neg and easy_neg share label 0 but live in
// different eras (hard_neg = old harvested prunes, easy_neg = recent timeline), so a newest-30%
// label-0 slice would be ALL easy_neg and starve the same-era pool of negatives. Within each
// kind: oldest `frac` → train, newest → test.
//
// REVIEW KINDS GO 100% TO TEST (M12 rethink). The time-split existed to stop the LR memorizing its
// own test rows — but no arm trains on reviews anymore (v1 is behavioral-only below; taste/author
// already exclude reviewed tweets via the M9 leak guard; keyword is fixed; rubric is an LLM), so
// spending the oldest 70% of hand-signed gold on a dead trainee just starved the gate (balanced
// n=88 while 387 reviews existed). Every review is test; the gate gets its full resolution.
export function splitByTime(rows: LabeledRow[], frac = 0.7): { train: LabeledRow[]; test: LabeledRow[] } {
  const train: LabeledRow[] = [], test: LabeledRow[] = [];
  for (const kind of ["pos", "hard_neg", "easy_neg", "review_pos", "review_neg"] as const) {
    const cls = rows.filter(r => r.kind === kind)
      .sort((a, b) => (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0));
    const cut = kind.startsWith("review") ? 0 : Math.floor(cls.length * frac);
    train.push(...cls.slice(0, cut));
    test.push(...cls.slice(cut));
  }
  return { train, test };
}

export interface PoolResult {
  pool: string;
  n: number; // balanced test-pool size (both classes) — small n = noisy gate, warn on it
  rows: {
    name: string; ndcg10: number; ndcg50: number; map: number; mapCI?: [number, number];
    diffVsKw?: [lo: number, hi: number]; // paired bootstrap on (arm − keyword) MAP — every arm, not just v1
  }[];
  ships: boolean;      // some CANDIDATE arm beats keyword: NDCG@10 AND MAP point-wise, AND (when CI ran) diff CI > 0
  champion?: string;   // the candidate that cleared it (highest MAP among clearers)
}

// Baselines never ship — they exist to be beaten. Everything else in a pool is a candidate.
const BASELINES = new Set(["random", "recency", "char_len"]);
const isCandidate = (name: string) => !BASELINES.has(name) && !name.startsWith("keyword");

// Paired bootstrap (ported from the closed M6 embedding experiment): resample the test rows with
// replacement B times and recompute every scorer's MAP on the SAME resample, so the per-model CIs
// and the (v1 − keyword) diff CI share sampling noise. Seeded PRNG, no Math.random — the gate must
// be reproducible run-to-run.
function bootstrapMaps(test: LabeledRow[], named: [string, (r: LabeledRow) => number][], B = 2000): number[][] {
  let s = 0x243f6a88;
  const rand = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const scored = named.map(([, sc]) => test.map(r => ({ l: r.label, sc: sc(r), id: r.tweet_id })));
  const maps: number[][] = named.map(() => []);
  for (let b = 0; b < B; b++) {
    const pick = Array.from({ length: test.length }, () => Math.floor(rand() * test.length));
    scored.forEach((rows, i) => {
      const rels = pick.map(j => rows[j]).sort((a, b2) => b2.sc - a.sc || (a.id < b2.id ? -1 : 1)).map(x => x.l);
      maps[i].push(averagePrecision(rels));
    });
  }
  return maps;
}
const pctile = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor(p * (xs.length - 1))];

export interface EvalResult {
  reviewOnly: PoolResult; // review_pos vs review_neg — hand-signed, NON-CIRCULAR — THE real ship gate
  // M12: votes attributed to ✧ explore-lane serves ONLY. The main review pool is serve-selected —
  // most votes land on cards the mix ranked up, so 👎s concentrate in the serving arm's own
  // high-score region and the pool drifts toward "the mix's audit log". Explore cards are
  // day-hash-sampled (no ranker chose them), so this subset is the serve-bias-free read. Small
  // for now; it grows exactly as fast as ✧ cards get voted. Diagnostic, not yet the gate.
  reviewAudit: PoolResult;
  sameEra: PoolResult;    // pos vs hard_neg — era-matched but keyword-curated (near-circular baseline)
  full: PoolResult;       // pos vs all negs — era-confounded, supplementary
  rubricCoverage?: RubricCoverage; // M8: how much of the review pool the LLM has actually scored
}

// M8 rubric arm. Scores are read from the db (rubric_scores, via rubric.ts) for the LATEST
// rubric_sha present, and passed in as a tweet_id→score map. A verdict is only as trustworthy as
// its coverage, so we carry the coverage numbers alongside and print them next to the arm — a
// rubric line at 3/44 coverage is visibly weak by construction, not silently mistaken for a result.
export interface RubricCoverage { scored: number; total: number; sha: string | null }

// M9 mix arm inputs — built from the db by the caller (runEval itself stays db-free). The taste
// model comes from digest.buildTaste (reviewed tweets excluded from the profile — the leak guard),
// the prior from digest.buildAuthorPrior (engagement_labels ONLY, never reviews).
export interface MixInputs { taste: TasteModel; authorPrior: Map<string, number> }

// The rubric scorer as a LabeledRow scorer: an unscored tweet gets -1 so it sorts BELOW every real
// 0–10 score, deterministically (the ranked()/bootstrap tiebreak on tweet_id keeps ties stable).
// This is the "missing scores rank last, deterministically" contract from the plan.
function rubricScorer(rs: RubricScores): (r: LabeledRow) => number {
  return (r) => rs.scores.get(r.tweet_id) ?? -1;
}

function evalPool(
  pool: string, test: LabeledRow[], v1: Model, v1NoAuthor: Model,
  withCI = false, extra: [string, (r: LabeledRow) => number][] = [],
): PoolResult {
  const named: [string, (r: LabeledRow) => number][] = [
    ["random", randomScorer(test)],
    ["recency", recencyScore],
    ["char_len", charLenScore],
    ["keyword (baseline to beat)", lexiconScore],
    ["v1 LR (no author)", (r) => predict(v1NoAuthor, r)],
    ["v1 LR (full)", (r) => predict(v1, r)],
    // extra arms ride ONLY the review pool (rubric / taste / mix — built in runEval). THE M8/M9
    // question lives here: does anything beat keyword on the honest gate where the LR lost?
    ...extra,
  ];
  const rows: PoolResult["rows"] = named.map(([name, s]) => ({ name, ...metrics(test, s) }));
  const keyword = rows.find(r => r.name.startsWith("keyword"))!;
  if (withCI && test.length > 0) {
    const maps = bootstrapMaps(test, named);
    const kw = named.findIndex(([n]) => n.startsWith("keyword"));
    rows.forEach((r, i) => {
      r.mapCI = [pctile(maps[i], 0.025), pctile(maps[i], 0.975)];
      if (i === kw) return;
      const diff = maps[i].map((m, b) => m - maps[kw][b]);
      r.diffVsKw = [pctile(diff, 0.025), pctile(diff, 0.975)];
    });
  }
  // The gate, generalized past v1: ANY candidate arm can clear it, but only honestly — point-wise
  // better on both metrics AND, when the bootstrap ran, a diff CI that excludes 0 (tied ≠ win).
  const clearers = rows.filter(r =>
    isCandidate(r.name) && r.ndcg10 > keyword.ndcg10 && r.map > keyword.map &&
    (r.diffVsKw ? r.diffVsKw[0] > 0 : true));
  const champion = clearers.sort((a, b) => b.map - a.map)[0]?.name;
  return { pool, n: test.length, rows, ships: clearers.length > 0, champion };
}

// Class-balance a test pool by deterministically downsampling the majority class to the minority
// count. WHY THIS IS REQUIRED, not cosmetic: the same-era pool is ~86% positive (pos hugely
// outnumber same-era hard_negs), so NDCG@10/MAP SATURATE — the top-k is nearly all-positive under
// ANY score, so `random` and `char_len` both hit 1.0 and the gate can't discriminate. A 50/50 pool
// makes random→~0.5 and lets keyword vs v1 actually separate. Deterministic (hashStr sort, no
// Math.random) so the gate is reproducible. Throws away majority-class test rows on purpose — a
// fair-but-smaller gate beats a large meaningless one.
function balancePool(test: LabeledRow[]): LabeledRow[] {
  const pos = test.filter(r => r.label === 1);
  const neg = test.filter(r => r.label === 0);
  const [maj, min] = pos.length >= neg.length ? [pos, neg] : [neg, pos];
  const keptMaj = [...maj].sort((a, b) => hashStr(a.tweet_id) - hashStr(b.tweet_id)).slice(0, min.length);
  return [...keptMaj, ...min];
}

export function runEval(rows: LabeledRow[], rubric?: RubricScores, mix?: MixInputs): EvalResult {
  const { train: tr, test } = splitByTime(rows);
  // v1 trains on BEHAVIORAL labels only (splitByTime routes every review row to test) — it kept
  // losing the gate (below random at n=88, five readings running), so it no longer earns gold.
  const v1 = train(tr, { useAuthor: true });
  const v1NoAuthor = train(tr, { useAuthor: false }); // ablation: author can memorize

  // REVIEW-ONLY: hand-signed 👍 vs 👎 — no keyword lexicon touched the labels, so this is the honest
  // gate. Balanced 50/50 so the metric discriminates. (Thin until you sign more — see the count.)
  const reviewTest = balancePool(test.filter(r => r.kind === "review_pos" || r.kind === "review_neg"));
  // SAME-ERA: pos vs topical-prune hard_neg — matched era but the negs were drawn with the AI lexicon,
  // so the keyword baseline here is near-circular. Kept as a supplementary read, no longer THE gate.
  const sameEraTest = balancePool(test.filter(r => r.kind === "pos" || r.kind === "hard_neg"));

  // M8 coverage: fraction of the ACTUAL (balanced) review test pool that carries a rubric score at
  // the latest sha. This is the number that qualifies the rubric verdict — measured against the same
  // pool the arm ranks, so it can't over-claim.
  const rubricCoverage: RubricCoverage | undefined = rubric && {
    scored: reviewTest.filter(r => rubric.scores.has(r.tweet_id)).length,
    total: reviewTest.length,
    sha: rubric.sha,
  };

  // M12: the serve-bias-free audit pool — review votes whose attributed serve was a ✧ explore card.
  const auditTest = balancePool(test.filter(r =>
    (r.kind === "review_pos" || r.kind === "review_neg") && r.served_lane === "explore"));

  // Review-pool-only arms, built per pool. rubric = the pure LLM judge (M8, −1 rank-last sentinel
  // for missing). taste = the pre-M9 shipped ranker (digest cosine) — the status quo the mix must
  // justify itself against, not just keyword. mix = THE digest formula (digest.mixFinal, weights
  // and all): z-scored over the pool being ranked — the mix's own definition, matching buildDigest —
  // then frozen (the bootstrap resamples frozen per-row scores, same as every other arm); missing
  // rubric is z=0 pool-neutral here, never −1 (the M9 contract). Per-pool z means the mix row is
  // comparable WITHIN a pool, not across pools.
  const armsFor = (pool: LabeledRow[]): [string, (r: LabeledRow) => number][] => {
    const extra: [string, (r: LabeledRow) => number][] = [];
    if (rubric) extra.push(["rubric (LLM judge)", rubricScorer(rubric)]);
    if (mix) {
      const tasteOf = (r: LabeledRow) => scoreText(r.text, mix.taste);
      extra.push(["taste (digest cosine)", tasteOf]);
      const finals = mixFinal(pool.map(r => ({
        taste: tasteOf(r),
        rubric: rubric?.scores.get(r.tweet_id) ?? null,
        author: mix.authorPrior.get(r.author_id) ?? 0,
      })));
      const byId = new Map(pool.map((r, i) => [r.tweet_id, finals[i].final]));
      extra.push(["mix (M9 digest blend)", (r) => byId.get(r.tweet_id) ?? 0]);
    }
    return extra;
  };

  return {
    // CI only on the review pools — they're the gates that get trusted, and the ones small enough
    // to need error bars. The supplementary pools are confounded; tighter bars wouldn't make them mean more.
    // The extra arms ride ONLY on these pools (the honest gates); the supplementary pools stay as-is.
    reviewOnly: evalPool("REVIEW-ONLY (hand-signed 👍 vs 👎) — NON-CIRCULAR SHIP GATE", reviewTest, v1, v1NoAuthor, true, armsFor(reviewTest)),
    reviewAudit: evalPool("REVIEW-EXPLORE (✧-lane votes only) — SERVE-BIAS-FREE AUDIT", auditTest, v1, v1NoAuthor, true, armsFor(auditTest)),
    sameEra: evalPool("SAME-ERA (pos vs topical-prune negs) — keyword-curated, supplementary", sameEraTest, v1, v1NoAuthor),
    full: evalPool("FULL (pos vs all negs) — era-confounded, supplementary", test, v1, v1NoAuthor),
    rubricCoverage,
  };
}

function formatPool(p: PoolResult): string {
  const hasCI = p.rows.some(r => r.mapCI);
  const ciHead = hasCI ? `  ${"MAP 95% CI".padEnd(16)}  Δ vs keyword` : "";
  const head = `${"model".padEnd(28)} ${"NDCG@10".padStart(8)} ${"NDCG@50".padStart(8)} ${"MAP".padStart(8)}${ciHead}`;
  const sgn = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(3)}`;
  const body = p.rows.map(r =>
    `${r.name.padEnd(28)} ${r.ndcg10.toFixed(4).padStart(8)} ${r.ndcg50.toFixed(4).padStart(8)} ${r.map.toFixed(4).padStart(8)}` +
    (r.mapCI ? `  ${`[${r.mapCI[0].toFixed(3)}, ${r.mapCI[1].toFixed(3)}]`.padEnd(16)}` : "") +
    // per-arm paired diff CI vs keyword: * marks a CI that excludes 0 (a real gap, either direction)
    (r.diffVsKw ? `  [${sgn(r.diffVsKw[0])}, ${sgn(r.diffVsKw[1])}]${r.diffVsKw[0] > 0 || r.diffVsKw[1] < 0 ? " *" : ""}` : ""),
  );
  return [`▼ ${p.pool}  (balanced test n=${p.n})`, head, ...body].join("\n");
}

// n below which the review gate is too thin to trust either way — sign more before believing it.
const REVIEW_MIN_N = 40;

// M8 coverage line. The rubric arm ranks the review pool, but its verdict means nothing at low
// coverage (an unscored tweet is dumped to the bottom via -1, so a mostly-unscored pool "ranks" on
// where the missing rows land, not on the LLM's judgment). Print X/Y explicitly and flag it loud
// below half, so the number itself tells you how much to trust the rubric row above.
function formatRubricCoverage(cov?: RubricCoverage): string {
  if (!cov) return "";
  const shaShort = cov.sha ? `${cov.sha.slice(0, 6)}…` : "none";
  const pct = cov.total ? Math.round((100 * cov.scored) / cov.total) : 0;
  const weak = cov.total === 0 || cov.scored < cov.total / 2
    ? `  ⚠ LOW COVERAGE — the rubric verdict above is weak; run \`npm run rubric\` to score the pool.`
    : "";
  return `rubric coverage: ${cov.scored}/${cov.total} review-pool tweets scored (sha ${shaShort})${weak}`;
}

// Default output is the review pool + verdict ONLY — the supplementary pools were LR-era scaffolding
// (era-confounded / keyword-circular) and mostly added noise to the read. `--all` still prints them.
export function formatEval(res: EvalResult, { all = false } = {}): string {
  const r = res.reviewOnly;
  const gate = r.n < REVIEW_MIN_N
    ? `⏳ INCONCLUSIVE — only ${r.n} hand-signed test labels (need ~${REVIEW_MIN_N}+). Sign more 👍/👎 in the ` +
      `reading client, then re-run. The keyword gate below is near-circular, so this is the one that counts.`
    : r.ships
      ? `SHIP ✅  ${r.champion} beats keyword on the NON-CIRCULAR review gate (NDCG@10 AND MAP, diff CI excludes 0) at n=${r.n}.`
      : `HOLD ⛔  no candidate beats keyword on the review gate at n=${r.n} — keyword stays the champion.`;
  // Summarize the strongest candidate's diff CI (the table has every arm's) — tied vs real gap.
  const best = [...r.rows].filter(x => isCandidate(x.name) && x.diffVsKw).sort((a, b) => b.map - a.map)[0];
  const ciNote = best?.diffVsKw
    ? best.diffVsKw[0] < 0 && best.diffVsKw[1] > 0
      ? `\n   best candidate (${best.name}): (arm − keyword) MAP CI [${best.diffVsKw[0].toFixed(3)}, ${best.diffVsKw[1].toFixed(3)}] straddles 0 → statistically TIED at n=${r.n}.`
      : `\n   best candidate (${best.name}): (arm − keyword) MAP CI [${best.diffVsKw[0].toFixed(3)}, ${best.diffVsKw[1].toFixed(3)}] excludes 0 → the gap is real at n=${r.n}, not sampling noise.`
    : "";
  const coverage = formatRubricCoverage(res.rubricCoverage);
  // M12 audit pool: print it always (movement is visible early), but refuse to let a thin n read
  // as a verdict — same doctrine as the interleave's judged-event floor.
  const audit = res.reviewAudit;
  const auditNote = audit.n < REVIEW_MIN_N
    ? `⏳ audit pool too thin to trust (n=${audit.n} < ${REVIEW_MIN_N}) — keep voting ✧ explore cards; this is the serve-bias-free gate growing.`
    : `audit pool at n=${audit.n} — large enough to read; where it disagrees with REVIEW-ONLY above, trust the audit (no serve bias).`;
  const supplementary = all
    ? [formatPool(res.sameEra), "", formatPool(res.full), ""]
    : ["(supplementary same-era/full pools hidden — `npm run eval -- --all` to print them)", ""];
  return [
    formatPool(res.reviewOnly),
    ...(coverage ? [coverage] : []), "",
    ...(audit.n > 0 ? [formatPool(audit)] : []), // an empty pool's all-zero table is noise; the note suffices
    auditNote, "",
    ...supplementary,
    gate + ciNote,
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { DatabaseSync } = await import("node:sqlite");
  const { buildTaste, buildAuthorPrior } = await import("./digest.ts");
  const db = new DatabaseSync(process.env.AFY_DB ?? "afy.db");
  // loadRubricScores tolerates a missing rubric_scores table (returns empty) so eval stays strictly
  // read-only — it never creates the table. The scorer (rubric.ts) and server own the CREATE.
  // MixInputs mirror exactly what buildDigest ships: same taste profile, same author prior.
  console.log(formatEval(runEval(
    buildLabels(db), loadRubricScores(db),
    { taste: buildTaste(db), authorPrior: buildAuthorPrior(db) },
  ), { all: process.argv.includes("--all") }));
}
