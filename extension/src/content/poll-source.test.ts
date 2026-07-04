import { describe, it, expect } from "vitest";
import { tagTweets, shouldEmitImpression } from "./poll-source";
import type { TweetRecord } from "../types";

// A minimal but complete TweetRecord — only source varies across cases.
function tweet(overrides: Partial<TweetRecord> = {}): TweetRecord {
  return {
    tweet_id: "t1", author_handle: "u", author_name: "U", author_id: "u1",
    text: "hi", media: [], is_thread: false, created_at: "2026-01-01T00:00:00Z",
    metrics: { likes: 0, rts: 0, replies: 0 }, captured_at: "2026-01-01T00:00:01Z",
    ...overrides,
  };
}

describe("M7 poller-tab source policy", () => {
  it("poller tab: every outgoing tweet is tagged source:'poll'", () => {
    const out = tagTweets([tweet({ tweet_id: "a" }), tweet({ tweet_id: "b" })], true);
    expect(out.map(t => t.source)).toEqual(["poll", "poll"]);
  });

  it("poller tab: overrides a dom source to poll (whole tab is candidate-only)", () => {
    // The DOM scraper hands us source:'dom'; on the poller tab it must become 'poll' so the server's
    // net > dom > poll precedence treats it as the weakest tier, upgradable by any organic capture.
    const out = tagTweets([tweet({ source: "dom" })], true);
    expect(out[0].source).toBe("poll");
  });

  it("poller tab: DROPS all impressions (never mints a behavioral label)", () => {
    expect(shouldEmitImpression(true)).toBe(false);
  });

  it("organic tab: tweets pass through UNTOUCHED (source stays undefined → server defaults 'net')", () => {
    const input = [tweet({ tweet_id: "a" }), tweet({ tweet_id: "b", source: "dom" })];
    const out = tagTweets(input, false);
    // Identical to today: no source stamped on the net tweet, dom preserved on the dom tweet.
    expect(out.map(t => t.source)).toEqual([undefined, "dom"]);
    expect(out).toEqual(input); // structural no-op
  });

  it("organic tab: impressions are emitted exactly as before", () => {
    expect(shouldEmitImpression(false)).toBe(true);
  });
});
