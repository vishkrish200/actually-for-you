// Quote-tweet relationship capture: the parent tweet records quoted_id, and the quoted tweet is
// still captured as its own row. X has served quoted_status_result at TWO locations over time —
// the RESULT level (current) and legacy.* (old) — both must work (dual read, like user core/legacy).
// Imports the REAL extractor (happy-dom absorbs the module's window.fetch/XHR patching).
import { describe, it, expect } from "vitest";
import { extractTweets } from "./network-hook";

const user = {
  rest_id: "u1",
  core: { screen_name: "alice", name: "Alice" },
};

// atResult: fields that sit on the tweet result (current schema home of quoted_status_result);
// atLegacy: fields inside legacy (the old home).
function tweetResult(id: string, text: string, atResult: Record<string, unknown> = {}, atLegacy: Record<string, unknown> = {}) {
  return {
    rest_id: id,
    core: { user_results: { result: user } },
    legacy: { full_text: text, favorite_count: 1, retweet_count: 0, reply_count: 0, ...atLegacy },
    ...atResult,
  };
}

const wrap = (result: unknown) => ({
  data: { home: { home_timeline_urt: { instructions: [{ type: "TimelineAddEntries", entries: [
    { entryId: "tweet-1", content: { itemContent: { tweet_results: { result } } } },
  ] }] } } },
});

describe("quoted_id capture", () => {
  it("current schema: quoted_status_result at the RESULT level — parent gets quoted_id, both rows captured", () => {
    const quoting = tweetResult("100", "this take is wild", {
      quoted_status_result: { result: tweetResult("200", "original hot take") },
    });
    const out = extractTweets(wrap(quoting));
    const byId = new Map(out.map(t => [t.tweet_id, t]));
    expect(byId.get("100")?.quoted_id).toBe("200");
    expect(byId.get("200")?.text).toBe("original hot take");
    expect(byId.get("200")?.quoted_id).toBeUndefined();
  });

  it("old schema: quoted_status_result under legacy still works", () => {
    const quoting = tweetResult("100", "this take is wild", {}, {
      quoted_status_result: { result: tweetResult("201", "legacy-location original") },
    });
    const out = extractTweets(wrap(quoting));
    const byId = new Map(out.map(t => [t.tweet_id, t]));
    expect(byId.get("100")?.quoted_id).toBe("201");
    expect(byId.get("201")?.text).toBe("legacy-location original");
  });

  it("unwraps a visibility-wrapped quoted result (result level)", () => {
    const quoting = tweetResult("100", "quoting a limited tweet", {
      quoted_status_result: { result: {
        __typename: "TweetWithVisibilityResults",
        tweet: tweetResult("300", "limited-visibility original"),
      } },
    });
    const out = extractTweets(wrap(quoting));
    expect(out.find(t => t.tweet_id === "100")?.quoted_id).toBe("300");
    expect(out.find(t => t.tweet_id === "300")?.text).toBe("limited-visibility original");
  });

  it("retweets: result-level retweeted_status_result is still walked into (same schema move)", () => {
    const rt = tweetResult("400", "RT @alice: the original", {
      retweeted_status_result: { result: tweetResult("500", "the original") },
    });
    const out = extractTweets(wrap(rt));
    expect(out.find(t => t.tweet_id === "500")?.text).toBe("the original");
  });

  it("plain tweets carry no quoted_id", () => {
    const out = extractTweets(wrap(tweetResult("600", "no quote here")));
    expect(out).toHaveLength(1);
    expect(out[0].quoted_id).toBeUndefined();
  });
});
