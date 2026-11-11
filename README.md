# StatGen Papers

<https://statgenpapers.github.io> lists about 25 new statistical genetics papers each month, ranked by a
model trained on a lab's reading list. Readers mark papers they are interested in and add papers the model
missed. It costs $0 and needs no monthly work. Requirements: [`docs/spec.md`](docs/spec.md); design and
evidence: [`docs/PLAN.md`](docs/PLAN.md); setup: [`docs/setup.md`](docs/setup.md).

## How it works

1. **Monthly run.** On the 3rd, `.github/workflows/monthly.yml` runs `python -m pipeline`: it fetches the
   previous month's ~2,000 candidates (`config/sources.toml`), dedupes and scores them, writes the shortlist to
   `site/data/YYYY-MM.{json,tsv}`, commits and deploys `site/`.
2. **Scorer.** A `potion-base-32M` embedding of title and abstract plus the venue, through the logistic
   regression in `model/weights.json`. Once 30 listed papers have marks, the run also fits a vote correction.
   `dev/backtest/` holds the numbers on the About page.
3. **Site.** Plain HTML, CSS and JavaScript in `site/`. Marks and added papers live in Firestore
   (`months/{m}/votes/{paper}~{handle}`, `months/{m}/submissions`), checked by `firebase/firestore.rules`. A
   browser signs in anonymously on its first write, never just to read. The list shows at once in the order
   last seen, then re-sorts as marks change.

## Common tasks

1. **Run a month by hand:** `gh workflow run monthly.yml -R statgenpapers/statgenpapers.github.io -f month=2026-09`.
   Running a month again replaces its list; marks are kept.
2. **Change sources or list size:** edit `config/sources.toml` and push.
3. **Retrain** (needs the private files in `handoff/data/`, never committed):
   `uv run --group train python dev/backtest/prep.py && uv run --group train python dev/train.py`, then commit
   `model/weights.json`.
4. **Remove someone else's added paper:** delete it under `months/YYYY-MM/submissions` in the Firebase console.

## Checks

```bash
uv run pytest                                      # pipeline
cd firebase && npm test                            # security rules, in the emulator
cd firebase && npx firebase emulators:exec --only firestore,auth --project demo-statgenpapers \
  "cd .. && uv run --with playwright python dev/site_check.py --emulator"   # two browsers, against emulators
python3 -m http.server -d site 8000                # preview
```

## Layout

| Path | What |
|---|---|
| `config/sources.toml` | Sources, junk patterns, list size, vote settings |
| `pipeline/` | Monthly run: `fetch`, `dedupe`, `score`, `votes`, `output` |
| `model/weights.json` | Lab weights |
| `site/` | The website; `site/data/` has one `.json` and `.tsv` per month |
| `data/votes/` | Monthly snapshots of marks (handles hashed) |
| `firebase/` | Firestore rules, tests, live check |
| `dev/` | Local only: `train.py`, `backtest/`, `site_check.py` |
