// M14 experiment — review-lr dump. Prints the ONE JSON object ({cutoff, rows}) review_lr.py
// trains/scores on: rows carries every
// hand-reviewed tweet (latest verdict, from buildLabels' review_pos/review_neg kinds) carrying the
// SAME features the M9 mix uses (rubric score, taste cosine, author prior) plus the confounder
// controls (char_len/media_present/is_thread — train-only, per CLAUDE.md). TS owns feature
// semantics here so the python never re-implements TF-IDF / the rubric join / the author prior —
// it only trains a classifier on numbers this script already computed the same way digest.ts does.
//
// Read-only: reuses buildLabels (labels.ts), loadRubricScores (rubric.ts), buildTaste/scoreText/
// buildAuthorPrior (digest.ts) verbatim — no SQL duplicated here.
//
// The output carries eval.ts's GATE_CUTOFF alongside the rows ({cutoff, rows}) so review_lr.py
// never hardcodes its own copy of the boundary — a re-freeze that moves eval.ts's cutoff moves
// the python's train set with it, by construction.
// M14 online arm: also emits a `candidates` array (predict-only, no y) — the digest's own
// candidate pool via digest.candidateRows, so review_lr.py can score exactly what the digest
// ranks. `--days N` (default 7) windows it: a superset of the serve windows (teaser uses 2).
import { DatabaseSync } from "node:sqlite";
import { buildLabels } from "./labels.ts";
import { loadRubricScores } from "./rubric.ts";
import { buildTaste, buildAuthorPrior, scoreText, candidateRows } from "./digest.ts";
import { GATE_CUTOFF } from "./eval.ts";

interface DumpRow {
  tweet_id: string;
  text: string;
  y: 0 | 1;                 // 1 = 👍, 0 = 👎
  review_ts: string | null;
  char_len: number;
  media_present: 0 | 1;
  is_thread: 0 | 1;
  rubric: number | null;
  taste: number;
  prior: number;
}

const db = new DatabaseSync(process.env.AFY_DB ?? "afy.db");

const rows = buildLabels(db).filter(r => r.kind === "review_pos" || r.kind === "review_neg");
const rubric = loadRubricScores(db);
const taste = buildTaste(db);
const prior = buildAuthorPrior(db);

const out: DumpRow[] = rows.map(r => ({
  tweet_id: r.tweet_id,
  text: r.text,
  y: r.kind === "review_pos" ? 1 : 0,
  review_ts: r.review_ts ?? null,
  char_len: r.char_len,
  media_present: r.media_present,
  is_thread: r.is_thread,
  rubric: rubric.scores.get(r.tweet_id) ?? null,
  taste: scoreText(r.text, taste),
  prior: prior.get(r.author_id) ?? 0,
}));

// Predict-only candidates: the digest's own pool (candidateRows excludes reviewed tweets, so this
// is disjoint from `rows` — review_lr_scores' PRIMARY KEY stays safe). Same feature columns, no y.
const daysFlag = process.argv.indexOf("--days");
const days = daysFlag >= 0 ? Math.max(0, parseInt(process.argv[daysFlag + 1] ?? "7", 10) || 0) : 7;
type CandidateRow = Omit<DumpRow, "y" | "review_ts">;
const candidates: CandidateRow[] = candidateRows(db, days, Date.now(), prior).map((r: any) => ({
  tweet_id: r.tweet_id,
  text: r.text,
  char_len: (r.text as string).length,
  media_present: (r.media && r.media !== "" && r.media !== "[]" ? 1 : 0) as 0 | 1,
  // ponytail: candidateRows doesn't select is_thread and the value is never read at predict (the
  // controls' coefficients are dropped) — 0 is fine until someone trains on candidates (never).
  is_thread: 0,
  rubric: rubric.scores.get(r.tweet_id) ?? null,
  taste: scoreText(r.text, taste),
  prior: prior.get(r.author_id ?? "") ?? 0,
}));

console.log(JSON.stringify({ cutoff: GATE_CUTOFF, rows: out, candidates }));
