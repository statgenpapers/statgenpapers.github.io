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
    """{paper id: {hashed uid: 1 or -1}} for one month. Names are dropped."""
    votes = {pid: fields.get("votes", {}).get("mapValue", {}).get("fields", {})
             for pid, fields in documents(project, f"months/{month}/papers").items()}
    return {pid: {hashlib.sha256(uid.encode()).hexdigest()[:16]: int(next(iter(v["mapValue"]["fields"]["v"].values())))
                  for uid, v in vs.items()}
            for pid, vs in votes.items() if vs}


def read_submissions(project, month):
    """{submission id: {journal, short_name, title, url}}: the papers visitors added to one month."""
    return {sid: {k: fields[k]["stringValue"] for k in ("journal", "short_name", "title", "url")}
            for sid, fields in documents(project, f"months/{month}/submissions").items()}
