// M0 self-check: tweet extractor parses a realistic X GraphQL fixture.
import { describe, it, expect } from "vitest";

// Inline extractor (the real one lives in network-hook.ts; duplicated here
// so the test has no DOM/window dependency)

interface TweetRecord {
  tweet_id: string;
  author_handle: string;
  author_name: string;
  text: string;
  metrics: { likes: number; rts: number; replies: number; views?: number };
}

function walk(node: unknown, out: TweetRecord[]): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { node.forEach(n => walk(n, out)); return; }
  const obj = node as Record<string, unknown>;
  const t = (obj.__typename === "TweetWithVisibilityResults" && obj.tweet
    ? obj.tweet
    : obj) as Record<string, unknown>;
  const legacy = t?.legacy as Record<string, unknown> | undefined;
  if (t?.rest_id && legacy && legacy.full_text !== undefined) {
    const core = t.core as Record<string, unknown> | undefined;
    const userResult = (core?.user_results as Record<string, unknown>)?.result as Record<string, unknown> | undefined;
    const userCore = userResult?.core as Record<string, unknown> | undefined;
    const userLegacy = userResult?.legacy as Record<string, unknown> | undefined;
    out.push({
      tweet_id: String(t.rest_id),
      author_handle: String(userCore?.screen_name ?? userLegacy?.screen_name ?? ""),
      author_name: String(userCore?.name ?? userLegacy?.name ?? ""),
      text: String(legacy.full_text ?? legacy.text ?? ""),
      metrics: {
        likes: Number(legacy.favorite_count ?? 0),
        rts: Number(legacy.retweet_count ?? 0),
        replies: Number(legacy.reply_count ?? 0),
      },
    });
    if (legacy.retweeted_status_result) walk(legacy.retweeted_status_result, out);
    if (legacy.quoted_status_result) walk(legacy.quoted_status_result, out);
    return;
  }
  for (const v of Object.values(obj)) walk(v, out);
}

// Minimal fixture mimicking X's deeply-nested GraphQL shape
const fixture = {
  data: {
    home: {
      home_timeline_urt: {
        instructions: [
          {
            type: "TimelineAddEntries",
            entries: [
              {
                entryId: "tweet-123",
                content: {
                  itemContent: {
                    tweet_results: {
                      result: {
                        __typename: "Tweet",
                        rest_id: "1234567890",
                        legacy: {
                          full_text: "Hello world!",
                          favorite_count: 42,
                          retweet_count: 7,
                          reply_count: 3,
                        },
                        core: {
                          user_results: {
                            result: {
                              rest_id: "u999",
                              // current X schema: screen_name/name live in core, not legacy
                              core: { screen_name: "testuser", name: "Test User" },
                              legacy: {},
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            ],
          },
        ],
      },
    },
  },
};

describe("tweet extractor", () => {
  it("extracts tweet from deeply-nested GraphQL fixture", () => {
    const out: TweetRecord[] = [];
    walk(fixture, out);
    expect(out).toHaveLength(1);
    expect(out[0].tweet_id).toBe("1234567890");
    expect(out[0].author_handle).toBe("testuser");
    expect(out[0].author_name).toBe("Test User");
    expect(out[0].text).toBe("Hello world!");
    expect(out[0].metrics.likes).toBe(42);
    expect(out[0].metrics.rts).toBe(7);
  });

  it("returns empty for non-tweet payload", () => {
    const out: TweetRecord[] = [];
    walk({ data: { other: "stuff" } }, out);
    expect(out).toHaveLength(0);
  });

  it("captures a tweet wrapped in TweetWithVisibilityResults (inner .tweet, no __typename:Tweet)", () => {
    const wrapped = {
      data: { home: { home_timeline_urt: { instructions: [{ type: "TimelineAddEntries", entries: [{
        content: { itemContent: { tweet_results: { result: {
          __typename: "TweetWithVisibilityResults",
          tweet: {
            rest_id: "999888",
            legacy: { full_text: "visibility-wrapped tweet", favorite_count: 5, retweet_count: 1, reply_count: 0 },
            core: { user_results: { result: { rest_id: "u1", core: { screen_name: "wrapped_user", name: "Wrapped" }, legacy: {} } } },
          },
        } } } },
      }] }] } } },
    };
    const out: TweetRecord[] = [];
    walk(wrapped, out);
    expect(out).toHaveLength(1);
    expect(out[0].tweet_id).toBe("999888");
    expect(out[0].author_handle).toBe("wrapped_user");
    expect(out[0].text).toBe("visibility-wrapped tweet");
  });

  it("does NOT misparse a User object as a tweet (no legacy.full_text)", () => {
    const userPayload = { data: { user: { result: {
      __typename: "User", rest_id: "u42",
      legacy: { screen_name: "someone", name: "Some One", created_at: "2020-01-01" },
    } } } };
    const out: TweetRecord[] = [];
    walk(userPayload, out);
    expect(out).toHaveLength(0);
  });
});
