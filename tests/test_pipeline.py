import numpy as np

from pipeline.dedupe import dedupe
from pipeline.fetch import Paper, clean, url_doi
from pipeline.output import paper_id, short_name, table_row
from pipeline.score import linear, probability, vote_correction
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


def votes(n, seed=0):
    """n listed papers: the upvoted half lies along +u, the rest along -u; all have lab score 0."""
    rng = np.random.default_rng(seed)
    upvoted = np.arange(n) % 2 == 0
    emb = rng.normal(size=(n, 8)) * 0.3 + np.where(upvoted, 1, -1)[:, None] * np.eye(8)[0]
    return emb / np.linalg.norm(emb, axis=1, keepdims=True), ["NG"] * n, upvoted


NEW = np.array([[1.0], [-1.0]]) * np.eye(8)[0]  # one new paper like the upvoted ones, one like the others


def test_no_votes_leaves_the_lab_scores():
    emb, venues, upvoted = votes(58)  # 29 upvoted papers: below min_upvoted
    for delta in [vote_correction(emb, venues, upvoted, np.zeros(58), 1.0, 30),
                  vote_correction(np.zeros((0, 8)), [], np.zeros(0, bool), np.zeros(0), 1.0, 30),
                  vote_correction(emb, venues, np.ones(58, bool), np.zeros(58), 1.0, 30)]:  # all upvoted: no contrast
        assert not np.any(delta["embedding"]) and not delta["venue"]
        np.testing.assert_array_equal(linear(delta, NEW, ["NG", "NG"]), 0)


def test_consistent_votes_move_scores():
    emb, venues, upvoted = votes(80)
    up, down = linear(vote_correction(emb, venues, upvoted, np.zeros(80), 1.0, 30), NEW, ["Cell", "Cell"])
    assert up > 0.5 and down < -0.5
    # more votes move the scores further; a stronger penalty keeps them closer to the lab weights
    more = linear(vote_correction(*votes(800), np.zeros(800), 1.0, 30), NEW, ["Cell", "Cell"])[0]
    stiff = linear(vote_correction(emb, venues, upvoted, np.zeros(80), 100.0, 30), NEW, ["Cell", "Cell"])[0]
    assert more > up > stiff > 0


def test_votes_that_agree_with_the_lab_score_change_little():
    emb, venues, upvoted = votes(80)
    agree = vote_correction(emb, venues, upvoted, np.where(upvoted, 6.0, -6.0), 1.0, 30)  # lab score predicts every vote
    surprise = vote_correction(emb, venues, upvoted, np.where(upvoted, -6.0, 6.0), 1.0, 30)
    assert 10 * np.linalg.norm(agree["embedding"]) < np.linalg.norm(surprise["embedding"])


def test_correction_ignores_how_popular_voting_is():
    # the same preference with a shifted lab score (an overall upvote rate the lab score gets wrong) gives the same correction
    emb, venues, upvoted = votes(80)
    a, b = (vote_correction(emb, venues, upvoted, np.full(80, shift), 1.0, 30)["embedding"] for shift in (0.0, 5.0))
    np.testing.assert_allclose(a, b, atol=1e-3)


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
