"""Fit the lab weights on the labelled 12-month pool and write model/weights.json.

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
from pipeline.fetch import clean  # noqa: E402
from pipeline.score import embed, load_model  # noqa: E402

MODEL = {"model": "minishlab/potion-base-32M", "revision": "1e5a03f8eeb2c98b928fbbd846f22f816360919f"}

pool = pd.read_parquet(ROOT / "handoff" / "data" / "bt" / "texts.parquet").query("kind == 'pool'").reset_index(drop=True)
month, tab = pool.month.to_numpy(), pool.pick_tab.to_numpy()  # tab: first Sheet tab listing the paper, "" if none
venue = np.where(pool.journal.isin(["Biorxiv", "Medrxiv"]), pool.journal + ":" + pool.category, pool.journal)
names = np.unique(venue)
cfg = tomllib.loads((ROOT / "config" / "sources.toml").read_text())
assert set(names) == {j["key"] for j in cfg["journals"]} | {
    f"{s['server'].capitalize()}:{c}" for s in cfg["preprints"] for c in s["categories"]}, "pool venues differ from config/sources.toml"

emb = embed(load_model(MODEL), pool.title.map(clean), pool.abstract.map(clean))
X = np.hstack([emb, venue[:, None] == names])
fit = lambda rows, y: LogisticRegression(C=1, class_weight="balanced", max_iter=300, tol=1e-3).fit(X[rows], y[rows])

auc, hits, picks = [], 0, 0
for M in [f"2026-{m:02d}" for m in range(3, 11)]:
    train, test = month < M, month == M
    s = fit(train, (tab != "") & (tab < M)).decision_function(X[test])
    y = tab[test] == M
    auc.append(roc_auc_score(y, s))
    hits += y[np.argsort(-s, kind="stable")[:25]].sum()
    picks += y.sum()
print(f"rolling check, Mar-Oct 2026: mean AUC {np.mean(auc):.3f}, picks in top 25: {hits} of {picks}")

lr = fit(np.ones(len(pool), bool), tab != "")
w = lr.coef_[0].round(6).tolist()
(ROOT / "model").mkdir(exist_ok=True)
(ROOT / "model" / "weights.json").write_text(json.dumps(MODEL | {
    "text": "title\nabstract",
    "bias": round(float(lr.intercept_[0]), 6),
    "embedding": w[:emb.shape[1]],
    "venue": dict(zip(names.tolist(), w[emb.shape[1]:])),
    "trained": date.today().isoformat(),
    "train_months": sorted(set(month)),
}) + "\n")
print(f"wrote model/weights.json: {len(pool)} papers, {(tab != '').sum()} picks, {lr.n_iter_[0]} iterations")
print(pd.Series(dict(zip(names, w[emb.shape[1]:]))).sort_values(ascending=False).round(2).to_string())
