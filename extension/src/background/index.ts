// Service worker — ephemeral under MV3. Holds NO state.
// Content script drains its own IDB and sends impression batches here via message.

const INGEST = "http://localhost:2727/ingest";

// Ingest write auth (PRD §5.8) — injected at build time by build.sh from ../ingest/.env.local,
// "" when unset. Never lives in committed source; a mismatch 401s and the batch waits in IDB.
declare const __AFY_TOKEN__: string;

async function postToIngest(body: object): Promise<boolean> {
  try {
    const res = await fetch(INGEST, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-afy-token": __AFY_TOKEN__ },
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
