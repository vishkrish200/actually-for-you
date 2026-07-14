// M0 self-check: tweet extractor parses a realistic X GraphQL fixture.
import { describe, it, expect } from "vitest";

// Inline extractor (the real one lives in network-hook.ts; duplicated here
// so the test has no DOM/window dependency)

interface TweetRecord {
  tweet_id: string;
  author_handle: string;
  author_name: string;
  author_profile?: {
    verified: boolean; verified_type?: string;
    affiliate?: { badge: string; title: string };
    bio?: string; followers?: number; following?: number;
  };
  text: string;
  media?: { type: string; url: string; video?: string; title?: string; preview?: string; domain?: string; link?: string }[];
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
    // link-card extraction — mirrors network-hook.ts parseTweetResult
    const bindings = (((t.card as Record<string, unknown>)?.legacy as Record<string, unknown>)
      ?.binding_values ?? []) as Array<Record<string, unknown>>;
    const bind = (k: string) => (bindings.find(b => b.key === k)?.value ?? {}) as Record<string, unknown>;
    const cardTitle = bind("title").string_value;
    const cardImg = (bind("thumbnail_image_original").image_value
      ?? bind("summary_photo_image_original").image_value
      ?? bind("photo_image_full_size_original").image_value) as Record<string, unknown> | undefined;
    const card = cardTitle ? [{
      type: "card",
      url: String(cardImg?.url ?? ""),
      title: String(cardTitle),
      domain: String(bind("vanity_url").string_value ?? bind("domain").string_value ?? ""),
      link: String(bind("card_url").string_value ?? ""),
    }] : [];
    // article extraction — mirrors network-hook.ts parseTweetResult
    const artResult = (((t.article as Record<string, unknown>)?.article_results as Record<string, unknown>)
      ?.result as Record<string, unknown> | undefined);
    const artCover = (((artResult?.cover_media as Record<string, unknown>)
      ?.media_info as Record<string, unknown>)?.original_img_url);
    const article = artResult?.title ? [{
      type: "article",
      url: String(artCover ?? ""),
      title: String(artResult.title),
      preview: String(artResult.preview_text ?? ""),
      link: `https://x.com/i/web/status/${String(t.rest_id)}`,
    }] : [];
    // video mp4 variant — mirrors network-hook.ts parseTweetResult
    const mediaItems = ((legacy.extended_entities as Record<string, unknown>)?.media ?? []) as Array<Record<string, unknown>>;
    // author profile (verified/affiliate/bio/counts) — mirrors network-hook.ts parseTweetResult
    const verification = userResult?.verification as Record<string, unknown> | undefined;
    const verifiedType = verification?.verified_type ?? userLegacy?.verified_type;
    const blueVerified = Boolean(verification?.verified ?? userResult?.is_blue_verified);
    const affLabel = (userResult?.affiliates_highlighted_label as Record<string, unknown>)
      ?.label as Record<string, unknown> | undefined;
    const bio = String((userResult?.profile_bio as Record<string, unknown>)?.description
      ?? userLegacy?.description ?? "");
    const counts = userResult?.relationship_counts as Record<string, unknown> | undefined;
    const followers = Number(userLegacy?.followers_count ?? counts?.followers ?? 0);
    const following = Number(userLegacy?.friends_count ?? counts?.following ?? 0);
    const author_profile = (blueVerified || verifiedType || affLabel || bio || followers) ? {
      verified: blueVerified || Boolean(verifiedType),
      ...(verifiedType ? { verified_type: String(verifiedType) } : {}),
      ...(affLabel ? { affiliate: {
        badge: String((affLabel.badge as Record<string, unknown>)?.url ?? ""),
        title: String(affLabel.description ?? ""),
      } } : {}),
      ...(bio ? { bio } : {}),
      followers, following,
    } : undefined;
    out.push({
      author_profile,
      media: [
        ...mediaItems.map(m => {
          const mp4 = (((m.video_info as Record<string, unknown>)?.variants ?? []) as Array<Record<string, unknown>>)
            .filter(v => v.content_type === "video/mp4")
            .sort((a, b) => Number(b.bitrate ?? 0) - Number(a.bitrate ?? 0))[0]?.url;
          return {
            type: String(m.type),
            url: String(m.media_url_https ?? m.media_url ?? ""),
            ...(mp4 ? { video: String(mp4) } : {}),
          };
        }),
        ...card,
        ...article,
      ],
      tweet_id: String(t.rest_id),
      author_handle: String(userCore?.screen_name ?? userLegacy?.screen_name ?? ""),
      author_name: String(userCore?.name ?? userLegacy?.name ?? ""),
      text: String(
        (((t.note_tweet as Record<string, unknown>)?.note_tweet_results as Record<string, unknown>)
          ?.result as Record<string, unknown>)?.text
        ?? legacy.full_text ?? legacy.text ?? ""),
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

  it("extracts a link-card embed (title/domain/thumbnail/link) from card.legacy.binding_values", () => {
    const withCard = {
      data: { home: { home_timeline_urt: { instructions: [{ type: "TimelineAddEntries", entries: [{
        content: { itemContent: { tweet_results: { result: {
          __typename: "Tweet",
          rest_id: "555",
          card: { legacy: { binding_values: [
            { key: "title", value: { type: "STRING", string_value: "You fail to learn if you don't learn to fail" } },
            { key: "vanity_url", value: { type: "STRING", string_value: "seated.ro" } },
            { key: "domain", value: { type: "STRING", string_value: "www.seated.ro" } },
            { key: "thumbnail_image_original", value: { type: "IMAGE", image_value: { url: "https://pbs.twimg.com/card_img/x.jpg" } } },
            { key: "card_url", value: { type: "STRING", string_value: "https://t.co/1sfGRzhoGh" } },
          ] } },
          legacy: { full_text: "thoughts https://t.co/1sfGRzhoGh", favorite_count: 45, retweet_count: 4, reply_count: 2 },
          core: { user_results: { result: { rest_id: "u3", core: { screen_name: "seatedro", name: "rohit" }, legacy: {} } } },
        } } } },
      }] }] } } },
    };
    const out: TweetRecord[] = [];
    walk(withCard, out);
    expect(out).toHaveLength(1);
    expect(out[0].media).toEqual([{
      type: "card",
      url: "https://pbs.twimg.com/card_img/x.jpg",
      title: "You fail to learn if you don't learn to fail",
      domain: "seated.ro", // vanity_url preferred over domain
      link: "https://t.co/1sfGRzhoGh",
    }]);
  });

  it("extracts an X Article (title/preview/cover) and links it to the tweet page", () => {
    const withArticle = {
      data: { home: { home_timeline_urt: { instructions: [{ type: "TimelineAddEntries", entries: [{
        content: { itemContent: { tweet_results: { result: {
          __typename: "Tweet",
          rest_id: "777",
          article: { article_results: { result: {
            title: "How I ship faster",
            preview_text: "A short preview of the article body…",
            cover_media: { media_info: { original_img_url: "https://pbs.twimg.com/article_img/cover.jpg" } },
          } } },
          legacy: { full_text: "How I ship faster https://t.co/abc", favorite_count: 10, retweet_count: 1, reply_count: 0 },
          core: { user_results: { result: { rest_id: "u4", core: { screen_name: "writer", name: "Writer" }, legacy: {} } } },
        } } } },
      }] }] } } },
    };
    const out: TweetRecord[] = [];
    walk(withArticle, out);
    expect(out).toHaveLength(1);
    expect(out[0].media).toEqual([{
      type: "article",
      url: "https://pbs.twimg.com/article_img/cover.jpg",
      title: "How I ship faster",
      preview: "A short preview of the article body…",
      link: "https://x.com/i/web/status/777",
    }]);
  });

  it("picks the highest-bitrate mp4 variant for videos so the digest can play inline", () => {
    const withVideo = {
      data: { home: { home_timeline_urt: { instructions: [{ type: "TimelineAddEntries", entries: [{
        content: { itemContent: { tweet_results: { result: {
          __typename: "Tweet",
          rest_id: "888",
          legacy: {
            full_text: "watch this",
            favorite_count: 1, retweet_count: 0, reply_count: 0,
            extended_entities: { media: [{
              type: "video",
              media_url_https: "https://pbs.twimg.com/poster.jpg",
              video_info: { variants: [
                { content_type: "application/x-mpegURL", url: "https://video.twimg.com/pl.m3u8" },
                { content_type: "video/mp4", bitrate: 256000, url: "https://video.twimg.com/lo.mp4" },
                { content_type: "video/mp4", bitrate: 2176000, url: "https://video.twimg.com/hi.mp4" },
              ] },
            }] },
          },
          core: { user_results: { result: { rest_id: "u5", core: { screen_name: "vid", name: "Vid" }, legacy: {} } } },
        } } } },
      }] }] } } },
    };
    const out: TweetRecord[] = [];
    walk(withVideo, out);
    expect(out).toHaveLength(1);
    expect(out[0].media).toEqual([{
      type: "video",
      url: "https://pbs.twimg.com/poster.jpg",
      video: "https://video.twimg.com/hi.mp4",
    }]);
  });

  it("prefers note_tweet full text over the truncated legacy.full_text (long-form tweets)", () => {
    const longform = {
      data: { home: { home_timeline_urt: { instructions: [{ type: "TimelineAddEntries", entries: [{
        content: { itemContent: { tweet_results: { result: {
          __typename: "Tweet",
          rest_id: "2076447816331960693",
          note_tweet: { note_tweet_results: { result: {
            text: "playing with local AI models — the FULL long-form text, well past the 280-char legacy cut",
          } } },
          legacy: { full_text: "playing with local AI models — the FULL long-form…", favorite_count: 93, retweet_count: 12, reply_count: 19 },
          core: { user_results: { result: { rest_id: "u2", core: { screen_name: "andrewchen", name: "andrew chen" }, legacy: {} } } },
        } } } },
      }] }] } } },
    };
    const out: TweetRecord[] = [];
    walk(longform, out);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("playing with local AI models — the FULL long-form text, well past the 280-char legacy cut");
  });

  it("extracts author_profile: verified type, affiliation badge, bio, follower counts", () => {
    const fx = JSON.parse(JSON.stringify(fixture));
    const user = fx.data.home.home_timeline_urt.instructions[0].entries[0]
      .content.itemContent.tweet_results.result.core.user_results.result;
    user.is_blue_verified = true;
    user.legacy = { verified_type: "Business", description: "We build rockets",
      followers_count: 1200000, friends_count: 42 };
    user.affiliates_highlighted_label = { label: {
      badge: { url: "https://pbs.twimg.com/semantic_core_img/badge.png" },
      description: "SpaceX", userLabelType: "BusinessLabel",
    } };
    const out: TweetRecord[] = [];
    walk(fx, out);
    expect(out[0].author_profile).toEqual({
      verified: true, verified_type: "Business",
      affiliate: { badge: "https://pbs.twimg.com/semantic_core_img/badge.png", title: "SpaceX" },
      bio: "We build rockets", followers: 1200000, following: 42,
    });
  });

  it("author_profile is absent for a bare unverified user (no noise rows)", () => {
    const out: TweetRecord[] = [];
    walk(fixture, out);
    expect(out[0].author_profile).toBeUndefined();
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

// opSource: resolve the Likes/Bookmarks confirmed-positive source from a GraphQL URL.
// Inline copy (the real one lives in network-hook.ts; duplicated so the test has no window dep).
function opSource(url: string): "like" | "bookmark" | null {
  const op = (url.split("?")[0].split("/").pop() ?? "");
  if (/^Likes/.test(op)) return "like";
  if (/^Bookmark/.test(op)) return "bookmark";
  return null;
}

describe("opSource (harvest Likes/Bookmarks as confirmed positives)", () => {
  it("detects the liked-tweets timeline", () => {
    expect(opSource("https://x.com/i/api/graphql/abc123/Likes?variables=%7B%7D")).toBe("like");
  });
  it("detects the bookmarks timeline despite its versioned op name", () => {
    // verified live: the bookmarks tweet timeline is a Bookmark*-prefixed versioned op, not "Bookmarks"
    expect(opSource("https://x.com/i/api/graphql/xyz/BookmarkTimelineV2?variables=1")).toBe("bookmark");
    expect(opSource("https://x.com/i/api/graphql/xyz/BookmarkFoldersSlice?v=1")).toBe("bookmark");
  });
  it("ignores ordinary feed ops", () => {
    expect(opSource("https://x.com/i/api/graphql/q/HomeTimeline?variables=1")).toBeNull();
    expect(opSource("https://x.com/i/api/graphql/q/TweetDetail?variables=1")).toBeNull();
    expect(opSource("https://x.com/i/api/1.1/graphql/viewer_context.json")).toBeNull();
  });
});
