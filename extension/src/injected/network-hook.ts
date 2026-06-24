// Runs in PAGE context (not isolated world) so we can wrap fetch/XHR.
// Captures X GraphQL timeline responses and postMessages them to the content script.

// Match ANY X GraphQL response, not a hand-maintained op-name list — the shape-based walk only
// emits objects that are actually tweets (rest_id + legacy.full_text), so scanning every GraphQL
// payload harmlessly captures tweets from whatever surface the user scrolls (home, profile,
// search, lists, conversation). Op names rotate and multiply; the endpoint path does not.
const TIMELINE_OP_PATTERNS = /\/graphql\//;

function extractTweets(json: unknown): TweetRecord[] {
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
    // key the impression to either's ID from the DOM.
    if (legacy.retweeted_status_result) walk(legacy.retweeted_status_result, out);
    if (legacy.quoted_status_result) walk(legacy.quoted_status_result, out);
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

  return {
    tweet_id,
    author_handle: String(userCore?.screen_name ?? userLegacy?.screen_name ?? ""),
    author_name: String(userCore?.name ?? userLegacy?.name ?? ""),
    author_id: String(userResult?.rest_id ?? ""),
    text: String(legacy.full_text ?? legacy.text ?? ""),
    media: mediaItems.map(m => ({
      type: String(m.type) as "photo" | "video" | "gif",
      url: String(m.media_url_https ?? m.media_url ?? ""),
    })),
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

// --- Fetch hook ---

const _fetch = window.fetch.bind(window);
window.fetch = async function (...args: Parameters<typeof fetch>) {
  const req = args[0];
  const url = typeof req === "string" ? req : req instanceof URL ? req.toString() : (req as Request).url;

  const res = await _fetch(...args);

  if (TIMELINE_OP_PATTERNS.test(url)) {
    res.clone().json().then(json => {
      const tweets = extractTweets(json);
      if (tweets.length) window.postMessage({ __afy: true, kind: "tweets", payload: tweets }, "*");
    }).catch(e => {
      window.postMessage({ __afy: true, kind: "capture_health", detail: { kind: "hook_error", detail: String(e) } }, "*");
    });
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
      try {
        const json = JSON.parse(xhr.responseText);
        const tweets = extractTweets(json);
        if (tweets.length) window.postMessage({ __afy: true, kind: "tweets", payload: tweets }, "*");
      } catch (e) {
        window.postMessage({ __afy: true, kind: "capture_health", detail: { kind: "hook_error", detail: String(e) } }, "*");
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
  author_id: string;
  text: string;
  media: { type: "photo" | "video" | "gif"; url: string }[];
  is_thread: boolean;
  created_at: string;
  metrics: { likes: number; rts: number; replies: number; views?: number };
  captured_at: string;
}
