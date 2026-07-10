// Personalized AI digest — ranks tweets by a weighted mix of interpretable signals (M9): TF-IDF
// cosine to what you've ALREADY liked, the LLM rubric score (M8), and a per-author like-count
// prior. Still the shippable ungated product: hand-set named weights over features, not a trained
// classifier — so the "v1 must beat keyword" ship gate doesn't apply (gate discipline lives in
// eval.ts, which prints a `mix` arm honestly). Cosine's length-normalization also neutralizes the
// char_len confounder for free (PRD §7.2 — length must not earn score).
import type { DatabaseSync } from "node:sqlite";
import { hashStr } from "./ranker_v1.ts";
import { loadRubricScores } from "./rubric.ts";
import { AI_LEXICON } from "./labels.ts";

export interface QuotedTweet {
  tweet_id: string;
  author_handle: string | null;
  author_name: string | null;
  text: string;
  media: { type: string; url: string }[];
  created_at: string | null;
}

export interface DigestItem {
  tweet_id: string;
  author_handle: string | null;
  author_name: string | null;
  text: string;
  media: { type: string; url: string }[];
  // quoted context, resolved from quoted_id: the full quoted tweet when we captured it, the bare
  // marker { tweet_id } when we know it's a quote but never saw the original (render "open on X"),
  // or null for a plain tweet. Pre-quoted_id rows can't distinguish quote-tweets at all — null.
  quoted: QuotedTweet | { tweet_id: string } | null;
  created_at: string | null;
  likes: number | null;
  rts: number | null;
  replies: number | null;
  views: number | null;
  score: number;
  // M9: the weighted z-contributions that sum to `score` — the client tooltip's breakdown.
  parts: MixParts;
  lane: "taste" | "explore";
  // M11: which ranker drafted this taste-lane slot in a team-draft interleave (digest_log carries
  // it; the funnel/interleave report attributes opens+votes back to it). null when interleaving is
  // OFF (MATCHUP=null) OR for explore-lane rows (explore is arm-agnostic — the invariant survives).
  // BLIND: `arm` never reaches client.html — the ✦ badge renders off score/parts (computed pool-
  // wide, identical across arms), so a vote can't be biased by which team served the card.
  arm: Arm | null;
}

// ---- M9 weighted mix: final = W.taste·z(cosine) + W.rubric·z(rubric) + W.author·z(author_prior).
// Named knobs, hand-set — NEVER tuned against the small-n review gate (that's fitting noise).
export const MIX_WEIGHTS = { taste: 0.5, rubric: 0.3, author: 0.2 } as const;

export interface MixParts { taste: number; rubric: number; author: number }

// z-scores over the pool being ranked. null = value missing for that row (unscored rubric):
// stats are computed over PRESENT values only and missing rows get exactly 0 — pool-neutral,
// never a penalty (eval's −1 rank-last sentinel is display-only for the pure rubric arm; the mix
// contract is z=0). Zero variance (or an empty/singleton present set) → all 0.
//
// WINSORIZED at ±Z_CLAMP: a zero-inflated input (the author prior — most of the pool is 0) makes
// any nonzero row a ±5σ+ outlier under raw z, and that one component swamps the blend. M10's first
// live serve caught it: rank-1's score was 78% author part. The clamp bounds every component's
// contribution at W·Z_CLAMP, so no single knob can outvote the other two combined by outlier alone.
// Functional-form fix from serve-log evidence — NOT a re-weight against the review pool.
export const Z_CLAMP = 2;
export function zscores(xs: (number | null)[]): number[] {
  const present = xs.filter((x): x is number => x !== null);
  const mean = present.length ? present.reduce((a, b) => a + b, 0) / present.length : 0;
  const sd = present.length
    ? Math.sqrt(present.reduce((a, x) => a + (x - mean) ** 2, 0) / present.length) : 0;
  return xs.map(x => (x === null || sd === 0 ? 0 : Math.max(-Z_CLAMP, Math.min(Z_CLAMP, (x - mean) / sd))));
}

// THE mix formula — digest and eval's `mix` arm both call this, so they cannot diverge. Input is
// the whole pool (z is pool-relative); output is index-aligned weighted parts + their sum.
export function mixFinal(
  pool: { taste: number; rubric: number | null; author: number }[],
): { final: number; parts: MixParts }[] {
  const zt = zscores(pool.map(p => p.taste));
  const zr = zscores(pool.map(p => p.rubric));
  const za = zscores(pool.map(p => p.author));
  return pool.map((_, i) => {
    const parts = {
      taste: MIX_WEIGHTS.taste * zt[i],
      rubric: MIX_WEIGHTS.rubric * zr[i],
      author: MIX_WEIGHTS.author * za[i],
    };
    return { final: parts.taste + parts.rubric + parts.author, parts };
  });
}

// ---- M11 team-draft interleaving: an ONLINE ranker comparison on the live digest. Two arms each
// rank the SAME filtered candidate pool; a team-draft fills the non-explore slots (position bias
// cancelled by construction — each team's picks are spread across ranks symmetrically), and every
// served slot records which arm drafted it. Attribution flows through digest_log's `arm` column
// into `npm run interleave`, which judges by opens+👍. This COMPARES rankers — it never mints
// labels (votes stay the only gold; the keyword arm on the product surface is still never a label
// source), and the explore lane is untouched (arm=null, ~10%, day-seeded — the invariant holds).
export type Arm = "mix" | "keyword" | "taste";

// THE matchup, pinned by a named const (the plan's design point). null = plain M9 mix digest —
// today's behavior, EXACTLY (regression-tested byte-for-byte). First matchup: the offline champion
// (keyword) meets the live product ranker (mix) on the user's own feed. Change this const to swap
// matchups; buildDigest takes an override param so tests can pin either state without a global edit.
export const MATCHUP: readonly [Arm, Arm] | null = ["mix", "keyword"];

// An arm scorer orders a candidate that already carries its pool-wide mix score/parts. Higher =
// better for that arm. mix = the M9 blend (what the digest ships); keyword = AI_LEXICON hit count
// (the offline baseline, reusing labels.ts's lexicon — it is a RANKING signal here, never a label,
// same as eval.ts's lexiconScore); taste = the taste part alone (a positive-weighted monotonic
// transform of z(cosine), so ranking by parts.taste == ranking by the raw cosine — the pre-M9
// shipped ranker as an arm). Text is lowercased once per candidate for the keyword arm.
const ARM_SCORERS: Record<Arm, (c: { text: string; score: number; parts: MixParts }) => number> = {
  mix: (c) => c.score,
  keyword: (c) => { const t = c.text.toLowerCase(); return AI_LEXICON.reduce((n, kw) => n + (t.includes(kw) ? 1 : 0), 0); },
  taste: (c) => c.parts.taste,
};

// Order the pool by one arm, then diversify with the SAME MMR the mix digest uses (the plan:
// "diversify each arm's ranking with the existing MMR first, then draft"). We rank on the arm's
// score but hand `diversify` a shallow copy whose `.score` is the arm score, so its relevance term
// reflects THIS arm's ordering while the MMR token-overlap penalty is identical across arms. The
// returned items still carry the real mix score/parts (diversify never mutates them) — blind
// serving intact. Stable tiebreak on tweet_id (eval.ts convention) so equal-scoring rows — very
// common for the integer-valued keyword arm — order deterministically, not by input/JS-sort luck.
function armRanking(candidates: DigestItem[], arm: Arm, slots: number): DigestItem[] {
  const score = ARM_SCORERS[arm];
  const ranked = candidates
    .map(c => ({ c, s: score(c) }))
    .sort((a, b) => b.s - a.s || (a.c.tweet_id < b.c.tweet_id ? -1 : 1))
    .map(x => ({ ...x.c, score: x.s })); // arm score drives diversify's relevance; real score restored below
  const diversified = diversify(ranked, 0.75, slots);
  // Restore each row's true mix score/parts (armRanking only borrowed `.score` to order/diversify).
  const byId = new Map(candidates.map(c => [c.tweet_id, c]));
  return diversified.map(d => byId.get(d.tweet_id)!);
}

// Team-draft (Radlinski et al.) made deterministic: instead of a per-round coin flip, a PRNG seeded
// on the digest `seed` decides which team drafts first each round — same determinism doctrine as the
// explore-lane hash (stable within a day, rotates daily, NO Math.random / Date.now). Each round the
// first team appends its top not-yet-taken candidate, then the second team does the same; the
// drafting arm is stamped on the slot. Both rankings draw from the same pool, so a `taken` set makes
// every tweet appear at most once. Fills up to `slots` (the non-explore budget).
export function teamDraft(rankA: DigestItem[], rankB: DigestItem[], armA: Arm, armB: Arm, seed: string, slots: number): DigestItem[] {
  // mulberry32 seeded from the digest seed (eval.ts's bootstrap PRNG shape). Deterministic per seed.
  let s = hashStr(seed) >>> 0;
  const rand = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const out: DigestItem[] = [];
  const taken = new Set<string>();
  let ia = 0, ib = 0;
  const nextFrom = (rank: DigestItem[], i: number) => { while (i < rank.length && taken.has(rank[i].tweet_id)) i++; return i; };
  const draftOne = (rank: DigestItem[], getI: () => number, setI: (n: number) => void, arm: Arm): boolean => {
    const i = nextFrom(rank, getI());
    setI(i);
    if (i >= rank.length) return false;
    const pick = rank[i];
    taken.add(pick.tweet_id);
    out.push({ ...pick, arm });
    setI(i + 1);
    return true;
  };
  while (out.length < slots) {
    // PRNG picks which team drafts FIRST this round — the credit-symmetry of team-draft.
    const aFirst = rand() < 0.5;
    const first = aFirst
      ? draftOne(rankA, () => ia, n => { ia = n; }, armA)
      : draftOne(rankB, () => ib, n => { ib = n; }, armB);
    if (out.length >= slots) break;
    const second = aFirst
      ? draftOne(rankB, () => ib, n => { ib = n; }, armB)
      : draftOne(rankA, () => ia, n => { ia = n; }, armA);
    if (!first && !second) break; // both rankings exhausted — nothing left to draft
  }
  return out;
}

// M9 author prior: log1p(kept-like count) per author_id. Derived from engagement_labels ONLY —
// NEVER from reviews (CLAUDE.md invariant: reviews are eval-only gold; a feature built from them
// leaks the gate into the model). Same exclusions as the taste profile: prunes out, and tweets
// that were later hand-reviewed out (see the leak-guard note on buildTaste). The plan's "/max
// normalization" is skipped on purpose: z() downstream is scale-invariant, so it's a no-op.
export function buildAuthorPrior(db: DatabaseSync): Map<string, number> {
  const rows = db.prepare(`
    SELECT t.author_id a, COUNT(DISTINCT t.tweet_id) c
    FROM engagement_labels e JOIN tweets t ON e.tweet_id = t.tweet_id
    WHERE e.tweet_id NOT IN (SELECT tweet_id FROM label_prunes)
      AND e.tweet_id NOT IN (SELECT tweet_id FROM reviews)
      AND t.author_id IS NOT NULL AND t.author_id != ''
    GROUP BY t.author_id
  `).all() as { a: string; c: number }[];
  return new Map(rows.map(r => [r.a, Math.log1p(r.c)]));
}

// media column is JSON text in sqlite; tolerate legacy null/'' rows.
export function parseMedia(raw: unknown): { type: string; url: string }[] {
  if (typeof raw !== "string" || !raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
}

// Resolve quoted_id → inline quoted content for a FINAL slate (bounded, ~50 rows — not the corpus).
export function attachQuoted<T extends { quoted_id?: string | null }>(
  db: DatabaseSync, items: T[],
): (T & { quoted: DigestItem["quoted"] })[] {
  const ids = [...new Set(items.map(i => i.quoted_id).filter(Boolean))] as string[];
  const found = new Map<string, QuotedTweet>();
  if (ids.length) {
    const rows = db.prepare(`
      SELECT tweet_id, author_handle, author_name, text, media, created_at
      FROM tweets WHERE tweet_id IN (${ids.map(() => "?").join(",")})
    `).all(...ids) as any[];
    for (const r of rows) {
      found.set(r.tweet_id, { ...r, media: parseMedia(r.media) });
    }
  }
  return items.map(i => ({
    ...i,
    quoted: i.quoted_id ? (found.get(i.quoted_id) ?? { tweet_id: i.quoted_id }) : null,
  }));
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

  // Leak guard (M9): a tweet can be BOTH liked and hand-reviewed. Reviewed tweets are the eval
  // gate's test pool — if their text feeds the profile, the eval mix/taste arms score gate rows
  // against their own text. Excluding them mirrors labels.ts ("an explicit verdict overrides the
  // harvested sources") and costs only the small liked∩reviewed overlap (`npm run labels`).
  // GROUP BY: positives are a SET of tweets (labels.ts / buildAuthorPrior convention) — a tweet
  // liked AND bookmarked must not weigh its text 2x in the centroid. Engagement-count weighting,
  // if ever wanted, should be a deliberate feature everywhere, not a JOIN artifact here.
  const likes = (db.prepare(`
    SELECT t.text FROM engagement_labels e JOIN tweets t ON e.tweet_id = t.tweet_id
    WHERE e.tweet_id NOT IN (SELECT tweet_id FROM label_prunes)
      AND e.tweet_id NOT IN (SELECT tweet_id FROM reviews)
      AND t.text IS NOT NULL AND t.text != ''
    GROUP BY t.tweet_id
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

// The digest: un-liked, un-reviewed tweets (optionally recent), ranked by the M9 weighted mix
// (taste cosine + rubric + author prior, z-scored over the candidate pool), diversified, plus an
// explore slice the ranker did NOT choose (CLAUDE.md invariant: every ranker version carries an
// explore lane — anti-filter-bubble AND the only low-bias signal source, since a profile can never
// learn about what it never shows). Reviewed tweets leave the feed: a 👍/👎 (review mode or in-flow
// on a digest card) is also a read receipt — the ranker doesn't learn from reviews, so a dropped
// tweet would otherwise rank identically tomorrow and reappear.
export function buildDigest(
  db: DatabaseSync,
  { limit = 50, days = 0, seed = new Date().toISOString().slice(0, 10), matchup = MATCHUP }:
    { limit?: number; days?: number; seed?: string; matchup?: readonly [Arm, Arm] | null } = {},
): DigestItem[] {
  const m = buildTaste(db);
  const prior = buildAuthorPrior(db);
  const rubric = loadRubricScores(db); // latest sha; tolerates a never-scored db (empty map → z=0)
  const rows = db.prepare(`
    SELECT tweet_id, author_id, author_handle, author_name, text, media, quoted_id, created_at, likes, rts, replies, views FROM tweets
    WHERE text IS NOT NULL AND text != ''
      AND (source = 'poll' OR tweet_id IN (SELECT tweet_id FROM impressions))
      AND tweet_id NOT IN (SELECT tweet_id FROM engagement_labels)
      AND tweet_id NOT IN (SELECT tweet_id FROM reviews)
  `).all() as any[];

  // days filters on AUTHORED age (created_at), not capture age — X resurfaces years-old tweets
  // into the feed, so "captured yesterday" says nothing about freshness. created_at is stored in
  // Twitter's raw format ("Fri Jul 03 03:34:14 +0000 2026"), which SQLite can't parse but
  // Date.parse can — hence JS, not SQL. Under a window, an unparseable/missing date is stale.
  const cutoff = Date.now() - days * 86_400_000;

  // fragment filter applies to every lane — link-only / one-word replies aren't worth a slot,
  // EXCEPT quote tweets: "this." over a quoted tweet is real curation, the substance is the quote.
  const candidates = rows
    .map(r => ({ ...r, media: parseMedia(r.media), lane: "taste" as const, arm: null as Arm | null }))
    .filter(r => days <= 0 || new Date(r.created_at ?? 0).getTime() > cutoff)
    .filter(r => r.quoted_id || tokenize(r.text).length >= 4);

  // M9: score = the weighted mix, z-scored over THIS candidate pool. An unscored rubric row is
  // null → z=0 (pool-neutral); an unknown author gets prior 0 (a real value — most of the pool).
  // BLIND (M11): this runs pool-wide, BEFORE any arm drafts — every candidate carries the same mix
  // score/parts no matter which arm later drafts it, so the client's ✦ badge can't leak the arm.
  const mixed = mixFinal(candidates.map(r => ({
    taste: scoreText(r.text, m),
    rubric: rubric.scores.get(r.tweet_id) ?? null,
    author: prior.get(r.author_id ?? "") ?? 0,
  })));
  candidates.forEach((r, i) => { r.score = mixed[i].final; r.parts = mixed[i].parts; });

  const exploreN = Math.max(1, Math.round(limit / 10));
  const slots = Math.max(1, limit - exploreN); // non-explore budget (same in both paths)

  // Non-explore slate. Two paths that share EVERYTHING downstream (explore, quote-attach, receipts):
  //  - MATCHUP=null → the plain M9 mix digest, byte-for-byte as pre-M11 (arm stays null; the branch
  //    below is the literal old code). Regression-tested against a fixed slate.
  //  - MATCHUP set → team-draft: each arm ranks+diversifies the SAME pool, a seeded draft fills the
  //    slots, and each row records the drafting arm. Explore is added identically afterward.
  let picked: DigestItem[];
  if (!matchup) {
    const scored = candidates
      .filter(r => r.score > 0) // above pool average (z-mix is centered) — the M9 analog of cosine>0
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(limit * 4, 200)); // diversify within a generous head
    picked = diversify(scored, 0.75, slots);
  } else {
    const [armA, armB] = matchup;
    // Each arm ranks the whole filtered pool (no score>0 pre-filter: an arm may legitimately rank
    // a below-mix-mean tweet first — e.g. keyword loves a high-AI-density tweet the mix docks on a
    // cold author — and the draft, not a mix threshold, decides the slate). MMR-diversify each arm's
    // list to `slots`, then team-draft. Explore still surfaces the truly un-drafted tail below.
    const rankA = armRanking(candidates as DigestItem[], armA, slots);
    const rankB = armRanking(candidates as DigestItem[], armB, slots);
    picked = teamDraft(rankA, rankB, armA, armB, seed, slots);
  }

  // Explore lane: sampled from candidates the taste head did NOT pick (zero-score included) by a
  // day-seeded hash — stable within a day, rotates daily, no Math.random. Interleaved, not
  // appended, so the tail-off-a-list problem can't quietly starve it of reads.
  const inFeed = new Set(picked.map(p => p.tweet_id));
  const explore = candidates
    .filter(r => !inFeed.has(r.tweet_id))
    .sort((a, b) => hashStr(seed + a.tweet_id) - hashStr(seed + b.tweet_id))
    .slice(0, exploreN)
    .map(r => ({ ...r, lane: "explore" as const, arm: null as Arm | null })); // explore is arm-agnostic — invariant
  const step = Math.max(1, Math.floor(picked.length / (explore.length + 1)));
  explore.forEach((e, i) => picked.splice(Math.min((i + 1) * step + i, picked.length), 0, e));
  // Resolve quote context only for the final slate (~limit rows), then drop the raw quoted_id and
  // the author_id the mix needed internally — neither belongs in the payload.
  return attachQuoted(db, picked as (DigestItem & { quoted_id?: string | null; author_id?: string | null })[])
    .map(({ quoted_id: _qid, author_id: _aid, ...item }) => item as DigestItem);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(process.env.AFY_DB ?? "afy.db");
  const items = buildDigest(db, { limit: 20 });
  const mode = MATCHUP ? `M11 team-draft [${MATCHUP[0]} vs ${MATCHUP[1]}]` : "M9 mix-ranked";
  console.log(`\nTop ${items.length} for you (${mode}):\n`);
  for (const it of items) {
    const who = it.author_handle ? `@${it.author_handle}` : "(unknown)";
    // arm tag shows which ranker drafted each taste slot (blank for explore, whose arm is null).
    const tag = it.lane === "explore" ? "✧ explore" : (it.arm ?? "—").padEnd(9);
    console.log(`${it.score.toFixed(3)} ${tag.padEnd(10)} ${who.padEnd(18)} ${it.text.replace(/\s+/g, " ").slice(0, 80)}`);
  }
}
