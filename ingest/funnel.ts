// M10 funnel report: what the digest served vs what you opened vs how you voted — by lane, by
// rank, and by mix component. Read-only over digest_log/digest_opens/reviews (npm run funnel;
// AFY_DB to override the db). Only covers tweets served AFTER digest_log existed — pre-M10
// votes have no serve context to attribute to (that lost data is why M10 exists).
import type { DatabaseSync } from "node:sqlite";

// A tweet's exposure context = its FIRST logged serve (position bias acts at first sight;
// re-serves on later reloads/days don't re-count). SQLite's bare-column-with-MIN rule pins
// lane/rank/channel to that first row. Opens must come at-or-after it to count.
const FIRST_SERVE = `SELECT tweet_id, lane, rank, channel, MIN(ts) AS ts FROM digest_log GROUP BY tweet_id`;
// A vote's context = the latest serve at-or-before the vote (the slate it was cast against),
// latest verdict per tweet (labels.ts convention). Votes with no prior logged serve (review
// mode, pre-M10 votes) don't join — no context, honestly excluded.
const VOTE_SERVE = `
  SELECT v.verdict, dl.lane, dl.rank, dl.parts
  FROM (SELECT tweet_id, verdict, MAX(ts) AS ts FROM reviews GROUP BY tweet_id) v
  JOIN digest_log dl ON dl.tweet_id = v.tweet_id AND dl.ts =
    (SELECT MAX(ts) FROM digest_log WHERE tweet_id = v.tweet_id AND ts <= v.ts)`;

const bucket = (col: string) =>
  `CASE WHEN ${col}<=5 THEN '1-5' WHEN ${col}<=10 THEN '6-10' WHEN ${col}<=20 THEN '11-20' ELSE '21+' END`;

export function funnel(db: DatabaseSync) {
  const openJoin = `
    FROM fs LEFT JOIN digest_opens o ON o.tweet_id = fs.tweet_id AND o.ts >= fs.ts`;
  const lanes = db.prepare(`
    WITH fs AS (${FIRST_SERVE})
    SELECT fs.lane, COUNT(*) AS served, COUNT(DISTINCT o.tweet_id) AS opened,
      ROUND(1.0 * COUNT(DISTINCT o.tweet_id) / COUNT(*), 3) AS open_rate
    ${openJoin} GROUP BY fs.lane ORDER BY fs.lane`).all();
  const ranks = db.prepare(`
    WITH fs AS (${FIRST_SERVE})
    SELECT ${bucket("fs.rank")} AS rank_bucket, COUNT(*) AS served,
      COUNT(DISTINCT o.tweet_id) AS opened,
      ROUND(1.0 * COUNT(DISTINCT o.tweet_id) / COUNT(*), 3) AS open_rate
    ${openJoin} GROUP BY rank_bucket ORDER BY MIN(fs.rank)`).all();
  const votesByLane = db.prepare(`
    WITH vs AS (${VOTE_SERVE})
    SELECT lane, SUM(verdict = 1) AS up, SUM(verdict = -1) AS down FROM vs
    GROUP BY lane ORDER BY lane`).all();
  const votesByRank = db.prepare(`
    WITH vs AS (${VOTE_SERVE})
    SELECT ${bucket("vs.rank")} AS rank_bucket, SUM(verdict = 1) AS up, SUM(verdict = -1) AS down
    FROM vs GROUP BY rank_bucket ORDER BY MIN(vs.rank)`).all();
  // Mean weighted z-parts of voted cards, as served — "did the author prior eat the 👎s?" is
  // answered by the author column diverging between verdict rows.
  const partsByVerdict = db.prepare(`
    WITH vs AS (${VOTE_SERVE})
    SELECT CASE vs.verdict WHEN 1 THEN 'up' ELSE 'down' END AS verdict, COUNT(*) AS n,
      ROUND(AVG(json_extract(parts, '$.taste')), 3) AS taste,
      ROUND(AVG(json_extract(parts, '$.rubric')), 3) AS rubric,
      ROUND(AVG(json_extract(parts, '$.author')), 3) AS author
    FROM vs GROUP BY vs.verdict ORDER BY vs.verdict DESC`).all();
  const totals = db.prepare(`
    SELECT (SELECT COUNT(*) FROM digest_log) AS serve_rows,
      (SELECT COUNT(DISTINCT tweet_id) FROM digest_log) AS tweets_served,
      (SELECT COUNT(*) FROM digest_opens) AS opens,
      (SELECT COUNT(*) FROM (${VOTE_SERVE})) AS votes_with_context`).get() as Record<string, number>;
  return { totals, lanes, ranks, votesByLane, votesByRank, partsByVerdict };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(process.env.AFY_DB ?? "afy.db");
  const r = funnel(db);
  if (!r.totals.serve_rows) {
    console.log("No serves logged yet — digest_log fills on the next /digest load (M10).");
    process.exit(0);
  }
  console.log(`\ndigest funnel — ${r.totals.serve_rows} serve rows over ${r.totals.tweets_served} tweets, ` +
    `${r.totals.opens} opens, ${r.totals.votes_with_context} votes with serve context\n`);
  console.log("serves → opens by lane:"); console.table(r.lanes);
  console.log("serves → opens by rank at first serve (position bias):"); console.table(r.ranks);
  console.log("votes by lane as served:"); console.table(r.votesByLane);
  console.log("votes by rank as served:"); console.table(r.votesByRank);
  console.log("mean mix parts of voted cards, as served:"); console.table(r.partsByVerdict);
}
