"""Summarize backtest results. Dev months (2026-03..09) choose; 2026-10 is held out.

Prints the comparison tables and writes site/data/backtest.json, the aggregate numbers shown
on the site's About page (no paper-level data).
"""
import glob, json, re
from datetime import date
from pathlib import Path
import pandas as pd

ROOT = Path(__file__).parents[3]
D = ROOT / "handoff" / "data" / "bt" / "results"
r = pd.concat(map(pd.read_csv, glob.glob(str(D / "*.csv"))))
pd.set_option("display.width", 250, "display.max_rows", 200)
agg = lambda d: d.groupby(["model", "scorer"]).agg(auc=("auc", "mean"), top25=("top25", "sum"), top50=("top50", "sum"), picks=("picks", "sum"))
dev = agg(r[(r.month < "2026-10") & (r.universe == "pool")])
held = agg(r[(r.month == "2026-10") & (r.universe == "pool")]).add_prefix("oct_")
t = dev.join(held[["oct_auc", "oct_top25", "oct_picks"]]).reset_index().sort_values(["top25", "auc"], ascending=False)
print("== full pool (~2,100 papers/month), dev = 7 months summed, Oct held out; best scorer per model")
print(t.groupby("model").head(1).round(3).to_string(index=False))
print("\n== all scorers, top 25 by dev top25")
print(t.head(25).round(3).to_string(index=False))
h = r[r.universe == "haiku-set"].pivot_table(index=["model", "scorer"], columns="month", values=["auc", "top25"]).round(3)
h.columns = [f"{a}_{m[5:]}" for a, m in h.columns]
h["auc_mean"] = h.filter(like="auc").mean(axis=1).round(3); h["top25_sum"] = h.filter(like="top25").sum(axis=1)
print("\n== same papers and labels as Haiku (Aug/Sep/Oct: AUC .870/.893/.882, top25 13/17/13 = 43)")
print(h.sort_values("top25_sum", ascending=False).head(25).to_string())

f = r[(r.universe == "pool") & (r.month >= "2026-06") & r.scorer.str.startswith("ta|lr-C1+venue1hot") & ~r.scorer.str.contains("x3")]
print("\n== frozen (trained once on Nov-May) vs retrained monthly, Jun-Oct, full pool: top25 hits / mean AUC")
print(f.groupby(["model", "scorer"]).agg(auc=("auc", "mean"), top25=("top25", "sum"), picks=("picks", "sum")).round(3).to_string())


# ---- export for the About page
VENUE = "ta|lr-C1+venue1hot"


def total(model, scorer, universe="pool", months=("2026-03", "2026-10")):
    d = r[(r.model == model) & (r.scorer == scorer) & (r.universe == universe) & r.month.between(*months)].sort_values("month")
    return {"auc": round(d.auc.mean(), 3), "top25": int(d.top25.sum()), "picks": int(d.picks.sum()),
            "auc_by_month": d.auc.round(3).tolist(), "top25_by_month": d.top25.tolist()}


st = pd.concat(map(pd.read_csv, glob.glob(str(D.parent / "strategies" / "*.csv"))))
st = st[~st.emb.str.contains(r"\+")].groupby(["strategy", "emb"]).agg(auc=("auc", "mean"), top25=("top25", "sum")).round(3).unstack("emb")
haiku = [dict(zip(["month", "auc", "top25"], [m, float(a), int(t)])) for m, a, t in re.findall(
    r"^v7-\S+ (\S+): .*AUC=(\S+) top25=(\d+)", (ROOT / "handoff" / "llm-scoring-experiment" / "results.txt").read_text(), re.M)]
pool = r[(r.model == "potion-32m") & (r.scorer == VENUE) & (r.universe == "pool")]
out = {
    "generated": date.today().isoformat(),
    "months": sorted(pool.month.unique()),
    "picks": int(pool.picks.sum()),
    "pool_per_month": int(pool.n.mean().round()),
    "scorers": [{"label": label, "chosen": label.startswith("potion-32M + venue"), **total(model, scorer)} for label, model, scorer in [
        ("potion-32M + venue one-hot", "potion-32m", VENUE),
        ("MiniLM-L6 + venue one-hot", "minilm", VENUE),
        ("static-retrieval-mrl + venue one-hot", "static-retrieval", VENUE),
        ("TF-IDF words + venue one-hot (not an embedding)", "refs", "ref|tfidf-lr+venue1hot"),
        ("potion-32M, text only", "potion-32m", "ta|lr-C1"),
        ("potion-32M, similarity to centroid of picks", "potion-32m", "ta|centroid"),
        ("Venue only", "refs", "ref|venue-only-lr"),
    ]],
    "haiku": {"months": [x["month"] for x in haiku],
              "papers_per_month": int(r[(r.universe == "haiku-set") & (r.model == "potion-32m") & (r.scorer == VENUE)].n.mean().round()),
              "rows": [{"label": "Claude Haiku (prompt v7)", "auc_by_month": [x["auc"] for x in haiku],
                        "top25_by_month": [x["top25"] for x in haiku], "top25": sum(x["top25"] for x in haiku)},
                       {"label": "potion-32M + venue one-hot", **total("potion-32m", VENUE, "haiku-set", ("2026-08", "2026-10"))}]},
    "frozen": {"months": ["2026-06", "2026-10"], "trained_through": "2026-05",
               "frozen": total("potion-32m", f"{VENUE}|frozen@2026-06", months=("2026-06", "2026-10")),
               "retrained": total("potion-32m", VENUE, months=("2026-06", "2026-10"))},
    "regex_shortlist": {"full_pool": total("potion-32m", VENUE), "regex_shortlist": total("potion-32m", VENUE, "scope")},
    "venue_variants": {"months": ["2026-03", "2026-09"], "rows": [
        {"model": m, **{k: total(m, sc, months=("2026-03", "2026-09"))["top25"] for k, sc in
                        [("one_hot", VENUE), ("one_hot_x3", f"{VENUE}-x3"), ("pick_rate_prior", "ta|lr-C1+venueprior")]}}
        for m in ["potion-32m", "minilm", "static-retrieval"]]},
    "strategies": [{"strategy": k, **{f"{e}_{c}".replace("-", "_"): float(v[(c, e)]) for c in ["auc", "top25"] for e in ["potion-32m", "minilm"]}}
                   for k, v in st.sort_values(("top25", "potion-32m"), ascending=False).iterrows()],
}
(ROOT / "site" / "data" / "backtest.json").write_text(json.dumps(out, indent=1) + "\n")
print("\nwrote site/data/backtest.json")
