// M11 interleave report — the ONLINE ranker comparison the offline gate (eval.ts) and the
// observational funnel (funnel.ts) can't give you: "which ranker serves ME better, on my own feed,
// judged by my actual reading?" Team-draft interleaving (digest.ts MATCHUP) cancels position bias
// by construction — each arm's picks are spread symmetrically across ranks — so a per-arm credit
// count is a fair head-to-head. Read-only over digest_log/digest_opens/reviews (npm run interleave;
// AFY_DB to override). It COMPARES rankers, it never mints labels: votes stay the only gold, opens
// are comparison-only signal, and the keyword arm on the product surface is still never a label
// source (CLAUDE.md invariant).
//
// Net credit = opens + 👍 − 👎, and it CAN GO NEGATIVE (never clamped). Doctrine: on this feed the
// 👎 is the MAJORITY judgment (the owner has cast far more 👎 than 👍) while opens are structurally
// rare — the digest is read in place, so a drafted card is seldom "opened" (a handful ever). Credit
// only opens + 👍 and every downvote — most of the judgments there are — carries zero weight: days
// collapse toward 0–0 ties and the credit-rate CI converges slowly toward a TIED-biased read. A 👎
// on a drafted card is direct evidence AGAINST the drafting arm, so it debits that arm's credit.
// (The judged-event FLOOR is unchanged — downs already counted toward it; only the credit formula
// gains the −👎 term.)
//
// Honesty rails, on purpose: (1) it refuses a verdict below a judged-event floor (opens+votes are
// the only judgments; below the floor the point estimate is noise) — prints the count and the floor,
// loudly. (2) The lean is a paired seeded-bootstrap CI over DAYS (the independent trials); a CI that
// straddles 0 prints TIED, same doctrine as eval.ts's diff CI. (3) Coverage counts always print, so
// a thin comparison reads as thin by construction. Determinism: seeded PRNG, NO Math.random.
import type { DatabaseSync } from "node:sqlite";

// Below this many judged events (opens + attributed votes, summed over both arms), NO verdict is
// printed — the point estimate is dominated by noise. Mirrors eval.ts's REVIEW_MIN_N discipline;
// the plan pins the floor at 30. Coverage still prints so you can watch it climb toward the floor.
export const JUDGED_FLOOR = 30;

// Arm-attributed FIRST serve per tweet: the earliest serve that a team drafted (arm IS NOT NULL).
// funnel.ts's FIRST_SERVE doctrine — exposure = first sight, re-serves don't re-count — scoped to
// interleaved serves. SQLite's bare-column-with-MIN rule pins arm/digest_date to that first row.
const ARM_FIRST_SERVE = `
  SELECT tweet_id, arm, digest_date, MIN(ts) AS ts
  FROM digest_log WHERE arm IS NOT NULL GROUP BY tweet_id`;
// A vote's context = the latest ARM-attributed serve at-or-before the vote (the interleaved slate it
// was cast against), latest verdict per tweet (labels.ts convention). funnel.ts's VOTE_SERVE, scoped
// to arm rows so the drafting arm is well-defined. Votes with no prior arm-attributed serve (review
// mode, pre-M11 non-interleaved serves) don't join — honestly excluded, same as the funnel.
const VOTE_ARM_SERVE = `
  SELECT v.verdict, dl.arm, dl.digest_date
  FROM (SELECT tweet_id, verdict, MAX(ts) AS ts FROM reviews GROUP BY tweet_id) v
  JOIN digest_log dl ON dl.tweet_id = v.tweet_id AND dl.arm IS NOT NULL AND dl.ts =
    (SELECT MAX(ts) FROM digest_log WHERE tweet_id = v.tweet_id AND arm IS NOT NULL AND ts <= v.ts)`;

export interface ArmRow {
  arm: string;
  served: number;   // arm-attributed first-serve exposures
  opened: number;   // distinct drafted tweets opened at-or-after first serve
  up: number;       // 👍 attributed to this arm's serves
  down: number;     // 👎 attributed to this arm's serves
  credits: number;  // opens + 👍 − 👎 — net interleaving credit; CAN BE NEGATIVE (👎 debits, never clamped)
  credit_rate: number; // credits / served (0 when the arm served nothing; negative when 👎 outweigh opens+👍)
}

// Per-arm × per-day credits/serves — the paired unit the bootstrap resamples. One row per
// (arm, digest_date) the arm was exposed on; credits = that day's opens + 👍 − 👎 on the arm's
// serves (may be negative — a day the arm drew only downvotes).
interface ArmDay { arm: string; digest_date: string; served: number; credits: number }

export interface InterleaveReport {
  arms: ArmRow[];                 // per-arm totals (the headline table)
  dayWins: { arm: string; days_won: number }[]; // day-level head-to-head (credits per day)
  tiedDays: number;              // days both arms tied on credits (incl. 0–0) — neither wins
  judged: number;                // total judged events (opens + attributed votes) — the floor gate
  matchup: [string, string] | null; // the two arms actually present in the data, or null if <2
  diffCI?: [lo: number, median: number, hi: number]; // paired-bootstrap CI on credit-rate diff (A−B)
  verdict: string;               // human-readable lean / TIED / insufficient-data line
}

// Paired bootstrap over DAYS (eval.ts's seeded-PRNG shape — NO Math.random). Resample the set of
// (arm,day) rows by DAY with replacement B times; for each resample pool credits/serves per arm and
// take the credit-rate diff (armA − armB). The two arms share the SAME resampled days each iteration
// (paired), so day-to-day variance cancels in the diff. Returns the sorted diff distribution.
function bootstrapDiff(days: ArmDay[], armA: string, armB: string, B = 2000): number[] {
  const dayIds = [...new Set(days.map(d => d.digest_date))];
  // index (arm,day) → {served, credits} for O(1) pooling; a day may have a row for one arm only.
  const byDay = new Map<string, { a?: ArmDay; b?: ArmDay }>();
  for (const id of dayIds) byDay.set(id, {});
  for (const d of days) {
    const slot = byDay.get(d.digest_date)!;
    if (d.arm === armA) slot.a = d; else if (d.arm === armB) slot.b = d;
  }
  let s = 0x243f6a88; // eval.ts's bootstrap seed — reproducible run-to-run
  const rand = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const out: number[] = [];
  const n = dayIds.length;
  for (let b = 0; b < B; b++) {
    let cA = 0, sA = 0, cB = 0, sB = 0;
    for (let k = 0; k < n; k++) {
      const pick = byDay.get(dayIds[Math.floor(rand() * n)])!;
      if (pick.a) { cA += pick.a.credits; sA += pick.a.served; }
      if (pick.b) { cB += pick.b.credits; sB += pick.b.served; }
    }
    out.push((sA ? cA / sA : 0) - (sB ? cB / sB : 0));
  }
  return out.sort((x, y) => x - y);
}
const pctile = (xs: number[], p: number) => xs[Math.floor(p * (xs.length - 1))];

// Empty report — no arm-attributed serves to compare (or the db predates the M11 `arm` column).
// Kept read-only: interleave.ts, like eval.ts, never migrates the db; the server owns the ALTER.
function emptyReport(reason: string): InterleaveReport {
  return { arms: [], dayWins: [], tiedDays: 0, judged: 0, matchup: null, verdict: reason };
}

export function interleaveReport(db: DatabaseSync): InterleaveReport {
  // Tolerate a db whose digest_log predates the M11 `arm` column (real afy.db until the server
  // restarts with the additive migration): no column → no interleaved serves yet. Read-only —
  // we detect via PRAGMA rather than letting `arm IS NOT NULL` throw "no such column".
  let hasArm = false;
  try {
    hasArm = (db.prepare(`PRAGMA table_info(digest_log)`).all() as { name: string }[]).some(c => c.name === "arm");
  } catch { return emptyReport("no digest_log table yet — nothing has been served."); }
  if (!hasArm) {
    return emptyReport(`insufficient data — digest_log has no \`arm\` column yet (server not restarted since M11?). ` +
      `Restart the server, then serve an interleaved digest and re-run.`);
  }
  // Per-arm serve + open counts. LEFT JOIN opens at-or-after the arm-attributed first serve.
  const serveOpen = db.prepare(`
    WITH fs AS (${ARM_FIRST_SERVE})
    SELECT fs.arm AS arm, COUNT(*) AS served, COUNT(DISTINCT o.tweet_id) AS opened
    FROM fs LEFT JOIN digest_opens o ON o.tweet_id = fs.tweet_id AND o.ts >= fs.ts
    GROUP BY fs.arm`).all() as { arm: string; served: number; opened: number }[];
  // Per-arm vote tallies from the arm-scoped vote-serve join.
  const votes = db.prepare(`
    WITH vs AS (${VOTE_ARM_SERVE})
    SELECT arm, SUM(verdict = 1) AS up, SUM(verdict = -1) AS down FROM vs GROUP BY arm`)
    .all() as { arm: string; up: number | null; down: number | null }[];

  const upByArm = new Map(votes.map(v => [v.arm, Number(v.up ?? 0)]));
  const downByArm = new Map(votes.map(v => [v.arm, Number(v.down ?? 0)]));
  const arms: ArmRow[] = serveOpen.map(r => {
    const up = upByArm.get(r.arm) ?? 0, down = downByArm.get(r.arm) ?? 0;
    const credits = r.opened + up - down; // opens + 👍 − 👎 — net credit; may be negative, NOT clamped
    return { arm: r.arm, served: r.served, opened: r.opened, up, down, credits, credit_rate: r.served ? credits / r.served : 0 };
  }).sort((a, b) => (a.arm < b.arm ? -1 : 1));

  // Per-(arm,day) credits/serves for the day-level wins + the bootstrap. Opens and votes both keyed
  // to the arm-attributed FIRST serve's digest_date (the day the exposure happened).
  const dayServeOpen = db.prepare(`
    WITH fs AS (${ARM_FIRST_SERVE})
    SELECT fs.arm AS arm, fs.digest_date AS digest_date, COUNT(*) AS served,
      COUNT(DISTINCT o.tweet_id) AS opened
    FROM fs LEFT JOIN digest_opens o ON o.tweet_id = fs.tweet_id AND o.ts >= fs.ts
    GROUP BY fs.arm, fs.digest_date`).all() as { arm: string; digest_date: string; served: number; opened: number }[];
  const dayUp = db.prepare(`
    WITH vs AS (${VOTE_ARM_SERVE})
    SELECT arm, digest_date, SUM(verdict = 1) AS up FROM vs GROUP BY arm, digest_date`)
    .all() as { arm: string; digest_date: string; up: number | null }[];
  // Per-(arm,day) 👎 — mirrors dayUp exactly (same VOTE_ARM_SERVE join, same digest_date keying), so
  // a downvote debits the same day it credits an up. Net per-day credit = opens + 👍 − 👎; may be < 0.
  const dayDown = db.prepare(`
    WITH vs AS (${VOTE_ARM_SERVE})
    SELECT arm, digest_date, SUM(verdict = -1) AS down FROM vs GROUP BY arm, digest_date`)
    .all() as { arm: string; digest_date: string; down: number | null }[];
  const upByArmDay = new Map(dayUp.map(d => [`${d.arm} ${d.digest_date}`, Number(d.up ?? 0)]));
  const downByArmDay = new Map(dayDown.map(d => [`${d.arm} ${d.digest_date}`, Number(d.down ?? 0)]));
  const armDays: ArmDay[] = dayServeOpen.map(d => {
    const up = upByArmDay.get(`${d.arm} ${d.digest_date}`) ?? 0;
    const down = downByArmDay.get(`${d.arm} ${d.digest_date}`) ?? 0;
    return { arm: d.arm, digest_date: d.digest_date, served: d.served, credits: d.opened + up - down };
  });

  // Which two arms are actually in the data (interleaving is a 2-arm design). Sorted so armA/armB
  // are stable run-to-run (the diff sign follows this order).
  const presentArms = arms.map(a => a.arm).sort();
  const matchup: [string, string] | null = presentArms.length === 2 ? [presentArms[0], presentArms[1]] : null;

  // Day-level wins: per digest_date, the arm with more credits wins the day; equal credits (incl.
  // 0–0) is a tie, neither wins. Unchanged rule — but with 👎 in the credit now, a day decided only
  // by downvotes (one arm drew a 👎 → −1, the other did nothing → 0, so 0 > −1) RESOLVES instead of
  // tying 0–0. A robust, position-bias-free summary that doesn't assume the credit-rate is normal —
  // complements the bootstrap CI below.
  const winByArm = new Map<string, number>();
  let tiedDays = 0;
  if (matchup) {
    const [armA, armB] = matchup;
    const byDate = new Map<string, { a: number; b: number }>();
    for (const d of armDays) {
      const slot = byDate.get(d.digest_date) ?? { a: 0, b: 0 };
      if (d.arm === armA) slot.a += d.credits; else if (d.arm === armB) slot.b += d.credits;
      byDate.set(d.digest_date, slot);
    }
    for (const { a, b } of byDate.values()) {
      if (a > b) winByArm.set(armA, (winByArm.get(armA) ?? 0) + 1);
      else if (b > a) winByArm.set(armB, (winByArm.get(armB) ?? 0) + 1);
      else tiedDays++;
    }
  }
  const dayWins = presentArms.map(arm => ({ arm, days_won: winByArm.get(arm) ?? 0 }));

  // Judged events = the only signals that carry a judgment (opens + attributed votes), summed over
  // both arms. THIS is the floor gate: below it, the comparison is noise regardless of any lean.
  const judged = arms.reduce((n, a) => n + a.opened + a.up + a.down, 0);

  // Verdict. Floor first (loud, no lean below it), then the paired-bootstrap CI: straddles 0 → TIED,
  // excludes 0 → a real lean toward the arm on the positive side of the (armA − armB) diff.
  let diffCI: InterleaveReport["diffCI"];
  let verdict: string;
  if (!matchup) {
    verdict = arms.length < 2
      ? `insufficient data — only ${arms.length} arm(s) with interleaved serves; need 2 (set digest.ts MATCHUP and serve some digests).`
      : `unsupported — ${arms.length} arms present; interleaving compares exactly 2.`;
  } else if (judged < JUDGED_FLOOR) {
    verdict = `insufficient data (${judged} judged events, floor ${JUDGED_FLOOR}) — serve more interleaved digests and read/vote on them, then re-run.`;
  } else {
    const [armA, armB] = matchup;
    const diff = bootstrapDiff(armDays, armA, armB);
    diffCI = [pctile(diff, 0.025), pctile(diff, 0.5), pctile(diff, 0.975)];
    const [lo, , hi] = diffCI;
    // TIED when 0 is INSIDE the closed CI (lo≤0≤hi) — this includes the degenerate [0,0] case of
    // two arms with identical credit rates every day (no difference is a tie, not a lean). A lean
    // requires the whole CI strictly to one side of 0.
    if (lo <= 0 && hi >= 0) {
      verdict = `TIED at n=${judged} judged events — the (${armA} − ${armB}) credit-rate CI [${lo.toFixed(3)}, ${hi.toFixed(3)}] contains 0. No ranker leads yet; keep serving.`;
    } else {
      const lead = lo > 0 ? armA : armB; // whole CI > 0 → armA leads; whole CI < 0 → armB leads
      verdict = `LEAN ${lead} at n=${judged} judged events — the (${armA} − ${armB}) credit-rate CI [${lo.toFixed(3)}, ${hi.toFixed(3)}] excludes 0. Not proof; let it run toward the ~2-week read.`;
    }
  }

  return { arms, dayWins, tiedDays, judged, matchup, diffCI, verdict };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(process.env.AFY_DB ?? "afy.db");
  const r = interleaveReport(db);
  const totalServed = r.arms.reduce((n, a) => n + a.served, 0);
  if (totalServed === 0) {
    // No arm-attributed serves yet (or the db predates the arm column). The verdict carries the
    // precise reason; echo it plus the one-liner on how the column fills.
    console.log(r.verdict + "\n" +
      "(digest_log's `arm` column fills on the next /digest serve with interleaving on — digest.ts MATCHUP.)");
    process.exit(0);
  }
  console.log(`\ninterleave — ${totalServed} arm-attributed serves, ${r.judged} judged events (opens + votes)` +
    (r.matchup ? `, matchup ${r.matchup[0]} vs ${r.matchup[1]}` : "") + "\n");
  console.log("per-arm credits (credits = opens + 👍 − 👎, credit_rate = credits / served; may be negative):");
  console.table(r.arms);
  console.log(`day-level wins (more credits that day; ${r.tiedDays} tied day(s)):`);
  console.table(r.dayWins);
  console.log("\n" + r.verdict + "\n");
}
