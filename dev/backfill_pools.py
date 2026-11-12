"""Store the pools of the cold start (2025-11..2026-10) in data/pools/, from which the monthly run's model learns.

    uv run --group train python dev/backfill_pools.py

Local only: reads handoff/data/bt/texts.parquet (dev/backtest/prep.py). The monthly run stores each later month's
pool itself. What is stored holds no picks and no abstracts (pipeline/train.py).
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT))
from pipeline.fetch import clean, norm_doi  # noqa: E402
from pipeline.score import embed, load_model  # noqa: E402
from pipeline.train import save_pool  # noqa: E402

pool = pd.read_parquet(ROOT / "handoff" / "data" / "bt" / "texts.parquet").query("kind == 'pool' and month >= '2025-11'")
model = load_model(json.loads((ROOT / "model" / "weights.json").read_text()))
for month, p in pool.groupby("month"):
    titles, abstracts = p.title.map(clean).tolist(), p.abstract.map(clean).tolist()
    venues = np.where(p.journal.isin(["Biorxiv", "Medrxiv"]), "Preprint", p.journal)  # a preprint is a preprint
    save_pool(month, model, p.doi.map(norm_doi).tolist(), titles, abstracts, venues, embed(model, titles, abstracts))
    print(month, len(p))
