import type { DatabaseSync } from "node:sqlite";
import { buildDigest, type DigestItem, type QuotedTweet } from "./digest.ts";

export const PUBLIC_FEED_LIMIT = 8;
export const PUBLIC_FEED_CANDIDATES = 32;
export const PUBLIC_FEED_DAYS = 2;

export interface PublicFeedMedia {
  type: "photo" | "video" | "gif" | "card" | "article";
  url?: string;
  title?: string;
  domain?: string;
  link?: string;
  preview?: string;
}

export interface PublicFeedQuote {
  tweet_id: string;
  author_handle: string | null;
  author_name: string | null;
  text: string;
  media: PublicFeedMedia[];
  created_at: string | null;
  url: string;
}

export interface PublicFeedItem {
  tweet_id: string;
  author_handle: string | null;
  author_name: string | null;
  author_avatar: string | null;
  text: string;
  media: PublicFeedMedia[];
  quoted: PublicFeedQuote | null;
  created_at: string | null;
  likes: number | null;
  rts: number | null;
  replies: number | null;
  views: number | null;
  url: string;
  badge: { kind: "taste"; value: number } | { kind: "explore" };
}

export interface PublicFeedSnapshot {
  version: 1;
  generated_at: string;
  items: PublicFeedItem[];
}

export type PublicTweetVerifier = (tweetId: string, handle: string | null) => Promise<boolean>;

function tweetUrl(tweetId: string, handle: string | null): string {
  const safeHandle = handle && /^[A-Za-z0-9_]{1,20}$/.test(handle) ? handle : "i/web";
  return `https://x.com/${safeHandle}/status/${encodeURIComponent(tweetId)}`;
}

function safeHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function safeImageUrl(value: unknown): string | undefined {
  const safe = safeHttpsUrl(value);
  if (!safe) return undefined;
  const host = new URL(safe).hostname.toLowerCase();
  return host === "pbs.twimg.com" || host === "abs.twimg.com" ? safe : undefined;
}

function sanitizeMedia(raw: unknown): PublicFeedMedia[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 4).flatMap((value): PublicFeedMedia[] => {
    if (!value || typeof value !== "object") return [];
    const media = value as Record<string, unknown>;
    const type = media.type;
    if (type !== "photo" && type !== "video" && type !== "gif" && type !== "card" && type !== "article") return [];

    if (type === "card" || type === "article") {
      const title = typeof media.title === "string" ? media.title.trim() : "";
      const link = safeHttpsUrl(media.link);
      if (!title || !link) return [];
      return [{
        type,
        title,
        link,
        ...(typeof media.domain === "string" && media.domain ? { domain: media.domain } : {}),
        ...(typeof media.preview === "string" && media.preview ? { preview: media.preview } : {}),
        ...(safeImageUrl(media.url) ? { url: safeImageUrl(media.url) } : {}),
      }];
    }

    const url = safeImageUrl(media.url);
    return url ? [{ type, url }] : [];
  });
}

function avatarFor(db: DatabaseSync, tweetId: string): string | null {
  const row = db.prepare("SELECT author_avatar AS avatar FROM tweets WHERE tweet_id = ?")
    .get(tweetId) as { avatar?: string | null } | undefined;
  return safeImageUrl(row?.avatar) ?? null;
}

function sanitizeQuote(db: DatabaseSync, quote: QuotedTweet): PublicFeedQuote {
  return {
    tweet_id: quote.tweet_id,
    author_handle: quote.author_handle,
    author_name: quote.author_name,
    text: quote.text,
    media: sanitizeMedia(quote.media),
    created_at: quote.created_at,
    url: tweetUrl(quote.tweet_id, quote.author_handle),
  };
}

function sanitizeItem(
  db: DatabaseSync,
  item: DigestItem,
  quote: PublicFeedQuote | null,
  badge: PublicFeedItem["badge"],
): PublicFeedItem {
  return {
    tweet_id: item.tweet_id,
    author_handle: item.author_handle,
    author_name: item.author_name,
    author_avatar: avatarFor(db, item.tweet_id),
    text: item.text,
    media: sanitizeMedia(item.media),
    quoted: quote,
    created_at: item.created_at,
    likes: item.likes,
    rts: item.rts,
    replies: item.replies,
    views: item.views,
    url: tweetUrl(item.tweet_id, item.author_handle),
    badge,
  };
}

// X's oEmbed endpoint is our public-visibility check. Captured rows can include protected-account
// posts because the owner follows that account; nothing enters the public snapshot unless X itself
// will render the tweet without the owner's session. A timeout is a failed check, never permission
// to publish from the local cache.
export async function verifyTweetIsPublic(tweetId: string, handle: string | null): Promise<boolean> {
  const endpoint = new URL("https://publish.twitter.com/oembed");
  endpoint.searchParams.set("url", tweetUrl(tweetId, handle));
  endpoint.searchParams.set("omit_script", "1");
  endpoint.searchParams.set("dnt", "1");
  try {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(5_000) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function sanitizePublicFeedItems(
  db: DatabaseSync,
  candidates: DigestItem[],
  { verify = verifyTweetIsPublic, limit = PUBLIC_FEED_LIMIT }:
    { verify?: PublicTweetVerifier; limit?: number } = {},
): Promise<PublicFeedItem[]> {
  const selected: { source: DigestItem; quote: PublicFeedQuote | null }[] = [];

  // Small batches keep first-load latency reasonable without hammering the oEmbed endpoint.
  for (let start = 0; start < candidates.length && selected.length < limit; start += 4) {
    const batch = candidates.slice(start, start + 4);
    const visible = await Promise.all(batch.map(item => verify(item.tweet_id, item.author_handle)));
    for (let i = 0; i < batch.length && selected.length < limit; i++) {
      if (!visible[i]) continue;
      const item = batch[i];
      let quote: PublicFeedQuote | null = null;
      if (item.quoted && "text" in item.quoted) {
        const publicQuote = await verify(item.quoted.tweet_id, item.quoted.author_handle);
        if (publicQuote) quote = sanitizeQuote(db, item.quoted);
      }
      selected.push({ source: item, quote });
    }
  }

  // Match the private reader's display contract without publishing raw model scores: taste cards
  // get a pool-relative 60–99 badge, while explore keeps its explicit lane marker. The order already
  // reveals relative rank; this adds no arm, score parts, or reusable feature value to the payload.
  const tasteScores = selected.filter(x => x.source.lane !== "explore").map(x => x.source.score);
  const low = Math.min(...tasteScores);
  const high = Math.max(...tasteScores);
  return selected.map(({ source, quote }) => {
    const badge: PublicFeedItem["badge"] = source.lane === "explore"
      ? { kind: "explore" }
      : { kind: "taste", value: high === low ? 92 : Math.round(60 + 39 * (source.score - low) / (high - low)) };
    return sanitizeItem(db, source, quote, badge);
  });
}

// Build from the ranker directly, never through GET /digest: public page views must not mint
// digest_log serves or digest_runs and must not enter the blinded online experiment. The output is
// deliberately a smaller type: no score, score parts, lane, arm, profile, dwell, or review state.
export async function buildPublicFeedSnapshot(
  db: DatabaseSync,
  {
    now = new Date(),
    verify = verifyTweetIsPublic,
    limit = PUBLIC_FEED_LIMIT,
    days = PUBLIC_FEED_DAYS,
  }: { now?: Date; verify?: PublicTweetVerifier; limit?: number; days?: number } = {},
): Promise<PublicFeedSnapshot> {
  const candidates = buildDigest(db, {
    limit: Math.max(limit, PUBLIC_FEED_CANDIDATES),
    days,
    nowMs: now.getTime(),
  });
  const items = await sanitizePublicFeedItems(db, candidates, { verify, limit });
  return { version: 1, generated_at: now.toISOString(), items };
}
