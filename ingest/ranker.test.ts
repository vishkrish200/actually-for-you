// Run with: node --experimental-strip-types --test ranker.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { score, mmr, WEIGHTS, buildFeed } from "./ranker.ts";

const base = {
  author_handle: "test", author_id: "1",
  text: "hello world testing ranker logic",
  media: null, is_thread: 0, created_at: null,
  likes: 0, rts: 0, replies: 0, views: null,
  total_dwell: 0, impression_count: 1,
  opened: 0, liked: 0, bookmarked: 0, replied: 0,
  flicked_count: 0, last_seen: null, char_len: 20, lane: "fresh",
};

describe("score", () => {
  it("opened_detail beats max dwell", () => {
    assert(score({ ...base, tweet_id: "a", opened: 1 }) >
           score({ ...base, tweet_id: "b", total_dwell: 60_000 }));
  });

  it("liked > bookmarked > replied", () => {
    const liked     = score({ ...base, tweet_id: "a", liked: 1 });
    const bookmarked = score({ ...base, tweet_id: "b", bookmarked: 1 });
    const replied   = score({ ...base, tweet_id: "c", replied: 1 });
    assert(liked > bookmarked && bookmarked > replied);
  });

  it("flicked penalizes below baseline", () => {
    assert(score({ ...base, tweet_id: "a" }) >
           score({ ...base, tweet_id: "b", flicked_count: 1 }));
  });

  it("dwell capped at 60s", () => {
    const s60  = score({ ...base, tweet_id: "a", total_dwell: 60_000 });
    const s120 = score({ ...base, tweet_id: "b", total_dwell: 120_000 });
    assert.equal(s60, s120);
  });

  it("order snapshot: opened > liked > dwell > baseline", () => {
    const candidates = [
      { ...base, tweet_id: "baseline" },
      { ...base, tweet_id: "dwell",   total_dwell: 30_000 },
      { ...base, tweet_id: "liked",   liked: 1 },
      { ...base, tweet_id: "opened",  opened: 1 },
    ];
    const sorted = [...candidates].sort((a, b) => score(b) - score(a));
    assert.deepStrictEqual(
      sorted.map(c => c.tweet_id),
      ["opened", "liked", "dwell", "baseline"],
    );
  });
});

describe("mmr", () => {
  it("lambda=1.0 returns pure score order", () => {
    const cs = [
      { ...base, tweet_id: "mid",  score: 5 },
      { ...base, tweet_id: "high", score: 10 },
      { ...base, tweet_id: "low",  score: 1 },
    ];
    const result = mmr(cs, 1.0, 3);
    assert.deepStrictEqual(result.map(c => c.tweet_id), ["high", "mid", "low"]);
  });

  it("diversity: diverse tweet beats near-duplicate at equal score", () => {
    // second and third have equal score; diversity should pick third over second
    const cs = [
      { ...base, tweet_id: "first",  text: "apple orange banana fruit salad bowl",  score: 10 },
      { ...base, tweet_id: "second", text: "apple orange banana fruit basket bowl",  score: 8 },
      { ...base, tweet_id: "third",  text: "javascript typescript code compiler",    score: 8 },
    ];
    const result = mmr(cs, 0.5, 3);
    assert.strictEqual(result[0].tweet_id, "first");
    // third (diverse) should rank above second (near-duplicate of first)
    assert.strictEqual(result[1].tweet_id, "third");
    assert.strictEqual(result[2].tweet_id, "second");
  });

  it("limit respected", () => {
    const cs = Array.from({ length: 10 }, (_, i) => ({ ...base, tweet_id: `t${i}`, score: 10 - i }));
    assert.equal(mmr(cs, 0.7, 3).length, 3);
  });
});

describe("buildFeed lane join", () => {
  function freshDb() {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE tweets (
        tweet_id TEXT PRIMARY KEY, author_handle TEXT, author_name TEXT, author_id TEXT, text TEXT,
        media TEXT, is_thread INTEGER, created_at TEXT,
        likes INTEGER, rts INTEGER, replies INTEGER, views INTEGER, captured_at TEXT);
      CREATE TABLE impressions (
        impression_id TEXT PRIMARY KEY, tweet_id TEXT, session_id TEXT, ts TEXT,
        position_in_feed INTEGER, dwell_ms INTEGER, max_visible_pct REAL,
        scroll_velocity_at_entry REAL, flicked INTEGER, opened_detail INTEGER,
        profile_expanded TEXT, liked INTEGER, rt INTEGER, bookmarked INTEGER, replied INTEGER,
        reported INTEGER, negative_feedback INTEGER,
        media_present INTEGER, is_thread INTEGER, char_len INTEGER);
    `);
    return db;
  }

  it("viewed-gate: excludes prefetched/never-on-screen tweets, keeps tweets actually seen", () => {
    const db = freshDb();
    // prefetch: content captured from X's GraphQL payload but never rendered (no impression)
    db.prepare(`INSERT INTO tweets (tweet_id, author_id, text, captured_at)
                VALUES ('prefetch1', 'a1', 'never scrolled to', datetime('now'))`).run();
    // seen: fully visible, low-velocity read
    db.prepare(`INSERT INTO tweets (tweet_id, author_id, text, captured_at)
                VALUES ('seen1', 'a2', 'actually on screen', datetime('now','-1 hour'))`).run();
    db.prepare(`INSERT INTO impressions (impression_id, tweet_id, dwell_ms, max_visible_pct, scroll_velocity_at_entry, ts, opened_detail, liked, bookmarked, flicked)
                VALUES ('i1', 'seen1', 2000, 1, 1.0, datetime('now'), 0, 0, 0, 0)`).run();
    // peek: had an impression but never crossed 50% visible (barely entered viewport edge)
    db.prepare(`INSERT INTO tweets (tweet_id, author_id, text, captured_at)
                VALUES ('peek1', 'a3', 'barely peeked at edge', datetime('now'))`).run();
    db.prepare(`INSERT INTO impressions (impression_id, tweet_id, dwell_ms, max_visible_pct, scroll_velocity_at_entry, ts, opened_detail, liked, bookmarked, flicked)
                VALUES ('i2', 'peek1', 0, 0.2, 1.0, datetime('now'), 0, 0, 0, 0)`).run();

    const ids = buildFeed(db, 50).map(c => c.tweet_id);
    assert.ok(ids.includes("seen1"), "a tweet that was >=50% on screen must appear");
    assert.ok(!ids.includes("prefetch1"), "a prefetched tweet never on screen must be excluded");
    assert.ok(!ids.includes("peek1"), "a tweet that never crossed 50% visible must be excluded");
  });

  it("surfaces a SEEN impression-only row that has no tweet content (e.g. retweet gap)", () => {
    const db = freshDb();
    db.prepare(`INSERT INTO impressions (impression_id, tweet_id, dwell_ms, max_visible_pct, scroll_velocity_at_entry, ts, opened_detail, liked, bookmarked, flicked)
                VALUES ('i1', 'orphan1', 3000, 1, 1.0, datetime('now'), 0, 0, 0, 0)`).run();
    const ids = buildFeed(db, 50).map(c => c.tweet_id);
    assert.ok(ids.includes("orphan1"), "a seen impression without content must still rank");
  });

  it("dwell lanes ignore leaked dwell (fast-scroll entry / absurd magnitude), keep genuine reads", () => {
    const db = freshDb();
    // leaked: 'fully visible', not flicked, but entered at high scroll velocity with 179s dwell
    // (the timer-leak signature). Captured >48h ago so the `fresh` lane can't claim it.
    db.prepare(`INSERT INTO tweets (tweet_id, author_id, text, captured_at)
                VALUES ('leak1','a','glanced past, never read', datetime('now','-3 days'))`).run();
    db.prepare(`INSERT INTO impressions (impression_id,tweet_id,ts,dwell_ms,max_visible_pct,scroll_velocity_at_entry,flicked,opened_detail,liked,bookmarked)
                VALUES ('l1','leak1',datetime('now','-3 days'),179000,1,8.6,0,0,0,0)`).run();
    // genuine read: low entry velocity, modest dwell
    db.prepare(`INSERT INTO tweets (tweet_id, author_id, text, captured_at)
                VALUES ('read1','b','actually read this one', datetime('now','-3 days'))`).run();
    db.prepare(`INSERT INTO impressions (impression_id,tweet_id,ts,dwell_ms,max_visible_pct,scroll_velocity_at_entry,flicked,opened_detail,liked,bookmarked)
                VALUES ('r1','read1',datetime('now','-3 days'),8000,1,1.0,0,0,0,0)`).run();

    const feed = buildFeed(db, 50);
    const leak = feed.find(c => c.tweet_id === "leak1");
    const read = feed.find(c => c.tweet_id === "read1");
    const DWELL_LANES = new Set(["backlog", "resurface"]);

    assert.ok(read && DWELL_LANES.has(read.lane), `genuine read should land in a dwell lane, got ${read?.lane}`);
    assert.ok(!leak || !DWELL_LANES.has(leak.lane), `leaked-dwell tweet must NOT enter a dwell lane, got ${leak?.lane}`);
    assert.equal(read!.total_dwell, 8000, "trusted dwell counts the genuine read");
    assert.equal(leak ? leak.total_dwell : 0, 0, "trusted dwell excludes the fast-scroll leak");
  });

  it("negative-feedback veto: reported / not-interested tweets are suppressed from every lane", () => {
    const db = freshDb();
    // would-otherwise-qualify tweets (seen, good dwell) but flagged negative
    db.prepare(`INSERT INTO tweets (tweet_id, author_id, text, captured_at)
                VALUES ('reported1','a','spam i flagged', datetime('now'))`).run();
    db.prepare(`INSERT INTO impressions (impression_id,tweet_id,dwell_ms,max_visible_pct,scroll_velocity_at_entry,ts,opened_detail,liked,bookmarked,flicked,reported,negative_feedback)
                VALUES ('i1','reported1',3000,1,1.0,datetime('now'),0,0,0,0,1,0)`).run();
    db.prepare(`INSERT INTO tweets (tweet_id, author_id, text, captured_at)
                VALUES ('boring1','b','meh not for me', datetime('now'))`).run();
    db.prepare(`INSERT INTO impressions (impression_id,tweet_id,dwell_ms,max_visible_pct,scroll_velocity_at_entry,ts,opened_detail,liked,bookmarked,flicked,reported,negative_feedback)
                VALUES ('i2','boring1',3000,1,1.0,datetime('now'),0,0,0,0,0,1)`).run();
    // a clean seen tweet that must still surface
    db.prepare(`INSERT INTO tweets (tweet_id, author_id, text, captured_at)
                VALUES ('keep1','c','genuinely fine', datetime('now'))`).run();
    db.prepare(`INSERT INTO impressions (impression_id,tweet_id,dwell_ms,max_visible_pct,scroll_velocity_at_entry,ts,opened_detail,liked,bookmarked,flicked,reported,negative_feedback)
                VALUES ('i3','keep1',3000,1,1.0,datetime('now'),0,0,0,0,0,0)`).run();

    const ids = buildFeed(db, 50).map(c => c.tweet_id);
    assert.ok(ids.includes("keep1"), "a clean seen tweet must still surface");
    assert.ok(!ids.includes("reported1"), "a reported tweet must be vetoed from all lanes");
    assert.ok(!ids.includes("boring1"), "a not-interested/muted/blocked tweet must be vetoed");
  });
});
