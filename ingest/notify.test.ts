import { test } from "node:test";
import assert from "node:assert";
import { formatDigest } from "./notify.ts";

test("formatDigest renders handle, lane, truncated text, and link", () => {
  const out = formatDigest([
    { tweet_id: "111", author_handle: "alice", author_name: "Alice", text: "hello world", lane: "fresh", score: 5 } as any,
    { tweet_id: "222", author_handle: "", author_name: "Bob", text: "x".repeat(200), lane: "explore", score: 1 } as any,
  ]);
  assert.match(out, /top 2 ranked/);
  // handle-bearing (newly captured) item gets the ✦ marker
  assert.match(out, /1\. ✦ @alice · fresh/);
  assert.match(out, /https:\/\/x\.com\/i\/web\/status\/111/);
  // no handle -> falls back to display name, never the numeric id, and no ✦
  assert.match(out, /2\. Bob · explore/);
  // text capped at 100 chars
  const bobLine = out.split("\n").find(l => l.startsWith("x"))!;
  assert.ok(bobLine.length <= 100, `expected <=100 chars, got ${bobLine.length}`);
});

test("formatDigest appends a newest-captures-with-handle section", () => {
  const out = formatDigest(
    [{ tweet_id: "1", author_handle: "a", author_name: "A", text: "ranked", lane: "fresh", score: 1 } as any],
    [{ tweet_id: "9", author_handle: "newuser", author_name: "New User", text: "just captured this" }],
  );
  assert.match(out, /🆕 newest captures with handle \(1\)/);
  assert.match(out, /@newuser — just captured this/);
});

test("formatDigest handles missing text", () => {
  const out = formatDigest([{ tweet_id: "1", author_handle: "a", author_name: "", text: null, lane: "backlog", score: 0 } as any]);
  assert.match(out, /\(no text captured\)/);
});
