// Daily digest ping — one iMessage with a one-line teaser + a link to the reading client.
// Run by launchd at 8am (com.afy.daily plist). Reuses notify.ts `send` (iMessage→poke→stdout).
// ponytail: the whole feature is "fetch top item, text a link" — no new ranker, no new deps.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { send } from "./notify.ts";
import { main as runRubric } from "./rubric.ts";

const execFileP = promisify(execFile);
// uv binary for review_lr.py — same contract as rubric.ts's CLAUDE_BIN: launchd's PATH doesn't
// include ~/.local/bin, so pin the absolute path via UV_BIN in .env.local for the 8am run.
const UV_BIN = process.env.UV_BIN ?? "uv";

// localhost works when you open it on the Mac. To tap it from your PHONE on the same wifi, set
// AFY_CLIENT_URL to the Mac's LAN IP (e.g. http://192.168.1.42:2727) and make sure the server
// binds 0.0.0.0. ponytail: left as an env knob, not auto-detected — set once if you read on phone.
const CLIENT = process.env.AFY_CLIENT_URL ?? "http://localhost:2727";
const SERVER = process.env.AFY_SERVER_URL ?? "http://localhost:2727";
const DAYS = Number(process.env.AFY_DAILY_DAYS ?? 2); // window the teaser pulls from (48h default)

async function teaser(): Promise<string> {
  try {
    // channel=imessage: this one-card serve is the iMessage send list — digest_log tags it (M10).
    const res = await fetch(`${SERVER}/digest?limit=1&days=${DAYS}&channel=imessage`);
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

// M14: refresh review_lr_scores BEFORE the digest builds — dump the feature JSON (labeled review
// pool + today's digest candidates, --days 7 ⊇ every serve window), then retrain/rescore via uv
// (the frozen recipe: pre-cutoff labels only, features refreshed daily — interleave.ts doctrine).
// Copies rubric's graceful contract: any failure prints ONE loud line and the digest continues —
// stale/missing scores just hit buildDigest's pool-mean fallback, never a block.
try {
  const dumpScript = fileURLToPath(new URL("./review_lr_dump.ts", import.meta.url));
  const pyScript = fileURLToPath(new URL("./review_lr.py", import.meta.url));
  const jsonPath = join(tmpdir(), "afy-review-lr-pool.json"); // fixed name: self-overwriting, no tmp litter
  // ponytail: 15-min ceilings + SIGKILL so a wedged model download can't stall the 8am ping forever.
  const opts = { timeout: 900_000, maxBuffer: 256 * 1024 * 1024, killSignal: "SIGKILL" as const };
  const { stdout } = await execFileP(
    process.execPath, ["--experimental-strip-types", dumpScript, "--days", "7"], opts);
  writeFileSync(jsonPath, stdout);
  const { stdout: py } = await execFileP(UV_BIN, ["run", pyScript, jsonPath], opts);
  console.log(py.trim().split("\n").at(-1) ?? "[afy-daily] review-lr rescored");
} catch (e) {
  console.error("[afy-daily] review-lr refresh failed (non-blocking, digest continues; " +
    "stale scores fall back to pool-mean at rank time):", String(e));
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
