// Daily digest report card: "was the digest actually good that day, and is it trending better?"
// One row per digest day. Read-only over digest_log/reviews/digest_opens (npm run scorecard; AFY_DB
// to override the db). Companion to funnel.ts (which slices by lane/rank across all time) and
// interleave.ts (which compares rankers) — this one asks the plainest question: day by day, did the
// slate earn 👍s and dodge 👎s, and is the trend up?
//
// Keying doctrine — EVERYTHING here is keyed to a tweet's FIRST logged serve (funnel.ts's FIRST_SERVE:
// exposure = first sight; re-serves on later reloads/days don't re-count). A row's `date` is the
// tweet's first-serve digest_date; its rank/lane are the first-serve row's (SQLite's bare-column-with
// -MIN rule). This is a deliberate, self-consistency-driven read of funnel.ts's VOTE_SERVE:
//   • Inclusion is IDENTICAL to funnel: a vote counts only if a serve exists at-or-before it (else
//     context-free — review-mode / pre-log votes — honestly excluded). "first serve ≤ latest vote"
//     is exactly "some serve ≤ vote", so the same votes qualify.
//   • Bucketing differs on purpose: funnel attributes a vote to the LATEST serve at-or-before it (to
//     read rank/lane bias); a report card keyed to first exposure must bucket the vote by the FIRST
//     serve instead, or `down` and `junk@k` (which is explicitly first-serve-keyed) would disagree —
//     junk would count a re-served tweet's 👎 on day 1 while `down` counted it on day 2. First-serve
//     keying makes each row internally coherent: served, opens, up/down, junk, and the lane split all
//     describe the same set of tweets the digest first showed you that day.
// Verdict per tweet is the LATEST verdict (labels.ts convention); opens count only at-or-after the
// first serve and attribute to the first-serve date (a tweet opened two days later still credits the
// day it was first served).
//
// Honest-output doctrine: every rate prints the n behind it (junk@k carries its down/total fraction;
// up/down/opens sit next to `served`). A day with 3 votes must read as thin, not as a trend. Rates
// guard div-by-zero (0 tweets at a cut → a dash, never NaN). Read-only: like funnel/eval/interleave
// this never CREATEs/ALTERs — a db predating digest_log reports "nothing served yet" and exits 0.
import type { DatabaseSync } from "node:sqlite";

// A tweet's exposure context = its FIRST logged serve. Bare rank/lane/digest_date pin to the MIN(ts)
// row (funnel.ts's FIRST_SERVE doctrine).
const FIRST_SERVE = `SELECT tweet_id, digest_date, rank, lane, MIN(ts) AS ts FROM digest_log GROUP BY tweet_id`;

// Raw per-day integer sums (rates derived in JS so every count is inspectable / assertable).
interface DayRaw {
  date: string;
  served: number;
  up: number; down: number;
  opens: number;
  j10_down: number; j10_n: number; // 👎 among first-served-that-day at rank≤10, over that count
  j20_down: number; j20_n: number; // …at rank≤20
  exp_up: number; exp_down: number;   // explore-lane (✧) verdicts, first-serve lane
  core_up: number; core_down: number; // non-explore verdicts
}

export interface DayRow extends DayRaw {
  hits: number;             // = up — the report-card's "good serve" tally (a 👍 on a first-served tweet)
  j10: number | null;       // junk@10 rate, null when j10_n === 0 (dash at print)
  j20: number | null;       // junk@20 rate, null when j20_n === 0
}

export type Scorecard =
  | { present: false }                          // db predates digest_log — nothing served yet
  | { present: true; days: DayRow[]; totals: DayRow };

const has = (db: DatabaseSync, table: string) =>
  (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).all(table) as unknown[]).length > 0;

// Derive rates + hits from raw sums; used per-day and for the TOTAL line (global num/den, not a mean
// of daily rates — the honest way to pool cuts of different sizes).
function finish(r: DayRaw): DayRow {
  return {
    ...r,
    hits: r.up,
    j10: r.j10_n ? r.j10_down / r.j10_n : null,
    j20: r.j20_n ? r.j20_down / r.j20_n : null,
  };
}

export function scorecard(db: DatabaseSync): Scorecard {
  // Read-only tolerance: a db predating digest_log (pre-M10) has nothing to grade. Probe rather than
  // let a missing table throw. reviews/digest_opens may also be absent on an old db → treat as empty
  // by swapping in a no-row source (never CREATE — that's the server's job).
  if (!has(db, "digest_log")) return { present: false };
  const REVIEWS = has(db, "reviews") ? `SELECT tweet_id, verdict, ts FROM reviews`
    : `SELECT NULL AS tweet_id, NULL AS verdict, NULL AS ts WHERE 0`;
  const OPENS = has(db, "digest_opens") ? `SELECT tweet_id, ts FROM digest_opens`
    : `SELECT NULL AS tweet_id, NULL AS ts WHERE 0`;

  // fs: first serve per tweet. lv: latest verdict per tweet (bare verdict pins to MAX(ts) row). op:
  // tweets opened at-or-after their first serve. j: one row per first-served tweet, carrying its
  // first-serve date/rank/lane, its in-context verdict (NULL if none or context-free), opened flag.
  const raw = db.prepare(`
    WITH fs AS (${FIRST_SERVE}),
    lv AS (SELECT tweet_id, verdict, MAX(ts) AS vts FROM (${REVIEWS}) GROUP BY tweet_id),
    op AS (SELECT DISTINCT fs.tweet_id AS tweet_id
           FROM fs JOIN (${OPENS}) o ON o.tweet_id = fs.tweet_id AND o.ts >= fs.ts),
    j AS (
      SELECT fs.digest_date AS date, fs.rank AS rank, fs.lane AS lane,
        CASE WHEN lv.tweet_id IS NOT NULL AND lv.vts >= fs.ts THEN lv.verdict END AS v,
        CASE WHEN op.tweet_id IS NOT NULL THEN 1 ELSE 0 END AS opened
      FROM fs
      LEFT JOIN lv ON lv.tweet_id = fs.tweet_id
      LEFT JOIN op ON op.tweet_id = fs.tweet_id)
    SELECT date,
      COUNT(*) AS served,
      SUM(CASE WHEN v = 1 THEN 1 ELSE 0 END) AS up,
      SUM(CASE WHEN v = -1 THEN 1 ELSE 0 END) AS down,
      SUM(opened) AS opens,
      SUM(CASE WHEN rank <= 10 THEN 1 ELSE 0 END) AS j10_n,
      SUM(CASE WHEN rank <= 10 AND v = -1 THEN 1 ELSE 0 END) AS j10_down,
      SUM(CASE WHEN rank <= 20 THEN 1 ELSE 0 END) AS j20_n,
      SUM(CASE WHEN rank <= 20 AND v = -1 THEN 1 ELSE 0 END) AS j20_down,
      SUM(CASE WHEN lane = 'explore' AND v = 1 THEN 1 ELSE 0 END) AS exp_up,
      SUM(CASE WHEN lane = 'explore' AND v = -1 THEN 1 ELSE 0 END) AS exp_down,
      SUM(CASE WHEN lane <> 'explore' AND v = 1 THEN 1 ELSE 0 END) AS core_up,
      SUM(CASE WHEN lane <> 'explore' AND v = -1 THEN 1 ELSE 0 END) AS core_down
    FROM j GROUP BY date ORDER BY date`).all() as unknown as DayRaw[];

  const days = raw.map(finish);
  // TOTAL line: sum every count across days, then re-derive rates globally.
  const z: DayRaw = { date: "TOTAL", served: 0, up: 0, down: 0, opens: 0,
    j10_down: 0, j10_n: 0, j20_down: 0, j20_n: 0, exp_up: 0, exp_down: 0, core_up: 0, core_down: 0 };
  for (const d of raw) for (const k of Object.keys(z) as (keyof DayRaw)[])
    if (k !== "date") (z[k] as number) += Number(d[k] ?? 0);
  return { present: true, days, totals: finish(z) };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────
const pct = (r: number) => `${(r * 100).toFixed(1)}%`;
// junk cell: rate with its down/total fraction so the n is always visible; dash when no tweets at the
// cut (never NaN). e.g. "50.0% (1/2)" or "— (0/0)".
const junk = (rate: number | null, down: number, n: number) => n === 0 ? `— (0/0)` : `${pct(rate!)} (${down}/${n})`;

function render(row: DayRow) {
  return {
    date: row.date,
    served: row.served,
    up: row.up, down: row.down, hits: row.hits,
    "junk@10": junk(row.j10, row.j10_down, row.j10_n),
    "junk@20": junk(row.j20, row.j20_down, row.j20_n),
    opens: row.opens,
    "✧ up/dn": `${row.exp_up}/${row.exp_down}`,
    "core up/dn": `${row.core_up}/${row.core_down}`,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(process.env.AFY_DB ?? "afy.db");
  const r = scorecard(db);
  if (!r.present || r.totals.served === 0) {
    console.log("Nothing served yet — digest_log fills on the next /digest load (M10). No scorecard to show.");
    process.exit(0);
  }
  console.log(`\ndigest scorecard — ${r.totals.served} tweets first-served over ${r.days.length} day(s), ` +
    `${r.totals.up} 👍 / ${r.totals.down} 👎, ${r.totals.opens} opens\n` +
    `(junk@k = 👎 among first-served-that-day at rank≤k; ✧/core = explore vs non-explore lane; ` +
    `every rate prints its n — thin days read as thin)\n`);
  console.table([...r.days.map(render), render(r.totals)]);
}
