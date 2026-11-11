"""Build one month's shortlist: python -m pipeline [--month YYYY-MM] (default: the previous calendar month)."""
import argparse
import calendar
import json
import re
import sys
import tomllib
from dataclasses import asdict
from datetime import date, timedelta
from pathlib import Path

import numpy as np

from . import ROOT
from .dedupe import dedupe
from .fetch import fetch_pool, full_authors, url_doi
from .output import TABLE_HEADER, paper_id, short_name, table_row
from .score import embed, linear, load_model, probability, vote_correction
from .votes import read_submissions, read_votes

DATA, VOTES = ROOT / "site" / "data", ROOT / "data" / "votes"


def write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=1, ensure_ascii=False, sort_keys=True) + "\n")


def score_added(weights, model, cfg, submissions, delta=None):
    """{submission id: pick chance} of added papers, scored as pool papers are; the venue from the journal shown."""
    if not submissions:
        return {}
    key = {j["abbr"]: j["key"] for j in cfg["journals"]}
    subs = list(submissions.values())
    emb = embed(model, [s["title"] for s in subs], [s["abstract"] for s in subs])
    venues = ["Preprint" if s["journal"] == "Preprint" else key.get(s["journal"], "") for s in subs]
    score = linear(weights, emb, venues) + (linear(delta, emb, venues) if delta else 0)
    return {sid: round(float(p), 3) for sid, p in zip(submissions, probability(weights, score))}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--month", default=(date.today().replace(day=1) - timedelta(days=1)).strftime("%Y-%m"))
    ap.add_argument("--weights", default=str(ROOT / "model" / "weights.json"), help="base weights to score with (dev/rollforward.py passes each month's)")
    ap.add_argument("--pool-out", help="also write the deduped pool here as JSON lines, in the format dev/backtest/prep.py reads")
    ap.add_argument("--pool-only", action="store_true", help="only fetch the pool and write --pool-out: training data for past months")
    ap.add_argument("--added-only", action="store_true", help="only score the month's added papers that have no score yet")
    args = ap.parse_args()
    month = args.month
    if not re.fullmatch(r"20\d\d-(0[1-9]|1[0-2])", month):
        ap.error("--month must look like 2026-10")
    year, mon = map(int, month.split("-"))
    start, end = date(year, mon, 1), min(date(year, mon, calendar.monthrange(year, mon)[1]), date.today())
    if start > end:
        ap.error(f"{month} has not started")
    cfg = tomllib.loads((ROOT / "config" / "sources.toml").read_text())
    weights = json.loads(Path(args.weights).read_text())
    listed = {} if args.pool_only else {p.stem: json.loads(p.read_text())["papers"] for p in sorted(DATA.glob("20??-??.json"))}
    if args.added_only:
        path, model = DATA / f"{month}.json", load_model(weights)
        data, subs = json.loads(path.read_text()), read_submissions(cfg["votes"]["firestore_project"], month)
        data["added"] = {sid: p for sid, p in data.get("added", {}).items() if sid in subs} | score_added(
            weights, model, cfg, {sid: s for sid, s in subs.items() if sid not in data.get("added", {})})
        write_json(path, data)
        return print(f"{month}: {len(data['added'])} added papers scored")

    # Votes and submitted papers of every listed month: snapshot them. The listed papers of
    # the months that got votes are the training rows of the vote correction.
    project, rated, upvoted, submitted, added = cfg["votes"]["firestore_project"], [], [], set(), {}
    for m, papers in listed.items():
        votes, submissions = read_votes(project, m), read_submissions(project, m)
        added[m] = submissions
        write_json(VOTES / f"{m}.json", {"month": m, "votes": votes, "submissions": submissions})
        submitted |= {url_doi(s["url"]) for s in submissions.values()} - {""}
        ups = [bool(votes.get(p["id"])) for p in papers]
        if any(ups):
            rated += papers
            upvoted += ups
    if month not in listed:  # the month in progress: readers add papers to it before its run
        added[month] = read_submissions(project, month)
        submitted |= {url_doi(s["url"]) for s in added[month].values()} - {""}
    print(f"{len(listed)} listed months: {sum(upvoted)} of {len(rated)} listed papers upvoted in months with votes, "
          f"{len(submitted)} submitted DOIs", flush=True)

    print(f"pool: {start} to {end}", flush=True)
    pool = fetch_pool(cfg, start.isoformat(), end.isoformat())
    papers = dedupe(pool, submitted | {p["doi"] for m, ps in listed.items() if m != month for p in ps})
    papers.sort(key=lambda p: p.doi)
    print(f"dedupe: {len(pool)} -> {len(papers)}", flush=True)
    if not papers:
        sys.exit("the pool is empty; nothing written")
    if args.pool_out:
        Path(args.pool_out).write_text("".join(json.dumps({
            # the training data's journal keys; a preprint's server and category come from its venue name, "bioRxiv · genetics"
            "journal": p.venue_name.split(" · ")[0].capitalize() if p.venue == "Preprint" else p.venue,
            "category": p.venue_name.partition(" · ")[2] if p.venue == "Preprint" else "article", "doi": p.doi,
            "url": p.url, "title": p.title, "date": p.date, "abstract": p.abstract}) + "\n" for p in papers))
    if args.pool_only:
        return

    model = load_model(weights)
    emb, venues = embed(model, [p.title for p in papers], [p.abstract for p in papers]), [p.venue for p in papers]
    base_score = linear(weights, emb, venues)
    rated_emb, rated_venues = embed(model, [p["title"] for p in rated], [p["abstract"] for p in rated]), [p["venue"] for p in rated]
    delta = vote_correction(rated_emb, rated_venues, np.array(upvoted, bool), linear(weights, rated_emb, rated_venues),
                            cfg["votes"]["penalty"], cfg["votes"]["min_upvoted"])
    score = base_score + linear(delta, emb, venues)
    order = np.argsort(-score, kind="stable")
    top = order[:int((probability(weights, score) >= cfg["min_pick_chance"]).sum())]
    corrected = bool(np.any(delta["embedding"]))
    if corrected:
        kept = len(set(top) & set(np.argsort(-base_score, kind="stable")[:len(top)]))
        print(f"vote correction from {sum(upvoted)} upvoted papers: {kept}/{len(top)} of the base-weights shortlist kept", flush=True)

    shortlist = [full_authors(papers[i]) for i in top]
    out = [{k: v for k, v in asdict(p).items() if k != "published_doi"}
           | {"id": paper_id(p.doi), "short_name": short_name(p), "score": round(float(score[i]), 3),
              "p_pick": round(float(probability(weights, score[i])), 3), "rank": rank}
           for rank, (i, p) in enumerate(zip(top, shortlist), 1)]
    # Added papers get a Score too: this month's all afresh, an earlier month's those it has no score for yet
    for m in sorted(m for m in added if m < month):
        data = json.loads((DATA / f"{m}.json").read_text())
        new = score_added(weights, model, cfg, {sid: s for sid, s in added[m].items() if sid not in data.get("added", {})}, delta)
        if new:
            write_json(DATA / f"{m}.json", data | {"added": data.get("added", {}) | new})
    write_json(DATA / f"{month}.json", {"month": month, "generated": date.today().isoformat(), "pool": len(papers),
                                         "upvoted_papers_used": sum(upvoted) if corrected else 0, "papers": out,
                                         "added": score_added(weights, model, cfg, added.get(month, {}), delta)})
    write_json(DATA / "index.json", {"months": sorted(listed.keys() | {month})})
    table = "\n".join("\t".join(row) for row in [TABLE_HEADER] + [table_row(p) for p in shortlist]) + "\n"
    (DATA / f"{month}.tsv").write_text(table)
    print(f"\nshortlist ({len(out)} papers, scores {out[-1]['score']} to {out[0]['score']}):\n{table}", end="")


if __name__ == "__main__":
    main()
