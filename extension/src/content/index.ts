// Content script: isolated world.
// Owns DOM observation (dwell, clicks, expands) + IndexedDB queue.
// Receives tweet content from injected script via postMessage.

import { openQueue, enqueue } from "./idb-queue";
import { DwellTracker } from "./dwell-tracker";
import type { ImpressionEvent, CaptureHealthEvent } from "../types";

let sessionId = crypto.randomUUID();
let lastActivity = Date.now();
const SESSION_IDLE_MS = 30 * 60 * 1000; // ponytail: tunable in M12

// --- Inject the page-context network hook ---
const script = document.createElement("script");
script.src = chrome.runtime.getURL("injected.js");
script.onload = () => script.remove();
(document.head ?? document.documentElement).prepend(script);

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

// --- Receive tweet content from injected page script ---
window.addEventListener("message", (e: MessageEvent) => {
  if (!e.data?.__afy) return;
  if (e.data.kind === "tweets") {
    // Forward to SW for storage
    chrome.runtime.sendMessage({ kind: "tweets", payload: e.data.payload });
  }
  if (e.data.kind === "capture_health") {
    emit(e.data.detail as CaptureHealthEvent);
  }
});

// --- Flush queue on page hide (sendBeacon handled in SW via runtime message) ---
document.addEventListener("visibilitychange", () => {
  if (document.hidden) chrome.runtime.sendMessage({ kind: "flush" });
});
