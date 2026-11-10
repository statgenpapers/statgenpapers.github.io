"""Summarize backtest results. Dev months (2026-03..09) choose; 2026-10 is held out."""
import glob
from pathlib import Path
import pandas as pd

D = Path(__file__).parents[2] / "handoff" / "data" / "bt" / "results"
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
h["auc_mean"] = h.filter(like="auc").mean(1).round(3); h["top25_sum"] = h.filter(like="top25").sum(1)
print("\n== same papers and labels as Haiku (Aug/Sep/Oct: AUC .870/.893/.882, top25 13/17/13 = 43)")
print(h.sort_values("top25_sum", ascending=False).head(25).to_string())

f = r[(r.universe == "pool") & (r.month >= "2026-06") & r.scorer.str.startswith("ta|lr-C1+venue1hot") & ~r.scorer.str.contains("x3")]
print("\n== frozen (trained once on Nov-May) vs retrained monthly, Jun-Oct, full pool: top25 hits / mean AUC")
print(f.groupby(["model", "scorer"]).agg(auc=("auc", "mean"), top25=("top25", "sum"), picks=("picks", "sum")).round(3).to_string())
