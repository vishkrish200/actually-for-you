// Run: node --experimental-strip-types --test scorecard.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { scorecard, type Scorecard } from "./scorecard.ts";

// Fixture spans two digest days (07-06, 07-07). Everything is keyed to a tweet's FIRST serve.
// Day 1 (07-06) first serves: A r1 taste, B r8 taste, C r15 explore, D r25 taste.
// Day 2 (07-07) first serves: E r3 explore, F r12 taste, G r2 taste. (A is RE-served r5 on day 2 —
//   a re-serve, so it must NOT add to day-2 `served`.)
// Verdicts (latest per tweet, counted only if a serve precedes the vote):
//   A: 👎 then 👍 — latest 👍 lands AFTER A's day-2 re-serve, yet must bucket to A's FIRST serve
//      (day 1, r1, taste). This is the case that distinguishes first-serve keying from funnel's
//      latest-serve-at-or-before keying.  B/C/D 👎 on day 1.  E 👍, F 👎 on day 2.
//   G: 👎 cast BEFORE its serve → context-free → excluded (G still counts in day-2 `served`).
//   H: 👍 but never served → excluded entirely.
// Opens: A after its serve (counts, day 1); B BEFORE its first serve (excluded); E next day after its
//   serve (counts, day 2, attributes to first-serve date); Z never served (stray, excluded).
function seed(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE digest_log (rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      digest_date TEXT, channel TEXT, tweet_id TEXT, rank INTEGER, lane TEXT, score REAL, parts TEXT, ts TEXT);
    CREATE TABLE digest_opens (rowid INTEGER PRIMARY KEY AUTOINCREMENT, tweet_id TEXT, ts TEXT);
    CREATE TABLE reviews (rowid INTEGER PRIMARY KEY AUTOINCREMENT, tweet_id TEXT, verdict INTEGER, ts TEXT);
  `);
  const serve = db.prepare("INSERT INTO digest_log (digest_date,channel,tweet_id,rank,lane,score,parts,ts) VALUES (?,?,?,?,?,1.0,'{}',?)");
  serve.run("2026-07-06", "web", "A", 1, "taste", "2026-07-06T08:00:00Z");
  serve.run("2026-07-06", "web", "B", 8, "taste", "2026-07-06T08:00:00Z");
  serve.run("2026-07-06", "web", "C", 15, "explore", "2026-07-06T08:00:00Z");
  serve.run("2026-07-06", "web", "D", 25, "taste", "2026-07-06T08:00:00Z");
  serve.run("2026-07-07", "web", "E", 3, "explore", "2026-07-07T08:00:00Z");
  serve.run("2026-07-07", "web", "F", 12, "taste", "2026-07-07T08:00:00Z");
  serve.run("2026-07-07", "web", "G", 2, "taste", "2026-07-07T08:00:00Z");
  serve.run("2026-07-07", "web", "A", 5, "taste", "2026-07-07T08:00:00Z"); // A re-serve — not a first serve
  const vote = db.prepare("INSERT INTO reviews (tweet_id,verdict,ts) VALUES (?,?,?)");
  vote.run("A", -1, "2026-07-06T08:30:00Z");
  vote.run("A", 1, "2026-07-07T09:00:00Z");  // latest wins, and post-re-serve — still buckets to day 1
  vote.run("B", -1, "2026-07-06T09:00:00Z");
  vote.run("C", -1, "2026-07-06T09:00:00Z");
  vote.run("D", -1, "2026-07-06T09:00:00Z"); // r25 👎 — counts in `down`/core but outside both junk cuts
  vote.run("E", 1, "2026-07-07T09:00:00Z");
  vote.run("F", -1, "2026-07-07T09:00:00Z");
  vote.run("G", -1, "2026-07-05T00:00:00Z"); // pre-serve → context-free → excluded
  vote.run("H", 1, "2026-07-06T10:00:00Z");  // never served → excluded
  const open = db.prepare("INSERT INTO digest_opens (tweet_id,ts) VALUES (?,?)");
  open.run("A", "2026-07-06T09:05:00Z");
  open.run("B", "2026-07-05T00:00:00Z"); // before B's first serve — excluded
  open.run("E", "2026-07-08T00:00:00Z"); // next day, after serve — counts, attributes to day 2
  open.run("Z", "2026-07-06T09:00:00Z"); // never served — stray
  return db;
}

function present(s: Scorecard) { assert.equal(s.present, true); return s as Extract<Scorecard, { present: true }>; }

describe("digest scorecard", () => {
  const r = present(scorecard(seed()));
  const day = (d: string) => r.days.find(x => x.date === d)!;

  it("row per first-serve day, chronological, plus a TOTAL", () => {
    assert.deepEqual(r.days.map(d => d.date), ["2026-07-06", "2026-07-07"]);
    assert.equal(r.totals.date, "TOTAL");
  });

  it("day 1: served/up/down/hits keyed to first serve (A's post-re-serve 👍 buckets here)", () => {
    const d = day("2026-07-06");
    assert.equal(d.served, 4);          // A,B,C,D first-served this day
    assert.equal(d.up, 1);              // A (latest 👍)
    assert.equal(d.down, 3);            // B,C,D
    assert.equal(d.hits, d.up);         // hits === up by definition
    assert.equal(d.opens, 1);           // A only; B's pre-serve open ignored
  });

  it("day 2: A's re-serve does NOT add to served; pre-serve vote (G) excluded", () => {
    const d = day("2026-07-07");
    assert.equal(d.served, 3);          // E,F,G — NOT A (re-serve)
    assert.equal(d.up, 1);              // E
    assert.equal(d.down, 1);            // F; G's pre-serve 👎 excluded
    assert.equal(d.opens, 1);           // E, opened next day, attributes here
  });

  it("junk@10 / junk@20 math exactly (down/n at each rank cut, first-serve rank)", () => {
    const d1 = day("2026-07-06");
    assert.deepEqual([d1.j10_down, d1.j10_n], [1, 2]);   // ≤10: A(r1),B(r8); 👎 among them: B
    assert.equal(d1.j10, 1 / 2);
    assert.deepEqual([d1.j20_down, d1.j20_n], [2, 3]);   // ≤20: A,B,C(r15); 👎: B,C  (D r25 excluded)
    assert.equal(d1.j20, 2 / 3);
    const d2 = day("2026-07-07");
    assert.deepEqual([d2.j10_down, d2.j10_n], [0, 2]);   // ≤10: E(r3),G(r2); 👎 among them: none
    assert.equal(d2.j10, 0);
    assert.deepEqual([d2.j20_down, d2.j20_n], [1, 3]);   // ≤20: E,F(r12),G; 👎: F
    assert.equal(d2.j20, 1 / 3);
  });

  it("explore (✧) vs non-explore split, by first-serve lane", () => {
    const d1 = day("2026-07-06");
    assert.deepEqual([d1.exp_up, d1.exp_down], [0, 1]);  // C 👎
    assert.deepEqual([d1.core_up, d1.core_down], [1, 2]); // A 👍; B,D 👎
    const d2 = day("2026-07-07");
    assert.deepEqual([d2.exp_up, d2.exp_down], [1, 0]);  // E 👍
    assert.deepEqual([d2.core_up, d2.core_down], [0, 1]); // F 👎; G excluded
  });

  it("TOTAL pools counts across days; junk rates are global num/den, not a mean of days", () => {
    assert.equal(r.totals.served, 7);
    assert.equal(r.totals.up, 2);
    assert.equal(r.totals.down, 4);
    assert.equal(r.totals.opens, 2);
    assert.deepEqual([r.totals.j10_down, r.totals.j10_n], [1, 4]);
    assert.equal(r.totals.j10, 1 / 4);
    assert.deepEqual([r.totals.j20_down, r.totals.j20_n], [3, 6]);
    assert.equal(r.totals.j20, 3 / 6);
    assert.deepEqual([r.totals.exp_up, r.totals.exp_down], [1, 1]);
    assert.deepEqual([r.totals.core_up, r.totals.core_down], [1, 3]);
    // Sanity: lane split partitions the votes exactly.
    assert.equal(r.totals.exp_up + r.totals.core_up, r.totals.up);
    assert.equal(r.totals.exp_down + r.totals.core_down, r.totals.down);
  });

  it("junk rate is null (dash at print) when no tweets sit at the cut — never NaN", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE digest_log (digest_date TEXT, channel TEXT, tweet_id TEXT, rank INTEGER, lane TEXT, score REAL, parts TEXT, ts TEXT);`);
    // One tweet served at rank 30 — outside both cuts. Missing reviews/digest_opens tables tolerated.
    db.prepare("INSERT INTO digest_log VALUES ('2026-07-06','web','X',30,'taste',1.0,'{}','2026-07-06T08:00:00Z')").run();
    const s = present(scorecard(db));
    assert.equal(s.days[0].j10, null);
    assert.equal(s.days[0].j20, null);
    assert.equal(s.days[0].served, 1);
  });

  it("db predating digest_log → present:false (nothing served yet), no throw", () => {
    const db = new DatabaseSync(":memory:"); // no tables at all
    assert.deepEqual(scorecard(db), { present: false });
  });
});
