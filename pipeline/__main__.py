"""Build one month's shortlist: python -m pipeline [--month YYYY-MM] (default: the previous calendar month)."""
import argparse
import hashlib
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


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--month", default=(date.today().replace(day=1) - timedelta(days=1)).strftime("%Y-%m"))
    ap.add_argument("--weights", default=str(ROOT / "model" / "weights.json"), help="lab weights to score with (dev/rollforward.py passes each month's)")
    ap.add_argument("--pool-out", help="also write the deduped pool here as JSON lines, in the format dev/backtest/prep.py reads")
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
    lab = hashlib.sha256(cfg["votes"]["lab_handle"].encode()).hexdigest()[:16]  # as read_votes hashes it
    listed = {p.stem: json.loads(p.read_text())["papers"] for p in sorted(DATA.glob("20??-??.json"))}

    # Votes and submitted papers of every listed month: snapshot them. The listed papers of
    # the months that got votes are the training rows of the vote correction.
    project, rated, upvoted, submitted = cfg["votes"]["firestore_project"], [], [], set()
    for m, papers in listed.items():
        votes, submissions = read_votes(project, m), read_submissions(project, m)
        write_json(VOTES / f"{m}.json", {"month": m, "votes": votes, "submissions": submissions})
        submitted |= {url_doi(s["url"]) for s in submissions.values()} - {""}
        ups = [any(h != lab for h in votes.get(p["id"], {})) for p in papers]  # readers' marks; the lab's are in the weights
        if any(ups):
            rated += papers
            upvoted += ups
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
            # the lab's journal keys; a preprint's server and category come from its venue name, "bioRxiv · genetics"
            "journal": p.venue_name.split(" · ")[0].capitalize() if p.venue == "Preprint" else p.venue,
            "category": p.venue_name.partition(" · ")[2] if p.venue == "Preprint" else "article", "doi": p.doi,
            "url": p.url, "title": p.title, "date": p.date, "abstract": p.abstract}) + "\n" for p in papers))

    model = load_model(weights)
    emb, venues = embed(model, [p.title for p in papers], [p.abstract for p in papers]), [p.venue for p in papers]
    lab_score = linear(weights, emb, venues)
    rated_emb, rated_venues = embed(model, [p["title"] for p in rated], [p["abstract"] for p in rated]), [p["venue"] for p in rated]
    delta = vote_correction(rated_emb, rated_venues, np.array(upvoted, bool), linear(weights, rated_emb, rated_venues),
                            cfg["votes"]["penalty"], cfg["votes"]["min_upvoted"])
    score = lab_score + linear(delta, emb, venues)
    order = np.argsort(-score, kind="stable")
    top = order[:int((probability(weights, score) >= cfg["min_pick_chance"]).sum())]
    corrected = bool(np.any(delta["embedding"]))
    if corrected:
        kept = len(set(top) & set(np.argsort(-lab_score, kind="stable")[:len(top)]))
        print(f"vote correction from {sum(upvoted)} upvoted papers: {kept}/{len(top)} of the lab-weights shortlist kept", flush=True)

    shortlist = [full_authors(papers[i]) for i in top]
    out = [{k: v for k, v in asdict(p).items() if k != "published_doi"}
           | {"id": paper_id(p.doi), "short_name": short_name(p), "score": round(float(score[i]), 3),
              "p_pick": round(float(probability(weights, score[i])), 3), "rank": rank}
           for rank, (i, p) in enumerate(zip(top, shortlist), 1)]
    write_json(DATA / f"{month}.json", {"month": month, "generated": date.today().isoformat(), "pool": len(papers),
                                         "upvoted_papers_used": sum(upvoted) if corrected else 0, "papers": out})
    write_json(DATA / "index.json", {"months": sorted(listed.keys() | {month})})
    table = "\n".join("\t".join(row) for row in [TABLE_HEADER] + [table_row(p) for p in shortlist]) + "\n"
    (DATA / f"{month}.tsv").write_text(table)
    print(f"\nshortlist ({len(out)} papers, scores {out[-1]['score']} to {out[0]['score']}):\n{table}", end="")


if __name__ == "__main__":
    main()
