"""Browser check of the site against the live Firebase project, or against local emulators.

Two headless browsers open a copy of site/ that lists one made-up month (2020-01, which the real
site never shows). Each must see the other's votes and the re-ordering within seconds; adding and
removing a paper is checked too. All test votes and papers are removed again.

The browsers keep their profiles in .cache/site-check/ and the copy is always served on the
same port, so every run votes as the same two anonymous users, logged in as two handles. Firebase refuses new anonymous
sign-ups from an IP address that makes too many (about 100 an hour); fresh profiles on every
run would use that up.

  uv run --with playwright python -m playwright install chromium   # once
  uv run --with playwright python dev/site_check.py

With --emulator, the copy talks to the Firestore and Auth emulators of firebase/firebase.json
(project demo-statgenpapers, the rules in firebase/firestore.rules), so it tests unpublished rules
and leaves the live project alone. The emulators need Java and `npm install` in firebase/:

  cd firebase && npx firebase emulators:exec --only firestore,auth --project demo-statgenpapers \
    "cd .. && uv run --with playwright python dev/site_check.py --emulator"
"""
import functools
import http.server
import json
import shutil
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).parents[1]
SITE = ROOT / "site"
MONTH = "2020-01"
EMULATOR = "--emulator" in sys.argv
PORT = 8731  # fixed: a browser profile keeps its sign-in per origin
PAPERS = [{"id": f"sitecheck-{i}", "doi": f"10.0000/sitecheck-{i}", "url": f"https://example.org/paper-{i}",
           "title": f"Test paper {i}", "authors": [f"Author {k}" for k in range(1, 2 * i)], "date": f"2020-01-0{i}",
           "venue": "Biorxiv:genetics" if i == 2 else "NG", "venue_name": "bioRxiv · genetics" if i == 2 else "Nature Genetics",
           "journal": "bioRxiv" if i == 2 else "Nat Genet",
           "type": "preprint" if i == 2 else "published", "abstract": f"Abstract Body of abstract {i}.",
           "short_name": f"NatGenet_Tester_2020_TestPaper{i}", "score": 5.0 - i, "rank": i} for i in range(1, 5)]
ADD_URL = "https://doi.org/10.1038/s41586-020-2308-7"  # a real DOI, for the Crossref lookup (gnomAD, Karczewski 2020)
failed = False


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def check(label, ok):
    global failed
    failed |= not ok
    print("PASS" if ok else "FAIL", label, flush=True)


def seen(locator, text, timeout=15):
    """Seconds until `locator` shows `text`, or None."""
    t0 = time.time()
    try:
        expect(locator).to_have_text(text, timeout=timeout * 1000)
        return time.time() - t0
    except AssertionError:
        return None


with tempfile.TemporaryDirectory() as tmp, sync_playwright() as pw:
    shutil.copytree(SITE, tmp, dirs_exist_ok=True, ignore=shutil.ignore_patterns("data"))
    (Path(tmp) / "data").mkdir()
    (Path(tmp) / "data" / "index.json").write_text(json.dumps({"months": [MONTH]}))
    (Path(tmp) / "data" / f"{MONTH}.json").write_text(json.dumps({"month": MONTH, "pool": 99, "papers": PAPERS}))
    if EMULATOR:  # point the copy at the local emulators; the site itself has no emulator code
        app, config = Path(tmp) / "app.js", Path(tmp) / "config.js"
        for path, old, new in [
            (app, "user = fb.getAuth(instance);", 'user = fb.getAuth(instance); fb.connectAuthEmulator(user, "http://127.0.0.1:9099", { disableWarnings: true });'),
            (app, "db = fb.initializeFirestore(instance, { experimentalForceLongPolling: true });",
             'db = fb.initializeFirestore(instance, { experimentalForceLongPolling: true }); fb.connectFirestoreEmulator(db, "127.0.0.1", 8085);'),
            (config, 'projectId: "statgenpapers"', 'projectId: "demo-statgenpapers"')]:
            assert old in path.read_text(), f"{path.name} changed: update the emulator patch in dev/site_check.py"
            path.write_text(path.read_text().replace(old, new))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(Quiet, directory=tmp))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_port}/"

    prompts, errors, pages = [], [], []
    for profile in "ab":  # two separate browser profiles: two anonymous users, logged in as two handles
        profile_dir = Path(tmp) / f"profile-{profile}" if EMULATOR else ROOT / ".cache" / "site-check" / profile  # emulator: fresh users are free
        context = pw.chromium.launch_persistent_context(profile_dir, permissions=["clipboard-read", "clipboard-write"])
        page = context.pages[0]
        page.on("dialog", lambda d: (prompts.append(d.message), d.accept()))
        page.on("popup", lambda p: prompts.append("popup"))
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(url)
        try:
            expect(page.locator("li.paper .up:not([disabled])")).to_have_count(4, timeout=30000)
        except AssertionError:
            sys.exit("voting did not become available: is Firebase refusing new anonymous sign-ups from this address? Try again later.")
        if page.inner_text("#login-open") == "login":  # the handle is remembered in the profile
            page.click("#login-open")
            page.fill("#login-handle", f"sitecheck_{profile}")
            page.click("#login button[type=submit]")
        pages.append(page)
    a, b = pages
    row = lambda page, n: page.locator("li.paper", has_text=f"Test paper {n}")
    order = lambda page: [t[-1] for t in page.locator("li.paper .title").all_inner_texts()]
    count = lambda page, n: row(page, n).locator(".count")  # the number under the upvote triangle
    pressed = lambda page, n: row(page, n).locator(".up").get_attribute("aria-pressed") == "true"
    check("both browsers list the month and can vote after logging in with a handle", order(a) == order(b) == list("1234") and not prompts)

    b.evaluate("() => { window.moves = 0; const animate = Element.prototype.animate;"
               "Element.prototype.animate = function (...args) { window.moves++; return animate.apply(this, args); }; }")
    row(a, 3).locator(".up").click()
    dt = seen(count(b, 3), "1")
    check(f"an upvote in one browser shows in the other ({dt and round(dt, 2)} s)", dt is not None and dt < 5)
    check("the other browser re-orders the list, animated", order(b)[0] == "3" and b.evaluate("window.moves") > 0)
    check("own mark is highlighted (blue) only for the voter", pressed(a, 3) and not pressed(b, 3))
    check("there is no downvote", a.locator("li.paper button").count() == 4)
    row(b, 3).locator(".toggle").click()
    check("the handle shows next to the vote; the abstract opens without its heading",
          "sitecheck_a" in row(b, 3).locator(".voters").inner_text() and row(b, 3).locator(".details p").first.inner_text() == "Body of abstract 3.")

    row(b, 3).locator(".up").click()
    row(b, 4).locator(".up").click()
    check("votes add up, and ties are ordered by score", seen(count(a, 3), "2") is not None and seen(count(a, 4), "1") is not None and order(a) == list("3412"))
    check("(journal, date) shows next to the titles",
          a.locator("li.paper .source").all_inner_texts() == ["(Nat Genet, 2020-01-03)", "(Nat Genet, 2020-01-04)", "(Nat Genet, 2020-01-01)", "(bioRxiv, 2020-01-02)"])
    check("authors show as first two … last two",
          row(a, 4).locator(".meta").inner_text() == "Author 1, Author 2, …, Author 6, Author 7"
          and row(a, 2).locator(".meta").inner_text() == "Author 1, Author 2, Author 3")
    a.click("#copy")
    rows = [line.split("\t") for line in a.evaluate("navigator.clipboard.readText()").split("\n")]
    check("copy table gives Journal, Short Name, Title, URL in the order shown",
          rows[0] == ["Journal", "Short Name", "Title", "URL"] and rows[1] == ["Nat Genet", "NatGenet_Tester_2020_TestPaper3", "Test paper 3", "https://example.org/paper-3"]
          and rows[4][0] == "bioRxiv" and len(rows) == 5)

    row(a, 3).locator(".up").click()
    row(b, 3).locator(".up").click()
    row(b, 4).locator(".up").click()
    check("a voter can take the upvote back", seen(count(b, 3), "0") is not None and seen(count(a, 4), "0") is not None
          and not pressed(a, 3) and order(a) == order(b) == list("1234"))

    rules = urllib.request.Request(f"https://firestore.googleapis.com/v1/projects/statgenpapers/databases/(default)/documents/months/{MONTH}/submissions")
    try:
        EMULATOR or urllib.request.urlopen(rules)
    except urllib.error.HTTPError:
        print("SKIP adding a paper: the submissions rule of firebase/firestore.rules is not published")
    else:
        a.click("#add-open")
        a.fill("#add-url", ADD_URL)
        a.locator("#add-url").blur()
        a.fill("#add-journal", "Nature")
        expect(a.locator("#add-title")).not_to_have_value("", timeout=15000)  # title filled from Crossref
        check("the short name is generated from journal, first author, year and title",
              seen(a.locator("#add-short"), "") is not None and a.input_value("#add-short") == "Nature_Karczewski_2020_MutationalConstraintSpectrumQuantified")
        a.click("#add button[type=submit]")
        added = lambda page: page.locator("li.paper", has_text="mutational constraint spectrum")
        dt = seen(added(b).locator(".count"), "1")
        check(f"a paper added in one browser shows in the other, upvoted by its submitter ({dt and round(dt, 2)} s)", dt is not None and dt < 5)
        check("it shows its journal and who added it", added(b).locator(".source").inner_text() == "(Nature)"
              and added(b).locator(".meta").inner_text() == "added by sitecheck_a")
        a.click("#add-open")
        a.fill("#add-url", ADD_URL + "?again")
        a.fill("#add-journal", "Nature")
        a.fill("#add-title", "Same paper again")
        a.click("#add button[type=submit]")
        check("the same paper cannot be added twice", "already on the list" in a.inner_text("#add-note"))
        a.click("#add-cancel")
        check("only the submitter can remove it", added(a).locator(".remove").is_visible() and not added(b).locator(".remove").is_visible())
        added(a).locator(".up").click()  # take the automatic upvote back, then remove the paper
        seen(added(b).locator(".count"), "0")
        n = len(prompts)
        added(a).locator(".remove").click()
        try:
            expect(added(b)).to_have_count(0, timeout=15000)
            check("removing it removes it everywhere, after a confirmation", len(prompts) == n + 1)
        except AssertionError:
            check("removing it removes it everywhere", False)
        prompts = prompts[:n]

    check(f"no prompt, popup or page error {prompts + errors}", not prompts and not errors)
    for page in pages:
        page.context.close()
    server.shutdown()
sys.exit(failed)
