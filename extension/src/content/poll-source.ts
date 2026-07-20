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

// ---- M15: watermark autoscroll STOP rule (pure — the loop's chrome/DOM plumbing lives in
// content/index.ts, but THIS decides when a poller tab has scrolled deep enough) ----
//
// A catch-up tick loads the chronological follows search, so "deep enough" is well-defined: once
// the rendered tail is older than the last poll tick, everything below is already captured. Per scroll
// step the caller hands us the rendered tweets' timestamps in DOM order (top→bottom); we stop when
// the TRAILING run of older-than-watermark tweets reaches OLDER_TAIL_RUN. A run — not one tweet —
// because a retweet renders the ORIGINAL tweet's (possibly ancient) timestamp inside an otherwise
// fresh stream; one stale-looking row must not end an overnight catch-up. Interior old rows (fresh
// tweets rendered below them) break the run for the same reason.
//
// SCROLL_CAP bounds a catch-up that never meets the watermark (first-ever tick, or a >24h gap);
// EMPTY_STREAK_LIMIT stops a page where no <time> elements render at all (X DOM churn) — that stop
// is breakage and the caller must emit capture_health, never spin blind (PRD §5.8).

export const SCROLL_CAP = 40;
export const OLDER_TAIL_RUN = 3;
export const EMPTY_STREAK_LIMIT = 3;

// ---- M15 pivot (2026-07-18): when is a tick a CATCH-UP tick? ----
// Steady-state ticks poll For You exactly as M7 did — no autoscroll (the watermark stop rule
// assumes time order, which For You doesn't have). A tick that wakes from a real gap (laptop
// slept through >2 cadences) polls the chronological filter:follows search instead and
// autoscrolls to the watermark: the last tick time minus slack, capped at 24h back so a
// week-long gap (or the first-ever tick) doesn't ask for the moon — SCROLL_CAP bounds it anyway.
export const CATCHUP_GAP_MS = 60 * 60 * 1000;
export const WATERMARK_SLACK_MS = 15 * 60 * 1000;
export const WATERMARK_CAP_MS = 24 * 3600 * 1000;

export type CatchupPlan = { catchup: false } | { catchup: true; scrollUntil: number };

export function catchupPlan(prevTickMs: number | undefined, nowMs: number): CatchupPlan {
  if (prevTickMs !== undefined && nowMs - prevTickMs <= CATCHUP_GAP_MS) return { catchup: false };
  const scrollUntil = Math.max(
    prevTickMs === undefined ? 0 : prevTickMs - WATERMARK_SLACK_MS,
    nowMs - WATERMARK_CAP_MS,
  );
  return { catchup: true, scrollUntil };
}

export type ScrollDecision =
  | { kind: "continue"; emptyStreak: number }
  | { kind: "stop"; reason: "watermark" | "cap" | "no-times" };

export function decideScroll(
  timesMs: number[],       // rendered tweets' timestamps, DOM order (top→bottom)
  scrollUntilMs: number,   // watermark: last poll tick minus slack
  scrollsDone: number,     // scroll steps already performed
  emptyStreak: number,     // consecutive prior steps that rendered zero <time> elements
  sawAnyBefore: boolean,   // has ANY prior step rendered a timestamp?
): ScrollDecision {
  if (scrollsDone >= SCROLL_CAP) return { kind: "stop", reason: "cap" };
  if (timesMs.length === 0) {
    // Dogfood 2026-07-18: a never-visible background tab is render-throttled by Chrome — X's app
    // can take well past 3 steps to mount the timeline, and every catch-up died "no-times" at
    // step 3 before the page existed. Empty steps BEFORE any content has rendered are "still
    // loading", not blindness, and don't count toward the limit (SCROLL_CAP still bounds the
    // wait). "no-times" now means what it says: content was there, then the selector went blind.
    if (!sawAnyBefore) return { kind: "continue", emptyStreak: 0 };
    const streak = emptyStreak + 1;
    if (streak >= EMPTY_STREAK_LIMIT) return { kind: "stop", reason: "no-times" };
    return { kind: "continue", emptyStreak: streak };
  }
  let run = 0;
  for (let i = timesMs.length - 1; i >= 0 && timesMs[i] < scrollUntilMs; i--) run++;
  if (run >= OLDER_TAIL_RUN) return { kind: "stop", reason: "watermark" };
  return { kind: "continue", emptyStreak: 0 };
}
