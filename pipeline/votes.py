"""Read what visitors wrote to Firestore, through its public REST API (no credentials needed)."""
import hashlib

from .fetch import request


def documents(project, path):
    """Every document of a collection, as {document id: fields}."""
    url = f"https://firestore.googleapis.com/v1/projects/{project}/databases/(default)/documents/{path}"
    out, token = {}, None
    while True:
        data = request("GET", url, params={"pageSize": 300} | ({"pageToken": token} if token else {})).json()
        out |= {doc["name"].rsplit("/", 1)[1]: doc.get("fields", {}) for doc in data.get("documents", [])}
        token = data.get("nextPageToken")
        if not token:
            return out


def read_votes(project, month):
    """{paper id: {hashed handle: 1}} for one month: one entry per upvote. Handles are hashed."""
    votes = {}
    for fields in documents(project, f"months/{month}/votes").values():
        handle = fields["handle"]["stringValue"].lower()
        votes.setdefault(fields["paper"]["stringValue"], {})[hashlib.sha256(handle.encode()).hexdigest()[:16]] = 1
    return votes


def read_submissions(project, month):
    """{submission id: {journal, short_name, title, url, abstract}}: the papers visitors added to one month."""
    return {sid: {k: fields.get(k, {}).get("stringValue", "") for k in ("journal", "short_name", "title", "url", "abstract")}
            for sid, fields in documents(project, f"months/{month}/submissions").items()}
