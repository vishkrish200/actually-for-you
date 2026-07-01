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
  // DOM is the gap-filler; a net record for the same id always wins (ingest writes net first).
  source?: "net" | "dom";
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
  kind: "graphql_schema_miss" | "selector_miss" | "hook_error";
  detail: string;
}
