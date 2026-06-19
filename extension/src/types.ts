export interface TweetRecord {
  tweet_id: string;
  author_handle: string;
  author_id: string;
  text: string;
  media: { type: "photo" | "video" | "gif"; url: string }[];
  is_thread: boolean;
  created_at: string;
  metrics: { likes: number; rts: number; replies: number; views?: number };
  captured_at: string;
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
