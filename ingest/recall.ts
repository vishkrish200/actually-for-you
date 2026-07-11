// Candidate-stage recall: "of tweets I later liked/bookmarked on X, did a digest build have the
// tweet as an eligible candidate before that observed engagement, and did the digest select it?"
// This is intentionally separate from eval/interleave, which measure precision of served cards.
//
// The old report compared a later organic engagement with ANY historical serve. That conflated a
// ranker miss with tweets captured after the last digest build, tweets that were ineligible at the
// time, and serves that happened after the engagement had already excluded the tweet. This version records a
// compact `digest_runs` ledger (one row per build, not every candidate per reload) and replays the
// candidate predicate from append-only timestamps. It is causal as far as the local sensor permits:
// engagement_labels records when the Like/Bookmark was observed, not X's private action timestamp.
import type { DatabaseSync } from "node:sqlite";
import { isDigestContentCandidate } from "./digest.ts";

const DAY_MS = 86_400_000;

export interface Miss { tweet_id: string; ts: string; snippet: string; first_eligible_ts: string }
export interface RecallReport {
  days: number;
  cutoff: string;
  emptyReason?: string;
  likes: number;
  bookmarks: number;
  total: number;
  captured: number;
  notCaptured: number;
  loggedRuns: number;
  noDigestRuns: boolean;
  available: number;              // candidate in at least one digest build before first observed engagement
  served: number;                 // selected before first observed engagement, among available
  missed: number;                 // available but never selected before first observed engagement
  notAvailable: number;           // captured, but no prior digest build found it eligible
  medianTimeToFirstServeMs: number | null;
  missedList: Miss[];
}

interface Run { ts: string; days: number }
interface EngagementRow {
  tweet_id: string;
  last_ts: string;
  first_ts: string;
  text: string | null;
  quoted_id: string | null;
  source: string | null;
  captured_at: string | null;
  created_at: string | null;
  first_impression_ts: string | null;
  first_review_ts: string | null;
}

const has = (db: DatabaseSync, table: string) =>
  (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).all(table) as unknown[]).length > 0;
const ms = (ts: string | null | undefined) => ts ? Date.parse(ts) : NaN;
const beforeOrAt = (ts: string | null | undefined, at: number) => {
  const n = ms(ts);
  return Number.isFinite(n) && n <= at;
};
const before = (ts: string | null | undefined, at: number) => {
  const n = ms(ts);
  return Number.isFinite(n) && n < at;
};

// Mirrors digest.ts's pre-score candidate predicate at the instant of an old run. Scoring features
// are deliberately absent: this asks whether ranking had the chance to choose the tweet, not how it
// would have scored it. A poll row is available once captured; net/dom rows require an impression,
// because that is the product's actual candidate-admission rule.
function eligibleAt(row: EngagementRow, run: Run): boolean {
  const runMs = ms(run.ts);
  const text = (row.text ?? "").toString();
  if (!Number.isFinite(runMs) || !text.trim() || !isDigestContentCandidate(text, row.quoted_id)) return false;
  if (beforeOrAt(row.first_ts, runMs) || beforeOrAt(row.first_review_ts, runMs)) return false;
  if (row.source === "poll") {
    if (!beforeOrAt(row.captured_at, runMs)) return false;
  } else if (!beforeOrAt(row.first_impression_ts, runMs)) {
    return false;
  }
  if (run.days > 0) {
    const authoredMs = ms(row.created_at);
    if (!Number.isFinite(authoredMs) || authoredMs <= runMs - run.days * DAY_MS) return false;
  }
  return true;
}

const snip = (t: string) => {
  const s = t.replace(/\s+/g, " ").trim();
  return s.length > 80 ? s.slice(0, 79) + "…" : s;
};
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const ys = [...xs].sort((a, b) => a - b), mid = Math.floor(ys.length / 2);
  return ys.length % 2 ? ys[mid] : (ys[mid - 1] + ys[mid]) / 2;
};

export function recall(db: DatabaseSync, days: number, nowMs: number = Date.now()): RecallReport {
  const cutoff = new Date(nowMs - days * DAY_MS).toISOString();
  const noDigestRunTable = !has(db, "digest_runs");
  const base: RecallReport = {
    days, cutoff, likes: 0, bookmarks: 0, total: 0, captured: 0, notCaptured: 0,
    loggedRuns: 0, noDigestRuns: noDigestRunTable, available: 0, served: 0, missed: 0, notAvailable: 0,
    medianTimeToFirstServeMs: null, missedList: [],
  };
  if (!has(db, "engagement_labels"))
    return { ...base, emptyReason: "No engagement_labels table yet — no organic likes/bookmarks recorded." };

  const pruneClause = has(db, "label_prunes")
    ? `AND el.tweet_id NOT IN (SELECT tweet_id FROM label_prunes)` : "";
  const counts = db.prepare(`
    SELECT SUM(CASE WHEN source = 'like' THEN 1 ELSE 0 END) AS likes,
           SUM(CASE WHEN source = 'bookmark' THEN 1 ELSE 0 END) AS bookmarks,
           COUNT(DISTINCT tweet_id) AS total
    FROM engagement_labels el WHERE el.ts >= ? ${pruneClause}`).get(cutoff) as
    { likes: number | null; bookmarks: number | null; total: number | null };
  const total = Number(counts.total ?? 0);
  if (total === 0)
    return { ...base, emptyReason: `No organic likes/bookmarks in the last ${days} day(s) (since ${cutoff}).` };

  const impressionsExpr = has(db, "impressions")
    ? `(SELECT MIN(i.ts) FROM impressions i WHERE i.tweet_id = recent.tweet_id)` : "NULL";
  const reviewsExpr = has(db, "reviews")
    ? `(SELECT MIN(v.ts) FROM reviews v WHERE v.tweet_id = recent.tweet_id)` : "NULL";
  const tweetsJoin = has(db, "tweets") ? "LEFT JOIN tweets t ON t.tweet_id = recent.tweet_id" : "";
  const tweetCols = has(db, "tweets")
    ? "t.text AS text, t.quoted_id AS quoted_id, t.source AS source, t.captured_at AS captured_at, t.created_at AS created_at"
    : "NULL AS text, NULL AS quoted_id, NULL AS source, NULL AS captured_at, NULL AS created_at";
  const rows = db.prepare(`
    WITH recent AS (
      SELECT el.tweet_id, MAX(el.ts) AS last_ts
      FROM engagement_labels el WHERE el.ts >= ? ${pruneClause} GROUP BY el.tweet_id
    )
    SELECT recent.tweet_id, recent.last_ts,
      (SELECT MIN(e.ts) FROM engagement_labels e WHERE e.tweet_id = recent.tweet_id) AS first_ts,
      ${tweetCols}, ${impressionsExpr} AS first_impression_ts, ${reviewsExpr} AS first_review_ts
  FROM recent ${tweetsJoin} ORDER BY recent.last_ts DESC`).all(cutoff) as EngagementRow[];
  const runs = noDigestRunTable ? [] : db.prepare(
    "SELECT ts, days FROM digest_runs ORDER BY ts ASC",
  ).all() as Run[];
  // A fresh server has created the table but has not served a digest yet. Mark the report the same
  // way as a pre-ledger database so the CLI calls these rows unmeasured, not ranker misses.
  const noDigestRuns = runs.length === 0;
  const hasDigestLog = has(db, "digest_log");

  let captured = 0, notCaptured = 0, available = 0, served = 0, missed = 0, notAvailable = 0;
  const waits: number[] = [], missedList: Miss[] = [];
  for (const row of rows) {
    const text = (row.text ?? "").toString();
    if (!text.trim()) { notCaptured++; continue; }
    captured++;
    const firstEngagementMs = ms(row.first_ts);
    const firstEligible = runs.find(run => before(run.ts, firstEngagementMs) && eligibleAt(row, run));
    if (!firstEligible) { notAvailable++; continue; }
    available++;
    const firstServe = hasDigestLog ? db.prepare(`
      SELECT MIN(ts) AS ts FROM digest_log
      WHERE tweet_id = ? AND ts >= ? AND ts < ?`).get(row.tweet_id, firstEligible.ts, row.first_ts) as { ts: string | null } : { ts: null };
    if (firstServe.ts) {
      served++;
      waits.push(Math.max(0, ms(firstServe.ts) - ms(firstEligible.ts)));
    } else {
      missed++;
      if (missedList.length < 10) missedList.push({
        tweet_id: row.tweet_id, ts: row.last_ts, snippet: snip(text), first_eligible_ts: firstEligible.ts,
      });
    }
  }

  return {
    ...base, likes: Number(counts.likes ?? 0), bookmarks: Number(counts.bookmarks ?? 0), total,
    captured, notCaptured, loggedRuns: runs.length, noDigestRuns, available, served, missed, notAvailable,
    medianTimeToFirstServeMs: median(waits), missedList,
  };
}

function parseDays(argv: string[]): number {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = a.startsWith("--days=") ? a.slice(7) : a === "--days" ? argv[i + 1] : undefined;
    if (v !== undefined) { const n = Number(v); if (Number.isFinite(n) && n > 0) return Math.floor(n); }
  }
  return 7;
}
const rate = (n: number, d: number) => d > 0 ? `${((n / d) * 100).toFixed(0)}%` : "—";
const fmtDuration = (n: number | null) => n === null ? "—" : n < 60_000 ? `${Math.round(n / 1_000)}s` : `${(n / 60_000).toFixed(1)}m`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(process.env.AFY_DB ?? "afy.db");
  const r = recall(db, parseDays(process.argv));
  if (r.emptyReason) { console.log(r.emptyReason); process.exit(0); }

  console.log(`\nrecall — organic engagements in the last ${r.days}d (since ${r.cutoff})`);
  console.log(`  volume:        ${r.likes} like(s) + ${r.bookmarks} bookmark(s) over ${r.total} distinct tweet(s)`);
  console.log(`  captured:      ${r.captured}/${r.total} (${rate(r.captured, r.total)}) — usable text stored before analysis`);
  console.log(`  digest builds: ${r.loggedRuns}${r.noDigestRuns ? " — ledger starts with the next /digest serve" : ""}`);
  if (r.noDigestRuns) {
    console.log(`  causal recall: unavailable for ${r.captured} captured tweets — no completed digest build was recorded before this ledger.`);
    console.log(`  not captured:  ${r.notCaptured} — no usable tweet text in the pipeline`);
  } else {
    console.log(`  available:     ${r.available}/${r.captured} (${rate(r.available, r.captured)}) — eligible in a completed build before observed engagement`);
    console.log(`  served:        ${r.served}/${r.available} (${rate(r.served, r.available)}) — selected before observed engagement`);
    console.log(`  MISSED:        ${r.missed} eligible-but-never-selected before engagement`);
    console.log(`  not available: ${r.notAvailable} captured tweets had no prior eligible digest opportunity`);
    console.log(`  not captured:  ${r.notCaptured} — no usable tweet text in the pipeline`);
    console.log(`  median wait:   ${fmtDuration(r.medianTimeToFirstServeMs)} from first eligible build to first serve`);
    if (r.missedList.length) {
      console.log("\n  most-recent selection misses (up to 10):");
      for (const m of r.missedList) console.log(`    ${m.tweet_id}  eligible ${m.first_eligible_ts}  ${m.snippet}`);
    }
  }
  console.log("\n  note: this is a lower-bound recall probe. Organic engagements are already conditioned on what X surfaced, and their timestamps are when this sensor observed them, not X's private action times.\n");
}
