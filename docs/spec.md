# StatGen Papers

## Purpose

A public website that publishes a monthly shortlist of statistical genetics papers. Users can vote on the papers, and the ranking updates live.

## Site and hosting

- The site is served at **<https://statgenpapers.github.io>**.
- The GitHub organization `statgenpapers` already exists. The code lives in a public repository under that organization.
- Running costs must be **$0**, using only free tiers. No paid services and no credit card on file.
- Maintenance should be low: after setup, the site should run on its own with no monthly manual work.

## Paper collection

- Each month, collect candidate papers from:
  - papers published that month in relevant journals, and
  - preprints posted that month on **bioRxiv** and **medRxiv**.
- Expect a candidate pool of roughly **500 papers** per month.
- Remove duplicates, for example a preprint that also appears as a published paper.
- Which journals, categories and topic filters to use should be easy to change without editing code.

## Scoring and shortlisting

- Score every candidate and shortlist the top **20–30** papers.
- Score with **text embeddings only**. The exact method is up to the implementer, for example similarity to seed papers or a classifier trained on embeddings. (Such scorer should be light and fast). One approach maybe PubMedBERT?
- The group provides a **seed list of papers it likes**, as DOIs and/or PMIDs, that defines what's relevant. Adding seeds should be easy.
- **Preferred:** over time, the scorer learns from the group's past votes.

## Schedule

- A new list is generated automatically **once a month**.
- It must also be possible to trigger a run by hand for any given month.
- Past months easily available.

## Website features

- Shows the current month's shortlist, with a way to browse past months.
- Each paper shows its title (linked to the paper), authors, journal or preprint server, date, and whether it's published or a preprint. The abstract is available on demand.
- Visitors can **upvote and downvote** papers.
  - **No account or sign-up of any kind.**
  - Entering a name is **optional**.
  - Each person gets one vote per paper, and can change or remove it. Basic protection against casual repeat voting or tampering with counts is enough; this is a group tool, not a public poll.
- **Real-time updates:** when anyone votes, everyone viewing the page sees the new count, and the list **re-orders live** without a refresh.
- The list can be sorted by votes or by the model's score, and filtered to published papers or preprints only.
- Works well on desktop and mobile.

## Deliverables

- A working site at statgenpapers.github.io.
- Automated monthly generation of the list.
- A short README describing:
  - one-time setup steps, including any accounts or keys the owner must create;
  - how to add seed papers;
  - how to change the journal and preprint sources;
  - how to trigger a run by hand.

## Acceptance criteria

- A manual run for a past month produces a 20–30 paper list that appears on the site.
- A vote in one browser shows up, with the list re-ordered, in a second browser within a few seconds.
- No login prompt appears anywhere.
- The monthly cost is $0.

## Notes from earlier exploration (non-binding)

- Free options looked at:
  - GitHub Pages for hosting, and GitHub Actions for the monthly job. Both are free for public repos on standard runners.
  - Firebase Firestore (Spark plan) with anonymous auth for live votes.
  - Supabase also works, but free projects pause after 7 days of inactivity.
