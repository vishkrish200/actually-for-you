// Content script: isolated world.
// Owns DOM observation (dwell, clicks, expands) + IndexedDB queue.
// Receives tweet content from injected script via postMessage.

import { openQueue, enqueue, drainQueue, deleteKeys } from "./idb-queue";
import { partition, type QueuedEvent } from "./queue-router";
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

// --- Flush queue on page hide — drain IDB here (content script owns the page-origin IDB).
// Tweets + impressions + health all ride the one durable queue; keys are deleted ONLY after the
// server confirms the write, so a fast-scroll burst, a dormant SW, or a momentarily-down server
// no longer loses content (it retries on the next flush). ---
document.addEventListener("visibilitychange", async () => {
  if (!document.hidden) return;
  await queueReady;
  const rows = await drainQueue();
  if (!rows.length) return;
  const { impressions, tweets, health } = partition(rows.map(r => r.value as QueuedEvent));
  const ok = await send({ kind: "flush", impressions, tweets, health });
  if (ok) await deleteKeys(rows.map(r => r.key));
});
