"""Build the monthly shortlists: python -m monthly [--month YYYY-MM].

Without --month: every month after the latest list through the previous calendar month, oldest first. That is one
month, or none if it is listed already, unless a run was missed: the workflow runs on the 10th to the 14th."""
import argparse
import calendar
import json
import re
import sys
import tomllib
from dataclasses import asdict
from datetime import date, timedelta

import numpy as np

from . import ROOT
from .dedupe import dedupe
from .fetch import fetch_pool, full_authors, url_doi
from .firestore import FIELDS, read_counts, read_submissions
from .output import paper_id, short_name
from .score import embed, linear, load_model, probability
from .train import POOLS, fit, index, marked_keys, month_at, save_pool

DATA, MODEL, COUNTS = ROOT / "site" / "data", ROOT / "data" / "model.json", ROOT / "data" / "counts.json"


def write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=1, ensure_ascii=False, sort_keys=True) + "\n")


def added_papers(submissions):
    """{submission id: paper} of a month's added papers, as the site shows them once the month is listed."""
    return {sid: {k: s[k] for k in FIELDS if s.get(k)} for sid, s in submissions.items()}


# A preprint is a preprint, by the journal typed or by its link: as PREPRINT in site/app.js
PREPRINT = re.compile(r"(bio|med|chem|psy|eco|soc)rxiv|arxiv|zenodo|preprint|research ?square|ssrn|osf\.io|authorea|qeios"
                      r"|10\.1101/|10\.64898/|10\.5281/", re.I)


def added_venue(cfg, s):
    """An added paper's venue key: Preprint, or the journal typed, by its abbreviation or full name; "" if unknown."""
    if PREPRINT.search(s["journal"]) or PREPRINT.search(s["url"]):
        return "Preprint"
    return {name.lower(): j["key"] for j in cfg["journals"] for name in (j["abbr"], j["name"])}.get(s["journal"].strip().lower(), "")


def score_added(weights, model, cfg, submissions):
    """{submission id: pick chance} of added papers, scored as pool papers are."""
    if not submissions:
        return {}
    subs = list(submissions.values())
    emb = embed(model, [s["title"] for s in subs], [s["abstract"] for s in subs])
    venues = [added_venue(cfg, s) for s in subs]
    score = linear(weights, emb, venues)
    return {sid: round(float(p), 3) for sid, p in zip(submissions, probability(weights, score))}


def months_to_build(listed, today):
    """The months after the latest list through the previous calendar month, oldest first."""
    last = (today.replace(day=1) - timedelta(days=1)).strftime("%Y-%m")
    if not listed:
        return [last]
    return [month_at(i) for i in range(index(max(listed)) + 1, index(last) + 1)]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--month", help="one month, YYYY-MM, even if listed already (a rerun replaces its list)")
    month = ap.parse_args().month
    if month and not re.fullmatch(r"20\d\d-(0[1-9]|1[0-2])", month):
        ap.error("--month must look like 2026-10")
    months = [month] if month else months_to_build([p.stem for p in DATA.glob("20??-??.json")], date.today())
    if not months:
        print("every month through the previous one is listed: nothing to build")
    for m in months:
        build(m)


def build(month):
    year, mon = map(int, month.split("-"))
    last = date(year, mon, calendar.monthrange(year, mon)[1])
    start, end = date(year, mon, 1), min(last, date.today())
    if start > end:
        sys.exit(f"{month} has not started")
    cfg = tomllib.loads((ROOT / "sources.toml").read_text())
    weights = json.loads(MODEL.read_text())  # last month's model: its embedding model and calibration are kept
    listed = {p.stem: json.loads(p.read_text())["papers"] for p in sorted(DATA.glob("20??-??.json"))}

    # Interest and added papers of every month with a list or a stored pool, and of the month in progress: the
    # model's labels. The counts are kept in data/counts.json too.
    project, counts, added = cfg["firestore_project"], {}, {}
    for m in sorted(listed.keys() | {p.stem for p in POOLS.glob("20??-??.npz")} | {month}):
        counts[m], added[m] = read_counts(project, m), read_submissions(project, m)
    snapshot = {m: c for m, c in (json.loads(COUNTS.read_text()) if COUNTS.exists() else {}).items() if m not in counts}
    snapshot |= {m: {pid: n for pid, n in c.items() if n > 0} for m, c in counts.items()}
    write_json(COUNTS, {m: c for m, c in snapshot.items() if c})
    submitted = {url_doi(s["url"]) for subs in added.values() for s in subs.values()} - {""}
    keys = marked_keys(listed, counts, added)
    print(f"{len(counts)} months: {sum(n > 0 for c in counts.values() for n in c.values())} marked papers, "
          f"{len(submitted)} submitted DOIs", flush=True)

    print(f"pool: {start} to {end}", flush=True)
    pool = fetch_pool(cfg, start.isoformat(), end.isoformat(), complete=end == last)
    # Added papers stay in the pool, the model's training data, and are left off the list below: they show as added papers
    papers = dedupe(pool, {p["doi"] for m, ps in listed.items() if m != month for p in ps})
    papers.sort(key=lambda p: p.doi)
    print(f"dedupe: {len(pool)} -> {len(papers)}", flush=True)
    if not papers:
        sys.exit("the pool is empty; nothing written")

    # The model of this month: refitted on the pools of the 12 months before it
    model = load_model(weights)
    marked = {m: [(url_doi(s["url"]), s["title"], s) for sid, s in subs.items() if counts[m].get(sid, 0) > 0] for m, subs in added.items()}
    marked = {m: [(doi, title, e) for (doi, title, _), e in zip(ps, embed(model, [s["title"] for *_, s in ps], [s["abstract"] for *_, s in ps]))]
              for m, ps in marked.items() if ps}
    names = {j["key"] for j in cfg["journals"]} | {"Preprint"}
    if refit := fit(month, names, keys, marked, base=weights):
        weights = refit
        if not listed or month >= max(listed):  # a rerun of a past month leaves the current model as it is
            write_json(MODEL, weights)
        print(f"model refitted on {weights['train_months'][0]} to {weights['train_months'][-1]}: "
              f"{weights['marked']} marked of {weights['papers']} papers", flush=True)
    emb, venues = embed(model, [p.title for p in papers], [p.abstract for p in papers]), [p.venue for p in papers]
    score = linear(weights, emb, venues)
    # the calibration's data: scores out of sample (this month's interest comes later), so only from a model refitted for it
    save_pool(month, model, [p.doi for p in papers], [p.title for p in papers], [p.abstract for p in papers], venues, emb,
              score if refit else np.full(len(papers), np.nan))
    shown = np.array([p.doi not in submitted for p in papers])  # an added paper is listed as one, not twice
    order = np.argsort(-np.where(shown, score, -np.inf), kind="stable")
    top = order[:int(((probability(weights, score) >= cfg["min_pick_chance"]) & shown).sum())]

    shortlist = [full_authors(papers[i]) for i in top]
    out = [{k: v for k, v in asdict(p).items() if k != "published_doi"}
           | {"id": paper_id(p.doi), "short_name": short_name(p), "score": round(float(score[i]), 3),
              "p_pick": round(float(probability(weights, score[i])), 3)}
           for i, p in zip(top, shortlist)]
    # Added papers get a Score too: this month's all afresh, an earlier month's those it has no score for yet
    for m in sorted(m for m in added if m < month and m in listed):
        data = json.loads((DATA / f"{m}.json").read_text())
        new = score_added(weights, model, cfg, {sid: s for sid, s in added[m].items() if sid not in data.get("added", {})})
        write_json(DATA / f"{m}.json", data | {"added": data.get("added", {}) | new, "added_papers": added_papers(added[m])})
    write_json(DATA / f"{month}.json", {"month": month, "generated": date.today().isoformat(), "pool": len(papers),
                                         "papers": out, "added": score_added(weights, model, cfg, added.get(month, {})),
                                         "added_papers": added_papers(added.get(month, {}))})
    write_json(DATA / "index.json", {"months": sorted(listed.keys() | {month})})
    print(f"\n{month} shortlist: {len(out)} papers" + (f", scores {out[-1]['score']} to {out[0]['score']}" if out else ""), flush=True)
    for p in out:
        print(f"  {p['p_pick']:.0%}  {p['journal']}  {p['title']}")


if __name__ == "__main__":
    main()
