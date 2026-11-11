"""Put one month's lab picks on the live site as marks of the handle "admin".

    uv run python dev/lab_marks.py actions.json
    actions.json: {"month": "2026-01", "marks": ["<paper id>", ...], "add": [{journal, title, url, short_name}, ...]}

A listed pick gets a mark; a missed pick is added as a paper and marked. What is already there is kept,
so a second run adds nothing twice. The writes go through the Firestore REST API under the public
rules, as one fixed anonymous Firebase user: firebase/firestore.rules lets only that user write as "admin".
Its sign-in is kept in ~/.config/statgenpapers/lab.json (private: never commit it). Run by
dev/rollforward.py, or by hand for a new month's picks.
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
from pipeline.fetch import cached, openalex_key, url_doi  # noqa: E402
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


def details(url):
    """Authors, abstract and date of a paper from OpenAlex, by the DOI in its URL; {} if not found."""
    doi = url_doi(url)
    if not doi:
        return {}
    try:
        w = json.loads(cached(f"https://api.openalex.org/works/doi:{doi}",
                              {"select": "authorships,abstract_inverted_index,publication_date", "api_key": openalex_key()}))
    except Exception:  # not in OpenAlex: the paper shows without them
        return {}
    position = {p: word for word, ps in (w.get("abstract_inverted_index") or {}).items() for p in ps}
    out = {"authors": [a["author"]["display_name"] for a in w.get("authorships", []) if a["author"].get("display_name")][:300],
           "abstract": " ".join(position[i] for i in sorted(position))[:10000], "date": w.get("publication_date") or ""}
    return {k: v for k, v in out.items() if v}


def delete(token, path):
    requests.delete(f"https://firestore.googleapis.com/v1/{DOCS}/{path}", headers={"Authorization": f"Bearer {token}"}).raise_for_status()


def main(actions):
    month, uid_token = actions["month"], id_token()
    uid, token = uid_token
    added = {f["url"]["stringValue"]: (sid, "authors" in f or "abstract" in f)
             for sid, f in documents(PROJECT, f"months/{month}/submissions").items() if f.get("name", {}).get("stringValue") == HANDLE}
    mark = lambda paper: create(token, f"months/{month}/votes/{paper}~{HANDLE}", {"paper": paper, "handle": HANDLE})
    new_marks = sum(mark(p) for p in actions["marks"])
    new_papers = 0
    for p in actions["add"]:
        sid, complete = added.get(p["url"], (None, False))
        if sid and not complete:  # added before papers carried authors and abstract: papers cannot be edited, so replace it
            delete(token, f"months/{month}/votes/{sid}~{HANDLE}")
            delete(token, f"months/{month}/submissions/{sid}")
            sid = None
        if not sid:
            p = p | details(p["url"])
            sid = "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(20))
            create(token, f"months/{month}/submissions/{sid}", p | {"uid": uid, "name": HANDLE}, server_time="created")
            new_papers += 1
        new_marks += mark(sid)
    print(f"{month}: {len(actions['marks'])} listed picks, {len(actions['add'])} missed picks; "
          f"{new_papers} papers added, {new_marks} marks written now")


if __name__ == "__main__":
    main(json.loads(Path(sys.argv[1]).read_text()))
