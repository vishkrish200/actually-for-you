// M6 experiment — does a SEMANTIC embedding featurization beat the bigram-hash LR (ranker_v1)?
// Hypothesis (user's): bigram bag-of-words is too naive — it needs literal word overlap, so it
// can't tell "this is about AI" when the exact tokens differ. Swap the featurizer for a pretrained
// text embedding (local via ollama, no API key, no per-call cost) and re-run the SAME review gate.
//
// This file DOES NOT touch the shipped gate (eval.ts) or the shipped model (ranker_v1.ts). It's an
// A/B: keyword vs bigram-LR vs embedding-LR vs embedding-cosine on the NON-CIRCULAR review pool.
// Only if embeddings win here do we promote it into eval.ts. Embeddings are cached in sqlite so
// re-runs are instant.
import type { DatabaseSync } from "node:sqlite";
import type { LabeledRow } from "./labels.ts";
import { buildLabels } from "./labels.ts";
import { hashStr, train as trainBigram, predict as predictBigram } from "./ranker_v1.ts";
import { splitByTime, ndcgAt, averagePrecision } from "./eval.ts";

const OLLAMA = process.env.AFY_OLLAMA_URL ?? "http://localhost:11434";
const EMB_MODEL = process.env.AFY_EMB_MODEL ?? "nomic-embed-text";

// ---- embedding with a sqlite cache (compute once per tweet, keyed by model) ----
function ensureCache(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS emb_cache (
    tweet_id TEXT NOT NULL, model TEXT NOT NULL, vec BLOB NOT NULL,
    PRIMARY KEY (tweet_id, model))`);
}
const toBlob = (v: number[]) => Buffer.from(new Float32Array(v).buffer);
const fromBlob = (b: Buffer) => Array.from(new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4));

async function ollamaEmbed(texts: string[]): Promise<number[][]> {
  const res = await fetch(`${OLLAMA}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: EMB_MODEL, input: texts }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
  return (await res.json()).embeddings;
}

// Embed every row, hitting the cache first. Returns tweet_id -> unit-normalized vector.
export async function embedAll(db: DatabaseSync, rows: LabeledRow[]): Promise<Map<string, number[]>> {
  ensureCache(db);
  const out = new Map<string, number[]>();
  const get = db.prepare("SELECT vec FROM emb_cache WHERE tweet_id = ? AND model = ?");
  const put = db.prepare("INSERT OR REPLACE INTO emb_cache (tweet_id, model, vec) VALUES (?,?,?)");
  const miss: LabeledRow[] = [];
  for (const r of rows) {
    const hit = get.get(r.tweet_id, EMB_MODEL) as { vec: Buffer } | undefined;
    if (hit) out.set(r.tweet_id, fromBlob(hit.vec));
    else miss.push(r);
  }
  if (miss.length) {
    console.error(`[emb] ${out.size} cached, embedding ${miss.length} misses via ${EMB_MODEL}…`);
    const BATCH = 64;
    for (let i = 0; i < miss.length; i += BATCH) {
      const chunk = miss.slice(i, i + BATCH);
      const vecs = await ollamaEmbed(chunk.map(r => r.text));
      chunk.forEach((r, j) => {
        const v = unit(vecs[j]);
        out.set(r.tweet_id, v);
        put.run(r.tweet_id, EMB_MODEL, toBlob(v));
      });
      if (i % 512 === 0 && i) console.error(`[emb]   …${i}/${miss.length}`);
    }
  }
  return out;
}

function unit(v: number[]): number[] {
  let n = 0; for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map(x => x / n);
}

// ---- dense logistic regression over the embedding + the 3 confounder controls ----
// Same PRD §7.2 invariant as ranker_v1: controls are regressed in during training then DROPPED at
// predict, so length/media can't earn score. Dense SGD; hyperparams differ from the sparse bigram
// LR because features here are continuous ~unit-norm, not binary presence.
export interface EmbModel { w: number[]; b: number; dim: number; }
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

function feats(v: number[], row: LabeledRow, withControls: boolean): number[] {
  if (!withControls) return v;
  return [...v, Math.min(row.char_len, 280) / 280, row.media_present, row.is_thread];
}

export function trainEmb(
  rows: LabeledRow[], emb: Map<string, number[]>,
  { epochs = 150, lr = 1.0, l2 = 1e-3 } = {},
): EmbModel {
  const dim = emb.get(rows[0].tweet_id)!.length;
  const w = new Array(dim + 3).fill(0);
  let b = 0;
  const X = rows.map(r => feats(emb.get(r.tweet_id)!, r, true));
  for (let e = 0; e < epochs; e++) {
    for (let n = 0; n < rows.length; n++) {
      const x = X[n];
      let z = b; for (let i = 0; i < x.length; i++) z += w[i] * x[i];
      const err = (sigmoid(z) - rows[n].label) * rows[n].weight;
      for (let i = 0; i < x.length; i++) w[i] -= lr * (err * x[i] + l2 * w[i]);
      b -= lr * err;
    }
  }
  return { w, b, dim };
}

export function predictEmb(m: EmbModel, row: LabeledRow, emb: Map<string, number[]>): number {
  const v = emb.get(row.tweet_id);
  if (!v) return 0;
  let z = m.b; for (let i = 0; i < v.length; i++) z += m.w[i] * v[i]; // controls dropped at serve
  return sigmoid(z);
}

// Cosine-to-positive-centroid: no learning, the "semantic similarity to what I liked" baseline.
// This is conceptually the shipped digest (cosine) but over neural embeddings instead of TF-IDF.
export function centroidScorer(train: LabeledRow[], emb: Map<string, number[]>): (r: LabeledRow) => number {
  const pos = train.filter(r => r.label === 1).map(r => emb.get(r.tweet_id)!);
  const c = unit(pos.reduce((a, v) => a.map((x, i) => x + v[i]), new Array(pos[0].length).fill(0)));
  return (r) => { const v = emb.get(r.tweet_id); if (!v) return 0; let d = 0; for (let i = 0; i < v.length; i++) d += v[i] * c[i]; return d; };
}

// ---- A/B on the review gate (mirrors eval.ts's review-pool selection + balancing) ----
function rankedRels(test: LabeledRow[], score: (r: LabeledRow) => number): number[] {
  return [...test].map(r => ({ l: r.label, s: score(r), id: r.tweet_id }))
    .sort((a, b) => b.s - a.s || (a.id < b.id ? -1 : 1)).map(x => x.l);
}
function balance(test: LabeledRow[]): LabeledRow[] {
  const pos = test.filter(r => r.label === 1), neg = test.filter(r => r.label === 0);
  const [maj, min] = pos.length >= neg.length ? [pos, neg] : [neg, pos];
  const keptMaj = [...maj].sort((a, b) => hashStr(a.tweet_id) - hashStr(b.tweet_id)).slice(0, min.length);
  return [...keptMaj, ...min];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(process.env.AFY_DB ?? "afy.db");
  const rows = buildLabels(db);
  const emb = await embedAll(db, rows);

  const { train: tr, test } = splitByTime(rows);
  const bigram = trainBigram(tr, { useAuthor: true });
  const embModel = trainEmb(tr, emb);
  const centroid = centroidScorer(tr, emb);

  const reviewTest = balance(test.filter(r => r.kind === "review_pos" || r.kind === "review_neg"));
  const scorers: [string, (r: LabeledRow) => number][] = [
    ["keyword (bar)", (r) => { const t = r.text.toLowerCase(); return ["ai","llm","gpt","agent","model","claude","openai"].reduce((n, k) => n + (t.includes(k) ? 1 : 0), 0); }],
    ["bigram LR (v1)", (r) => predictBigram(bigram, r)],
    ["emb cosine centroid", centroid],
    ["emb LR", (r) => predictEmb(embModel, r, emb)],
  ];
  console.log(`\n▼ REVIEW GATE A/B — embedding vs bigram (balanced n=${reviewTest.length})`);
  console.log(`${"model".padEnd(22)} ${"NDCG@10".padStart(8)} ${"MAP".padStart(8)}`);
  for (const [name, s] of scorers) {
    const rels = rankedRels(reviewTest, s);
    console.log(`${name.padEnd(22)} ${ndcgAt(rels, 10).toFixed(4).padStart(8)} ${averagePrecision(rels).toFixed(4).padStart(8)}`);
  }

  // ---- paired bootstrap: resample the n rows with replacement B times, recompute MAP for each
  // scorer on the SAME resample. Report each MAP's 95% CI, and the CI of (emb LR − keyword). If
  // that difference CI straddles 0, they're statistically tied at this n. Seeded → reproducible.
  const B = 2000;
  let seed = 0x243f6a88; // deterministic (no Math.random — repo convention)
  const rand = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor(p * (xs.length - 1))];
  const ci = (xs: number[]) => `${pct(xs, 0.5).toFixed(3)} [${pct(xs, 0.025).toFixed(3)}, ${pct(xs, 0.975).toFixed(3)}]`;

  const relsBy = scorers.map(([, s]) => reviewTest.map(r => ({ l: r.label, sc: s(r), id: r.tweet_id })));
  const boot: number[][] = scorers.map(() => []);
  const diff: number[] = []; // emb LR − keyword, per resample
  const kwI = scorers.findIndex(([n]) => n.startsWith("keyword"));
  const embI = scorers.findIndex(([n]) => n === "emb LR");
  for (let bIt = 0; bIt < B; bIt++) {
    const pick = Array.from({ length: reviewTest.length }, () => Math.floor(rand() * reviewTest.length));
    const maps = relsBy.map(rows => {
      const rels = pick.map(i => rows[i]).sort((a, b) => b.sc - a.sc || (a.id < b.id ? -1 : 1)).map(x => x.l);
      return averagePrecision(rels);
    });
    maps.forEach((m, i) => boot[i].push(m));
    diff.push(maps[embI] - maps[kwI]);
  }
  console.log(`\n▼ BOOTSTRAP 95% CI on MAP (B=${B}, n=${reviewTest.length})`);
  scorers.forEach(([name], i) => console.log(`${name.padEnd(22)} ${ci(boot[i])}`));
  const straddles = pct(diff, 0.025) < 0 && pct(diff, 0.975) > 0;
  console.log(`\nemb LR − keyword (MAP):  ${ci(diff)}`);
  console.log(straddles
    ? `→ CI straddles 0 → STATISTICALLY TIED at n=${reviewTest.length}. Can't call keyword the winner; sign more labels to resolve.`
    : pct(diff, 0.5) < 0
      ? `→ CI below 0 → keyword genuinely beats emb LR at n=${reviewTest.length}.`
      : `→ CI above 0 → emb LR genuinely beats keyword at n=${reviewTest.length}.`);
}
