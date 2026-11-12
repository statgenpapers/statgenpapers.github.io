"""Leak-free rolling backtest of embedding scorers. Usage: backtest.py [MODEL_KEY ...]

For each test month M, training uses only pool months < M with labels from Sheet tabs < M
(a paper first listed in tab >= M counts as a negative, as it would in production).
Test rows are month-M candidates; positives are those listed in tab M.
Writes handoff/data/bt/results/<model>.csv.
"""
import json, sys
from pathlib import Path
import numpy as np, pandas as pd
from scipy import sparse
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score

D = Path(__file__).parents[3] / "handoff" / "data" / "bt"
KEYS = Path(__file__).parents[3] / "handoff" / "llm-scoring-experiment" / "keys"
MONTHS = [f"2026-{m:02d}" for m in range(3, 11)]
JOURNALS = ["Nature", "NG", "NatCommun", "NRG", "NatMed", "NatHumBehav", "Science", "SciTranslMed", "Cell", "CG", "AJHG"]
FROZEN_AT = "2026-06"
PREPRINT_CATS = ["genetics", "genomics", "genetic and genomic medicine", "health informatics"]

df = pd.read_parquet(D / "texts.parquet")
pool = df[df.kind == "pool"].reset_index(drop=True)
picks = df[df.kind == "pick"]
pick_rows = np.flatnonzero(df.kind == "pick")
prod = (pool.journal.isin(JOURNALS) | pool.category.isin(PREPRINT_CATS)).to_numpy()  # production source list
source = np.where(pool.journal.isin(["Biorxiv", "Medrxiv"]), pool.journal + ":" + pool.category, pool.journal)
venue_onehot = pd.get_dummies(pd.Series(source)).to_numpy(float)
haiku = {m: {k["doi"]: k["pick"] for k in json.load(open(KEYS / f"{m}.json"))} for m in ["2026-08", "2026-09", "2026-10"]}


def metrics(y, s):
    order = np.argsort(-s, kind="stable")
    return {"n": len(y), "picks": int(y.sum()), "auc": roc_auc_score(y, s) if 0 < y.sum() < len(y) else np.nan,
            "top25": int(y[order[:25]].sum()), "top50": int(y[order[:50]].sum())}


def lr(Xtr, ytr, Xte, C):
    return LogisticRegression(C=C, class_weight="balanced", max_iter=300, tol=1e-3).fit(Xtr, ytr).decision_function(Xte)


def run(model):
    load = lambda v: np.load(D / "emb" / f"{'minilm' if model == 'refs' else model}.{v}.npy").astype(np.float32)
    E = {"ta": load("ta"), "vta": load("vta")}
    T = load("t")
    E["t"], Tpick = T[: len(pool)], T[pick_rows]
    rows = []
    fz = prod & (pool.month < FROZEN_AT).to_numpy()
    frozen = LogisticRegression(C=1, class_weight="balanced", max_iter=300, tol=1e-3).fit(
        np.hstack([E["ta"][fz], venue_onehot[fz]]), ((pool.pick_tab != "") & (pool.pick_tab < FROZEN_AT)).to_numpy()[fz])
    for M in MONTHS:
        tr = prod & (pool.month < M).to_numpy()
        ytr = ((pool.pick_tab != "") & (pool.pick_tab < M)).to_numpy()[tr]
        te_all = prod & (pool.month == M).to_numpy()
        yte_all = (pool.pick_tab == M).to_numpy()
        old = (picks.tab < M).to_numpy()  # every earlier Sheet pick, title only
        scores = {}
        sc = pool.in_scope.to_numpy()[tr]
        for v in ["ta", "vta", "t"]:
            Xtr, Xte = E[v][tr], E[v][te_all]
            pos = Xtr[ytr]
            scores[f"{v}|centroid"] = Xte @ pos.mean(0)
            scores[f"{v}|knn10"] = np.sort(Xte @ pos.T, axis=1)[:, -10:].mean(1)
            scores[f"{v}|lr-C1"] = lr(Xtr, ytr, Xte, 1)
        Xtr, Xte = E["ta"][tr], E["ta"][te_all]
        for C in [0.1, 10]:
            scores[f"ta|lr-C{C}"] = lr(Xtr, ytr, Xte, C)
        scores["ta|lr-C1+venue1hot"] = lr(np.hstack([Xtr, venue_onehot[tr]]), ytr, np.hstack([Xte, venue_onehot[te_all]]), 1)
        # venue variants: stronger one-hot (weaker penalty), one-hot on venue-prefixed text, and a
        # single learned coefficient on the smoothed log-odds of each venue's training pick rate
        scores["ta|lr-C1+venue1hot-x3"] = lr(np.hstack([Xtr, 3 * venue_onehot[tr]]), ytr, np.hstack([Xte, 3 * venue_onehot[te_all]]), 1)
        scores["vta|lr-C1+venue1hot"] = lr(np.hstack([E["vta"][tr], venue_onehot[tr]]), ytr, np.hstack([E["vta"][te_all], venue_onehot[te_all]]), 1)
        rate = (venue_onehot[tr][ytr].sum(0) + 0.5) / (venue_onehot[tr].sum(0) + 1 / ytr.mean() * 0.5)
        prior = venue_onehot @ np.log(rate / (1 - rate))
        scores["ta|lr-C1+venueprior"] = lr(np.c_[Xtr, prior[tr]], ytr, np.c_[Xte, prior[te_all]], 1)
        scores["ref|venueprior-only"] = prior[te_all]
        if M >= FROZEN_AT:  # weights fitted once on months < FROZEN_AT and never retrained
            scores[f"ta|lr-C1+venue1hot|frozen@{FROZEN_AT}"] = frozen.decision_function(np.hstack([Xte, venue_onehot[te_all]]))
        scores["ta|lr-C1-trainscope"] = lr(Xtr[sc], ytr[sc], Xte, 1)  # in-scope-only training set
        # all earlier Sheet picks (title-only embeddings) as seeds / extra positives
        scores["t|centroid-allpicks"] = E["t"][te_all] @ Tpick[old].mean(0)
        scores["ta|centroid-allpicks-title"] = E["ta"][te_all] @ Tpick[old].mean(0)
        scores["t|lr-C1+allpicks"] = lr(np.vstack([E["t"][tr], Tpick[old]]), np.r_[ytr, np.ones(old.sum(), bool)], E["t"][te_all], 1)
        scores["ta|lr-C1+allpicks-title"] = lr(np.vstack([E["ta"][tr], Tpick[old]]), np.r_[ytr, np.ones(old.sum(), bool)], E["ta"][te_all], 1)
        if model == "refs":
            scores["ref|venue-only-lr"] = lr(venue_onehot[tr], ytr, venue_onehot[te_all], 1)
            text = (pool.title + " " + pool.abstract)
            tf = TfidfVectorizer(sublinear_tf=True, min_df=3, stop_words="english").fit(text[tr])
            scores["ref|tfidf-lr"] = lr(tf.transform(text[tr]), ytr, tf.transform(text[te_all]), 10)
            scores["ref|tfidf-lr+venue1hot"] = lr(sparse.hstack([tf.transform(text[tr]), venue_onehot[tr]]).tocsr(), ytr,
                                                  sparse.hstack([tf.transform(text[te_all]), venue_onehot[te_all]]).tocsr(), 10)
        te_pool = pool[te_all]
        for name, s in scores.items():
            universes = {"pool": np.ones(len(s), bool), "scope": te_pool.in_scope.to_numpy()}
            y = yte_all[te_all]
            if M in haiku:  # exactly the papers and labels Haiku was scored on
                universes["haiku-set"] = te_pool.doi.isin(haiku[M]).to_numpy()
            for u, mask in universes.items():
                yy = te_pool.doi[mask].map(haiku[M]).to_numpy(bool) if u == "haiku-set" else y[mask]
                rows.append({"model": model, "scorer": name, "month": M,
                             "universe": u, "all_picks": int(y.sum()), **metrics(yy, s[mask])})
    return rows


(D / "results").mkdir(exist_ok=True)
for m in sys.argv[1:]:  # model keys, or "refs" for the non-embedding references
    res = pd.DataFrame(run(m))
    if m == "refs":
        res = res[res.scorer.str.startswith("ref|")]
    else:
        res = res[~res.scorer.str.startswith("ref|venueprior")]
    res.to_csv(D / "results" / f"{m}.csv", index=False)
    print(m, len(res), "rows", flush=True)
