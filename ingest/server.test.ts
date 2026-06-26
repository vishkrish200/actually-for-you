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

  it("DOM content fills a gap the network never captured", async () => {
    const dom = { ...tweet, tweet_id: "dom1", text: "scraped", source: "dom",
      metrics: { likes: 0, rts: 0, replies: 0 } };
    await post({ tweets: [dom] });
    const row = db.prepare("SELECT text, source FROM tweets WHERE tweet_id='dom1'").get() as any;
    assert.equal(row.text, "scraped");
    assert.equal(row.source, "dom");
  });

  it("network record wins over a DOM record in the same batch, regardless of order", async () => {
    const net = { ...tweet, tweet_id: "race1", text: "net-rich", source: "net",
      metrics: { likes: 42, rts: 0, replies: 0 } };
    const dom = { ...tweet, tweet_id: "race1", text: "dom-poor", source: "dom",
      metrics: { likes: 0, rts: 0, replies: 0 } };
    // DOM listed FIRST in the array — ingest must still let the net record win.
    await post({ tweets: [dom, net] });
    const row = db.prepare("SELECT text, likes, source FROM tweets WHERE tweet_id='race1'").get() as any;
    assert.equal(row.text, "net-rich");
    assert.equal(row.likes, 42);
    assert.equal(row.source, "net");
  });

  it("a later DOM batch does not clobber an existing network row", async () => {
    const net = { ...tweet, tweet_id: "keep1", text: "net-rich", source: "net" };
    await post({ tweets: [net] });
    const dom = { ...tweet, tweet_id: "keep1", text: "dom-poor", source: "dom" };
    await post({ tweets: [dom] });
    const row = db.prepare("SELECT text, source FROM tweets WHERE tweet_id='keep1'").get() as any;
    assert.equal(row.text, "net-rich");
    assert.equal(row.source, "net");
  });

  it("harvests confirmed positives from Likes/Bookmarks into engagement_labels", async () => {
    await post({ confirmed: [
      { source: "like", ids: ["lk1", "lk2"] },
      { source: "bookmark", ids: ["bm1"] },
    ]});
    const likes = (db.prepare("SELECT COUNT(*) n FROM engagement_labels WHERE source='like'").get() as any).n;
    const bms = (db.prepare("SELECT COUNT(*) n FROM engagement_labels WHERE source='bookmark'").get() as any).n;
    assert.equal(likes, 2);
    assert.equal(bms, 1);
  });

  it("re-scrolling the Likes tab doesn't duplicate a label (idempotent on tweet_id+source)", async () => {
    await post({ confirmed: [{ source: "like", ids: ["lk1", "lk1", "lk3"] }] });
    const n = (db.prepare("SELECT COUNT(*) n FROM engagement_labels WHERE source='like'").get() as any).n;
    assert.equal(n, 3); // lk1 (already present, deduped), lk2 (prior test), lk3 — not 4+
  });

  it("same tweet can be both liked AND bookmarked (distinct rows)", async () => {
    await post({ confirmed: [{ source: "like", ids: ["both1"] }, { source: "bookmark", ids: ["both1"] }] });
    const n = (db.prepare("SELECT COUNT(*) n FROM engagement_labels WHERE tweet_id='both1'").get() as any).n;
    assert.equal(n, 2);
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
