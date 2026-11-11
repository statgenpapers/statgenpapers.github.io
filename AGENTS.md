# StatGen Papers

Read `README.md` and `docs/PLAN.md` before changing anything.

## Hard constraints

1. Never commit `handoff/`, the lab Sheet ID, pick lists or secrets; only weights and aggregate backtest numbers are public.
2. Cancel Slurm jobs only by explicit job ID.
3. Push workflow files over SSH (the `gh` token lacks the `workflow` scope).
4. Publish `firebase/firestore.rules` with `cd firebase && npx firebase deploy --only firestore:rules --project statgenpapers`,
   only after `npm test` and `dev/site_check.py --emulator` pass.
5. Never write to the live site from fresh browser profiles in a loop: each creates an anonymous user, and Firebase
   refuses about 100 sign-ups an hour per IP. `dev/site_check.py` reuses two profiles.

## Terminology

- *Pool:* a month's ~2,000 candidates after the junk filter and dedupe.
- *Pick:* a paper on the lab's monthly reading list; the private positive label.
- *Shortlist:* the papers of a month's pool that the site lists.
- *Venue:* internal key of a journal (`NG`) or preprint category (`Biorxiv:genetics`); never shown.
- *Journal:* the abbreviation shown (`Nat Genet`, `bioRxiv`).
- *Lab weights:* `model/weights.json`, fitted to picks. *Vote correction:* Δ fitted to marks; score = lab + Δ·x.
- *Table:* the columns `Journal`, `Short Name`, `Title`, `URL`. *Short name:* `Journal_FirstAuthor_Year_Keyword`.
- *Submission:* a paper a reader added. *Handle:* a password-free login, lower case.
- *Mark:* a reader's "interested" (▲ and a count); stored as a vote document.
- *Pick chance:* shown as "Score": `sigmoid(a + b·score)`, the calibrated chance the lab picks a paper.
