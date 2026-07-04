// Quote-tweet relationship capture: the parent tweet records quoted_id, and the quoted tweet is
// still captured as its own row. Imports the REAL extractor (happy-dom absorbs the module's
// window.fetch/XHR patching side effects) — unlike the older inline-duplicated fixture tests.
import { describe, it, expect } from "vitest";
import { extractTweets } from "./network-hook";

const user = {
  rest_id: "u1",
  core: { screen_name: "alice", name: "Alice" },
};

function tweetResult(id: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    rest_id: id,
    core: { user_results: { result: user } },
    legacy: { full_text: text, favorite_count: 1, retweet_count: 0, reply_count: 0, ...extra },
  };
}

const wrap = (result: unknown) => ({
  data: { home: { home_timeline_urt: { instructions: [{ type: "TimelineAddEntries", entries: [
    { entryId: "tweet-1", content: { itemContent: { tweet_results: { result } } } },
  ] }] } } },
});

describe("quoted_id capture", () => {
  it("records the quoted tweet's id on the quoting tweet AND captures both rows", () => {
    const quoting = tweetResult("100", "this take is wild", {
      quoted_status_result: { result: tweetResult("200", "original hot take") },
    });
    const out = extractTweets(wrap(quoting));
    const byId = new Map(out.map(t => [t.tweet_id, t]));
    expect(byId.get("100")?.quoted_id).toBe("200");
    expect(byId.get("200")?.text).toBe("original hot take");
    expect(byId.get("200")?.quoted_id).toBeUndefined();
  });

  it("unwraps a visibility-wrapped quoted result", () => {
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

  it("plain tweets carry no quoted_id", () => {
    const out = extractTweets(wrap(tweetResult("400", "no quote here")));
    expect(out).toHaveLength(1);
    expect(out[0].quoted_id).toBeUndefined();
  });
});
