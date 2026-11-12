"""Fetch one month's pool: journals from OpenAlex, preprints from bioRxiv/medRxiv, missing abstracts from PubMed."""
import hashlib
import html
import json
import os
import re
import sys
import time
from collections import Counter
from dataclasses import dataclass, replace
from pathlib import Path
from types import SimpleNamespace

import requests

session = requests.Session()
session.headers["User-Agent"] = "monthly-papers/0.1"
n_requests = 0
openalex_usd = 0.0
OPENALEX_MAX_USD = float(os.environ.get("OPENALEX_MAX_USD", 0.5))  # stop a run before it spends half the keyed $1/day budget
# Local runs keep response bodies in .cache/http for a week, so reruns make almost no calls; the monthly
# workflow fetches fresh. PIPELINE_HTTP_CACHE sets another directory, or "" for none.
HTTP_CACHE = os.environ.get("PIPELINE_HTTP_CACHE", "" if os.environ.get("GITHUB_ACTIONS") else str(Path(__file__).parents[1] / ".cache" / "http"))
CACHE_DAYS = float(os.environ.get("PIPELINE_HTTP_CACHE_DAYS", 7))
fresh = lambda path: path.exists() and time.time() - path.stat().st_mtime < CACHE_DAYS * 86400
INLINE_TAG = re.compile(r"</?(?:i|em|b|strong|sub|sup|sc|scp|p|br|title|sec|jats:[\w-]+)\b[^>]*>", re.I)


@dataclass
class Paper:
    doi: str
    url: str
    title: str
    authors: list[str]
    venue: str  # key of the venue weight: a journal key, or "Preprint" for every preprint
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
        if fresh(path):
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
    """DOI in a paper URL, or "" if it shows none. Keep in step with urlDoi() in site/app.js."""
    if m := re.search(r"nature\.com/articles/([^\s?#/]+)", url, re.I):
        doi = f"10.1038/{m.group(1)}"
    elif m := re.search(r"arxiv\.org/(?:abs|pdf)/(\d{4}\.\d{4,5})", url, re.I):
        doi = f"10.48550/arxiv.{m.group(1)}"
    elif m := re.search(r"10\.\d{4,9}/[^\s?#]+", url):
        doi = m.group(0)
    else:
        return ""
    doi = re.sub(r"[.,;)\]]+$", "", doi)
    return norm_doi(re.sub(r"(\.full\.pdf\+html|\.full\.pdf|\.full-text|\.full|\.abstract|\.pdf|/full|/abstract)$", "", doi))


def lookup(url, params=None):
    """JSON of a GET that may fail (after request()'s retries): None on a miss or error. Cached like `cached`."""
    try:
        return json.loads(cached(url, params))
    except (SystemExit, ValueError):  # request() exits on a failure it cannot retry, such as a 404
        return None


plain_title = lambda t: re.sub(r"[^a-z0-9]+", " ", (t or "").lower()).strip()


def find_doi(url, title=""):
    """A paper's DOI, "" if none is found. In order: the DOI in its URL; a bioRxiv or medRxiv id; an Elsevier PII (cell.com and
    ScienceDirect links), which Crossref keeps as an alternative id; its exact title in OpenAlex, a journal's
    record before a repository's; its exact title in Crossref."""
    if doi := url_doi(url):
        return doi
    if m := re.search(r"/(S\d{4}-?\d{3}[\dX](?:\(\d\d\)|\d\d)\d{5}-?[\dX])(?:[/?#]|$)", url, re.I):  # any cell.com or ScienceDirect path
        found = lookup("https://api.crossref.org/works", {"filter": f"alternative-id:{re.sub(r'[^0-9XS]', '', m.group(1).upper())}",
                                                         "rows": 1, "select": "DOI"})
        if items := (found or {}).get("message", {}).get("items"):
            return norm_doi(items[0]["DOI"])
    if m := re.search(r"(?:bio|med)rxiv\.org/.*?(\d{4}\.\d\d\.\d\d\.\d{6,8})", url):  # an "early" or PDF link: the id without its DOI prefix
        for prefix in ("10.64898", "10.1101"):  # the prefix bioRxiv and medRxiv use since 2025, and before
            if lookup(f"https://api.crossref.org/works/{prefix}/{m.group(1)}"):
                return f"{prefix}/{m.group(1)}"
    if not (want := plain_title(title)):
        return ""
    found = lookup("https://api.openalex.org/works", {"filter": f"title.search:{re.sub(r'[,:|]', ' ', title)}",
                                                     "select": "doi,display_name,primary_location", "per-page": 10, "api_key": openalex_key()})
    same = [w for w in (found or {}).get("results", []) if w.get("doi") and plain_title(w["display_name"]) == want]
    journal = [w for w in same if ((w.get("primary_location") or {}).get("source") or {}).get("type") == "journal"]
    if journal or same:
        return norm_doi((journal or same)[0]["doi"])
    found = lookup("https://api.crossref.org/works", {"query.bibliographic": title, "rows": 5, "select": "DOI,title"})
    for item in (found or {}).get("message", {}).get("items", []):
        if plain_title((item.get("title") or [""])[0]) == want:
            return norm_doi(item["DOI"])
    return ""


def clean(text):
    """Plain text: entities decoded, inline markup removed, whitespace collapsed.

    A leading "Abstract" heading, which OpenAlex often keeps, stays in: the base weights were
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


OPENALEX_AUTHOR_CAP = 100  # OpenAlex lists cut authorships at 100; a single-work request has them all


def full_authors(paper):
    """`paper` with every author, fetched one work at a time for a journal paper at OpenAlex's cap of 100."""
    if paper.type != "published" or len(paper.authors) != OPENALEX_AUTHOR_CAP:
        return paper
    w = json.loads(cached(f"https://api.openalex.org/works/doi:{paper.doi}", {"select": "authorships", "api_key": openalex_key()}))
    return replace(paper, authors=[a["author"]["display_name"] for a in w["authorships"] if a["author"].get("display_name")])


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
                        venue="Preprint",
                        venue_name=f"{src['name']} · {category}",  # internal: the site does not show it for preprints
                        journal="Preprint",  # a preprint is a preprint, whatever the server
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


def abstract_elsewhere(doi):
    """The abstract of a paper OpenAlex has none for: PubMed, then Europe PMC, then the publisher's page (its
    citation_abstract or dc.description; never og:description, a teaser); "" if none has it."""
    paper = SimpleNamespace(doi=norm_doi(doi), abstract="")
    fill_abstracts([paper])
    if paper.abstract:
        return paper.abstract
    try:
        found = session.get("https://www.ebi.ac.uk/europepmc/webservices/rest/search", timeout=30, params={
            "query": f'DOI:"{paper.doi}"', "resultType": "core", "format": "json", "pageSize": 1}).json()
        text = (found.get("resultList", {}).get("result") or [{}])[0].get("abstractText", "")
        if not text:
            page = session.get(f"https://doi.org/{paper.doi}", timeout=30).text
            meta = re.search(r'<meta name="(?:citation_abstract|dc\.description)" content="([^"]{100,})"', page)
            text = html.unescape(meta.group(1)) if meta else ""
    except (requests.RequestException, ValueError):
        return ""
    return clean(text)


def nature_type(doi):
    """A Nature-family paper's article type from its page ("Article", "Research Highlight"); "" if unknown."""
    path = Path(HTTP_CACHE) / f"nature-type-{doi.replace('/', '_')}.txt" if HTTP_CACHE else None
    if path and fresh(path):
        return path.read_text()
    try:
        page = session.get(f"https://www.nature.com/articles/{doi.split('/', 1)[1]}", timeout=30).text
    except requests.RequestException:
        return ""  # unknown: the paper stays
    found = re.search(r'name="citation_article_type" content="([^"]*)"', page)
    kind = html.unescape(found.group(1)) if found else ""
    if path and kind:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(kind)
    return kind


def fetch_pool(cfg, start, end):
    """The month's candidates from every configured source, junk removed, abstracts filled."""
    papers = fetch_journals(cfg, start, end) + fetch_preprints(cfg, start, end)
    total, sources = Counter(p.venue for p in papers), Counter(p.venue_name for p in papers)
    for source in [j["name"] for j in cfg["journals"]] + [f"{s['name']} · {c}" for s in cfg["preprints"] for c in s["categories"]]:
        if not sources[source]:  # a silent API change would otherwise shrink the list
            warn(f"no papers from {source} between {start} and {end}")
    junk_title = re.compile(rf"(?:{'|'.join(cfg['junk_title'])})\b", re.I)
    junk_doi = re.compile("|".join(cfg["junk_doi"]))
    papers = list({p.doi: p for p in papers if not junk_title.match(p.title) and not junk_doi.search(p.doi)}.values())
    fill_abstracts(papers)
    # Nature-family pieces without an abstract are mostly research highlights, briefings and columns: keep
    # only research and review articles (a page lookup each, a few dozen a month)
    kinds = {p.doi: nature_type(p.doi) for p in papers if p.doi.startswith("10.1038/") and not p.abstract}
    dropped = {doi for doi, kind in kinds.items() if kind and kind not in cfg["nature_article_types"]}
    papers = [p for p in papers if p.doi not in dropped]
    print(f"{len(dropped)} of {len(kinds)} Nature-family papers without abstract left out as not research: "
          f"{dict(Counter(kinds[d] for d in dropped))}", flush=True)
    missing = Counter(p.venue for p in papers if not p.abstract)
    for venue, n in missing.items():
        if total[venue] >= 10 and n > 0.6 * total[venue]:  # NG and others sit near 40% (News & Views)
            warn(f"{venue}: {n}/{total[venue]} papers have no abstract")
    print(f"fetched {sum(total.values())} papers, {len(papers)} after the junk filter, {sum(missing.values())} without abstract; "
          f"{n_requests} API requests, OpenAlex spend ${openalex_usd:.4f}", flush=True)
    return papers
