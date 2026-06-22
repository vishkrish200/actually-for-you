// Content script: isolated world.
// Owns DOM observation (dwell, clicks, expands) + IndexedDB queue.
// Receives tweet content from injected script via postMessage.

import { openQueue, enqueue, drainQueue, deleteKeys } from "./idb-queue";
import { DwellTracker } from "./dwell-tracker";
import type { ImpressionEvent, CaptureHealthEvent } from "../types";

let sessionId = crypto.randomUUID();
let lastActivity = Date.now();
const SESSION_IDLE_MS = 30 * 60 * 1000; // ponytail: tunable in M12

// --- IndexedDB queue (durable; SW drains it) ---
const queueReady = openQueue();

async function emit(event: ImpressionEvent | CaptureHealthEvent) {
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
    emit({ ...ev, session_id: sessionId });
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

// ponytail: silently stop on invalidation — expected when extension reloads mid-session
function send(msg: unknown) {
  try { chrome.runtime.sendMessage(msg); } catch { /* context invalidated */ }
}

// --- Receive tweet content from injected page script ---
window.addEventListener("message", (e: MessageEvent) => {
  if (!e.data?.__afy) return;
  if (e.data.kind === "tweets") send({ kind: "tweets", payload: e.data.payload });
  if (e.data.kind === "capture_health") emit(e.data.detail as CaptureHealthEvent);
});

// --- Flush queue on page hide — drain IDB here (content script owns the page-origin IDB) ---
document.addEventListener("visibilitychange", async () => {
  if (!document.hidden) return;
  await queueReady;
  const rows = await drainQueue();
  if (!rows.length) return;
  send({ kind: "impressions", payload: rows.map(r => r.value) });
  await deleteKeys(rows.map(r => r.key));
});
