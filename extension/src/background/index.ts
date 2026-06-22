// Service worker — ephemeral under MV3. Holds NO state.
// Content script drains its own IDB and sends impression batches here via message.

const INGEST = "http://localhost:2727/ingest";

async function postToIngest(body: object) {
  await fetch(INGEST, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {}); // ponytail: on server-down, data is lost for tweets; impressions already deleted from IDB
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.kind === "tweets") postToIngest({ tweets: msg.payload });
  if (msg.kind === "impressions") postToIngest({ impressions: msg.payload });
  sendResponse({ ok: true });
  return false;
});
