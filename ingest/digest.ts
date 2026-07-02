// Personalized AI digest — ranks tweets by similarity to what you've ALREADY liked. This is the
// shippable product: it uses your ~1,900 calibrated likes as a taste profile, needs no behavioral
// data and no training/ship-gate (it's similarity, not a trained classifier — so the "v1 must beat
// keyword" problem doesn't apply). TF-IDF cosine; cosine's length-normalization also neutralizes the
// char_len confounder for free (PRD §7.2 — length must not earn score).
import type { DatabaseSync } from "node:sqlite";
import { hashStr } from "./ranker_v1.ts";

export interface DigestItem {
  tweet_id: string;
  author_handle: string | null;
  author_name: string | null;
  text: string;
  created_at: string | null;
  likes: number | null;
  rts: number | null;
  replies: number | null;
  views: number | null;
  score: number;
  lane: "taste" | "explore";
}

// Tokenize: lowercase words, drop short tokens, URLs, and t.co noise. Hashtags/@handles kept (signal).
function tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .split(/[^a-z0-9#@]+/)
    .filter(t => t.length > 2 && t.length < 30 && t !== "the" && t !== "and");
}

type Vec = Map<string, number>;

function tfidf(text: string, idf: Map<string, number>): Vec {
  const tf = new Map<string, number>();
  for (const t of tokenize(text)) tf.set(t, (tf.get(t) ?? 0) + 1);
  const v: Vec = new Map();
  for (const [t, c] of tf) { const w = idf.get(t); if (w) v.set(t, c * w); }
  return v;
}

function unit(v: Vec): Vec {
  let n = 0; for (const w of v.values()) n += w * w;
  n = Math.sqrt(n);
  if (n === 0) return v;
  const u: Vec = new Map();
  for (const [t, w] of v) u.set(t, w / n);
  return u;
}

function dot(a: Vec, b: Vec): number {
  // iterate the smaller map
  const [s, l] = a.size < b.size ? [a, b] : [b, a];
  let d = 0;
  for (const [t, w] of s) { const x = l.get(t); if (x) d += w * x; }
  return d;
}

export interface TasteModel { idf: Map<string, number>; profile: Vec; }

// Build the taste profile: IDF over the whole corpus, profile = centroid of UNIT-normalized
// liked-tweet vectors (unit-first so a long like doesn't dominate a short one).
export function buildTaste(db: DatabaseSync): TasteModel {
  const corpus = (db.prepare(
    `SELECT text FROM tweets WHERE text IS NOT NULL AND text != ''`,
  ).all() as { text: string }[]).map(r => r.text);

  const df = new Map<string, number>();
  for (const text of corpus) {
    for (const t of new Set(tokenize(text))) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const N = corpus.length;
  const idf = new Map<string, number>();
  for (const [t, d] of df) idf.set(t, Math.log(N / (1 + d)));

  const likes = (db.prepare(`
    SELECT t.text FROM engagement_labels e JOIN tweets t ON e.tweet_id = t.tweet_id
    WHERE e.tweet_id NOT IN (SELECT tweet_id FROM label_prunes)
      AND t.text IS NOT NULL AND t.text != ''
  `).all() as { text: string }[]).map(r => r.text);

  const profile: Vec = new Map();
  for (const text of likes) {
    for (const [t, w] of unit(tfidf(text, idf))) profile.set(t, (profile.get(t) ?? 0) + w);
  }
  for (const [t, w] of profile) profile.set(t, w / Math.max(1, likes.length));
  return { idf, profile };
}

export function scoreText(text: string, m: TasteModel): number {
  return dot(unit(tfidf(text, m.idf)), m.profile);
}

// Light MMR so the digest isn't ten near-identical takes. Token-overlap penalty, relevance-heavy.
function diversify(items: DigestItem[], lambda = 0.75, limit = 50): DigestItem[] {
  const toks = items.map(i => new Set(tokenize(i.text)));
  const picked: DigestItem[] = [];
  const pickedTok: Set<string>[] = [];
  const used = new Set<number>();
  while (picked.length < limit && used.size < items.length) {
    let best = -1, bestVal = -Infinity;
    for (let i = 0; i < items.length; i++) {
      if (used.has(i)) continue;
      const sim = pickedTok.length === 0 ? 0 : Math.max(...pickedTok.map(p => {
        let inter = 0; for (const t of toks[i]) if (p.has(t)) inter++;
        const uni = toks[i].size + p.size - inter; return uni ? inter / uni : 0;
      }));
      const val = lambda * items[i].score - (1 - lambda) * sim;
      if (val > bestVal) { bestVal = val; best = i; }
    }
    used.add(best); picked.push(items[best]); pickedTok.push(toks[best]);
  }
  return picked;
}

// The digest: un-liked tweets (optionally recent), ranked by taste similarity, diversified,
// plus an explore slice the taste model did NOT choose (CLAUDE.md invariant: every ranker
// version carries an explore lane — anti-filter-bubble AND the only low-bias signal source,
// since a profile can never learn about what it never shows).
export function buildDigest(
  db: DatabaseSync,
  { limit = 50, days = 0, seed = new Date().toISOString().slice(0, 10) } = {},
): DigestItem[] {
  const m = buildTaste(db);
  const recency = days > 0 ? `AND datetime(captured_at) > datetime('now','-${days} days')` : "";
  const rows = db.prepare(`
    SELECT tweet_id, author_handle, author_name, text, created_at, likes, rts, replies, views FROM tweets
    WHERE text IS NOT NULL AND text != ''
      AND tweet_id NOT IN (SELECT tweet_id FROM engagement_labels)
      ${recency}
  `).all() as Omit<DigestItem, "score" | "lane">[];

  // fragment filter applies to every lane — link-only / one-word replies aren't worth a slot
  const candidates = rows
    .map(r => ({ ...r, score: scoreText(r.text, m), lane: "taste" as const }))
    .filter(r => tokenize(r.text).length >= 4);

  const exploreN = Math.max(1, Math.round(limit / 10));
  const scored = candidates
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(limit * 4, 200)); // diversify within a generous head
  const picked: DigestItem[] = diversify(scored, 0.75, Math.max(1, limit - exploreN));

  // Explore lane: sampled from candidates the taste head did NOT pick (zero-score included) by a
  // day-seeded hash — stable within a day, rotates daily, no Math.random. Interleaved, not
  // appended, so the tail-off-a-list problem can't quietly starve it of reads.
  const inFeed = new Set(picked.map(p => p.tweet_id));
  const explore = candidates
    .filter(r => !inFeed.has(r.tweet_id))
    .sort((a, b) => hashStr(seed + a.tweet_id) - hashStr(seed + b.tweet_id))
    .slice(0, exploreN)
    .map(r => ({ ...r, lane: "explore" as const }));
  const step = Math.max(1, Math.floor(picked.length / (explore.length + 1)));
  explore.forEach((e, i) => picked.splice(Math.min((i + 1) * step + i, picked.length), 0, e));
  return picked;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(process.env.AFY_DB ?? "afy.db");
  const items = buildDigest(db, { limit: 20 });
  console.log(`\nTop ${items.length} for you (taste-ranked):\n`);
  for (const it of items) {
    const who = it.author_handle ? `@${it.author_handle}` : "(unknown)";
    console.log(`${it.score.toFixed(3)} ${it.lane === "explore" ? "✧" : " "} ${who.padEnd(18)} ${it.text.replace(/\s+/g, " ").slice(0, 90)}`);
  }
}
