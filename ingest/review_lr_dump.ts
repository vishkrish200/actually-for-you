// M14 experiment — review-lr dump. Prints the ONE JSON array review_lr.py trains/scores on: every
// hand-reviewed tweet (latest verdict, from buildLabels' review_pos/review_neg kinds) carrying the
// SAME features the M9 mix uses (rubric score, taste cosine, author prior) plus the confounder
// controls (char_len/media_present/is_thread — train-only, per CLAUDE.md). TS owns feature
// semantics here so the python never re-implements TF-IDF / the rubric join / the author prior —
// it only trains a classifier on numbers this script already computed the same way digest.ts does.
//
// Read-only: reuses buildLabels (labels.ts), loadRubricScores (rubric.ts), buildTaste/scoreText/
// buildAuthorPrior (digest.ts) verbatim — no SQL duplicated here.
import { DatabaseSync } from "node:sqlite";
import { buildLabels } from "./labels.ts";
import { loadRubricScores } from "./rubric.ts";
import { buildTaste, buildAuthorPrior, scoreText } from "./digest.ts";

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

console.log(JSON.stringify(out));
