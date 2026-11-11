"""Scorer: static text embedding plus venue, linear base weights, and a correction learned from votes."""
import numpy as np
from scipy.optimize import minimize
from scipy.special import expit


def load_model(weights):
    """The embedding model named in the weights file, at its pinned revision."""
    from huggingface_hub import snapshot_download
    from model2vec import StaticModel

    path = snapshot_download(weights["model"], revision=weights["revision"],
                             allow_patterns=["config.json", "model.safetensors", "tokenizer.json"])
    return StaticModel.from_pretrained(path, force_download=False)


def embed(model, titles, abstracts):
    """L2-normalized embeddings of title + newline + abstract, untruncated (as in the backtest)."""
    texts = [f"{t}\n{a}" for t, a in zip(titles, abstracts)]
    return model.encode(texts, max_length=None, normalize=True) if texts else np.zeros((0, model.dim))


def linear(w, emb, venues):
    """bias + embedding weights · embedding + venue weight; a venue missing from `w` weighs 0."""
    return w.get("bias", 0.0) + emb @ np.asarray(w["embedding"]) + np.array([w["venue"].get(v, 0.0) for v in venues])


def probability(w, score):
    """The Score: calibrated chance that the paper gets marked, sigmoid(a + b·score), a and b from dev/train.py."""
    return expit(w["calibration"]["a"] + w["calibration"]["b"] * np.asarray(score))


def vote_correction(emb, venues, upvoted, offset, penalty, min_upvoted):
    """Correction Δ to the base weights, learned from votes, in the shape `linear` takes.

    Rows are the listed papers of the months that got votes; `upvoted` says which of them have
    an upvote. Logistic regression of `upvoted` on [embedding, venue one-hot], with the base
    score as a fixed `offset`, a free intercept (listed papers are upvoted at another rate than
    pool papers were marked in the training data) and the penalty penalty/2 · |Δ|². Few votes, or votes the base score
    already predicts, leave Δ near 0, so the scorer stays at the base weights. Δ is exactly 0
    below `min_upvoted` upvoted papers, and when every paper is upvoted.
    """
    names, k = sorted(set(venues)), emb.shape[1]
    if upvoted.sum() < min_upvoted or upvoted.all():
        return {"embedding": np.zeros(k), "venue": {}}
    X = np.hstack([emb, np.array(venues)[:, None] == np.array(names), np.ones((len(emb), 1))])
    weight = np.r_[np.full(X.shape[1] - 1, penalty), 0.0]  # the intercept, last, is not penalized

    def loss(d):
        z = offset + X @ d
        return np.logaddexp(0, z).sum() - upvoted @ z + weight @ d**2 / 2, X.T @ (expit(z) - upvoted) + weight * d

    d = minimize(loss, np.zeros(X.shape[1]), jac=True, method="L-BFGS-B").x
    return {"embedding": d[:k], "venue": dict(zip(names, d[k:-1]))}
