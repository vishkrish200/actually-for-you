import { describe, it, expect } from "vitest";
import {
  tagTweets, shouldEmitImpression, decideScroll, SCROLL_CAP,
  catchupPlan, CATCHUP_GAP_MS, WATERMARK_SLACK_MS, WATERMARK_CAP_MS,
} from "./poll-source";
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

describe("M15 watermark autoscroll STOP rule", () => {
  const MARK = 1_000_000; // watermark; times are DOM order top→bottom
  const fresh = MARK + 1, old = MARK - 1;

  it("stops on watermark when the trailing 3 rendered tweets all predate it", () => {
    expect(decideScroll([fresh, fresh, old, old, old], MARK, 5, 0, true))
      .toEqual({ kind: "stop", reason: "watermark" });
  });

  it("retweet fake-out: an old timestamp with fresh tweets below it breaks the run", () => {
    // A retweet renders the ORIGINAL tweet's old time inside a fresh chronological stream —
    // interior old rows must not end an overnight catch-up.
    expect(decideScroll([fresh, old, fresh, old, old], MARK, 5, 0, true))
      .toEqual({ kind: "continue", emptyStreak: 0 });
    expect(decideScroll([old, old, old, fresh], MARK, 5, 0, true))
      .toEqual({ kind: "continue", emptyStreak: 0 });
  });

  it("a trailing run of only 2 old tweets keeps scrolling", () => {
    expect(decideScroll([fresh, old, old], MARK, 5, 0, true))
      .toEqual({ kind: "continue", emptyStreak: 0 });
  });

  it("exact-watermark timestamps count as fresh (strictly-older comparison)", () => {
    expect(decideScroll([fresh, MARK, MARK, MARK], MARK, 5, 0, true))
      .toEqual({ kind: "continue", emptyStreak: 0 });
  });

  it("stops on cap regardless of what is rendered", () => {
    expect(decideScroll([fresh, fresh, fresh], MARK, SCROLL_CAP, 0, true))
      .toEqual({ kind: "stop", reason: "cap" });
  });

  it("empty steps BEFORE any content rendered are still-loading, never no-times (dogfood 2026-07-18)", () => {
    // A never-visible background tab is render-throttled — X mounts its timeline long after step
    // 3. Pre-content empty steps must not count toward blindness, no matter how many.
    for (const step of [1, 2, 3, 10, 30]) {
      expect(decideScroll([], MARK, step, 0, false)).toEqual({ kind: "continue", emptyStreak: 0 });
    }
    // Only the cap ends a page that never renders anything.
    expect(decideScroll([], MARK, SCROLL_CAP, 0, false)).toEqual({ kind: "stop", reason: "cap" });
  });

  it("AFTER content has rendered: 3 consecutive empty steps stop with the breakage reason", () => {
    expect(decideScroll([], MARK, 5, 0, true)).toEqual({ kind: "continue", emptyStreak: 1 });
    expect(decideScroll([], MARK, 6, 1, true)).toEqual({ kind: "continue", emptyStreak: 2 });
    expect(decideScroll([], MARK, 7, 2, true)).toEqual({ kind: "stop", reason: "no-times" });
  });

  it("a non-empty step resets the empty streak", () => {
    expect(decideScroll([fresh], MARK, 6, 2, true)).toEqual({ kind: "continue", emptyStreak: 0 });
  });
});

describe("M15 catch-up tick policy (home stays primary)", () => {
  const NOW = 1_000_000_000_000;

  it("a normal 30-min cadence tick is NOT a catch-up (pure M7 For You path)", () => {
    expect(catchupPlan(NOW - 30 * 60 * 1000, NOW)).toEqual({ catchup: false });
  });

  it("a gap at exactly the threshold is still not a catch-up (strictly-greater)", () => {
    expect(catchupPlan(NOW - CATCHUP_GAP_MS, NOW)).toEqual({ catchup: false });
  });

  it("an overnight gap is a catch-up with the watermark at prev-tick minus slack", () => {
    const prev = NOW - 8 * 3600 * 1000;
    expect(catchupPlan(prev, NOW))
      .toEqual({ catchup: true, scrollUntil: prev - WATERMARK_SLACK_MS });
  });

  it("a multi-day gap caps the watermark at 24h back", () => {
    expect(catchupPlan(NOW - 5 * 24 * 3600 * 1000, NOW))
      .toEqual({ catchup: true, scrollUntil: NOW - WATERMARK_CAP_MS });
  });

  it("the first-ever tick is a capped catch-up (no prior tick to key off)", () => {
    expect(catchupPlan(undefined, NOW))
      .toEqual({ catchup: true, scrollUntil: NOW - WATERMARK_CAP_MS });
  });
});
