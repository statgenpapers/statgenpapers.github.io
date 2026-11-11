# Implementation plan

For the agent that builds the project. `README.md` is the spec; this file records the
decisions already made and verified (2026-11-10) and the work that remains. Read
`handoff/HANDOFF.md` too (local only). Sections marked **Decided** are settled with the
owner; do not reopen them. Section 9 lists what is still open. Section 10 records the state
after the build of 2026-11-10 and what the owner changed during it; where it differs from an
earlier section, section 10 holds.

## 1. Hard constraints

1. **Never commit `handoff/`, the Sheet ID, lab pick lists, or any secret.** Lab picks are
   used only locally, to fit weights. Only fitted weights and aggregate backtest numbers
   are public. (Decided.)
2. The lab Sheet is read-only. Local code may read `handoff/data/sheet-picks.csv`; public
   code must contain no Sheet access at all.
3. $0 running cost, no manual monthly work.
4. Cancel Slurm jobs only by explicit job ID. The owner's session and other projects run
   under the same accounts.
5. The local `gh` token lacks the `workflow` scope: push workflow files over SSH.

## 2. What already exists

| Path | State |
|---|---|
| `firebase/firestore.rules` | Handle votes, one document per upvote (2026-11-10). 27 emulator tests pass (`cd firebase && npm install && npm test`); `dev/site_check.py --emulator` passes 18/18. Published 2026-11-10 with the Firebase CLI; `live-check.mjs` 17/17 and `dev/site_check.py` 18/18 pass live. |
| `firebase/live-check.mjs` | End-to-end check against the live project, for handle votes; 17/17 pass (`node firebase/live-check.mjs`). |
| `site/config.js` | Live Firebase web config (public by design). |
| `dev/backtest/` | Backtest harness and README. Results in `handoff/data/bt/results/`. |
| `.github/workflows/monthly.yml` | Monthly run, manual run, and deploy (section 6). Replaced `pages.yml`. |
| Firebase project `statgenpapers` | Spark plan, Anonymous sign-in on (auto clean-up off), Firestore in production mode, `statgenpapers.github.io` authorized. |
| Actions secret `OPENALEX_API_KEY` | Set. |

Delete the empty `backtest/` directory once no `embed` Slurm jobs remain.

## 3. Scorer (Decided)

**Model:** `minishlab/potion-base-32M` (static embedding, 512 dimensions), revision
`1e5a03f8eeb2c98b928fbbd846f22f816360919f`, loaded with `model2vec` (numpy only, no torch).
It embeds about 1,800 abstracts per second on one CPU core (4,200 on four), so a month takes seconds on the runner.

**Features:** L2-normalized embedding of `title + "\n" + abstract`, concatenated with a
one-hot venue indicator (each journal; each preprint server:category). Venue is an input to
the classifier only; it is never part of the embedded text.

**Classifier:** `LogisticRegression(C=1, class_weight="balanced")`. The score is the
decision function. No regex scope prefilter: rank the whole pool and take the top 25.

### Backtest evidence

Leak-free rolling backtest, full pool of about 2,100 papers a month, March–October 2026
(210 picks; 200 top-25 slots). Protocol in `dev/backtest/README.md`.

| Scorer | Mean AUC | Picks in top 25 (of 210) |
|---|---|---|
| potion-32M + venue one-hot (**chosen**) | 0.963 | 90 |
| MiniLM-L6 + venue one-hot | 0.965 | 87 |
| static-retrieval-mrl + venue one-hot | 0.962 | 86 |
| TF-IDF words + venue one-hot (not an embedding) | 0.960 | 87 |
| potion-32M, text only | 0.931 | 45 |
| potion-32M, similarity to centroid of picks | 0.847 | 33 |
| Venue only | 0.851 | 36 |

Against the Claude Haiku baseline, on Haiku's own papers and labels (regex shortlist):

| | AUC Aug / Sep / Oct | Top-25 Aug / Sep / Oct | Total |
|---|---|---|---|
| Haiku (prompt v7) | 0.870 / 0.893 / 0.882 | 13 / 17 / 13 | 43 |
| potion-32M + venue one-hot | 0.783 / 0.815 / 0.911 | 11 / 15 / 12 | 38 |

Findings to state honestly on the About page:

1. The embedding scorer is close to Haiku but below it: 38 against 43 top-25 picks, and
   lower AUC in two of three months.
2. Venue carries about half the signal. Text alone finds half as many picks.
3. Seed-similarity scoring is clearly worse than a classifier.
4. A smoothed venue pick-rate prior (one coefficient) was worse than the one-hot (57–62
   against 74–78 dev top-25 hits); a three-times-stronger one-hot made no difference.
5. Weights frozen after May 2026 did as well on June–October as weights retrained every
   month (58 against 59 top-25 hits of 132 picks). Frozen weights are therefore safe.
6. Ranking the full pool finds as many picks as ranking the regex shortlist, so the regex
   filter is dropped.
7. Alternative scorers on the same embeddings (`dev/backtest/strategies.py`: RBF and linear
   SVM, MLP, gradient boosting, kNN features, two-stage text-then-venue, recency weighting,
   separate title embedding, other penalties) did not beat logistic regression consistently:
   most land within six top-25 hits of it out of 191, and the best on one embedding is
   mid-table on the other. Venue written into the embedded text was worse than the indicator.
8. Larger transformer embeddings (PubMedBERT, bge-base, SciNCL, MedCPT, …) find up to 6 more
   of 210 picks, none more on the held-out month, at about 1/1,000 of potion's speed; potion
   stays. Table and speeds in `dev/LOG.md` (2026-11-10).

### Weights file

`dev/train.py` (to write; local only) fits the classifier on all 12 pool months with all
picks and writes `model/weights.json`:

```json
{"model": "minishlab/potion-base-32M", "revision": "1e5a03f…", "text": "title\nabstract",
 "bias": 0.0, "embedding": [512 floats], "venue": {"NG": 0.0, "Preprint": 0.0},
 "trained": "2026-11-10", "train_months": ["2025-11", "…", "2026-10"]}
```

A venue missing from the file gets weight 0. Commit this file; it reveals taste, not the
pick list (owner approved).

### Learning from votes

Each monthly run, before scoring:

1. Read all votes with an unauthenticated REST call
   (`https://firestore.googleapis.com/v1/projects/statgenpapers/databases/(default)/documents/months/{m}/papers`, verified to work)
   and commit a snapshot to `data/votes/YYYY-MM.json` (uids hashed, names dropped).
2. Label each voted paper by net votes: positive if above 0, negative if below 0.
3. If at least 30 papers are labelled, fit a correction `Δ` by logistic regression with the
   lab score as a fixed offset and an L2 penalty on `Δ`, so that with few votes the scorer
   stays at the lab weights. Final score = lab score + `Δ·x`.
4. Re-embed the voted papers on the fly from `site/data/*.json`; no embedding store is needed.

Write a unit test showing `Δ = 0` with no votes and that a consistent vote pattern moves scores.

## 4. Pipeline (`pipeline/`, one `uv` project)

Entry point: `uv run python -m pipeline --month YYYY-MM` (default: previous calendar month).

1. **Config, no code edits needed:** `config/sources.toml` holds journals (name, ISSN),
   preprint servers and categories, junk-title patterns, and `shortlist_size = 25`.
   Start from the lists in `handoff/reference-pipeline/candidates.py`.
2. **Fetch:** port `candidates.py` (OpenAlex cursor paging by ISSN with the key, bioRxiv/medRxiv
   `details` API keeping the latest version, PubMed abstract fill, `JUNK_TITLE`, `NEWS_DOI`,
   retries, empty-source warnings). Keep the spend printout and `OPENALEX_MAX_USD` cap.
   Drop the SQLite store, the keyless fallback, the regex scope filter and every Sheet function.
   Also capture the full author list for display.
3. **Dedupe:** within a month, merge a preprint with its published version by normalized
   title and keep the published one. Across months, drop DOIs already listed in
   `site/data/*.json`; a newly published version of an earlier preprint may be listed again.
4. **Score** with `model/weights.json` plus the vote correction; keep the top 25.
5. **Write** `site/data/YYYY-MM.json` (id, doi, url, title, authors, venue, date, type
   published/preprint, abstract, score, rank) and update `site/data/index.json` (list of months).
   Paper id = DOI with every character outside `[A-Za-z0-9._-]` replaced by `_` (the
   Firestore rules require this alphabet).
6. **Tests:** pytest for dedupe, id mapping, scoring from a weights file, and the vote correction.

## 5. Site (`site/`, static, no build step)

1. `index.html`, `app.js`, `style.css`, `about.html`. Firebase JS SDK v11 as ES modules from
   `https://www.gstatic.com/firebasejs/`.
2. On load: `signInAnonymously`, fetch `data/index.json` and the selected month, then
   `onSnapshot` on `months/{month}/papers`. Count votes client-side from each document's
   `votes` map; re-sort on every snapshot.
3. Vote writes (the only shapes the rules accept):
   - first vote on a paper: `setDoc(ref, {votes: {[uid]: {v, name?}}}, {merge: true})`;
   - change: `updateDoc(ref, {["votes." + uid]: {v, name?}})`;
   - remove: `updateDoc(ref, {["votes." + uid]: deleteField()})`.
4. Features: month picker, sort by votes (ties by score) or by score, filter
   all/published/preprint, abstract on click, optional name kept in `localStorage`,
   own vote highlighted, animated re-order, responsive layout, no login prompt anywhere.
5. `about.html`: what the site is, how papers are collected and scored, the backtest tables
   of section 3 with their caveats, and a pointer to `dev/backtest/`. Numbers come from
   `site/data/backtest.json`, written by `dev/backtest/summary.py` (extend it to export).

## 6. Automation (built as proposed)

One workflow `monthly.yml` replacing `pages.yml`:

1. Triggers: `schedule` (3rd of each month, for the previous month), `workflow_dispatch`
   with an optional `month` input, and `push` to `site/**`.
2. Job: checkout, `uv sync`, run the pipeline (skipped on plain pushes), commit
   `site/data/` and `data/votes/`, then upload and deploy Pages **in the same workflow**.
   A commit made with `GITHUB_TOKEN` does not trigger other workflows.
3. `permissions: contents: write, pages: write, id-token: write` (the repo default is read).
4. The monthly commit also keeps the schedule alive; GitHub disables schedules after 60
   days without repository activity.

## 7. Documentation

Rewrite `README.md` as the deliverable the spec asks for (setup incl. the Firebase steps
already done, how to change sources, how to trigger a run, how to retrain weights locally).
The spec's "how to add seed papers" becomes "how to retrain the weights"; the owner
dropped the public seeds file. Keep the spec as `docs/spec.md`. Record project terms in a
`AGENTS.md` Terminology section (pool, pick, shortlist, venue, lab weights, vote correction).

## 8. Acceptance checks

1. `uv run python -m pipeline --month 2026-10` yields 25 papers; the site shows them.
2. `node firebase/live-check.mjs` passes; a vote in one browser re-orders a second within seconds.
3. `npm test` in `firebase/` and `pytest` pass.
4. A manual `workflow_dispatch` run for a past month succeeds and deploys.
5. `git log -p` contains nothing from `handoff/` and no key other than the Firebase web config.

## 9. Open

Build order agreed with the owner: site and pipeline first with the scorer of section 3;
revisit the model when the remaining backtests are in.

1. Workflow shape (section 6): built as proposed when the owner asked for sections 3 to 8.
2. Backtest of the larger models (section 3, finding 8). Embeddings land in
   `handoff/data/bt/emb/<key>.{ta,vta,t}.npy` (Slurm jobs 59240570–59240578, IDs in
   `handoff/data/bt/jobids.txt`). Run `backtest.py <key>` and `strategies.py <key>` on each
   and update the tables; switch model only for a clear gain, since the owner prioritizes speed.
3. One stale test vote sits at `months/2020-01/papers/_selftest`; harmless, deletable in the console.

## 10. Built (2026-11-10)

Sections 3 to 8 are built as written, with the owner's changes below. Acceptance results are in
the commit that added this section.

### Changes the owner asked for during the build

1. **Table.** Every list is also the lab Sheet's four columns, `Journal`, `Short Name`, `Title`,
   `URL`: `site/data/YYYY-MM.tsv`, the site's columns, and its "Copy table" button. Short names
   (`Journal_FirstAuthor_Year_Keyword`) are generated.
2. **Submissions.** Visitors add a paper by typing journal, title and URL. It is stored in
   `months/{m}/submissions/{id}` under a new block of `firebase/firestore.rules` (create and
   delete by the submitter only). The monthly run snapshots submissions with the votes and does
   not list a DOI that was submitted to another month.
3. **Upvotes only.** The site has no downvote. This changes "Learning from votes" in section 3:
   the training rows are the listed papers of every month that got votes, a paper with an
   upvote is a positive and the other listed papers are negatives, and the fit has a free
   intercept next to the fixed lab-score offset. The correction starts at 30 upvoted papers
   (`min_upvoted`). Not yet confirmed by the owner; see open item 4.
4. **Look.** Arial, one upvote button per paper, authors as first two … last two, the journal
   only in its own column.
5. **No sort or filter controls, no published/preprint label.** The list is always ordered by
   votes, equal votes by score. The Journal column shows official title abbreviations
   (`Nat Genet`, `Am J Hum Genet`, `bioRxiv`); short names start with them (`NatGenet_…`).

### Details worth knowing

1. `model2vec` takes no revision, so `pipeline/score.py` downloads the pinned revision with
   `huggingface_hub` and loads it from disk. `encode(..., max_length=None)` reproduces the
   backtest embeddings (cosine at least 0.9998); the default truncation at 512 tokens does not.
2. Text is embedded as fetched, with only entities, inline tags and whitespace cleaned. Removing
   the "Abstract" heading that OpenAlex keeps cost 2 of the 90 top-25 hits, so the heading stays
   in the data and the site hides it.
3. Papers without an abstract stay in the pool: 50 of the 330 picks have none.
4. The weights were fitted on all twelve months, so the lists for months up to 2026-10 are
   in-sample. The About page says so.
5. Vote snapshots are `data/votes/YYYY-MM.json`, one per listed month, rewritten each run.
6. The workflow is built as section 6 proposes. `astral-sh/setup-uv` has no moving major tag, so
   it is pinned to a full version.
7. The site opens its Firestore listeners without signing in (marks are public), signs in
   anonymously on the first write, and uses long-polling
   (`experimentalForceLongPolling`). With the SDK default, 2 of 90 page loads in a two-browser
   test showed the other browser's vote more than 25 s late, although the server had it within
   a second; with long-polling, 0 of 60 (median 0.5 s).
8. Firebase refuses new anonymous sign-ups from one IP address after about 100 an hour
   (`auth/too-many-requests`). Tests that open fresh browser profiles hit this;
   `dev/site_check.py` therefore reuses two saved profiles on a fixed port. When a sign-in is
   refused, the site stays readable and live, and says that voting is unavailable.

### Open

1. Section 9, item 2: backtests of the larger models.
2. Section 9, item 3: the stale test document.
3. Submissions feed dedupe but not learning. A submission is a strong signal that the scorer
   missed a paper; it has a title but no abstract.
4. The upvote-only learning rule above, and its penalty (`penalty = 1.0`), have no data behind
   them yet. Revisit when the first few hundred votes exist.
5. Anyone can add a paper, so spam is possible. The rules limit field sizes and URL schemes;
   removal is by hand in the Firebase console.
