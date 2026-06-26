// Pure routing for the durable queue. Each queued row is tagged with __k; on drain we split the
// mixed stream back into the three ingest arrays. Kept pure (no IDB/chrome) so it's unit-testable.

export type QueuedEvent =
  | { __k: "impression"; v: unknown }
  | { __k: "tweets"; v: unknown[] }   // a whole batch from one GraphQL response
  | { __k: "health"; v: unknown }
  | { __k: "confirmed"; v: unknown }; // a Likes/Bookmarks batch → confirmed-positive labels

export function partition(values: QueuedEvent[]): {
  impressions: unknown[]; tweets: unknown[]; health: unknown[]; confirmed: unknown[];
} {
  const impressions: unknown[] = [];
  const tweets: unknown[] = [];
  const health: unknown[] = [];
  const confirmed: unknown[] = [];
  for (const e of values) {
    if (!e || typeof e !== "object") continue;
    if (e.__k === "impression") impressions.push(e.v);
    else if (e.__k === "tweets" && Array.isArray(e.v)) tweets.push(...e.v);
    else if (e.__k === "health") health.push(e.v);
    else if (e.__k === "confirmed") confirmed.push(e.v);
  }
  return { impressions, tweets, health, confirmed };
}
