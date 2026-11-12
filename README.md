# StatGen Papers

<https://statgenpapers.github.io> lists each month's statistical genetics papers with a Score of at least
25%: the model's prediction of how likely a paper is to be marked. Readers mark papers they are interested in and add papers the model
missed. It costs $0 and needs no monthly work. Requirements: [`docs/spec.md`](docs/spec.md); design and
evidence: [`docs/PLAN.md`](docs/PLAN.md); setup: [`docs/setup.md`](docs/setup.md).

## How it works

1. **Monthly run.** On the 10th, `.github/workflows/monthly.yml` runs `python -m pipeline`: it fetches the
   previous month's ~2,000 candidates (`config/sources.toml`), dedupes and scores them, writes the shortlist to
   `site/data/YYYY-MM.{json,tsv}`, commits and deploys `site/`. Papers readers added to that month are scored too
   and listed with a person icon beside the Score; until then they are not shown. Readers always add to the month in progress.
2. **Scorer.** A `potion-base-32M` embedding of title and abstract plus the venue, through a logistic regression
   the run fits again each month (`pipeline/train.py`): on the pools of the 12 months before the list, weight
   halving every 6 months, marked papers positive and the rest negative. It writes `model/weights.json` and the
   words that move the score most (About). The pools are kept, as int8 embeddings without abstracts, on the
   branch `training` (last 12 months, one commit). `dev/backtest/` holds the numbers on the About page.
3. **Site.** Plain HTML, CSS and JavaScript in `site/`. Marks and added papers live in Firestore
   (`months/{m}/votes/{paper}~{handle}`, `months/{m}/submissions`), checked by `firebase/firestore.rules`. A
   browser signs in anonymously on its first write, never just to read. The list shows at once in the order
   last seen, then re-sorts as marks change.

## Common tasks

1. **Run a month by hand:** `gh workflow run monthly.yml -R statgenpapers/statgenpapers.github.io -f month=2026-09`.
   Running a month again replaces its list; marks are kept.
2. **Change sources or list size:** edit `config/sources.toml` and push.
3. **Cold start (done 2026-11-11; needs the private `handoff/data/`, never committed):**
   `uv run --group train python dev/backtest/prep.py && uv run --group train python dev/train.py` fits
   `model/weights.json`; `dev/rollforward.py 2026-01 2026-10` built those months leak-free and wrote their marks as
   the handle `admin` through `dev/lab_marks.py` (`firebase/firestore.rules` reserves it for the one Firebase user in
   `~/.config/statgenpapers/lab.json`, never committed). From 2026-11 the monthly run learns from all marks.
4. **Remove someone else's added paper:** delete it under `months/YYYY-MM/submissions` in the Firebase console.
5. **An added paper without an abstract:** `uv run python dev/fill_abstracts.py --write` fills every one it can find
   (OpenAlex, PubMed, Europe PMC, the publisher's page) in place, as the owner.

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
| `config/sources.toml` | Sources, junk patterns, list size, Firestore project |
| `pipeline/` | Monthly run: `fetch`, `dedupe`, `train`, `score`, `votes`, `output` |
| `model/weights.json` | The latest month's model |
| `data/pools/` | Not on `main`: the branch `training`, checked out here by the run |
| `site/` | The website; `site/data/` has one `.json` and `.tsv` per month |
| `data/votes/` | Monthly snapshots of marks (handles hashed) |
| `firebase/` | Firestore rules, tests, live check |
| `dev/` | Local only: `train.py`, `backtest/`, `site_check.py` |
