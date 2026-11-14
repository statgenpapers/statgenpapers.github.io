"""Read what readers wrote to Firestore, through its public REST API (no credentials needed): a month's interest
counts and the papers added to it. Which handle is interested in what is never read."""
from .fetch import request

FIELDS = ("journal", "title", "url", "short_name", "authors", "abstract", "date")  # of an added paper


def url(project, path):
    return f"https://firestore.googleapis.com/v1/projects/{project}/databases/(default)/documents/{path}"


def plain(value):
    """A Firestore REST value as plain Python: {"integerValue": "3"} -> 3."""
    (kind, v), = value.items()
    if kind == "integerValue":
        return int(v)
    if kind == "arrayValue":
        return [plain(x) for x in v.get("values", [])]
    if kind == "mapValue":
        return {k: plain(x) for k, x in v.get("fields", {}).items()}
    return v


def documents(project, path):
    """Every document of a collection, as {document id: fields}."""
    out, token = {}, None
    while True:
        data = request("GET", url(project, path), params={"pageSize": 300} | ({"pageToken": token} if token else {})).json()
        out |= {doc["name"].rsplit("/", 1)[1]: {k: plain(v) for k, v in doc.get("fields", {}).items()} for doc in data.get("documents", [])}
        token = data.get("nextPageToken")
        if not token:
            return out


def read_counts(project, month):
    """{paper id: handles interested in it} of one month; {} if nobody has been."""
    doc = request("GET", url(project, f"months/{month}"), missing_ok=True)
    return plain(doc.json().get("fields", {}).get("counts", {"mapValue": {}})) if doc else {}


LIMIT = 200  # added papers a month: the add page shows the 200 oldest
SIZE = {"journal": 60, "title": 400, "url": 500, "short_name": 150, "abstract": 10000, "date": 10}  # as the rules allow


def read_submissions(project, month):
    """{submission id: {journal, title, url, short_name, authors, abstract, date}}: the papers readers added to one month,
    the 200 oldest, each field of the type and size the rules allow; a paper without a title or link is left out."""
    docs = sorted(documents(project, f"months/{month}/submissions").items(), key=lambda d: str(d[1].get("created", "")))
    out = {}
    for sid, fields in docs:
        paper = {k: fields[k][:n] if isinstance(fields.get(k), str) else "" for k, n in SIZE.items()}
        authors = fields.get("authors")
        authors = [a[:200] for a in authors[:300] if isinstance(a, str)] if isinstance(authors, list) else []
        while len(", ".join(authors)) > 10000:  # as the rules allow
            authors.pop()
        paper["authors"] = authors
        if paper["title"] and paper["url"] and len(out) < LIMIT:
            out[sid] = {k: paper[k] for k in FIELDS}
    if len(docs) > len(out):
        print(f"::warning::{month}: {len(docs) - len(out)} of {len(docs)} added papers left out (no title or link, or over {LIMIT})")
    return out
