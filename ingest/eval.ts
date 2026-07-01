// M6 — Offline replay eval = THE SHIP GATE (PRD §9). Rank a held-out pool of {positives,
// negatives} and measure NDCG@k / MAP. v1 ships ONLY if it beats the AI-keyword lexical
// baseline (the rule-of-thumb that loosely built the labels) — beating random/recency/char_len
// is necessary but not sufficient. If v1 loses, that's a real result; we print it, we don't ship.
//
// Note on v0: the existing behavioral ranker (ranker.ts) scores dwell/opened/liked — the
// held-out candidates here are text-only harvested likes with no impressions, so v0 scores them
// all ~0. It is NOT a meaningful comparator on this surface; the content baselines below are.
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
  rows: { name: string; ndcg10: number; ndcg50: number; map: number }[];
  ships: boolean;
}

export interface EvalResult {
  reviewOnly: PoolResult; // review_pos vs review_neg — hand-signed, NON-CIRCULAR — THE real ship gate
  sameEra: PoolResult;    // pos vs hard_neg — era-matched but keyword-curated (near-circular baseline)
  full: PoolResult;       // pos vs all negs — era-confounded, supplementary
}

function evalPool(pool: string, test: LabeledRow[], v1: Model, v1NoAuthor: Model): PoolResult {
  const named: [string, (r: LabeledRow) => number][] = [
    ["random", randomScorer(test)],
    ["recency", recencyScore],
    ["char_len", charLenScore],
    ["keyword (baseline to beat)", lexiconScore],
    ["v1 LR (no author)", (r) => predict(v1NoAuthor, r)],
    ["v1 LR (full)", (r) => predict(v1, r)],
  ];
  const rows = named.map(([name, s]) => ({ name, ...metrics(test, s) }));
  const keyword = rows.find(r => r.name.startsWith("keyword"))!;
  const v1full = rows.find(r => r.name === "v1 LR (full)")!;
  const ships = v1full.ndcg10 > keyword.ndcg10 && v1full.map > keyword.map;
  return { pool, n: test.length, rows, ships };
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

export function runEval(rows: LabeledRow[]): EvalResult {
  const { train: tr, test } = splitByTime(rows);
  const v1 = train(tr, { useAuthor: true });
  const v1NoAuthor = train(tr, { useAuthor: false }); // ablation: author can memorize

  // REVIEW-ONLY: hand-signed 👍 vs 👎 — no keyword lexicon touched the labels, so this is the honest
  // gate. Balanced 50/50 so the metric discriminates. (Thin until you sign more — see the count.)
  const reviewTest = balancePool(test.filter(r => r.kind === "review_pos" || r.kind === "review_neg"));
  // SAME-ERA: pos vs topical-prune hard_neg — matched era but the negs were drawn with the AI lexicon,
  // so the keyword baseline here is near-circular. Kept as a supplementary read, no longer THE gate.
  const sameEraTest = balancePool(test.filter(r => r.kind === "pos" || r.kind === "hard_neg"));
  return {
    reviewOnly: evalPool("REVIEW-ONLY (hand-signed 👍 vs 👎) — NON-CIRCULAR SHIP GATE", reviewTest, v1, v1NoAuthor),
    sameEra: evalPool("SAME-ERA (pos vs topical-prune negs) — keyword-curated, supplementary", sameEraTest, v1, v1NoAuthor),
    full: evalPool("FULL (pos vs all negs) — era-confounded, supplementary", test, v1, v1NoAuthor),
  };
}

function formatPool(p: PoolResult): string {
  const head = `${"model".padEnd(28)} ${"NDCG@10".padStart(8)} ${"NDCG@50".padStart(8)} ${"MAP".padStart(8)}`;
  const body = p.rows.map(r =>
    `${r.name.padEnd(28)} ${r.ndcg10.toFixed(4).padStart(8)} ${r.ndcg50.toFixed(4).padStart(8)} ${r.map.toFixed(4).padStart(8)}`,
  );
  return [`▼ ${p.pool}  (balanced test n=${p.n})`, head, ...body].join("\n");
}

// n below which the review gate is too thin to trust either way — sign more before believing it.
const REVIEW_MIN_N = 40;

export function formatEval(res: EvalResult): string {
  const r = res.reviewOnly;
  const gate = r.n < REVIEW_MIN_N
    ? `⏳ INCONCLUSIVE — only ${r.n} hand-signed test labels (need ~${REVIEW_MIN_N}+). Sign more 👍/👎 in the ` +
      `reading client, then re-run. The keyword gate below is near-circular, so this is the one that counts.`
    : r.ships
      ? `SHIP ✅  v1 beats keyword on the NON-CIRCULAR review gate (NDCG@10 AND MAP) at n=${r.n}.`
      : `HOLD ⛔  v1 does NOT beat keyword on the review gate at n=${r.n} — do not ship v1.`;
  return [
    formatPool(res.reviewOnly), "",
    formatPool(res.sameEra), "",
    formatPool(res.full), "",
    gate,
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(process.env.AFY_DB ?? "afy.db");
  console.log(formatEval(runEval(buildLabels(db))));
}
