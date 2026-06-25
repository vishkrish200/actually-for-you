import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildFeed } from "./ranker.ts";
import { maybeNotify } from "./notify.ts";

const PORT = 2727;
const DB_PATH = process.env.AFY_DB ?? "afy.db";

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS tweets (
    tweet_id TEXT PRIMARY KEY,
    author_handle TEXT, author_name TEXT, author_id TEXT, text TEXT,
    media TEXT,
    is_thread INTEGER, created_at TEXT,
    likes INTEGER, rts INTEGER, replies INTEGER, views INTEGER,
    captured_at TEXT,
    source TEXT DEFAULT 'net'
  );
  CREATE TABLE IF NOT EXISTS impressions (
    impression_id TEXT PRIMARY KEY,
    tweet_id TEXT, session_id TEXT, ts TEXT,
    position_in_feed INTEGER, dwell_ms INTEGER,
    max_visible_pct REAL, scroll_velocity_at_entry REAL,
    flicked INTEGER, opened_detail INTEGER,
    profile_expanded TEXT,
    liked INTEGER, rt INTEGER, bookmarked INTEGER, replied INTEGER,
    reported INTEGER, negative_feedback INTEGER,
    media_present INTEGER, is_thread INTEGER, char_len INTEGER
  );
  CREATE TABLE IF NOT EXISTS capture_health (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT, kind TEXT, detail TEXT
  );
  -- Elicited labels from the end-of-session review loop. Append-only log (never mutated):
  -- a changed mind is a new row, latest ts per tweet wins. +1 = "show me more like this",
  -- -1 = "don't want to see this". Distinct from passive impressions on purpose — this is
  -- reflective endorsement, not in-the-moment behavior (an intentional extension of PRD §7.2).
  CREATE TABLE IF NOT EXISTS reviews (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    tweet_id TEXT, verdict INTEGER, ts TEXT
  );
`);

// Additive migrations for DBs created before these columns existed (append-only safe).
try { db.exec("ALTER TABLE tweets ADD COLUMN author_name TEXT"); } catch { /* already present */ }
try { db.exec("ALTER TABLE tweets ADD COLUMN source TEXT DEFAULT 'net'"); } catch { /* already present */ }
try { db.exec("ALTER TABLE impressions ADD COLUMN reported INTEGER"); } catch { /* already present */ }
try { db.exec("ALTER TABLE impressions ADD COLUMN negative_feedback INTEGER"); } catch { /* already present */ }

const stmts = {
  tweet: db.prepare(`
    INSERT OR IGNORE INTO tweets
      (tweet_id, author_handle, author_name, author_id, text, media, is_thread, created_at,
       likes, rts, replies, views, captured_at, source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `),
  impression: db.prepare(`
    INSERT OR IGNORE INTO impressions
      (impression_id, tweet_id, session_id, ts, position_in_feed, dwell_ms,
       max_visible_pct, scroll_velocity_at_entry, flicked, opened_detail,
       profile_expanded, liked, rt, bookmarked, replied,
       reported, negative_feedback,
       media_present, is_thread, char_len)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `),
  health: db.prepare(
    `INSERT INTO capture_health (ts, kind, detail) VALUES (?,?,?)`
  ),
  review: db.prepare(
    `INSERT INTO reviews (tweet_id, verdict, ts) VALUES (?,?,?)`
  ),
};

function ingestBatch(body: {
  tweets?: TweetRecord[];
  impressions?: ImpressionEvent[];
  health?: CaptureHealthEvent[];
}) {
  const run = db.prepare("BEGIN");
  run.run();
  try {
    // Net (GraphQL-parsed) tweets first so a rich record wins the INSERT OR IGNORE over a DOM
    // gap-filler for the same id. ponytail: a DOM row written in an earlier batch is NOT replaced
    // when its net record arrives later (rare cross-batch ordering); add a conflict-upgrade clause
    // if the tail's missing metrics ever matter. Content stays insert-only — no row is ever mutated.
    const tweets = [...(body.tweets ?? [])].sort(
      (a, b) => (a.source === "dom" ? 1 : 0) - (b.source === "dom" ? 1 : 0),
    );
    for (const t of tweets) {
      stmts.tweet.run(
        t.tweet_id, t.author_handle, t.author_name ?? "", t.author_id, t.text,
        JSON.stringify(t.media ?? []), t.is_thread ? 1 : 0, t.created_at,
        t.metrics.likes, t.metrics.rts, t.metrics.replies, t.metrics.views ?? null,
        t.captured_at, t.source === "dom" ? "dom" : "net",
      );
    }
    for (const imp of body.impressions ?? []) {
      stmts.impression.run(
        imp.impression_id, imp.tweet_id, imp.session_id, imp.ts,
        imp.position_in_feed, imp.dwell_ms, imp.max_visible_pct,
        imp.scroll_velocity_at_entry, imp.flicked ? 1 : 0, imp.opened_detail ? 1 : 0,
        imp.profile_expanded, imp.liked ? 1 : 0, imp.rt ? 1 : 0,
        imp.bookmarked ? 1 : 0, imp.replied ? 1 : 0,
        imp.reported ? 1 : 0, imp.negative_feedback ? 1 : 0,
        imp.media_present ? 1 : 0, imp.is_thread ? 1 : 0, imp.char_len,
      );
    }
    for (const h of body.health ?? []) {
      stmts.health.run(h.ts, h.kind, h.detail);
    }
    db.prepare("COMMIT").run();
  } catch (e) {
    db.prepare("ROLLBACK").run();
    throw e;
  }
}

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" };

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise(resolve => { let s = ""; req.on("data", c => s += c); req.on("end", () => resolve(s)); });
}

export const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }

  if (req.method === "GET" && req.url === "/status") {
    const counts = {
      tweets: (db.prepare("SELECT COUNT(*) as n FROM tweets").get() as any).n,
      impressions: (db.prepare("SELECT COUNT(*) as n FROM impressions").get() as any).n,
      health: (db.prepare("SELECT COUNT(*) as n FROM capture_health").get() as any).n,
    };
    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify(counts));
    return;
  }

  if (req.method === "POST" && req.url === "/log") {
    const body = await readBody(req);
    console.log("[afy-sw]", body);
    res.writeHead(200, cors); res.end();
    return;
  }

  if (req.method === "POST" && req.url === "/ingest") {
    const raw = await readBody(req);
    try {
      ingestBatch(JSON.parse(raw));
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: true }));
      maybeNotify(db).catch(e => console.error("[afy-notify]", e)); // after flush, rate-limited
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }
  // Review queue: tweets you genuinely dwelled on but haven't signed yet. Built straight from
  // impressions (NOT buildFeed) so we never elicit labels on the ranker's own output — these are
  // the ambiguous-magnitude items whose sign only an explicit verdict can settle.
  if (req.method === "GET" && req.url?.startsWith("/review/queue")) {
    const url = new URL(req.url, "http://localhost");
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50"), 100);
    const rows = db.prepare(`
      SELECT i.tweet_id,
        t.author_handle, t.author_name, t.author_id, t.text, t.media,
        t.created_at, t.likes, t.rts, t.replies, t.views,
        MAX(CASE WHEN i.flicked=0 AND COALESCE(i.scroll_velocity_at_entry,99) < 5
                 THEN MIN(i.dwell_ms, 60000) ELSE 0 END) AS trusted_dwell,
        MAX(i.ts) AS last_seen
      FROM impressions i
      LEFT JOIN tweets t ON t.tweet_id = i.tweet_id
      WHERE i.tweet_id NOT IN (SELECT tweet_id FROM reviews)
      GROUP BY i.tweet_id
      HAVING MAX(i.max_visible_pct) >= 0.5 AND trusted_dwell > 1500
      ORDER BY trusted_dwell DESC
      LIMIT ?
    `).all(limit);
    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({ tweets: rows }));
    return;
  }

  if (req.method === "POST" && req.url === "/review") {
    const raw = await readBody(req);
    try {
      const { tweet_id, verdict, ts } = JSON.parse(raw);
      if (typeof tweet_id !== "string" || (verdict !== 1 && verdict !== -1)) {
        throw new Error("tweet_id (string) and verdict (+1|-1) required");
      }
      stmts.review.run(tweet_id, verdict, ts ?? new Date().toISOString());
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/feed")) {
    const url = new URL(req.url, "http://localhost");
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50"), 200);
    const offset = parseInt(url.searchParams.get("offset") ?? "0");
    const sortMode = url.searchParams.get("sort") ?? "dwell";

    if (sortMode === "ranked") {
      const all = buildFeed(db, 200);
      const page = all.slice(offset, offset + limit);
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ tweets: page, total: all.length, limit, offset }));
      return;
    }

    const order = sortMode === "time"
      ? "last_seen DESC, i.tweet_id DESC"
      : "total_dwell DESC, last_seen DESC, i.tweet_id DESC";
    const rows = db.prepare(`
      SELECT
        i.tweet_id,
        t.author_handle, t.author_name, t.author_id, t.text, t.media,
        t.is_thread, t.created_at, t.likes, t.rts, t.replies, t.views,
        t.captured_at,
        COALESCE(SUM(i.dwell_ms), 0) as total_dwell,
        MAX(i.opened_detail)         as opened,
        MAX(i.liked)                 as liked,
        MAX(i.ts)                    as last_seen
      FROM impressions i
      LEFT JOIN tweets t ON i.tweet_id = t.tweet_id
      GROUP BY i.tweet_id
      ORDER BY ${order}
      LIMIT ? OFFSET ?
    `).all(limit, offset);
    const total = (db.prepare("SELECT COUNT(DISTINCT tweet_id) as n FROM impressions").get() as any).n;
    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({ tweets: rows, total, limit, offset }));
    return;
  }

  const impMatch = req.method === "GET" && req.url?.match(/^\/impressions\/(\d+)$/);
  if (impMatch) {
    const rows = db.prepare(`
      SELECT ts, dwell_ms, flicked, opened_detail, liked, position_in_feed, scroll_velocity_at_entry
      FROM impressions WHERE tweet_id = ? ORDER BY ts ASC
    `).all(impMatch[1]);
    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify(rows));
    return;
  }

  if (req.method === "GET" && (req.url === "/" || req.url === "/client")) {
    const html = fs.readFileSync(path.join(import.meta.dirname, "client.html"));
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
    return;
  }

  res.writeHead(404); res.end();
});

// Types (mirrored from extension/src/types.ts — PRD §6 is source of truth)
interface TweetRecord {
  tweet_id: string; author_handle: string; author_name: string; author_id: string; text: string;
  media: { type: string; url: string }[]; is_thread: boolean; created_at: string;
  metrics: { likes: number; rts: number; replies: number; views?: number };
  captured_at: string;
  source?: "net" | "dom";
}
interface ImpressionEvent {
  impression_id: string; tweet_id: string; session_id: string; ts: string;
  position_in_feed: number; dwell_ms: number; max_visible_pct: number;
  scroll_velocity_at_entry: number; flicked: boolean; opened_detail: boolean;
  profile_expanded: string; liked: boolean; rt: boolean; bookmarked: boolean;
  replied: boolean; reported: boolean; negative_feedback: boolean;
  media_present: boolean; is_thread: boolean; char_len: number;
}
interface CaptureHealthEvent { ts: string; kind: string; detail: string; }

if (process.argv[1] === new URL(import.meta.url).pathname) {
  server.listen(PORT, () => console.log(`[afy-ingest] listening on http://localhost:${PORT}`));
}
