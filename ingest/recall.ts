// The miss detector: "of tweets I organically liked/bookmarked on X recently — independent of the
// digest — how many did the pipeline even capture, and how many did the digest actually serve me?"
// Read-only over engagement_labels/label_prunes/tweets/digest_log (npm run recall [-- --days=N];
// AFY_DB to override). This is the ONLY recall-side check in the system: eval/funnel/interleave all
// measure precision (of what I served, was it good?); recall asks the opposite (of what I liked
// elsewhere, did I serve it?). A high miss count means the pipeline isn't capturing/surfacing things
// I demonstrably want.
//
// Window: engagement_labels within the last N days (--days=N, default 7). Wall-clock Date.now for the
// cutoff is fine here — this is an interactive CLI, not a deterministic eval path; recall() takes the
// cutoff instant as an arg so tests pin it. ts is ISO-8601 (UTC 'Z'), lexically comparable, so the
// cutoff is a plain string bound (the funnel/interleave convention).
//
// Classification, per distinct tweet in the window (a like AND a bookmark on one tweet = 2 engagements
// but 1 tweet to capture/serve):
//   • pruned (in label_prunes) → dropped BEFORE counting: a liked-then-pruned tweet is not a miss.
//   • not-captured → no usable tweets row (missing, or empty text): the sensor never stored content.
//   • captured → served (any digest_log row) — the win — else MISSED (captured but never served).
// served ⊆ captured ⊆ total; not-captured = total − captured. % captured / % served both over total
// distinct engaged tweets, each printed with its n (honest-output doctrine).
//
// Honest caveat (always printed): organic likes are biased toward what X's own algorithm already
// showed you, so this is a LOWER-BOUND miss detector, not full recall — it can't see what X never
// surfaced. Read-only: never CREATE/ALTER. Tolerates a db with no digest_log (then nothing has been
// served, so every captured engagement is a miss — said plainly) and an empty window (exit 0).
import type { DatabaseSync } from "node:sqlite";

const DAY_MS = 86_400_000;

export interface Miss { tweet_id: string; ts: string; snippet: string }
export interface RecallReport {
  days: number;
  cutoff: string;              // ISO instant; engagements at-or-after this are in-window
  emptyReason?: string;        // set when engagement_labels absent or the window is empty → CLI exits 0
  likes: number;               // 'like' engagements in window (rows, post-prune)
  bookmarks: number;           // 'bookmark' engagements in window (rows, post-prune)
  total: number;               // distinct tweets engaged in window (post-prune) — the rate denominator
  captured: number;            // distinct tweets with a usable (non-empty text) tweets row
  served: number;              // captured tweets with ≥1 digest_log row
  missed: number;              // captured − served: liked/bookmarked, captured, never served
  notCaptured: number;         // total − captured: the sensor never stored usable content
  noDigestLog: boolean;        // digest_log absent → served forced 0, everything captured is a miss
  missedList: Miss[];          // up to 10, most-recent-first
}

const has = (db: DatabaseSync, table: string) =>
  (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).all(table) as unknown[]).length > 0;

// ~80-char single-line snippet: collapse all whitespace, trim, ellipsize.
const snip = (t: string) => {
  const s = t.replace(/\s+/g, " ").trim();
  return s.length > 80 ? s.slice(0, 79) + "…" : s;
};

export function recall(db: DatabaseSync, days: number, nowMs: number = Date.now()): RecallReport {
  const cutoff = new Date(nowMs - days * DAY_MS).toISOString();
  const base: RecallReport = { days, cutoff, likes: 0, bookmarks: 0, total: 0, captured: 0,
    served: 0, missed: 0, notCaptured: 0, noDigestLog: !has(db, "digest_log"), missedList: [] };

  if (!has(db, "engagement_labels"))
    return { ...base, emptyReason: `No engagement_labels table yet — no organic likes/bookmarks recorded.` };

  // A liked-then-pruned tweet is not a miss — drop pruned tweets from the window before anything else.
  const pruneClause = has(db, "label_prunes")
    ? `AND el.tweet_id NOT IN (SELECT tweet_id FROM label_prunes)` : ``;

  const counts = db.prepare(`
    SELECT SUM(CASE WHEN source = 'like' THEN 1 ELSE 0 END) AS likes,
           SUM(CASE WHEN source = 'bookmark' THEN 1 ELSE 0 END) AS bookmarks,
           COUNT(DISTINCT tweet_id) AS total
    FROM engagement_labels el WHERE el.ts >= ? ${pruneClause}`).get(cutoff) as
    { likes: number | null; bookmarks: number | null; total: number | null };

  const total = Number(counts.total ?? 0);
  if (total === 0)
    return { ...base, emptyReason: `No organic likes/bookmarks in the last ${days} day(s) (since ${cutoff}).` };

  // Per distinct in-window tweet, most-recent-first: its latest engagement ts, its stored text (NULL
  // if no tweets table), and whether the digest ever served it (0 if no digest_log). Correlated
  // subqueries are built conditionally so an absent table never reaches prepare().
  const textExpr = has(db, "tweets") ? `(SELECT text FROM tweets WHERE tweet_id = pt.tweet_id)` : `NULL`;
  const servedExpr = base.noDigestLog ? `0` : `EXISTS(SELECT 1 FROM digest_log dl WHERE dl.tweet_id = pt.tweet_id)`;
  const rows = db.prepare(`
    WITH eng AS (SELECT tweet_id, ts FROM engagement_labels el WHERE el.ts >= ? ${pruneClause}),
         pt AS (SELECT tweet_id, MAX(ts) AS last_ts FROM eng GROUP BY tweet_id)
    SELECT pt.tweet_id AS tweet_id, pt.last_ts AS last_ts, ${textExpr} AS text, ${servedExpr} AS served
    FROM pt ORDER BY pt.last_ts DESC`).all(cutoff) as
    { tweet_id: string; last_ts: string; text: string | null; served: number }[];

  let captured = 0, served = 0, missed = 0, notCaptured = 0;
  const missedList: Miss[] = [];
  for (const r of rows) {
    const text = (r.text ?? "").toString();
    if (text.trim().length === 0) { notCaptured++; continue; }     // no usable content
    captured++;
    if (Number(r.served)) { served++; continue; }                  // captured AND served — the win
    missed++;                                                       // captured, never served — a miss
    if (missedList.length < 10) missedList.push({ tweet_id: r.tweet_id, ts: r.last_ts, snippet: snip(text) });
  }

  return { ...base, likes: Number(counts.likes ?? 0), bookmarks: Number(counts.bookmarks ?? 0),
    total, captured, served, missed, notCaptured, missedList };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────
function parseDays(argv: string[]): number {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = a.startsWith("--days=") ? a.slice(7) : a === "--days" ? argv[i + 1] : undefined;
    if (v !== undefined) { const n = Number(v); if (Number.isFinite(n) && n > 0) return Math.floor(n); }
  }
  return 7;
}
const rate = (n: number, d: number) => d > 0 ? `${((n / d) * 100).toFixed(0)}%` : "—";

if (import.meta.url === `file://${process.argv[1]}`) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(process.env.AFY_DB ?? "afy.db");
  const days = parseDays(process.argv);
  const r = recall(db, days);
  if (r.emptyReason) { console.log(r.emptyReason); process.exit(0); }

  console.log(`\nrecall — organic engagements in the last ${days}d (since ${r.cutoff})`);
  console.log(`  volume:       ${r.likes} like(s) + ${r.bookmarks} bookmark(s) over ${r.total} distinct tweet(s)`);
  console.log(`  captured:     ${r.captured}/${r.total} (${rate(r.captured, r.total)}) — pipeline stored usable text`);
  console.log(`  served:       ${r.served}/${r.total} (${rate(r.served, r.total)}) — digest actually showed it to you`);
  console.log(`  MISSED:       ${r.missed} captured-but-never-served` +
    (r.noDigestLog ? `  (digest_log absent — nothing served yet, so every captured engagement is a miss)` : ``));
  console.log(`  not captured: ${r.notCaptured} — no usable tweet text in the pipeline`);
  if (r.missedList.length) {
    console.log(`\n  most-recent misses (up to 10):`);
    for (const m of r.missedList) console.log(`    ${m.tweet_id}  ${m.snippet}`);
  }
  console.log(`\n  note: organic likes are biased toward what X's own algorithm showed you — ` +
    `this is a lower-bound miss detector, not full recall.\n`);
}
