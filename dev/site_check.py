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
import os
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
           "venue": "Preprint" if i == 2 else "NG", "venue_name": "bioRxiv · genetics" if i == 2 else "Nature Genetics",
           "journal": "bioRxiv" if i == 2 else "Nat Genet",
           "type": "preprint" if i == 2 else "published", "abstract": f"Abstract Body of abstract {i}.",
           "short_name": f"NatGenet_Tester_2020_TestPaper{i}", "score": 5.0 - i, "p_pick": round(0.9 - 0.1 * i, 2), "rank": i} for i in range(1, 5)]
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
        page.on("pageerror", lambda e: errors.append(str(e) + " " + (e.stack or "")[:300]))
        page.goto(url)
        try:
            expect(page.locator("li.paper .up:not([disabled])")).to_have_count(4, timeout=30000)
        except AssertionError:
            sys.exit("voting did not become available: did the month's marks load from Firestore?")
        if page.inner_text("#login-open") == "login":  # the handle is remembered in the profile
            page.click("#login-open")
            page.fill("#login-handle", f"sitecheck_{profile}")
            page.click("#login button[type=submit]")
        pages.append(page)
    a, b = pages
    row = lambda page, n: page.locator("li.paper", has_text=f"Test paper {n}")
    order = lambda page: [t[-1] for t in page.locator("li.paper .title").all_inner_texts()]

    def settles(page, expected, timeout=8):
        """The list reaches `expected` order within `timeout` seconds."""
        t0 = time.time()
        while time.time() - t0 < timeout:
            if order(page) == list(expected):
                return True
            page.wait_for_timeout(200)
        return False
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
    check("there is no downvote", a.locator("li.paper button:not(.added-icon)").count() == 4)
    row(b, 3).locator(".toggle").click()
    check("the abstract opens without its heading, and no handle shows",
          row(b, 3).locator(".details p").first.inner_text() == "Body of abstract 3." and "sitecheck" not in b.inner_text("#list"))
    row(b, 3).locator(".toggle").click()  # closed again

    row(b, 3).locator(".up").click()
    row(b, 4).locator(".up").click()
    check("votes add up, and ties are ordered by score", seen(count(a, 3), "2") is not None and seen(count(a, 4), "1") is not None and settles(a, "3412"))
    check("(journal, date) shows next to the titles",
          a.locator("li.paper .source").all_inner_texts() == ["(Nat Genet, 2020/01/03)", "(Nat Genet, 2020/01/04)", "(Nat Genet, 2020/01/01)", "(bioRxiv, 2020/01/02)"])
    check("authors show as first two … last two",
          row(a, 4).locator(".meta").inner_text() == "Author 1, Author 2, …, Author 6, Author 7"
          and row(a, 2).locator(".meta").inner_text() == "Author 1, Author 2, Author 3")
    a.click("#copy")
    rows = [line.split("\t") for line in a.evaluate("navigator.clipboard.readText()").split("\n")]
    check("copy table gives Journal, Short Name, Title, URL in the order shown",
          rows[0] == ["Journal", "Short Name", "Title", "URL"] and rows[1] == ["Nat Genet", "NatGenet_Tester_2020_TestPaper3", "Test paper 3", "https://example.org/paper-3"]
          and rows[4][0] == "bioRxiv" and len(rows) == 5)

    # Without a connection Firestore answers from its empty cache: the saved counts must stay, and voting wait.
    offline = b.context.new_page()
    offline.route("**/google.firestore.v1.Firestore/**", lambda route: route.abort())
    offline.goto(url)
    offline.wait_for_timeout(12000)  # past the SDK's offline timeout (10 s)
    check("without Firestore, the saved counts stay and voting waits",
          count(offline, 3).inner_text() == "2" and offline.locator("li.paper .up:not([disabled])").count() == 0
          and offline.evaluate(f"JSON.parse(localStorage.getItem('marks:{MONTH}')).counts")["sitecheck-3"] == 2)
    offline.close()

    if EMULATOR:  # a fresh browser: a new anonymous user, free on the emulator
        c = pw.chromium.launch_persistent_context(Path(tmp) / "profile-c").pages[0]
        c.on("pageerror", lambda e: errors.append(str(e)))
        signups = []
        c.on("request", lambda r: "accounts:signUp" in r.url and signups.append(r.url))
        c.goto(url)
        expect(c.locator("li.paper .up:not([disabled])")).to_have_count(4, timeout=30000)
        row(c, 1).locator(".up").click()  # asks for a handle; cancelled, the click is forgotten
        c.click("#login-cancel")
        c.click("#login-open")
        c.fill("#login-handle", "sitecheck_c")
        c.click("#login button[type=submit]")
        c.wait_for_timeout(1500)
        check("a login opened by hand does not carry out an earlier, cancelled click", count(c, 1).inner_text() == "0")
        c.evaluate("() => { for (const li of document.querySelectorAll('li.paper'))"  # two first writes at once
                   "  if (/Test paper [12]$/.test(li.querySelector('.title').textContent)) li.querySelector('.up').click(); }")
        check("writes started together sign in once", seen(count(a, 1), "1") is not None and seen(count(a, 2), "1") is not None
              and len(signups) == 1)
        for n in (1, 2):
            row(c, n).locator(".up").click()
        check("and the marks can be taken back", seen(count(a, 1), "0") is not None and seen(count(a, 2), "0") is not None)
        c.context.close()

    row(a, 3).locator(".up").click()
    row(b, 3).locator(".up").click()
    row(b, 4).locator(".up").click()
    check("a voter can take the upvote back", seen(count(b, 3), "0") is not None and seen(count(a, 4), "0") is not None
          and not pressed(a, 3) and settles(a, "1234") and settles(b, "1234"))

    rules = urllib.request.Request(f"https://firestore.googleapis.com/v1/projects/statgenpapers/databases/(default)/documents/months/{MONTH}/submissions")
    try:
        EMULATOR or urllib.request.urlopen(rules)
    except urllib.error.HTTPError:
        print("SKIP adding a paper: the submissions rule of firebase/firestore.rules is not published")
    else:
        a.click("#add-open")
        a.fill("#add-url", ADD_URL)
        a.locator("#add-url").blur()
        expect(a.locator("#add-authors")).not_to_have_value("", timeout=15000)  # filled from Crossref
        check("the link fills the form from its DOI", a.input_value("#add-journal") == "Nature" and "Karczewski" in a.input_value("#add-authors"))
        check("the abstract box grows to show the filled abstract",
              a.evaluate("() => { const b = document.getElementById('add-abstract'); return b.value.length > 300 && b.offsetHeight > 150 }"))
        a.click("#add button[type=submit]")
        added = lambda page: page.locator("li.paper", has_text="mutational constraint spectrum")
        check("a paper is added to the month in progress, and not shown before its run scores it",
              seen(a.locator("#toast"), "Added to 2020/02; it gets a Score on 2020/03/10.") is not None
              and added(b).count() == 0)
        check("the add page lists it, unscored, under its form",
              a.inner_text("#list-month") == "Added to 2020/02 so far" and seen(added(a).locator(".pct"), "–") is not None
              and a.locator("#add").is_visible())
        a.click("#add-open")
        a.fill("#add-url", ADD_URL.removeprefix("https://doi.org/"))  # a bare DOI
        a.fill("#add-journal", "Nature")
        a.fill("#add-title", "Same paper again")
        a.fill("#add-abstract", "An abstract.")
        a.click("#add button[type=submit]")
        check("the same paper cannot be added twice",
              seen(a.locator("#add-note"), "Someone has added this paper to 2020/02 already: mark it below.") is not None)
        a.fill("#add-url", "https://example.org/other-link")
        a.fill("#add-title", PAPERS[0]["title"].upper() + ".")  # the same title, other case and punctuation
        a.click("#add button[type=submit]")
        check("a paper of an earlier list is warned about, and may be added anyway",
              seen(a.locator("#add-note"), "This paper is on the 2020/01 list already. Add it anyway?") is not None
              and seen(a.locator("#add button[type=submit]"), "add anyway") is not None)
        a.fill("#add-title", PAPERS[0]["title"] + " 2")
        check("an edit checks the form afresh", seen(a.locator("#add button[type=submit]"), "add") is not None)
        paste = ("([name, text]) => { const input = document.getElementById(name); input.value = ''; input.focus();"
                 " const data = new DataTransfer(); data.setData('text/plain', text);"
                 " input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); }")
        a.evaluate(paste, ["add-title", "AlphaGenome 2: deciphering how cells\nread DNA to better under-\nstand disease"])
        a.evaluate(paste, ["add-authors", "Žiga Avsec1,2,*, Natasha Latysheva1\nJun Cheng† and Pushmeet Kohli1"])
        check("text pasted from a PDF goes in tidied: lines joined, author markers dropped",
              a.input_value("#add-title") == "AlphaGenome 2: deciphering how cells read DNA to better understand disease"
              and a.input_value("#add-authors") == "Žiga Avsec, Natasha Latysheva, Jun Cheng, Pushmeet Kohli")
        a.click("#add-cancel")

        # the run for 2020-02: it lists the month, with the added paper scored
        base = "http://127.0.0.1:8085" if EMULATOR else "https://firestore.googleapis.com"
        project = "demo-statgenpapers" if EMULATOR else "statgenpapers"
        docs = json.load(urllib.request.urlopen(f"{base}/v1/projects/{project}/databases/(default)/documents/months/2020-02/submissions"))
        sid = docs["documents"][0]["name"].rsplit("/", 1)[1]
        check("the short name is made on submit from journal, first author, year and title",
              docs["documents"][0]["fields"]["short_name"]["stringValue"] == "Nature_Karczewski_2020_MutationalConstraintSpectrumQuantified")
        (Path(tmp) / "data" / "2020-02.json").write_text(json.dumps({"month": "2020-02", "pool": 99, "papers": PAPERS[3:], "added": {sid: 0.42}}))
        (Path(tmp) / "data" / "index.json").write_text(json.dumps({"months": [MONTH, "2020-02"]}))
        os.utime(Path(tmp) / "data" / "index.json", (time.time() + 2,) * 2)  # the server dates files to the second: no stale 304
        for page in pages:
            page.goto(url)
        dt = seen(added(b).locator(".count"), "1")
        check("after its run, it is listed in both browsers, marked by its submitter", dt is not None)
        check("with its journal, the authors found for its DOI, its Score and the added icon, and no handle",
              added(b).locator(".source").inner_text().startswith("(Nature") and "Karczewski" in added(b).locator(".meta").inner_text()
              and added(b).locator(".pick").inner_text() == "42%" and added(b).locator(".added-icon").is_visible() and row(b, 4).locator(".added-icon").is_hidden()
              and "sitecheck" not in added(b).inner_text())
        added(b).locator(".added-icon").click()
        check("a tap on the icon says, next to it, that the paper was added",
              seen(added(b).locator(".tip"), "Added by a reader, not chosen by the model.") is not None)
        added(a).locator(".added-icon").click()
        check("once listed, nobody can remove it, not even its handle",
              seen(added(a).locator(".tip"), "Added by a reader, not chosen by the model.") is not None and added(a).locator(".tip .remove").count() == 0)
        a.locator("h1").click()  # closes the tip
        added(a).locator(".up").click()  # take the automatic upvote back
        seen(added(b).locator(".count"), "0")

        # back before the run (the month unlisted again): its submitter removes it from the next month's page
        (Path(tmp) / "data" / "index.json").write_text(json.dumps({"months": [MONTH]}))
        os.utime(Path(tmp) / "data" / "index.json", (time.time() + 5,) * 2)  # the server dates files to the second: no stale 304
        for page in pages:
            page.goto(f"{url}?month=2020-02")
        expect(added(b)).to_have_count(1, timeout=15000)
        for page in pages:  # the list first shows the browser's saved copy, without handles; then the live one
            expect(added(page).locator(".up")).to_be_enabled(timeout=15000)
        try:  # once the live submissions, with handles, are in
            expect(added(a).locator(".added-icon")).to_have_attribute("title", "Added by you; tap to remove", timeout=15000)
            added(b).locator(".added-icon").click()
            others = seen(added(b).locator(".tip"), "Added by a reader, not chosen by the model.") is not None and added(b).locator(".tip .remove").count() == 0
            added(a).locator(".added-icon").click()
            check("before the run, only its handle can remove it, from the icon's tip",
                  others and seen(added(a).locator(".tip"), "Added by you, not chosen by the model.remove") is not None)
            if shots := os.environ.get("SITE_CHECK_SHOTS"):  # a picture of the submitter's row and its tip, for review
                added(a).screenshot(path=f"{shots}/own-added-row.png")
        except AssertionError:
            check("before the run, only its handle can remove it, from the icon's tip", False)
        n = len(prompts)
        added(a).locator(".tip .remove").click()
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
