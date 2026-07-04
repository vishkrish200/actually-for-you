// Service worker — ephemeral under MV3. Holds NO durable state; storage.session is the only home
// for the poller tab id (see M7 below). Content script drains its own IDB and sends impression
// batches here via message; the SW's only jobs are (1) relay those batches to the ingest server
// and (2) run the M7 candidate-acquisition poller.

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

// ---- M7: independent candidate acquisition (the poller tab) ----
// Problem: we only rank tweets the user happened to scroll past — X's algorithm is the upstream
// gatekeeper of what's even eligible. Fix (lazy path, zero API replay): keep ONE pinned, never-
// focused x.com/home tab alive and reload it every ~30 min. The PAGE fetches its own timeline with
// perfect first-party headers; the existing injected hook captures those tweets exactly like an
// organic visit — no query-ID forgery, no bot-pattern API calls, nothing to rot when X rotates its
// GraphQL internals (op-name matching stays untouched). The reloaded page's tweets are tagged
// source:'poll' and mint NO impressions (the content script enforces both — see content/index.ts).
//
// storage.session (NOT a module var): the SW is ephemeral and gets killed between alarms, so the
// tab id must survive in storage. session (not local) is right — the poller tab is a per-browser-
// session artifact; if the browser restarts the old id is meaningless and onStartup re-seeds it.

const ALARM = "afy-poll";
const POLL_PERIOD_MIN = 30; // ponytail: fixed 30-min cadence. No tuning UI, no night idling, no
// Following-vs-ForYou control — all explicit M7 non-goals. Bump this const if the corpus grows too
// slowly; adaptive cadence (e.g. back off when the tab is consistently active) is a later lever.
const POLLER_HOME = "https://x.com/home";
const TAB_KEY = "pollerTabId";

async function getPollerTabId(): Promise<number | undefined> {
  const got = await chrome.storage.session.get(TAB_KEY);
  return got[TAB_KEY] as number | undefined;
}

// Register the periodic alarm idempotently from BOTH onInstalled (fresh install / reload / update)
// and onStartup (browser relaunch — session storage was cleared, so any stored tab id is stale and
// the next tick will find-or-create afresh). chrome.alarms.create with the same name replaces the
// existing alarm, so double-registration is harmless. periodInMinutes handles the recurring fire;
// no manual re-arm, and it survives the SW being killed (that's the whole point of alarms over
// setTimeout, which dies with the ephemeral worker).
function registerAlarm() {
  chrome.alarms.create(ALARM, { periodInMinutes: POLL_PERIOD_MIN });
}
chrome.runtime.onInstalled.addListener(registerAlarm);
chrome.runtime.onStartup.addListener(registerAlarm);

// One poll tick. Returns the action taken so it can be logged loudly (a silent poller is
// undiagnosable — PRD §5.8 "breakage must be loud"). We reach the same x.com/home tab across ticks:
//  - tab exists & on x.com & NOT active → reload it (the page refetches its timeline). We SKIP the
//    reload when tab.active — never yank a page the user is actually looking at (they may be reading
//    the poller tab if they clicked it). A skipped tick still logs, so a permanently-active tab is
//    visible in the health stream rather than looking like silent death.
//  - tab missing / gone / navigated off x.com → (re)create a pinned, background, never-focused
//    x.com/home tab and remember its id.
// Reading tab.url for an x.com tab does NOT need the "tabs" permission: host_permissions already
// grants x.com, which populates url/pendingUrl for matching tabs. tabs.get/create/reload themselves
// never required "tabs". Verified: manifest stays ["storage","alarms"], no "tabs" added.
type PollAction = "created" | "reloaded" | "skipped-active";

async function pollTick(): Promise<{ action: PollAction; tabId: number }> {
  const storedId = await getPollerTabId();
  if (storedId !== undefined) {
    // chrome.tabs.get rejects if the tab was closed — treat that as "gone" and fall through to
    // create. We also re-check the URL: the user could have navigated the pinned tab elsewhere, in
    // which case it's no longer OUR poller and reloading it would be rude + useless for capture.
    const tab = await chrome.tabs.get(storedId).catch(() => undefined);
    const onX = !!tab && !!(tab.url ?? tab.pendingUrl) &&
      /^https:\/\/(x|twitter)\.com\//.test(tab.url ?? tab.pendingUrl ?? "");
    if (tab && onX) {
      if (tab.active) return { action: "skipped-active", tabId: storedId };
      await chrome.tabs.reload(storedId);
      return { action: "reloaded", tabId: storedId };
    }
  }
  const created = await chrome.tabs.create({ url: POLLER_HOME, pinned: true, active: false });
  await chrome.storage.session.set({ [TAB_KEY]: created.id });
  return { action: "created", tabId: created.id! };
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== ALARM) return;
  pollTick()
    .then(({ action, tabId }) => {
      // Emit a capture_health event per tick through the EXISTING ingest path (reuse postToIngest,
      // no new endpoint). kind:"poll_tick" so /status and any health query can see the poller is
      // alive and what it did each tick — the loud signal that separates "working" from "wedged".
      // Fire-and-forget: if the server is down this drops (like any health event), but the next
      // tick re-emits; the poller's job is capture, not guaranteed telemetry delivery.
      return postToIngest({
        health: [{
          ts: new Date().toISOString(),
          kind: "poll_tick",
          detail: JSON.stringify({ action, tabId }),
        }],
      });
    })
    .catch(() => { /* tabs API failure (e.g. tab race) — next tick retries; nothing to persist */ });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.kind === "flush") {
    postToIngest({ tweets: msg.tweets, impressions: msg.impressions, health: msg.health, confirmed: msg.confirmed })
      .then(ok => sendResponse({ ok }));
    return true; // async sendResponse — keep the channel open
  }
  // M7: content scripts ask at document_start whether THEY are the poller tab, so they can tag
  // their tweets source:'poll' and drop impressions. Answer from storage.session (the SW may have
  // been killed and revived since the tab was created, so this must not depend on a module var).
  if (msg.kind === "am_i_poller") {
    getPollerTabId()
      .then(id => sendResponse({ poller: sender.tab?.id !== undefined && sender.tab.id === id }))
      .catch(() => sendResponse({ poller: false })); // storage read failed → assume organic (safe:
      // a false negative captures normally; a false positive would drop a real user's impressions)
    return true; // async sendResponse
  }
  sendResponse({ ok: true });
  return false;
});
