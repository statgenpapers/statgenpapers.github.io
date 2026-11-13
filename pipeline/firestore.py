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


def read_submissions(project, month):
    """{submission id: {journal, title, url, short_name, authors, abstract, date}}: the papers readers added to one month."""
    return {sid: {k: fields.get(k, [] if k == "authors" else "") for k in FIELDS}
            for sid, fields in documents(project, f"months/{month}/submissions").items()}
