# StatGenPapers

<https://statgenpapers.github.io> lists each month's statistical genetics papers with a Score of at least 30%: the
model's estimate of the chance that a paper is of interest. Readers mark the papers they are interested in (▲) and
add papers the model missed. It costs $0 and needs no monthly work.

## How it works

1. **Monthly run.** On the 10th, `.github/workflows/monthly.yml` runs `python -m monthly`: it fetches last month's
   ~2,000 candidates (`sources.toml`), refits the model, writes `site/data/YYYY-MM.json`, `data/counts.json` and
   `data/model.json`, and deploys `site/`. Added papers show with a person icon once their month is listed. The 11th
   to 14th retry a failed run; a source with no papers stops a run instead of shipping a list without it.
2. **Model** (`monthly/train.py`): a `potion-base-32M` embedding of title and abstract plus the venue, through a
   logistic regression on the pools of the 12 months before the list (weight halving every 6 months; papers of
   interest positive). The pools are kept on the branch `training`.
3. **Site.** Plain HTML, CSS and JavaScript in `site/`. Interest and added papers live in Firestore, checked by
   `firebase/firestore.rules`; a browser signs in anonymously on its first write.

| Firestore path | Content | Read by |
|---|---|---|
| `months/YYYY-MM` | `counts`: {paper id: number of handles interested} | Anyone |
| `months/YYYY-MM/interests/{handle}` | The papers the handle is interested in and the ones it added | Its exact handle; never listed |
| `months/YYYY-MM/submissions/{id}` | An added paper: journal, title, URL, short name, authors, abstract, date; no handle | Anyone |

A write changes one paper's interest and its count together. Added papers can be changed until the 15th of the next
month. The handle `admin` holds the cold start and is frozen.

## Common tasks

1. **Run a month by hand:** `gh workflow run monthly.yml -R statgenpapers/statgenpapers.github.io -f month=2026-09`.
   A rerun replaces the list and keeps the interest.
2. **Change sources or the cutoff:** edit `sources.toml` and push.
3. **Remove an unwanted added paper:** delete it under `months/YYYY-MM/submissions` in the Firebase console.
4. **Change the rules:** edit `firebase/firestore.rules`; after the checks below pass,
   `cd firebase && npx firebase deploy --only firestore:rules --project statgenpapers`.
5. **Cold start** (done 2026-11-11): the lists of 2026-01..10 were built leak-free from private data, and their
   marks written as the handle `admin`. Its scripts are in the git history before v0.1; `dev/backtest/` keeps the
   backtest behind the About page.

## Checks

```bash
uv run pytest                                      # the monthly run
cd firebase && npm test                            # security rules, in the emulator
cd firebase && npx firebase emulators:exec --only firestore,auth --project demo-statgenpapers \
  "cd .. && uv run --with playwright python dev/site_check.py --emulator"   # two browsers, against emulators
uv run --with playwright python dev/site_check.py  # the same, live, in the unlisted months 2099-01/02
python3 -m http.server -d site 8000                # preview
```

## Setup

Done for the live site; recorded so it can be repeated.

1. **GitHub:** Settings → Pages → Source: GitHub Actions. The workflow asks for its own write permission.
2. **OpenAlex key:** the Actions secret `OPENALEX_API_KEY`; GitHub masks it in logs and withholds it from pull
   requests of forks. Rotate with `gh secret set OPENALEX_API_KEY -R statgenpapers/statgenpapers.github.io`. For
   local runs put it in `OPENALEX_API_KEY` or `~/.config/openalex/api_key` (`chmod 600`); never commit it. A month
   costs about $0.001 of the free daily budget; the run stops at `OPENALEX_MAX_USD` (default 0.5).
3. **Firebase:** project `statgenpapers`, Spark plan (free, no card). Its web configuration is in `site/app.js`,
   public by design. Authentication: Anonymous on, automatic clean-up off; authorized domain
   `statgenpapers.github.io`. Firestore in production mode, with the rules deployed as above.
4. **API key** (Google Cloud console → Credentials → Browser key): websites `https://statgenpapers.github.io/*` and
   `http://127.0.0.1:8731/*` (the site check) only, so logging in fails elsewhere, such as in the preview.

## Layout

| Path | What |
|---|---|
| `sources.toml` | Sources, junk filter, cutoff |
| `monthly/` | Monthly run: `fetch`, `dedupe`, `train`, `score`, `firestore`, `output` |
| `data/` | `model.json`, the latest model; `counts.json`, each month's interest counts at the last run |
| `site/` | The website; `site/data/` has each month's list |
| `firebase/` | Firestore rules and their tests |
| `dev/` | Local only: `site_check.py`; `backtest/`, the numbers on the About page |
| `tests/` | Pipeline tests |

## License

The code is under the MIT license (`LICENSE`). The papers' titles, authors and abstracts in `site/data/` remain their
publishers' and authors'.
