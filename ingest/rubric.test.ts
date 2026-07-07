// M8 rubric scorer tests. Run: node --experimental-strip-types --test rubric.test.ts
// The claude invocation is INJECTED (runClaude stub), so this suite makes ZERO live claude calls.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  parseScores, buildPrompt, selectUnscored, scoreCandidates, rubricSha, ensureSchema,
  type RunClaude,
} from "./rubric.ts";
import { runEval, loadRubricScores } from "./eval.ts";
import { buildLabels } from "./labels.ts";
import { buildTaste, buildAuthorPrior } from "./digest.ts";

// Minimal db with the tables rubric.ts + labels.ts touch. Mirrors the other test files' seed style.
function seed(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE tweets (tweet_id TEXT PRIMARY KEY, author_handle TEXT, author_name TEXT,
      author_id TEXT, text TEXT, media TEXT, quoted_id TEXT, is_thread INTEGER,
      created_at TEXT, captured_at TEXT, likes INTEGER, rts INTEGER, replies INTEGER, views INTEGER,
      source TEXT DEFAULT 'net');
    CREATE TABLE reviews (rowid INTEGER PRIMARY KEY AUTOINCREMENT, tweet_id TEXT, verdict INTEGER, ts TEXT);
    CREATE TABLE engagement_labels (tweet_id TEXT, source TEXT, ts TEXT, PRIMARY KEY(tweet_id,source));
    CREATE TABLE label_prunes (tweet_id TEXT PRIMARY KEY, reason TEXT, ts TEXT);
  `);
  ensureSchema(db);
  return db;
}
const insTweet = (db: DatabaseSync, o: Partial<{ tweet_id: string; text: string; quoted_id: string | null; captured_at: string; author_handle: string; author_name: string }>) =>
  db.prepare(`INSERT INTO tweets (tweet_id, author_handle, author_name, text, quoted_id, captured_at) VALUES (?,?,?,?,?,?)`)
    .run(o.tweet_id, o.author_handle ?? "somehandle", o.author_name ?? "Some Name", o.text ?? "", o.quoted_id ?? null, o.captured_at ?? "2026-01-01");

const RUBRIC = "score tweets 0-10 for a technical reader";

// A stub runner that returns a fixed reply and counts how many times it was called.
function stubRunner(reply: string | ((prompt: string) => string)): RunClaude & { calls: number; prompts: string[] } {
  const fn = (async (prompt: string) => {
    fn.calls++; fn.prompts.push(prompt);
    return typeof reply === "function" ? reply(prompt) : reply;
  }) as RunClaude & { calls: number; prompts: string[] };
  fn.calls = 0; fn.prompts = [];
  return fn;
}

describe("rubric parser", () => {
  const ids = new Set(["a", "b"]);

  it("parses a markdown-fenced JSON reply (the CLI's real output shape)", () => {
    const raw = "```json\n[{\"id\":\"a\",\"score\":8},{\"id\":\"b\",\"score\":2}]\n```";
    const m = parseScores(raw, ids);
    assert.deepEqual([...m!.entries()].sort(), [["a", 8], ["b", 2]]);
  });

  it("parses a bare (unfenced) JSON reply", () => {
    const m = parseScores('[{"id":"a","score":5},{"id":"b","score":10}]', ids);
    assert.equal(m!.get("a"), 5);
    assert.equal(m!.get("b"), 10);
  });

  it("rejects garbage, out-of-batch ids, and out-of-range/non-integer scores", () => {
    assert.equal(parseScores("not json at all", ids), null);
    assert.equal(parseScores("{}", ids), null);                                   // not an array
    assert.equal(parseScores('[{"id":"zzz","score":5}]', ids), null);            // id not in batch
    assert.equal(parseScores('[{"id":"a","score":11}]', ids), null);             // out of range
    assert.equal(parseScores('[{"id":"a","score":3.5}]', ids), null);            // non-integer
    assert.equal(parseScores('[{"id":"a","score":"8"}]', ids), null);            // string score
  });

  it("garbage reply → retry once → skip: stub called exactly twice, nothing written", async () => {
    const db = seed();
    insTweet(db, { tweet_id: "a", text: "hello world one" });
    insTweet(db, { tweet_id: "b", text: "hello world two" });
    const run = stubRunner("this is not json");
    const summary = await scoreCandidates(db,
      [{ tweet_id: "a", text: "x" }, { tweet_id: "b", text: "y" }],
      { rubricText: RUBRIC, runClaude: run });
    assert.equal(run.calls, 2, "one initial call + one retry, then give up");
    assert.equal(summary.scored, 0);
    assert.equal(summary.skipped, 2, "both tweets in the bad batch skipped");
    const n = (db.prepare("SELECT COUNT(*) n FROM rubric_scores").get() as any).n;
    assert.equal(n, 0, "nothing persisted on a failed batch");
  });

  it("a retry that succeeds on the second attempt is scored", async () => {
    const db = seed();
    let call = 0;
    const run = stubRunner(() => (call++ === 0 ? "garbage" : '[{"id":"a","score":7}]'));
    const summary = await scoreCandidates(db, [{ tweet_id: "a", text: "x" }],
      { rubricText: RUBRIC, runClaude: run });
    assert.equal(run.calls, 2);
    assert.equal(summary.scored, 1);
    assert.equal((db.prepare("SELECT score FROM rubric_scores WHERE tweet_id='a'").get() as any).score, 7);
  });
});

describe("rubric idempotency (keyed on tweet_id + rubric_sha)", () => {
  it("second run with the same sha scores nothing; a changed rubric re-scores", async () => {
    const db = seed();
    insTweet(db, { tweet_id: "a", text: "a real technical claim about llm benchmarks" });
    const sha1 = rubricSha(RUBRIC);
    const run1 = stubRunner('[{"id":"a","score":9}]');

    // first run for sha1 → one candidate selected, scored
    let cands = selectUnscored(db, sha1, 500);
    assert.equal(cands.length, 1);
    await scoreCandidates(db, cands, { rubricText: RUBRIC, runClaude: run1 });
    assert.equal(run1.calls, 1);

    // second run, SAME sha → selection is empty, no claude call
    cands = selectUnscored(db, sha1, 500);
    assert.equal(cands.length, 0, "already-scored tweet not re-selected for the same sha");
    const run2 = stubRunner('[{"id":"a","score":9}]');
    await scoreCandidates(db, cands, { rubricText: RUBRIC, runClaude: run2 });
    assert.equal(run2.calls, 0, "no batches → no claude calls");

    // edit the rubric → new sha → the tweet is unscored FOR THAT sha → re-selected + re-scored
    const RUBRIC2 = RUBRIC + "\nnow also value humor";
    const sha2 = rubricSha(RUBRIC2);
    assert.notEqual(sha1, sha2);
    cands = selectUnscored(db, sha2, 500);
    assert.equal(cands.length, 1, "rubric edit re-exposes the tweet for scoring");
    const run3 = stubRunner('[{"id":"a","score":4}]');
    await scoreCandidates(db, cands, { rubricText: RUBRIC2, runClaude: run3 });
    assert.equal(run3.calls, 1);

    // both scores coexist append-only, one per sha
    const rows = db.prepare("SELECT rubric_sha, score FROM rubric_scores WHERE tweet_id='a' ORDER BY rowid").all() as any[];
    assert.equal(rows.length, 2, "append-only: a re-score is a new row, not a mutation");
    assert.deepEqual(rows.map(r => r.score), [9, 4]);
  });
});

describe("rubric selection priority", () => {
  it("scores a review-pool tweet before a newer non-review tweet when cap = 1", () => {
    const db = seed();
    // an OLD review-pool tweet and a NEWER plain tweet
    insTweet(db, { tweet_id: "review_old", text: "hand signed tweet worth covering", captured_at: "2020-01-01" });
    db.prepare("INSERT INTO reviews (tweet_id, verdict, ts) VALUES (?,?,?)").run("review_old", 1, "2020-01-02");
    insTweet(db, { tweet_id: "fresh_new", text: "a brand new candidate tweet", captured_at: "2026-12-31" });

    const cands = selectUnscored(db, rubricSha(RUBRIC), 1); // cap 1 forces the priority to bite
    assert.equal(cands.length, 1);
    assert.equal(cands[0].tweet_id, "review_old", "review-pool tweet wins the single slot despite being older");
  });

  it("skips empty-text rows entirely", () => {
    const db = seed();
    insTweet(db, { tweet_id: "empty", text: "" });
    insTweet(db, { tweet_id: "real", text: "some actual content here" });
    const cands = selectUnscored(db, rubricSha(RUBRIC), 500);
    assert.deepEqual(cands.map(c => c.tweet_id), ["real"]);
  });
});

describe("rubric prompt payload", () => {
  it("includes quoted text for a captured quote-tweet", () => {
    const db = seed();
    insTweet(db, { tweet_id: "orig", text: "the original substantive point about model scaling" });
    insTweet(db, { tweet_id: "quoter", text: "this.", quoted_id: "orig" });
    const cands = selectUnscored(db, rubricSha(RUBRIC), 500);
    const q = cands.find(c => c.tweet_id === "quoter")!;
    assert.equal(q.quoted_text, "the original substantive point about model scaling", "quoted text joined in");
    // a quote whose original we never captured carries no quoted_text (render/score text-only)
    insTweet(db, { tweet_id: "orphan", text: "great point!", quoted_id: "GONE" });
    const cands2 = selectUnscored(db, rubricSha(RUBRIC), 500);
    assert.equal(cands2.find(c => c.tweet_id === "orphan")!.quoted_text, undefined);
  });

  it("NEVER puts author handles/names or metrics into the prompt (no fame proxy)", async () => {
    const db = seed();
    insTweet(db, { tweet_id: "t1", text: "a claim about inference latency", author_handle: "elonmusk", author_name: "Elon Musk" });
    const cands = selectUnscored(db, rubricSha(RUBRIC), 500);
    const run = stubRunner('[{"id":"t1","score":6}]');
    await scoreCandidates(db, cands, { rubricText: RUBRIC, runClaude: run });
    const prompt = run.prompts[0];
    assert.ok(prompt.includes("a claim about inference latency"), "tweet text is in the prompt");
    assert.ok(prompt.includes('"id":"t1"'), "the tweet_id IS the payload id (so scores can be matched back)");
    assert.ok(!prompt.includes("elonmusk"), "author handle must NOT appear in the prompt");
    assert.ok(!prompt.includes("Elon Musk"), "author name must NOT appear in the prompt");
    // the payload objects only carry id/text/(quoted_text) — assert no 'author'/'likes' keys leaked
    assert.ok(!/\bauthor\b/i.test(prompt) && !/\blikes\b/i.test(prompt), "no author/metrics fields in payload");
  });

  it("buildPrompt embeds the rubric text; the payload omits quoted_text when absent", () => {
    const p = buildPrompt("MY UNIQUE RUBRIC MARKER", [{ id: "x", text: "hello" }]);
    assert.ok(p.includes("MY UNIQUE RUBRIC MARKER"), "rubric contents included");
    // The instruction line legitimately mentions "quoted_text"; assert on the PAYLOAD json instead —
    // a plain tweet's serialized object must not carry the key (only id + text).
    assert.ok(p.includes('{"id":"x","text":"hello"}'), "plain tweet payload has only id+text, no quoted_text key");
    const pq = buildPrompt("R", [{ id: "y", text: "hi", quoted_text: "the quote" }]);
    assert.ok(pq.includes('"quoted_text":"the quote"'), "quoted_text key included in payload when present");
  });
});

describe("eval rubric arm", () => {
  // A fixture review pool where the rubric perfectly separates 👍 from 👎 (high scores on positives,
  // low on negatives) → the rubric arm must land at the TOP of the pool, and coverage must be exact.
  function seedReviewPool(): DatabaseSync {
    const db = seed();
    // balancePool downsamples to 50/50 and splitByTime holds out the newest 30% per kind, so seed a
    // generous, date-spread pool so the balanced TEST pool clears REVIEW_MIN_N and both classes appear.
    for (let i = 0; i < 40; i++) {
      const d = `2026-0${1 + (i % 6)}-01`;
      const pos = `rp${i}`, neg = `rn${i}`;
      insTweet(db, { tweet_id: pos, text: `positive ${i} substantive technical claim about models`, captured_at: d });
      insTweet(db, { tweet_id: neg, text: `negative ${i} gm wagmi engagement bait rt if you agree`, captured_at: d });
      db.prepare("INSERT INTO reviews (tweet_id, verdict, ts) VALUES (?,?,?)").run(pos, 1, `${d}T01:00:00Z`);
      db.prepare("INSERT INTO reviews (tweet_id, verdict, ts) VALUES (?,?,?)").run(neg, -1, `${d}T01:00:00Z`);
    }
    return db;
  }

  it("ranks the review pool by rubric score and reports correct coverage", () => {
    const db = seedReviewPool();
    // score EVERY reviewed tweet: positives high (9), negatives low (1), at one sha.
    const sha = rubricSha(RUBRIC);
    const ins = db.prepare("INSERT INTO rubric_scores (tweet_id, score, model, rubric_sha, ts) VALUES (?,?,?,?,?)");
    const reviewed = db.prepare("SELECT tweet_id, verdict FROM reviews").all() as any[];
    for (const r of reviewed) ins.run(r.tweet_id, r.verdict === 1 ? 9 : 1, "haiku", sha, "2026-07-04T00:00:00Z");

    const rubric = loadRubricScores(db);
    assert.equal(rubric.sha, sha);
    const res = runEval(buildLabels(db), rubric);

    const arm = res.reviewOnly.rows.find(r => r.name.startsWith("rubric"));
    assert.ok(arm, "rubric arm present in the review pool");
    const kw = res.reviewOnly.rows.find(r => r.name.startsWith("keyword"))!;
    // perfect separation → rubric MAP is a perfect 1.0 and at least matches the keyword baseline.
    assert.equal(arm!.map, 1, `rubric MAP should be perfect on cleanly-separated scores, got ${arm!.map}`);
    assert.ok(arm!.map >= kw.map, "rubric at least ties keyword on this fixture");
    // M12 rethink: every non-keyword review-pool arm carries a paired (arm − keyword) diff CI.
    assert.ok(arm!.diffVsKw, "rubric arm has a diff CI vs keyword");
    assert.ok(!kw.diffVsKw, "keyword carries no diff against itself");

    // coverage: the balanced test pool is fully scored here → scored === total, sha matches.
    assert.ok(res.rubricCoverage, "coverage computed");
    assert.equal(res.rubricCoverage!.scored, res.rubricCoverage!.total, "full coverage on a fully-scored pool");
    assert.equal(res.rubricCoverage!.total, res.reviewOnly.n, "coverage total == balanced review pool n");
    assert.equal(res.rubricCoverage!.sha, sha);
  });

  it("unscored review tweets rank last (missing → below every real score) and lower coverage", () => {
    const db = seedReviewPool();
    const sha = rubricSha(RUBRIC);
    const ins = db.prepare("INSERT INTO rubric_scores (tweet_id, score, model, rubric_sha, ts) VALUES (?,?,?,?,?)");
    // Score ONLY the negatives, high — and leave positives unscored. If missing did NOT sort last,
    // the unscored positives would be indistinguishable; the -1 sentinel must push them below the
    // scored negatives, so the rubric arm should do BADLY (positives at the bottom) and coverage < total.
    const negs = db.prepare("SELECT tweet_id FROM reviews WHERE verdict = -1").all() as any[];
    for (const r of negs) ins.run(r.tweet_id, 8, "haiku", sha, "2026-07-04T00:00:00Z");

    const res = runEval(buildLabels(db), loadRubricScores(db));
    assert.ok(res.rubricCoverage!.scored < res.rubricCoverage!.total, "partial coverage reflected");
    assert.ok(res.rubricCoverage!.scored > 0, "the scored negatives are counted");
    const arm = res.reviewOnly.rows.find(r => r.name.startsWith("rubric"))!;
    // negatives scored high + positives at -1 → an actively WRONG ranking → MAP below a coin flip.
    const rnd = res.reviewOnly.rows.find(r => r.name === "random")!;
    assert.ok(arm.map <= rnd.map + 1e-9, `mis-scored pool should not beat random, got rubric ${arm.map} vs random ${rnd.map}`);
  });

  it("no rubric scores at all → no arm, no coverage (eval still runs)", () => {
    const db = seedReviewPool();
    const res = runEval(buildLabels(db), loadRubricScores(db)); // rubric_scores empty
    assert.equal(res.rubricCoverage!.total, res.reviewOnly.n);
    assert.equal(res.rubricCoverage!.scored, 0, "nothing scored yet");
    // arm IS present (rubric passed) but scores everything -1 → ties; the point is eval doesn't crash.
    assert.ok(res.reviewOnly.rows.length >= 6, "baseline arms all still present");
  });

  it("M9: taste + mix arms ride the review pool only, side by side with keyword/v1/rubric", () => {
    const db = seedReviewPool();
    const sha = rubricSha(RUBRIC);
    const ins = db.prepare("INSERT INTO rubric_scores (tweet_id, score, model, rubric_sha, ts) VALUES (?,?,?,?,?)");
    const reviewed = db.prepare("SELECT tweet_id, verdict FROM reviews").all() as any[];
    for (const r of reviewed) ins.run(r.tweet_id, r.verdict === 1 ? 9 : 1, "haiku", sha, "2026-07-04T00:00:00Z");

    const mix = { taste: buildTaste(db), authorPrior: buildAuthorPrior(db) };
    const res = runEval(buildLabels(db), loadRubricScores(db), mix);

    const names = res.reviewOnly.rows.map(r => r.name);
    assert.ok(names.some(n => n.startsWith("keyword")), "keyword present");
    assert.ok(names.includes("v1 LR (full)"), "v1 present");
    assert.ok(names.some(n => n.startsWith("rubric")), "rubric present");
    assert.ok(names.includes("taste (digest cosine)"), "taste arm present");
    assert.ok(names.includes("mix (M9 digest blend)"), "mix arm present");
    // the M9 arms are review-pool-only — the supplementary pools stay untouched
    for (const pool of [res.sameEra, res.full]) {
      assert.ok(!pool.rows.some(r => r.name.startsWith("mix") || r.name.startsWith("taste (")),
        `no M9 arms in ${pool.pool}`);
    }
    // this fixture has NO likes → taste cosine and author prior are all-zero → the mix reduces to
    // 0.3·z(rubric), and the fully-scored, cleanly-separated pool must rank perfectly. This also
    // pins missing-score handling implicitly: any −1 sentinel leaking into the mix would be a bug
    // caught by the digest snapshot test; here every row is scored.
    const mixRow = res.reviewOnly.rows.find(r => r.name === "mix (M9 digest blend)")!;
    assert.equal(mixRow.map, 1, `mix MAP should be perfect on this fixture, got ${mixRow.map}`);
  });
});
