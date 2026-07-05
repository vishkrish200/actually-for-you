// Run: node --experimental-strip-types --test digest.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { buildTaste, scoreText, buildDigest, buildAuthorPrior, zscores, MIX_WEIGHTS } from "./digest.ts";
import { ensureSchema } from "./rubric.ts";

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
  const t = db.prepare("INSERT INTO tweets (tweet_id,author_handle,author_name,text,created_at,captured_at) VALUES (?,?,?,?,?,?)");
  const lab = db.prepare("INSERT INTO engagement_labels VALUES (?,?,?)");
  // liked tweets: all about AI/LLMs
  const likes = [
    ["L1", "new llm model beats benchmarks on reasoning and agents"],
    ["L2", "training large language models with reinforcement learning"],
    ["L3", "the ai agent uses an llm to plan and call tools"],
    ["L4", "openai and anthropic release new reasoning models"],
  ];
  for (const [id, text] of likes) { t.run(id, "ai", "AI", text, "2026-01-01", "2026-01-01"); lab.run(id, "like", "2026-01-01"); }
  // candidates (un-liked): one AI, one off-topic (shares the stopword-ish "with" → tiny score),
  // one with ZERO token overlap with any like → taste score exactly 0, only explore can surface it
  t.run("C_ai", "x", "X", "this new llm agent model is great at reasoning tasks", "2026-06-01", "2026-06-01");
  t.run("C_off", "y", "Y", "my sourdough bread recipe with garden tomatoes and basil", "2026-06-01", "2026-06-01");
  t.run("C_fin", "z", "Z", "quarterly earnings report shows strong revenue growth for retailers", "2026-06-01", "2026-06-01");
  return db;
}

describe("personalized digest (taste similarity)", () => {
  it("scores an AI tweet far above an off-topic one", () => {
    const db = seed();
    const m = buildTaste(db);
    const ai = scoreText("a new llm reasoning agent from openai", m);
    const off = scoreText("baking bread with tomatoes from my garden", m);
    assert.ok(ai > off, `AI ${ai} should beat off-topic ${off}`);
    assert.ok(ai > 0, "AI tweet should have positive taste score");
  });

  it("buildDigest surfaces the AI candidate, excludes already-liked, ranks AI first", () => {
    const items = buildDigest(seed(), { limit: 10 });
    assert.ok(!items.find(i => i.tweet_id.startsWith("L")), "already-liked tweets excluded");
    assert.equal(items[0]?.tweet_id, "C_ai", "AI candidate ranked first");
  });

  it("a tweet liked AND bookmarked weighs its text ONCE in the profile (set semantics, not 2x)", () => {
    const a = seed();
    const b = seed();
    // same tweet, second engagement source — must not move the centroid at all
    b.prepare("INSERT INTO engagement_labels VALUES (?,?,?)").run("L1", "bookmark", "2026-01-02");
    const probe = "new llm model beats benchmarks"; // overlaps L1's text, so a 2x L1 would inflate it
    const sa = scoreText(probe, buildTaste(a));
    const sb = scoreText(probe, buildTaste(b));
    assert.ok(Math.abs(sa - sb) < 1e-12, `bookmark added to a liked tweet moved the profile: ${sa} vs ${sb}`);
  });

  it("length does not earn score (cosine normalization controls char_len)", () => {
    const m = buildTaste(seed());
    const short = scoreText("llm agent", m);
    // a long off-topic tweet must not outrank a short on-topic one purely on length
    const longOff = scoreText("today i went for a long walk in the park and then cooked dinner and watched a film about nothing".repeat(3), m);
    assert.ok(short > longOff, `short on-topic ${short} must beat long off-topic ${longOff}`);
  });

  it("reviewed tweets leave the digest (👍 and 👎 alike — a vote is a read receipt)", () => {
    const db = seed();
    db.prepare("INSERT INTO reviews (tweet_id, verdict, ts) VALUES (?,?,?)").run("C_ai", -1, "2026-07-03");
    const items = buildDigest(db, { limit: 10 });
    assert.ok(!items.find(i => i.tweet_id === "C_ai"), "reviewed tweet excluded from every lane");
    assert.ok(items.length >= 1, "digest still serves the remaining candidates");
  });

  it("digest items carry parsed media and resolved quoted context (the inline-render payload)", () => {
    const db = seed();
    const t = db.prepare("INSERT INTO tweets (tweet_id,author_handle,author_name,text,media,quoted_id,created_at,captured_at) VALUES (?,?,?,?,?,?,?,?)");
    // a captured quoted tweet + a quoting tweet pointing at it, with media of its own
    t.run("Q_orig", "orig", "Orig", "the original llm agent reasoning benchmark thread",
      '[{"type":"photo","url":"https://pbs.twimg.com/media/orig.jpg"}]', null, "2026-06-01", "2026-06-01");
    t.run("Q_ing", "quoter", "Quoter", "this llm agent reasoning take matters for models",
      '[{"type":"video","url":"https://pbs.twimg.com/vid_thumb.jpg"}]', "Q_orig", "2026-06-02", "2026-06-02");
    // a quoting tweet whose original we never captured
    t.run("Q_miss", "m", "M", "llm agents reasoning models quoted from nowhere", "[]", "GONE", "2026-06-02", "2026-06-02");
    // limit 30 → exploreN 3 ≥ the below-pool-mean candidates, so every row surfaces in SOME lane
    // regardless of where the z-mix cut lands (this test asserts payload shape, not ranking).
    const items = buildDigest(db, { limit: 30 });
    const quoting = items.find(i => i.tweet_id === "Q_ing")!;
    assert.deepEqual(quoting.media, [{ type: "video", url: "https://pbs.twimg.com/vid_thumb.jpg" }], "media parsed to array");
    assert.equal((quoting.quoted as any)?.text, "the original llm agent reasoning benchmark thread", "quoted content joined in");
    assert.deepEqual((quoting.quoted as any)?.media, [{ type: "photo", url: "https://pbs.twimg.com/media/orig.jpg" }], "quoted media included");
    const missing = items.find(i => i.tweet_id === "Q_miss")!;
    assert.deepEqual(missing.quoted, { tweet_id: "GONE" }, "uncaptured quote → bare id marker, not null");
    const plain = items.find(i => i.tweet_id === "C_ai")!;
    assert.equal(plain.quoted, null, "non-quote tweets carry quoted: null");
    assert.ok(!("quoted_id" in plain), "raw quoted_id column not leaked into the payload");
  });

  it("short quote tweets survive the fragment filter (the substance is the quote)", () => {
    const db = seed();
    const t = db.prepare("INSERT INTO tweets (tweet_id,author_handle,author_name,text,media,quoted_id,created_at,captured_at) VALUES (?,?,?,?,?,?,?,?)");
    t.run("Q_orig", "orig", "Orig", "llm agents and reasoning models benchmark results", "[]", null, "2026-06-01", "2026-06-01");
    t.run("Q_short", "s", "S", "this llm.", "[]", "Q_orig", "2026-06-02", "2026-06-02"); // <4 tokens
    t.run("F_short", "f", "F", "lol ok.", "[]", null, "2026-06-02", "2026-06-02");       // <4 tokens, no quote
    const items = buildDigest(db, { limit: 30 }); // exploreN 3 → sub-mean rows still surface (see above)
    assert.ok(items.find(i => i.tweet_id === "Q_short"), "short QUOTE tweet kept");
    assert.ok(!items.find(i => i.tweet_id === "F_short"), "short plain fragment still dropped");
  });

  it("explore lane: surfaces items the taste ranker would never pick, deterministically per seed", () => {
    // C_fin has zero token overlap with the likes, so the mix ranks it below the pool mean and only
    // explore can surface it. limit 20 → exploreN 2 covers both sub-mean candidates (C_off, C_fin),
    // so C_fin's presence is deterministic, not day-hash luck.
    const a = buildDigest(seed(), { limit: 20, seed: "day1" });
    const b = buildDigest(seed(), { limit: 20, seed: "day1" });
    assert.deepEqual(a.map(i => [i.tweet_id, i.lane]), b.map(i => [i.tweet_id, i.lane]), "same seed → same digest");
    const explore = a.filter(i => i.lane === "explore");
    assert.ok(explore.length >= 1, "explore lane present");
    assert.ok(a.some(i => i.tweet_id === "C_fin" && i.lane === "explore"), "zero-score item reachable via explore");
    assert.equal(a[0]?.lane, "taste", "explore never steals the top slot when taste matches exist");
  });
});

describe("M9 weighted mix (named knobs)", () => {
  it("zscores: pool stats over present values; missing → exactly 0 (pool-neutral, never a penalty)", () => {
    assert.deepEqual(zscores([10, 2, null]), [1, -1, 0]); // mean 6, population sd 4
    assert.deepEqual(zscores([5, 5]), [0, 0], "zero variance → all neutral");
    assert.deepEqual(zscores([null, null]), [0, 0], "nothing scored → all neutral");
    assert.deepEqual(zscores([]), []);
  });

  it("buildAuthorPrior: engagement_labels ONLY — prunes out, reviews NEVER counted (CLAUDE.md invariant)", () => {
    const db = seed();
    const t = db.prepare("INSERT INTO tweets (tweet_id,author_id,text,created_at,captured_at) VALUES (?,?,?,?,?)");
    const lab = db.prepare("INSERT INTO engagement_labels VALUES (?,?,?)");
    // FAN: 3 kept likes → log1p(3). One tweet liked as BOTH like+bookmark → still 1 distinct tweet.
    for (const id of ["F1", "F2", "F3"]) { t.run(id, "FAN", `fan tweet ${id}`, "2026-01-01", "2026-01-01"); lab.run(id, "like", "2026-01-01"); }
    lab.run("F1", "bookmark", "2026-01-02");
    // PRUNED: 2 likes, both pruned → no prior.
    for (const id of ["P1", "P2"]) {
      t.run(id, "PRUNED", `crypto tweet ${id}`, "2026-01-01", "2026-01-01"); lab.run(id, "like", "2026-01-01");
      db.prepare("INSERT INTO label_prunes VALUES (?,?,?)").run(id, "crypto", "2026-01-02");
    }
    // REVLIKED: 1 like whose tweet was later hand-reviewed → excluded (the leak guard).
    t.run("R1", "REVLIKED", "liked then reviewed", "2026-01-01", "2026-01-01"); lab.run("R1", "like", "2026-01-01");
    db.prepare("INSERT INTO reviews (tweet_id, verdict, ts) VALUES (?,?,?)").run("R1", 1, "2026-01-02");
    // RONLY: reviews only, zero likes → reviews must NEVER mint a prior.
    t.run("O1", "RONLY", "reviewed but never liked", "2026-01-01", "2026-01-01");
    db.prepare("INSERT INTO reviews (tweet_id, verdict, ts) VALUES (?,?,?)").run("O1", 1, "2026-01-02");

    const prior = buildAuthorPrior(db);
    assert.equal(prior.get("FAN"), Math.log1p(3), "kept likes counted once per distinct tweet");
    assert.equal(prior.get("PRUNED"), undefined, "pruned likes earn no prior");
    assert.equal(prior.get("REVLIKED"), undefined, "liked-then-reviewed tweet excluded (leak guard)");
    assert.equal(prior.get("RONLY"), undefined, "reviews never mint a prior");
    // seed()'s L1–L4 likes carry NULL author_id → no phantom empty-string author
    assert.equal(prior.size, 1);
  });

  it("snapshot: fixed candidates + weights → asserted order (rubric lifts, author lifts, missing rubric is neutral)", () => {
    // Fresh minimal db (not seed()) so the candidate pool is EXACTLY the trio below. All three
    // candidates share identical text → identical taste z (0) → order is decided by rubric/author
    // alone, fully derivable by hand:
    //   rubric z over {10, 2}: mean 6, sd 4 → M_rub +1, M_plain −1, M_auth missing → 0 (neutral)
    //   author prior over {0, log1p(3), 0} → M_auth z +1.414…, others −0.707…
    //   final = 0.3·z_rubric + 0.2·z_author →
    //     M_auth +0.283 > M_rub +0.159 > 0 > M_plain −0.441 (below pool mean → explore-only)
    // M_auth (UNSCORED) outranking M_rub (scored 10) pins the z=0-neutral contract: under eval's −1
    // sentinel M_auth would sink instead. Interleave puts the explore row at index 1.
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE tweets (tweet_id TEXT PRIMARY KEY, author_id TEXT, author_handle TEXT, author_name TEXT,
        text TEXT, media TEXT, quoted_id TEXT, created_at TEXT, captured_at TEXT,
        likes INTEGER, rts INTEGER, replies INTEGER, views INTEGER);
      CREATE TABLE engagement_labels (tweet_id TEXT, source TEXT, ts TEXT, PRIMARY KEY(tweet_id,source));
      CREATE TABLE label_prunes (tweet_id TEXT PRIMARY KEY, reason TEXT, ts TEXT);
      CREATE TABLE reviews (rowid INTEGER PRIMARY KEY AUTOINCREMENT, tweet_id TEXT, verdict INTEGER, ts TEXT);
    `);
    ensureSchema(db); // rubric_scores
    const t = db.prepare("INSERT INTO tweets (tweet_id,author_id,text,created_at,captured_at) VALUES (?,?,?,?,?)");
    // FAN's 3 kept likes (about AI, zero token overlap with the candidate text below)
    for (const id of ["F1", "F2", "F3"]) {
      t.run(id, "FAN", "training large language models with reinforcement learning", "2026-01-01", "2026-01-01");
      db.prepare("INSERT INTO engagement_labels VALUES (?,?,?)").run(id, "like", "2026-01-01");
    }
    const TEXT = "quantum chemistry lab results published in nature today";
    t.run("M_rub", "nobody1", TEXT, "2026-06-01", "2026-06-01");
    t.run("M_auth", "FAN", TEXT, "2026-06-01", "2026-06-01");
    t.run("M_plain", "nobody2", TEXT, "2026-06-01", "2026-06-01");
    const ins = db.prepare("INSERT INTO rubric_scores (tweet_id, score, model, rubric_sha, ts) VALUES (?,?,?,?,?)");
    ins.run("M_rub", 10, "haiku", "testsha", "2026-07-01T00:00:00Z");
    ins.run("M_plain", 2, "haiku", "testsha", "2026-07-01T00:00:00Z");

    const items = buildDigest(db, { limit: 10, seed: "day1" });
    assert.deepEqual(
      items.map(i => [i.tweet_id, i.lane]),
      [["M_auth", "taste"], ["M_plain", "explore"], ["M_rub", "taste"]],
      "asserted order: author-prior lift > scored-10 rubric lift > sub-mean row via explore",
    );
    for (const it of items) {
      assert.ok(Math.abs(it.parts.taste + it.parts.rubric + it.parts.author - it.score) < 1e-12,
        `parts must sum to score for ${it.tweet_id}`);
    }
    const mAuth = items.find(i => i.tweet_id === "M_auth")!;
    assert.equal(mAuth.parts.rubric, 0, "missing rubric contributes exactly 0 — neutral, not −1");
    const mRub = items.find(i => i.tweet_id === "M_rub")!;
    assert.equal(mRub.parts.rubric, MIX_WEIGHTS.rubric * 1, "scored 10 → z=+1 → weighted +0.3");
  });
});
