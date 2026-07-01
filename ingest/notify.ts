import type { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildFeed, type Candidate } from "./ranker.ts";

const execFileP = promisify(execFile);

// After each flush, push the top-ranked tweets to a personal channel so capture +
// ranker quality can be eyeballed without opening the reader. Channel precedence:
//   AFY_IMESSAGE_TO set -> native macOS iMessage (Messages.app)
//   else POKE_API_KEY set -> Poke
//   else -> log digest to stdout (formatting still verifiable)

const COOLDOWN_MS = Number(process.env.AFY_NOTIFY_COOLDOWN_MS ?? 15 * 60 * 1000);
const TOP_N = Number(process.env.AFY_NOTIFY_TOP_N ?? 5);
const POKE_URL = process.env.POKE_URL ?? "https://poke.com/api/v1/inbound/api-message";
const IMESSAGE_TO = process.env.AFY_IMESSAGE_TO;

let lastNotified = 0; // ponytail: in-memory gate; resets on server restart, fine for one user.

export interface FreshTweet {
  tweet_id: string;
  author_handle: string | null;
  author_name: string | null;
  text: string | null;
}

function snippet(text: string | null, n = 100): string {
  return (text ?? "").replace(/\s+/g, " ").trim().slice(0, n) || "(no text captured)";
}

// ✦ marks a tweet captured *with a handle* — i.e. captured after the screen_name fix.
// (All historical tweets are handle-less, so handle-presence is an exact proxy for "new".)
export function formatDigest(
  tweets: (Candidate & { score: number })[],
  fresh: FreshTweet[] = [],
): string {
  const lines = tweets.map((t, i) => {
    const isNew = !!t.author_handle;
    const who = t.author_handle ? `@${t.author_handle}` : (t.author_name || "unknown");
    return `${i + 1}. ${isNew ? "✦ " : ""}${who} · ${t.lane}\n${snippet(t.text)}\nhttps://x.com/i/web/status/${t.tweet_id}`;
  });
  let out = `actually-for-you — top ${tweets.length} ranked  (✦ = newly captured, has handle)\n\n${lines.join("\n\n")}`;

  if (fresh.length) {
    const fl = fresh.map(f => `· @${f.author_handle} — ${snippet(f.text, 70)}`);
    out += `\n\n🆕 newest captures with handle (${fresh.length}) — capture fix is live:\n${fl.join("\n")}`;
  }
  return out;
}

// Send to iMessage via AppleScript. `on run argv` keeps the message/recipient out of the
// script body so newlines and quotes need no escaping.
// ponytail: macOS-only; needs Messages signed in + a one-time Automation permission grant,
// and the Mac awake. Reaches the phone via iMessage handoff.
const IMESSAGE_SCRIPT = `on run argv
  tell application "Messages"
    set svc to 1st service whose service type = iMessage
    send (item 1 of argv) to buddy (item 2 of argv) of svc
  end tell
end run`;

async function sendIMessage(message: string, to: string): Promise<void> {
  try {
    await execFileP("osascript", ["-e", IMESSAGE_SCRIPT, message, to]);
  } catch (e) {
    console.error("[afy-notify] iMessage send failed (Messages signed in? Automation allowed?):", e);
  }
}

async function sendPoke(message: string, key: string): Promise<void> {
  try {
    const res = await fetch(POKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) console.error(`[afy-notify] poke send failed ${res.status}: ${await res.text()}`);
  } catch (e) {
    console.error("[afy-notify] poke send error:", e);
  }
}

export async function send(message: string): Promise<void> {
  if (IMESSAGE_TO) { await sendIMessage(message, IMESSAGE_TO); return; }
  const key = process.env.POKE_API_KEY;
  if (key) { await sendPoke(message, key); return; }
  console.log("[afy-notify] no channel configured — digest follows:\n" + message);
}

function recentWithHandle(db: DatabaseSync, n: number): FreshTweet[] {
  return db.prepare(`
    SELECT tweet_id, author_handle, author_name, text
    FROM tweets
    WHERE author_handle IS NOT NULL AND author_handle != ''
    ORDER BY captured_at DESC
    LIMIT ?
  `).all(n) as FreshTweet[];
}

// Fire-and-forget; never throws into the ingest path.
export async function maybeNotify(db: DatabaseSync): Promise<void> {
  const now = Date.now();
  if (now - lastNotified < COOLDOWN_MS) return;
  lastNotified = now;
  const top = buildFeed(db, TOP_N);
  if (!top.length) return;
  await send(formatDigest(top, recentWithHandle(db, TOP_N)));
}
