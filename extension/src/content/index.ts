// Content script: isolated world.
// Owns DOM observation (dwell, clicks, expands) + IndexedDB queue.
// Receives tweet content from injected script via postMessage.

import { openQueue, enqueue, drainQueue, deleteKeys } from "./idb-queue";
import { type QueuedEvent } from "./queue-router";
import { flushInChunks } from "./flush";
import { DwellTracker } from "./dwell-tracker";
import type { ImpressionEvent, CaptureHealthEvent, TweetRecord } from "../types";

let sessionId = crypto.randomUUID();
let lastActivity = Date.now();
const SESSION_IDLE_MS = 30 * 60 * 1000; // ponytail: tunable in M12

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
    refreshSession();
    emit({ __k: "impression", v: { ...ev, session_id: sessionId } });
  },
  // DOM-scraped content fallback (source:"dom") — fills the gap for tweets the GraphQL hook never
  // saw. Same durable queue as network tweets; ingest writes net first so a richer record wins.
  onContent: (tweet: TweetRecord) => emit({ __k: "tweets", v: [tweet] }),
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
window.addEventListener("message", (e: MessageEvent) => {
  if (!e.data?.__afy) return;
  if (e.data.kind === "tweets") emit({ __k: "tweets", v: e.data.payload as TweetRecord[] });
  if (e.data.kind === "capture_health") emit({ __k: "health", v: e.data.detail as CaptureHealthEvent });
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
