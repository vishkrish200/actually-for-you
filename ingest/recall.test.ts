// Run: node --experimental-strip-types --test recall.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { recall } from "./recall.ts";

const NOW = Date.parse("2026-07-08T00:00:00Z");

// T1 was eligible at a build and selected before its like; T2/T3 were eligible but not selected;
// T8 was captured only after the final pre-like build, so it is not a ranker miss. T6/T7 prove
// that absent/blank content stays outside the candidate denominator.
function seed({ withRuns = true, withDigestLog = true }: { withRuns?: boolean; withDigestLog?: boolean } = {}): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE engagement_labels (tweet_id TEXT, source TEXT, ts TEXT, PRIMARY KEY (tweet_id, source));
    CREATE TABLE label_prunes (tweet_id TEXT PRIMARY KEY, reason TEXT, ts TEXT);
    CREATE TABLE tweets (tweet_id TEXT PRIMARY KEY, text TEXT, quoted_id TEXT, source TEXT, captured_at TEXT, created_at TEXT);
    CREATE TABLE impressions (impression_id TEXT PRIMARY KEY, tweet_id TEXT, ts TEXT);
    CREATE TABLE reviews (rowid INTEGER PRIMARY KEY AUTOINCREMENT, tweet_id TEXT, verdict INTEGER, ts TEXT);
    ${withRuns ? `CREATE TABLE digest_runs (rowid INTEGER PRIMARY KEY AUTOINCREMENT, digest_date TEXT, channel TEXT, days INTEGER, limit_n INTEGER, candidate_count INTEGER, ts TEXT);` : ""}
    ${withDigestLog ? `CREATE TABLE digest_log (rowid INTEGER PRIMARY KEY AUTOINCREMENT, tweet_id TEXT, ts TEXT);` : ""}
  `);
  const eng = db.prepare("INSERT INTO engagement_labels (tweet_id,source,ts) VALUES (?,?,?)");
  eng.run("T1", "like", "2026-07-07T10:00:00Z");
  eng.run("T2", "like", "2026-07-06T10:00:00Z");
  eng.run("T3", "bookmark", "2026-07-05T10:00:00Z");
  eng.run("T4", "like", "2026-06-01T10:00:00Z"); // outside window
  eng.run("T5", "like", "2026-07-04T10:00:00Z"); // pruned
  eng.run("T6", "like", "2026-07-03T10:00:00Z"); // no tweet row
  eng.run("T7", "like", "2026-07-02T10:00:00Z"); // blank text
  eng.run("T8", "like", "2026-07-07T12:00:00Z"); // no run after capture
  db.prepare("INSERT INTO label_prunes VALUES ('T5','manual','2026-07-04T11:00:00Z')").run();
  const tw = db.prepare("INSERT INTO tweets (tweet_id,text,quoted_id,source,captured_at,created_at) VALUES (?,?,?,?,?,?)");
  for (const id of ["T1", "T2", "T3"]) {
    tw.run(id, `${id} has enough real candidate words to be eligible`, null, "net", "2026-07-01T00:00:00Z", "2026-07-01T00:00:00Z");
  }
  tw.run("T5", "pruned candidate with enough words to be eligible", null, "net", "2026-07-01T00:00:00Z", "2026-07-01T00:00:00Z");
  tw.run("T7", "   ", null, "net", "2026-07-01T00:00:00Z", "2026-07-01T00:00:00Z");
  tw.run("T8", "captured after the digest build with enough words", null, "net", "2026-07-07T11:00:00Z", "2026-07-07T11:00:00Z");
  const imp = db.prepare("INSERT INTO impressions VALUES (?,?,?)");
  for (const id of ["T1", "T2", "T3", "T5"]) imp.run(`${id}-imp`, id, "2026-07-01T00:00:00Z");
  imp.run("T8-imp", "T8", "2026-07-07T11:00:00Z");
  if (withRuns) {
    const run = db.prepare("INSERT INTO digest_runs (digest_date,channel,days,limit_n,candidate_count,ts) VALUES (?,?,?,?,?,?)");
    run.run("2026-07-04", "web", 0, 50, 3, "2026-07-04T08:00:00Z");
    run.run("2026-07-06", "web", 0, 50, 3, "2026-07-06T08:00:00Z");
    run.run("2026-07-07", "web", 0, 50, 3, "2026-07-07T08:00:00Z");
  }
  if (withDigestLog) db.prepare("INSERT INTO digest_log (tweet_id,ts) VALUES ('T1','2026-07-07T08:30:00Z')").run();
  return db;
}

describe("candidate-stage recall", () => {
  it("keeps the engagement window and prune exclusion as the report denominator", () => {
    const r = recall(seed(), 7, NOW);
    assert.equal(r.likes, 5);      // T1,T2,T6,T7,T8; old T4 excluded and T5 pruned
    assert.equal(r.bookmarks, 1);
    assert.equal(r.total, 6);
    assert.equal(r.loggedRuns, 3);
    assert.equal(r.noDigestRuns, false);
  });

  it("separates selected candidates from ranker misses and no-opportunity tweets", () => {
    const r = recall(seed(), 7, NOW);
    assert.equal(r.captured, 4);      // T1,T2,T3,T8
    assert.equal(r.notCaptured, 2);   // T6 absent, T7 blank
    assert.equal(r.available, 3);     // T1,T2,T3 had a prior eligible run
    assert.equal(r.served, 1);        // T1 before its observed like
    assert.equal(r.missed, 2);        // T2,T3: candidate-stage chance, selection miss
    assert.equal(r.notAvailable, 1);  // T8 arrived after the final pre-like run
    assert.equal(r.served + r.missed + r.notAvailable, r.captured);
    assert.equal(r.medianTimeToFirstServeMs, (3 * 24 * 60 + 30) * 60 * 1000); // 07-04 08:00 → 07-07 08:30
  });

  it("lists only causal selection misses, newest first, with the first eligible build", () => {
    const r = recall(seed(), 7, NOW);
    assert.deepEqual(r.missedList.map(m => m.tweet_id), ["T2", "T3"]);
    assert.equal(r.missedList[0].first_eligible_ts, "2026-07-04T08:00:00Z");
    assert.match(r.missedList[0].snippet, /T2 has enough/);
  });

  it("a digest run with no selected cards still creates a candidate opportunity", () => {
    const r = recall(seed({ withDigestLog: false }), 7, NOW);
    assert.equal(r.available, 3);
    assert.equal(r.served, 0);
    assert.equal(r.missed, 3);
  });

  it("databases from before the ledger report no causal verdict rather than calling every candidate a ranker miss", () => {
    const r = recall(seed({ withRuns: false }), 7, NOW);
    assert.equal(r.noDigestRuns, true);
    assert.equal(r.loggedRuns, 0);
    assert.equal(r.available, 0);
    assert.equal(r.missed, 0);
    assert.equal(r.notAvailable, 4);
  });

  it("a fresh but empty ledger says no causal data yet", () => {
    const db = seed();
    db.exec("DELETE FROM digest_runs");
    const r = recall(db, 7, NOW);
    assert.equal(r.loggedRuns, 0);
    assert.equal(r.noDigestRuns, true);
    assert.equal(r.missed, 0);
  });

  it("empty window and missing labels remain harmless", () => {
    assert.ok(recall(seed(), 1, Date.parse("2026-08-01T00:00:00Z")).emptyReason);
    const r = recall(new DatabaseSync(":memory:"), 7, NOW);
    assert.match(r.emptyReason!, /engagement_labels/);
  });
});
