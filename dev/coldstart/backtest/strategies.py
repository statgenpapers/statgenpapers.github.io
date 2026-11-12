"""Alternative scorers on the same embeddings, same leak-free rolling protocol as backtest.py.
Usage: strategies.py MODEL_KEY [MODEL_KEY ...]   (several keys = concatenated embeddings)
Writes handoff/data/bt/strategies/<keys>.csv.
"""
import json, sys
from pathlib import Path
import numpy as np, pandas as pd
from sklearn.decomposition import PCA
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.neural_network import MLPClassifier
from sklearn.svm import SVC, LinearSVC

D = Path(__file__).parents[3] / "handoff" / "data" / "bt"
KEYS = Path(__file__).parents[3] / "handoff" / "llm-scoring-experiment" / "keys"
MONTHS = [f"2026-{m:02d}" for m in range(3, 11)]
keys = sys.argv[1:]
df = pd.read_parquet(D / "texts.parquet")
pool = df[df.kind == "pool"].reset_index(drop=True)
load = lambda v: np.hstack([np.load(D / "emb" / f"{k}.{v}.npy").astype(np.float32)[: len(pool)] for k in keys]) / np.sqrt(len(keys))
TA, T = load("ta"), load("t")
source = np.where(pool.journal.isin(["Biorxiv", "Medrxiv"]), pool.journal + ":" + pool.category, pool.journal)
V = pd.get_dummies(pd.Series(source)).to_numpy(np.float32)
month, pick_tab = pool.month.to_numpy(), pool.pick_tab.to_numpy()
haiku = {m: {k["doi"]: k["pick"] for k in json.load(open(KEYS / f"{m}.json"))} for m in ["2026-08", "2026-09", "2026-10"]}
LR = lambda C=1, cw="balanced": LogisticRegression(C=C, class_weight=cw, max_iter=300, tol=1e-3)
dec = lambda m, Xtr, y, Xte, **kw: m.fit(Xtr, y, **kw).decision_function(Xte)


def strategies(tr, te, y, M):
    X, Xv = TA, np.hstack([TA, V])
    out = {"lr+venue (baseline)": dec(LR(), Xv[tr], y, Xv[te])}
    for C in [0.3, 3, 10]:
        out[f"lr+venue C={C}"] = dec(LR(C), Xv[tr], y, Xv[te])
    out["lr+venue unweighted classes"] = dec(LR(10, None), Xv[tr], y, Xv[te])
    out["linear SVM+venue"] = dec(LinearSVC(C=0.1, class_weight="balanced"), Xv[tr], y, Xv[te])
    out["RBF SVM+venue"] = dec(SVC(C=1, class_weight="balanced"), Xv[tr], y, Xv[te])
    # title embedded separately from title+abstract
    Xt = np.hstack([TA, T, V])
    out["lr+venue, title and abstract separate"] = dec(LR(), Xt[tr], y, Xt[te])
    # recent months weigh more (half-life 4 months)
    age = (pd.Period(M, "M") - pd.PeriodIndex(month[tr], freq="M")).map(lambda d: d.n).to_numpy()
    out["lr+venue, recency-weighted"] = dec(LR(), Xv[tr], y, Xv[te], sample_weight=0.5 ** (age / 4))
    # two-stage: text-only score, then score + venue + score x venue (per-venue threshold and slope)
    oof = np.zeros(tr.sum())
    folds = pd.factorize(month[tr])[0]
    for f in np.unique(folds):  # out-of-month text scores so stage 2 sees honest scores
        oof[folds == f] = dec(LR(), X[tr][folds != f], y[folds != f], X[tr][folds == f])
    s_te = dec(LR(), X[tr], y, X[te])
    two = lambda s, v: np.c_[s, v, s[:, None] * v]
    out["two-stage: text score x venue"] = dec(LR(1), two(oof, V[tr]), y, two(s_te, V[te]))
    out["two-stage: text score + venue"] = dec(LR(1), np.c_[oof, V[tr]], y, np.c_[s_te, V[te]])
    # non-linear models
    pca = PCA(64, random_state=0).fit(X[tr])
    P = lambda idx: np.hstack([pca.transform(X[idx]), V[idx]])
    out["gradient boosting (PCA64+venue)"] = HistGradientBoostingClassifier(
        class_weight="balanced", max_iter=200, learning_rate=0.05, random_state=0).fit(P(tr), y).decision_function(P(te))
    neg = np.flatnonzero(~y)
    rng = np.random.default_rng(0)
    mlp = np.zeros(te.sum())
    for seed in range(3):  # MLP has no class weights: oversample positives against a negative subsample
        idx = np.r_[np.repeat(np.flatnonzero(y), 10), rng.choice(neg, 10 * y.sum(), replace=False)]
        mlp += MLPClassifier((128,), alpha=1e-2, max_iter=200, random_state=seed).fit(Xv[tr][idx], y[idx]).predict_proba(Xv[te])[:, 1]
    out["MLP 128+venue"] = mlp
    # generative: difference of class centroids plus venue log-odds
    out["centroid difference + lr venue"] = dec(LR(), np.c_[X[tr] @ (X[tr][y].mean(0) - X[tr][~y].mean(0)), V[tr]], y,
                                                 np.c_[X[te] @ (X[tr][y].mean(0) - X[tr][~y].mean(0)), V[te]])
    # kNN features (similarity to nearest picks and non-picks) + venue
    def knn(idx, drop_self):
        sp, sn = X[idx] @ X[tr][y].T, X[idx] @ X[tr][~y][:: 5].T
        k = slice(-11, -1) if drop_self else slice(-10, None)
        return np.c_[np.sort(sp, 1)[:, k].mean(1), np.sort(sn, 1)[:, k].mean(1)]
    out["kNN similarities + venue"] = dec(LR(10), np.c_[knn(tr, True), V[tr]], y, np.c_[knn(te, False), V[te]])
    return out


rows = []
for M in MONTHS:
    tr, te = month < M, month == M
    y = ((pick_tab != "") & (pick_tab < M))[tr]
    yte = (pick_tab == M)[te]
    hk = pool.doi[te].isin(haiku.get(M, {})).to_numpy()
    for name, s in strategies(tr, te, y, M).items():
        top = lambda yy, ss: int(yy[np.argsort(-ss, kind="stable")[:25]].sum())
        r = {"emb": "+".join(keys), "strategy": name, "month": M, "auc": roc_auc_score(yte, s), "top25": top(yte, s), "picks": int(yte.sum())}
        if M in haiku:
            yh = pool.doi[te][hk].map(haiku[M]).to_numpy(bool)
            r |= {"h_auc": roc_auc_score(yh, s[hk]), "h_top25": top(yh, s[hk])}
        rows.append(r)
    print(M, flush=True)
(D / "strategies").mkdir(exist_ok=True)
r = pd.DataFrame(rows)
r.to_csv(D / "strategies" / f"{'+'.join(keys)}.csv", index=False)
dev, oct_ = r[r.month < "2026-10"], r[r.month == "2026-10"].set_index("strategy")
t = dev.groupby("strategy").agg(dev_auc=("auc", "mean"), dev_top25=("top25", "sum")).join(oct_[["auc", "top25"]].add_prefix("oct_"))
t = t.join(r.groupby("strategy").agg(haiku_auc=("h_auc", "mean"), haiku_top25=("h_top25", "sum")))
pd.set_option("display.width", 200)
print("+".join(keys), "(dev: 191 picks; Oct: 19; Haiku set: Haiku itself = AUC 0.882 mean, 43 hits)")
print(t.sort_values("dev_top25", ascending=False).round(3).to_string())
