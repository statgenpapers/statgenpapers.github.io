import numpy as np

from pipeline.dedupe import dedupe
from pipeline.fetch import Paper, clean, url_doi
from pipeline.output import paper_id, short_name, table_row
from pipeline.score import linear, probability
from pipeline import train
from pipeline import votes as votes_module


def paper(doi, title, type="published", journal="Nat Genet", published_doi="", authors=("Ada B. Smith", "Li Wei"), date="2026-10-07"):
    return Paper(doi=doi, url=f"https://doi.org/{doi}", title=title, authors=list(authors), venue="NG", venue_name="",
                 journal=journal, date=date, type=type, abstract="", published_doi=published_doi)


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


def test_short_name_and_table_row():
    assert short_name(paper("10.1/a", "Fine-mapping of rare variants in a biobank")) == "NatGenet_Smith_2026_FineMappingRareVariants"
    assert short_name(paper("10.1/b", "SuSiE-x: a method for the cross-ancestry case", journal="bioRxiv",
                            authors=["J. van der Müller-O'Neil"])) == "bioRxiv_MüllerONeil_2026_SuSiEX"
    assert short_name(paper("10.1/c", "Alzheimer’s disease genetics", authors=[])) == "NatGenet_NA_2026_AlzheimerDiseaseGenetics"
    assert table_row(paper("10.1/d", "A cell atlas", journal="Am J Hum Genet")) == [
        "Am J Hum Genet", "AmJHumGenet_Smith_2026_CellAtlas", "A cell atlas", "https://doi.org/10.1/d"]


def test_clean_and_url_doi():
    assert clean("A&amp;B of <i>TP53</i>\n in <sub>2</sub> cells  where p < 0.05 > q") == "A&B of TP53 in 2 cells where p < 0.05 > q"
    assert url_doi("https://www.biorxiv.org/content/10.1101/2026.01.02.123456v2.full") == "10.1101/2026.01.02.123456"
    assert url_doi("https://www.nature.com/articles/s41588-026-00001-1") == "10.1038/s41588-026-00001-1"
    assert url_doi("https://www.cell.com/ajhg/fulltext/S0002-9297(26)00001-1") == ""


def test_score_from_a_weights_file():
    weights = {"bias": -1.0, "embedding": [2.0, 0.0, -1.0], "venue": {"NG": 0.5}}
    emb = np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]])
    # a venue missing from the file weighs 0
    np.testing.assert_allclose(linear(weights, emb, ["NG", "PNAS", "NG"]), [1.5, -1.0, -1.5])


def test_marks_on_lists_and_added_papers_are_the_labels():
    listed = {"2026-01": [{"id": "a", "doi": "10.1/a", "title": "Listed A"}, {"id": "b", "doi": "10.1/b", "title": "Listed B"}]}
    votes = {"2026-01": {"a": {"h": 1}}, "2026-02": {"s1": {"h": 1}}}
    subs = {"2026-02": {"s1": {"url": "https://example.org/x", "title": "An Added Paper!"}, "s2": {"url": "https://doi.org/10.1/c", "title": "Unmarked"}}}
    assert train.marked_keys(listed, votes, subs) == {"10.1/a", "listed a", "an added paper"}


def test_monthly_fit_learns_marks_weighting_recent_months_more(tmp_path, monkeypatch):
    monkeypatch.setattr(train, "POOLS", tmp_path)
    rng, u = np.random.default_rng(0), np.eye(8)[0]
    model = type("M", (), {"tokenizer": type("T", (), {"encode_batch": lambda self, texts, add_special_tokens: [
        type("E", (), {"ids": [i % 5]})() for i, _ in enumerate(texts)]})()})()
    for i, m in enumerate(["2025-10", "2025-11", "2026-10"]):  # 2025-10 is 13 months before 2026-11: outside the window
        marked = np.arange(200) < 20
        emb = rng.normal(size=(200, 8)) * 0.3 + np.where(marked, 1, -1)[:, None] * u
        train.save_pool(m, model, [f"10.1/{m}-{j}" for j in range(200)], [f"T {m} {j}" for j in range(200)], [""] * 200, ["NG"] * 200,
                        emb / np.linalg.norm(emb, axis=1, keepdims=True))
    keys = {f"10.1/{m}-{j}" for m in ("2025-10", "2025-11", "2026-10") for j in range(20)}
    w = train.fit("2026-11", {"NG", "Preprint"}, keys, base={"calibration": {"a": -3, "b": 1}})
    assert w["train_months"] == ["2025-11", "2026-10"] and w["marked"] == 40 and w["calibration"] == {"a": -3, "b": 1}
    up, down = linear(w, np.array([u, -u]), ["NG", "NG"])
    assert up > 0 > down
    assert train.fit("2027-11", {"NG"}, keys) is None  # no stored pool in the window: the caller keeps its weights


def test_pick_chance_is_calibrated_and_monotone():
    w = {"calibration": {"a": -3.0, "b": 0.75}}
    p = probability(w, [-10.0, 4.0, 10.0])
    np.testing.assert_allclose(p[1], 0.5)
    assert 0 < p[0] < p[1] < p[2] < 1


def test_read_votes_counts_one_upvote_per_handle_and_hashes_handles(monkeypatch):
    docs = {"p1~alice": {"paper": {"stringValue": "p1"}, "handle": {"stringValue": "Alice"}},
            "p1~bob": {"paper": {"stringValue": "p1"}, "handle": {"stringValue": "bob"}},
            "p2~alice": {"paper": {"stringValue": "p2"}, "handle": {"stringValue": "alice"}}}
    monkeypatch.setattr(votes_module, "documents", lambda project, path: docs if path == "months/2026-10/votes" else {})
    out = votes_module.read_votes("proj", "2026-10")
    assert {k: len(v) for k, v in out.items()} == {"p1": 2, "p2": 1}
    assert set(out["p1"].values()) == {1} and out["p2"].keys() <= out["p1"].keys()  # the same handle, whatever its case
    assert not any("alice" in h or "bob" in h for v in out.values() for h in v)
