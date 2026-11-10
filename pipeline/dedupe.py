"""Remove duplicates: a preprint whose published version is in the same pool, and papers already listed."""
import re


def norm_title(title):
    return re.sub(r"[^a-z0-9]", "", title.lower())


def dedupe(papers, listed_dois):
    """Drop preprints published in the same pool (same normalized title, or the server's link to the
    journal DOI), then every DOI in `listed_dois` (the shortlists of other months).

    Across months the match is by DOI only, so the journal version of an earlier preprint can be listed again.
    """
    published = [p for p in papers if p.type == "published"]
    titles, dois = {norm_title(p.title) for p in published}, {p.doi for p in published}
    return [p for p in papers if p.doi not in listed_dois
            and (p.type == "published" or (norm_title(p.title) not in titles and p.published_doi not in dois))]
