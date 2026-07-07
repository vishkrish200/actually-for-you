// M5/M6 verification. Run: node --experimental-strip-types --test m5m6.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { LabeledRow } from "./labels.ts";
import { labelReport } from "./labels.ts";
import { train, predict } from "./ranker_v1.ts";
import { ndcgAt, averagePrecision, splitByTime, runEval } from "./eval.ts";
import { runProbe, type SeenRow } from "./probe.ts";

const mk = (o: Partial<LabeledRow>): LabeledRow => ({
  tweet_id: "0", label: 0, kind: "easy_neg", weight: 1, text: "", author_id: "", created_at: "",
  char_len: 0, media_present: 0, is_thread: 0, ...o,
});

describe("metrics", () => {
  it("NDCG@k against hand-computed values", () => {
    // perfect ranking → 1.0; worst → < 1.0
    assert.equal(ndcgAt([1, 1, 0, 0], 4), 1);
    // [0,1] : DCG = 0/log2(2) + 1/log2(3) = 0.6309; IDCG = 1/log2(2) = 1 → 0.6309
    assert.ok(Math.abs(ndcgAt([0, 1], 2) - 0.63092) < 1e-4);
    assert.equal(ndcgAt([0, 0], 2), 0); // no positives → 0
  });

  it("AP against hand-computed values", () => {
    assert.equal(averagePrecision([1, 1]), 1);            // both at top
    // [0,1,1]: precisions at hits = 1/2, 2/3 → mean = 0.58333
    assert.ok(Math.abs(averagePrecision([0, 1, 1]) - 0.58333) < 1e-4);
    assert.equal(averagePrecision([0, 0]), 0);
  });
});

describe("logistic regression", () => {
  it("learns a token-separable set", () => {
    const rows: LabeledRow[] = [];
    for (let i = 0; i < 30; i++) {
      rows.push(mk({ tweet_id: `p${i}`, label: 1, text: "ai model llm agent", char_len: 18 }));
      rows.push(mk({ tweet_id: `n${i}`, label: 0, text: "soup recipe garden", char_len: 18 }));
    }
    const model = train(rows, { epochs: 60 });
    assert.ok(predict(model, mk({ text: "ai model llm agent" })) > 0.8);
    assert.ok(predict(model, mk({ text: "soup recipe garden" })) < 0.2);
  });

  it("does NOT separate purely on char_len (confounder is controlled, not rewarded)", () => {
    // identical text, label correlated with length → model must not learn length as the signal
    const rows: LabeledRow[] = [];
    for (let i = 0; i < 30; i++) {
      rows.push(mk({ tweet_id: `p${i}`, label: 1, text: "same words here", char_len: 250 }));
      rows.push(mk({ tweet_id: `n${i}`, label: 0, text: "same words here", char_len: 10 }));
    }
    const model = train(rows, { epochs: 60 });
    // a long never-seen tweet shouldn't be scored as positive on length alone
    const longUnseen = predict(model, mk({ text: "totally different tokens", char_len: 280 }));
    assert.ok(longUnseen < 0.7, `length leaked into score: ${longUnseen}`);
  });
});

describe("split & label sanity", () => {
  it("stratifies both classes into train and test by time", () => {
    const rows: LabeledRow[] = [];
    for (let i = 0; i < 10; i++) {
      const d = `2024-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`;
      rows.push(mk({ tweet_id: `p${i}`, label: 1, created_at: d }));
      rows.push(mk({ tweet_id: `n${i}`, label: 0, created_at: d }));
    }
    const { train: tr, test } = splitByTime(rows, 0.7);
    assert.ok(tr.some(r => r.label === 1) && tr.some(r => r.label === 0));
    assert.ok(test.some(r => r.label === 1) && test.some(r => r.label === 0));
    // test holds the NEWER rows
    assert.ok(test.every(r => Date.parse(r.created_at) >= Date.parse("2024-01-08T00:00:00Z")));
  });

  it("review kinds go 100% to test — hand-signed gold never trains any arm", () => {
    const rows: LabeledRow[] = [];
    for (let i = 0; i < 10; i++) {
      const d = `2024-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`;
      rows.push(mk({ tweet_id: `rp${i}`, label: 1, kind: "review_pos", created_at: d }));
      rows.push(mk({ tweet_id: `rn${i}`, label: 0, kind: "review_neg", created_at: d }));
      rows.push(mk({ tweet_id: `p${i}`, label: 1, kind: "pos", created_at: d }));
    }
    const { train: tr, test } = splitByTime(rows, 0.7);
    assert.equal(tr.filter(r => r.kind.startsWith("review")).length, 0, "no review row in train");
    assert.equal(test.filter(r => r.kind.startsWith("review")).length, 20, "every review row in test");
    // behavioral kinds still time-split 70/30
    assert.ok(tr.some(r => r.kind === "pos") && test.some(r => r.kind === "pos"));
  });

  it("labelReport surfaces counts and the char_len confounder", () => {
    const rows = [mk({ label: 1, char_len: 156 }), mk({ label: 0, char_len: 122 })];
    const rep = labelReport(rows);
    assert.match(rep, /positives:\s+1/);
    assert.match(rep, /char_len/);
  });

  it("runEval reports same-era + full pools with a ship verdict on a separable toy set", () => {
    const rows: LabeledRow[] = [];
    for (let i = 0; i < 40; i++) {
      const d = `2024-0${1 + (i % 6)}-01T00:00:00Z`;
      rows.push(mk({ tweet_id: `p${i}`, label: 1, kind: "pos", text: "ai llm model agent gpt", created_at: d, char_len: 22 }));
      rows.push(mk({ tweet_id: `h${i}`, label: 0, kind: "hard_neg", text: "garden soup recipe cat", created_at: d, char_len: 22 }));
      rows.push(mk({ tweet_id: `e${i}`, label: 0, kind: "easy_neg", text: "weather traffic news bus", created_at: d, char_len: 24 }));
    }
    const res = runEval(rows);
    assert.equal(res.sameEra.rows.length, 6);
    assert.ok(res.sameEra.rows.find(r => r.name === "v1 LR (full)"));
    assert.equal(typeof res.sameEra.ships, "boolean");
    assert.ok(res.full.rows.find(r => r.name === "random"));
  });

  it("behavioral probe: detects dwell signal when present, and random stays ~0.5 on the balanced pool", () => {
    const seen = (o: Partial<SeenRow>): SeenRow => ({
      tweet_id: "0", label: 0, dwell: 0, opened: 0, profile: 0, visible: 1, last_ts: 0, ...o,
    });
    // liked tweets carry high dwell, non-liked ~none → behavioral MUST beat random (wiring check:
    // catches a metric inversion or a broken balance()). 240v240 mirrors the real pool shape.
    const strong: SeenRow[] = [];
    for (let i = 0; i < 240; i++) strong.push(seen({ tweet_id: `p${i}`, label: 1, dwell: 40000 }));
    for (let i = 0; i < 8000; i++) strong.push(seen({ tweet_id: `n${i}`, label: 0, dwell: 0 }));
    const s = runProbe(strong);
    assert.ok(s.beatsRandom, "dwell perfectly separates likes but probe says no signal");

    // no dwell difference → behavioral is label-independent → must NOT beat random (no false signal).
    const flat: SeenRow[] = [];
    for (let i = 0; i < 240; i++) flat.push(seen({ tweet_id: `p${i}`, label: 1, dwell: 5000 }));
    for (let i = 0; i < 8000; i++) flat.push(seen({ tweet_id: `n${i}`, label: 0, dwell: 5000 }));
    const f = runProbe(flat);
    const rnd = f.rows.find(r => r.name === "random")!;
    assert.ok(rnd.map > 0.35 && rnd.map < 0.65, `balanced random MAP should be ~0.5, got ${rnd.map}`);
  });

  it("random baseline is label-independent AND the gate is balanced (no saturation, no id leak)", () => {
    // positives get high-id strings, negs low-id — mirrors the real snowflake/era split.
    // The same-era gate is now 50/50 class-balanced (balancePool), so a correct random baseline
    // scores MAP ≈ 0.5 — NOT ~perfect (would mean a tweet_id/era leak) and NOT ~pos-fraction
    // (would mean the pool is saturated/imbalanced and the metric can't discriminate).
    const rows: LabeledRow[] = [];
    for (let i = 0; i < 100; i++) {
      rows.push(mk({ tweet_id: `90${i}`, label: 1, kind: "pos", created_at: "2024-01-01T00:00:00Z" }));
      for (let j = 0; j < 2; j++) rows.push(mk({ tweet_id: `10${i}_${j}`, label: 0, kind: "hard_neg", created_at: "2024-01-01T00:00:00Z" }));
    }
    const rnd = runEval(rows).sameEra.rows.find(r => r.name === "random")!;
    assert.ok(rnd.map > 0.35 && rnd.map < 0.65, `balanced random MAP should be ~0.5, got ${rnd.map}`);
  });
});
