// Run: node --experimental-strip-types --test recall.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { recall } from "./recall.ts";

const NOW = Date.parse("2026-07-08T00:00:00Z"); // fixed clock → deterministic 7-day cutoff (2026-07-01)

// Fixture — engagements in a 7-day window (07-01 .. 07-08), classified per distinct tweet:
//   T1 like  07-07  captured + served        → served (the win)
//   T2 like  07-06  captured, not served     → MISSED   (text has whitespace to collapse)
//   T3 bkmk  07-05  captured, not served     → MISSED   (100-char text to truncate ~80)
//   T4 like  06-01  OLD (before cutoff)       → excluded from the window
//   T5 like  07-04  in label_prunes           → excluded (liked-then-pruned is not a miss)
//   T6 like  07-03  no tweets row             → not-captured
//   T7 like  07-02  tweets row with '' text   → not-captured (captured requires non-empty text)
function seed({ withDigestLog = true }: { withDigestLog?: boolean } = {}): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE engagement_labels (tweet_id TEXT, source TEXT, ts TEXT, PRIMARY KEY (tweet_id, source));
    CREATE TABLE label_prunes (tweet_id TEXT PRIMARY KEY, reason TEXT, ts TEXT);
    CREATE TABLE tweets (tweet_id TEXT PRIMARY KEY, text TEXT);
    ${withDigestLog ? `CREATE TABLE digest_log (rowid INTEGER PRIMARY KEY AUTOINCREMENT, tweet_id TEXT, ts TEXT);` : ``}
  `);
  const eng = db.prepare("INSERT INTO engagement_labels (tweet_id,source,ts) VALUES (?,?,?)");
  eng.run("T1", "like", "2026-07-07T10:00:00Z");
  eng.run("T2", "like", "2026-07-06T10:00:00Z");
  eng.run("T3", "bookmark", "2026-07-05T10:00:00Z");
  eng.run("T4", "like", "2026-06-01T10:00:00Z"); // old — outside the window
  eng.run("T5", "like", "2026-07-04T10:00:00Z"); // pruned
  eng.run("T6", "like", "2026-07-03T10:00:00Z"); // no tweets row
  eng.run("T7", "like", "2026-07-02T10:00:00Z"); // empty text
  db.prepare("INSERT INTO label_prunes (tweet_id,reason,ts) VALUES ('T5','manual','2026-07-04T11:00:00Z')").run();
  const tw = db.prepare("INSERT INTO tweets (tweet_id,text) VALUES (?,?)");
  tw.run("T1", "hello world");
  tw.run("T2", "a missed\n   banger   about rust"); // whitespace collapses to single spaces
  tw.run("T3", "x".repeat(100));                     // long → snippet truncates to ~80 + ellipsis
  tw.run("T5", "pruned tweet");
  tw.run("T7", "   ");                               // whitespace-only → not captured
  // NOTE: no tweets row for T6.
  if (withDigestLog) db.prepare("INSERT INTO digest_log (tweet_id,ts) VALUES ('T1','2026-07-07T08:00:00Z')").run();
  return db;
}

describe("recall miss detector", () => {
  it("window + prune exclusion: old like and pruned like drop out of the counts", () => {
    const r = recall(seed(), 7, NOW);
    assert.equal(r.likes, 4);      // T1,T2,T6,T7 (T4 old, T5 pruned excluded)
    assert.equal(r.bookmarks, 1);  // T3
    assert.equal(r.total, 5);      // distinct tweets T1,T2,T3,T6,T7
    assert.equal(r.noDigestLog, false);
  });

  it("captured / served / missed / not-captured classification", () => {
    const r = recall(seed(), 7, NOW);
    assert.equal(r.captured, 3);     // T1,T2,T3 have non-empty text
    assert.equal(r.served, 1);       // T1 served
    assert.equal(r.missed, 2);       // T2,T3 captured but never served
    assert.equal(r.notCaptured, 2);  // T6 (no row), T7 (empty text)
    // partition holds: served + missed + not-captured === total
    assert.equal(r.served + r.missed + r.notCaptured, r.total);
  });

  it("missed list is most-recent-first, ≤10, with a collapsed ~80-char snippet", () => {
    const r = recall(seed(), 7, NOW);
    assert.deepEqual(r.missedList.map(m => m.tweet_id), ["T2", "T3"]); // 07-06 before 07-05
    assert.equal(r.missedList[0].snippet, "a missed banger about rust"); // whitespace collapsed
    assert.equal(r.missedList[1].snippet, "x".repeat(79) + "…");         // truncated to 80 chars
    assert.ok(r.missedList[1].snippet.length === 80);
  });

  it("no digest_log → served forced 0, every captured engagement is a miss", () => {
    const r = recall(seed({ withDigestLog: false }), 7, NOW);
    assert.equal(r.noDigestLog, true);
    assert.equal(r.served, 0);
    assert.equal(r.missed, 3);   // T1 now a miss too
    assert.equal(r.captured, 3);
    assert.deepEqual(r.missedList.map(m => m.tweet_id), ["T1", "T2", "T3"]);
  });

  it("empty window → emptyReason set, exits clean (no misses to report)", () => {
    const r = recall(seed(), 1, Date.parse("2026-08-01T00:00:00Z")); // cutoff 07-31, all engagements older
    assert.ok(r.emptyReason);
    assert.equal(r.total, 0);
    assert.equal(r.missedList.length, 0);
  });

  it("no engagement_labels table → emptyReason, no throw", () => {
    const db = new DatabaseSync(":memory:");
    const r = recall(db, 7, NOW);
    assert.ok(r.emptyReason);
    assert.match(r.emptyReason!, /engagement_labels/);
  });
});
