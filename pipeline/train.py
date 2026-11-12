"""The monthly model: refitted before each list on the pools of the 12 months before it, from the marks on the site.

A pool paper marked on the site (on a list, or added and marked, in any month) is a positive; every other pool
paper a negative, as if readers had looked through the whole pool. A marked added paper found in no stored pool is
one more positive, in the month it was added to. Month M of a model for month L weighs 0.5 ** (age / 6), age = L - M
in months, 1 to 12: the setting the leak-free backtest of 2026-01..10 chose (dev/recency.py, dev/train.py).

Each month's pool is stored in data/pools/YYYY-MM.npz: DOIs, plain titles, venue keys, embeddings as int8 (with a
scale per dimension; the leak-free backtest of 2026-07..10 scored the same as with full precision) and how many papers
each token of the embedding model's vocabulary appears in (for the words of the About page). No abstracts. The files
live on the branch `pools`, which keeps the last 12 months in one commit (.github/workflows/monthly.yml).
"""
import re
from datetime import date

import numpy as np

from . import ROOT
from .fetch import plain_title, url_doi

POOLS = ROOT / "data" / "pools"
WINDOW, HALF_LIFE = 12, 6  # months
MIN_PAPERS, MIN_PAPERS_CHANGE = 30, 100  # a word shown on About is in at least this many papers of the training pools

index = lambda m: int(m[:4]) * 12 + int(m[5:7]) - 1
month_at = lambda i: f"{i // 12}-{i % 12 + 1:02d}"


def save_pool(month, model, dois, titles, abstracts, venues, emb):
    """Store a month's pool: the training data of the next 12 months' models."""
    tokens = model.tokenizer.encode_batch([f"{t}\n{a}" for t, a in zip(titles, abstracts)], add_special_tokens=False)
    ids, counts = np.unique(np.concatenate([np.unique(t.ids) for t in tokens] or [np.zeros(0, int)]), return_counts=True)
    emb = np.asarray(emb, np.float32).reshape(len(dois), -1)
    scale = np.maximum(np.abs(emb).max(0), 1e-12) / 127
    POOLS.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(POOLS / f"{month}.npz", doi=np.array(dois, str), title=np.array([plain_title(t) for t in titles], str),
                        venue=np.array(venues, str), emb=np.round(emb / scale).astype(np.int8), scale=scale,
                        token=ids.astype(np.int32), papers=counts.astype(np.int32))


def load_pool(month):
    """A stored pool, its embeddings as floats again."""
    with np.load(POOLS / f"{month}.npz") as p:
        return {k: p[k] for k in p.files} | {"emb": p["emb"] * p["scale"].astype(float)}


def marked_keys(listed, votes, submissions):
    """DOIs and plain titles of every paper marked on the site: listed papers by id, added papers by submission id.
    listed: {month: [paper]}; votes: {month: {paper id: marks}}; submissions: {month: {submission id: paper}}."""
    keys = set()
    for m, marks in votes.items():
        ids, subs = {p["id"]: p for p in listed.get(m, [])}, submissions.get(m, {})
        for pid in marks:
            if pid in ids:
                keys |= {ids[pid]["doi"], plain_title(ids[pid]["title"])}
            elif pid in subs:
                keys |= {url_doi(subs[pid]["url"]), plain_title(subs[pid]["title"])}
    return keys - {""}


def fit(month, venue_names, keys, added=None, base=None, model=None):
    """Weights for month `month` ("2026-11") in the shape `score.linear` takes, or None if no pool is stored.

    keys: marked_keys(); added: {month: [(doi, title, embedding)]} of the marked added papers; base: the current
    weights, whose model, calibration and text recipe are kept; model: the embedding model, for the words."""
    from sklearn.linear_model import LogisticRegression

    months = [month_at(index(month) - age) for age in range(1, WINDOW + 1)]
    pools = {m: load_pool(m) for m in months if (POOLS / f"{m}.npz").exists()}
    if not pools:
        return None
    found = set().union(*({*p["doi"].tolist(), *p["title"].tolist()} for p in pools.values())) - {""}
    names = np.array(sorted(venue_names))
    X, y, w = [], [], []
    for m, p in pools.items():
        X.append(np.hstack([p["emb"], p["venue"][:, None] == names]))
        y.append(np.isin(p["doi"], list(keys)) | np.isin(p["title"], list(keys)))
        w.append(np.full(len(p["doi"]), 0.5 ** ((index(month) - index(m)) / HALF_LIFE)))
    for m, papers in (added or {}).items():  # marked added papers no pool holds; no venue: they may come from any journal
        emb = np.array([e for doi, title, e in papers if m in pools and not {doi, plain_title(title)} & found])
        if len(emb):
            X.append(np.hstack([emb, np.zeros((len(emb), len(names)))]))
            y.append(np.ones(len(emb), bool))
            w.append(np.full(len(emb), 0.5 ** ((index(month) - index(m)) / HALF_LIFE)))
    X, y, w = np.vstack(X), np.concatenate(y), np.concatenate(w)
    lr = LogisticRegression(C=1, class_weight="balanced", max_iter=300, tol=1e-3).fit(X, y, sample_weight=w)
    coef, k = lr.coef_[0], X.shape[1] - len(names)
    out = {key: base[key] for key in ("model", "revision", "text", "calibration") if base and key in base} | {
        "bias": round(float(lr.intercept_[0]), 6), "embedding": coef[:k].round(6).tolist(),
        "venue": dict(zip(names.tolist(), coef[k:].round(6).tolist())), "trained": date.today().isoformat(),
        "train_months": sorted(pools), "half_life_months": HALF_LIFE, "marked": int(y.sum()), "papers": len(y),
    }
    if model is not None:
        out["words"] = words(model, out, pools, base)
    return out


def words(model, weights, pools, previous=None, n=15):
    """The words that raise and lower the score most, and those the model weighs more and less than `previous`.

    The embedding is the normalized mean of its tokens' vectors, so a token adds (its vector · the weights) to the
    score of every paper it is in, divided by that paper's norm: the ranking of tokens is exact. Only words of 4
    letters or more, in at least MIN_PAPERS papers of the training pools; MIN_PAPERS_CHANGE for the change from
    `previous`, which is small, so rare word pieces would lead it."""
    vectors, vocab = np.asarray(model.embedding), model.tokenizer.get_vocab()
    papers = np.zeros(len(vectors), int)
    for p in pools.values():
        np.add.at(papers, p["token"], p["papers"])
    names = np.empty(len(vectors), object)
    for token, i in vocab.items():
        if i < len(names):
            names[i] = token
    word = np.array([bool(t) and bool(re.fullmatch(r"[a-z][a-z-]{3,}", t)) for t in names])
    rank = lambda c, ok, k: [str(t) for t in names[ok][np.argsort(-c[ok], kind="stable")[:k]]]
    effect, ok = vectors @ np.asarray(weights["embedding"]), word & (papers >= MIN_PAPERS)
    out = {"up": rank(effect, ok, n), "down": rank(-effect, ok, n)}
    if previous and len(previous.get("embedding", [])) == vectors.shape[1]:
        change, ok = effect - vectors @ np.asarray(previous["embedding"]), word & (papers >= MIN_PAPERS_CHANGE)
        out |= {"more": rank(change, ok, 10), "less": rank(-change, ok, 10)}
    return out
