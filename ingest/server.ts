import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildDigest, candidateCount, attachQuoted, parseMedia, isReply, buildAuthorPrior, REPLY_MIN_AUTHOR_LIKES } from "./digest.ts";

const PORT = 2727;
const DB_PATH = process.env.AFY_DB ?? "afy.db";
// PRD §5.8 ingest auth. When AFY_TOKEN is set (.env.local), every WRITE endpoint requires a
// matching x-afy-token header — the extension bakes it in at build (extension/build.sh reads the
// same .env.local). Unset = open, so a token-less extension can't wedge capture before it's
// rebuilt + reloaded. Reads stay open: the client is served same-origin (Mac + phone-on-LAN).
const TOKEN = process.env.AFY_TOKEN ?? "";

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
  -- ui_context (2026-07-15): JSON snapshot of what the judge SAW when voting — surface
  -- ('digest'|'explore'|'review'), rank/pos, shown_score, shown_dwell. The review UI displays
  -- anchoring cues (dwell line, score badge, lane label) correlated with the confounders under
  -- debate; this records them per vote so future analysis can stratify. Observational metadata
  -- ONLY — never a feature, never a label input.
  CREATE TABLE IF NOT EXISTS reviews (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    tweet_id TEXT, verdict INTEGER, ts TEXT, ui_context TEXT
  );
  -- Confirmed positives harvested from your own Likes / Bookmarks timelines. Membership in those
  -- lists IS an explicit endorsement — the strongest, least-biased positive label we have (no dwell,
  -- no propensity correction needed). Append-only; (tweet_id, source) keyed so re-scrolling the tab
  -- doesn't duplicate. ts = when harvested (the original like-time isn't exposed by the API).
  CREATE TABLE IF NOT EXISTS engagement_labels (
    tweet_id TEXT, source TEXT, ts TEXT,
    PRIMARY KEY (tweet_id, source)
  );
  -- Tweets pruned from the POSITIVE set — a stale/unwanted like or bookmark. This is "not a current
  -- positive", NOT a negative: the label pipeline excludes these from positives but must NOT feed them
  -- to the negative class (that's reserved for report/mute/block). Append-only; reason records how it
  -- was pruned ('age' = bulk age cut-off, 'reviewed' = per-tweet drop in the review tool).
  CREATE TABLE IF NOT EXISTS label_prunes (
    tweet_id TEXT PRIMARY KEY, reason TEXT, ts TEXT
  );
  -- M8 LLM rubric scores. An LLM grades each tweet 0–10 against RUBRIC.md (rubric.ts, run by
  -- daily.ts). These are ranking FEATURES, never labels (CLAUDE.md invariant). Append-only, keyed
  -- (tweet_id, rubric_sha): rubric_sha ties a score to the rubric version that produced it, so
  -- editing RUBRIC.md re-scores as new appends rather than mutating rows. rubric.ts owns the same
  -- CREATE IF NOT EXISTS; this copy keeps the server-owned db carrying the table from first boot.
  CREATE TABLE IF NOT EXISTS rubric_scores (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    tweet_id TEXT, score INTEGER, model TEXT, rubric_sha TEXT, ts TEXT
  );
  -- M10 own-feed telemetry, both append-only. digest_log: one row per card per serve — which
  -- tweet ranked where, in which lane, with what mix score/parts, on which channel
  -- ('web'|'imessage'). Score parts are captured AT SERVE TIME because they aren't
  -- reconstructable later (profile/prior/rubric all drift daily). digest_opens: taps in the
  -- reading client. funnel.ts joins these against reviews to answer "are 👎s concentrated at
  -- top ranks / in a lane / on high-author-prior cards?" — and they're the prereq for any
  -- future online ranker comparison (M11 interleaving).
  -- M11 adds arm (nullable): which ranker drafted this taste-lane slot in a team-draft interleave
  -- (digest.ts MATCHUP), NULL when interleaving is off or on explore rows. interleave.ts attributes
  -- opens/votes back to it via the funnel's FIRST_SERVE/VOTE_SERVE joins.
  CREATE TABLE IF NOT EXISTS digest_log (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    digest_date TEXT, channel TEXT, tweet_id TEXT, rank INTEGER, lane TEXT,
    score REAL, parts TEXT, ts TEXT, arm TEXT
  );
  CREATE TABLE IF NOT EXISTS digest_opens (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    tweet_id TEXT, ts TEXT
  );
  -- Candidate-stage ledger. One row per digest build records the exact run instant and the size of
  -- its eligible pool; recall.ts replays eligibility from append-only raw timestamps, avoiding a
  -- prohibitively large candidate×reload event table.
  CREATE TABLE IF NOT EXISTS digest_runs (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    digest_date TEXT, channel TEXT, days INTEGER, limit_n INTEGER, candidate_count INTEGER, ts TEXT
  );
`);

// Additive migrations for DBs created before these columns existed (append-only safe).
try { db.exec("ALTER TABLE tweets ADD COLUMN author_name TEXT"); } catch { /* already present */ }
try { db.exec("ALTER TABLE tweets ADD COLUMN author_avatar TEXT"); } catch { /* already present */ }
try { db.exec("ALTER TABLE tweets ADD COLUMN source TEXT DEFAULT 'net'"); } catch { /* already present */ }
try { db.exec("ALTER TABLE tweets ADD COLUMN quoted_id TEXT"); } catch { /* already present */ }
try { db.exec("ALTER TABLE tweets ADD COLUMN author_profile TEXT"); } catch { /* already present */ }
try { db.exec("ALTER TABLE impressions ADD COLUMN reported INTEGER"); } catch { /* already present */ }
try { db.exec("ALTER TABLE impressions ADD COLUMN negative_feedback INTEGER"); } catch { /* already present */ }
// M11: nullable arm on digest_log for DBs created before the interleave column existed. Existing
// rows get NULL (pre-M11 serves have no drafting arm — correct: they weren't drafted by one).
try { db.exec("ALTER TABLE digest_log ADD COLUMN arm TEXT"); } catch { /* already present */ }
try { db.exec("ALTER TABLE reviews ADD COLUMN ui_context TEXT"); } catch { /* already present */ }

const stmts = {
  tweet: db.prepare(`
    INSERT OR IGNORE INTO tweets
      (tweet_id, author_handle, author_name, author_avatar, author_id, author_profile, text, media, quoted_id, is_thread, created_at,
       likes, rts, replies, views, captured_at, source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `),
  // Precedence-upgrade write (M7). INSERT OR REPLACE swaps the whole row on a tweet_id conflict
  // (it is NOT an in-place edit statement), so the caller MUST pass every column — a partial
  // replace would blank the rest. We only fire this when the incoming source strictly OUTRANKS the
  // stored one (net > dom > poll), so it upgrades a weaker row and never clobbers a stronger one.
  // Append-only intent is preserved: no row is ever edited in place or removed; a higher-fidelity
  // capture supersedes a lower one (the same "net wins over dom" rule that already governed same-
  // batch order, now also across batches and extended with the poll tier). The server.ts append-
  // only grep still holds — REPLACE is neither of the two forbidden mutation keywords.
  tweetUpgrade: db.prepare(`
    INSERT OR REPLACE INTO tweets
      (tweet_id, author_handle, author_name, author_avatar, author_id, author_profile, text, media, quoted_id, is_thread, created_at,
       likes, rts, replies, views, captured_at, source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
    `INSERT INTO reviews (tweet_id, verdict, ts, ui_context) VALUES (?,?,?,?)`
  ),
  engLabel: db.prepare(
    `INSERT OR IGNORE INTO engagement_labels (tweet_id, source, ts) VALUES (?,?,?)`
  ),
  prune: db.prepare(
    `INSERT OR IGNORE INTO label_prunes (tweet_id, reason, ts) VALUES (?,?,?)`
  ),
  // Read the stored source (if any) to decide whether an incoming tweet outranks it (see below).
  tweetSource: db.prepare(`SELECT source, length(text) AS len, author_profile FROM tweets WHERE tweet_id = ?`),
  digestLog: db.prepare(
    `INSERT INTO digest_log (digest_date, channel, tweet_id, rank, lane, score, parts, ts, arm) VALUES (?,?,?,?,?,?,?,?,?)`
  ),
  digestOpen: db.prepare(
    `INSERT INTO digest_opens (tweet_id, ts) VALUES (?,?)`
  ),
  digestRun: db.prepare(
    `INSERT INTO digest_runs (digest_date, channel, days, limit_n, candidate_count, ts) VALUES (?,?,?,?,?,?)`
  ),
};

// M10: append the served slate. Telemetry must never take down the product — a logging failure
// is loud but the digest still serves. Every serve logs (page reloads included); funnel.ts
// dedupes to first-serve per tweet at analysis time, append-only stays simple here.
function logDigest(
  items: { tweet_id: string; lane: string; score: number; parts: unknown; arm?: string | null }[],
  { channel, days, limit, candidateCount, ts }: { channel: "web" | "imessage"; days: number; limit: number; candidateCount: number; ts: string },
) {
  db.prepare("BEGIN").run();
  try {
    stmts.digestRun.run(ts.slice(0, 10), channel, days, limit, candidateCount, ts);
    items.forEach((it, i) =>
      stmts.digestLog.run(ts.slice(0, 10), channel, it.tweet_id, i + 1, it.lane, it.score, JSON.stringify(it.parts), ts, it.arm ?? null));
    db.prepare("COMMIT").run();
  } catch (e) {
    db.prepare("ROLLBACK").run();
    console.error("[afy-ingest] digest telemetry write failed (serve continues):", e);
  }
}

// Capture-fidelity precedence: net (GraphQL, rich) > dom (article scrape) > poll (M7 background
// poller tab — candidate only, never behaviorally observed). Higher rank wins at upsert: an organic
// capture upgrades a polled row (source AND any richer fields), poll never overwrites net/dom. A
// tweet with NO source is treated as 'net' — preserving pre-M7 default behavior exactly.
function sourceRank(source: string | undefined): number {
  if (source === "dom") return 1;
  if (source === "poll") return 0;
  return 2; // "net" or unset — the default, richest tier
}
function normalizeSource(source: string | undefined): "net" | "dom" | "poll" {
  return source === "dom" ? "dom" : source === "poll" ? "poll" : "net";
}

function ingestBatch(body: {
  tweets?: TweetRecord[];
  impressions?: ImpressionEvent[];
  health?: CaptureHealthEvent[];
  confirmed?: { source: "like" | "bookmark"; ids: string[] }[];
}) {
  const run = db.prepare("BEGIN");
  run.run();
  try {
    // Write weakest→strongest within a batch (poll < dom < net) so that when the same id appears at
    // multiple fidelities in ONE batch, the strongest lands last and its upgrade REPLACEs the rest.
    // Cross-batch, we compare the incoming source against the row already stored and only upgrade
    // when it strictly outranks it — so an organic net/dom capture supersedes an earlier poll (and
    // net still supersedes an earlier dom, closing the gap the old ponytail note flagged), while a
    // later poll NEVER clobbers an existing net/dom row. Content is never mutated in place: a lower-
    // fidelity row is superseded wholesale by a higher-fidelity capture, never edited.
    const tweets = [...(body.tweets ?? [])].sort(
      (a, b) => sourceRank(a.source) - sourceRank(b.source),
    );
    for (const t of tweets) {
      const incomingRank = sourceRank(t.source);
      const stored = stmts.tweetSource.get(t.tweet_id) as { source?: string; len?: number; author_profile?: string | null } | undefined;
      // Absent row → plain insert (IGNORE is a no-op only if a concurrent write beat us). Present but
      // weaker → upgrade via REPLACE. Present and same-or-stronger → IGNORE leaves it untouched.
      // Equal source + strictly longer text also upgrades: a note_tweet-aware capture superseding a
      // pre-fix truncated row is a fidelity gain at the same tier (heals rows captured before the
      // long-form fix); shorter/equal text at the same tier never replaces, so no downgrade path.
      const upgrade = stored !== undefined &&
        (incomingRank > sourceRank(stored.source) ||
          (incomingRank === sourceRank(stored.source) && (t.text?.length ?? 0) > (stored.len ?? 0)));
      const stmt = upgrade ? stmts.tweetUpgrade : stmts.tweet;
      stmt.run(
        t.tweet_id, t.author_handle, t.author_name ?? "", t.author_avatar ?? "", t.author_id,
        // On upgrade, an incoming capture without a profile (older extension build) keeps the
        // stored one — REPLACE swaps the whole row, so we must carry it forward explicitly.
        t.author_profile ? JSON.stringify(t.author_profile) : stored?.author_profile ?? null,
        t.text,
        JSON.stringify(t.media ?? []), t.quoted_id ?? null, t.is_thread ? 1 : 0, t.created_at,
        t.metrics.likes, t.metrics.rts, t.metrics.replies, t.metrics.views ?? null,
        t.captured_at, normalizeSource(t.source),
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
    // Health is a DIAGNOSTIC stream — it must never take down behavior/content writes (PRD §5.1
    // independent failure boundaries). Coerce every field to a bindable type (the injected hook
    // emitted capture_health without a `ts`, whose undefined can't bind and rolled back the whole
    // batch) and guard per-row so a malformed event is skipped, not fatal.
    for (const h of body.health ?? []) {
      try {
        stmts.health.run(
          String(h.ts ?? new Date().toISOString()),
          String(h.kind ?? "unknown"),
          typeof h.detail === "string" ? h.detail : JSON.stringify(h.detail ?? null),
        );
      } catch (e) { console.error("[afy-ingest] skipped bad health row:", e); }
    }
    const harvestedAt = new Date().toISOString();
    for (const c of body.confirmed ?? []) {
      for (const id of c.ids ?? []) stmts.engLabel.run(id, c.source, harvestedAt);
    }
    db.prepare("COMMIT").run();
  } catch (e) {
    db.prepare("ROLLBACK").run();
    throw e;
  }
}

// No CORS headers anywhere, deliberately: the extension's service worker fetch is CORS-exempt via
// manifest host_permissions, and the reading client is served same-origin — so a cross-origin
// reader can only be someone else's webpage. Denying it the headers is the whole point.
function authed(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (!TOKEN || req.headers["x-afy-token"] === TOKEN) return true;
  console.error(`[afy-ingest] 401 ${req.method} ${req.url} — x-afy-token missing/wrong (extension rebuilt + reloaded since the token was set?)`);
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "bad or missing x-afy-token" }));
  return false;
}

// ---- avatar cache ----
// Fetch each handle's real X profile photo from unavatar ONCE, cache to disk, serve locally. The
// browser hits same-origin /avatar/<handle> (no third-party rate limit on the client — unavatar
// limits per-IP and a 50-avatar page would trip it); repeat loads (screenshots) are instant from
// disk. Throttled to 3 concurrent upstream fetches; misses are cached too so we don't re-hammer.
const AV_DIR = ".avatars";
fs.mkdirSync(AV_DIR, { recursive: true });
let avInFlight = 0;
const avWaiters: (() => void)[] = [];
function avAcquire(): Promise<void> {
  return new Promise(res => { if (avInFlight < 3) { avInFlight++; res(); } else avWaiters.push(res); });
}
function avRelease() { avInFlight--; const next = avWaiters.shift(); if (next) { avInFlight++; next(); } }

async function serveAvatar(handle: string, res: http.ServerResponse) {
  const hit = path.join(AV_DIR, handle + ".img");
  const miss = path.join(AV_DIR, handle + ".miss");
  if (fs.existsSync(hit)) {
    res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "max-age=604800" });
    fs.createReadStream(hit).pipe(res); return;
  }
  if (fs.existsSync(miss)) { res.writeHead(404); res.end(); return; }
  // Prefer X's OWN avatar URL captured from GraphQL (pbs.twimg.com — no rate limit). Any one
  // avatar-bearing tweet from this author gives us the URL for all their tweets. _normal is 48px;
  // bump to 400x400 for a crisp render. Fall back to unavatar only if we've never captured one.
  const stored = (db.prepare(
    `SELECT author_avatar AS a FROM tweets WHERE author_handle = ? AND author_avatar IS NOT NULL
       AND author_avatar != '' ORDER BY captured_at DESC LIMIT 1`,
  ).get(handle) as { a: string } | undefined)?.a;
  const url = stored
    ? stored.replace(/_normal\.(jpg|jpeg|png|webp|gif)/i, "_400x400.$1")
    : `https://unavatar.io/x/${handle}`;

  await avAcquire();
  try {
    const r = await fetch(url);
    if (r.ok) {
      const buf = Buffer.from(await r.arrayBuffer());
      fs.writeFileSync(hit, buf);
      res.writeHead(200, { "Content-Type": r.headers.get("content-type") ?? "image/jpeg", "Cache-Control": "max-age=604800" });
      res.end(buf);
    } else {
      if (r.status === 404) fs.writeFileSync(miss, ""); // only negative-cache genuine misses, NOT 429/5xx
      res.writeHead(404); res.end();
    }
  } catch {
    res.writeHead(502); res.end(); // transient — don't negative-cache, let it retry next load
  } finally { avRelease(); }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise(resolve => { let s = ""; req.on("data", c => s += c); req.on("end", () => resolve(s)); });
}

export const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url ?? "/", "http://localhost");
  const isRemote = Boolean(req.headers["cf-connecting-ip"]);

  // ---- remote read gate (Cloudflare Tunnel) ----
  // Local traffic (extension SW, launchd scripts) hits localhost directly and never carries
  // cf-connecting-ip; everything arriving through the tunnel does. Remote readers present
  // AFY_TOKEN once (?key=…); a year-long HttpOnly cookie unlocks after that. Personal data —
  // dwell, taste profile — must never be readable by whoever guesses the hostname.
  // ponytail: one shared secret + cookie; upgrade to Cloudflare Access if it ever leaks.
  if (isRemote && TOKEN) {
    if (requestUrl.searchParams.get("key") === TOKEN) {
      res.writeHead(302, {
        "Set-Cookie": `afy=${TOKEN}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=31536000`,
        "Location": requestUrl.pathname === "/" ? "/client" : requestUrl.pathname,
      });
      res.end();
      return;
    }
  }

  // The deployment homepage is intentionally public, but only through the tunnel. Local `/`
  // remains the private reader so the extension and machine-local workflows do not change.
  if (isRemote && req.method === "GET" && requestUrl.pathname === "/") {
    const html = fs.readFileSync(path.join(import.meta.dirname, "landing.html"), "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" });
    res.end(html);
    return;
  }

  // This screenshot contains no feed history beyond the already-public project example.
  if (req.method === "GET" && requestUrl.pathname === "/landing-reader.png") {
    const image = fs.readFileSync(path.join(import.meta.dirname, "../docs/reader.png"));
    res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=604800" });
    res.end(image);
    return;
  }

  if (isRemote && TOKEN) {
    const cookieOk = (req.headers.cookie ?? "").split(/;\s*/).includes(`afy=${TOKEN}`);
    if (!cookieOk && req.headers["x-afy-token"] !== TOKEN) {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("unauthorized");
      return;
    }
  }

  if (req.method === "GET" && req.url === "/status") {
    const one = (sql: string) => (db.prepare(sql).get() as any).n;
    // Freshness: answers "is capture alive RIGHT NOW?". Scroll x.com and watch last_impression go
    // fresh + impressions_last_hour climb — that's the live signal /status's lifetime totals lack.
    const lastImpression = (db.prepare("SELECT MAX(ts) as t FROM impressions").get() as any).t as string | null;
    const minutesSince = lastImpression
      ? Math.round((Date.now() - Date.parse(lastImpression)) / 60000) : null;
    const counts = {
      tweets: one("SELECT COUNT(*) as n FROM tweets"),
      impressions: one("SELECT COUNT(*) as n FROM impressions"),
      health: one("SELECT COUNT(*) as n FROM capture_health"),
      likes: one("SELECT COUNT(*) as n FROM engagement_labels WHERE source='like'"),
      bookmarks: one("SELECT COUNT(*) as n FROM engagement_labels WHERE source='bookmark'"),
      pruned: one("SELECT COUNT(*) as n FROM label_prunes"),
      // --- live capture health ---
      last_impression: lastImpression,
      minutes_since_last_impression: minutesSince,
      capture_live: minutesSince !== null && minutesSince <= 10, // arriving within last 10 min
      impressions_last_hour: one("SELECT COUNT(*) as n FROM impressions WHERE datetime(ts) > datetime('now','-1 hour')"),
      impressions_today: one("SELECT COUNT(*) as n FROM impressions WHERE date(ts) = date('now')"),
      last_net_tweet: (db.prepare("SELECT MAX(captured_at) as t FROM tweets WHERE source='net'").get() as any).t,
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(counts));
    return;
  }

  if (req.method === "POST" && req.url === "/ingest") {
    if (!authed(req, res)) return;
    const raw = await readBody(req);
    try {
      const body = JSON.parse(raw);
      console.log(`[afy-ingest] POST /ingest  impressions=${body.impressions?.length ?? 0} tweets=${body.tweets?.length ?? 0} health=${body.health?.length ?? 0}`);
      ingestBatch(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      console.error("[afy-ingest] WRITE FAILED:", e); // surfaces the throw that wedges the retry loop
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }
  // Review queue: tweets you genuinely dwelled on but haven't signed yet. Built straight from
  // impressions (never from a ranker's output) so we never elicit labels on what we ranked — these
  // are the ambiguous-magnitude items whose sign only an explicit verdict can settle.
  if (req.method === "GET" && req.url?.startsWith("/review/queue")) {
    const url = new URL(req.url, "http://localhost");
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50"), 200);
    const rows = db.prepare(`
      SELECT i.tweet_id,
        t.author_handle, t.author_name, t.author_id, t.author_profile, t.text, t.media, t.quoted_id,
        t.created_at, t.likes, t.rts, t.replies, t.views,
        -- dwell_ms=30000 is exactly MAX_INTERVAL_MS: a leaked timer clamped at the cap (dropped
        -- IntersectionObserver exit under virtualized scroll), not a real read. Untrusted here.
        -- Root fix is the extension geometry watchdog; this drops the historical sentinel rows.
        MAX(CASE WHEN i.flicked=0 AND COALESCE(i.scroll_velocity_at_entry,99) < 5 AND i.dwell_ms <> 30000
                 THEN MIN(i.dwell_ms, 60000) ELSE 0 END) AS trusted_dwell,
        MAX(i.ts) AS last_seen
      FROM impressions i
      LEFT JOIN tweets t ON t.tweet_id = i.tweet_id
      WHERE i.tweet_id NOT IN (SELECT tweet_id FROM reviews)
      GROUP BY i.tweet_id
      HAVING MAX(i.max_visible_pct) >= 0.5 AND trusted_dwell > 1500
      ORDER BY trusted_dwell DESC
      LIMIT ?
    `).all(limit * 4);
    // Format policy (user directive 2026-07-13), same rule as the digest: replies earn a review
    // slot only from high-like-prior authors. Reading a conversation racks up dwell on every
    // reply, so without this the dwell-sorted queue is ~27% engagement-farm replies. Over-fetch
    // 4x then cut — the queue backlog is thousands deep, it will fill.
    const prior = buildAuthorPrior(db);
    const kept = (rows as any[])
      .filter(r => !isReply(r.text ?? "") || (prior.get(r.author_id ?? "") ?? 0) >= Math.log1p(REPLY_MIN_AUTHOR_LIKES))
      .slice(0, limit);
    // Same inline context as the digest: parsed media + resolved quoted tweet (review mode has
    // the identical "can't judge without clicking through" friction).
    const enriched = attachQuoted(db, kept).map(({ quoted_id: _q, ...r }: any) =>
      ({ ...r, media: parseMedia(r.media) }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ tweets: enriched }));
    return;
  }

  if (req.method === "POST" && req.url === "/review") {
    if (!authed(req, res)) return;
    const raw = await readBody(req);
    try {
      const { tweet_id, verdict, ts, ui_context } = JSON.parse(raw);
      if (typeof tweet_id !== "string" || (verdict !== 1 && verdict !== -1)) {
        throw new Error("tweet_id (string) and verdict (+1|-1) required");
      }
      stmts.review.run(tweet_id, verdict, ts ?? new Date().toISOString(),
        ui_context && typeof ui_context === "object" ? JSON.stringify(ui_context) : null);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  // Prune a tweet from the positive set (used by the like-review tool's "drop" + the bulk age cut).
  if (req.method === "POST" && req.url === "/prune") {
    if (!authed(req, res)) return;
    const raw = await readBody(req);
    try {
      const { tweet_id, reason } = JSON.parse(raw);
      if (typeof tweet_id !== "string") throw new Error("tweet_id (string) required");
      stmts.prune.run(tweet_id, reason ?? "reviewed", new Date().toISOString());
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  // Review queue for harvested likes: ids not yet pruned and not yet kept. The review page renders
  // each via X's embed widget (we only stored ids), so this returns ids + nothing else. Newest first.
  if (req.method === "GET" && req.url?.startsWith("/prune/queue")) {
    const url = new URL(req.url, "http://localhost");
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50"), 200);
    const rows = db.prepare(`
      SELECT tweet_id FROM engagement_labels
      WHERE source = 'like'
        AND tweet_id NOT IN (SELECT tweet_id FROM label_prunes)
        AND tweet_id NOT IN (SELECT tweet_id FROM reviews WHERE verdict = 1)
      ORDER BY tweet_id DESC
      LIMIT ?
    `).all(limit) as { tweet_id: string }[];
    const remaining = (db.prepare(`
      SELECT COUNT(*) n FROM engagement_labels
      WHERE source='like' AND tweet_id NOT IN (SELECT tweet_id FROM label_prunes)
        AND tweet_id NOT IN (SELECT tweet_id FROM reviews WHERE verdict=1)
    `).get() as any).n;
    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({ ids: rows.map(r => r.tweet_id), remaining }));
    return;
  }

  const avMatch = req.method === "GET" && req.url?.match(/^\/avatar\/([A-Za-z0-9_]{1,20})$/);
  if (avMatch) { await serveAvatar(avMatch[1], res); return; }

  // The review/prune pages POST hand-signed labels — the gold labels the whole eval rests on — so
  // they carry the same write token as the extension. The server injects it at serve time: anyone
  // who can load the page same-origin could read it, but a cross-origin page can't (no CORS), and
  // drive-by label poisoning is exactly what the token exists to stop.
  const serveHtml = (file: string) => {
    const html = fs.readFileSync(path.join(import.meta.dirname, file), "utf8").replace("__AFY_TOKEN__", TOKEN);
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
  };

  // Personalized AI digest: corpus ranked by similarity to your likes (digest.ts). ?days=N limits
  // by AUTHORED age (tweets.created_at, 0 = all) — not capture age; see buildDigest. The product
  // surface.
  // M10 open receipts from the reading client (fire-and-forget in openTweet, same pattern as
  // votes). Token-authed like every write. Opens on never-served tweets (review mode, quoted
  // cards) land here too — harmless, funnel.ts joins through digest_log so strays don't count.
  if (req.method === "POST" && req.url === "/digest/open") {
    if (!authed(req, res)) return;
    const raw = await readBody(req);
    try {
      const { tweet_id, ts } = JSON.parse(raw);
      if (typeof tweet_id !== "string" || !tweet_id) throw new Error("tweet_id (string) required");
      stmts.digestOpen.run(tweet_id, ts ?? new Date().toISOString());
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/digest")) {
    const url = new URL(req.url, "http://localhost");
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50"), 200);
    const days = parseInt(url.searchParams.get("days") ?? "0");
    // daily.ts tags its teaser fetch ?channel=imessage — that one-card serve IS the iMessage
    // send list, so it logs under its real channel. Everything else is the web client.
    const channel = url.searchParams.get("channel") === "imessage" ? "imessage" : "web";
    const now = new Date();
    const nowMs = now.getTime();
    const items = buildDigest(db, { limit, days, nowMs });
    logDigest(items, { channel, days, limit, candidateCount: candidateCount(db, { days, nowMs }), ts: now.toISOString() });
    const profileSize = (db.prepare(`
      SELECT COUNT(DISTINCT e.tweet_id) AS n FROM engagement_labels e JOIN tweets t ON e.tweet_id = t.tweet_id
      WHERE e.tweet_id NOT IN (SELECT tweet_id FROM label_prunes)
        AND e.tweet_id NOT IN (SELECT tweet_id FROM reviews) -- mirror buildTaste: leak guard + tweet-set dedupe
        AND t.text IS NOT NULL AND t.text != ''
    `).get() as any).n;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ items, count: items.length, profile_size: profileSize }));
    return;
  }

  const page = req.url?.split("?")[0]; // html routes ignore the query string (?n=200 etc.)
  if (req.method === "GET" && (page === "/" || page === "/client")) { serveHtml("client.html"); return; }
  if (req.method === "GET" && page === "/prune") { serveHtml("prune.html"); return; }

  res.writeHead(404); res.end();
});

// Types (mirrored from extension/src/types.ts — PRD §6 is source of truth)
interface TweetRecord {
  tweet_id: string; author_handle: string; author_name: string; author_id: string; text: string;
  author_profile?: object; // stored opaquely as JSON (badges + hover card); UI-only
  media: { type: string; url: string }[]; is_thread: boolean; created_at: string;
  metrics: { likes: number; rts: number; replies: number; views?: number };
  captured_at: string;
  source?: "net" | "dom" | "poll";
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
