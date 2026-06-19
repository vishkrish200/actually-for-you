// Service worker — ephemeral under MV3. Holds NO state.
// Drains the IndexedDB queue (written by content script) to the ingest endpoint.
// ponytail: no ingest server yet (M2); for M0 just log to console.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.kind === "tweets") {
    console.log("[afy] tweets captured:", msg.payload);
    sendResponse({ ok: true });
  }
  if (msg.kind === "flush") {
    console.log("[afy] flush requested");
    sendResponse({ ok: true });
  }
  return false;
});

// M0: log impression events relayed from content script
// (content script enqueues to IDB; SW will drain in M2)
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.kind === "impression") {
    console.log("[afy] impression:", JSON.stringify(msg.payload, null, 2));
  }
});
