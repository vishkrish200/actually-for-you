import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// Personal push channel for the daily digest text (daily.ts is the only caller).
// Channel precedence:
//   AFY_IMESSAGE_TO set -> native macOS iMessage (Messages.app)
//   else POKE_API_KEY set -> Poke
//   else -> log to stdout (formatting still verifiable)

const POKE_URL = process.env.POKE_URL ?? "https://poke.com/api/v1/inbound/api-message";
const IMESSAGE_TO = process.env.AFY_IMESSAGE_TO;

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
