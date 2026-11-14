import numpy as np

from pipeline.dedupe import dedupe
from pipeline.fetch import Paper, author_names, clean, url_doi
from pipeline.output import paper_id, short_name
from pipeline.score import linear, probability
from pipeline import firestore, train


def paper(doi, title, type="published", journal="Nat Genet", published_doi="", authors=("Ada B. Smith", "Li Wei"), date="2026-10-07"):
    return Paper(doi=doi, url=f"https://doi.org/{doi}", title=title, authors=list(authors), venue="NG", venue_name="",
                 journal=journal, date=date, type=type, abstract="", published_doi=published_doi)


def test_authors_are_the_names_printed_on_the_paper():
    profile = lambda name, raw=None: {"author": {"display_name": name}, **({"raw_author_name": raw} if raw else {})}
    assert author_names([profile("Masayuki NAGAI", "Masayuki Nagai"), profile("J. Li", "Jinghui  Li"), profile("Peter K. Koo"),
                         profile("Emma Dann", "Dann, Emma"), {"author": {}}]) == ["Masayuki Nagai", "Jinghui Li", "Peter K. Koo", "Emma Dann"]


def test_dedupe_keeps_published_version_within_month():
    pool = [paper("10.1038/a", "Fine-mapping of 1,000 loci"),
            paper("10.1101/b", "Fine mapping of 1,000 Loci.", "preprint"),  # same normalized title
            paper("10.1101/c", "An earlier title", "preprint", published_doi="10.1038/a"),  # linked by the server
            paper("10.1101/d", "An unrelated preprint", "preprint")]
    assert [p.doi for p in dedupe(pool, set())] == ["10.1038/a", "10.1101/d"]


def test_dedupe_across_months_is_by_doi_only():
    pool = [paper("10.1101/x", "Listed last month as this preprint", "preprint"),
            paper("10.1038/y", "Listed last month as a preprint")]  # journal version: new DOI, listed again
    assert [p.doi for p in dedupe(pool, {"10.1101/x", "10.1101/y-preprint"})] == ["10.1038/y"]


def test_paper_id_uses_the_firestore_alphabet():
    assert paper_id("10.1038/s41588-026-00001-1") == "10.1038_s41588-026-00001-1"
    assert paper_id("10.1016/j.ajhg.2026.09.001(a);b") == "10.1016_j.ajhg.2026.09.001_a__b"
    assert len(paper_id("10.1/" + "x" * 300)) == 150


def test_short_name():
    assert short_name(paper("10.1/a", "Fine-mapping of rare variants in a biobank")) == "NatGenet_Smith_2026_FineMappingRareVariants"
    assert short_name(paper("10.1/b", "SuSiE-x: a method for the cross-ancestry case", journal="bioRxiv",
                            authors=["J. van der Müller-O'Neil"])) == "bioRxiv_MüllerONeil_2026_SuSiEX"
    assert short_name(paper("10.1/c", "Alzheimer’s disease genetics", authors=[])) == "NatGenet_NA_2026_AlzheimerDiseaseGenetics"
    assert short_name(paper("10.1/d", "A cell atlas", journal="Am J Hum Genet")) == "AmJHumGenet_Smith_2026_CellAtlas"


def test_clean_and_url_doi():
    assert clean("A&amp;B of <i>TP53</i>\n in <sub>2</sub> cells  where p < 0.05 > q") == "A&B of TP53 in 2 cells where p < 0.05 > q"
    assert url_doi("https://www.biorxiv.org/content/10.1101/2026.01.02.123456v2.full") == "10.1101/2026.01.02.123456"
    assert url_doi("https://www.nature.com/articles/s41588-026-00001-1") == "10.1038/s41588-026-00001-1"
    assert url_doi("https://www.cell.com/ajhg/fulltext/S0002-9297(26)00001-1") == ""
    assert url_doi("https://www.medrxiv.org/content/10.1101/2026.01.02.26300001v1.full.pdf+html") == "10.1101/2026.01.02.26300001"
    assert url_doi("https://doi.org/10.1016/j.ajhg.2026.01.001.") == "10.1016/j.ajhg.2026.01.001"
    assert url_doi("https://arxiv.org/abs/2601.01234v2") == "10.48550/arxiv.2601.01234"
    assert url_doi("https://www.science.org/doi/10.1126/science.adv0235") == "10.1126/science.adv0235"  # a DOI's own v
    assert url_doi("https://doi.org/10.1126/SCITRANSLMED.ADV1234") == "10.1126/scitranslmed.adv1234"


def test_score_from_a_weights_file():
    weights = {"bias": -1.0, "embedding": [2.0, 0.0, -1.0], "venue": {"NG": 0.5}}
    emb = np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]])
    # a venue missing from the file weighs 0
    np.testing.assert_allclose(linear(weights, emb, ["NG", "PNAS", "NG"]), [1.5, -1.0, -1.5])


def test_interest_in_listed_and_added_papers_is_the_labels():
    listed = {"2026-01": [{"id": "a", "doi": "10.1/a", "title": "Listed A"}, {"id": "b", "doi": "10.1/b", "title": "Listed B"}]}
    counts = {"2026-01": {"a": 2, "b": 0}, "2026-02": {"s1": 1, "s2": 0}, "2025-12": {"10.1_old": 1}}
    subs = {"2026-02": {"s1": {"url": "https://example.org/x", "title": "An Added Paper!"}, "s2": {"url": "https://doi.org/10.1/c", "title": "Unmarked"}}}
    assert train.marked_keys(listed, counts, subs) == {"10.1/a", "listed a", "an added paper", "10.1_old"}


def test_monthly_fit_learns_marks_weighting_recent_months_more(tmp_path, monkeypatch):
    monkeypatch.setattr(train, "POOLS", tmp_path)
    rng, u = np.random.default_rng(0), np.eye(8)[0]
    model = type("M", (), {"tokenizer": type("T", (), {"encode_batch": lambda self, texts, add_special_tokens: [
        type("E", (), {"ids": [i % 5]})() for i, _ in enumerate(texts)]})()})()
    for i, m in enumerate(["2025-10", "2025-11", "2026-10"]):  # 2025-10 is 13 months before 2026-11: outside the window
        marked = np.arange(200) < 20
        emb = rng.normal(size=(200, 8)) * 0.3 + np.where(marked, 1, -1)[:, None] * u
        train.save_pool(m, model, [f"10.1/{m}-{j}" for j in range(200)], [f"T {m} {j}" for j in range(200)], [""] * 200, ["NG"] * 200,
                        emb / np.linalg.norm(emb, axis=1, keepdims=True), np.where(marked, 2.0, -2.0) + rng.normal(size=200))
    keys = {f"10.1/{m}-{j}" for m in ("2025-10", "2025-11", "2026-10") for j in range(20)}
    w = train.fit("2026-11", {"NG", "Preprint"}, keys, base={"calibration": {"a": -3, "b": 1}})
    assert w["train_months"] == ["2025-11", "2026-10"] and w["marked"] == 40
    up, down = linear(w, np.array([u, -u]), ["NG", "NG"])
    assert up > 0 > down
    cal = w["calibration"]  # refitted on the stored scores: marked papers score higher, so b > 0
    assert w["calibrated_on"] == {"months": ["2025-11", "2026-10"], "marked": 40} and cal["b"] > 0 and cal != {"a": -3, "b": 1}
    assert train.fit("2027-11", {"NG"}, keys) is None  # no stored pool in the window: the caller keeps its weights


def test_pick_chance_is_calibrated_and_monotone():
    w = {"calibration": {"a": -3.0, "b": 0.75}}
    p = probability(w, [-10.0, 4.0, 10.0])
    np.testing.assert_allclose(p[1], 0.5)
    assert 0 < p[0] < p[1] < p[2] < 1


def test_reads_counts_and_added_papers_through_the_rest_api(monkeypatch):
    month = {"fields": {"counts": {"mapValue": {"fields": {"p1": {"integerValue": "2"}, "p2": {"integerValue": "0"}}}},
                        "paper": {"stringValue": "p1"}}}
    subs = {"documents": [{"name": "projects/p/databases/(default)/documents/months/2026-10/submissions/s1", "fields": {
        "title": {"stringValue": "T"}, "url": {"stringValue": "https://doi.org/10.1/x"}, "journal": {"stringValue": "PNAS"},
        "short_name": {"stringValue": "PNAS_B_2026_T"}, "authors": {"arrayValue": {"values": [{"stringValue": "A. B"}]}},
        "created": {"timestampValue": "2026-10-01T00:00:00Z"}}}]}
    response = lambda data: type("R", (), {"json": lambda self: data})()

    def request(method, url, missing_ok=False, **kw):
        if url.endswith("/months/2026-09"):
            assert missing_ok
            return None  # no document: nobody has been interested in a paper of the month
        return response(month if url.endswith("/months/2026-10") else subs)
    monkeypatch.setattr(firestore, "request", request)
    assert firestore.read_counts("p", "2026-10") == {"p1": 2, "p2": 0}
    assert firestore.read_counts("p", "2026-09") == {}
    assert firestore.read_submissions("p", "2026-10") == {"s1": {"title": "T", "url": "https://doi.org/10.1/x", "journal": "PNAS",
                                                                 "short_name": "PNAS_B_2026_T", "authors": ["A. B"], "abstract": "", "date": ""}}


def test_months_to_build():
    from datetime import date
    from pipeline.__main__ import months_to_build
    assert months_to_build(["2026-09", "2026-10"], date(2026, 11, 13)) == []  # listed already
    assert months_to_build(["2026-10"], date(2026, 12, 10)) == ["2026-11"]
    assert months_to_build(["2026-10"], date(2027, 1, 12)) == ["2026-11", "2026-12"]  # a missed month first
    assert months_to_build([], date(2026, 12, 10)) == ["2026-11"]


def test_added_venue_and_junk_titles():
    import re
    import tomllib
    from pipeline import ROOT
    from pipeline.__main__ import added_venue
    cfg = tomllib.loads((ROOT / "sources.toml").read_text())
    paper = lambda journal, url="https://doi.org/10.1/x": {"journal": journal, "url": url}
    assert [added_venue(cfg, paper(j)) for j in ["Nat Genet", "Nature Genetics", "nature genetics ", "bioRxiv", "Preprint", "J Unknown"]] \
        == ["NG", "NG", "NG", "Preprint", "Preprint", ""]
    assert added_venue(cfg, paper("Other", "https://www.medrxiv.org/content/10.1101/2026.01.02.26300001v1")) == "Preprint"
    junk = re.compile(rf"(?:{'|'.join(cfg['junk_title'])})\b", re.I)
    assert [bool(junk.match(t)) for t in ["Correction to: X", "Correction: X", "Correction", "Author Correction: X",
                                          "Correction for population stratification in GWAS", "Corrections of bias"]] \
        == [True, True, True, True, False, False]


def test_read_submissions_keeps_the_oldest_well_formed():
    from unittest import mock
    import pipeline.firestore as firestore
    docs = {"b": {"title": "T2", "url": "https://x/2", "journal": "Nature", "short_name": "s", "created": "2026-11-02T00:00:00Z",
                  "authors": ["A", 3, "B" * 500]},
            "a": {"title": "T1", "url": "https://x/1", "journal": "Nature", "short_name": "s", "created": "2026-11-01T00:00:00Z",
                  "abstract": "x" * 20000},
            "c": {"title": "", "url": "https://x/3", "created": "2026-11-03T00:00:00Z"}}
    with mock.patch.object(firestore, "documents", return_value=docs):
        out = firestore.read_submissions("project", "2026-11")
    assert list(out) == ["a", "b"] and len(out["a"]["abstract"]) == 10000 and out["b"]["authors"] == ["A", "B" * 200]
    with mock.patch.object(firestore, "documents", return_value={str(i): docs["a"] for i in range(250)}), mock.patch("builtins.print"):
        assert len(firestore.read_submissions("project", "2026-11")) == firestore.LIMIT
