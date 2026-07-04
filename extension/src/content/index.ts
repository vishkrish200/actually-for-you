// Content script: isolated world.
// Owns DOM observation (dwell, clicks, expands) + IndexedDB queue.
// Receives tweet content from injected script via postMessage.

import { openQueue, enqueue, drainQueue, deleteKeys } from "./idb-queue";
import { type QueuedEvent } from "./queue-router";
import { flushInChunks } from "./flush";
import { DwellTracker } from "./dwell-tracker";
import { tagTweets, shouldEmitImpression } from "./poll-source";
import type { ImpressionEvent, CaptureHealthEvent, TweetRecord } from "../types";

let sessionId = crypto.randomUUID();
let lastActivity = Date.now();
const SESSION_IDLE_MS = 30 * 60 * 1000; // ponytail: tunable in M12

// --- M7: am I the poller tab? ---
// The SW keeps ONE pinned, never-focused x.com/home tab (see background/index.ts) that it reloads
// every ~30 min to widen the candidate corpus. If THIS tab is that one, its tweets are candidates
// ONLY (source:'poll') and it must mint NO impressions/dwell/engagement — the user never looked at
// it, so any behavioral signal from it would be fabricated (CLAUDE.md: polled tweets never label).
//
// We ask the SW at document_start and cache the answer. The reply is async, so there's a ms-scale
// window at page load where isPoller is still false. That race is harmless: dwell is visibility-
// gated (the poller tab loads with document.hidden true → dwell.pauseAll keeps every timer paused),
// and the very first timeline fetch takes far longer than the round-trip, so no real tweet or
// impression is emitted before the flag lands. isPoller defaults false → an organic tab behaves
// exactly as before if the message ever fails (fail safe: capture normally, never wrongly drop).
let isPoller = false;
try {
  chrome.runtime.sendMessage({ kind: "am_i_poller" }, res => {
    if (!chrome.runtime.lastError && (res as { poller?: boolean } | undefined)?.poller) isPoller = true;
  });
} catch { /* context invalidated at load — stay organic; a reload re-asks */ }

// --- IndexedDB queue (durable; drained on tab-hide, keys deleted only after the server confirms) ---
const queueReady = openQueue();

async function emit(event: QueuedEvent) {
  await queueReady;
  await enqueue(event);
}

// --- Session refresh ---
function refreshSession() {
  const now = Date.now();
  if (now - lastActivity > SESSION_IDLE_MS) sessionId = crypto.randomUUID();
  lastActivity = now;
}

// --- Dwell tracker ---
const dwell = new DwellTracker({
  onImpression: (ev: Omit<ImpressionEvent, "session_id">) => {
    // M7: the poller tab drops ALL impressions (belt; the document.hidden → dwell.pauseAll gate is
    // the suspenders). Never queue a behavioral signal from a tab the user never looked at.
    if (!shouldEmitImpression(isPoller)) return;
    refreshSession();
    emit({ __k: "impression", v: { ...ev, session_id: sessionId } });
  },
  // DOM-scraped content fallback (source:"dom") — fills the gap for tweets the GraphQL hook never
  // saw. Same durable queue as network tweets; ingest writes net first so a richer record wins.
  // On the poller tab tagTweets rewrites source:"dom"→"poll" (candidate-only, like every record
  // from that tab); the server's net > dom > poll precedence upgrades it on any later organic view.
  onContent: (tweet: TweetRecord) => emit({ __k: "tweets", v: tagTweets([tweet], isPoller) }),
});
dwell.start();

// --- Tab visibility: pause/resume all timers ---
document.addEventListener("visibilitychange", () => {
  if (document.hidden) dwell.pauseAll();
  else dwell.resumeAll();
});
window.addEventListener("blur", () => dwell.pauseAll());
window.addEventListener("focus", () => dwell.resumeAll());

// Send to the SW and resolve with whether the server actually wrote it (SW echoes POST success).
// Resolves false on a swallowed context-invalidation too — so the queue is never dropped blindly.
function send(msg: unknown): Promise<boolean> {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage(msg, res => resolve(!chrome.runtime.lastError && !!(res as { ok?: boolean })?.ok));
    } catch { resolve(false); /* context invalidated — keep the data for next flush */ }
  });
}

// --- Receive tweet content from injected page script — enqueue durably, don't fire-and-forget ---
// The injected hook (network-hook.ts, MAIN world) is UNTOUCHED by M7 — it never knows it's the
// poller tab. The poll tagging happens HERE, at the isolated-world seam, via tagTweets: on the
// poller tab every network-captured tweet becomes source:'poll' (candidate-only). On an organic tab
// tagTweets is a pass-through, so source stays undefined → the server defaults it to 'net' as before.
window.addEventListener("message", (e: MessageEvent) => {
  if (!e.data?.__afy) return;
  if (e.data.kind === "tweets") emit({ __k: "tweets", v: tagTweets(e.data.payload as TweetRecord[], isPoller) });
  if (e.data.kind === "capture_health") emit({ __k: "health", v: e.data.detail as CaptureHealthEvent });
  // Confirmed-positive labels harvested from the Likes/Bookmarks timeline. NOTE: the poller only
  // ever loads x.com/home, never the Likes/Bookmarks timelines, so no "confirmed" message can
  // originate from it — these stay genuine hand-endorsed positives regardless of isPoller.
  if (e.data.kind === "confirmed") emit({ __k: "confirmed", v: { source: e.data.source, ids: e.data.ids } });
});

// --- Flush the durable queue to the server. Content script owns the page-origin IDB; the SW does
// the actual POST (only the extension can reach http://localhost — the HTTPS page is blocked by
// mixed-content). Keys are deleted ONLY after the server confirms, and we drain in bounded chunks
// so a large backlog can't wedge into an all-or-nothing batch that never succeeds. ---
let flushing = false;
async function flush() {
  if (flushing) return; // a flush is already in flight — periodic + visibilitychange must not overlap
  flushing = true;
  try {
    await queueReady;
    const rows = await drainQueue();
    if (rows.length) {
      await flushInChunks(rows as { key: IDBValidKey; value: QueuedEvent }[], send, deleteKeys);
    }
  } finally {
    flushing = false;
  }
}

// Periodic flush so capture reaches the server during a long scroll session — not held hostage to
// a tab switch (the prior sole trigger meant a focused tab buffered forever). ponytail: fixed 15s
// interval; make it adaptive to queue depth only if 15s ever proves too slow under heavy capture.
setInterval(flush, 15_000);
// Tab hidden / navigating away — flush immediately so nothing waits a full interval.
document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); });
window.addEventListener("pagehide", () => flush());
