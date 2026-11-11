"""Build the backtest text table from handoff/data (local only; never committed).

Writes handoff/data/bt/texts.parquet with one row per text to embed:
  pool rows (kind=pool): title, abstract, venue string, month, in_scope, label tab
  pick rows (kind=pick): Sheet picks (title only), tab
"""
import gzip, json, re
from pathlib import Path
import pandas as pd

D = Path(__file__).parents[2] / "handoff" / "data"
VENUE = {"NG": "Nature Genetics", "AJHG": "American Journal of Human Genetics", "CG": "Cell Genomics",
         "NRG": "Nature Reviews Genetics", "NatCommun": "Nature Communications", "NatMed": "Nature Medicine",
         "NatHumBehav": "Nature Human Behaviour", "SciTranslMed": "Science Translational Medicine",
         "GenomeBiol": "Genome Biology", "GenomeRes": "Genome Research", "NatBiotech": "Nature Biotechnology",
         "NatMethods": "Nature Methods", "NatNeuro": "Nature Neuroscience", "NatAging": "Nature Aging"}
norm_title = lambda t: re.sub(r"[^a-z0-9]", "", t.lower())

picks = pd.read_csv(D / "sheet-picks.csv", dtype=str).fillna("")
picks["nt"] = picks.title.map(norm_title)
# every pool file: pool-2025-11_2026-10.jsonl.gz and the months 2025-01..10 fetched with `python -m pipeline --pool-only`
# (with equal weights they made the 2026 lists worse; with dev/recency.py's half-life they make them better)
pool = pd.DataFrame([json.loads(l) for f in sorted(D.glob("pool-*.jsonl.gz")) for l in gzip.open(f, "rt")]).drop_duplicates("doi")
# production source list only (the pool file also holds sources dropped earlier)
pool = pool[pool.journal.isin(["Nature", "NG", "NatCommun", "NRG", "NatMed", "NatHumBehav", "Science", "SciTranslMed", "Cell", "CG", "AJHG"])
            | pool.category.isin(["genetics", "genomics", "genetic and genomic medicine", "health informatics"])].reset_index(drop=True)
pool["month"] = pool.date.str[:7]
pool["nt"] = pool.title.map(norm_title)
pool["venue"] = [f"{'bioRxiv' if j == 'Biorxiv' else 'medRxiv'} preprint, {c}" if j in ("Biorxiv", "Medrxiv")
                 else VENUE.get(j, j) for j, c in zip(pool.journal, pool.category)]
# first tab (YYYY-MM) that lists each candidate, by DOI or normalized title; "" if never picked
# a candidate is a pick of the earliest tab >= its own month that lists it (re-listed journal versions
# match the later tab by title; earlier-tab DOI matches are the dedupe case and are dropped downstream)
def pick_tab(r):
    tabs = picks.tab[(picks.doi.eq(r.doi) & (r.doi != "")) | picks.nt.eq(r.nt)]
    tabs = tabs[tabs >= r.month]
    return tabs.min() if len(tabs) else ""
cand = pool[pool.doi.isin(set(picks.doi) - {""}) | pool.nt.isin(set(picks.nt) - {""})]
pool["pick_tab"] = ""
pool.loc[cand.index, "pick_tab"] = cand.apply(pick_tab, axis=1)
pool["kind"] = "pool"
picks["kind"] = "pick"
out = pd.concat([pool[["kind", "doi", "journal", "category", "venue", "title", "abstract", "month", "in_scope", "pick_tab"]],
                 picks[["kind", "doi", "journal", "title", "tab"]]], ignore_index=True)
out["in_scope"] = out.in_scope.fillna(False).astype(bool)
out = out.fillna("")
(D / "bt").mkdir(exist_ok=True)
out.to_parquet(D / "bt" / "texts.parquet")
print(out.kind.value_counts().to_dict(), "pool picks:", (pool.pick_tab != "").sum(),
      "same-month:", (pool.pick_tab == pool.month).sum())
print(pd.crosstab(pool.month, pool.pick_tab).to_string())
