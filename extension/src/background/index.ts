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
// gatekeeper of what's even eligible. Fix (lazy path, zero API replay): every ~30 min open a
// SHORT-LIVED, never-focused background x.com/home tab, let it capture, close it ~2 min later.
// The PAGE fetches its own timeline with perfect first-party headers; the existing injected hook
// captures those tweets exactly like an organic visit — no query-ID forgery, no bot-pattern API
// calls, nothing to rot when X rotates its GraphQL internals (op-name matching stays untouched).
// The tab's tweets are tagged source:'poll' and mint NO impressions (the content script enforces
// both — see content/index.ts).
//
// v1 kept ONE permanent pinned tab and reloaded it; dogfood verdict: rejected. Closing the pinned
// tab just made the poller recreate it next tick (health log 2026-07-04: four 'created' in two
// hours = user closing it over and over). Ephemeral tab instead: nothing permanent in the strip,
// closing one early costs only that cycle. 2 min is ample for capture — the timeline fetch lands
// in seconds, the content script flushes every 15 s, and tab close fires a pagehide flush; any
// straggler batch sits in page-origin IDB and drains on the next x.com load.
//
// storage.session (NOT a module var): the SW is ephemeral and gets killed between alarms, so the
// tab id must survive in storage. session (not local) is right — the poller tab is a per-browser-
// session artifact; if the browser restarts the old id is meaningless.
// Known hole, accepted: browser quits before the close alarm fires + "continue where you left
// off" → ONE orphan x.com/home tab restores once (stored id died with the session, so it's never
// closed or re-tagged). Benign: close it by hand, it doesn't come back.

const ALARM = "afy-poll";
const CLOSE_ALARM = "afy-poll-close";
const POLL_PERIOD_MIN = 30; // ponytail: fixed 30-min cadence. No tuning UI, no night idling, no
// Following-vs-ForYou control — all explicit M7 non-goals. Bump this const if the corpus grows too
// slowly; adaptive cadence (e.g. back off when the tab is consistently active) is a later lever.
const TAB_LIFE_MIN = 2; // page load + timeline fetch + a full 15-s flush cycle, with slack
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

// Every action is logged loudly (a silent poller is undiagnosable — PRD §5.8 "breakage must be
// loud"): "created" once per tick, then one close-outcome ~2 min later.
// tabs.create/get/remove never required the "tabs" permission — manifest stays ["storage","alarms"].
type PollAction = "created" | "closed" | "close-skipped-active" | "close-already-gone" | "close-noop";

// Close (or disown) the current poller tab. Disown FIRST: once the key is gone the tab can never
// be touched or poll-tagged again, even if the close itself fails — we must never close or tag
// what may have become the user's tab. Runs from the close alarm, and defensively at tick start
// in case a close alarm was ever lost (a leftover tab must not accumulate).
async function closePollerTab(): Promise<{ action: PollAction; tabId?: number }> {
  const id = await getPollerTabId();
  if (id === undefined) return { action: "close-noop" };
  await chrome.storage.session.remove(TAB_KEY);
  const tab = await chrome.tabs.get(id).catch(() => undefined); // rejects = already closed
  if (!tab) return { action: "close-already-gone", tabId: id };
  if (tab.active) return { action: "close-skipped-active", tabId: id }; // user grabbed it — never
  // yank a page they're reading; disowned above, so their next navigation captures organically
  await chrome.tabs.remove(id);
  return { action: "closed", tabId: id };
}

// One poll tick: open a fresh background tab, remember it, arm its close alarm. The content
// script asks "am I the poller?" at document_start, so the id must be stored before the page
// loads — tabs.create resolves pre-navigation, and storage.set wins that race (same event loop,
// network is slower; a lost race degrades safe anyway: the tab captures as organic).
async function pollTick(): Promise<{ action: PollAction; tabId?: number }> {
  await closePollerTab().catch(() => {}); // leftover from a lost close alarm, if any
  const created = await chrome.tabs.create({ url: POLLER_HOME, active: false });
  await chrome.storage.session.set({ [TAB_KEY]: created.id });
  chrome.alarms.create(CLOSE_ALARM, { delayInMinutes: TAB_LIFE_MIN });
  return { action: "created", tabId: created.id };
}

chrome.alarms.onAlarm.addListener(alarm => {
  const work =
    alarm.name === ALARM ? pollTick() :
    alarm.name === CLOSE_ALARM ? closePollerTab() :
    undefined;
  work
    ?.then(({ action, tabId }) => {
      // Emit a capture_health event per action through the EXISTING ingest path (reuse
      // postToIngest, no new endpoint). kind:"poll_tick" so /status and any health query can see
      // the poller is alive and what it did — the loud signal separating "working" from "wedged".
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
