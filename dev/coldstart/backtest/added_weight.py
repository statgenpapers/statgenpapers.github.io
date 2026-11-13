"""Should added papers weigh more in training? Leak-free backtest of 2026-01..10: uv run --group train python dev/coldstart/backtest/added_weight.py

An added paper is a pick the site did not show: here, a pick outside the top 25 of its own month under that month's
leak-free model (how dev/coldstart/rollforward.py decided what admin added). Each model of month M trains as
dev/coldstart/train.py does (12 months before M, 6-month half-life, picks of tabs before M), with the sample weight
of added positives multiplied by k. Scored on every pick of tab M in M's pool: AUC, and picks in the top 25.
Picks in no pool (production adds them as extra positives) are left out: the local pool has no abstracts for them.
Local only: reads handoff/data/bt/texts.parquet.
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score

ROOT = Path(__file__).parents[3]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "dev" / "coldstart"))
from pipeline.fetch import clean  # noqa: E402
from pipeline.score import embed, load_model  # noqa: E402
from recency import rows_and_weights  # noqa: E402

MODEL = {"model": "minishlab/potion-base-32M", "revision": "1e5a03f8eeb2c98b928fbbd846f22f816360919f"}
SHOWN, WEIGHTS = 25, [1, 1.5, 2, 3, 5]

pool = pd.read_parquet(ROOT / "handoff" / "data" / "bt" / "texts.parquet").query("kind == 'pool'").reset_index(drop=True)
month, tab = pool.month.to_numpy(), pool.pick_tab.to_numpy()
venue = np.where(pool.journal.isin(["Biorxiv", "Medrxiv"]), "Preprint", pool.journal)
X = np.hstack([embed(load_model(MODEL), pool.title.map(clean), pool.abstract.map(clean)), venue[:, None] == np.unique(venue)])
months = sorted(set(month))


def fit(before, added=None, k=1):
    rows, weight = rows_and_weights(month, before)
    y = (tab != "") & (tab < before)
    if added is not None:
        weight = weight * np.where(y[rows] & added[rows], k, 1)
    return LogisticRegression(C=1, class_weight="balanced", max_iter=300, tol=1e-3).fit(X[rows], y[rows], sample_weight=weight)


# Which picks were "added": outside the top 25 of their own month under that month's model (the first month has none)
shown = np.zeros(len(pool), bool)
for M in months[1:]:
    at = np.flatnonzero(month == M)
    shown[at[np.argsort(-fit(M).decision_function(X[at]), kind="stable")[:SHOWN]]] = True
added = (tab != "") & ~shown
print(f"picks in the pool: {(tab != '').sum()}, of them added: {added.sum()} ({added.sum() / (tab != '').sum():.0%})")

rows = []
for M in [m for m in months if m >= "2026-01"]:
    at = month == M
    y = tab[at] == M
    for k in WEIGHTS:
        s = fit(M, added, k).decision_function(X[at])
        top = np.argsort(-s, kind="stable")[:SHOWN]
        rows.append({"month": M, "k": k, "picks": int(y.sum()), "auc": roc_auc_score(y, s), "top25": int(y[top].sum()),
                     # the picks the k=1 model did not show: the ones a weight on added papers should help find
                     "auc_added": roc_auc_score(y[~shown[at] | ~y], s[~shown[at] | ~y]) if (y & ~shown[at]).any() else np.nan})
res = pd.DataFrame(rows)
print(res.groupby("k").agg(auc=("auc", "mean"), auc_added=("auc_added", "mean"), top25=("top25", "sum"), picks=("picks", "sum")).round(4).to_string())
print(res.pivot(index="month", columns="k", values="top25").to_string())
