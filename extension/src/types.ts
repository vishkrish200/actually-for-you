export interface TweetRecord {
  tweet_id: string;
  author_handle: string;
  author_name: string;
  author_avatar?: string;   // X's pbs.twimg.com profile-image URL (no rate limit)
  author_id: string;
  // Verification / affiliation / bio / follower counts — feeds the digest's badges and hover
  // card so the user can judge WHO posted without opening X. Stored opaquely as JSON (like
  // media); UI-only, never a ranking feature.
  author_profile?: {
    verified: boolean;          // blue check (or implied by a paid verified_type)
    verified_type?: string;     // "Business" (gold) | "Government" (gray); absent = blue
    affiliate?: { badge: string; title: string }; // small org badge next to the name
    bio?: string;
    followers?: number;
    following?: number;
  };
  text: string;
  media: { type: "photo" | "video" | "gif"; url: string }[];
  // rest_id of the tweet this one quotes, if any. The quoted tweet itself is already captured as
  // its own row (walk() recurses into quoted_status_result); this field records the RELATIONSHIP
  // so the digest can render the quoted context inline instead of a context-free quote shell.
  quoted_id?: string;
  is_thread: boolean;
  created_at: string;
  metrics: { likes: number; rts: number; replies: number; views?: number };
  captured_at: string;
  // "net" = parsed from a GraphQL response (rich: metrics, author_id, created_at).
  // "dom" = scraped from the rendered article when X served the tweet from its client cache
  // or fetched it before our network hook installed, so no response crossed the wire to parse.
  // "poll" = captured by the M7 background poller tab (a short-lived, never-focused x.com/home tab
  // the SW opens every ~30 min, closes ~2 min later). Same GraphQL hook, same shape — but these are CANDIDATES ONLY: the
  // user never looked at that tab, so a polled row must never carry an impression/dwell/engagement
  // label (the content script drops all impressions from the poller). Ranked precedence at upsert
  // is net > dom > poll: an organic capture always upgrades a polled row, poll never clobbers net/
  // dom. So "poll" widens the candidate corpus (X's algorithm is no longer the sole gatekeeper of
  // what's eligible) without polluting the behavioral signal.
  source?: "net" | "dom" | "poll";
}

export interface ImpressionEvent {
  impression_id: string;
  tweet_id: string;
  session_id: string;
  ts: string;
  position_in_feed: number;
  dwell_ms: number;
  max_visible_pct: number;
  scroll_velocity_at_entry: number;
  flicked: boolean;
  opened_detail: boolean;
  profile_expanded: "none" | "hovercard" | "clickthrough";
  liked: boolean;
  rt: boolean;
  bookmarked: boolean;
  replied: boolean;
  // negative feedback (mirrors X's heavy-ranker negative heads: report is isolated at the
  // largest magnitude, the soft three — not-interested/"show fewer", mute, block — are bundled).
  reported: boolean;
  negative_feedback: boolean;
  // confounder controls — never reward features
  media_present: boolean;
  is_thread: boolean;
  char_len: number;
}

export interface CaptureHealthEvent {
  ts: string;
  // "poll_tick" is emitted by the M7 background poller once per ~30-min alarm (detail carries the
  // action taken + tab id) — not a breakage signal but a liveness heartbeat: a silent poller is
  // undiagnosable, so every tick leaves a row in capture_health (PRD §5.8 "breakage must be loud").
  kind: "graphql_schema_miss" | "selector_miss" | "hook_error" | "poll_tick";
  detail: string;
}
