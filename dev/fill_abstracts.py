"""Fill in the abstract of every added paper stored without one, in place, so its id, marks and Score stay.

    uv run python dev/fill_abstracts.py           # list what it would fill
    uv run python dev/fill_abstracts.py --write

The rules let nobody edit a paper, so it writes as the project's owner, with the Firebase CLI's login (run any
`npx firebase` command first if that login has expired). Safe to rerun: it touches only papers without an abstract.
Run it after dev/rollforward.py, or whenever a paper shows "No abstract available".
"""
import json
import re
import sys
from pathlib import Path

import requests

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT))
from pipeline.fetch import abstract_elsewhere, find_doi, lookup, openalex_key  # noqa: E402
from pipeline.votes import documents  # noqa: E402

PROJECT = re.search(r'projectId: "([^"]+)"', (ROOT / "site" / "config.js").read_text()).group(1)
DOCS = f"projects/{PROJECT}/databases/(default)/documents"


def abstract(url, title):
    """OpenAlex's abstract, else abstract_elsewhere's; "" if none."""
    doi = find_doi(url, title)
    if not doi:
        return ""
    w = lookup(f"https://api.openalex.org/works/doi:{doi}", {"select": "abstract_inverted_index", "api_key": openalex_key()}) or {}
    position = {p: word for word, ps in (w.get("abstract_inverted_index") or {}).items() for p in ps}
    return " ".join(position[i] for i in sorted(position)) or abstract_elsewhere(doi)


def main(write):
    lists = sorted(p.stem for p in (ROOT / "site" / "data").glob("20*.json"))
    y, m = map(int, lists[-1].split("-"))
    months = ["2025-11", "2025-12"] + lists + [f"{y + m // 12}-{m % 12 + 1:02d}"]  # the cold start's months before the first list, and the month in progress
    found = {}
    for month in months:
        for sid, f in documents(PROJECT, f"months/{month}/submissions").items():
            if not f.get("abstract", {}).get("stringValue"):
                url, title = f["url"]["stringValue"], f["title"]["stringValue"]
                text = abstract(url, title)
                print(f"{'fill' if text else 'NONE'} {month} {url} {title[:60]}")
                if text:
                    found[f"months/{month}/submissions/{sid}"] = text[:10000]
    if write and found:
        token = json.loads((Path.home() / ".config" / "configstore" / "firebase-tools.json").read_text())["tokens"]["access_token"]
        for path, text in found.items():
            requests.patch(f"https://firestore.googleapis.com/v1/{DOCS}/{path}", params={"updateMask.fieldPaths": "abstract", "currentDocument.exists": "true"},
                           json={"fields": {"abstract": {"stringValue": text}}},
                           headers={"Authorization": f"Bearer {token}"}).raise_for_status()
    print(f"{len(found)} abstracts found{', written' if write and found else ''}")


if __name__ == "__main__":
    main("--write" in sys.argv)
