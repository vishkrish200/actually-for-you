// Measure the laptop-closed capture gap. Read-only on afy.db.
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("/Users/vishnukrishnan/Developer/actually-for-you/ingest/afy.db", { readOnly: true });
const IST_MS = 5.5 * 3600 * 1000;
const HOUR = 3600 * 1000;

type Row = { tweet_id: string; author_handle: string; created_at: string; captured_at: string; source: string };
const rows = db.prepare(
  "SELECT tweet_id, author_handle, created_at, captured_at, source FROM tweets WHERE created_at IS NOT NULL AND captured_at IS NOT NULL"
).all() as unknown as Row[];

const parsed = rows.map(r => ({
  ...r,
  cap: Date.parse(r.captured_at),
  crt: Date.parse(r.created_at),
})).filter(r => !Number.isNaN(r.cap) && !Number.isNaN(r.crt));
const bad = rows.length - parsed.length;
if (bad > 0) console.log(`(dropped ${bad}/${rows.length} rows with unparseable timestamps)`);

const istDay = (ms: number) => new Date(ms + IST_MS).toISOString().slice(0, 10);
const istHour = (ms: number) => new Date(ms + IST_MS).getUTCHours();
const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length * p)] : NaN; };

// ---- 1. Sensor-alive: 30-min bins with any capture, per IST day; overnight gaps ----
const capsSorted = parsed.map(r => r.cap).sort((a, b) => a - b);
const binsByDay = new Map<string, Set<number>>();
for (const c of capsSorted) {
  const d = istDay(c);
  if (!binsByDay.has(d)) binsByDay.set(d, new Set());
  binsByDay.get(d)!.add(Math.floor((c + IST_MS) % 86400000 / (30 * 60 * 1000)));
}
const aliveHrs = [...binsByDay.values()].map(s => s.size / 2);
console.log(`\n== Sensor uptime ==`);
console.log(`days with any capture: ${binsByDay.size} (${istDay(capsSorted[0])} .. ${istDay(capsSorted.at(-1)!)})`);
console.log(`sensor-alive hours/day: median ${med(aliveHrs).toFixed(1)}h, p25 ${pct(aliveHrs, 0.25).toFixed(1)}h, p75 ${pct(aliveHrs, 0.75).toFixed(1)}h`);

// gaps > 2h between consecutive captures = dead windows
const gaps: { start: number; end: number }[] = [];
for (let i = 1; i < capsSorted.length; i++) {
  if (capsSorted[i] - capsSorted[i - 1] > 2 * HOUR) gaps.push({ start: capsSorted[i - 1], end: capsSorted[i] });
}
const gapHrs = gaps.map(g => (g.end - g.start) / HOUR);
console.log(`dead windows (>2h no capture): ${gaps.length}, median ${med(gapHrs).toFixed(1)}h, p90 ${pct(gapHrs, 0.9).toFixed(1)}h, total ${gapHrs.reduce((a, b) => a + b, 0).toFixed(0)}h`);

// ---- 2. Do wake-time polls recover tweets posted during dead windows? ----
// For each tweet, was it created inside a dead window? If so, capture lag past wake.
const inGap = (t: number) => gaps.find(g => t >= g.start && t <= g.end);
const gapPosted = parsed.filter(r => inGap(r.crt));
const dayPosted = parsed.filter(r => !inGap(r.crt) && r.crt >= capsSorted[0]);
console.log(`\n== Recovery of dead-window posts ==`);
console.log(`captured tweets posted DURING a dead window: ${gapPosted.length}`);
console.log(`captured tweets posted while sensor alive (same period): ${dayPosted.length}`);
// per-hour rate comparison
const gapTotalHrs = gapHrs.reduce((a, b) => a + b, 0);
const aliveTotalHrs = aliveHrs.reduce((a, b) => a + b, 0);
console.log(`capture rate: ${(gapPosted.length / gapTotalHrs).toFixed(1)}/h (dead-window posts) vs ${(dayPosted.length / aliveTotalHrs).toFixed(1)}/h (alive-window posts)`);
const lags = gapPosted.map(r => (r.cap - inGap(r.crt)!.end) / HOUR);
const within2h = lags.filter(l => l <= 2).length;
console.log(`of dead-window posts captured: ${(100 * within2h / (lags.length || 1)).toFixed(0)}% within 2h of wake; median lag past wake ${med(lags).toFixed(1)}h`);
const ages = gapPosted.map(r => (r.cap - r.crt) / HOUR);
console.log(`age at capture (dead-window posts): median ${med(ages).toFixed(1)}h, p90 ${pct(ages, 0.9).toFixed(1)}h`);
const agesDay = dayPosted.map(r => (r.cap - r.crt) / HOUR);
console.log(`age at capture (alive-window posts): median ${med(agesDay).toFixed(1)}h, p90 ${pct(agesDay, 0.9).toFixed(1)}h`);

// ---- 3. Posting-hour histogram (IST), all vs engaged authors ----
const engaged = new Set((db.prepare(
  "SELECT DISTINCT t.author_handle FROM engagement_labels e JOIN tweets t ON t.tweet_id = e.tweet_id"
).all() as unknown as { author_handle: string }[]).map(r => r.author_handle));
console.log(`\n== Capture volume by posting hour (IST) ==  (engaged-author set: ${engaged.size} authors)`);
const histAll = new Array(24).fill(0), histEng = new Array(24).fill(0);
for (const r of parsed) {
  const h = istHour(r.crt);
  histAll[h]++;
  if (engaged.has(r.author_handle)) histEng[h]++;
}
const maxAll = Math.max(...histAll);
for (let h = 0; h < 24; h++) {
  const bar = "#".repeat(Math.round(40 * histAll[h] / maxAll));
  console.log(`${String(h).padStart(2, "0")}:00  ${String(histAll[h]).padStart(6)}  eng ${String(histEng[h]).padStart(5)}  ${bar}`);
}

// ---- 4. Morning-specific: gaps ending 05:00-12:00 IST (the phone-first mornings) ----
const morning = gaps.filter(g => { const h = istHour(g.end); return h >= 5 && h <= 12; });
const mPosts = parsed.filter(r => morning.some(g => r.crt >= g.start && r.crt <= g.end));
console.log(`\n== Overnight gaps ending in the morning (wake 05-12 IST) ==`);
console.log(`count: ${morning.length}, median length ${med(morning.map(g => (g.end - g.start) / HOUR)).toFixed(1)}h`);
console.log(`captured tweets posted inside them: ${mPosts.length} (${(mPosts.length / (morning.length || 1)).toFixed(0)}/gap) — engaged-author: ${mPosts.filter(r => engaged.has(r.author_handle)).length}`);
