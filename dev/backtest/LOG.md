# Dev log

Dated results of experiments that are not part of the monthly run. Aggregate numbers only;
the data behind them lives in `handoff/` and is never committed.

## 2026-11-10: Calibrated pick chance

The score is the decision function of a logistic regression fitted with balanced class weights,
so `sigmoid(score)` overstates the chance of a pick (a score of 8.8 reads as 99.98%). An
unpenalized logistic fit to the out-of-sample scores of the rolling backtest (Mar–Oct 2026,
17,000 papers, 210 picks) gives `P(pick) = sigmoid(-3.378 + 0.716 · score)`, stored as
`calibration` in the model (now `data/model.json`, refitted by each monthly run).

| Score | Papers | Picked | Calibrated |
|---|---|---|---|
| ≤ 0 | 15,882 | 0.3% | 0.3% |
| 0–2 | 729 | 8.8% | 6.2% |
| 2–4 | 226 | 16.8% | 21.0% |
| 4–5 | 53 | 47.2% | 47.2% |
| 5–6 | 27 | 51.9% | 63.3% |
| 6–7 | 19 | 78.9% | 77.2% |
| 7–9 | 14 | 92.9% | 90.0% |
| Top 25 of each month | 200 | 45.0% | 45.8% |

The calibration comes from models trained on fewer months than the final weights, and it
predicts lab picks, not upvotes.

## 2026-11-10: Other embedding models

Rolling backtest (`dev/backtest/`), full pool, logistic regression on embedding + venue
one-hot, title + abstract. Top 25: picks found in the top 25 of each month, Mar–Oct 2026
(210 picks); October was held out from model selection.

| Model | Mean AUC | Top 25 (of 210) | Oct top 25 (of 19) | Abstracts/s, 4 CPU threads |
|---|---|---|---|---|
| PubMedBERT (`NeuML/pubmedbert-base-embeddings`) | 0.972 | 96 | 11 | ~6 |
| bge-base | 0.973 | 95 | 13 | 6 |
| SciNCL | 0.970 | 95 | 11 | ~6 |
| MedCPT | 0.968 | 94 | 12 | ~6 |
| bge-small | 0.971 | 91 | 13 | 21 |
| mpnet | 0.969 | 91 | 12 | ~6 |
| **potion-32M (in use)** | 0.963 | 90 | 12 | **7,300** |
| MiniLM-L6 | 0.965 | 87 | 12 | 72 |
| SPECTER2 (base) | 0.969 | 86 | 11 | ~6 |
| e5-base | 0.966 | 86 | 11 | ~6 |
| static-retrieval-mrl | 0.962 | 86 | 12 | 5,100 |

On the papers and labels of the Haiku experiment (Haiku: 43 top-25 hits), the models score
32–39, potion 38. gte-modernbert did not finish embedding within the 6-hour Slurm limit.

Speeds were timed on 5,000 (static) or 100–300 (transformer) abstracts; "~6" marks base-size
BERT models not timed directly, whose Slurm run times match bge-base.

Conclusion: the best transformer finds 6 more picks of 210 than potion, none more on the held-out
month, at about 1/1,000 of the speed. potion-32M stays; it is also the fastest model tested.

## Weighting added papers (2026-11-13)

`added_weight.py`: added papers (picks outside their month's top 25) weighted k times in training,
leak-free, 2026-01..10 (239 picks; 271 of the 486 pool picks were added).

| k | Mean AUC | AUC, unshown picks | Top 25 (of 239) |
|---|---|---|---|
| **1 (in use)** | 0.971 | 0.949 | 110 |
| 1.5 | 0.971 | 0.948 | 109 |
| 2 | 0.972 | 0.950 | 110 |
| 3 | 0.972 | 0.951 | 113 |
| 5 | 0.972 | 0.949 | 111 |

Conclusion: no weight helps beyond noise (3 picks in 10 months at best, months mixed); added papers stay at
weight 1. Of the 199 papers added 2026-01..10, 32 are in no stored pool: 23 preprints (9 bioRxiv
bioinformatics, the rest spread over 8 categories), 5 PNAS, 2 Science, 1 JACC, 1 Nat Genet.
