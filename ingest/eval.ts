// M6 — Offline replay eval = THE SHIP GATE (PRD §9). Rank a held-out pool of {positives,
// negatives} and measure NDCG@k / MAP. v1 ships ONLY if it beats the AI-keyword lexical
// baseline (the rule-of-thumb that loosely built the labels) — beating random/recency/char_len
// is necessary but not sufficient. If v1 loses, that's a real result; we print it, we don't ship.
// The review gate also prints a paired-bootstrap 95% CI per MAP and on (v1 − keyword): at small n
// the point estimates are noisy, and a diff CI straddling 0 means TIED, not a loss/win.
//
// Note on v0: the existing behavioral ranker (ranker.ts) scores dwell/opened/liked — the
// held-out candidates here are text-only harvested likes with no impressions, so v0 scores them
// all ~0. It is NOT a meaningful comparator on this surface; the content baselines below are.
import type { DatabaseSync } from "node:sqlite";
import type { LabeledRow } from "./labels.ts";
import { buildLabels, AI_LEXICON } from "./labels.ts";
import { train, predict, hashStr, type Model } from "./ranker_v1.ts";

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
export function splitByTime(rows: LabeledRow[], frac = 0.7): { train: LabeledRow[]; test: LabeledRow[] } {
  const train: LabeledRow[] = [], test: LabeledRow[] = [];
  for (const kind of ["pos", "hard_neg", "easy_neg", "review_pos", "review_neg"] as const) {
    const cls = rows.filter(r => r.kind === kind)
      .sort((a, b) => (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0));
    const cut = Math.floor(cls.length * frac);
    train.push(...cls.slice(0, cut));
    test.push(...cls.slice(cut));
  }
  return { train, test };
}

export interface PoolResult {
  pool: string;
  n: number; // balanced test-pool size (both classes) — small n = noisy gate, warn on it
  rows: { name: string; ndcg10: number; ndcg50: number; map: number; mapCI?: [number, number] }[];
  ships: boolean;
  diffCI?: [lo: number, median: number, hi: number]; // paired bootstrap on (v1 full − keyword) MAP
}

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
  sameEra: PoolResult;    // pos vs hard_neg — era-matched but keyword-curated (near-circular baseline)
  full: PoolResult;       // pos vs all negs — era-confounded, supplementary
  rubricCoverage?: RubricCoverage; // M8: how much of the review pool the LLM has actually scored
}

// M8 rubric arm. Scores are read from the db (rubric_scores) for the LATEST rubric_sha present, and
// passed in as a tweet_id→score map. A verdict is only as trustworthy as its coverage, so we carry
// the coverage numbers alongside and print them next to the arm — a rubric line at 3/44 coverage is
// visibly weak by construction, not silently mistaken for a real result.
export interface RubricScores { sha: string | null; scores: Map<string, number> }
export interface RubricCoverage { scored: number; total: number; sha: string | null }

// The rubric scorer as a LabeledRow scorer: an unscored tweet gets -1 so it sorts BELOW every real
// 0–10 score, deterministically (the ranked()/bootstrap tiebreak on tweet_id keeps ties stable).
// This is the "missing scores rank last, deterministically" contract from the plan.
function rubricScorer(rs: RubricScores): (r: LabeledRow) => number {
  return (r) => rs.scores.get(r.tweet_id) ?? -1;
}

function evalPool(
  pool: string, test: LabeledRow[], v1: Model, v1NoAuthor: Model,
  withCI = false, rubric?: RubricScores,
): PoolResult {
  const named: [string, (r: LabeledRow) => number][] = [
    ["random", randomScorer(test)],
    ["recency", recencyScore],
    ["char_len", charLenScore],
    ["keyword (baseline to beat)", lexiconScore],
    ["v1 LR (no author)", (r) => predict(v1NoAuthor, r)],
    ["v1 LR (full)", (r) => predict(v1, r)],
    // rubric arm added ONLY where a score map is passed (the review pool). THE M8 question: does an
    // LLM judge beat keyword on the honest gate where the bigram LR and embeddings both lost?
    ...(rubric ? [["rubric (LLM judge)", rubricScorer(rubric)] as [string, (r: LabeledRow) => number]] : []),
  ];
  const rows: PoolResult["rows"] = named.map(([name, s]) => ({ name, ...metrics(test, s) }));
  const keyword = rows.find(r => r.name.startsWith("keyword"))!;
  const v1full = rows.find(r => r.name === "v1 LR (full)")!;
  const ships = v1full.ndcg10 > keyword.ndcg10 && v1full.map > keyword.map;
  let diffCI: PoolResult["diffCI"];
  if (withCI && test.length > 0) {
    const maps = bootstrapMaps(test, named);
    rows.forEach((r, i) => { r.mapCI = [pctile(maps[i], 0.025), pctile(maps[i], 0.975)]; });
    const kw = named.findIndex(([n]) => n.startsWith("keyword"));
    const v1i = named.findIndex(([n]) => n === "v1 LR (full)");
    const diff = maps[v1i].map((m, b) => m - maps[kw][b]);
    diffCI = [pctile(diff, 0.025), pctile(diff, 0.5), pctile(diff, 0.975)];
  }
  return { pool, n: test.length, rows, ships, diffCI };
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

export function runEval(rows: LabeledRow[], rubric?: RubricScores): EvalResult {
  const { train: tr, test } = splitByTime(rows);
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
  return {
    // CI only on the review pool — it's the gate that gets trusted, and the one that's small enough
    // to need error bars. The supplementary pools are confounded; tighter bars wouldn't make them mean more.
    // The rubric arm rides ONLY on this pool (the honest gate); the supplementary pools stay as-is.
    reviewOnly: evalPool("REVIEW-ONLY (hand-signed 👍 vs 👎) — NON-CIRCULAR SHIP GATE", reviewTest, v1, v1NoAuthor, true, rubric),
    sameEra: evalPool("SAME-ERA (pos vs topical-prune negs) — keyword-curated, supplementary", sameEraTest, v1, v1NoAuthor),
    full: evalPool("FULL (pos vs all negs) — era-confounded, supplementary", test, v1, v1NoAuthor),
    rubricCoverage,
  };
}

// Read rubric scores from the db for the LATEST rubric_sha present in rubric_scores (missing → the
// map simply lacks the id, and rubricScorer sorts it last). "Latest" = the sha of the most recent
// row by ts; a rubric edit starts a fresh sha, so this always evaluates the current rubric version.
export function loadRubricScores(db: DatabaseSync): RubricScores {
  // Tolerate a db that has never been scored: if rubric_scores doesn't exist yet, return empty
  // WITHOUT creating it — `npm run eval` must be strictly read-only (the scorer/server own the
  // CREATE). A missing table just means zero coverage, which the arm + coverage line handle.
  let latest: { rubric_sha: string } | undefined;
  try {
    latest = db.prepare(
      `SELECT rubric_sha FROM rubric_scores ORDER BY ts DESC, rowid DESC LIMIT 1`,
    ).get() as { rubric_sha: string } | undefined;
  } catch { return { sha: null, scores: new Map() }; } // "no such table: rubric_scores"
  const sha = latest?.rubric_sha ?? null;
  const scores = new Map<string, number>();
  if (sha) {
    // Latest score per tweet at this sha (append-only means a re-score could leave >1 row; take the
    // newest). Scores are integers 0–10.
    const rows = db.prepare(`
      SELECT s.tweet_id, s.score FROM rubric_scores s
      JOIN (SELECT tweet_id, MAX(rowid) mr FROM rubric_scores WHERE rubric_sha = ? GROUP BY tweet_id) l
        ON s.tweet_id = l.tweet_id AND s.rowid = l.mr
    `).all(sha) as { tweet_id: string; score: number }[];
    for (const r of rows) scores.set(r.tweet_id, r.score);
  }
  return { sha, scores };
}

function formatPool(p: PoolResult): string {
  const ciHead = p.rows.some(r => r.mapCI) ? "  MAP 95% CI" : "";
  const head = `${"model".padEnd(28)} ${"NDCG@10".padStart(8)} ${"NDCG@50".padStart(8)} ${"MAP".padStart(8)}${ciHead}`;
  const body = p.rows.map(r =>
    `${r.name.padEnd(28)} ${r.ndcg10.toFixed(4).padStart(8)} ${r.ndcg50.toFixed(4).padStart(8)} ${r.map.toFixed(4).padStart(8)}` +
    (r.mapCI ? `  [${r.mapCI[0].toFixed(3)}, ${r.mapCI[1].toFixed(3)}]` : ""),
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

export function formatEval(res: EvalResult): string {
  const r = res.reviewOnly;
  const gate = r.n < REVIEW_MIN_N
    ? `⏳ INCONCLUSIVE — only ${r.n} hand-signed test labels (need ~${REVIEW_MIN_N}+). Sign more 👍/👎 in the ` +
      `reading client, then re-run. The keyword gate below is near-circular, so this is the one that counts.`
    : r.ships
      ? `SHIP ✅  v1 beats keyword on the NON-CIRCULAR review gate (NDCG@10 AND MAP) at n=${r.n}.`
      : `HOLD ⛔  v1 does NOT beat keyword on the review gate at n=${r.n} — do not ship v1.`;
  const d = r.diffCI;
  const ciNote = d
    ? d[0] < 0 && d[2] > 0
      ? `\n   (v1 − keyword) MAP CI [${d[0].toFixed(3)}, ${d[2].toFixed(3)}] straddles 0 → statistically TIED at n=${r.n}; sign more labels before trusting the verdict either way.`
      : `\n   (v1 − keyword) MAP CI [${d[0].toFixed(3)}, ${d[2].toFixed(3)}] excludes 0 → the gap is real at n=${r.n}, not sampling noise.`
    : "";
  const coverage = formatRubricCoverage(res.rubricCoverage);
  return [
    formatPool(res.reviewOnly),
    ...(coverage ? [coverage] : []), "",
    formatPool(res.sameEra), "",
    formatPool(res.full), "",
    gate + ciNote,
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(process.env.AFY_DB ?? "afy.db");
  // loadRubricScores tolerates a missing rubric_scores table (returns empty) so eval stays strictly
  // read-only — it never creates the table. The scorer (rubric.ts) and server own the CREATE.
  console.log(formatEval(runEval(buildLabels(db), loadRubricScores(db))));
}
