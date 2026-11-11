"""Fit the base weights for the next month and write model/weights.json: the 12 months before it, each weighted by
age with a 6-month half-life (dev/recency.py).

Local only: reads handoff/data/bt/texts.parquet (built by dev/backtest/prep.py), which is never
committed. Run from the repository root: uv run --group train python dev/train.py

Before fitting, it repeats the leak-free rolling backtest (dev/backtest/README.md) through the
production code path, to check that the embedding call, text cleaning and venue keys of the
monthly run reproduce the published numbers.
"""
import json
import sys
import tomllib
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "dev"))
from pipeline.fetch import clean  # noqa: E402
from pipeline.score import embed, load_model  # noqa: E402
from recency import rows_and_weights  # noqa: E402

MODEL = {"model": "minishlab/potion-base-32M", "revision": "1e5a03f8eeb2c98b928fbbd846f22f816360919f"}

pool = pd.read_parquet(ROOT / "handoff" / "data" / "bt" / "texts.parquet").query("kind == 'pool'").reset_index(drop=True)
month, tab = pool.month.to_numpy(), pool.pick_tab.to_numpy()  # tab: first Sheet tab listing the paper, "" if none
venue = np.where(pool.journal.isin(["Biorxiv", "Medrxiv"]), "Preprint", pool.journal)  # a preprint is a preprint
names = np.unique(venue)
cfg = tomllib.loads((ROOT / "config" / "sources.toml").read_text())
assert set(names) == {j["key"] for j in cfg["journals"]} | {"Preprint"}, "pool venues differ from config/sources.toml"

emb = embed(load_model(MODEL), pool.title.map(clean), pool.abstract.map(clean))
X = np.hstack([emb, venue[:, None] == names])


def fit(before):
    """The model for month `before`: the picks known before it, on its rows and weights."""
    rows, weight = rows_and_weights(month, before)
    y = (tab != "") & (tab < before)
    return LogisticRegression(C=1, class_weight="balanced", max_iter=300, tol=1e-3).fit(X[rows], y[rows], sample_weight=weight)


# Each month after the first is scored by its own model: the rolling check, and the calibration's data
auc, hits, picks, oos = [], 0, 0, []
for M in sorted(set(month))[1:]:
    s = fit(M).decision_function(X[month == M])
    y = tab[month == M] == M
    oos.append((s, y))
    if M >= "2026-01":
        auc.append(roc_auc_score(y, s))
        hits += y[np.argsort(-s, kind="stable")[:25]].sum()
        picks += y.sum()
print(f"rolling check, 2026-01..{max(month)}: mean AUC {np.mean(auc):.3f}, picks in top 25: {hits} of {picks}")

# Calibration: P(pick) = sigmoid(a + b·score), fitted (unpenalized) to the out-of-sample scores above.
# The balanced class weights make sigmoid(score) itself far too high.
s, y = map(np.concatenate, zip(*oos))
cal = LogisticRegression(penalty=None).fit(s[:, None], y)
calibration = {"a": round(float(cal.intercept_[0]), 4), "b": round(float(cal.coef_[0, 0]), 4)}
print(f"calibration: P(pick) = sigmoid({calibration['a']} + {calibration['b']} * score)")

last = max(month)
following = f"{int(last[:4]) + int(last[5:]) // 12}-{int(last[5:]) % 12 + 1:02d}"  # the month these weights score
lr = fit(following)
w = lr.coef_[0].round(6).tolist()
(ROOT / "model").mkdir(exist_ok=True)
(ROOT / "model" / "weights.json").write_text(json.dumps(MODEL | {
    "text": "title\nabstract",
    "bias": round(float(lr.intercept_[0]), 6),
    "embedding": w[:emb.shape[1]],
    "venue": dict(zip(names.tolist(), w[emb.shape[1]:])),
    "calibration": calibration,
    "trained": date.today().isoformat(),
    "train_months": sorted(set(month[rows_and_weights(month, following)[0]])), "half_life_months": 6,
}) + "\n")
print(f"wrote model/weights.json for {following}: {rows_and_weights(month, following)[0].sum()} papers, {lr.n_iter_[0]} iterations")
print(pd.Series(dict(zip(names, w[emb.shape[1]:]))).sort_values(ascending=False).round(2).to_string())
