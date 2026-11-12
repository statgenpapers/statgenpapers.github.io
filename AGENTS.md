# StatGen Papers

Read `README.md` and `docs/PLAN.md` before changing anything.

## Hard constraints

1. Never commit `handoff/`, the Sheet ID or secrets. The cold-start marks are public only as marks and added papers of
   the handle `admin` on the site (the owner agreed, 2026-11-11), never as a file.
2. Cancel Slurm jobs only by explicit job ID.
3. Push workflow files over SSH (the `gh` token lacks the `workflow` scope).
4. Publish `firebase/firestore.rules` with `cd firebase && npx firebase deploy --only firestore:rules --project statgenpapers`,
   only after `npm test` and `dev/site_check.py --emulator` pass.
5. Never write to the live site from fresh browser profiles in a loop: each creates an anonymous user, and Firebase
   refuses about 100 sign-ups an hour per IP. `dev/site_check.py` reuses two profiles.

## Owner's preferences

1. Small UI details (size, spacing, motion): pick the best-practice option yourself; show a screenshot of visible changes.
2. After tests pass, commit, push and watch the Pages deploy for each change; the owner reviews the live site.
3. The site never shows a handle to other readers; only counts.
4. Handles are trusted: no password, and nobody is assumed to log in as another's handle. A handle may take back
   its marks, and remove the papers it added until the monthly run lists them (the rules cannot check a handle,
   so any signed-in browser may; the site offers it to the handle only).
5. A preprint is a preprint: bioRxiv, medRxiv, Zenodo and other servers are one kind of source, not different venues.
6. Short, plain text everywhere: About is an FAQ; docs stay brief.

## Terminology

- *Pool:* a month's ~2,000 candidates after the junk filter and dedupe.
- *Cold start:* the marks of 2025-11 to 2026-10, the first months the model learns from; on the site as marks of `admin`, which
  only `dev/lab_marks.py` writes (the login refuses it). The site and docs have no concept of a lab or picks.
- *Shortlist:* the papers of a month's pool that the site lists.
- *Venue:* internal key of a journal (`NG`) or `Preprint` for every preprint; never shown.
- *Journal:* the abbreviation shown (`Nat Genet`, `bioRxiv`).
- *Model:* refitted by each monthly run (`pipeline/train.py`) on the pools of the 12 months before the list, weight
  halving every 6 months; marked papers are positives, all other pool papers negatives (as if readers read the whole
  pool). Written to `model/weights.json`, with the calibration (a, b), refitted on the stored out-of-sample scores.
  There is no vote correction.
- *Training branch:* `training`, the stored pools (int8 embeddings, no abstracts) of the last 12 months, one commit.
- *Table:* the columns `Journal`, `Short Name`, `Title`, `URL`. *Short name:* `Journal_FirstAuthor_Year_Keyword`.
- *Submission:* a paper a reader added. *Handle:* a password-free login, lower case.
- *Mark:* a reader's "interested" (▲ and a count); stored as a vote document.
- *Score:* shown in the list: `sigmoid(a + b·score)`, the model's calibrated prediction that a paper gets marked.
