// M7 poller-tab policy, kept PURE (no chrome/DOM/IDB) so it's unit-testable without a SW mock —
// the chrome.* alarm/tab plumbing in background/index.ts is verified by manual dogfood, but THIS
// (the invariant that a polled tab tags candidates and mints no behavioral labels) is the part with
// a correctness bug surface, so it gets tests.
//
// Two rules, both gated on "is this the poller tab?":
//  1. tagTweets: every outgoing tweet record from the poller tab gets source:'poll' — overriding
//     whatever source it had (net from the GraphQL hook, dom from the article scraper). The whole
//     tab is a candidate-only source; the server's net > dom > poll precedence then lets any later
//     ORGANIC capture of the same id upgrade the row (see server.ts). When NOT the poller, records
//     pass through untouched (an organic net tweet keeps its undefined source → server defaults it
//     to 'net', exactly as before M7).
//  2. dropImpressions: the poller tab emits NO impressions, ever — belt to the visibility-gate's
//     suspenders. The user never looked at that tab; dwell/opened/engagement from it would be
//     fabricated signal, and CLAUDE.md forbids ever minting labels from polled tweets. So we drop
//     at the emit seam regardless of what the (paused) dwell tracker produces.

import type { TweetRecord } from "../types";

export function tagTweets(tweets: TweetRecord[], isPoller: boolean): TweetRecord[] {
  if (!isPoller) return tweets;
  return tweets.map(t => ({ ...t, source: "poll" as const }));
}

// Returns whether an impression from this tab should be emitted at all. Trivial today, but named so
// the call site reads as an intentional invariant, not an accident — and so the test asserts it.
export function shouldEmitImpression(isPoller: boolean): boolean {
  return !isPoller;
}
