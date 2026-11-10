# Scorer backtest

Reproduces the numbers on the site's About page. It needs the lab-internal files in
`handoff/data/` (gitignored), so it runs only on the owner's machine. Nothing it reads
or writes under `handoff/` is ever committed; only aggregate results are published.

Run from the repository root:

```bash
UV="uv run --no-project --python 3.12 --with torch --with sentence-transformers --with model2vec --with pandas --with pyarrow --with scikit-learn"
export HF_HOME=$PWD/.cache/hf OMP_NUM_THREADS=4

$UV python dev/backtest/prep.py                 # 1. label the 12-month pool against the picks
$UV python dev/backtest/embed.py potion-32m     # 2. embed (seconds for static models; see MODELS in embed.py)
$UV python dev/backtest/backtest.py refs potion-32m   # 3. rolling backtest, ~10 s per model
$UV python dev/backtest/summary.py              # 4. tables
```

Larger models take 20–60+ minutes each on 16 CPU threads: `sbatch -J <key> dev/backtest/embed.sbatch <key>`.

## Protocol

1. **Pool:** every candidate from the production source list, Nov 2025 – Oct 2026 (about 2,100 a month).
2. **Labels:** a candidate is a positive for month M if the lab listed it in tab M.
3. **Leak-free:** to score month M, the model is trained only on months before M, using only
   picks from tabs before M. A paper first listed in tab M or later counts as a negative in
   training, as it would in production.
4. **Selection:** March–September 2026 choose the model and scorer; October 2026 is held out.
5. **Metrics:** AUC, and picks found in the top 25 (the site shows 20–30 papers).
6. **Haiku comparison:** the `haiku-set` universe restricts to the papers and labels of the earlier
   Claude Haiku experiment (`handoff/llm-scoring-experiment/keys/`). 328/340, 358/368 and 346/346 of
   those papers are in this pool for Aug, Sep and Oct.

## Files

| File | Purpose |
|---|---|
| `prep.py` | Builds `handoff/data/bt/texts.parquet` (pool with labels, plus pick titles). |
| `embed.py` | Embeds title+abstract (`ta`), venue+title+abstract (`vta`) and title (`t`) with one model. |
| `strategies.py` | Alternative scorers (SVM, MLP, boosting, kNN, two-stage) on the same embeddings. |
| `backtest.py` | Rolling evaluation of every scorer; writes `handoff/data/bt/results/<model>.csv`. |
| `summary.py` | Prints the comparison tables. |
