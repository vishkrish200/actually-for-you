// Run with: node --experimental-strip-types --test ranker.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { score, mmr, WEIGHTS } from "./ranker.ts";

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
