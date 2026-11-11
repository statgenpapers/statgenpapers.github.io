// StatGen Papers: static list from data/*.json, live interest marks and reader-added papers from Firestore.
import { firebaseConfig } from "./config.js";

const SDK = "https://www.gstatic.com/firebasejs/11.10.0";  // also preloaded in index.html: change both
const TABLE_HEADER = ["Journal", "Short Name", "Title", "URL"];
const STOPWORDS = new Set("a an and are as at by for from in into is of on or the to via with across between through using".split(" "));
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls || "", textContent: text ?? "" });
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const state = {
  months: [], month: null, data: null,
  votes: new Map(),  // paper id -> Set of handles interested in it
  subs: [],          // papers added by readers
  uid: null,
  handle: "",        // the reader's handle, lower case; "" when logged out
  view: "list",      // "list" (a month), "user" or "interested" (pages of the logged-in handle)
  waiting: new Set(),  // first snapshots a month's first draw waits for: "votes", "submissions"
};
const rows = new Map();  // paper id -> <li>
const voting = new Set();  // paper ids with a mark write in flight: a second click must wait for it
let fb = null, db = null, unsubscribe = [], offline = false;  // offline: Firebase failed to load
let dbReady, afterLogin = null;  // afterLogin: the action that asked for a handle, run once one is given
const connected = new Promise((resolve) => { dbReady = resolve; });  // settles once Firestore is set up, or failed

// ---------------------------------------------------------------- helpers

// A short message at the bottom; with `undo`, it offers an "undo" button. It stays while the pointer or focus is on it.
function toast(message, undo) {
  const t = $("toast");
  t.replaceChildren(message);
  if (undo) {
    const button = el("button", "undo", "undo");
    button.addEventListener("click", () => { hideToast(); undo(); });
    t.append(" ", button);
  }
  toast.ms = undo ? 8000 : 5000;
  startToast();
}
function startToast() {
  clearTimeout(toast.timer);
  toast.timer = setTimeout(hideToast, toast.ms);
}
function hideToast() {
  clearTimeout(toast.timer);
  $("toast").replaceChildren();  // empty, not hidden: screen readers announce each new message
}

const monthName = (m) => m.replace("-", "/");  // 2026-10 -> 2026/10
const httpUrl = (url) => (/^https?:\/\/\S+$/i.test(url) ? url : null);
const stripTags = (s) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
const source = (p) => `(${[p.journal, p.date?.replaceAll("-", "/")].filter(Boolean).join(", ")})`;  // dates as months are written: 2026/10/05

// DOI shown in a paper URL, without a preprint version; "" if none
function urlDoi(url) {
  const m = url.match(/10\.\d{4,9}\/[^\s?#]+/);
  return m ? m[0].replace(/(\.full|\.abstract|\/full|\/abstract)$/, "").replace(/v\d+$/, "").toLowerCase() : "";
}

// Sheet-style label Journal_Surname_Year_Keyword. Keep in step with short_name() in pipeline/output.py.
export function shortName(journal, surname, year, title) {
  const t = title.replace(/['’]s\b|['’]/g, "");
  const colon = t.indexOf(":");
  const head = colon > 0 && t.slice(0, colon).trim().split(/\s+/).length <= 3 ? t.slice(0, colon) : t;
  const words = (head.match(/[\p{L}\p{N}]+/gu) || []).filter((w) => !STOPWORDS.has(w.toLowerCase())).slice(0, 4);
  const alnum = (s) => String(s || "").replace(/[^\p{L}\p{N}]/gu, "");
  return [alnum(journal), alnum(surname), year, words.map((w) => (w !== w.toLowerCase() ? w : w[0].toUpperCase() + w.slice(1))).join("")]
    .filter(Boolean).join("_");
}

// A handle is the reader's login: no password, so anyone who types it marks as its owner. Handles are
// lower case, so one handle has one mark per paper on any device: months/{m}/votes/{paper}~{handle}.
const HANDLE = /^[A-Za-z0-9_]{2,20}$/;
const count = (id) => state.votes.get(id)?.size ?? 0;
const mine = (id) => Boolean(state.handle) && (state.votes.get(id)?.has(state.handle) ?? false);
const voteRef = (month, id, handle = state.handle) => fb.doc(db, "months", month, "votes", `${id}~${handle}`);

// Listed papers and reader-added papers in one shape
function items() {
  const listed = state.data?.papers || [], dois = new Set(listed.map((p) => p.doi));
  return [...listed, ...state.subs.filter((s) => !dois.has(urlDoi(s.url))).map((s) => ({ ...s, added: true }))];
}

// By marks; equal marks by score. Added papers have no score: after the scored ones, oldest first.
function visible() {
  const score = (p) => p.score ?? -Infinity, age = (p) => p.created ?? 0;
  return items().sort((a, b) => count(b.id) - count(a.id) || (score(a) === score(b) ? age(a) - age(b) : score(b) - score(a)));
}

const link = (handler) => (event) => { event.preventDefault(); handler(event); };

// A month's data file, fetched once per page load
const monthFiles = new Map();
function monthData(m) {
  if (!monthFiles.has(m)) {
    monthFiles.set(m, fetch(`data/${m}.json`, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : { papers: [] }), () => ({ papers: [] })));
  }
  return monthFiles.get(m);
}

// ---------------------------------------------------------------- rendering

function createRow(p) {
  const li = $("row").content.firstElementChild.cloneNode(true);
  const q = (sel) => li.querySelector(sel);
  const url = httpUrl(p.url);
  q(".title").textContent = p.title;
  url ? (q(".title").href = url) : q(".title").removeAttribute("href");
  q(".source").textContent = source(p);
  q(".source").title = p.venue_name || "";
  const a = p.authors || [], cut = a.length === 100;  // a preprint source may cut the list at 100 authors
  q(".meta").textContent = p.added ? "added by a reader"
    : a.length <= 4 ? a.join(", ") : `${a.slice(0, 2).join(", ")}, …${cut ? "" : `, ${a.slice(-2).join(", ")}`}`;  // first two … last two
  if (p.p_pick != null) {
    q(".pick").textContent = `${Math.round(100 * p.p_pick)}%`;
    q(".pick").title = `Calibrated chance the lab picks this paper (raw score ${p.score.toFixed(2)})`;
  }
  q(".toggle").addEventListener("click", link(() => {
    const open = q(".details").hidden;
    q(".details").hidden = !open;
    q(".toggle").setAttribute("aria-expanded", open);
  }));
  q(".up").addEventListener("click", () => vote(p.id));
  q(".remove").addEventListener("click", link(() => removeSubmission(p)));
  li.addEventListener("animationend", () => li.classList.remove("new"));

  const details = q(".details");
  if (!p.added) {
    details.append(el("p", "", tidyAbstract(p.abstract || "") || "No abstract available."));
    if (a.length > 4) details.append(el("p", "authors", `Authors: ${a.join(", ")}${cut ? ", …" : ""}`));
  }
  return li;
}

// OpenAlex abstracts lose their markup: "5×10<sup>−8</sup>)" arrives as "5x10 -8 )". Restore the exponent
// after a "×10" or "= 10", drop the spaces inside brackets and before punctuation, and drop a leading "Abstract".
const SUPERSCRIPT = Object.fromEntries([..."0123456789-−–"].map((c, i) => [c, "⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁻⁻"[i]]));
function tidyAbstract(text) {
  return text.replace(/^abstract[\s:.]+(?=[A-Z])/i, "")
    .replace(/(?<=\d ?[x×] ?|[=<>≤≥] ?)10 ?([-−–]?\d{1,3})\b/g, (_, e) => `10${[...e].map((c) => SUPERSCRIPT[c]).join("")}`)
    .replace(/\( /g, "(").replace(/ ([),;.])(?=[\s),;.]|$)/g, "$1");
}

function updateRow(li, p) {
  const n = count(p.id), own = mine(p.id), q = (sel) => li.querySelector(sel);
  q(".count").textContent = n;
  q(".count").title = `${n} interested`;
  q(".up").setAttribute("aria-pressed", own);
  q(".up").setAttribute("aria-label", own ? "Not interested any more" : "Interested");
  q(".up").title = state.handle ? (own ? "Not interested any more" : "Interested") : "Log in with a handle to mark papers you are interested in";
  q(".up").disabled = !state.uid;
  q(".remove-wrap").hidden = !p.added || p.uid !== state.uid;
}

function render() {
  const list = $("list");
  if (state.view === "list" && (!state.data || state.waiting.size)) return renderBar();
  const before = new Map([...list.children].map((li) => [li, li.getBoundingClientRect().top]));
  const nodes = visible().map((p) => {
    if (!rows.has(p.id)) rows.set(p.id, createRow(p));
    updateRow(rows.get(p.id), p);
    return rows.get(p.id);
  });
  const sameRows = nodes.length === list.children.length && [...list.children].every((li) => li.isConnected && nodes.includes(li));
  const reorder = nodes.some((n, i) => n !== list.children[i]);
  if (sameRows && reorder && reading()) {  // counts are updated in place; the order follows once the reader pauses
    clearTimeout(render.held);
    render.held = setTimeout(render, 1000);
    return renderBar();
  }
  if (!nodes.length) {
    list.replaceChildren(el("li", "empty", "No list for this month yet."));
  } else if (!sameRows || reorder) {
    const focused = document.activeElement;
    list.replaceChildren(...nodes);
    if (focused && list.contains(focused)) focused.focus({ preventScroll: true });
    if (!reduceMotion) {
      for (const li of nodes) {  // FLIP: start each row where it was, let it glide to its new place
        const dy = before.has(li) ? before.get(li) - li.getBoundingClientRect().top : 0;
        if (Math.abs(dy) <= 1) continue;
        const far = Math.abs(dy) > li.offsetHeight;  // passes other rows: draw it above them
        if (far) li.classList.add("lift");
        const glide = li.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 300, easing: "cubic-bezier(.2, 0, 0, 1)" });
        if (far) glide.finished.then(() => li.classList.remove("lift"), () => li.classList.remove("lift"));
      }
    }
  }
  renderBar();
}

// Someone is reading: a details panel is open, or the page was scrolled, or the list pointed at or
// typed in, within the last 3 s. Re-ordering then would move the row being read.
let lastInput = 0;
const reading = () => Date.now() - lastInput < 3000 || Boolean($("list").querySelector(".details:not([hidden])"));

function renderBar() {
  // a month's list names its month at the end of the top bar, in the darker blue: "latest | past | add | 2026/10"
  const listed = state.view === "list" && state.month;
  $("viewing-wrap").hidden = !listed;
  $("viewing").textContent = listed ? monthName(state.month) : "";
  $("me-wrap").hidden = $("interested-wrap").hidden = !state.handle;
  $("me").textContent = state.handle;
  $("me").classList.toggle("current", state.view === "user");
  $("interested-open").classList.toggle("current", state.view === "interested");
  $("copy-wrap").hidden = state.view !== "list";
  $("login-open").textContent = state.handle ? "logout" : "login";
}

// ---------------------------------------------------------------- data

async function loadMonth(month) {
  state.view = "list";
  $("listview").hidden = false;
  $("page").hidden = true;
  state.month = month;
  state.data = null;
  rows.clear();
  // Stale-while-revalidate: a month seen before shows at once in its last-seen order, and only changes
  // glide in. A first visit waits for the marks (at most 3 s), so it too opens already in order.
  const saved = readMarks(month);
  state.votes = saved?.votes ?? new Map();
  state.subs = saved?.subs ?? [];
  state.waiting = new Set(saved || offline ? [] : ["votes", "submissions"]);
  clearTimeout(loadMonth.timer);
  loadMonth.timer = setTimeout(() => { state.waiting.clear(); render(); }, 3000);
  history.replaceState(null, "", month === state.months.at(-1) ? location.pathname : `?month=${month}`);
  closeForm();
  listen();
  const data = await monthData(month);
  if (state.month !== month) return;  // the reader moved on while this was loading
  state.data = data;
  $("journals").replaceChildren(...[...new Set(items().map((p) => p.journal))].sort().map((j) => Object.assign(el("option"), { value: j })));
  render();
}

function listen() {
  unsubscribe.forEach((stop) => stop());
  unsubscribe = [];
  if (!db || !state.month || state.view !== "list") return;
  const month = state.month, at = (name) => fb.collection(db, "months", month, name);
  unsubscribe.push(fb.onSnapshot(at("votes"), (snap) => {
    state.votes = new Map();
    for (const d of snap.docs) {
      const { paper, handle } = d.data();
      if (!state.votes.has(paper)) state.votes.set(paper, new Set());
      state.votes.get(paper).add(handle);
    }
    arrived("votes");
  }, (e) => { console.warn("votes", e); arrived("votes"); toast("Marking is unavailable right now; the list is still readable."); }));
  unsubscribe.push(fb.onSnapshot(at("submissions"), (snap) => {
    state.subs = snap.docs.map((d) => {
      const s = d.data({ serverTimestamps: "estimate" });
      return { ...s, id: d.id, created: s.created?.toMillis() ?? Date.now() };
    });
    arrived("submissions");
  }, (e) => { console.warn("submissions", e); arrived("submissions"); }));
}

function arrived(name) {
  state.waiting.delete(name);
  saveMarks();
  render();
}

// The month's marks as last seen, in this browser only: counts and this handle's own marks, never other
// handles; added papers without the adder's handle. Placeholder entries stand in for others' marks
// until the first snapshot replaces them.
function saveMarks() {
  if (state.waiting.size) return;  // not before both snapshots are in
  const counts = Object.fromEntries([...state.votes].map(([id, handles]) => [id, handles.size]));
  const own = [...state.votes].filter(([, handles]) => handles.has(state.handle)).map(([id]) => id);
  const subs = state.subs.map(({ name, ...s }) => s);
  try { localStorage.setItem(`marks:${state.month}`, JSON.stringify({ counts, own, handle: state.handle, subs })); } catch {}
}

function readMarks(month) {
  try {
    const saved = JSON.parse(localStorage.getItem(`marks:${month}`));
    if (!saved) return null;
    const own = new Set(saved.handle === state.handle ? saved.own : []);
    const votes = new Map(Object.entries(saved.counts).map(([id, n]) => {
      const handles = new Set(own.has(id) ? [state.handle] : []);
      while (handles.size < n) handles.add(`\u0000${handles.size}`);  // not a valid handle: never matches or deletes
      return [id, handles];
    }));
    return { votes, subs: saved.subs };
  } catch {
    return null;
  }
}

async function connect() {
  try {
    const [app, auth, firestore] = await Promise.all(["app", "auth", "firestore"].map((m) => import(`${SDK}/firebase-${m}.js`)));
    fb = { ...auth, ...firestore };
    const instance = app.initializeApp(firebaseConfig), user = fb.getAuth(instance);
    // Long-polling, not the default streaming with proxy auto-detection: in tests the default showed
    // another browser's mark more than half a minute late after about 1 page load in 50.
    db = fb.initializeFirestore(instance, { experimentalForceLongPolling: true });
    dbReady();
    listen();  // marks are public: read them at once, while this browser signs in (needed only to write)
    fb.onAuthStateChanged(user, (u) => { state.uid = u?.uid || null; render(); });
    await user.authStateReady();
    if (!user.currentUser) {  // silent: no prompt; the handle, not this id, is what marks
      await fb.signInAnonymously(user).catch((e) => { console.warn(e); toast("Marking is unavailable right now; the list is still readable."); });
    }
  } catch (e) {
    dbReady();
    offline = true;
    state.waiting.clear();
    render();
    console.warn(e);
    toast("Marking is unavailable right now; the list is still readable.");
  }
}

// ---------------------------------------------------------------- writes

// Without a handle, open the login form and remember what to do once one is given.
function needHandle(action) {
  if (state.handle) return false;
  afterLogin = action;
  if ($("login").hidden) openPanel("login");
  else $("login-handle").focus();
  return true;
}

// Mark a paper, or take the mark back if this handle already gave one.
async function vote(id) {
  if (!state.uid) return toast("Still connecting; try again in a moment.");
  if (needHandle(() => vote(id).then(() => rows.get(id)?.scrollIntoView({ block: "center" })))) return;
  if (voting.has(id)) return;
  voting.add(id);
  try {
    if (mine(id)) await fb.deleteDoc(voteRef(state.month, id));
    else await fb.setDoc(voteRef(state.month, id), { paper: id, handle: state.handle });
  } catch (e) {
    console.warn(e);
    toast("Your mark was not saved.");
  } finally {
    voting.delete(id);
  }
}

// Remove a paper this browser added, and its marks, which would otherwise be read on every visit.
async function removeSubmission(p) {
  if (!confirm(`Remove "${p.title}" from the list?`)) return;
  try {
    await Promise.all([...(state.votes.get(p.id) ?? [])].filter((h) => HANDLE.test(h)).map((handle) => fb.deleteDoc(voteRef(state.month, p.id, handle))));
    await fb.deleteDoc(fb.doc(db, "months", state.month, "submissions", p.id));
  } catch (e) {
    console.warn(e);
    toast("Could not remove the paper.");
  }
}

// ---------------------------------------------------------------- login, past months

function setHandle(handle) {
  state.handle = handle;
  try { handle ? localStorage.setItem("handle", handle) : localStorage.removeItem("handle"); } catch {}
  render();
}

function login(event) {
  event.preventDefault();
  const handle = $("login-handle").value.trim().toLowerCase();  // handles are lower case: one spelling, one Firestore query
  if (!HANDLE.test(handle)) {
    $("login-note").textContent = "A handle is 2–20 letters, digits or _.";
    return $("login-handle").focus();
  }
  const action = afterLogin;
  setHandle(handle);
  closeLogin();
  action?.();
}

function closeLogin() {
  $("login").hidden = true;
  $("login-note").textContent = "";
  afterLogin = null;
  $("login-open").focus({ preventScroll: true });
}

function toggleScoreNote(open = $("score-note").hidden) {
  $("score-note").hidden = !open;
  $("score-help").setAttribute("aria-expanded", open);
}

// "past": a drop-down of all months under the link; it covers the page instead of moving it.
function togglePast(open = $("past").hidden) {
  const past = $("past");
  if (open) {
    past.replaceChildren(...[...state.months].reverse().map((m) => {
      const a = Object.assign(el("a", m === state.month && state.view === "list" ? "current" : "", monthName(m)), { href: `?month=${m}` });
      a.addEventListener("click", link(() => { go({ month: m }); $("past-open").focus({ preventScroll: true }); }));
      return a;
    }));
  }
  past.hidden = !open;
  $("past-open").setAttribute("aria-expanded", open);
}

// ---------------------------------------------------------------- pages of the logged-in handle

// The URL says what to show: ?user=h, ?interested=h, ?month=YYYY-MM, or nothing for the latest month.
// The handle pages open only for the handle logged in here: nobody browses another reader's marks.
function route() {
  const q = new URLSearchParams(location.search), month = q.get("month"), own = (h) => h && state.handle && h.toLowerCase() === state.handle;
  if (own(q.get("user"))) return showUser();
  if (own(q.get("interested"))) return showInterested();
  return loadMonth(state.months.includes(month) ? month : state.months.at(-1));
}

// Every navigation adds a history entry, so Back returns to the previous month or page.
function go(params) {
  history.pushState(null, "", `?${new URLSearchParams(params)}`);
  togglePast(false);
  return route();
}

// Every paper the logged-in handle is interested in, newest month first: [{ month, paper }].
async function myMarks() {
  await connected;
  if (!db) throw new Error("Firestore is unavailable");
  const handle = state.handle;
  const months = await Promise.all(state.months.map(async (m) => {
    // Only this handle's marks are read (a query costs one read per result, at least one); a month's data
    // file only if it has a mark, and its added papers only if a marked paper is not in that file.
    const marks = (await fb.getDocs(fb.query(fb.collection(db, "months", m, "votes"), fb.where("handle", "==", handle)))).docs.map((d) => d.data().paper);
    if (!marks.length) return [];
    const papers = new Map((await monthData(m)).papers.map((p) => [p.id, p]));
    if (marks.some((id) => !papers.has(id))) {
      for (const d of (await fb.getDocs(fb.collection(db, "months", m, "submissions"))).docs) papers.set(d.id, { ...d.data(), id: d.id, added: true });
    }
    return marks.filter((id) => papers.has(id)).map((id) => ({ month: m, paper: papers.get(id) }));
  }));
  return months.reverse().flat();
}

function showPage(view, ...content) {
  state.view = view;
  unsubscribe.forEach((stop) => stop());
  unsubscribe = [];
  closeForm();
  $("listview").hidden = true;
  $("page").hidden = false;
  $("page").replaceChildren(...content);
  render();
}

async function showUser() {
  const handle = state.handle, total = el("span", "", "…"), table = el("div", "user");
  for (const [label, value] of [["user:", el("span", "", handle)], ["interested in:", total]]) {
    const row = el("div", "row");
    row.append(el("span", "label", label), value);
    table.append(row);
  }
  const shown = Object.assign(el("a", "", "interested papers"), { href: `?interested=${handle}` });
  shown.addEventListener("click", link(() => go({ interested: handle })));
  const more = el("p");
  more.append(shown);
  showPage("user", table, more);
  try {
    const marks = await myMarks();
    if (state.view !== "user" || state.handle !== handle) return;
    total.textContent = `${marks.length} paper${marks.length === 1 ? "" : "s"}`;
  } catch (e) {
    console.warn(e);
    total.textContent = "unavailable";
  }
}

async function showInterested() {
  const handle = state.handle, list = el("ol", "list marks");
  list.append(el("li", "empty", "Loading…"));
  showPage("interested", el("p", "page-head", "Papers you are interested in"), list);
  let marks;
  try {
    marks = await myMarks();
  } catch (e) {
    console.warn(e);
    list.replaceChildren(el("li", "empty", "Unavailable right now; try again later."));
    return;
  }
  if (state.view !== "interested" || state.handle !== handle) return;
  if (!marks.length) return list.replaceChildren(el("li", "empty", "Nothing yet: click the triangle beside a paper."));
  list.replaceChildren(...marks.map(({ month, paper: p }) => {
    const li = el("li", "mark"), title = el("a", "title", p.title), url = httpUrl(p.url);
    if (url) Object.assign(title, { href: url, target: "_blank", rel: "noopener noreferrer" });
    const monthLink = Object.assign(el("a", "", monthName(month)), { href: `?month=${month}` });
    monthLink.addEventListener("click", link(() => go({ month })));
    const undo = Object.assign(el("a", "", "not interested"), { href: "#" });
    undo.addEventListener("click", link(async () => {
      const ref = voteRef(month, p.id, handle);
      try {
        await fb.deleteDoc(ref);
        li.hidden = true;
        toast("Removed.", async () => {
          try {
            await fb.setDoc(ref, { paper: p.id, handle });
            li.hidden = false;
          } catch (e) {
            console.warn(e);
            toast("Could not restore the mark.");
          }
        });
      } catch (e) {
        console.warn(e);
        toast("Could not remove the mark.");
      }
    }));
    const sub = el("div", "sub");
    sub.append(monthLink, " · ", undo);
    li.append(title, " ", el("span", "source", source(p)), sub);
    return li;
  }));
}

// ---------------------------------------------------------------- add a paper

const form = { lookup: {}, edited: false };
const field = (name) => $(`add-${name}`);

function note(message, error = false) {
  $("add-note").textContent = message;
  $("add-note").classList.toggle("error", error);
}

function refreshShortName() {
  if (form.edited) return;
  field("short").value = field("journal").value.trim() && field("title").value.trim()
    ? shortName(field("journal").value.trim(), form.lookup.surname, form.lookup.year || state.month.slice(0, 4), field("title").value)
    : "";
}

// First author and year from Crossref, for the short name; fills the title if it is still empty.
async function lookUp() {
  const doi = urlDoi(field("url").value);
  if (doi === form.lookup.doi) return;
  form.lookup = { doi };
  if (doi) {
    try {
      const response = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
      const work = response.ok ? (await response.json()).message : {};
      if (form.lookup.doi !== doi) return;
      form.lookup = { doi, surname: work.author?.[0]?.family, year: work.issued?.["date-parts"]?.[0]?.[0] };
      if (!field("title").value.trim() && work.title?.[0]) field("title").value = stripTags(work.title[0]);
      note(form.lookup.surname ? "" : "Could not find the first author; add the surname to the short name if you like.");
    } catch (e) {
      console.warn(e);
    }
  }
  refreshShortName();
}

async function submitPaper(event) {
  event.preventDefault();
  const paper = { journal: field("journal").value.trim(), title: field("title").value.trim(), url: field("url").value.trim(), short_name: field("short").value.trim() };
  if (!state.uid) return note("Still connecting; try again in a moment.", true);
  if (needHandle(() => { openPanel("add"); })) return;
  if (!httpUrl(paper.url)) return note("The URL must start with http:// or https://.", true);
  const doi = urlDoi(paper.url);
  if (items().some((p) => p.url === paper.url || (doi && (p.doi || urlDoi(p.url)) === doi))) return note("This paper is already on the list.", true);
  try {
    const ref = await fb.addDoc(fb.collection(db, "months", state.month, "submissions"),
      { ...paper, uid: state.uid, created: fb.serverTimestamp(), name: state.handle });
    closeForm();
    $("add-open").focus({ preventScroll: true });
    await vote(ref.id);  // adding a paper marks it, and the mark can be taken back like any other
    rows.get(ref.id)?.classList.add("new");
    rows.get(ref.id)?.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
  } catch (e) {
    console.warn(e);
    note("The paper was not added. Please try again later.", true);
  }
}

function closeForm() {
  $("add").hidden = true;
  $("add").reset();
  form.lookup = {};
  form.edited = false;
  note("");
}

// Show one of the two forms (login, add), or hide it if it is open.
function openPanel(name) {
  const other = name === "add" ? "login" : "add";
  $(other).hidden = true;
  $(name).hidden = !$(name).hidden;
  if (!$(name).hidden) $(name).querySelector("input").focus();
}

// ---------------------------------------------------------------- controls

async function copyTable() {
  const shown = visible();
  const text = [TABLE_HEADER, ...shown.map((p) => [p.journal, p.short_name, p.title, p.url])]
    .map((row) => row.map((cell) => String(cell).replace(/\s+/g, " ")).join("\t")).join("\n");
  try {
    await navigator.clipboard.writeText(text);
    toast(`Copied ${shown.length} rows: ${TABLE_HEADER.join(", ")}.`);
  } catch {
    toast("Copying is blocked in this browser.");
  }
}

async function init() {
  try { const saved = (localStorage.getItem("handle") || "").toLowerCase(); if (HANDLE.test(saved)) state.handle = saved; } catch {}
  connect();  // in parallel with the month index; listening starts once a month is shown
  $("copy").addEventListener("click", link(copyTable));
  $("add-open").addEventListener("click", link(async () => {
    if (state.view !== "list") await go({});  // a paper is added to the month shown
    openPanel("add");
  }));
  $("add-cancel").addEventListener("click", link(() => { closeForm(); $("add-open").focus({ preventScroll: true }); }));
  $("add").addEventListener("submit", submitPaper);
  $("login-open").addEventListener("click", link(() => {
    if (!state.handle) return openPanel("login");
    setHandle("");
    if (state.view !== "list") go({});  // the handle's own pages close with it
  }));
  $("login-cancel").addEventListener("click", link(closeLogin));
  $("login").addEventListener("submit", login);
  $("past-open").addEventListener("click", link(() => togglePast()));
  $("me").addEventListener("click", link(() => go({ user: state.handle })));
  $("interested-open").addEventListener("click", link(() => go({ interested: state.handle })));
  $("latest").addEventListener("click", link(() => go({})));
  $("score-help").addEventListener("click", link(() => toggleScoreNote()));
  // a click outside a pop-up, or Escape, closes it
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".links .menu")) togglePast(false);
    if (!e.target.closest(".pick-head .menu")) toggleScoreNote(false);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { togglePast(false); toggleScoreNote(false); } });
  for (const type of ["pointermove", "pointerdown", "keydown"]) $("list").addEventListener(type, () => { lastInput = Date.now(); }, { passive: true });
  addEventListener("scroll", () => { lastInput = Date.now(); }, { passive: true });
  // the toast stays while the pointer or focus is on it
  for (const [type, handler] of [["mouseenter", () => clearTimeout(toast.timer)], ["focusin", () => clearTimeout(toast.timer)],
    ["mouseleave", startToast], ["focusout", startToast]]) $("toast").addEventListener(type, () => $("toast").childNodes.length && handler());
  field("url").addEventListener("change", lookUp);
  field("journal").addEventListener("input", refreshShortName);
  field("title").addEventListener("input", refreshShortName);
  field("short").addEventListener("input", () => { form.edited = field("short").value !== ""; });

  const index = await fetch("data/index.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : { months: [] }), () => ({ months: [] }));
  state.months = index.months;
  if (!state.months.length) {
    $("list").replaceChildren(el("li", "empty", "No lists yet."));
    return;
  }
  addEventListener("popstate", route);
  await route();
}

init();
