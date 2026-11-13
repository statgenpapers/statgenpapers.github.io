"""Put one month's lab picks on the live site as marks of the handle "admin".

    uv run python dev/lab_marks.py actions.json
    actions.json: {"month": "2026-01", "marks": ["<paper id>", ...], "add": [{journal, title, url, short_name}, ...]}

A listed pick gets a mark; a missed pick is added as a paper and marked. What is already there is kept,
so a second run adds nothing twice. The writes go through the Firestore REST API under the public
rules, as one fixed anonymous Firebase user: firebase/firestore.rules lets only that user write as "admin".
Its sign-in is kept in ~/.config/statgenpapers/lab.json (private: never commit it). Run by
dev/coldstart/rollforward.py, or by hand for a new month's picks.
"""
import json
import re
import secrets
import string
import sys
from pathlib import Path

import requests

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT))
from pipeline.fetch import abstract_elsewhere, author_names, find_doi, lookup, openalex_key, plain_title as plain, url_doi  # noqa: E402
from pipeline.votes import documents  # noqa: E402

HANDLE = "admin"
CREDS = Path.home() / ".config" / "statgenpapers" / "lab.json"
CONFIG = (ROOT / "site" / "config.js").read_text()
API_KEY, PROJECT = (re.search(rf'{k}: "([^"]+)"', CONFIG).group(1) for k in ("apiKey", "projectId"))
DOCS = f"projects/{PROJECT}/databases/(default)/documents"


def id_token():
    """(uid, ID token) of the lab's Firebase user; signs it up once."""
    if not CREDS.exists():
        r = requests.post(f"https://identitytoolkit.googleapis.com/v1/accounts:signUp?key={API_KEY}", json={"returnSecureToken": True})
        r.raise_for_status()
        CREDS.parent.mkdir(parents=True, exist_ok=True)
        CREDS.write_text(json.dumps({"uid": r.json()["localId"], "refresh_token": r.json()["refreshToken"]}))
        CREDS.chmod(0o600)
    creds = json.loads(CREDS.read_text())
    r = requests.post(f"https://securetoken.googleapis.com/v1/token?key={API_KEY}",
                      data={"grant_type": "refresh_token", "refresh_token": creds["refresh_token"]})
    r.raise_for_status()
    return creds["uid"], r.json()["id_token"]


def create(token, path, fields, server_time=None):
    """Create one document; False if it exists already."""
    value = lambda v: {"arrayValue": {"values": [{"stringValue": x} for x in v]}} if isinstance(v, list) else {"stringValue": v}
    write = {"update": {"name": f"{DOCS}/{path}", "fields": {k: value(v) for k, v in fields.items()}},
             "currentDocument": {"exists": False}}
    if server_time:
        write["updateTransforms"] = [{"fieldPath": server_time, "setToServerValue": "REQUEST_TIME"}]
    r = requests.post(f"https://firestore.googleapis.com/v1/{DOCS}:commit", json={"writes": [write]},
                      headers={"Authorization": f"Bearer {token}"})
    if r.status_code == 409 or "ALREADY_EXISTS" in r.text:
        return False
    r.raise_for_status()
    return True


def work(url, title):
    """The OpenAlex record of a paper, found by fetch.find_doi; None if not found."""
    doi = find_doi(url, title)
    return doi and lookup(f"https://api.openalex.org/works/doi:{doi}", {"select": "doi,authorships,abstract_inverted_index,publication_date",
                                                                       "api_key": openalex_key()})


def details(url, title=""):
    """DOI URL, authors, abstract and date of a paper from OpenAlex; {} if not found."""
    w = work(url, title)
    if not w:
        return {}
    position = {p: word for word, ps in (w.get("abstract_inverted_index") or {}).items() for p in ps}
    abstract = " ".join(position[i] for i in sorted(position)) or (w.get("doi") and abstract_elsewhere(w["doi"])) or ""
    if not abstract:
        print(f"no abstract found for {w.get('doi') or url}: run dev/fill_abstracts.py later, or add it by hand")
    out = {"url": w["doi"] if not url_doi(url) and w.get("doi") else "",  # a DOI link where the Sheet had none
           "authors": author_names(w.get("authorships"))[:300],
           "abstract": abstract[:10000], "date": w.get("publication_date") or ""}
    return {k: v for k, v in out.items() if v}


def delete(token, path):
    """Delete one document; one that is gone already (the rules answer 403 for it) is fine."""
    r = requests.delete(f"https://firestore.googleapis.com/v1/{DOCS}/{path}", headers={"Authorization": f"Bearer {token}"})
    if r.status_code == 403 and requests.get(f"https://firestore.googleapis.com/v1/{DOCS}/{path}").status_code == 404:
        return
    r.raise_for_status()


def main(actions):
    """Write one month's actions: marks on listed papers (also of earlier months, "marks_in": {month: [ids]}), and
    the missed picks as added papers. An added paper already there is kept if complete, else replaced; one no
    longer in the actions (say, a pick found on an earlier list) is removed with its mark."""
    month, (uid, token) = actions["month"], id_token()
    mark = lambda m, paper: create(token, f"months/{m}/votes/{paper}~{HANDLE}", {"paper": paper, "handle": HANDLE})
    new_marks = sum(mark(m, p) for m, ids in ({month: actions["marks"]} | actions.get("marks_in", {})).items() for p in ids)
    subs = {sid: f for sid, f in documents(PROJECT, f"months/{month}/submissions").items() if f.get("name", {}).get("stringValue") == HANDLE}
    by_key = {key: sid for sid, f in subs.items() for key in (f["url"]["stringValue"], plain(f["title"]["stringValue"]))}
    complete = lambda f: "authors" in f or "abstract" in f
    kept, gone, new_papers = set(), set(), 0
    for p in actions["add"]:
        sid = by_key.get(p["url"]) or by_key.get(plain(p["title"]))
        if sid in kept or sid in gone:  # two picks of one paper: one is enough
            continue
        if sid and not complete(subs[sid]) and (more := details(p["url"], p["title"])):  # papers cannot be edited: replace it
            delete(token, f"months/{month}/votes/{sid}~{HANDLE}")
            delete(token, f"months/{month}/submissions/{sid}")
            gone.add(sid)
            sid, p = None, p | more
        elif not sid:
            p = p | details(p["url"], p["title"])
        if not sid:
            sid = "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(20))
            create(token, f"months/{month}/submissions/{sid}", p | {"uid": uid, "name": HANDLE}, server_time="created")
            new_papers += 1
        kept.add(sid)
        new_marks += mark(month, sid)
    for sid in subs.keys() - kept - gone:
        delete(token, f"months/{month}/votes/{sid}~{HANDLE}")
        delete(token, f"months/{month}/submissions/{sid}")
    print(f"{month}: {len(actions['marks'])} listed picks, {sum(map(len, actions.get('marks_in', {}).values()))} on earlier lists, "
          f"{len(actions['add'])} missed; {new_papers} papers added, {len(subs.keys() - kept - gone)} removed, {new_marks} marks written now")


if __name__ == "__main__":
    main(json.loads(Path(sys.argv[1]).read_text()))
