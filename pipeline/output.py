"""Output records: Firestore paper ids, and rows of the lab Sheet's table (Journal, Short Name, Title, URL)."""
import re

TABLE_HEADER = ["Journal", "Short Name", "Title", "URL"]
STOPWORDS = frozenset("a an and are as at by for from in into is of on or the to via with across between through using".split())


def paper_id(doi):
    """Firestore document id of a paper; the security rules allow only this alphabet, up to 150 characters."""
    return re.sub(r"[^A-Za-z0-9._-]", "_", doi)[:150]


def short_name(p):
    """Sheet-style label Journal_Surname_Year_Keyword, such as NatGenet_Smith_2026_FineMappingRareVariants.

    Keyword: the name before a colon when the title starts with one ("SuSiE: ..."), else the
    first four title words that are not stopwords; CamelCase, existing capitals kept.
    """
    title = re.sub(r"['’]s\b|['’]", "", p.title)  # Alzheimer's -> Alzheimer
    head, colon, _ = title.partition(":")
    words = [w for w in re.findall(r"[^\W_]+", head if colon and head.strip() and len(head.split()) <= 3 else title)
             if w.lower() not in STOPWORDS][:4]
    surname = re.sub(r"[\W_]", "", p.authors[0].split()[-1]) if p.authors else "NA"
    return "_".join([re.sub(r"[\W_]", "", p.journal), surname, p.date[:4],
                     "".join(w if w != w.lower() else w.capitalize() for w in words)])


def table_row(p):
    return [p.journal, short_name(p), p.title, p.url]
