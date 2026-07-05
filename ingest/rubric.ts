// M8 — LLM rubric scorer. An LLM grades each tweet 0–10 against RUBRIC.md (the user's personal
// taste rubric — the qualityWeight backscroll calls it). Scores are ranking FEATURES persisted
// append-only in `rubric_scores`; they are NEVER labels (CLAUDE.md invariant — an LLM-labeled pool
// would be circular for any LLM-scored ranker). This phase does NOT wire scores into the digest
// (that's M9); it only produces the feature and an eval arm (eval.ts) that asks the one question:
// does an LLM judge beat the keyword baseline on the honest review-pool gate?
//
// TRANSPORT — the user's Claude *subscription*, not the Anthropic API. We shell out to the local
// `claude` CLI in headless mode (`claude --model haiku -p '<prompt>'`) via node:child_process, so
// the zero-dependency invariant holds and NO API key exists anywhere. The CLI wraps its JSON reply
// in ```-fences even when told not to, so the parser strips fences before JSON.parse. execFile (not
// exec) so tweet text is passed as an argv element and never touches a shell.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

// Resolve the binary from CLAUDE_BIN, else "claude" on PATH. WHY the env override: launchd's PATH
// doesn't include ~/.local/bin, so the daily agent can't find `claude` by name — the user pins the
// absolute path in .env.local (CLAUDE_BIN=/Users/…/.local/bin/claude). Interactive shells find it
// on PATH, so "claude" is the sensible default.
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const MODEL = process.env.AFY_RUBRIC_MODEL ?? "haiku"; // haiku ≈ pennies/day; overridable if desired
const BATCH_SIZE = 20;     // items per claude call — keeps one prompt small and one bad batch cheap
const CALL_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 8 * 1024 * 1024; // generous: a 20-item JSON reply is tiny, but never truncate

export interface ScoreItem { id: string; text: string; quoted_text?: string }

// ---- schema (mirrors server.ts style; also added to server.ts's CREATE block so the server-owned
// db always carries it). Append-only: a score is keyed (tweet_id, rubric_sha) — re-running only
// fills pairs missing for the CURRENT sha, and editing RUBRIC.md (new sha) naturally re-scores.
// rowid autoincrement documents insertion order; nothing is ever UPDATEd. ----
export function ensureSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rubric_scores (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      tweet_id TEXT, score INTEGER, model TEXT, rubric_sha TEXT, ts TEXT
    );
  `);
}

// sha256 hex of the rubric contents — the version key. Any edit changes it, which is exactly how a
// rubric edit triggers a re-score without a manual flag.
export function rubricSha(rubricText: string): string {
  return createHash("sha256").update(rubricText).digest("hex");
}

// ---- prompt ----
// The rubric text is the system context; the items are numbered JSON. We NEVER include author
// handles/names or engagement metrics — quality must not proxy fame (CLAUDE.md). Quoted text is
// included when present: a "this." quote-tweet is meaningless alone, its substance IS the quote.
export function buildPrompt(rubricText: string, items: ScoreItem[]): string {
  const payload = items.map(it => {
    const o: Record<string, string> = { id: it.id, text: it.text };
    if (it.quoted_text) o.quoted_text = it.quoted_text;
    return o;
  });
  return [
    "You are grading tweets against the rubric below. Score each tweet from 0 to 10 (whole integers",
    "only) for how well it matches the rubric. Judge ONLY the text provided. When a tweet includes",
    '"quoted_text", it is a quote-tweet — grade the whole unit (the take plus what it quotes).',
    "",
    "===== RUBRIC =====",
    rubricText.trim(),
    "===== END RUBRIC =====",
    "",
    "Score these items:",
    JSON.stringify(payload, null, 0),
    "",
    'Respond with ONLY a JSON array, one object per item, in the form',
    '[{"id":"<id>","score":<0-10 integer>}]. No prose, no markdown, no code fences.',
  ].join("\n");
}

// ---- runner (INJECTABLE) ----
// Default implementation: shell to the claude CLI. Tests pass a stub instead, so `npm test` makes
// ZERO live claude calls. Rejects on non-zero exit / spawn error (binary missing, auth/quota) — the
// caller turns that into a loud, non-fatal skip.
export type RunClaude = (prompt: string) => Promise<string>;

export const runClaudeCLI: RunClaude = (prompt) =>
  new Promise((resolve, reject) => {
    execFile(
      CLAUDE_BIN,
      ["--model", MODEL, "-p", prompt],
      { timeout: CALL_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });

// ---- parser ----
// Strip markdown fences (the CLI adds ```json … ``` despite instructions), JSON.parse, and validate:
// every id must belong to the requested batch and every score must be an integer 0–10. Returns a
// Map id→score on success, or null on any structural failure (caller retries once then skips).
export function parseScores(raw: string, batchIds: Set<string>): Map<string, number> | null {
  const stripped = stripFences(raw);
  let parsed: unknown;
  try { parsed = JSON.parse(stripped); } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  const out = new Map<string, number>();
  for (const item of parsed) {
    if (!item || typeof item !== "object") return null;
    const { id, score } = item as { id?: unknown; score?: unknown };
    if (typeof id !== "string" || !batchIds.has(id)) return null;   // hallucinated / out-of-batch id
    if (typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > 10) return null;
    out.set(id, score);
  }
  return out;
}

// Pull the first ```-fenced block if present (```json … ``` or bare ```), else return the trimmed
// input. Tolerant: some replies fence, some don't, some add a stray sentence around the fence.
function stripFences(raw: string): string {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fence ? fence[1] : raw).trim();
}

// ---- selection ----
// Priority order, capped at `limit`:
//   (a) REVIEW-POOL tweets first — any tweet_id in `reviews` with non-empty text, unscored for the
//       current sha. The eval arm is meaningless without coverage of the pool it ranks, so these
//       come first no matter how old.
//   (b) then unscored candidates, newest captured_at first.
// Both skip empty-text rows and anything already scored at the current sha (idempotency + a rubric
// edit re-scores because the sha changed). Quoted text is joined in when we captured the original.
interface Candidate { tweet_id: string; text: string; quoted_text?: string }

export function selectUnscored(db: DatabaseSync, sha: string, limit: number): Candidate[] {
  // review-pool first, then newest candidates; a single UNION-ordered query keeps the priority and
  // the cap honest in one place. `pri` 0 = review pool, 1 = other — ORDER BY pri, then newest.
  const rows = db.prepare(`
    WITH scored AS (SELECT tweet_id FROM rubric_scores WHERE rubric_sha = ?),
    ranked AS (
      SELECT t.tweet_id, t.text, t.quoted_id, 0 AS pri, '' AS captured_at
      FROM reviews r JOIN tweets t ON r.tweet_id = t.tweet_id
      WHERE t.text IS NOT NULL AND t.text != ''
        AND t.tweet_id NOT IN (SELECT tweet_id FROM scored)
      UNION
      SELECT t.tweet_id, t.text, t.quoted_id, 1 AS pri, COALESCE(t.captured_at, '') AS captured_at
      FROM tweets t
      WHERE t.text IS NOT NULL AND t.text != ''
        AND t.tweet_id NOT IN (SELECT tweet_id FROM scored)
        AND t.tweet_id NOT IN (SELECT tweet_id FROM reviews)
    )
    SELECT tweet_id, text, quoted_id FROM ranked
    ORDER BY pri ASC, captured_at DESC, tweet_id DESC
    LIMIT ?
  `).all(sha, limit) as { tweet_id: string; text: string; quoted_id: string | null }[];

  // Attach quoted text for captured quote-tweets (mirror of digest.ts attachQuoted, text-only —
  // the quoted AUTHOR is deliberately dropped: no fame proxy). Bounded to the selected slate.
  const qids = [...new Set(rows.map(r => r.quoted_id).filter(Boolean))] as string[];
  const quoted = new Map<string, string>();
  if (qids.length) {
    const qrows = db.prepare(
      `SELECT tweet_id, text FROM tweets WHERE tweet_id IN (${qids.map(() => "?").join(",")})
         AND text IS NOT NULL AND text != ''`,
    ).all(...qids) as { tweet_id: string; text: string }[];
    for (const q of qrows) quoted.set(q.tweet_id, q.text);
  }
  return rows.map(r => {
    const qt = r.quoted_id ? quoted.get(r.quoted_id) : undefined;
    return qt ? { tweet_id: r.tweet_id, text: r.text, quoted_text: qt } : { tweet_id: r.tweet_id, text: r.text };
  });
}

// ---- core scoring loop (exported, testable) ----
export interface RunSummary { scored: number; skipped: number; alreadyCovered: number; sha: string; model: string }

// Score `candidates` in sequential batches (NO parallel claude processes) and append rows. Each
// batch gets ONE retry on a parse/validation failure, then is skipped with a loud line and the run
// continues. `alreadyCovered` is computed by the caller (candidates are already the unscored set);
// we thread it through for the summary.
export async function scoreCandidates(
  db: DatabaseSync,
  candidates: Candidate[],
  opts: { rubricText: string; runClaude?: RunClaude; alreadyCovered?: number; model?: string },
): Promise<RunSummary> {
  const runClaude = opts.runClaude ?? runClaudeCLI;
  const model = opts.model ?? MODEL;
  const sha = rubricSha(opts.rubricText);
  ensureSchema(db);
  const insert = db.prepare(
    `INSERT INTO rubric_scores (tweet_id, score, model, rubric_sha, ts) VALUES (?,?,?,?,?)`,
  );

  let scored = 0, skipped = 0;
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const batchIds = new Set(batch.map(b => b.tweet_id));
    // Candidate.tweet_id IS the prompt id — the LLM only ever sees the id + text (+ quoted_text),
    // never the author (no fame proxy). Map to ScoreItem so the id actually lands in the payload.
    const items: ScoreItem[] = batch.map(b => ({
      id: b.tweet_id, text: b.text, ...(b.quoted_text ? { quoted_text: b.quoted_text } : {}),
    }));
    const prompt = buildPrompt(opts.rubricText, items);

    let result: Map<string, number> | null = null;
    for (let attempt = 0; attempt < 2 && !result; attempt++) {
      try {
        const raw = await runClaude(prompt);
        result = parseScores(raw, batchIds);
        if (!result && attempt === 0) {
          console.error(`[rubric] batch ${i / BATCH_SIZE} unparseable — retrying once`);
        }
      } catch (e) {
        // A transport error mid-run (rare: the first-batch preflight in main() already caught a dead
        // binary/auth). Retry once; if it persists, skip this batch loudly and keep going.
        if (attempt === 0) console.error(`[rubric] batch ${i / BATCH_SIZE} claude call failed — retrying once:`, String(e));
        else throw e; // second consecutive transport failure → let main() treat it as a run abort
      }
    }

    if (!result) {
      console.error(`[rubric] SKIPPED batch ${i / BATCH_SIZE} (${batch.length} tweets) — bad output after retry`);
      skipped += batch.length;
      continue;
    }
    const ts = new Date().toISOString();
    for (const b of batch) {
      const s = result.get(b.tweet_id);
      if (s === undefined) { skipped++; continue; } // parser guarantees full coverage, but be safe
      insert.run(b.tweet_id, s, model, sha, ts);
      scored++;
    }
  }
  return { scored, skipped, alreadyCovered: opts.alreadyCovered ?? 0, sha, model };
}

// ---- score reader (used by eval.ts arm + digest.ts M9 mix — lives here because this module owns
// the rubric_scores table; digest and eval both import it without importing each other) ----
export interface RubricScores { sha: string | null; scores: Map<string, number> }

// Read rubric scores from the db for the LATEST rubric_sha present in rubric_scores (missing → the
// map simply lacks the id; callers decide what missing means — eval's arm sentinels it to rank-last,
// the M9 mix treats it as z=0 neutral). "Latest" = the sha of the most recent row by ts; a rubric
// edit starts a fresh sha, so this always reads the current rubric version.
export function loadRubricScores(db: DatabaseSync): RubricScores {
  // Tolerate a db that has never been scored: if rubric_scores doesn't exist yet, return empty
  // WITHOUT creating it — eval and the digest serve path must stay read-only (the scorer/server
  // own the CREATE). A missing table just means zero coverage.
  let latest: { rubric_sha: string } | undefined;
  try {
    latest = db.prepare(
      `SELECT rubric_sha FROM rubric_scores ORDER BY ts DESC, rowid DESC LIMIT 1`,
    ).get() as { rubric_sha: string } | undefined;
  } catch { return { sha: null, scores: new Map() }; } // "no such table: rubric_scores"
  const sha = latest?.rubric_sha ?? null;
  const scores = new Map<string, number>();
  if (sha) {
    // Latest score per tweet at this sha (append-only means a re-score could leave >1 row; take the
    // newest). Scores are integers 0–10.
    const rows = db.prepare(`
      SELECT s.tweet_id, s.score FROM rubric_scores s
      JOIN (SELECT tweet_id, MAX(rowid) mr FROM rubric_scores WHERE rubric_sha = ? GROUP BY tweet_id) l
        ON s.tweet_id = l.tweet_id AND s.rowid = l.mr
    `).all(sha) as { tweet_id: string; score: number }[];
    for (const r of rows) scores.set(r.tweet_id, r.score);
  }
  return { sha, scores };
}

// ---- CLI entry (npm run rubric) ----
// Graceful degradation is the whole contract: a missing binary, an auth failure, or an exhausted
// quota must print ONE loud line and exit 0 having written NOTHING — scores are optional everywhere
// downstream (digest/daily/eval all tolerate their absence), so a failed rubric run must never break
// a caller. We preflight the transport on the FIRST batch: if that call throws, we abort clean.
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(process.env.AFY_DB ?? "afy.db");
  ensureSchema(db);

  const limitFlag = argv.indexOf("--limit");
  const limit = limitFlag >= 0 ? Math.max(0, parseInt(argv[limitFlag + 1] ?? "500", 10) || 0) : 500;

  const rubricText = readFileSync(new URL("./RUBRIC.md", import.meta.url), "utf8");
  const sha = rubricSha(rubricText);
  const covered = (db.prepare(
    `SELECT COUNT(*) n FROM rubric_scores WHERE rubric_sha = ?`,
  ).get(sha) as { n: number }).n;

  const candidates = selectUnscored(db, sha, limit);
  if (candidates.length === 0) {
    console.log(`[rubric] nothing to score for sha ${sha.slice(0, 8)}… (${covered} rows already covered). Done.`);
    return;
  }
  console.log(`[rubric] scoring ${candidates.length} tweets (cap ${limit}) with ${MODEL}, rubric sha ${sha.slice(0, 8)}…`);

  let summary: RunSummary;
  try {
    summary = await scoreCandidates(db, candidates, { rubricText, alreadyCovered: covered });
  } catch (e) {
    // Transport died (binary missing / auth / quota) — loud, single line, exit 0, nothing partial is
    // a problem because writes are per-batch and append-only (whatever landed before the death stays,
    // the rest is picked up next run). This is the "must never break callers" contract.
    console.error(
      `[rubric] ABORTED — claude transport failed (binary missing, auth, or quota?). ` +
      `Nothing more written; scores are optional and the run resumes next time. Detail: ${String(e)}`,
    );
    return;
  }
  console.log(
    `[rubric] done — scored ${summary.scored}, skipped ${summary.skipped}, ` +
    `already covered ${summary.alreadyCovered} (sha ${sha.slice(0, 8)}…, model ${summary.model}).`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
