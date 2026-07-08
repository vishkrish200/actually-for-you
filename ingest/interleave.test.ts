// Run: node --experimental-strip-types --test interleave.test.ts
// M11 team-draft interleaving: the digest-side draft (determinism, blindness, invariants) and the
// read-only interleave.ts report math (credits, day-wins, TIED CI, judged-event floor).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { buildDigest, teamDraft, type Arm, type DigestItem } from "./digest.ts";
import { interleaveReport, JUDGED_FLOOR } from "./interleave.ts";

// A candidate pool where the two arms DISAGREE, so the draft actually interleaves two orderings:
//  - liked tweets are all AI (taste profile + FAN author prior point at AI text).
//  - "kw*" candidates are dense in AI_LEXICON hits but written by cold authors with text unlike the
//    likes → keyword ranks them high, the mix ranks them low.
//  - "mx*" candidates echo the liked text closely + are by FAN (author prior) → the mix ranks them
//    high, but they carry FEW distinct lexicon hits → keyword ranks them lower.
// The result: mix and keyword produce genuinely different orderings, exercising the team-draft.
function seed(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE tweets (tweet_id TEXT PRIMARY KEY, author_id TEXT, author_handle TEXT, author_name TEXT,
      text TEXT, media TEXT, quoted_id TEXT, created_at TEXT, captured_at TEXT,
      likes INTEGER, rts INTEGER, replies INTEGER, views INTEGER);
    CREATE TABLE engagement_labels (tweet_id TEXT, source TEXT, ts TEXT, PRIMARY KEY(tweet_id,source));
    CREATE TABLE label_prunes (tweet_id TEXT PRIMARY KEY, reason TEXT, ts TEXT);
    CREATE TABLE reviews (rowid INTEGER PRIMARY KEY AUTOINCREMENT, tweet_id TEXT, verdict INTEGER, ts TEXT);
  `);
  const t = db.prepare("INSERT INTO tweets (tweet_id,author_id,author_handle,author_name,text,created_at,captured_at) VALUES (?,?,?,?,?,?,?)");
  const lab = db.prepare("INSERT INTO engagement_labels VALUES (?,?,?)");
  // FAN's liked tweets — the taste centroid + a strong author prior for FAN.
  const likes = [
    ["L1", "the sourdough starter needs feeding every morning before the bake"],
    ["L2", "my garden tomatoes and basil are thriving in the summer heat"],
    ["L3", "slow roasted coffee beans make the smoothest pour over"],
    ["L4", "hiking the ridge trail at dawn is the best way to start a weekend"],
  ];
  for (const [id, text] of likes) { t.run(id, "FAN", "fan", "Fan", text, "2026-01-01", "2026-01-01"); lab.run(id, "like", "2026-01-01"); }
  // mx*: close to the liked (non-AI) text AND authored by FAN → high mix (taste + author), low keyword.
  t.run("mx1", "FAN", "fan", "Fan", "feeding the sourdough starter every morning before the summer bake", "2026-06-01", "2026-06-01");
  t.run("mx2", "FAN", "fan", "Fan", "garden tomatoes basil and slow roasted coffee on a weekend morning", "2026-06-01", "2026-06-01");
  t.run("mx3", "FAN", "fan", "Fan", "a dawn hike on the ridge trail then pour over coffee at the summit", "2026-06-01", "2026-06-01");
  // kw*: dense AI_LEXICON hits, cold authors, text nothing like the likes → high keyword, low mix.
  t.run("kw1", "cold1", "c1", "C1", "ai llm gpt agent model neural training inference transformer reasoning", "2026-06-01", "2026-06-01");
  t.run("kw2", "cold2", "c2", "C2", "openai anthropic gemini claude diffusion embedding dataset benchmark agi rl", "2026-06-01", "2026-06-01");
  t.run("kw3", "cold3", "c3", "C3", "prompt prompting rag embeddings gpu cuda pytorch tensor multimodal robotics", "2026-06-01", "2026-06-01");
  return db;
}

describe("M11 team-draft interleaving (digest side)", () => {
  it("MATCHUP=null reproduces the pre-M11 M9 mix digest exactly (arm=null on every item)", () => {
    // The regression proof: with interleaving OFF the slate is the plain M9 mix, and arm is null
    // everywhere (taste AND explore). Same seed → deterministic; two builds are byte-identical. The
    // kw* candidates fall below the mix pool mean (cold authors, off-taste text), so only mx* make
    // the taste lane and one kw rides explore — exactly the pre-M11 shape.
    const a = buildDigest(seed(), { limit: 10, seed: "day1", matchup: null });
    const b = buildDigest(seed(), { limit: 10, seed: "day1", matchup: null });
    assert.deepEqual(a, b, "matchup:null is deterministic per seed");
    assert.ok(a.every(i => i.arm === null), "no item carries a drafting arm when interleaving is off");
    assert.deepEqual(a.map(i => [i.tweet_id, i.lane]), [
      ["mx1", "taste"], ["kw2", "explore"], ["mx2", "taste"], ["mx3", "taste"],
    ], "the plain M9 mix slate: taste+author candidates ranked, a cold keyword tweet only via explore");
  });

  it("determinism snapshot: fixed candidates + fixed seed → asserted slate order AND arm attributions", () => {
    // Order-sensitive code gets a snapshot (CLAUDE.md). Locked to the deterministic team-draft output
    // for seed 'day1'; a change to the draft/PRNG/ranking will trip this and demand a conscious relock.
    // limit 6 → exploreN 1, slots 5: five of the six candidates are drafted (mix takes mx1/mx2,
    // keyword takes kw2/kw3/kw1 in the seeded pick order), the leftover mx3 rides the explore lane
    // (interleaved at index 2), arm=null. The badge is blind — every row still carries a mix score.
    const items = buildDigest(seed(), { limit: 6, seed: "day1" }); // default MATCHUP = ["mix","keyword"]
    const slate = items.map(i => [i.tweet_id, i.lane, i.arm] as const);
    assert.deepEqual(slate, [
      ["mx1", "taste", "mix"],
      ["kw2", "taste", "keyword"],
      ["mx3", "explore", null],
      ["mx2", "taste", "mix"],
      ["kw3", "taste", "keyword"],
      ["kw1", "taste", "keyword"],
    ], "deterministic interleaved slate: mix and keyword picks interleave by the seeded draft order, explore woven in arm=null");
  });

  it("both arms appear; no tweet is drafted twice; explore rows carry arm=null", () => {
    const items = buildDigest(seed(), { limit: 6, seed: "day1" });
    const drafted = items.filter(i => i.lane === "taste");
    const armsSeen = new Set(drafted.map(i => i.arm));
    assert.ok(armsSeen.has("mix") && armsSeen.has("keyword"), "both matchup arms drafted at least one slot");
    const ids = items.map(i => i.tweet_id);
    assert.equal(ids.length, new Set(ids).size, "no duplicate tweet_id across the whole slate");
    assert.ok(drafted.every(i => i.arm === "mix" || i.arm === "keyword"), "every taste slot records its drafting arm");
    assert.ok(items.filter(i => i.lane === "explore").every(i => i.arm === null), "explore rows are arm-agnostic (arm=null)");
  });

  it("explore lane survives interleaving (~10%, present, deterministic per seed)", () => {
    // limit 6 → exploreN = round(6/10) = 1, slots = 5. Six candidates: five drafted, the un-drafted
    // tail (mx3) surfaces via explore. Explore must still exist, be interleaved, and be arm=null.
    const a = buildDigest(seed(), { limit: 6, seed: "day1" });
    const b = buildDigest(seed(), { limit: 6, seed: "day1" });
    assert.deepEqual(a.map(i => [i.tweet_id, i.lane, i.arm]), b.map(i => [i.tweet_id, i.lane, i.arm]),
      "interleaved digest is deterministic per seed (explore included)");
    const explore = a.filter(i => i.lane === "explore");
    assert.equal(explore.length, 1, "explore lane present under interleaving (~10% of the slate)");
    assert.ok(explore.every(i => i.arm === null), "explore items carry no arm");
  });

  it("teamDraft: each team drafts its own top not-yet-taken pick; no cross-team duplicates", () => {
    // Two disjoint rankings over a shared pool. Whatever the seeded pick order, every id appears once
    // and each is stamped with the team that drafted it (a pick from rankA is armA, from rankB armB).
    const mk = (id: string): DigestItem => ({
      tweet_id: id, author_handle: null, author_name: null, text: id, media: [], quoted: null,
      created_at: null, likes: null, rts: null, replies: null, views: null,
      score: 0, parts: { taste: 0, rubric: 0, author: 0 }, lane: "taste", arm: null,
    });
    const rankA = ["a1", "a2", "a3"].map(mk);
    const rankB = ["b1", "b2", "b3"].map(mk);
    const out = teamDraft(rankA, rankB, "mix", "keyword", "seedX", 6);
    const ids = out.map(o => o.tweet_id);
    assert.equal(ids.length, 6, "all six slots filled from the two 3-long rankings");
    assert.equal(new Set(ids).size, 6, "no duplicate picks");
    assert.ok(out.filter(o => o.arm === "mix").every(o => o.tweet_id.startsWith("a")), "mix-stamped picks all came from rankA");
    assert.ok(out.filter(o => o.arm === "keyword").every(o => o.tweet_id.startsWith("b")), "keyword-stamped picks all came from rankB");
    assert.equal(out.filter(o => o.arm === "mix").length, 3, "team-draft is balanced (3 each from equal-length rankings)");
  });
});

// ---- interleave.ts report math ----
// Fixture: mix drafted A(rank1) & C(rank3); keyword drafted B(rank2) & D(rank4), all on 2026-07-06.
// Net credit = opens + 👍 − 👎. A opened + 👍 (+2). B opened (keyword +1). C 👎 (−1, still 1 judged).
// D nothing. Second day 2026-07-07: mix drafts E (opened → +1), keyword drafts F (nothing). So mix
// nets 2 (A:+2, C:−1, E:+1) and keyword nets 1 (B) — and the 👎 on C makes day 07-06 a 1–1 tie.
// Judged events = opens(A,B,E)=3 + votes(A,C)=2 = 5 → BELOW the floor, so the base fixture refuses.
function reportSeed(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE digest_log (rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      digest_date TEXT, channel TEXT, tweet_id TEXT, rank INTEGER, lane TEXT,
      score REAL, parts TEXT, ts TEXT, arm TEXT);
    CREATE TABLE digest_opens (rowid INTEGER PRIMARY KEY AUTOINCREMENT, tweet_id TEXT, ts TEXT);
    CREATE TABLE reviews (rowid INTEGER PRIMARY KEY AUTOINCREMENT, tweet_id TEXT, verdict INTEGER, ts TEXT);
  `);
  const serve = db.prepare("INSERT INTO digest_log (digest_date,channel,tweet_id,rank,lane,score,parts,ts,arm) VALUES (?,?,?,?,?,1.0,'{}',?,?)");
  serve.run("2026-07-06", "web", "A", 1, "taste", "2026-07-06T08:00:00Z", "mix");
  serve.run("2026-07-06", "web", "B", 2, "taste", "2026-07-06T08:00:00Z", "keyword");
  serve.run("2026-07-06", "web", "C", 3, "taste", "2026-07-06T08:00:00Z", "mix");
  serve.run("2026-07-06", "web", "D", 4, "taste", "2026-07-06T08:00:00Z", "keyword");
  serve.run("2026-07-06", "web", "X", 5, "explore", "2026-07-06T08:00:00Z", null); // explore: arm NULL, must be ignored
  serve.run("2026-07-07", "web", "E", 1, "taste", "2026-07-07T08:00:00Z", "mix");
  serve.run("2026-07-07", "web", "F", 2, "taste", "2026-07-07T08:00:00Z", "keyword");
  const open = db.prepare("INSERT INTO digest_opens (tweet_id, ts) VALUES (?,?)");
  open.run("A", "2026-07-06T08:05:00Z");
  open.run("B", "2026-07-06T08:06:00Z");
  open.run("E", "2026-07-07T08:05:00Z");
  open.run("X", "2026-07-06T08:07:00Z"); // open on an explore (arm-null) serve — never credited to an arm
  const vote = db.prepare("INSERT INTO reviews (tweet_id, verdict, ts) VALUES (?,?,?)");
  vote.run("A", 1, "2026-07-06T08:10:00Z");   // mix 👍
  vote.run("C", -1, "2026-07-06T08:11:00Z");  // mix 👎
  return db;
}

// Add enough opens to clear the judged-event floor, keeping mix ahead so the CI leans (not TIED).
function reportSeedAboveFloor(): DatabaseSync {
  const db = reportSeed();
  const serve = db.prepare("INSERT INTO digest_log (digest_date,channel,tweet_id,rank,lane,score,parts,ts,arm) VALUES (?,?,?,?,?,1.0,'{}',?,?)");
  const open = db.prepare("INSERT INTO digest_opens (tweet_id, ts) VALUES (?,?)");
  // 30 more days, each: mix serves a tweet that gets opened (credit), keyword serves one that doesn't.
  for (let d = 10; d < 40; d++) {
    const date = `2026-08-${String(d).padStart(2, "0")}`;
    const ts = `${date}T08:00:00Z`;
    serve.run(date, "web", `M${d}`, 1, "taste", ts, "mix");
    serve.run(date, "web", `K${d}`, 2, "taste", ts, "keyword");
    open.run(`M${d}`, `${date}T08:05:00Z`); // mix credit every day → mix clearly ahead
  }
  return db;
}

describe("M11 interleave report (read-only math)", () => {
  it("refuses a verdict below the judged-event floor, but still prints coverage", () => {
    const r = interleaveReport(reportSeed());
    // Per-arm credits are still computed (coverage always prints).
    const mix = r.arms.find(a => a.arm === "mix")!;
    const kw = r.arms.find(a => a.arm === "keyword")!;
    assert.equal(mix.served, 3, "mix drafted A, C (day1) + E (day2)"); // arm-attributed first serves
    assert.equal(mix.opened, 2, "A and E opened"); // C not opened
    assert.equal(mix.up, 1, "A 👍");
    assert.equal(mix.down, 1, "C 👎");
    assert.equal(mix.credits, 2, "net credit = opens(2) + 👍(1) − 👎(1)");
    assert.equal(kw.served, 3, "keyword drafted B, D (day1) + F (day2)");
    assert.equal(kw.opened, 1, "only B opened");
    assert.equal(kw.credits, 1, "net credit = opens(1) + 👍(0) − 👎(0)");
    // Judged = opens(A,B,E)=3 + votes(A,C)=2 = 5 < 30.
    assert.equal(r.judged, 5);
    assert.match(r.verdict, /insufficient data \(5 judged events, floor 30\)/);
    assert.ok(!r.diffCI, "no CI computed below the floor");
  });

  it("explore serves (arm=NULL) and their opens are never credited to an arm", () => {
    const r = interleaveReport(reportSeed());
    const total = r.arms.reduce((n, a) => n + a.served, 0);
    assert.equal(total, 6, "only the 6 arm-attributed serves count; the explore (X) row is excluded");
    assert.ok(!r.arms.some(a => a.opened > 0 && a.arm !== "mix" && a.arm !== "keyword"), "no phantom arm from explore opens");
  });

  it("day-level wins: the arm with more credits wins the day; ties counted separately", () => {
    // day 2026-07-06: mix credits = A(open+👍=2) + C(👎=−1) = 1; keyword = B(open=1) + D(0) = 1 → TIE
    // (the 👎 on C drags mix to parity — before net credit this was a 2–1 mix win, not a tie).
    // day 2026-07-07: mix credits = E(open=1) = 1; keyword = F(0) = 0 → mix wins. So mix 1, kw 0, 1 tie.
    const r = interleaveReport(reportSeed());
    assert.deepEqual(r.dayWins.map(d => ({ ...d })), [
      { arm: "keyword", days_won: 0 },
      { arm: "mix", days_won: 1 },
    ]);
    assert.equal(r.tiedDays, 1);
  });

  it("above the floor: paired-bootstrap CI produces a LEAN when one arm dominates every day", () => {
    const r = interleaveReport(reportSeedAboveFloor());
    assert.ok(r.judged >= JUDGED_FLOOR, `judged ${r.judged} clears the floor ${JUDGED_FLOOR}`);
    assert.ok(r.diffCI, "CI computed above the floor");
    const [lo, , hi] = r.diffCI!;
    // Arms sort alphabetically → armA=keyword, armB=mix, so the diff is (keyword − mix). mix opens a
    // drafted tweet every day while keyword opens none → mix's credit rate dominates → the whole CI
    // sits strictly BELOW 0, and the verdict names the leader (mix) regardless of the diff sign.
    assert.ok(lo < 0 && hi < 0, `(keyword − mix) CI [${lo}, ${hi}] strictly < 0 → excludes 0`);
    assert.match(r.verdict, /LEAN mix/);
  });

  it("above the floor with symmetric credits → CI straddles 0 → TIED", () => {
    // Both arms open exactly one drafted tweet per day → identical credit rates → diff ~0 every
    // resample → CI straddles 0. Clears the floor via the open volume.
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE digest_log (rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        digest_date TEXT, channel TEXT, tweet_id TEXT, rank INTEGER, lane TEXT, score REAL, parts TEXT, ts TEXT, arm TEXT);
      CREATE TABLE digest_opens (rowid INTEGER PRIMARY KEY AUTOINCREMENT, tweet_id TEXT, ts TEXT);
      CREATE TABLE reviews (rowid INTEGER PRIMARY KEY AUTOINCREMENT, tweet_id TEXT, verdict INTEGER, ts TEXT);
    `);
    const serve = db.prepare("INSERT INTO digest_log (digest_date,channel,tweet_id,rank,lane,score,parts,ts,arm) VALUES (?,?,?,?,?,1.0,'{}',?,?)");
    const open = db.prepare("INSERT INTO digest_opens (tweet_id, ts) VALUES (?,?)");
    for (let d = 1; d <= 35; d++) {
      const date = `2026-09-${String(d).padStart(2, "0")}`, ts = `${date}T08:00:00Z`;
      serve.run(date, "web", `M${d}`, 1, "taste", ts, "mix");
      serve.run(date, "web", `K${d}`, 2, "taste", ts, "keyword");
      open.run(`M${d}`, `${date}T08:05:00Z`); // 1 mix credit
      open.run(`K${d}`, `${date}T08:06:00Z`); // 1 keyword credit — symmetric
    }
    const r = interleaveReport(db);
    assert.ok(r.judged >= JUDGED_FLOOR);
    const [lo, , hi] = r.diffCI!;
    assert.ok(lo <= 0 && hi >= 0, `symmetric credits → CI [${lo}, ${hi}] straddles 0`);
    assert.match(r.verdict, /TIED/);
  });

  it("a db predating the arm column → insufficient-data, read-only (no throw)", () => {
    // Real afy.db until the server restarts: digest_log has no `arm` column. Must not throw.
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE digest_log (digest_date TEXT, channel TEXT, tweet_id TEXT, rank INTEGER, lane TEXT, score REAL, parts TEXT, ts TEXT);
      CREATE TABLE digest_opens (tweet_id TEXT, ts TEXT);
      CREATE TABLE reviews (tweet_id TEXT, verdict INTEGER, ts TEXT);`);
    const r = interleaveReport(db);
    assert.equal(r.arms.length, 0);
    assert.equal(r.judged, 0);
    assert.match(r.verdict, /no .?arm.? column yet/);
  });

  it("a down-only day RESOLVES instead of tying 0–0: two 👎 to arm A → arm B wins the day", () => {
    // Before net credit this day had no opens/👍 → 0–0 tie. Now mix's two 👎 debit it to −2 while
    // keyword sits at 0, so keyword wins the day it never used to (0 > −2). Direct proof the 👎 counts.
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE digest_log (rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        digest_date TEXT, channel TEXT, tweet_id TEXT, rank INTEGER, lane TEXT, score REAL, parts TEXT, ts TEXT, arm TEXT);
      CREATE TABLE digest_opens (rowid INTEGER PRIMARY KEY AUTOINCREMENT, tweet_id TEXT, ts TEXT);
      CREATE TABLE reviews (rowid INTEGER PRIMARY KEY AUTOINCREMENT, tweet_id TEXT, verdict INTEGER, ts TEXT);
    `);
    const serve = db.prepare("INSERT INTO digest_log (digest_date,channel,tweet_id,rank,lane,score,parts,ts,arm) VALUES (?,?,?,?,?,1.0,'{}',?,?)");
    const vote = db.prepare("INSERT INTO reviews (tweet_id, verdict, ts) VALUES (?,?,?)");
    serve.run("2026-10-01", "web", "P", 1, "taste", "2026-10-01T08:00:00Z", "mix");
    serve.run("2026-10-01", "web", "Q", 2, "taste", "2026-10-01T08:00:00Z", "mix");
    serve.run("2026-10-01", "web", "R", 3, "taste", "2026-10-01T08:00:00Z", "keyword");
    vote.run("P", -1, "2026-10-01T08:10:00Z"); // mix 👎
    vote.run("Q", -1, "2026-10-01T08:11:00Z"); // mix 👎
    const r = interleaveReport(db);
    const mix = r.arms.find(a => a.arm === "mix")!;
    assert.equal(mix.down, 2, "both 👎 attributed to mix");
    assert.equal(mix.credits, -2, "net credit = 0 opens + 0 👍 − 2 👎");
    assert.deepEqual(r.dayWins.map(d => ({ ...d })), [
      { arm: "keyword", days_won: 1 }, // keyword(0) > mix(−2) → keyword wins a day that used to tie 0–0
      { arm: "mix", days_won: 0 },
    ]);
    assert.equal(r.tiedDays, 0, "no longer a 0–0 tie — the downvotes resolve the day");
  });

  it("net-negative credits: credit_rate goes negative (not clamped) and the report still verdicts", () => {
    // mix draws a 👎 every day with no opens/👍 → net −1/day → credit_rate −1.0. keyword opens a card
    // every day → +1/day. Downs also carry the judged floor, so the CI computes and must LEAN keyword.
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE digest_log (rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        digest_date TEXT, channel TEXT, tweet_id TEXT, rank INTEGER, lane TEXT, score REAL, parts TEXT, ts TEXT, arm TEXT);
      CREATE TABLE digest_opens (rowid INTEGER PRIMARY KEY AUTOINCREMENT, tweet_id TEXT, ts TEXT);
      CREATE TABLE reviews (rowid INTEGER PRIMARY KEY AUTOINCREMENT, tweet_id TEXT, verdict INTEGER, ts TEXT);
    `);
    const serve = db.prepare("INSERT INTO digest_log (digest_date,channel,tweet_id,rank,lane,score,parts,ts,arm) VALUES (?,?,?,?,?,1.0,'{}',?,?)");
    const open = db.prepare("INSERT INTO digest_opens (tweet_id, ts) VALUES (?,?)");
    const vote = db.prepare("INSERT INTO reviews (tweet_id, verdict, ts) VALUES (?,?,?)");
    for (let d = 1; d <= 35; d++) {
      const date = `2026-12-${String(d).padStart(2, "0")}`, ts = `${date}T08:00:00Z`;
      serve.run(date, "web", `M${d}`, 1, "taste", ts, "mix");
      serve.run(date, "web", `K${d}`, 2, "taste", ts, "keyword");
      vote.run(`M${d}`, -1, `${date}T08:10:00Z`); // mix 👎 every day → mix net negative
      open.run(`K${d}`, `${date}T08:05:00Z`);     // keyword opened every day → keyword positive
    }
    const r = interleaveReport(db);
    const mix = r.arms.find(a => a.arm === "mix")!;
    const kw = r.arms.find(a => a.arm === "keyword")!;
    assert.equal(mix.credits, -35, "35 👎, no opens/👍 → −35 net credit");
    assert.ok(mix.credit_rate < 0, `mix credit_rate ${mix.credit_rate} is negative (not clamped)`);
    assert.equal(mix.credit_rate, -1, "−35 credits / 35 served = −1.0");
    assert.equal(kw.credits, 35, "keyword opened 35 cards");
    assert.ok(r.judged >= JUDGED_FLOOR, `downs carry the floor: ${r.judged} judged`);
    assert.ok(r.diffCI, "CI computed above the floor even with negative credits");
    // armA=keyword, armB=mix; keyword_rate(1.0) − mix_rate(−1.0) > 0 → whole CI > 0 → LEAN keyword.
    const [lo, , hi] = r.diffCI!;
    assert.ok(lo > 0 && hi > 0, `(keyword − mix) CI [${lo}, ${hi}] strictly > 0`);
    assert.match(r.verdict, /LEAN keyword/);
  });

  it("a 👎 on an explore serve (arm NULL) never credits, debits, nor counts toward the floor", () => {
    // The downvote-side mirror of the explore-open exclusion: an arm-NULL serve that gets 👎'd must
    // leave every arm untouched (VOTE_ARM_SERVE joins only arm-attributed serves).
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE digest_log (rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        digest_date TEXT, channel TEXT, tweet_id TEXT, rank INTEGER, lane TEXT, score REAL, parts TEXT, ts TEXT, arm TEXT);
      CREATE TABLE digest_opens (rowid INTEGER PRIMARY KEY AUTOINCREMENT, tweet_id TEXT, ts TEXT);
      CREATE TABLE reviews (rowid INTEGER PRIMARY KEY AUTOINCREMENT, tweet_id TEXT, verdict INTEGER, ts TEXT);
    `);
    const serve = db.prepare("INSERT INTO digest_log (digest_date,channel,tweet_id,rank,lane,score,parts,ts,arm) VALUES (?,?,?,?,?,1.0,'{}',?,?)");
    const vote = db.prepare("INSERT INTO reviews (tweet_id, verdict, ts) VALUES (?,?,?)");
    serve.run("2026-11-01", "web", "A", 1, "taste", "2026-11-01T08:00:00Z", "mix");
    serve.run("2026-11-01", "web", "B", 2, "taste", "2026-11-01T08:00:00Z", "keyword");
    serve.run("2026-11-01", "web", "X", 3, "explore", "2026-11-01T08:00:00Z", null); // explore: arm NULL
    vote.run("X", -1, "2026-11-01T08:10:00Z"); // 👎 on the explore card — must vanish from arm credit
    const r = interleaveReport(db);
    const mix = r.arms.find(a => a.arm === "mix")!;
    const kw = r.arms.find(a => a.arm === "keyword")!;
    assert.equal(mix.down, 0, "explore 👎 not charged to mix");
    assert.equal(kw.down, 0, "explore 👎 not charged to keyword");
    assert.equal(mix.credits, 0, "no debit from the arm-NULL 👎");
    assert.equal(kw.credits, 0, "no debit from the arm-NULL 👎");
    assert.equal(r.judged, 0, "an arm-NULL 👎 is never attributed → never counts toward the floor");
  });
});
