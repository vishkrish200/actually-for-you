import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { DigestItem } from "./digest.ts";
import { sanitizePublicFeedItems } from "./public_feed.ts";

function item(id: string, quoted: DigestItem["quoted"] = null): DigestItem {
  return {
    tweet_id: id,
    author_handle: "public_user",
    author_name: "Public User",
    author_profile: JSON.stringify({ bio: "private payload must not leave" }),
    text: "A public post",
    media: [
      { type: "photo", url: "https://pbs.twimg.com/media/example.jpg" },
      { type: "photo", url: "https://tracker.example/pixel.jpg" },
      { type: "card", url: "https://tracker.example/card.jpg", title: "Useful link", domain: "example.com", link: "https://example.com/read" },
      { type: "card", url: "", title: "Bad link", domain: "bad.test", link: "javascript:alert(1)" },
    ] as DigestItem["media"],
    quoted,
    created_at: "2026-07-20T00:00:00.000Z",
    likes: 12,
    rts: 3,
    replies: 2,
    views: 900,
    score: 99,
    parts: { taste: 1, rubric: 2, author: 3 },
    lane: "taste",
    arm: "review_lr",
  };
}

function fixtureDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE tweets (tweet_id TEXT PRIMARY KEY, author_avatar TEXT)");
  db.prepare("INSERT INTO tweets VALUES (?, ?)").run("main", "https://pbs.twimg.com/profile_images/avatar_normal.jpg");
  return db;
}

describe("public feed sanitizer", () => {
  it("publishes only verified tweets and strips private ranking metadata", async () => {
    const db = fixtureDb();
    const result = await sanitizePublicFeedItems(db, [item("main"), item("hidden")], {
      verify: async id => id === "main",
    });

    assert.equal(result.length, 1);
    assert.equal(result[0].tweet_id, "main");
    assert.deepEqual(result[0].badge, { kind: "taste", value: 92 });
    assert.equal(result[0].author_avatar, "https://pbs.twimg.com/profile_images/avatar_normal.jpg");
    assert.deepEqual(result[0].media, [
      { type: "photo", url: "https://pbs.twimg.com/media/example.jpg" },
      { type: "card", title: "Useful link", link: "https://example.com/read", domain: "example.com" },
    ]);
    for (const privateKey of ["score", "parts", "lane", "arm", "author_profile", "dwell", "verdict"]) {
      assert.equal(privateKey in result[0], false, `${privateKey} must not enter the public payload`);
    }
  });

  it("omits captured quote content unless the quoted tweet is independently public", async () => {
    const db = fixtureDb();
    const quoted = {
      tweet_id: "quote",
      author_handle: "protected_user",
      author_name: "Protected User",
      text: "This must stay private",
      media: [],
      created_at: "2026-07-19T00:00:00.000Z",
    };

    const hidden = await sanitizePublicFeedItems(db, [item("main", quoted)], {
      verify: async id => id === "main",
    });
    assert.equal(hidden[0].quoted, null);

    const visible = await sanitizePublicFeedItems(db, [item("main", quoted)], {
      verify: async () => true,
    });
    assert.equal(visible[0].quoted?.tweet_id, "quote");
    assert.equal(visible[0].quoted?.url, "https://x.com/protected_user/status/quote");
  });

  it("keeps the explore marker without exposing the underlying lane or raw score", async () => {
    const db = fixtureDb();
    const explore = { ...item("main"), lane: "explore" as const, arm: null };
    const [result] = await sanitizePublicFeedItems(db, [explore], { verify: async () => true });
    assert.deepEqual(result.badge, { kind: "explore" });
    assert.equal("lane" in result, false);
    assert.equal("score" in result, false);
  });
});
