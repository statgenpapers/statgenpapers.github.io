"""Scorer: static text embedding plus venue, and the month's linear weights (pipeline/train.py)."""
import numpy as np
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
    """The Score: calibrated chance that the paper gets marked, sigmoid(a + b·score), a and b refitted each month (pipeline/train.py)."""
    return expit(w["calibration"]["a"] + w["calibration"]["b"] * np.asarray(score))
