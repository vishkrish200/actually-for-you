import type { DatabaseSync } from "node:sqlite";

export interface Candidate {
  tweet_id: string;
  author_handle: string | null;
  author_name: string | null;
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
  reviewed: number; // elicited verdict: +1 review-right, -1 review-left, 0 unreviewed
  lane: string;
}

export const WEIGHTS = {
  reviewed: 12,    // explicit "show me more" — your strongest positive, above any passive signal
  opened_detail: 10,
  liked: 8,
  bookmarked: 7,
  replied: 6,
  dwell_norm: 3,   // full weight at 60s cap; controls for raw time bias
  flicked: -5,
};

export function score(c: Candidate): number {
  let s = 0;
  if (c.reviewed > 0) s += WEIGHTS.reviewed;
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

// Trusted dwell: the single best *legitimate* view of a tweet — MAX (not SUM) of per-impression
// dwell, each capped at 60s, ignoring flicks and fast-scroll entries.
//   - MAX, not SUM: a tweet shown 39 times across a session must not accumulate 39× credit;
//     genuine lingering shows up as one solid impression, repeated-glance does not.
//   - cap 60s + drop flicked / high-velocity entries: the capture layer leaks IntersectionObserver
//     exit events under virtualized scroll, inflating raw dwell to minutes on barely-seen tweets.
// Together this is what stops the "it says I dwelled on a tweet I never saw" promotion.
// ponytail: velocity<5 mirrors FLICK_VELOCITY; trades some recall for precision while capture is noisy.
const TRUSTED_DWELL =
  `MAX(CASE WHEN flicked = 0 AND COALESCE(scroll_velocity_at_entry, 99) < 5 THEN MIN(dwell_ms, 60000) ELSE 0 END)`;

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
      HAVING MAX(opened_detail)=0 AND ${TRUSTED_DWELL} > 1500
      ORDER BY ${TRUSTED_DWELL} DESC LIMIT 40`,
  },
  {
    name: "resurface",
    sql: `
      SELECT tweet_id FROM impressions
      WHERE datetime(ts) < datetime('now', '-2 hours')
      GROUP BY tweet_id
      HAVING ${TRUSTED_DWELL} > 5000
      ORDER BY ${TRUSTED_DWELL} DESC LIMIT 30`,
  },
  {
    name: "explore",
    sql: `SELECT tweet_id FROM impressions GROUP BY tweet_id ORDER BY RANDOM() LIMIT 25`,
  },
];

// Viewed-gate: a tweet is only a candidate if it was actually rendered to the user — at least
// one impression reached VIEWED_PCT visibility. This excludes the ~2.4k tweets captured from X's
// GraphQL payload as prefetch but never scrolled into view, plus same-author tweets the user
// never saw. The product is "re-rank what was in front of me", not discovery of unseen content.
// bookmark is exempt: an explicit bookmark means you saw it. VIEWED_PCT mirrors the dwell
// tracker's VISIBILITY_THRESHOLD.
const VIEWED_PCT = 0.5;

export function buildFeed(db: DatabaseSync, limit = 50): (Candidate & { score: number })[] {
  const seen = new Set(
    (db.prepare(
      `SELECT tweet_id FROM impressions GROUP BY tweet_id HAVING MAX(max_visible_pct) >= ?`,
    ).all(VIEWED_PCT) as { tweet_id: string }[]).map(r => r.tweet_id),
  );

  // Latest elicited verdict per tweet (append-only log → most recent ts wins).
  const verdicts = new Map(
    (db.prepare(
      `SELECT tweet_id, verdict FROM reviews
       WHERE rowid IN (SELECT MAX(rowid) FROM reviews GROUP BY tweet_id)`,
    ).all() as { tweet_id: string; verdict: number }[]).map(r => [r.tweet_id, r.verdict]),
  );

  // Negative-feedback veto: a tweet you reported / marked not-interested/muted/blocked, OR
  // explicitly review-left (-1), is suppressed from every lane (bookmark too). Mirrors X's
  // near-veto on negative heads; the graded version is the M5 label-pipeline decision.
  const suppressed = new Set(
    (db.prepare(
      `SELECT tweet_id FROM impressions GROUP BY tweet_id
       HAVING COALESCE(MAX(reported),0)=1 OR COALESCE(MAX(negative_feedback),0)=1`,
    ).all() as { tweet_id: string }[]).map(r => r.tweet_id),
  );
  for (const [id, v] of verdicts) if (v < 0) suppressed.add(id);

  const laneMap = new Map<string, string>();
  for (const lane of LANE_QUERIES) {
    const rows = db.prepare(lane.sql).all() as { tweet_id: string }[];
    for (const r of rows) {
      if (suppressed.has(r.tweet_id)) continue; // negative-feedback veto
      if (lane.name !== "bookmark" && !seen.has(r.tweet_id)) continue; // viewed-gate
      if (!laneMap.has(r.tweet_id)) laneMap.set(r.tweet_id, lane.name);
    }
  }

  if (laneMap.size === 0) return [];

  const ids = [...laneMap.keys()];
  const valuesList = ids.map(() => "(?)").join(",");

  // Anchor on the lane-selected ids, not on either table: a "fresh" tweet may have content
  // but no impression yet, and a retweet may have impressions but no content row. Joining
  // FROM impressions (or FROM tweets) would silently drop one or the other.
  const rows = db.prepare(`
    WITH ids(tweet_id) AS (VALUES ${valuesList})
    SELECT
      ids.tweet_id,
      t.author_handle, t.author_name, t.author_id, t.text, t.media, t.is_thread,
      t.created_at, t.likes, t.rts, t.replies, t.views,
      COALESCE(${TRUSTED_DWELL.replace(/dwell_ms|flicked|scroll_velocity_at_entry/g, "i.$&")}, 0) AS total_dwell,
      COUNT(i.impression_id)           AS impression_count,
      COALESCE(MAX(i.opened_detail),0) AS opened,
      COALESCE(MAX(i.liked),0)         AS liked,
      COALESCE(MAX(i.bookmarked),0)    AS bookmarked,
      COALESCE(MAX(i.replied),0)       AS replied,
      COALESCE(SUM(i.flicked),0)       AS flicked_count,
      MAX(i.ts)                        AS last_seen,
      MIN(i.char_len)                  AS char_len
    FROM ids
    LEFT JOIN tweets t      ON t.tweet_id = ids.tweet_id
    LEFT JOIN impressions i ON i.tweet_id = ids.tweet_id
    GROUP BY ids.tweet_id
  `).all(...ids) as Candidate[];

  const candidates = rows.map(r => {
    const c = { ...r, reviewed: verdicts.get(r.tweet_id) ?? 0 } as Candidate;
    return { ...c, lane: laneMap.get(r.tweet_id) ?? "explore", score: score(c) };
  });

  candidates.sort((a, b) => b.score - a.score);
  return mmr(candidates, 0.7, limit);
}
