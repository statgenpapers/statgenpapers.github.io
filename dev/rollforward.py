"""Roll the site forward through past months as if it had run live: python dev/rollforward.py 2026-01 2026-10

For each month M, in order:
1. Fit lab weights on the pool months before M, with the picks known before M (leak-free), and a
   calibration on out-of-sample scores of earlier months; write model/rollforward/weights-M.json.
2. Run the monthly pipeline for M with those weights (it fetches M's pool and writes site/data/M.*).
3. Put the lab's picks for M on the site as marks of the handle "admin" (dev/lab_marks.py): a
   listed pick is marked, a missed pick is added as a paper and marked. The next month's run then
   sees them, as it would see readers' marks.

Local only: reads the private handoff/data/ files (picks and the labelled 2025-11..2026-10 pool).
Run from the repository root with: uv run --group train python dev/rollforward.py 2026-01 2026-10
"""
import csv
import json
import re
import subprocess
import sys
import tempfile
import tomllib
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT))
from pipeline.fetch import clean, url_doi  # noqa: E402
from pipeline.score import embed, load_model  # noqa: E402

MODEL = {"model": "minishlab/potion-base-32M", "revision": "1e5a03f8eeb2c98b928fbbd846f22f816360919f"}
OUT = ROOT / "model" / "rollforward"
cfg = tomllib.loads((ROOT / "config" / "sources.toml").read_text())

pool = pd.read_parquet(ROOT / "handoff" / "data" / "bt" / "texts.parquet").query("kind == 'pool'").reset_index(drop=True)
month, tab = pool.month.to_numpy(), pool.pick_tab.to_numpy()  # tab: first Sheet tab listing the paper, "" if none
venue = np.where(pool.journal.isin(["Biorxiv", "Medrxiv"]), "Preprint", pool.journal)
names = np.unique(venue)
emb = embed(load_model(MODEL), pool.title.map(clean), pool.abstract.map(clean))
X = np.hstack([emb, venue[:, None] == names])
fit = lambda before: LogisticRegression(C=1, class_weight="balanced", max_iter=300, tol=1e-3).fit(
    X[month < before], ((tab != "") & (tab < before))[month < before])


def weights(M):
    """Lab weights for month M: fitted on months before M; calibration on earlier months' out-of-sample scores."""
    oos = [(fit(K).decision_function(X[month == K]), tab[month == K] == K) for K in sorted(set(month)) if month.min() < K < M]
    s, y = map(np.concatenate, zip(*oos))
    cal = LogisticRegression(penalty=None).fit(s[:, None], y)
    lr = fit(M)
    w = lr.coef_[0].round(6).tolist()
    return MODEL | {"text": "title\nabstract", "bias": round(float(lr.intercept_[0]), 6), "embedding": w[:emb.shape[1]],
                    "venue": dict(zip(names.tolist(), w[emb.shape[1]:])),
                    "calibration": {"a": round(float(cal.intercept_[0]), 4), "b": round(float(cal.coef_[0, 0]), 4)},
                    "trained": date.today().isoformat(), "train_months": sorted(set(month[month < M]))}


# The Journal column for a pick the model missed: the Sheet's journal key, as the site shows journals
ABBR = {j["key"]: j["abbr"] for j in cfg["journals"]} | {j["name"]: j["abbr"] for j in cfg["journals"]} | {
    "biorxiv": "bioRxiv", "medrxiv": "medRxiv", "zenodo": "Zenodo", "nat comm": "Nat Commun", "nat genet": "Nat Genet"}
journal = lambda j: ABBR.get(j) or ABBR.get(j.lower()) or j
plain = lambda t: re.sub(r"[^a-z0-9]+", " ", t.lower()).strip()


def lab_marks(M):
    """dev/lab_marks.py actions for M: the picks of tab M, marked where listed, else added."""
    papers = json.loads((ROOT / "site" / "data" / f"{M}.json").read_text())["papers"]
    by_doi, by_title = {p["doi"].lower(): p["id"] for p in papers}, {plain(p["title"]): p["id"] for p in papers}
    marks, add = [], []
    for r in csv.DictReader(open(ROOT / "handoff" / "data" / "sheet-picks.csv")):
        if r["tab"] != M:
            continue
        doi = (r["doi"] or url_doi(r["url"])).lower()
        listed = by_doi.get(doi) or by_title.get(plain(r["title"]))
        if listed:
            marks.append(listed)
        elif r["url"].startswith(("http://", "https://")):
            add.append({"journal": journal(r["journal"])[:60], "title": r["title"][:400], "url": r["url"][:500],
                        "short_name": (r["short_name"] or r["title"])[:150]})
    return {"month": M, "marks": sorted(set(marks)), "add": add}


def months(first, last):
    y, m = map(int, first.split("-"))
    while f"{y}-{m:02d}" <= last:
        yield f"{y}-{m:02d}"
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)


OUT.mkdir(parents=True, exist_ok=True)
for M in months(*sys.argv[1:3]):
    path = OUT / f"weights-{M}.json"
    path.write_text(json.dumps(weights(M)) + "\n")
    subprocess.run([sys.executable, "-m", "pipeline", "--month", M, "--weights", str(path)], cwd=ROOT, check=True)
    with tempfile.NamedTemporaryFile("w", suffix=".json") as f:
        actions = lab_marks(M)
        json.dump(actions, f)
        f.flush()
        subprocess.run([sys.executable, "dev/lab_marks.py", f.name], cwd=ROOT, check=True)
    print(f"== {M}: {len(actions['marks'])} picks on the list, {len(actions['add'])} added", flush=True)
