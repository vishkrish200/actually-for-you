import type { DatabaseSync } from "node:sqlite";

export interface Candidate {
  tweet_id: string;
  author_handle: string | null;
  author_id: string | null;
  text: string | null;
  media: string | null;
  is_thread: number;
  created_at: string | null;
  likes: number;
  rts: number;
  replies: number;
  views: number | null;
  total_dwell: number;
  impression_count: number;
  opened: number;
  liked: number;
  bookmarked: number;
  replied: number;
  flicked_count: number;
  last_seen: string | null;
  char_len: number | null;
  lane: string;
}

export const WEIGHTS = {
  opened_detail: 10,
  liked: 8,
  bookmarked: 7,
  replied: 6,
  dwell_norm: 3,   // full weight at 60s cap; controls for raw time bias
  flicked: -5,
};

export function score(c: Candidate): number {
  let s = 0;
  if (c.opened) s += WEIGHTS.opened_detail;
  if (c.liked) s += WEIGHTS.liked;
  if (c.bookmarked) s += WEIGHTS.bookmarked;
  if (c.replied) s += WEIGHTS.replied;
  s += (Math.min(c.total_dwell, 60_000) / 60_000) * WEIGHTS.dwell_norm;
  if (c.flicked_count > 0) s += WEIGHTS.flicked;
  return s;
}

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/\W+/).filter(w => w.length > 2));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function mmr(
  candidates: (Candidate & { score: number })[],
  lambda = 0.7,
  limit = 50,
): (Candidate & { score: number })[] {
  const selected: (Candidate & { score: number })[] = [];
  const remaining = [...candidates];
  const selectedTokens: Set<string>[] = [];

  while (selected.length < limit && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const tokens = tokenize(remaining[i].text ?? "");
      const maxSim = selectedTokens.length === 0 ? 0
        : Math.max(...selectedTokens.map(st => jaccard(tokens, st)));
      const mmrScore = lambda * remaining[i].score - (1 - lambda) * maxSim;
      if (mmrScore > bestScore) { bestScore = mmrScore; bestIdx = i; }
    }

    selected.push(remaining[bestIdx]);
    selectedTokens.push(tokenize(remaining[bestIdx].text ?? ""));
    remaining.splice(bestIdx, 1);
  }

  return selected;
}

// Lane priority: first lane wins on dedup. explore is non-negotiable (PRD §7.3).
const LANE_QUERIES: { name: string; sql: string }[] = [
  {
    name: "bookmark",
    sql: `SELECT DISTINCT tweet_id FROM impressions WHERE bookmarked=1 LIMIT 20`,
  },
  {
    name: "liked_author",
    sql: `
      SELECT DISTINCT t.tweet_id FROM tweets t
      WHERE t.author_id IN (
        SELECT DISTINCT t2.author_id FROM impressions i
        JOIN tweets t2 ON i.tweet_id = t2.tweet_id
        WHERE i.liked=1 OR i.opened_detail=1
      ) LIMIT 40`,
  },
  {
    name: "fresh",
    sql: `
      SELECT t.tweet_id FROM tweets t
      LEFT JOIN impressions i ON t.tweet_id = i.tweet_id
      WHERE datetime(t.captured_at) > datetime('now', '-48 hours')
      GROUP BY t.tweet_id
      HAVING COALESCE(MAX(i.opened_detail),0)=0 AND COALESCE(MAX(i.liked),0)=0
      LIMIT 40`,
  },
  {
    name: "backlog",
    sql: `
      SELECT tweet_id FROM impressions
      GROUP BY tweet_id
      HAVING MAX(opened_detail)=0 AND SUM(dwell_ms) > 1500
      ORDER BY SUM(dwell_ms) DESC LIMIT 40`,
  },
  {
    name: "resurface",
    sql: `
      SELECT tweet_id FROM impressions
      WHERE datetime(ts) < datetime('now', '-2 hours')
      GROUP BY tweet_id
      HAVING SUM(dwell_ms) > 5000
      ORDER BY SUM(dwell_ms) DESC LIMIT 30`,
  },
  {
    name: "explore",
    sql: `SELECT tweet_id FROM impressions GROUP BY tweet_id ORDER BY RANDOM() LIMIT 25`,
  },
];

export function buildFeed(db: DatabaseSync, limit = 50): (Candidate & { score: number })[] {
  const laneMap = new Map<string, string>();
  for (const lane of LANE_QUERIES) {
    const rows = db.prepare(lane.sql).all() as { tweet_id: string }[];
    for (const r of rows) {
      if (!laneMap.has(r.tweet_id)) laneMap.set(r.tweet_id, lane.name);
    }
  }

  if (laneMap.size === 0) return [];

  const ids = [...laneMap.keys()];
  const placeholders = ids.map(() => "?").join(",");

  const rows = db.prepare(`
    SELECT
      i.tweet_id,
      t.author_handle, t.author_id, t.text, t.media, t.is_thread,
      t.created_at, t.likes, t.rts, t.replies, t.views,
      COALESCE(SUM(i.dwell_ms), 0)     AS total_dwell,
      COUNT(i.impression_id)           AS impression_count,
      COALESCE(MAX(i.opened_detail),0) AS opened,
      COALESCE(MAX(i.liked),0)         AS liked,
      COALESCE(MAX(i.bookmarked),0)    AS bookmarked,
      COALESCE(MAX(i.replied),0)       AS replied,
      COALESCE(SUM(i.flicked),0)       AS flicked_count,
      MAX(i.ts)                        AS last_seen,
      MIN(i.char_len)                  AS char_len
    FROM impressions i
    LEFT JOIN tweets t ON i.tweet_id = t.tweet_id
    WHERE i.tweet_id IN (${placeholders})
    GROUP BY i.tweet_id
  `).all(...ids) as Candidate[];

  const candidates = rows.map(r => ({
    ...r,
    lane: laneMap.get(r.tweet_id) ?? "explore",
    score: score(r as Candidate),
  }));

  candidates.sort((a, b) => b.score - a.score);
  return mmr(candidates, 0.7, limit);
}
