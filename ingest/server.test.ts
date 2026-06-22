// Run with: node --experimental-strip-types server.test.ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";

process.env.AFY_DB = ":memory:";

const { db, server } = await import("./server.ts");

const PORT = 12727;

function post(body: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ port: PORT, path: "/ingest", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
    }, res => {
      let raw = "";
      res.on("data", c => { raw += c; });
      res.on("end", () => resolve({ status: res.statusCode!, json: JSON.parse(raw) }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

before(() => new Promise<void>(r => server.listen(PORT, r)));
after(() => new Promise<void>(r => server.close(r)));

const tweet = {
  tweet_id: "t1", author_handle: "user", author_id: "u1", text: "hello",
  media: [], is_thread: false, created_at: "2026-01-01T00:00:00Z",
  metrics: { likes: 1, rts: 0, replies: 0 }, captured_at: "2026-01-01T00:00:01Z",
};

const impression = {
  impression_id: "imp-1", tweet_id: "t1", session_id: "s1",
  ts: "2026-01-01T00:00:00Z", position_in_feed: 0, dwell_ms: 1500,
  max_visible_pct: 0.9, scroll_velocity_at_entry: 0.5, flicked: false,
  opened_detail: false, profile_expanded: "none",
  liked: false, rt: false, bookmarked: false, replied: false,
  media_present: false, is_thread: false, char_len: 5,
};

describe("ingest server", () => {
  it("persists tweets and impressions", async () => {
    const res = await post({ tweets: [tweet], impressions: [impression] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true });
    const tCount = (db.prepare("SELECT COUNT(*) as n FROM tweets").get() as any).n;
    const iCount = (db.prepare("SELECT COUNT(*) as n FROM impressions").get() as any).n;
    assert.equal(tCount, 1);
    assert.equal(iCount, 1);
  });

  it("idempotent: same impression_id twice → 1 row", async () => {
    await post({ impressions: [impression] });
    const n = (db.prepare("SELECT COUNT(*) as n FROM impressions").get() as any).n;
    assert.equal(n, 1);
  });

  it("idempotent: same tweet_id twice → 1 row", async () => {
    await post({ tweets: [tweet] });
    const n = (db.prepare("SELECT COUNT(*) as n FROM tweets").get() as any).n;
    assert.equal(n, 1);
  });

  it("append-only: no UPDATE or DELETE in server.ts", () => {
    const src = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
    assert.ok(!(/\bUPDATE\b/i).test(src), "found UPDATE in server.ts");
    assert.ok(!(/\bDELETE\b/i).test(src), "found DELETE in server.ts");
  });

  it("persists capture_health events", async () => {
    await post({ health: [{ ts: "2026-01-01T00:00:00Z", kind: "hook_error", detail: "test" }] });
    const n = (db.prepare("SELECT COUNT(*) as n FROM capture_health").get() as any).n;
    assert.equal(n, 1);
  });
});
