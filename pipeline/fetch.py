"""Fetch one month's pool: journals from OpenAlex, preprints from bioRxiv/medRxiv, missing abstracts from PubMed."""
import hashlib
import html
import json
import os
import re
import sys
import time
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

import requests

session = requests.Session()
session.headers["User-Agent"] = "monthly-papers/0.1"
n_requests = 0
openalex_usd = 0.0
OPENALEX_MAX_USD = float(os.environ.get("OPENALEX_MAX_USD", 0.5))  # stop a run before it spends half the keyed $1/day budget
HTTP_CACHE = os.environ.get("PIPELINE_HTTP_CACHE")  # development: directory that keeps response bodies, so reruns make no calls
INLINE_TAG = re.compile(r"</?(?:i|em|b|strong|sub|sup|sc|scp|p|br|title|sec|jats:[\w-]+)\b[^>]*>", re.I)


@dataclass
class Paper:
    doi: str
    url: str
    title: str
    authors: list[str]
    venue: str  # key of the venue weight: a journal key, or "Server:category" for preprints
    venue_name: str
    journal: str  # official title abbreviation, as shown in the Journal column
    date: str
    type: str  # "published" or "preprint"
    abstract: str
    published_doi: str = ""  # preprints: DOI of the journal version, when the server knows it


def warn(msg):
    print(f"::warning::{msg}" if os.environ.get("GITHUB_ACTIONS") else f"WARNING: {msg}", file=sys.stderr, flush=True)


def request(method, url, tries=5, **kw):
    """HTTP request with retries on network errors, 429 and 5xx; exits on failure."""
    global n_requests
    err = ""
    for attempt in range(tries):
        n_requests += 1
        try:
            r = session.request(method, url, timeout=90, **kw)
        except requests.RequestException as e:
            err = repr(e)
        else:
            if r.status_code == 200:
                return r
            err = f"HTTP {r.status_code}: {r.text[:300]}"
            if r.status_code in (400, 401, 403, 404, 414):
                break
        time.sleep(2 ** attempt)
    if key := (kw.get("params") or {}).get("api_key"):  # the failing URL is in the error text
        err = err.replace(key, "***")
    sys.exit(f"request failed: {method} {url[:120]}\n{err}")


def cached(url, params=None, data=None):
    """Body of a GET (or a POST when `data` is given), kept on disk when PIPELINE_HTTP_CACHE is set."""
    if HTTP_CACHE:
        key = json.dumps([url, {k: v for k, v in (params or {}).items() if k != "api_key"}, data], sort_keys=True)
        path = Path(HTTP_CACHE) / f"{hashlib.sha256(key.encode()).hexdigest()}.txt"
        if path.exists():
            return path.read_text()
    text = request("POST" if data else "GET", url, params=params, data=data).text
    if HTTP_CACHE:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    return text


def norm_doi(doi):
    doi = re.sub(r"^https?://(dx\.)?doi\.org/", "", doi.strip(), flags=re.I).lower()
    return re.sub(r"v\d+$", "", doi)  # drop preprint version suffix


def url_doi(url):
    """DOI in a paper URL, or "" if it shows none."""
    if m := re.search(r"10\.\d{4,9}/[^\s?#]+", url):
        return norm_doi(re.sub(r"(\.full|\.abstract|/full|/abstract)$", "", m.group(0)))
    if m := re.search(r"nature\.com/articles/([a-z0-9-]+)", url):
        return f"10.1038/{m.group(1)}"
    return ""


def clean(text):
    """Plain text: entities decoded, inline markup removed, whitespace collapsed.

    A leading "Abstract" heading, which OpenAlex often keeps, stays in: the lab weights were
    fitted and backtested on text that has it. The site hides it.
    """
    return " ".join(INLINE_TAG.sub("", html.unescape(text or "")).split())


def openalex_key():
    """OPENALEX_API_KEY, else ~/.config/openalex/api_key."""
    path = Path.home() / ".config" / "openalex" / "api_key"
    key = os.environ.get("OPENALEX_API_KEY") or (path.read_text().strip() if path.exists() else "")
    return key or sys.exit("no OpenAlex API key: set OPENALEX_API_KEY (see docs/setup.md)")


def fetch_journals(cfg, start, end):
    """Works of the configured journals published in [start, end]; cursor paging, about one call per 200 works."""
    global openalex_usd
    by_issn = {j["issn"]: j for j in cfg["journals"]}
    params = {
        "filter": f"primary_location.source.issn:{'|'.join(by_issn)},type:{'|'.join(cfg['work_types'])},"
                  f"from_publication_date:{start},to_publication_date:{end}",
        "select": "doi,title,type,publication_date,authorships,abstract_inverted_index,primary_location",
        "per_page": 200,
        "api_key": openalex_key(),
    }
    out, cursor = [], "*"
    while cursor:
        if openalex_usd >= OPENALEX_MAX_USD:
            sys.exit(f"OpenAlex spend reached ${openalex_usd:.4f}; stopping to protect the daily budget")
        before = n_requests
        data = json.loads(cached("https://api.openalex.org/works", params | {"cursor": cursor}))
        if n_requests > before:  # not served from the development cache
            openalex_usd += data["meta"].get("cost_usd") or 0.0001
        for w in data["results"]:
            source = (w.get("primary_location") or {}).get("source") or {}
            journal = next((by_issn[i] for i in source.get("issn") or [] if i in by_issn), None)
            if not (w.get("doi") and w.get("title") and journal):
                continue
            position = {p: word for word, ps in (w.get("abstract_inverted_index") or {}).items() for p in ps}
            out.append(Paper(
                doi=norm_doi(w["doi"]),
                url=w["doi"],
                title=clean(w["title"]),
                authors=[a["author"]["display_name"] for a in w.get("authorships") or [] if a["author"].get("display_name")],
                venue=journal["key"],
                venue_name=journal["name"],
                journal=journal["abbr"],
                date=w["publication_date"],
                type="published",
                abstract=clean(" ".join(position[i] for i in sorted(position))),
            ))
        cursor = data["meta"].get("next_cursor") if data["results"] else None
    print(f"  OpenAlex: {len(out)} papers, spent ${openalex_usd:.4f} this run", flush=True)
    return out


def fetch_preprints(cfg, start, end):
    """Preprints of the configured categories with a version posted in [start, end]; latest version per DOI."""
    latest = {}
    for src in cfg["preprints"]:
        for category in src["categories"]:
            cursor = 0
            while True:
                data = json.loads(cached(f"https://api.biorxiv.org/details/{src['server']}/{start}/{end}/{cursor}",
                                         {"category": category.replace(" ", "_")}))
                batch = data.get("collection", [])
                for p in batch:
                    doi, version = norm_doi(p["doi"]), int(p["version"])
                    if p["category"].strip().lower() != category or (doi in latest and latest[doi][0] >= version):
                        continue
                    published = (p.get("published") or "NA").strip()
                    latest[doi] = version, Paper(
                        doi=doi,
                        url=f"https://www.{src['server']}.org/content/{p['doi']}v{version}",
                        title=clean(p["title"]),
                        # "Harvey, D. Y.; Smith, J." -> ["D. Y. Harvey", "J. Smith"]
                        authors=[" ".join(reversed(a.split(",", 1))).strip() for a in p["authors"].split(";") if a.strip()],
                        venue=f"{src['server'].capitalize()}:{category}",
                        venue_name=f"{src['name']} · {category}",
                        journal=src["name"],
                        date=p["date"],
                        type="preprint",
                        abstract=clean(p["abstract"]),
                        published_doi="" if published.upper() == "NA" else norm_doi(published),
                    )
                cursor += len(batch)
                if not batch or cursor >= int(data["messages"][0].get("total", 0)):
                    break
            print(f"  {src['server']}/{category}: {cursor} versions", flush=True)
    return [p for _, p in latest.values()]


def fill_abstracts(papers):
    """Fill missing abstracts from PubMed, 100 DOIs per query."""
    missing = [p for p in papers if not p.abstract]
    eutils = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
    for i in range(0, len(missing), 100):
        chunk = {p.doi: p for p in missing[i:i + 100]}
        ids = json.loads(cached(f"{eutils}/esearch.fcgi", data={
            "db": "pubmed", "term": " OR ".join(f'"{d}"[doi]' for d in chunk), "retmax": 200, "retmode": "json",
        }))["esearchresult"]["idlist"]
        if not ids:
            continue
        xml = cached(f"{eutils}/efetch.fcgi", data={"db": "pubmed", "id": ",".join(ids), "retmode": "xml"})
        for article in re.findall(r"<PubmedArticle>.*?</PubmedArticle>", xml, re.S):
            doi = re.search(r'<ArticleId IdType="doi">([^<]+)</ArticleId>', article)
            if doi and norm_doi(doi.group(1)) in chunk:
                chunk[norm_doi(doi.group(1))].abstract = clean(" ".join(
                    re.sub(r"<[^>]+>", "", a) for a in re.findall(r"<AbstractText[^>]*>(.*?)</AbstractText>", article, re.S)))
        time.sleep(0.4)  # NCBI allows 3 requests a second without a key


def fetch_pool(cfg, start, end):
    """The month's candidates from every configured source, junk removed, abstracts filled."""
    papers = fetch_journals(cfg, start, end) + fetch_preprints(cfg, start, end)
    total = Counter(p.venue for p in papers)
    for venue in [j["key"] for j in cfg["journals"]] + [f"{s['server'].capitalize()}:{c}" for s in cfg["preprints"] for c in s["categories"]]:
        if not total[venue]:  # a silent API change would otherwise shrink the list
            warn(f"no papers from {venue} between {start} and {end}")
    junk_title = re.compile(rf"(?:{'|'.join(cfg['junk_title'])})\b", re.I)
    junk_doi = re.compile("|".join(cfg["junk_doi"]))
    papers = list({p.doi: p for p in papers if not junk_title.match(p.title) and not junk_doi.search(p.doi)}.values())
    fill_abstracts(papers)
    missing = Counter(p.venue for p in papers if not p.abstract)
    for venue, n in missing.items():
        if total[venue] >= 10 and n > 0.6 * total[venue]:  # NG and others sit near 40% (News & Views)
            warn(f"{venue}: {n}/{total[venue]} papers have no abstract")
    print(f"fetched {sum(total.values())} papers, {len(papers)} after the junk filter, {sum(missing.values())} without abstract; "
          f"{n_requests} API requests, OpenAlex spend ${openalex_usd:.4f}", flush=True)
    return papers
