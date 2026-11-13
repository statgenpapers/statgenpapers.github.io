# StatGenPapers

<https://statgenpapers.github.io> lists each month's statistical genetics papers with a Score of at least 30%: the
model's prediction that a paper is marked. Readers mark papers and add ones the model missed. It costs $0 and needs no
monthly work.

## How it works

1. **Monthly run.** On the 10th, `.github/workflows/monthly.yml` runs `python -m pipeline`: it fetches last month's
   ~2,000 candidates (`config/sources.toml`), refits the model, scores and writes `site/data/YYYY-MM.{json,tsv}`,
   then deploys `site/`. Added papers show with a person icon once their month is listed.
2. **Model** (`pipeline/train.py`): a `potion-base-32M` embedding of title and abstract plus the venue, through a
   logistic regression on the pools of the 12 months before the list (weight halving every 6 months; marked papers
   positive). Written to `model/weights.json`; pools are kept on the branch `training`.
3. **Site.** Plain HTML, CSS and JavaScript in `site/`. Marks and added papers live in Firestore, checked by
   `firebase/firestore.rules`; a browser signs in anonymously on its first write.

## Common tasks

1. **Run a month by hand:** `gh workflow run monthly.yml -R statgenpapers/statgenpapers.github.io -f month=2026-09`.
   A rerun replaces the list and keeps the marks.
2. **Change sources or the cutoff:** edit `config/sources.toml` and push.
3. **Remove someone else's added paper:** delete it under `months/YYYY-MM/submissions` in the Firebase console.
4. **Fill missing abstracts of added papers:** `uv run python dev/fill_abstracts.py --write`.
5. **Cold start** (done 2026-11-11, needs the private `handoff/data/`): `dev/coldstart/rollforward.py 2026-01 2026-10` built
   those months leak-free; `dev/lab_marks.py` wrote their marks as the handle `admin`
   (its Firebase user is in `~/.config/statgenpapers/lab.json`, never committed).

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
| `config/sources.toml` | Sources, junk filter, cutoff |
| `pipeline/` | Monthly run: `fetch`, `dedupe`, `train`, `score`, `votes`, `output` |
| `model/weights.json` | The latest model |
| `site/` | The website; `site/data/` has each month's list |
| `data/votes/` | Monthly snapshots of marks (handles hashed) |
| `firebase/` | Firestore rules and tests |
| `dev/` | Local only: site check, admin marks, abstracts; `coldstart/`: the finished cold start and its backtest |
