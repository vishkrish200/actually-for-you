// Run with: node --experimental-strip-types server.test.ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";

process.env.AFY_DB = ":memory:";

const { db, server } = await import("./server.ts");

const PORT = 12727;

function post(body: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ port: PORT, path: "/ingest", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
    }, res => {
      let raw = "";
      res.on("data", c => { raw += c; });
      res.on("end", () => resolve({ status: res.statusCode!, json: JSON.parse(raw) }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

before(() => new Promise<void>(r => server.listen(PORT, r)));
after(() => new Promise<void>(r => server.close(r)));

const tweet = {
  tweet_id: "t1", author_handle: "user", author_id: "u1", text: "hello",
  media: [], is_thread: false, created_at: "2026-01-01T00:00:00Z",
  metrics: { likes: 1, rts: 0, replies: 0 }, captured_at: "2026-01-01T00:00:01Z",
};

const impression = {
  impression_id: "imp-1", tweet_id: "t1", session_id: "s1",
  ts: "2026-01-01T00:00:00Z", position_in_feed: 0, dwell_ms: 1500,
  max_visible_pct: 0.9, scroll_velocity_at_entry: 0.5, flicked: false,
  opened_detail: false, profile_expanded: "none",
  liked: false, rt: false, bookmarked: false, replied: false,
  media_present: false, is_thread: false, char_len: 5,
};

describe("ingest server", () => {
  it("persists tweets and impressions", async () => {
    const res = await post({ tweets: [tweet], impressions: [impression] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true });
    const tCount = (db.prepare("SELECT COUNT(*) as n FROM tweets").get() as any).n;
    const iCount = (db.prepare("SELECT COUNT(*) as n FROM impressions").get() as any).n;
    assert.equal(tCount, 1);
    assert.equal(iCount, 1);
  });

  it("idempotent: same impression_id twice → 1 row", async () => {
    await post({ impressions: [impression] });
    const n = (db.prepare("SELECT COUNT(*) as n FROM impressions").get() as any).n;
    assert.equal(n, 1);
  });

  it("idempotent: same tweet_id twice → 1 row", async () => {
    await post({ tweets: [tweet] });
    const n = (db.prepare("SELECT COUNT(*) as n FROM tweets").get() as any).n;
    assert.equal(n, 1);
  });

  it("DOM content fills a gap the network never captured", async () => {
    const dom = { ...tweet, tweet_id: "dom1", text: "scraped", source: "dom",
      metrics: { likes: 0, rts: 0, replies: 0 } };
    await post({ tweets: [dom] });
    const row = db.prepare("SELECT text, source FROM tweets WHERE tweet_id='dom1'").get() as any;
    assert.equal(row.text, "scraped");
    assert.equal(row.source, "dom");
  });

  it("network record wins over a DOM record in the same batch, regardless of order", async () => {
    const net = { ...tweet, tweet_id: "race1", text: "net-rich", source: "net",
      metrics: { likes: 42, rts: 0, replies: 0 } };
    const dom = { ...tweet, tweet_id: "race1", text: "dom-poor", source: "dom",
      metrics: { likes: 0, rts: 0, replies: 0 } };
    // DOM listed FIRST in the array — ingest must still let the net record win.
    await post({ tweets: [dom, net] });
    const row = db.prepare("SELECT text, likes, source FROM tweets WHERE tweet_id='race1'").get() as any;
    assert.equal(row.text, "net-rich");
    assert.equal(row.likes, 42);
    assert.equal(row.source, "net");
  });

  it("a later DOM batch does not clobber an existing network row", async () => {
    const net = { ...tweet, tweet_id: "keep1", text: "net-rich", source: "net" };
    await post({ tweets: [net] });
    const dom = { ...tweet, tweet_id: "keep1", text: "dom-poor", source: "dom" };
    await post({ tweets: [dom] });
    const row = db.prepare("SELECT text, source FROM tweets WHERE tweet_id='keep1'").get() as any;
    assert.equal(row.text, "net-rich");
    assert.equal(row.source, "net");
  });

  // ---- M7: source:'poll' (background poller tab candidates) precedence ----
  // Precedence at upsert is net > dom > poll: a polled row is a candidate only and must be
  // upgradable by any later organic capture, but must never itself overwrite a net/dom row.

  it("M7: a tweet arriving with source 'poll' stores 'poll'", async () => {
    const poll = { ...tweet, tweet_id: "poll1", text: "polled", source: "poll" };
    await post({ tweets: [poll] });
    const row = db.prepare("SELECT text, source FROM tweets WHERE tweet_id='poll1'").get() as any;
    assert.equal(row.text, "polled");
    assert.equal(row.source, "poll");
  });

  it("M7: 'poll' arriving after an existing 'net' row leaves source AND content intact", async () => {
    const net = { ...tweet, tweet_id: "np1", text: "net-organic", source: "net",
      metrics: { likes: 7, rts: 0, replies: 0 } };
    await post({ tweets: [net] });
    // A later poll of the same id must be a no-op — it never saw the user, it can't downgrade truth.
    const poll = { ...tweet, tweet_id: "np1", text: "poll-stale", source: "poll",
      metrics: { likes: 0, rts: 0, replies: 0 } };
    await post({ tweets: [poll] });
    const row = db.prepare("SELECT text, likes, source FROM tweets WHERE tweet_id='np1'").get() as any;
    assert.equal(row.text, "net-organic");
    assert.equal(row.likes, 7);
    assert.equal(row.source, "net");
  });

  it("M7: 'net' arriving after a 'poll' row upgrades source AND content", async () => {
    const poll = { ...tweet, tweet_id: "pn1", text: "poll-thin", source: "poll",
      metrics: { likes: 0, rts: 0, replies: 0 } };
    await post({ tweets: [poll] });
    const net = { ...tweet, tweet_id: "pn1", text: "net-rich", source: "net",
      metrics: { likes: 99, rts: 0, replies: 0 } };
    await post({ tweets: [net] });
    const row = db.prepare("SELECT text, likes, source FROM tweets WHERE tweet_id='pn1'").get() as any;
    assert.equal(row.text, "net-rich");
    assert.equal(row.likes, 99);
    assert.equal(row.source, "net"); // organic capture upgraded the polled candidate
  });

  it("M7: 'dom' arriving after a 'poll' row upgrades it (net > dom > poll)", async () => {
    const poll = { ...tweet, tweet_id: "pd1", text: "poll-thin", source: "poll" };
    await post({ tweets: [poll] });
    const dom = { ...tweet, tweet_id: "pd1", text: "dom-scraped", source: "dom" };
    await post({ tweets: [dom] });
    const row = db.prepare("SELECT text, source FROM tweets WHERE tweet_id='pd1'").get() as any;
    assert.equal(row.text, "dom-scraped");
    assert.equal(row.source, "dom");
  });

  it("same source + longer text upgrades (heals pre-note_tweet truncated rows)", async () => {
    const short = { ...tweet, tweet_id: "lf1", text: "truncated at a", source: "net" };
    await post({ tweets: [short] });
    const long = { ...tweet, tweet_id: "lf1", text: "truncated at a $10B valuation — the full note_tweet text", source: "net" };
    await post({ tweets: [long] });
    const row = db.prepare("SELECT text, source FROM tweets WHERE tweet_id='lf1'").get() as any;
    assert.equal(row.text, long.text);
    assert.equal(row.source, "net");
  });

  it("same source + shorter/equal text does NOT replace", async () => {
    const long = { ...tweet, tweet_id: "lf2", text: "the full long-form text of the tweet", source: "net" };
    await post({ tweets: [long] });
    await post({ tweets: [{ ...tweet, tweet_id: "lf2", text: "shorter", source: "net" }] });
    await post({ tweets: [{ ...tweet, tweet_id: "lf2", text: "x".repeat(long.text.length), source: "net" }] });
    const row = db.prepare("SELECT text FROM tweets WHERE tweet_id='lf2'").get() as any;
    assert.equal(row.text, long.text);
  });

  it("author_profile persists as JSON and survives an upgrade from a profile-less capture", async () => {
    const profile = { verified: true, verified_type: "Business", bio: "hi", followers: 9, following: 2 };
    await post({ tweets: [{ ...tweet, tweet_id: "ap1", text: "short", source: "net", author_profile: profile }] });
    let row = db.prepare("SELECT author_profile FROM tweets WHERE tweet_id='ap1'").get() as any;
    assert.deepEqual(JSON.parse(row.author_profile), profile);
    // longer-text upgrade from an older extension build (no author_profile) keeps the stored one
    await post({ tweets: [{ ...tweet, tweet_id: "ap1", text: "much longer replacement text", source: "net" }] });
    row = db.prepare("SELECT text, author_profile FROM tweets WHERE tweet_id='ap1'").get() as any;
    assert.equal(row.text, "much longer replacement text");
    assert.deepEqual(JSON.parse(row.author_profile), profile);
  });

  it("longer text at a WEAKER source still loses (poll never clobbers net)", async () => {
    const net = { ...tweet, tweet_id: "lf3", text: "net short", source: "net" };
    await post({ tweets: [net] });
    await post({ tweets: [{ ...tweet, tweet_id: "lf3", text: "a much much longer polled version of the text", source: "poll" }] });
    const row = db.prepare("SELECT text, source FROM tweets WHERE tweet_id='lf3'").get() as any;
    assert.equal(row.text, "net short");
    assert.equal(row.source, "net");
  });

  it("M7 regression: a tweet with NO source still defaults to 'net'", async () => {
    // The `tweet` fixture carries no source field — must behave exactly as pre-M7.
    const bare = { ...tweet, tweet_id: "bare1", text: "no-source" };
    await post({ tweets: [bare] });
    const row = db.prepare("SELECT source FROM tweets WHERE tweet_id='bare1'").get() as any;
    assert.equal(row.source, "net");
  });

  it("persists quoted_id so the digest can join quote context back in", async () => {
    await post({ tweets: [
      { ...tweet, tweet_id: "qt-orig", text: "the original" },
      { ...tweet, tweet_id: "qt-ing", text: "quoting it", quoted_id: "qt-orig" },
    ] });
    const rows = (db.prepare("SELECT tweet_id, quoted_id FROM tweets WHERE tweet_id LIKE 'qt-%' ORDER BY tweet_id").all() as any[])
      .map(r => ({ ...r })); // node:sqlite rows are null-prototype — normalize for deepEqual
    assert.deepEqual(rows, [
      { tweet_id: "qt-ing", quoted_id: "qt-orig" },
      { tweet_id: "qt-orig", quoted_id: null }, // absent field binds NULL, not ""
    ]);
  });

  it("harvests confirmed positives from Likes/Bookmarks into engagement_labels", async () => {
    await post({ confirmed: [
      { source: "like", ids: ["lk1", "lk2"] },
      { source: "bookmark", ids: ["bm1"] },
    ]});
    const likes = (db.prepare("SELECT COUNT(*) n FROM engagement_labels WHERE source='like'").get() as any).n;
    const bms = (db.prepare("SELECT COUNT(*) n FROM engagement_labels WHERE source='bookmark'").get() as any).n;
    assert.equal(likes, 2);
    assert.equal(bms, 1);
  });

  it("re-scrolling the Likes tab doesn't duplicate a label (idempotent on tweet_id+source)", async () => {
    await post({ confirmed: [{ source: "like", ids: ["lk1", "lk1", "lk3"] }] });
    const n = (db.prepare("SELECT COUNT(*) n FROM engagement_labels WHERE source='like'").get() as any).n;
    assert.equal(n, 3); // lk1 (already present, deduped), lk2 (prior test), lk3 — not 4+
  });

  it("same tweet can be both liked AND bookmarked (distinct rows)", async () => {
    await post({ confirmed: [{ source: "like", ids: ["both1"] }, { source: "bookmark", ids: ["both1"] }] });
    const n = (db.prepare("SELECT COUNT(*) n FROM engagement_labels WHERE tweet_id='both1'").get() as any).n;
    assert.equal(n, 2);
  });

  it("append-only: no UPDATE or DELETE in server.ts", () => {
    const src = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
    assert.ok(!(/\bUPDATE\b/i).test(src), "found UPDATE in server.ts");
    assert.ok(!(/\bDELETE\b/i).test(src), "found DELETE in server.ts");
  });

  it("persists capture_health events", async () => {
    await post({ health: [{ ts: "2026-01-01T00:00:00Z", kind: "hook_error", detail: "test" }] });
    const n = (db.prepare("SELECT COUNT(*) as n FROM capture_health").get() as any).n;
    assert.equal(n, 1);
  });
});

// ---- M10: own-feed telemetry (digest_log serves + digest_opens receipts) ----
function req(method: string, urlPath: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? "" : JSON.stringify(body);
    const r = http.request({ port: PORT, path: urlPath, method,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    }, res => {
      let raw = "";
      res.on("data", c => { raw += c; });
      res.on("end", () => resolve({ status: res.statusCode!, json: raw ? JSON.parse(raw) : null }));
    });
    r.on("error", reject);
    r.end(data);
  });
}

describe("M10 digest telemetry", () => {
  it("GET /digest appends one digest_log row per served card, ranks from 1", async () => {
    // A candidate that clears the ≥4-token fragment filter AND was organically seen (impression),
    // so it's digest-eligible and the digest serves something.
    await post({
      tweets: [{ ...tweet, tweet_id: "m10-c", text: "telemetry candidate tweet with plenty of tokens" }],
      impressions: [{ ...impression, impression_id: "imp-m10-c", tweet_id: "m10-c" }],
    });
    const beforeRuns = (db.prepare("SELECT COALESCE(MAX(rowid),0) n FROM digest_runs").get() as any).n;
    const { status, json } = await req("GET", "/digest?limit=10");
    assert.equal(status, 200);
    assert.ok(json.items.length >= 1, "digest served at least one card");
    const rows = db.prepare("SELECT * FROM digest_log ORDER BY rank").all() as any[];
    assert.equal(rows.length, json.items.length, "one log row per served card");
    assert.equal(rows[0].rank, 1);
    assert.equal(rows[0].channel, "web");
    assert.equal(rows[0].tweet_id, json.items[0].tweet_id);
    assert.ok(rows[0].lane === "taste" || rows[0].lane === "explore");
    assert.equal(rows[0].digest_date, new Date().toISOString().slice(0, 10));
    // mix parts captured at serve time — the not-reconstructable-later half of the log
    assert.deepEqual(Object.keys(JSON.parse(rows[0].parts)).sort(), ["author", "rubric", "taste"]);
    const runs = db.prepare("SELECT channel, days, limit_n, candidate_count, ts FROM digest_runs WHERE rowid > ?").all(beforeRuns) as any[];
    assert.equal(runs.length, 1, "one compact candidate-stage ledger row per digest build");
    assert.deepEqual({ ...runs[0], ts: Boolean(runs[0].ts) }, {
      channel: "web", days: 0, limit_n: 10, candidate_count: runs[0].candidate_count, ts: true,
    });
    assert.ok(runs[0].candidate_count >= json.items.length, "pool count is pre-selection, so it covers the served slate");
  });

  it("?channel=imessage (daily.ts teaser) logs under its real channel", async () => {
    const before = (db.prepare("SELECT COALESCE(MAX(rowid),0) n FROM digest_log").get() as any).n;
    await req("GET", "/digest?limit=1&channel=imessage");
    const rows = db.prepare("SELECT channel FROM digest_log WHERE rowid > ?").all(before) as any[];
    assert.ok(rows.length >= 1);
    assert.ok(rows.every(r => r.channel === "imessage"));
  });

  it("POST /digest/open appends an open receipt", async () => {
    const { status } = await req("POST", "/digest/open", { tweet_id: "m10-c" });
    assert.equal(status, 200);
    const rows = db.prepare("SELECT tweet_id, ts FROM digest_opens").all() as any[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tweet_id, "m10-c");
    assert.ok(rows[0].ts);
  });

  it("POST /digest/open without tweet_id → 400, nothing appended", async () => {
    const { status } = await req("POST", "/digest/open", { nope: true });
    assert.equal(status, 400);
    const n = (db.prepare("SELECT COUNT(*) n FROM digest_opens").get() as any).n;
    assert.equal(n, 1); // still just the row from the previous test
  });
});

// ---- M11: digest_log serve rows carry the drafting `arm` (team-draft interleaving) ----
describe("M11 digest_log arm attribution", () => {
  it("a served digest writes arm on taste rows (mix|keyword under the live MATCHUP), null on explore", async () => {
    // Enough distinct-token candidates that the live MATCHUP=["mix","keyword"] draft produces a
    // multi-card slate; each taste slot must be stamped with the arm that drafted it, explore null.
    const m11ids = ["m11-a", "m11-b", "m11-c", "m11-d"];
    await post({ tweets: [
      { ...tweet, tweet_id: "m11-a", text: "an ai llm agent model reasoning benchmark with many tokens here" },
      { ...tweet, tweet_id: "m11-b", text: "openai anthropic claude gemini training inference dataset embeddings" },
      { ...tweet, tweet_id: "m11-c", text: "a totally different topic about sourdough bread and garden tomatoes today" },
      { ...tweet, tweet_id: "m11-d", text: "prompt engineering rag gpu cuda pytorch tensor multimodal robotics agi" },
    ], impressions: m11ids.map(id => ({ ...impression, impression_id: `imp-${id}`, tweet_id: id })) });
    const before = (db.prepare("SELECT COALESCE(MAX(rowid),0) n FROM digest_log").get() as any).n;
    const { status, json } = await req("GET", "/digest?limit=10");
    assert.equal(status, 200);
    const rows = db.prepare("SELECT tweet_id, lane, arm FROM digest_log WHERE rowid > ? ORDER BY rank").all(before) as any[];
    assert.equal(rows.length, json.items.length, "one log row per served card, including the new arm column");
    // Taste rows carry a real arm from the matchup; explore rows are arm-agnostic (null).
    for (const r of rows) {
      if (r.lane === "explore") assert.equal(r.arm, null, "explore serve row has arm=null");
      else assert.ok(r.arm === "mix" || r.arm === "keyword", `taste serve row carries a matchup arm, got ${r.arm}`);
    }
    assert.ok(rows.some(r => r.arm === "mix" || r.arm === "keyword"), "at least one arm-attributed serve row was logged");
    // The logged arm matches what buildDigest put on the served item (no drift between serve + log).
    const byId = new Map(rows.map(r => [r.tweet_id, r.arm]));
    for (const it of json.items) assert.equal(byId.get(it.tweet_id), it.arm ?? null, `arm logged == item.arm for ${it.tweet_id}`);
  });
});

// ---- Vote ui_context: what the judge saw at vote time, stored per review row ----
describe("review vote ui_context", () => {
  it("stores context as JSON when sent, null when absent", async () => {
    const ctx = { surface: "review", pos: 3, shown_dwell: 5200 };
    let r = await req("POST", "/review", { tweet_id: "uc1", verdict: 1, ui_context: ctx });
    assert.equal(r.status, 200);
    r = await req("POST", "/review", { tweet_id: "uc2", verdict: -1 });
    assert.equal(r.status, 200);
    const rows = db.prepare(
      "SELECT tweet_id, ui_context FROM reviews WHERE tweet_id IN ('uc1','uc2') ORDER BY tweet_id"
    ).all() as any[];
    assert.deepEqual(JSON.parse(rows[0].ui_context), ctx);
    assert.equal(rows[1].ui_context, null);
  });
});

// ---- Review queue format policy: replies only from high-like-prior authors ----
describe("review queue reply filter", () => {
  it("drops cold-author replies, keeps originals and high-prior-author replies", async () => {
    // High-prior author: 2 kept likes (≥ REPLY_MIN_AUTHOR_LIKES) attributed via tweets.author_id.
    await post({ tweets: [
      { ...tweet, tweet_id: "rq-like1", author_id: "hp", text: "liked one" },
      { ...tweet, tweet_id: "rq-like2", author_id: "hp", text: "liked two" },
      { ...tweet, tweet_id: "rq-orig", author_id: "cold1", text: "an original tweet with plenty of tokens here" },
      { ...tweet, tweet_id: "rq-reply-cold", author_id: "cold2", text: "@someone great point totally agree with all of this" },
      { ...tweet, tweet_id: "rq-reply-hp", author_id: "hp", text: "@someone a reply from an author whose posts you keep liking" },
    ] });
    db.prepare("INSERT OR IGNORE INTO engagement_labels (tweet_id, source, ts) VALUES (?,?,?)").run("rq-like1", "like", "2026-01-01T00:00:00Z");
    db.prepare("INSERT OR IGNORE INTO engagement_labels (tweet_id, source, ts) VALUES (?,?,?)").run("rq-like2", "like", "2026-01-01T00:00:00Z");
    // Trusted dwell for the three queue candidates (>1500ms, visible, unflicked, slow entry).
    await post({ impressions: ["rq-orig", "rq-reply-cold", "rq-reply-hp"].map(id => ({
      ...impression, impression_id: `imp-${id}`, tweet_id: id, dwell_ms: 5000, max_visible_pct: 0.9,
    })) });
    const { status, json } = await req("GET", "/review/queue?limit=50");
    assert.equal(status, 200);
    const ids = new Set(json.tweets.map((t: any) => t.tweet_id));
    assert.ok(ids.has("rq-orig"), "original stays in the queue");
    assert.ok(!ids.has("rq-reply-cold"), "cold-author reply is filtered out");
    assert.ok(ids.has("rq-reply-hp"), "high-like-prior author's reply survives");
  });
});
