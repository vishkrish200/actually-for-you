export interface TweetRecord {
  tweet_id: string;
  author_handle: string;
  author_name: string;
  author_avatar?: string;   // X's pbs.twimg.com profile-image URL (no rate limit)
  author_id: string;
  text: string;
  media: { type: "photo" | "video" | "gif"; url: string }[];
  is_thread: boolean;
  created_at: string;
  metrics: { likes: number; rts: number; replies: number; views?: number };
  captured_at: string;
  // "net" = parsed from a GraphQL response (rich: metrics, author_id, created_at).
  // "dom" = scraped from the rendered article when X served the tweet from its client cache
  // or fetched it before our network hook installed, so no response crossed the wire to parse.
  // "poll" = captured by the M7 background poller tab (a pinned, never-focused x.com/home tab the
  // SW reloads every ~30 min). Same GraphQL hook, same shape — but these are CANDIDATES ONLY: the
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
