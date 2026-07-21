// Runs in PAGE context (not isolated world) so we can wrap fetch/XHR.
// Captures X GraphQL timeline responses and postMessages them to the content script.

// Match ANY X GraphQL response, not a hand-maintained op-name list — the shape-based walk only
// emits objects that are actually tweets (rest_id + legacy.full_text), so scanning every GraphQL
// payload harmlessly captures tweets from whatever surface the user scrolls (home, profile,
// search, lists, conversation). Op names rotate and multiply; the endpoint path does not.
const TIMELINE_OP_PATTERNS = /\/graphql\//;

export function extractTweets(json: unknown): TweetRecord[] {
  // X nests tweets at: data → * → instructions → entries → content → itemContent
  // → tweet_results → result → legacy
  const out: TweetRecord[] = [];
  try {
    walk(json, out);
  } catch (e) {
    window.postMessage({ __afy: true, kind: "capture_health", detail: { kind: "graphql_schema_miss", detail: String(e) } }, "*");
  }
  return out;
}

function walk(node: unknown, out: TweetRecord[]): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { node.forEach(n => walk(n, out)); return; }

  const obj = node as Record<string, unknown>;

  // X wraps many timeline tweets in TweetWithVisibilityResults; the real tweet sits at .tweet
  // and frequently lacks __typename:"Tweet". Unwrap it before matching.
  const t = (obj.__typename === "TweetWithVisibilityResults" && obj.tweet
    ? obj.tweet
    : obj) as Record<string, unknown>;

  // Match a tweet by SHAPE, not __typename. A tweet result has rest_id + legacy.full_text;
  // the full_text check discriminates tweets from User objects (also rest_id+legacy, no full_text).
  // The old `__typename === "Tweet"` check silently dropped every visibility-wrapped tweet —
  // the "unknown / no content captured" rows.
  const legacy = t?.legacy as Record<string, unknown> | undefined;
  if (t?.rest_id && legacy && legacy.full_text !== undefined) {
    const parsed = parseTweetResult(t);
    if (parsed) out.push(parsed);
    // Also capture the original behind a retweet and the quoted tweet — the dwell tracker may
    // key the impression to either's ID from the DOM. X moved both from legacy.* to the result
    // level (sibling of legacy) — read both, current location first (same drift-proofing as the
    // user core/legacy dual read).
    const rtRef = t.retweeted_status_result ?? legacy.retweeted_status_result;
    const qtRef = t.quoted_status_result ?? legacy.quoted_status_result;
    if (rtRef) walk(rtRef, out);
    if (qtRef) walk(qtRef, out);
    return;
  }

  for (const v of Object.values(obj)) walk(v, out);
}

function parseTweetResult(result: Record<string, unknown>): TweetRecord | null {
  const legacy = result.legacy as Record<string, unknown> | undefined;
  if (!legacy) return null;

  const core = result.core as Record<string, unknown> | undefined;
  const userResult = (core?.user_results as Record<string, unknown>)?.result as Record<string, unknown> | undefined;
  // X moved screen_name/name from user.legacy into user.core; read core first, legacy as fallback.
  const userCore = userResult?.core as Record<string, unknown> | undefined;
  const userLegacy = userResult?.legacy as Record<string, unknown> | undefined;

  const tweet_id = String(result.rest_id ?? "");
  if (!tweet_id) return null;

  const mediaItems = ((legacy.extended_entities as Record<string, unknown>)?.media ?? []) as Array<Record<string, unknown>>;

  // Quoted-tweet RELATIONSHIP: walk() already captures the quoted tweet as its own row; here we
  // record which tweet it was quoted by, so the server can join the context back at digest time.
  // Current X schema puts quoted_status_result at the RESULT level (legacy.* is the old location —
  // dual read, like everything else in this file). May be visibility-wrapped — unwrap for rest_id.
  const quotedRaw = ((result.quoted_status_result ?? legacy.quoted_status_result) as Record<string, unknown>)?.result as Record<string, unknown> | undefined;
  const quoted = quotedRaw?.__typename === "TweetWithVisibilityResults" && quotedRaw.tweet
    ? quotedRaw.tweet as Record<string, unknown>
    : quotedRaw;

  // Avatar: X moved it from user.legacy.profile_image_url_https into user.avatar.image_url (newer
  // schema). Read avatar first, legacy fallback. This is X's own pbs.twimg.com CDN — no rate limit.
  const userAvatar = userResult?.avatar as Record<string, unknown> | undefined;

  // Long-form ("note") tweets: legacy.full_text is truncated at ~280 chars; the complete text
  // lives at result.note_tweet.note_tweet_results.result.text (sibling of legacy). Prefer it.
  const noteText = (((result.note_tweet as Record<string, unknown>)
    ?.note_tweet_results as Record<string, unknown>)
    ?.result as Record<string, unknown>)?.text;

  // Link-card embed (external URL preview): title/domain/thumbnail live in card.legacy
  // .binding_values as {key, value} pairs. Shipped as a media item (type:'card') so no
  // schema/server change is needed — the media JSON is stored and parsed opaquely.
  const bindings = (((result.card as Record<string, unknown>)?.legacy as Record<string, unknown>)
    ?.binding_values ?? []) as Array<Record<string, unknown>>;
  const bind = (k: string) => (bindings.find(b => b.key === k)?.value ?? {}) as Record<string, unknown>;
  const cardTitle = bind("title").string_value;
  const cardImg = (bind("thumbnail_image_original").image_value
    ?? bind("summary_photo_image_original").image_value
    ?? bind("photo_image_full_size_original").image_value) as Record<string, unknown> | undefined;
  const card = cardTitle ? [{
    type: "card" as const,
    url: String(cardImg?.url ?? ""),
    title: String(cardTitle),
    domain: String(bind("vanity_url").string_value ?? bind("domain").string_value ?? ""),
    link: String(bind("card_url").string_value ?? ""),
  }] : [];

  // X Article (long-form editorial): title/preview/cover live at result.article.article_results
  // .result — legacy.full_text for these is just "Title + t.co", so without this the tweet looks
  // empty. Same media-JSON ride as the link card; link opens the tweet where the article renders.
  const artResult = (((result.article as Record<string, unknown>)
    ?.article_results as Record<string, unknown>)
    ?.result as Record<string, unknown> | undefined);
  const artCover = (((artResult?.cover_media as Record<string, unknown>)
    ?.media_info as Record<string, unknown>)?.original_img_url);
  const article = artResult?.title ? [{
    type: "article" as const,
    url: String(artCover ?? ""),
    title: String(artResult.title),
    preview: String(artResult.preview_text ?? ""),
    link: `https://x.com/i/web/status/${tweet_id}`,
  }] : [];

  // Author identity beyond name+avatar, for the digest's badges + hover card: verification
  // (blue check / gold Business / gray Government), the affiliation badge (the small org logo
  // next to some names), bio, and follower counts. Same dual-read drift-proofing: verification
  // moved from result-level is_blue_verified / legacy.verified_type toward a `verification`
  // object, bio from legacy.description toward profile_bio.description. All fields optional —
  // an absent user object just yields no profile, never a parse failure.
  const verification = userResult?.verification as Record<string, unknown> | undefined;
  const verifiedType = verification?.verified_type ?? userLegacy?.verified_type; // "Business" | "Government"
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

  return {
    tweet_id,
    author_handle: String(userCore?.screen_name ?? userLegacy?.screen_name ?? ""),
    author_name: String(userCore?.name ?? userLegacy?.name ?? ""),
    author_avatar: String(userAvatar?.image_url ?? userLegacy?.profile_image_url_https ?? ""),
    author_id: String(userResult?.rest_id ?? ""),
    author_profile,
    text: String(noteText ?? legacy.full_text ?? legacy.text ?? ""),
    media: [
      ...mediaItems.map(m => {
        // videos/gifs: pick the highest-bitrate mp4 variant so the digest can play inline
        // (the poster image alone was a dead frame + play badge).
        const mp4 = (((m.video_info as Record<string, unknown>)?.variants ?? []) as Array<Record<string, unknown>>)
          .filter(v => v.content_type === "video/mp4")
          .sort((a, b) => Number(b.bitrate ?? 0) - Number(a.bitrate ?? 0))[0]?.url;
        return {
          type: String(m.type) as "photo" | "video" | "gif",
          url: String(m.media_url_https ?? m.media_url ?? ""),
          ...(mp4 ? { video: String(mp4) } : {}),
        };
      }),
      ...card,
      ...article,
    ],
    quoted_id: quoted?.rest_id ? String(quoted.rest_id) : undefined,
    is_thread: Boolean(legacy.self_thread),
    created_at: String(legacy.created_at ?? ""),
    metrics: {
      likes: Number(legacy.favorite_count ?? 0),
      rts: Number(legacy.retweet_count ?? 0),
      replies: Number(legacy.reply_count ?? 0),
      views: Number((result.views as Record<string, unknown>)?.count ?? 0) || undefined,
    },
    captured_at: new Date().toISOString(),
  };
}

// Parse a response body and emit any tweets in it. Because we match ALL /graphql/ traffic (not a
// curated op list), plenty of matched responses are empty, streamed, or non-JSON — those are NORMAL,
// not capture failures, so a parse miss is swallowed silently. A genuine capture-health signal still
// fires from extractTweets() when the JSON parses but the tweet SHAPE has drifted (graphql_schema_miss).
// (The old code called .json() on every match and emitted a hook_error on each failure, flooding the
// durable queue with thousands of "Unexpected end of JSON input" events — see flush.ts.)
function isJson(contentType: string | null): boolean {
  return (contentType ?? "").includes("json");
}

// Membership in your own Likes / Bookmarks timeline IS a confirmed positive — every tweet there is
// one you explicitly endorsed, regardless of where X later positioned it. This harvests your entire
// historical library as labels (the in-session DOM-flip only catches likes made WHILE we watch, and
// the entry-baseline deliberately ignores already-liked tweets). The op NAME is the last /graphql/
// path segment; X rotates the numeric query id but not the name (PRD §5 — match by op name).
// The op name is the last /graphql/ path segment. Match the op FAMILY by prefix, not an exact name:
// verified live, the liked-tweets timeline is "Likes", but the bookmarks timeline is a versioned name
// (X serves "BookmarkFoldersSlice" for folders and a "Bookmark…Timeline…" op for the tweets). A
// prefix survives X's version bumps; variants that carry no tweets (e.g. the folders slice) just mint
// no labels, so over-matching is harmless.
export function opSource(url: string): "like" | "bookmark" | null {
  const op = (url.split("?")[0].split("/").pop() ?? "");
  if (/^Likes/.test(op)) return "like";
  if (/^Bookmark/.test(op)) return "bookmark";
  return null;
}

function emitTweetsFromBody(body: string, source: "like" | "bookmark" | null): void {
  if (!body) return;
  let json: unknown;
  try { json = JSON.parse(body); } catch { return; }
  const tweets = extractTweets(json);
  if (!tweets.length) return;
  window.postMessage({ __afy: true, kind: "tweets", payload: tweets }, "*");
  // On the Likes/Bookmarks timeline, mint a confirmed-positive label per tweet.
  if (source) {
    window.postMessage({ __afy: true, kind: "confirmed", source, ids: tweets.map(t => t.tweet_id) }, "*");
  }
}

// --- Fetch hook ---

const _fetch = window.fetch.bind(window);
window.fetch = async function (...args: Parameters<typeof fetch>) {
  const req = args[0];
  const url = typeof req === "string" ? req : req instanceof URL ? req.toString() : (req as Request).url;

  const res = await _fetch(...args);

  if (TIMELINE_OP_PATTERNS.test(url) && res.ok && isJson(res.headers.get("content-type"))) {
    const source = opSource(url);
    res.clone().text().then(t => emitTweetsFromBody(t, source)).catch(() => { /* body read/clone failed — not a capture miss */ });
  }

  return res;
};

// --- XHR hook ---

const _open = XMLHttpRequest.prototype.open;
const _send = XMLHttpRequest.prototype.send;

XMLHttpRequest.prototype.open = function (method: string, url: string, ...rest: unknown[]) {
  (this as XMLHttpRequest & { __afy_url?: string }).__afy_url = url;
  return (_open as Function).call(this, method, url, ...rest);
};

XMLHttpRequest.prototype.send = function (...args: unknown[]) {
  const xhr = this as XMLHttpRequest & { __afy_url?: string };
  if (xhr.__afy_url && TIMELINE_OP_PATTERNS.test(xhr.__afy_url)) {
    xhr.addEventListener("load", function () {
      if (xhr.status === 200 && isJson(xhr.getResponseHeader("content-type"))) {
        emitTweetsFromBody(xhr.responseText, opSource(xhr.__afy_url ?? ""));
      }
    });
  }
  return (_send as Function).call(this, ...args);
};

// -- Types (duplicated here; shared types live in types.ts but injected script is standalone) --

interface TweetRecord {
  tweet_id: string;
  author_handle: string;
  author_name: string;
  author_avatar: string;
  author_id: string;
  author_profile?: {
    verified: boolean; verified_type?: string;
    affiliate?: { badge: string; title: string };
    bio?: string; followers?: number; following?: number;
  };
  text: string;
  media: { type: "photo" | "video" | "gif" | "card" | "article"; url: string; video?: string; title?: string; preview?: string; domain?: string; link?: string }[];
  quoted_id?: string;
  is_thread: boolean;
  created_at: string;
  metrics: { likes: number; rts: number; replies: number; views?: number };
  captured_at: string;
}
