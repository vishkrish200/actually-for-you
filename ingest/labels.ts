// M5 — Label pipeline. Re-derives a labeled training set from raw, append-only data.
// Nothing here mutates events; re-run any time labeling logic changes (PRD §7.1/§7.2).
//
// THE DATA REALITY (drives the whole design): the dense, clean signal is TEXT, not behavior.
// The ~1,883 calibrated positives are harvested likes/bookmarks; only ~112 ever got an
// impression row. So v1 is a CONTENT relevance model — P(I'd-engage | text+author) — not a
// behavioral dwell model (that one would train on 112 examples and starve). The v0 behavioral
// re-ranker in ranker.ts is a different surface (re-rank what you saw); this powers the digest.
import type { DatabaseSync } from "node:sqlite";
import { hashStr } from "./ranker_v1.ts";

export interface LabeledRow {
  tweet_id: string;
  label: 0 | 1;
  // pos | hard_neg (topical prune, SAME era as positives) | easy_neg (timeline, LATER era)
  //   | review_pos / review_neg (hand-signed 👍/👎 in the reading client — the NON-CIRCULAR labels).
  // The eval needs this: harvested likes (pos+hard_neg) span 2024–2026; timeline easy_negs are
  // all recent. Mixing them lets a model win by detecting era, not relevance — so the ship gate
  // runs on the same-era pool (pos vs hard_neg) only. The review_* kinds are cleaner still: their
  // sign is a human verdict, not the keyword lexicon, so they get their own gate. See eval.ts.
  kind: "pos" | "hard_neg" | "easy_neg" | "review_pos" | "review_neg";
  weight: number;        // IPW hook — uniform 1 for now (see note below)
  text: string;
  author_id: string;
  created_at: string;
  // confounder CONTROLS — never reward features (PRD invariant). char_len is real in the data:
  // positives avg 156 chars vs negatives 123, so length must be regressed out, not rewarded.
  char_len: number;
  media_present: 0 | 1;
  is_thread: 0 | 1;
}

// Easy negatives are sampled to keep class balance sane. NEG_RATIO = total negatives / positives.
// Hard negatives (topical prunes) are always all kept; easy negs (net timeline never-liked) fill
// the rest. ponytail: 2.5:1 is a heuristic — bump if eval shows the model can't separate classes.
const NEG_RATIO = 2.5;

// Small AI/tech lexicon for the lexical baseline in eval.ts. Deliberately NOT used as a label
// source — labels come from observed engagement only. This is the bar v1 must beat.
export const AI_LEXICON = [
  "ai", "llm", "llms", "gpt", "agent", "agents", "model", "models", "neural", "ml",
  "claude", "openai", "anthropic", "gemini", "transformer", "inference", "training",
  "prompt", "prompting", "fine-tune", "finetune", "rag", "embedding", "embeddings",
  "diffusion", "gpu", "cuda", "pytorch", "tensor", "benchmark", "reasoning", "rl",
  "dataset", "tokens", "context", "multimodal", "deepmind", "agi", "robotics",
];

export function buildLabels(db: DatabaseSync): LabeledRow[] {
  const row = (label: 0 | 1, kind: LabeledRow["kind"]) => (r: any): LabeledRow => ({
    tweet_id: r.tweet_id,
    label,
    kind,
    weight: 1, // ponytail: IPW deferred — explicit labels are position-robust AND these harvested
               // positives carry no position_in_feed. Swap this for a propensity weight when
               // behavioral labels densify; the rest of the pipeline already threads `weight`.
    text: r.text,
    author_id: r.author_id ?? "",
    created_at: r.created_at ?? "",
    char_len: (r.text as string).length,
    media_present: r.media && r.media !== "" && r.media !== "[]" ? 1 : 0,
    is_thread: r.is_thread ? 1 : 0,
  });

  // POSITIVES: engagement_labels − label_prunes, with text. (age prunes are dropped here too.)
  const positives = (db.prepare(`
    SELECT t.tweet_id, t.text, t.author_id, t.created_at, t.media, t.is_thread
    FROM engagement_labels e JOIN tweets t ON e.tweet_id = t.tweet_id
    WHERE e.tweet_id NOT IN (SELECT tweet_id FROM label_prunes)
      AND t.text IS NOT NULL AND t.text != ''
    GROUP BY t.tweet_id
  `).all() as any[]).map(row(1, "pos"));

  // HARD NEGATIVES: topical prunes — "I engaged but it's off-calibration for the AI digest".
  // age prunes are EXCLUDED (topically-AI but old → neither clean positive nor negative).
  const hardNegs = (db.prepare(`
    SELECT t.tweet_id, t.text, t.author_id, t.created_at, t.media, t.is_thread
    FROM label_prunes p JOIN tweets t ON p.tweet_id = t.tweet_id
    WHERE p.reason IN ('crypto','noise','non-ai-topic')
      AND t.text IS NOT NULL AND t.text != ''
    GROUP BY t.tweet_id
  `).all() as any[]).map(row(0, "hard_neg"));

  // EASY NEGATIVES: net-sourced timeline tweets never engaged. Deterministically sampled by a
  // hash of tweet_id (reproducible, no Math.random) to the count that hits NEG_RATIO.
  const easyPool = (db.prepare(`
    SELECT t.tweet_id, t.text, t.author_id, t.created_at, t.media, t.is_thread
    FROM tweets t
    WHERE t.source = 'net' AND t.text IS NOT NULL AND t.text != ''
      AND t.tweet_id NOT IN (SELECT tweet_id FROM engagement_labels)
  `).all() as any[]).map(row(0, "easy_neg"));

  const easyTarget = Math.max(0, Math.round(NEG_RATIO * positives.length) - hardNegs.length);
  easyPool.sort((a, b) => hashStr(a.tweet_id) - hashStr(b.tweet_id));
  const dropped = Math.max(0, easyPool.length - easyTarget);
  const easyNegs = easyPool.slice(0, easyTarget);

  // REVIEW LABELS: hand-signed 👍/👎 from the reading client's review loop (reviews table). Latest
  // verdict per tweet wins (a changed mind is a new row). These are the NON-CIRCULAR gold labels —
  // their sign is a human call, not the AI lexicon that curated the harvested-like boundary, so a
  // model beating a review_pos-vs-review_neg gate genuinely wins (unlike the near-circular keyword
  // gate). An explicit verdict OVERRIDES the harvested sources below (it's the stronger signal).
  const reviewed = db.prepare(`
    SELECT t.tweet_id, t.text, t.author_id, t.created_at, t.media, t.is_thread, r.verdict
    FROM reviews r
    JOIN (SELECT tweet_id, MAX(ts) mts FROM reviews GROUP BY tweet_id) l
      ON r.tweet_id = l.tweet_id AND r.ts = l.mts
    JOIN tweets t ON r.tweet_id = t.tweet_id
    WHERE t.text IS NOT NULL AND t.text != ''
    GROUP BY t.tweet_id
  `).all() as any[];
  const reviewPos = reviewed.filter(r => r.verdict === 1).map(row(1, "review_pos"));
  const reviewNeg = reviewed.filter(r => r.verdict !== 1).map(row(0, "review_neg"));
  const reviewedIds = new Set(reviewed.map(r => r.tweet_id));
  const notReviewed = (r: LabeledRow) => !reviewedIds.has(r.tweet_id);

  // ponytail: tried upweighting hard-negs (easy-negs outnumber them ~8:1) to un-drown the topical
  // boundary — neutral on the same-era gate (+0.001 MAP), HURT full-pool generalization
  // (NDCG@10 0.82→0.53). Left uniform: the gate's weakness is data (too few same-era negs, ~135)
  // and keyword/label circularity, not training mass. Re-add via `weight` if hard-negs densify.
  if (dropped > 0) {
    console.error(`[labels] sampled ${easyNegs.length}/${easyPool.length} easy negatives ` +
      `(dropped ${dropped} to hit ${NEG_RATIO}:1 balance)`); // no silent cap
  }

  return [
    ...positives.filter(notReviewed), ...hardNegs.filter(notReviewed), ...easyNegs.filter(notReviewed),
    ...reviewPos, ...reviewNeg,
  ];
}

// Distribution-sanity report — the PRD §7.2 / §9 label gate. Confirms the classes are
// distinguishable and the length confounder is visible (so we know to control for it).
export function labelReport(rows: LabeledRow[]): string {
  const pos = rows.filter(r => r.label === 1);
  const neg = rows.filter(r => r.label === 0);
  const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  const lines = [
    `positives:        ${pos.length}`,
    `negatives:        ${neg.length}  (balance ${(neg.length / Math.max(1, pos.length)).toFixed(2)}:1)`,
    `char_len  pos/neg: ${mean(pos.map(r => r.char_len)).toFixed(1)} / ${mean(neg.map(r => r.char_len)).toFixed(1)}  ← confounder; controlled, never rewarded`,
    `media%    pos/neg: ${(100 * mean(pos.map(r => r.media_present))).toFixed(0)}% / ${(100 * mean(neg.map(r => r.media_present))).toFixed(0)}%`,
    `thread%   pos/neg: ${(100 * mean(pos.map(r => r.is_thread))).toFixed(0)}% / ${(100 * mean(neg.map(r => r.is_thread))).toFixed(0)}%`,
  ];
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(process.env.AFY_DB ?? "afy.db");
  console.log(labelReport(buildLabels(db)));
}
