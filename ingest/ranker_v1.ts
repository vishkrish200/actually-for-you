// M6 — Ranker v1: a learned CONTENT relevance model. Logistic regression over hashed
// bag-of-words + author, with char_len/media/thread as controls (regressed in so the model
// can't use length as a topic proxy — PRD §7.2 invariant). Pure TS, no deps, no Python:
// 2k examples train in milliseconds. Skipped GBT — add only if LR loses the ship gate AND
// there's evidence nonlinearity helps. The eval (eval.ts) decides whether this ships at all.
import type { LabeledRow } from "./labels.ts";

const HASH_DIM = 1 << 14;            // 16384 token/author buckets
const N_CONTROL = 3;                 // char_len_norm, media_present, is_thread
const DIM = HASH_DIM + N_CONTROL;
const CTRL_BASE = HASH_DIM;          // controls live in the last N_CONTROL slots

export interface Model {
  w: number[];
  b: number;
  useAuthor: boolean;
}

// Deterministic non-negative string hash (FNV-1a). Shared with labels.ts for reproducible sampling.
export function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function tokens(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9#@]+/).filter(t => t.length > 1 && t.length < 30);
}

// Sparse feature vector: list of [index, value]. Token/author features are binary presence
// (set-of-tokens, not counts — robust on short text).
//
// CONTROLS are the PRD §7.2 invariant in action: char_len/media/thread are included while
// TRAINING (includeControls=true) so they absorb confounding — token weights are then estimated
// holding length/media constant, instead of a long-tweet bias leaking into the topic weights.
// At PREDICT time they are DROPPED (includeControls=false): a confounder controlled for must
// never earn score, so length can't promote a candidate. Standard "regress out, then drop".
export function featurize(row: LabeledRow, useAuthor: boolean, includeControls = true): [number, number][] {
  const idx = new Map<number, number>();
  const toks = tokens(row.text);
  for (const t of toks) idx.set(hashStr("t:" + t) % HASH_DIM, 1);
  // bigrams: phrases like "ai agent" / "language model" carry topical signal a unigram BoW misses.
  for (let i = 1; i < toks.length; i++) idx.set(hashStr("b:" + toks[i - 1] + " " + toks[i]) % HASH_DIM, 1);
  if (useAuthor && row.author_id) idx.set(hashStr("a:" + row.author_id) % HASH_DIM, 1);
  const feats: [number, number][] = [...idx.entries()];
  if (includeControls) {
    feats.push([CTRL_BASE + 0, Math.min(row.char_len, 280) / 280]);
    feats.push([CTRL_BASE + 1, row.media_present]);
    feats.push([CTRL_BASE + 2, row.is_thread]);
  }
  return feats;
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

function dot(w: number[], feats: [number, number][], b: number): number {
  let z = b;
  for (const [i, v] of feats) z += w[i] * v;
  return z;
}

export function predict(model: Model, row: LabeledRow): number {
  // includeControls=false: confounders absorbed during training never earn score at serve time.
  return sigmoid(dot(model.w, featurize(row, model.useAuthor, false), model.b));
}

// SGD logistic regression with L2. Deterministic example order (no shuffle → reproducible eval).
export function train(
  rows: LabeledRow[],
  { useAuthor = true, epochs = 40, lr = 0.5, l2 = 1e-5 } = {},
): Model {
  const w = new Array(DIM).fill(0);
  let b = 0;
  const cache = rows.map(r => featurize(r, useAuthor));
  for (let e = 0; e < epochs; e++) {
    for (let n = 0; n < rows.length; n++) {
      const feats = cache[n];
      const err = (sigmoid(dot(w, feats, b)) - rows[n].label) * rows[n].weight;
      for (const [i, v] of feats) w[i] -= lr * (err * v + l2 * w[i]);
      b -= lr * err;
    }
  }
  return { w, b, useAuthor };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { DatabaseSync } = await import("node:sqlite");
  const { writeFileSync } = await import("node:fs");
  const { buildLabels } = await import("./labels.ts");
  const db = new DatabaseSync(process.env.AFY_DB ?? "afy.db");
  const model = train(buildLabels(db));
  writeFileSync("model.json", JSON.stringify(model)); // derived, gitignored
  console.log(`trained on full label set → model.json (dim ${DIM})`);
}
