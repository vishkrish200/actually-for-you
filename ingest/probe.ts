// M6 behavioral probe — the non-circular counterpart to the content ship gate in eval.ts.
//
// The content gate is a dead end: the keyword baseline is near-circular (labels were curated partly
// BY the AI lexicon) and char_len alone ≈ keyword, so a text-LR is asked to beat the rule that made
// its own labels (see PROGRESS.md M5+M6). This probe asks a genuinely NEW question instead:
//
//   Among tweets we actually PUT ON SCREEN (viewed-gate ≥50%), does passive behavior — how long you
//   dwelled, whether you opened detail — rank the ones you LIKED above the ones you didn't, better
//   than recency (and random)?
//
// No circularity: the label is the harvested like; the score uses ONLY passive signals (dwell,
// opened_detail, visibility) — NEVER the like/rt/bookmark flips, which would trivially predict the
// like. No era confound either: every candidate has a recent impression, so there's no old-vs-new
// split for a model to cheat on. And no training — these are fixed scoring rules, so there's nothing
// to hold out; we score the whole balanced seen-pool. If behavior can't beat recency here, no learned
// behavioral v1 will — M6's learned path closes for good. If it can, a behavioral v1 has real signal.
import type { DatabaseSync } from "node:sqlite";
import { ndcgAt, averagePrecision } from "./eval.ts";
import { hashStr } from "./ranker_v1.ts";

export interface SeenRow {
  tweet_id: string;
  label: 0 | 1;   // 1 = user liked it (engagement_labels source=like) — the held-out target
  dwell: number;  // trusted dwell (ms): MAX per-impression, capped 60s, flicks/fast-scroll dropped
  opened: 0 | 1;  // any impression opened_detail
  profile: 0 | 1; // any impression profile_expanded
  visible: number;// max max_visible_pct
  last_ts: number;// most recent impression ts — the recency baseline
}

const VIEWED_PCT = 0.5;
// Same trusted-dwell definition the v0 ranker uses (ranker.ts TRUSTED_DWELL): the capture layer leaks
// IntersectionObserver exits under virtualized scroll, so raw dwell is untrustworthy. MAX-not-SUM +
// 60s cap + drop flicks / velocity≥5 is what makes a dwell number mean "actually read this".
const TRUSTED_DWELL =
  `MAX(CASE WHEN flicked = 0 AND COALESCE(scroll_velocity_at_entry, 99) < 5 THEN MIN(dwell_ms, 60000) ELSE 0 END)`;

export function buildSeen(db: DatabaseSync): SeenRow[] {
  return (db.prepare(`
    SELECT i.tweet_id                                        AS tweet_id,
           ${TRUSTED_DWELL}                                  AS dwell,
           MAX(i.opened_detail)                              AS opened,
           MAX(CASE WHEN i.profile_expanded IS NOT NULL
                     AND i.profile_expanded != '' THEN 1 ELSE 0 END) AS profile,
           MAX(i.max_visible_pct)                            AS visible,
           MAX(i.ts)                                         AS last_ts,
           MAX(CASE WHEN e.tweet_id IS NOT NULL THEN 1 ELSE 0 END) AS label
    FROM impressions i
    LEFT JOIN engagement_labels e ON i.tweet_id = e.tweet_id AND e.source = 'like'
    GROUP BY i.tweet_id
    HAVING MAX(i.max_visible_pct) >= ${VIEWED_PCT}
  `).all() as any[]).map(r => ({
    tweet_id: r.tweet_id,
    label: (r.label ? 1 : 0) as 0 | 1,
    dwell: r.dwell ?? 0,
    opened: (r.opened ? 1 : 0) as 0 | 1,
    profile: (r.profile ? 1 : 0) as 0 | 1,
    visible: r.visible ?? 0,
    last_ts: r.last_ts ?? 0,
  }));
}

// Deterministic 50/50 downsample of the majority class (seen-pool is ~97% not-liked, so an
// unbalanced NDCG/MAP saturates and can't discriminate — same reason eval.ts balances). hashStr
// sort, no Math.random, so the gate is reproducible.
function balance(rows: SeenRow[]): SeenRow[] {
  const pos = rows.filter(r => r.label === 1);
  const neg = rows.filter(r => r.label === 0);
  const [maj, min] = pos.length >= neg.length ? [pos, neg] : [neg, pos];
  const keptMaj = [...maj].sort((a, b) => hashStr(a.tweet_id) - hashStr(b.tweet_id)).slice(0, min.length);
  return [...keptMaj, ...min];
}

function ranked(test: SeenRow[], score: (r: SeenRow) => number): number[] {
  return [...test]
    .map(r => ({ label: r.label, s: score(r), id: r.tweet_id }))
    .sort((a, b) => b.s - a.s || (a.id < b.id ? -1 : 1))
    .map(x => x.label);
}
function metrics(test: SeenRow[], score: (r: SeenRow) => number) {
  const rels = ranked(test, score);
  return { ndcg10: ndcgAt(rels, 10), ndcg50: ndcgAt(rels, 50), map: averagePrecision(rels) };
}

function randomScorer(rows: SeenRow[]): (r: SeenRow) => number {
  let s = 0x9e3779b9;
  const m = new Map<string, number>();
  for (const r of rows) { s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) >>> 0; m.set(r.tweet_id, s); }
  return (r) => m.get(r.tweet_id) ?? 0;
}

export interface ProbeResult {
  seen: number; liked: number; opened_and_liked: number;
  rows: { name: string; ndcg10: number; ndcg50: number; map: number }[];
  beatsRecency: boolean; beatsRandom: boolean;
}

export function runProbe(seen: SeenRow[]): ProbeResult {
  const test = balance(seen);
  // behavioral: dwell dominant, opened/profile as tie-breakers (small bump — opened is rare here).
  const behavioral = (r: SeenRow) => r.dwell + (r.opened ? 30000 : 0) + (r.profile ? 5000 : 0);
  const named: [string, (r: SeenRow) => number][] = [
    ["random", randomScorer(test)],
    ["recency (baseline to beat)", (r) => r.last_ts],
    ["dwell only", (r) => r.dwell],
    ["opened_detail only", (r) => r.opened],
    ["behavioral (dwell+opened)", behavioral],
  ];
  const rows = named.map(([name, s]) => ({ name, ...metrics(test, s) }));
  const recency = rows.find(r => r.name.startsWith("recency"))!;
  const random = rows.find(r => r.name === "random")!;
  const beh = rows.find(r => r.name.startsWith("behavioral"))!;
  return {
    seen: seen.length,
    liked: seen.filter(r => r.label === 1).length,
    opened_and_liked: seen.filter(r => r.label === 1 && r.opened).length,
    rows,
    beatsRecency: beh.ndcg10 > recency.ndcg10 && beh.map > recency.map,
    beatsRandom: beh.ndcg10 > random.ndcg10 && beh.map > random.map,
  };
}

export function formatProbe(p: ProbeResult): string {
  const head = `${"model".padEnd(28)} ${"NDCG@10".padStart(8)} ${"NDCG@50".padStart(8)} ${"MAP".padStart(8)}`;
  const body = p.rows.map(r =>
    `${r.name.padEnd(28)} ${r.ndcg10.toFixed(4).padStart(8)} ${r.ndcg50.toFixed(4).padStart(8)} ${r.map.toFixed(4).padStart(8)}`);
  const verdict = p.beatsRecency
    ? "SIGNAL ✅  passive behavior beats recency — a learned behavioral v1 has something to learn."
    : p.beatsRandom
      ? "WEAK ⚠️  behavior beats random but NOT recency — the like/dwell link is too thin to ship a v1 on."
      : "DEAD ⛔  behavior does not beat random — no behavioral signal predicts likes; M6 learned path is closed.";
  return [
    `▼ BEHAVIORAL PROBE — does dwell/opened predict likes among SEEN tweets? (balanced ${p.liked}v${p.liked})`,
    `  seen=${p.seen}  liked=${p.liked}  liked&opened=${p.opened_and_liked}`,
    head, ...body, "", verdict,
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(process.env.AFY_DB ?? "afy.db");
  console.log(formatProbe(runProbe(buildSeen(db))));
}
