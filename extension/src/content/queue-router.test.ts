import { describe, it, expect } from "vitest";
import { partition, type QueuedEvent } from "./queue-router";

describe("queue partition", () => {
  it("splits a mixed durable queue back into the three ingest arrays", () => {
    const rows: QueuedEvent[] = [
      { __k: "impression", v: { impression_id: "i1" } },
      { __k: "tweets", v: [{ tweet_id: "t1" }, { tweet_id: "t2" }] }, // a batch flattens
      { __k: "impression", v: { impression_id: "i2" } },
      { __k: "health", v: { kind: "hook_error" } },
      { __k: "tweets", v: [{ tweet_id: "t3" }] },
    ];
    const { impressions, tweets, health } = partition(rows);
    expect(impressions.map((i: any) => i.impression_id)).toEqual(["i1", "i2"]);
    expect(tweets.map((t: any) => t.tweet_id)).toEqual(["t1", "t2", "t3"]);
    expect(health).toHaveLength(1);
  });

  it("empty / malformed rows don't throw", () => {
    const { impressions, tweets, health } = partition([null as any, { __k: "tweets", v: null as any }]);
    expect(impressions).toHaveLength(0);
    expect(tweets).toHaveLength(0);
    expect(health).toHaveLength(0);
  });
});
