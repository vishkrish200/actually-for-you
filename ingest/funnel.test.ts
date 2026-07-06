// Run: node --experimental-strip-types --test funnel.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { funnel } from "./funnel.ts";

// Fixture: A served rank 1 (taste), B rank 2 (taste), C rank 12 (explore); A re-served later at
// rank 40. A opened after serve; B "opened" BEFORE its serve (must not count); stray open on a
// never-served tweet (must not count). A voted 👎-then-👍 (latest wins) between its two serves —
// attribution must pick the rank-1 serve; C voted 👎 after everything. One review with no serve
// context at all (review-mode vote) — excluded.
function seed(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE digest_log (rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      digest_date TEXT, channel TEXT, tweet_id TEXT, rank INTEGER, lane TEXT,
      score REAL, parts TEXT, ts TEXT);
    CREATE TABLE digest_opens (rowid INTEGER PRIMARY KEY AUTOINCREMENT, tweet_id TEXT, ts TEXT);
    CREATE TABLE reviews (rowid INTEGER PRIMARY KEY AUTOINCREMENT, tweet_id TEXT, verdict INTEGER, ts TEXT);
  `);
  const serve = db.prepare("INSERT INTO digest_log (digest_date,channel,tweet_id,rank,lane,score,parts,ts) VALUES ('2026-07-06','web',?,?,?,1.0,?,?)");
  serve.run("A", 1, "taste", '{"taste":0.8,"rubric":0.1,"author":0.5}', "2026-07-06T08:00:00Z");
  serve.run("B", 2, "taste", '{"taste":0.6,"rubric":0.2,"author":0.0}', "2026-07-06T08:00:00Z");
  serve.run("C", 12, "explore", '{"taste":-0.2,"rubric":0.0,"author":-0.3}', "2026-07-06T08:00:00Z");
  serve.run("A", 40, "taste", '{"taste":0.1,"rubric":0.1,"author":0.1}', "2026-07-07T08:00:00Z"); // re-serve
  const open = db.prepare("INSERT INTO digest_opens (tweet_id, ts) VALUES (?,?)");
  open.run("A", "2026-07-06T08:05:00Z");
  open.run("B", "2026-07-05T00:00:00Z"); // before B's first serve — not attributable
  open.run("Z", "2026-07-06T09:00:00Z"); // never served — stray
  const vote = db.prepare("INSERT INTO reviews (tweet_id, verdict, ts) VALUES (?,?,?)");
  vote.run("A", -1, "2026-07-06T08:06:00Z");
  vote.run("A", 1, "2026-07-06T08:07:00Z"); // latest verdict per tweet wins
  vote.run("C", -1, "2026-07-08T00:00:00Z");
  vote.run("R", 1, "2026-07-06T10:00:00Z"); // review-mode vote, never served
  return db;
}

describe("M10 funnel report", () => {
  const r = funnel(seed());

  it("totals: raw serve rows, first-serve tweet count, votes with serve context", () => {
    assert.equal(r.totals.serve_rows, 4);
    assert.equal(r.totals.tweets_served, 3);
    assert.equal(r.totals.opens, 3);
    assert.equal(r.totals.votes_with_context, 2); // A and C; R has no serve to attribute to
  });

  it("opens by lane count only at-or-after first serve, per distinct tweet", () => {
    assert.deepEqual(r.lanes.map(x => ({ ...x })), [
      { lane: "explore", served: 1, opened: 0, open_rate: 0 },
      { lane: "taste", served: 2, opened: 1, open_rate: 0.5 }, // A yes; B's pre-serve open ignored
    ]);
  });

  it("rank curve buckets by rank at FIRST serve (re-serve at 40 doesn't re-count A)", () => {
    assert.deepEqual(r.ranks.map(x => ({ ...x })), [
      { rank_bucket: "1-5", served: 2, opened: 1, open_rate: 0.5 },
      { rank_bucket: "11-20", served: 1, opened: 0, open_rate: 0 },
    ]); // no 21+ bucket: the rank-40 row is a re-serve, not a first exposure
  });

  it("votes attribute to the latest serve at-or-before the vote, latest verdict wins", () => {
    assert.deepEqual(r.votesByLane.map(x => ({ ...x })), [
      { lane: "explore", up: 0, down: 1 },
      { lane: "taste", up: 1, down: 0 }, // A's earlier 👎 superseded by the 👍
    ]);
    assert.deepEqual(r.votesByRank.map(x => ({ ...x })), [
      { rank_bucket: "1-5", up: 1, down: 0 }, // A's vote predates the rank-40 re-serve
      { rank_bucket: "11-20", up: 0, down: 1 },
    ]);
  });

  it("mean mix parts by verdict come from the attributed serve's parts JSON", () => {
    assert.deepEqual(r.partsByVerdict.map(x => ({ ...x })), [
      { verdict: "up", n: 1, taste: 0.8, rubric: 0.1, author: 0.5 },
      { verdict: "down", n: 1, taste: -0.2, rubric: 0, author: -0.3 },
    ]);
  });

  it("empty db → zeroed report, no throw", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE digest_log (digest_date TEXT, channel TEXT, tweet_id TEXT, rank INTEGER, lane TEXT, score REAL, parts TEXT, ts TEXT);
      CREATE TABLE digest_opens (tweet_id TEXT, ts TEXT);
      CREATE TABLE reviews (tweet_id TEXT, verdict INTEGER, ts TEXT);
    `);
    const empty = funnel(db);
    assert.equal(empty.totals.serve_rows, 0);
    assert.deepEqual(empty.lanes, []);
  });
});
