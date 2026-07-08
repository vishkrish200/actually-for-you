// M5/M6 verification. Run: node --experimental-strip-types --test m5m6.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { LabeledRow } from "./labels.ts";
import { labelReport } from "./labels.ts";
import { train, predict } from "./ranker_v1.ts";
import { ndcgAt, averagePrecision, auc, aucOnKeywordTies, runEval, formatEval } from "./eval.ts";
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

describe("label sanity", () => {
  it("labelReport surfaces counts and the char_len confounder", () => {
    const rows = [mk({ label: 1, char_len: 156 }), mk({ label: 0, char_len: 122 })];
    const rep = labelReport(rows);
    assert.match(rep, /positives:\s+1/);
    assert.match(rep, /char_len/);
  });

  it("labelReport prints the preference-pair count for the gate (no 50/50 balance)", () => {
    const rows = [
      ...Array.from({ length: 3 }, (_, i) => mk({ tweet_id: `rp${i}`, label: 1, kind: "review_pos" })),
      ...Array.from({ length: 4 }, (_, i) => mk({ tweet_id: `rn${i}`, label: 0, kind: "review_neg" })),
    ];
    // 3 👍 × 4 👎 = 12 preference pairs; the old "honest-gate n=… after 50/50 balance" phrasing is gone.
    assert.match(labelReport(rows), /hand-signed 👍\/👎: 3 \/ 4\s+→ 12 preference pairs for the gate/);
    assert.doesNotMatch(labelReport(rows), /50\/50 balance/);
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
});

describe("AUC gate", () => {
  const P = (id: string, o: Partial<LabeledRow> = {}) => mk({ tweet_id: id, label: 1, kind: "review_pos", ...o });
  const N = (id: string, o: Partial<LabeledRow> = {}) => mk({ tweet_id: id, label: 0, kind: "review_neg", ...o });

  it("perfect separator → 1.0, inverted → 0.0, constant → 0.5", () => {
    const pos = [P("p0", { char_len: 10 }), P("p1", { char_len: 20 })];
    const neg = [N("n0", { char_len: 1 }), N("n1", { char_len: 2 })];
    assert.equal(auc(pos, neg, r => r.char_len), 1);   // every 👍 scores above every 👎
    assert.equal(auc(pos, neg, r => -r.char_len), 0);  // exactly inverted
    assert.equal(auc(pos, neg, () => 5), 0.5);         // constant → all ties → ½
  });

  it("label-independent random arm lands in [0.4, 0.6] on a ~200-row pool", () => {
    const rows: LabeledRow[] = [];
    for (let i = 0; i < 100; i++) { rows.push(P(`p${i}`)); rows.push(N(`n${i}`)); }
    const rnd = runEval(rows).reviewOnly.rows.find(r => r.name === "random")!;
    assert.ok(rnd.auc > 0.4 && rnd.auc < 0.6, `random AUC should be ≈0.5, got ${rnd.auc}`);
  });

  it("keyword-tied cut selects EXACTLY the equal-keyword-score pairs", () => {
    // texts chosen for known AI_LEXICON hit counts: "xyz"→0, "ai"→1, "ai llm"→2.
    const pos = [P("p0", { text: "xyz", char_len: 100 }), P("p1", { text: "ai", char_len: 100 }), P("p2", { text: "ai llm", char_len: 100 })];
    const neg = [N("n0", { text: "xyz", char_len: 1 }), N("n1", { text: "ai", char_len: 1 }), N("n2", { text: "ai llm", char_len: 1 })];
    const t = aucOnKeywordTies(pos, neg, r => r.char_len);
    // only the 3 diagonal pairs share a keyword score (0-0, 1-1, 2-2); the other 6 cross pairs differ.
    assert.equal(t.pairs, 3, "exactly the equal-keyword pairs are selected");
    assert.equal(t.auc, 1, "char_len separates 👍>👎 on every selected pair");
    // a scorer that does nothing on those pairs → 0.5 (all ties), proving the subset, not luck.
    assert.equal(aucOnKeywordTies(pos, neg, () => 7).auc, 0.5);
  });

  it("rigged: a candidate separates where keyword is blind → ships with that champion, diff-CI lo > 0", () => {
    const rows: LabeledRow[] = [];
    const scores = new Map<string, number>();
    for (let i = 0; i < 30; i++) {
      // identical text → keyword ties on ALL pairs (0.5, structurally blind); rubric separates cleanly.
      rows.push(P(`p${i}`, { text: "same words", char_len: 5, created_at: "2024-01-01T00:00:00Z" }));
      rows.push(N(`n${i}`, { text: "same words", char_len: 5, created_at: "2024-01-01T00:00:00Z" }));
      scores.set(`p${i}`, 9); scores.set(`n${i}`, 1);
    }
    const res = runEval(rows, { sha: "rig", scores });
    assert.equal(res.reviewOnly.ships, true, "the rubric candidate clears the gate");
    assert.equal(res.reviewOnly.champion, "rubric (LLM judge)");
    const arm = res.reviewOnly.rows.find(r => r.name.startsWith("rubric"))!;
    const kw = res.reviewOnly.rows.find(r => r.name.startsWith("keyword"))!;
    assert.ok(arm.auc > kw.auc, "rubric all-pairs AUC beats keyword");
    assert.ok(arm.diffVsKw && arm.diffVsKw[0] > 0, `diff-CI lo > 0, got ${JSON.stringify(arm.diffVsKw)}`);
    assert.ok(!kw.diffVsKw, "keyword carries no diff against itself");
    assert.match(formatEval(res), /SHIP/);
  });

  it("tiny pool → INCONCLUSIVE and ships=false (below the floor, no verdict either way)", () => {
    const rows: LabeledRow[] = [];
    for (let i = 0; i < 5; i++) { rows.push(P(`p${i}`)); rows.push(N(`n${i}`)); } // 10 total < 40
    const res = runEval(rows);
    assert.equal(res.reviewOnly.ships, false);
    assert.match(formatEval(res), /INCONCLUSIVE/);
  });

  it("integration: audit cut = ✧explore-served votes only; main gate keeps every review row", () => {
    const rows: LabeledRow[] = [];
    for (let i = 0; i < 20; i++) {
      rows.push(P(`ep${i}`, { text: "ai model", served_lane: "explore" }));
      rows.push(N(`en${i}`, { text: "soup", served_lane: "explore" }));
      rows.push(P(`tp${i}`, { text: "ai model", served_lane: "taste" }));
      rows.push(N(`tn${i}`, { text: "soup", served_lane: "taste" }));
    }
    const res = runEval(rows);
    assert.equal(res.reviewAudit.nPos, 20, "audit pool = explore-served 👍 only");
    assert.equal(res.reviewAudit.nNeg, 20, "audit pool = explore-served 👎 only");
    assert.equal(res.reviewOnly.nPos, 40, "main gate keeps all 👍 (explore + taste)");
    assert.equal(res.reviewOnly.nNeg, 40, "main gate keeps all 👎");
    assert.ok(res.reviewAudit.rows.find(r => r.name.startsWith("keyword")), "audit ranks the same arms");
    assert.ok(res.reviewOnly.rows[0].aucCI, "main gate got a bootstrap CI (both classes present)");
    assert.ok(res.reviewAudit.rows[0].aucCI, "audit cut bootstrapped too (both classes present)");
  });
});
