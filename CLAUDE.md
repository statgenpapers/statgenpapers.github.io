# StatGen Papers

Read `README.md` and `docs/PLAN.md` before changing anything.

## Hard constraints

1. Never commit `handoff/`, the lab Sheet ID, lab pick lists, or any secret. Only fitted weights
   and aggregate backtest numbers are public.
2. Cancel Slurm jobs only by explicit job ID.
3. Push workflow files over SSH; the local `gh` token lacks the `workflow` scope.
4. Publish a change to `firebase/firestore.rules` with `cd firebase && npx firebase deploy --only firestore:rules
   --project statgenpapers` (the owner's CLI login), only after `npm test` and `dev/site_check.py --emulator` pass.
5. Do not mark or add papers on the live site from fresh browser profiles in a loop: a profile's
   first write creates an anonymous Firebase user, and Firebase refuses sign-ups from an IP address
   after about 100 an hour. Reading creates none. `dev/site_check.py` reuses two saved profiles for this reason.

## Terminology

- *Pool:* all candidates fetched for one month from the configured sources, after the junk filter and dedupe (about 2,000).
- *Pick:* a paper the lab listed in its monthly reading list. The positive label for training and backtests; private.
- *Shortlist:* the top 25 of a month's pool by score; what the site lists.
- *Venue:* the internal key of a journal (`NG`) or of a preprint `Server:category` (`Biorxiv:genetics`). One indicator feature each; never shown.
- *Journal:* the official title abbreviation shown in the table and in short names (`Nat Genet`, `Am J Hum Genet`, `bioRxiv`).
- *Lab weights:* `model/weights.json`, the logistic-regression weights fitted to picks.
- *Vote correction:* the adjustment Δ to the lab weights fitted to upvotes. Final score = lab score + Δ·x.
- *Table:* the four columns `Journal`, `Short Name`, `Title`, `URL`, as in the lab Sheet.
- *Short name:* the label `Journal_FirstAuthor_Year_Keyword`, generated for every paper.
- *Submission:* a paper a visitor added on the site (`months/YYYY-MM/submissions` in Firestore).
- *Handle:* a visitor's login name, without a password. Votes are keyed by the lower-case handle.
- *Mark:* a reader's "interested" on a paper, shown as ▲ and a count. Stored as a vote document; the site says mark, the code and data say vote.
- *Pick chance:* shown on the site as "Score"; the calibrated probability that the lab picks a paper, `sigmoid(a + b·score)`, with `a` and `b` stored in the lab weights.
