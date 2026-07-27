// M16 — the split amendment + online-lr. The integrity properties under test:
//   1. voteSplit is deterministic, ~1/3 gold, and content twins (same author+text, different
//      tweet_id) always land in the SAME pool — no train/gold text leakage.
//   2. trainOk: gold rows and boundary-late rows are NEVER train-eligible; frozen mode is
//      byte-for-byte the M14 pre-cutoff rule.
//   3. The prospective gate reads ONLY post-cutoff gold-split votes; the train stream is its own
//      advisory pool.
//   4. armRanking ranks online_lr from its external map (same contract as review_lr).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GATE_CUTOFF, voteSplit, trainOk, runEval } from "./eval.ts";
import { armRanking } from "./digest.ts";
import type { LabeledRow } from "./labels.ts";

const PRE = "2026-07-01T00:00:00Z";              // before GATE_CUTOFF
const POST = `${GATE_CUTOFF}T10:00:00Z`;         // after it
const BOUNDARY = `${GATE_CUTOFF}T12:00:00Z`;     // a dump run later the same day

describe("M16 voteSplit (deterministic gold/train assignment)", () => {
  it("is deterministic and lands roughly 1/3 gold on a synthetic stream", () => {
    let gold = 0;
    for (let i = 0; i < 3000; i++) {
      const r = { author_id: `a${i % 97}`, text: `tweet number ${i} about topic ${i % 13}`, tweet_id: `t${i}` };
      const s = voteSplit(r);
      assert.equal(s, voteSplit({ ...r }), "same key → same pool, every time");
      if (s === "gold") gold++;
    }
    assert.ok(gold / 3000 > 0.25 && gold / 3000 < 0.42, `gold share ${(gold / 3000).toFixed(3)} ≈ 1/3`);
  });

  it("content twins (same author+text, different tweet_id) share a pool; no text is missing → tweet_id keys", () => {
    const twinA = { author_id: "au1", text: "the same posting event", tweet_id: "id-1" };
    const twinB = { author_id: "au1", text: "the same posting event", tweet_id: "id-2" };
    assert.equal(voteSplit(twinA), voteSplit(twinB),
      "X's duplicate tweet_ids for one post must never straddle gold/train");
    // Missing text falls back to tweet_id — still deterministic.
    assert.equal(voteSplit({ tweet_id: "solo", text: "" }), voteSplit({ tweet_id: "solo", text: null }));
  });
});

describe("M16 trainOk (the one shared train-eligibility boundary)", () => {
  // Find one post-cutoff gold row and one train row by searching the split space — the test
  // derives them from voteSplit itself, so it can never drift from the real assignment.
  const rowFor = (want: "gold" | "train") => {
    for (let i = 0; i < 200; i++) {
      const r = { author_id: `probe`, text: `probe text ${i}`, tweet_id: `p${i}`, review_ts: POST };
      if (voteSplit(r) === want) return r;
    }
    throw new Error(`no ${want} row found in 200 probes — split is degenerate`);
  };

  it("frozen mode = the M14 rule: pre-cutoff only", () => {
    assert.equal(trainOk("frozen", { ...rowFor("train"), review_ts: PRE }, BOUNDARY), true);
    assert.equal(trainOk("frozen", rowFor("train"), BOUNDARY), false, "post-cutoff never trains the frozen recipe");
    assert.equal(trainOk("frozen", { tweet_id: "x", review_ts: null }, BOUNDARY), false, "no review_ts → never");
  });

  it("online mode adds post-cutoff TRAIN-split votes before the boundary — and nothing else", () => {
    assert.equal(trainOk("online", rowFor("train"), BOUNDARY), true);
    assert.equal(trainOk("online", rowFor("gold"), BOUNDARY), false, "GOLD never trains, in any mode");
    assert.equal(trainOk("online", { ...rowFor("train"), review_ts: `${GATE_CUTOFF}T13:00:00Z` }, BOUNDARY),
      false, "a vote cast after the dump boundary waits for the next retrain — test-then-train");
    assert.equal(trainOk("online", { ...rowFor("train"), review_ts: PRE }, BOUNDARY), true, "pre-cutoff still spendable");
  });
});

describe("M16 prospective gate reads gold only; train stream is its own advisory pool", () => {
  const mkRow = (tweet_id: string, kind: "review_pos" | "review_neg", review_ts: string | null, text: string): LabeledRow => ({
    tweet_id, label: kind === "review_pos" ? 1 : 0, kind, review_ts, weight: 1,
    text, author_id: "au", created_at: "2026-07-01", char_len: text.length, media_present: 0, is_thread: 0,
  });
  // Derive gold/train fixture rows from the real split (same trick as above).
  const pick = (want: "gold" | "train", n: number) => {
    const out: string[] = [];
    for (let i = 0; out.length < n && i < 500; i++) {
      const text = `gate fixture text ${i}`;
      if (voteSplit({ author_id: "au", text, tweet_id: `g${i}` }) === want) out.push(text);
    }
    assert.equal(out.length, n, "found enough fixture texts");
    return out;
  };

  it("post-cutoff train-split votes appear in reviewTrain, never in the gate n", () => {
    const [gPos, gNeg] = pick("gold", 2);
    const [tPos, tNeg] = pick("train", 2);
    const rows: LabeledRow[] = [
      mkRow("A", "review_pos", POST, gPos), mkRow("B", "review_neg", POST, gNeg),   // gold → gate
      mkRow("C", "review_pos", POST, tPos), mkRow("D", "review_neg", POST, tNeg),   // train → stream
      mkRow("E", "review_pos", PRE, gPos + " older"),                               // pre-cutoff → dev only
      mkRow("F", "review_pos", null, gPos + " fixture"),                            // no ts → gate (fixture contract)
    ];
    const res = runEval(rows);
    assert.equal(res.reviewGate.nPos + res.reviewGate.nNeg, 3, "gate = 2 gold + 1 no-ts fixture row");
    assert.equal(res.reviewTrain.nPos + res.reviewTrain.nNeg, 2, "train stream = the 2 train-split rows");
    assert.equal(res.reviewOnly.nPos + res.reviewOnly.nNeg, 6, "dev pool still sees everything");
  });
});

describe("M16 online_lr arm ranking (external table contract, same as review_lr)", () => {
  const mk = (id: string, text: string) => ({
    tweet_id: id, author_handle: null, author_name: null, text, media: [], quoted: null,
    created_at: null, likes: null, rts: null, replies: null, views: null,
    score: 0, parts: { taste: 0, rubric: 0, author: 0 }, lane: "taste", arm: null,
  }) as any;
  const cands = [
    mk("a", "alpha bravo charlie delta"),
    mk("b", "echo foxtrot golf hotel"),
    mk("c", "india juliet kilo lima"),
  ];

  it("orders by the external map; a missing candidate lands at the pool mean, never rank-last", () => {
    const order = armRanking(cands, "online_lr", 3, new Map([["a", 1], ["c", 5]])).map(i => i.tweet_id);
    // b missing → mean(1,5)=3 → between c(5) and a(1).
    assert.deepEqual(order, ["c", "b", "a"]);
  });
});
