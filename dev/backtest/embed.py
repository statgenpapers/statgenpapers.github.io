"""Embed the backtest texts with one model. Usage: embed.py MODEL_KEY [VARIANT ...]

Writes handoff/data/bt/emb/<key>.<variant>.npy (float16, L2-normalized), rows aligned to texts.parquet:
  ta  = title + abstract            (pool rows)
  vta = venue + title + abstract    (pool rows)
  t   = title only                  (pool and pick rows)
"""
import sys, time
from pathlib import Path
import numpy as np, pandas as pd, torch
from sentence_transformers import SentenceTransformer, models

# key: (hf id, pooling or None for the model's own sentence-transformers config, document prefix, kwargs)
MODELS = {
    "pubmedbert-st": ("NeuML/pubmedbert-base-embeddings", None, "", {}),
    "medcpt": ("ncbi/MedCPT-Article-Encoder", "cls", "", {}),
    "specter2": ("allenai/specter2_base", "cls", "", {}),  # + proximity adapter
    "scincl": ("malteos/scincl", "cls", "", {}),
    "bge-small": ("BAAI/bge-small-en-v1.5", None, "", {}),
    "bge-base": ("BAAI/bge-base-en-v1.5", None, "", {}),
    "minilm": ("sentence-transformers/all-MiniLM-L6-v2", None, "", {}),
    "mpnet": ("sentence-transformers/all-mpnet-base-v2", None, "", {}),
    "e5-base": ("intfloat/e5-base-v2", None, "passage: ", {}),
    "gte-modernbert": ("Alibaba-NLP/gte-modernbert-base", None, "", {}),
    # static embeddings: token lookup + mean, no transformer forward pass
    "potion-32m": ("minishlab/potion-base-32M", None, "", {}),
    "static-retrieval": ("sentence-transformers/static-retrieval-mrl-en-v1", None, "", {}),
}
key = sys.argv[1]
hf, pooling, prefix, kw = MODELS[key]
D = Path(__file__).parents[2] / "handoff" / "data" / "bt"
(D / "emb").mkdir(exist_ok=True)
df = pd.read_parquet(D / "texts.parquet")
device = "cpu"  # production runs on a CPU-only GitHub Actions runner
torch.set_num_threads(16)

if pooling:
    tr = models.Transformer(hf, max_seq_length=512)
    if key == "specter2":
        from adapters import init
        init(tr.auto_model)
        tr.auto_model.load_adapter("allenai/specter2", source="hf", load_as="proximity", set_active=True)
    model = SentenceTransformer(modules=[tr, models.Pooling(tr.get_word_embedding_dimension(), pooling)], device=device)
else:
    model = SentenceTransformer(hf, device=device, **kw)
    if isinstance(model[0], models.Transformer):  # static embeddings have no length limit to set
        model.max_seq_length = min(model.max_seq_length or 512, 512)
sep = getattr(getattr(model, "tokenizer", None), "sep_token", None) or "\n"  # SPECTER/SciNCL/MedCPT were trained on "title [SEP] abstract"
pool = df[df.kind == "pool"]
texts = {
    "ta": (pool.title + f" {sep} " + pool.abstract).tolist(),
    "vta": (pool.venue + ". " + pool.title + f" {sep} " + pool.abstract).tolist(),
    "t": df.title.tolist(),
}
for variant in sys.argv[2:] or list(texts):
    tx = texts[variant]
    t0 = time.time()
    emb = model.encode([prefix + x for x in tx], batch_size=64, normalize_embeddings=True, show_progress_bar=False)
    np.save(D / "emb" / f"{key}.{variant}.npy", emb.astype(np.float16))
    print(f"{key} {variant}: {emb.shape} in {time.time() - t0:.0f}s on {torch.get_num_threads()} CPU threads, {len(tx) / (time.time() - t0):.1f} docs/s", flush=True)
