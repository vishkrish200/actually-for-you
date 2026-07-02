// Run: node --experimental-strip-types --test digest.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { buildTaste, scoreText, buildDigest } from "./digest.ts";

function seed(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE tweets (tweet_id TEXT PRIMARY KEY, author_handle TEXT, author_name TEXT,
      text TEXT, created_at TEXT, captured_at TEXT,
      likes INTEGER, rts INTEGER, replies INTEGER, views INTEGER);
    CREATE TABLE engagement_labels (tweet_id TEXT, source TEXT, ts TEXT, PRIMARY KEY(tweet_id,source));
    CREATE TABLE label_prunes (tweet_id TEXT PRIMARY KEY, reason TEXT, ts TEXT);
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

  it("length does not earn score (cosine normalization controls char_len)", () => {
    const m = buildTaste(seed());
    const short = scoreText("llm agent", m);
    // a long off-topic tweet must not outrank a short on-topic one purely on length
    const longOff = scoreText("today i went for a long walk in the park and then cooked dinner and watched a film about nothing".repeat(3), m);
    assert.ok(short > longOff, `short on-topic ${short} must beat long off-topic ${longOff}`);
  });

  it("explore lane: surfaces items the taste ranker would never pick, deterministically per seed", () => {
    // C_fin scores exactly 0 on taste (zero token overlap), so only explore can surface it.
    const a = buildDigest(seed(), { limit: 10, seed: "day1" });
    const b = buildDigest(seed(), { limit: 10, seed: "day1" });
    assert.deepEqual(a.map(i => [i.tweet_id, i.lane]), b.map(i => [i.tweet_id, i.lane]), "same seed → same digest");
    const explore = a.filter(i => i.lane === "explore");
    assert.ok(explore.length >= 1, "explore lane present");
    assert.ok(a.some(i => i.tweet_id === "C_fin" && i.lane === "explore"), "zero-score item reachable via explore");
    assert.equal(a[0]?.lane, "taste", "explore never steals the top slot when taste matches exist");
  });
});
