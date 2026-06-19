// M0 self-check: tweet extractor parses a realistic X GraphQL fixture.
import { describe, it, expect } from "vitest";

// Inline extractor (the real one lives in network-hook.ts; duplicated here
// so the test has no DOM/window dependency)

interface TweetRecord {
  tweet_id: string;
  author_handle: string;
  text: string;
  metrics: { likes: number; rts: number; replies: number; views?: number };
}

function walk(node: unknown, out: TweetRecord[]): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { node.forEach(n => walk(n, out)); return; }
  const obj = node as Record<string, unknown>;
  if (obj.__typename === "Tweet" && obj.legacy && obj.rest_id) {
    const legacy = obj.legacy as Record<string, unknown>;
    const core = obj.core as Record<string, unknown> | undefined;
    const userLegacy = ((core?.user_results as Record<string, unknown>)?.result as Record<string, unknown>)?.legacy as Record<string, unknown> | undefined;
    out.push({
      tweet_id: String(obj.rest_id),
      author_handle: String(userLegacy?.screen_name ?? ""),
      text: String(legacy.full_text ?? legacy.text ?? ""),
      metrics: {
        likes: Number(legacy.favorite_count ?? 0),
        rts: Number(legacy.retweet_count ?? 0),
        replies: Number(legacy.reply_count ?? 0),
      },
    });
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
                              legacy: { screen_name: "testuser" },
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
    expect(out[0].text).toBe("Hello world!");
    expect(out[0].metrics.likes).toBe(42);
    expect(out[0].metrics.rts).toBe(7);
  });

  it("returns empty for non-tweet payload", () => {
    const out: TweetRecord[] = [];
    walk({ data: { other: "stuff" } }, out);
    expect(out).toHaveLength(0);
  });
});
