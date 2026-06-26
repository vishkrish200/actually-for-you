// Service worker — ephemeral under MV3. Holds NO state.
// Content script drains its own IDB and sends impression batches here via message.

const INGEST = "http://localhost:2727/ingest";

async function postToIngest(body: object): Promise<boolean> {
  try {
    const res = await fetch(INGEST, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false; // server down — content script keeps the batch in IDB and retries next flush
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.kind === "flush") {
    postToIngest({ tweets: msg.tweets, impressions: msg.impressions, health: msg.health, confirmed: msg.confirmed })
      .then(ok => sendResponse({ ok }));
    return true; // async sendResponse — keep the channel open
  }
  sendResponse({ ok: true });
  return false;
});
