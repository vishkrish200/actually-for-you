# /// script
# requires-python = ">=3.10"
# dependencies = ["sentence-transformers", "scikit-learn"]
# ///
# M14 experiment — review-lr (dev-trained) arm. Same external-scorer contract as embed_score.py:
# reads AFY_DB, writes ONE table (review_lr_scores), never touches raw events. Eval treats a
# missing score as the -1 rank-last sentinel, so a partial run degrades, never blocks.
#
# Input is review_lr_dump.ts's JSON (argv[1]): one row per hand-reviewed tweet carrying the SAME
# features the M9 mix uses (rubric score, taste cosine, author prior) plus the confounder controls
# (char_len/media_present/is_thread). TS computed those; this script only trains + predicts.
#
# THE INTEGRITY BOUNDARY (CLAUDE.md 2026-07-15 amendment — "spent dev currency"): TRAIN ONLY on
# rows with review_ts < GATE_CUTOFF, string-compared EXACTLY like eval.ts's isDev(). Rows with a
# null review_ts or review_ts >= GATE_CUTOFF are NEVER trained on — get this wrong and the arm
# trains on the same votes the prospective gate later verdicts on, which is the one thing the
# 2026-07-14 freeze exists to prevent. Everything downstream (the printed AUCs, the model name) is
# labeled "train-set read, not the gate" for the same reason.
#
# Confounder discipline (ranker_v1 / PRD §7.2, same pattern as embed_score.py lines ~82-93):
# char_len/media_present/is_thread are regressed in AT FIT, then their coefficients are DROPPED at
# predict — a control a ranker is forbidden from using must never earn score.
#
# ponytail: no LightGBM, no IPW — trees only enter if they beat LR on the internal time split.
import json
import os
import sqlite3
import sys

import numpy as np
from sentence_transformers import SentenceTransformer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score

MODEL = "all-MiniLM-L6-v2"
GATE_CUTOFF = "2026-07-15"  # eval.ts's GATE_CUTOFF constant, string-compared identically
C_GRID = [0.01, 0.1, 1.0]

if len(sys.argv) < 2:
    sys.exit("usage: uv run review_lr.py <dump.json>")

with open(sys.argv[1]) as f:
    pool = json.load(f)
assert pool, "empty review pool dump — run review_lr_dump.ts first"

# ---- train/pool split — the integrity boundary ----
is_train = lambda r: r["review_ts"] is not None and r["review_ts"] < GATE_CUTOFF
train = [r for r in pool if is_train(r)]
assert train, "empty train set — no pre-cutoff (dev) reviews to train on"
assert len(train) < len(pool), (
    f"train set ({len(train)}) must be a STRICT subset of the pool ({len(pool)}) — "
    "if this fires, the whole pool is pre-cutoff and there is nothing for the gate to score"
)
n_pos = sum(r["y"] for r in train)
print(f"[review-lr] train set (pre-cutoff, dev-only): {len(train)} reviews "
      f"({n_pos} pos / {len(train) - n_pos} neg) of {len(pool)} total review-pool rows")

# ---- embed everything once ----
st = SentenceTransformer(MODEL)
encode = lambda texts: st.encode(texts, normalize_embeddings=True, show_progress_bar=False)
pool_emb = encode([r["text"] for r in pool])
emb_by_id = {r["tweet_id"]: pool_emb[i] for i, r in enumerate(pool)}


# ---- scalar features: rubric, taste, prior, char_len_norm — standardized on TRAIN stats only.
# Missing rubric (None) is imputed to the TRAIN-set rubric mean BEFORE standardizing, i.e. it lands
# at z=0 — pool-neutral, the same missing-rubric contract mixFinal uses (digest.ts zscores).
def scalar4(rows: list[dict], rubric_mean: float) -> np.ndarray:
    r_raw = np.array([rubric_mean if r["rubric"] is None else r["rubric"] for r in rows], dtype=float)
    taste = np.array([r["taste"] for r in rows], dtype=float)
    prior = np.array([r["prior"] for r in rows], dtype=float)
    clen = np.array([min(r["char_len"], 280) / 280 for r in rows], dtype=float)  # ranker_v1 norm
    return np.column_stack([r_raw, taste, prior, clen])


train_rubric_present = [r["rubric"] for r in train if r["rubric"] is not None]
rubric_mean = float(np.mean(train_rubric_present)) if train_rubric_present else 0.0
mu = scalar4(train, rubric_mean).mean(axis=0)
sd = scalar4(train, rubric_mean).std(axis=0)
sd[sd == 0] = 1.0  # degenerate-column guard (constant feature → no-op standardization)


# X = [emb(384) | rubric_z, taste_z, prior_z, char_len_z | media_present, is_thread] (390 cols).
# CONTROL columns are the LAST 3 (char_len_z, media_present, is_thread) — PREDICT drops exactly
# those, matching embed_score.py's coef_[0, :emb.shape[1]] slice pattern, generalized to also keep
# the rubric/taste/prior weights (the non-control features).
def build_X(rows: list[dict], emb: np.ndarray) -> np.ndarray:
    sc = (scalar4(rows, rubric_mean) - mu) / sd
    controls = np.array(
        [[0 if not r["media_present"] else 1, 1 if r["is_thread"] else 0] for r in rows], dtype=float,
    )
    return np.hstack([emb, sc, controls])


N_NONCONTROL = pool_emb.shape[1] + 3  # emb + rubric_z + taste_z + prior_z; drops char_len_z/media/thread

# ---- model selection: C from C_GRID by a TIME-ORDERED split WITHIN train (fit earliest 80%,
# validate on latest 20% by review_ts) — never a random split, so the internal read respects the
# same "don't peek at the future" discipline as the prospective gate itself, one level down.
train_sorted = sorted(train, key=lambda r: r["review_ts"])
split = max(1, min(round(0.8 * len(train_sorted)), len(train_sorted) - 1))
fit_rows, val_rows = train_sorted[:split], train_sorted[split:]
fit_emb = np.array([emb_by_id[r["tweet_id"]] for r in fit_rows])
val_emb = np.array([emb_by_id[r["tweet_id"]] for r in val_rows]) if val_rows else np.empty((0, pool_emb.shape[1]))
X_fit, y_fit = build_X(fit_rows, fit_emb), np.array([r["y"] for r in fit_rows])
X_val, y_val = build_X(val_rows, val_emb), np.array([r["y"] for r in val_rows])

val_aucs: dict[float, float] = {}
for C in C_GRID:
    if len(set(y_fit.tolist())) < 2:
        val_aucs[C] = float("nan")
        print(f"[review-lr]   C={C:<5} time-split val AUC = n/a (single-class fit split)")
        continue
    lr_c = LogisticRegression(C=C, max_iter=2000).fit(X_fit, y_fit)
    if len(val_rows) == 0 or len(set(y_val.tolist())) < 2:
        val_aucs[C] = float("nan")
        print(f"[review-lr]   C={C:<5} time-split val AUC = n/a (single-class or empty val split)")
    else:
        val_aucs[C] = roc_auc_score(y_val, lr_c.decision_function(X_val))
        print(f"[review-lr]   C={C:<5} time-split val AUC = {val_aucs[C]:.4f}")

valid = {c: v for c, v in val_aucs.items() if not np.isnan(v)}
if valid:
    best_auc = max(valid.values())
    chosen_C = min(c for c, v in valid.items() if v == best_auc)  # tie-break: more regularization
else:
    chosen_C = 0.1
    print("[review-lr]   WARNING: time-split val AUC undefined for every C (too few/degenerate dev "
          f"votes) — defaulting to C={chosen_C}")
print(f"[review-lr] chosen C = {chosen_C}")

# ---- refit on the FULL train set with the chosen C ----
X_train_full = build_X(train, np.array([emb_by_id[r["tweet_id"]] for r in train]))
y_train_full = np.array([r["y"] for r in train])
lr = LogisticRegression(C=chosen_C, max_iter=2000).fit(X_train_full, y_train_full)
train_auc = roc_auc_score(y_train_full, lr.decision_function(X_train_full))
best_val_auc = val_aucs.get(chosen_C, float("nan"))
print(f"[review-lr] train-set AUC (apparent, controls in, C={chosen_C}) = {train_auc:.4f}  "
      f"— TRAIN-SET READ, NOT THE GATE")
print(f"[review-lr] dev-internal time-split val AUC (chosen C) = "
      f"{'n/a' if np.isnan(best_val_auc) else f'{best_val_auc:.4f}'}  — TRAIN-SET READ, NOT THE GATE")

# ---- PREDICT for the ENTIRE pool: non-control coefficients only, intercept kept ----
X_pool = build_X(pool, pool_emb)
scores = X_pool[:, :N_NONCONTROL] @ lr.coef_[0, :N_NONCONTROL] + lr.intercept_[0]

db = sqlite3.connect(os.environ.get("AFY_DB", "afy.db"))
db.execute("CREATE TABLE IF NOT EXISTS review_lr_scores (tweet_id TEXT PRIMARY KEY, model TEXT, score REAL)")
db.execute("DELETE FROM review_lr_scores")  # one experiment at a time; the model column names it
model_name = f"review-lr {MODEL}+rubric+taste+prior C={chosen_C}"
db.executemany(
    "INSERT INTO review_lr_scores (tweet_id, model, score) VALUES (?, ?, ?)",
    [(r["tweet_id"], model_name, float(s)) for r, s in zip(pool, scores)],
)
db.commit()

# ponytail check: full coverage of the review pool, and the model actually separates something.
n = db.execute("SELECT count(*) FROM review_lr_scores").fetchone()[0]
assert n == len(pool), f"coverage {n}/{len(pool)}"
assert float(np.std(scores)) > 0, "degenerate scores"
print(f"[review-lr] wrote {n} scores to review_lr_scores as {model_name!r} (std {np.std(scores):.4f})")
