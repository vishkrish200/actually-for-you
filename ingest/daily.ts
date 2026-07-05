// Daily digest ping — one iMessage with a one-line teaser + a link to the reading client.
// Run by launchd at 8am (com.afy.daily plist). Reuses notify.ts `send` (iMessage→poke→stdout).
// ponytail: the whole feature is "fetch top item, text a link" — no new ranker, no new deps.
import { send } from "./notify.ts";
import { main as runRubric } from "./rubric.ts";

// localhost works when you open it on the Mac. To tap it from your PHONE on the same wifi, set
// AFY_CLIENT_URL to the Mac's LAN IP (e.g. http://192.168.1.42:2727) and make sure the server
// binds 0.0.0.0. ponytail: left as an env knob, not auto-detected — set once if you read on phone.
const CLIENT = process.env.AFY_CLIENT_URL ?? "http://localhost:2727";
const SERVER = process.env.AFY_SERVER_URL ?? "http://localhost:2727";
const DAYS = Number(process.env.AFY_DAILY_DAYS ?? 2); // window the teaser pulls from (48h default)

async function teaser(): Promise<string> {
  try {
    const res = await fetch(`${SERVER}/digest?limit=1&days=${DAYS}`);
    if (!res.ok) return "";
    const { items, count } = await res.json() as { items?: any[]; count?: number };
    const t = items?.[0];
    if (!t) return "";
    const who = t.author_handle ? `@${t.author_handle}` : (t.author_name || "");
    const text = String(t.text ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    return `${count ?? items!.length} new · top: ${who} — ${text}\n`;
  } catch {
    return ""; // never block the ping on the teaser; a bare link still works
  }
}

// M8: score new tweets against the rubric BEFORE the digest builds, at the default cap. Fully
// guarded — a rubric failure (quota/binary/anything) must NEVER block the 08:00 digest. rubric.ts's
// main() already swallows transport failures and exits clean; this try/catch is the belt to its
// suspenders so even an unexpected throw can't stop the ping. Scores are a feature, not a gate —
// the digest ranks fine without today's fresh scores. (rubric.ts opens its own AFY_DB handle.)
try {
  await runRubric([]); // [] = default limit (500)
} catch (e) {
  console.error("[afy-daily] rubric scoring failed (non-blocking, digest continues):", String(e));
}

const msg = `actually-for-you — your digest is ready\n${await teaser()}${CLIENT}`;
await send(msg);
console.log("[afy-daily] sent:\n" + msg);
