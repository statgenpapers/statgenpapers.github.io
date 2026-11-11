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
  waiting: new Set(),  // a month's first snapshots not yet in: "votes", "submissions"; saved marks wait for both
};
const rows = new Map();  // paper id -> <li>
const voting = new Set();  // paper ids with a mark write in flight: a second click must wait for it
let fb = null, db = null, signer = null, unsubscribe = [], offline = false;  // offline: Firebase failed to load
let dbReady, afterLogin = null;  // afterLogin: the action that asked for a handle, run once one is given
const UNAVAILABLE = "Marking and adding are unavailable right now; the list is still readable.";
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
const httpUrl = (url) => (/^https?:\/\/\S+$/.test(url) ? url : null);
const stripTags = (s) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
const source = (p) => `(${[p.journal, p.date?.replaceAll("-", "/")].filter(Boolean).join(", ")})`;  // dates as months are written: 2026/10/05

// DOI shown in a paper URL, without a preprint version, a page suffix or trailing punctuation; "" if none.
// nature.com/articles/X is the paper with DOI 10.1038/X.
function urlDoi(url) {
  const nature = url.match(/nature\.com\/articles\/([^\s?#/]+)/i);
  const doi = nature ? `10.1038/${nature[1]}` : url.match(/10\.\d{4,9}\/[^\s?#]+/)?.[0];
  return doi ? doi.replace(/[.,;)\]]+$/, "").replace(/(\.full\.pdf|\.full-text|\.full|\.abstract|\.pdf|\/full|\/abstract)$/, "").replace(/v\d+$/, "").toLowerCase() : "";
}
const plainTitle = (t) => (t || "").toLowerCase().replace(/<[^>]+>/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// Sheet-style label Journal_Surname_Year_Keyword. Keep in step with short_name() in pipeline/output.py.
export function shortName(journal, surname, year, title) {
  const t = title.replace(/['’]s\b|['’]/g, "");
  const colon = t.indexOf(":");
  const head = colon > 0 && t.slice(0, colon).trim().split(/\s+/).length <= 3 ? t.slice(0, colon) : t;
  const words = (head.match(/[\p{L}\p{N}]+/gu) || []).filter((w) => !STOPWORDS.has(w.toLowerCase())).slice(0, 4);
  const alnum = (s) => String(s || "").replace(/[^\p{L}\p{N}]/gu, "");
  return [alnum(journal), alnum(surname) || "NA", year, words.map((w) => (w !== w.toLowerCase() ? w : w[0].toUpperCase() + w.slice(1))).join("")]
    .filter(Boolean).join("_");
}

// A handle is the reader's login: no password, so anyone who types it marks as its owner. Handles are
// lower case, so one handle has one mark per paper on any device: months/{m}/votes/{paper}~{handle}.
const HANDLE = /^[A-Za-z0-9_]{2,20}$/;
const LAB = "admin";  // the handle whose marks are the lab's picks (dev/rollforward.py); its added papers say so
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

// A link that acts in the page. Ctrl, Cmd or Shift on a link to another page opens that page as the browser would.
const link = (handler) => (event) => {
  if ((event.ctrlKey || event.metaKey || event.shiftKey) && event.currentTarget.getAttribute("href") !== "#") return;
  event.preventDefault();
  handler(event);
};

// A month's data file, fetched once per page load
const monthFiles = new Map();
function monthData(m) {
  if (!monthFiles.has(m)) {
    monthFiles.set(m, fetch(`data/${m}.json`, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
      .catch((e) => { console.warn(e); monthFiles.delete(m); return { papers: [] }; }));  // a failed fetch is tried again next time
  }
  return monthFiles.get(m);
}

// ---------------------------------------------------------------- rendering

function createRow(p) {
  const month = state.month;  // a row belongs to one month: a late click never marks a paper of another
  const li = $("row").content.firstElementChild.cloneNode(true);
  const q = (sel) => li.querySelector(sel);
  const url = httpUrl(p.url);
  q(".title").textContent = p.title;
  url ? (q(".title").href = url) : q(".title").removeAttribute("href");
  q(".source").textContent = source(p);
  q(".source").title = p.venue_name || "";
  const a = p.authors || [], cut = a.length === 100;  // a preprint source may cut the list at 100 authors
  q(".meta").textContent = p.added ? (p.name === LAB || p.lab ? "added by the lab" : "added by a reader")
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
  q(".up").addEventListener("click", () => vote(p.id, month));  // no hover colour: grey or blue only
  q(".remove").addEventListener("click", link(() => removeSubmission(p)));
  li.addEventListener("animationend", () => li.classList.remove("new"));

  const details = q(".details");
  q(".toggle").hidden = Boolean(p.added);  // an added paper has no abstract or authors here
  if (!p.added) {
    details.append(el("p", "", tidyAbstract(p.abstract || "") || "No abstract available."));
    // a consortium paper can list hundreds: the first 30 and the last 5
    const names = a.length > 35 ? [...a.slice(0, 30), "…", ...a.slice(-5)] : cut ? [...a, "…"] : a;
    if (a.length > 4) details.append(el("p", "authors", `Authors: ${names.join(", ")}`));
  }
  return li;
}

// OpenAlex abstracts lose their markup: "5×10<sup>−8</sup>)" arrives as "5x10 -8 )". Restore the exponent
// after "5x10" (signed or after a space) or after "= 10 " (signed only, so "n = 105" and "> 100,000" stay),
// drop the spaces inside brackets and before punctuation, and drop a leading "Abstract".
// No lookbehind: Safari before 16.4 cannot parse it.
const SUPERSCRIPT = Object.fromEntries([..."0123456789-−–"].map((c, i) => [c, "⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁻⁻"[i]]));
const sup = (e) => [...e].map((c) => SUPERSCRIPT[c]).join("");
function tidyAbstract(text) {
  return text.replace(/^abstract[\s:.]+(?=[A-Z])/i, "")
    .replace(/(\d ?[x×] ?10)(?: ?([-−–]\d{1,3})| (\d{1,3}))(?![\d.,]?\d)/g, (_, base, e1, e2) => base + sup(e1 ?? e2))
    .replace(/([=<>≤≥] ?10) ([-−–]\d{1,3})(?![\d.,]?\d)/g, (_, base, e) => base + sup(e))
    .replace(/\( /g, "(").replace(/ ([),;.])(?=[\s),;.]|$)/g, "$1");
}

function updateRow(li, p) {
  const n = count(p.id), own = mine(p.id), q = (sel) => li.querySelector(sel);
  q(".count").textContent = n;
  li.dataset.count = n;
  q(".count").title = `${n} interested`;
  q(".up").setAttribute("aria-pressed", own);
  q(".up").title = state.handle ? (own ? "Not interested any more" : "Interested") : "Log in with a handle to mark papers you are interested in";
  q(".up").disabled = !db || state.waiting.has("votes");  // not before this month's marks are in: a click would toggle a guess
  q(".remove-wrap").hidden = !p.added || p.uid !== state.uid;
}

// The list: (1) shows at once, in the order last seen in this browser or else by score; (2) when marks
// arrive or change, re-sorts at once: passed rows ease aside, a paper whose count changed fades in at
// its new place. README "How it works" says the same.
function render() {
  const list = $("list");
  if (state.view === "list" && !state.data) return renderBar();  // the list shows as soon as its file is in
  const before = new Map([...list.children].map((li) => [li, li.getBoundingClientRect().top]));
  const nodes = visible().map((p) => {
    if (!rows.has(p.id)) rows.set(p.id, createRow(p));
    updateRow(rows.get(p.id), p);
    return rows.get(p.id);
  });
  const sameRows = nodes.length === list.children.length && [...list.children].every((li) => li.isConnected && nodes.includes(li));
  const reorder = nodes.some((n, i) => n !== list.children[i]);
  if (!nodes.length) {
    list.replaceChildren(el("li", "empty", "No list for this month yet."));
  } else if (!sameRows || reorder) {
    const focused = document.activeElement;
    list.replaceChildren(...nodes);
    if (focused && list.contains(focused)) {
      focused.focus({ preventScroll: true });
      if (focused.matches(":focus-visible")) focused.scrollIntoView({ block: "nearest" });  // keyboard focus moved with its row: keep it on screen
    }
    if (!reduceMotion) {
      // Re-sorting, with Material Design 3 motion tokens: the rows a paper passes move aside (standard
      // easing, medium1 = 250 ms), and each paper whose count changed fades in at its new place (emphasized
      // decelerate, medium2 = 300 ms) after short3 = 150 ms, once they have mostly made room.
      for (const li of nodes) {
        const dy = before.has(li) ? before.get(li) - li.getBoundingClientRect().top : 0;
        if (Math.abs(dy) <= 1) continue;
        if (li.dataset.count !== li.dataset.placed) li.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay: 150, easing: "cubic-bezier(.05, .7, .1, 1)", fill: "backwards" });
        else li.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 250, easing: "cubic-bezier(.2, 0, 0, 1)" });
      }
    }
  }
  for (const li of nodes) li.dataset.placed = li.dataset.count;  // the count each row had when the order was last applied
  renderBar();
}

function renderBar() {
  // the list's heading names its month: "Papers of 2026/10"
  const listed = state.view === "list" && state.month;
  $("list-month").textContent = listed ? `Papers of ${monthName(state.month)}` : "Papers";
  $("me-wrap").hidden = $("interested-wrap").hidden = !state.handle;
  $("me").textContent = state.handle;
  $("me").href = `?user=${state.handle}`;
  $("interested-open").href = `?interested=${state.handle}`;
  for (const [a, current] of [[$("me"), state.view === "user"], [$("interested-open"), state.view === "interested"]]) {
    a.classList.toggle("current", current);
    current ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current");
  }
  $("login-open").textContent = state.handle ? "logout" : "login";
  syncExpanded();
  syncAccountSep();
  document.title = { list: listed && state.month !== state.months.at(-1) ? `${monthName(state.month)} · StatGen Papers` : "StatGen Papers",
    user: "Your handle · StatGen Papers", interested: "Interested · StatGen Papers" }[state.view];
}

// When the account block wraps onto two lines, the "|" after "interested" ends a line: hide it.
function syncAccountSep() {
  $("account-sep").hidden = false;
  $("account-sep").hidden = $("login-open").parentElement.offsetTop > $("interested-wrap").offsetTop;
}

// The "add" and "login" links say whether their form is open.
function syncExpanded() {
  $("add-open").setAttribute("aria-expanded", !$("add").hidden);
  if (state.handle) $("login-open").removeAttribute("aria-expanded");  // "logout" opens nothing
  else $("login-open").setAttribute("aria-expanded", !$("login").hidden);
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
  // move; a first visit shows the file's order at once, and the marks re-order it when they arrive.
  const saved = readMarks(month);
  state.votes = saved?.votes ?? new Map();
  state.subs = saved?.subs ?? [];
  state.waiting = new Set(offline ? [] : ["votes", "submissions"]);
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
  // Without a connection Firestore answers from its empty cache: that answer would zero the counts and
  // overwrite the saved copy, so the month waits for the server's first answer.
  const fromServer = (name, snap) => !(snap.metadata.fromCache && state.waiting.has(name));
  const live = { includeMetadataChanges: true };
  unsubscribe.push(fb.onSnapshot(at("votes"), live, (snap) => {
    if (!fromServer("votes", snap)) return;
    state.votes = new Map();
    for (const d of snap.docs) {
      const { paper, handle } = d.data();
      if (!state.votes.has(paper)) state.votes.set(paper, new Set());
      state.votes.get(paper).add(handle);
    }
    arrived("votes");
  }, (e) => { console.warn("votes", e); arrived("votes"); toast(UNAVAILABLE); }));
  unsubscribe.push(fb.onSnapshot(at("submissions"), live, (snap) => {
    if (!fromServer("submissions", snap)) return;
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
  const subs = state.subs.map(({ name, ...s }) => (name === LAB ? { ...s, lab: true } : s));  // no reader's handle; the lab is no secret
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
    signer = user;  // the Auth instance, for the sign-in on the first write
    // Long-polling, not the default streaming with proxy auto-detection: in tests the default showed
    // another browser's mark more than half a minute late after about 1 page load in 50.
    db = fb.initializeFirestore(instance, { experimentalForceLongPolling: true });
    dbReady();
    listen();  // marks are public: reading needs no sign-in
    fb.onAuthStateChanged(user, (u) => { state.uid = u?.uid || null; render(); });
    render();  // the triangles work from here on
  } catch (e) {
    dbReady();
    offline = true;
    state.waiting.clear();
    render();
    console.warn(e);
    toast(UNAVAILABLE);
  }
}

// ---------------------------------------------------------------- writes

// Writes need a signed-in browser. The anonymous sign-in happens on the first write, not on load, so a
// reader who only reads never creates a Firebase user. Silent: no prompt; the handle, not this id, is what marks.
async function signedIn() {
  if (!signer) return toast("Still connecting; try again in a moment."), false;
  await signer.authStateReady();
  if (signer.currentUser) return true;
  // Writes started together (a mark and an added paper, quick clicks) share one sign-in: one Firebase user.
  signedIn.pending ??= fb.signInAnonymously(signer).finally(() => { signedIn.pending = null; });
  try {
    state.uid = (await signedIn.pending).user.uid;
    return true;
  } catch (e) {
    console.warn(e);
    toast("Marking and adding are unavailable right now; try again later.");
    return false;
  }
}

// Without a handle, open the login form and remember what to do once one is given.
function needHandle(action) {
  if (state.handle) return false;
  if ($("login").hidden) openPanel("login");
  else $("login-handle").focus();
  afterLogin = action;  // after opening, which forgets any earlier action
  return true;
}

// Mark a paper of `month`, or take the mark back if this handle already gave one. After a login asked
// for by the click, the paper is scrolled to and its triangle focused.
async function vote(id, month) {
  if (needHandle(() => vote(id, month).then(() => {
    const up = rows.get(id)?.querySelector(".up");
    up?.scrollIntoView({ block: "center" });
    up?.focus({ preventScroll: true });
  }))) return;
  if (month !== state.month || voting.has(id)) return;
  voting.add(id);
  let slow;
  try {
    if (!(await signedIn()) || month !== state.month) return;
    // the mark shows at once; if the server has not confirmed it in 3 s, say so
    slow = setTimeout(() => toast("Not saved yet: waiting for the connection."), 3000);
    if (mine(id)) await fb.deleteDoc(voteRef(month, id));
    else await fb.setDoc(voteRef(month, id), { paper: id, handle: state.handle });
  } catch (e) {
    console.warn(e);
    toast("Your mark was not saved.");
  } finally {
    clearTimeout(slow);
    voting.delete(id);
  }
}

// Remove a paper this browser added, and its marks, which would otherwise be read on every visit.
async function removeSubmission(p) {
  const month = state.month, handles = [...(state.votes.get(p.id) ?? [])].filter((h) => HANDLE.test(h));
  if (!confirm(`Remove "${p.title}" from the list?`)) return;
  try {
    // the paper first: if its marks then fail to go, nobody sees them
    await fb.deleteDoc(fb.doc(db, "months", month, "submissions", p.id));
    await Promise.all(handles.map((handle) => fb.deleteDoc(voteRef(month, p.id, handle))));
  } catch (e) {
    console.warn(e);
    toast("Could not remove the paper.");
  }
}

// ---------------------------------------------------------------- login, past months

function setHandle(handle) {
  state.handle = handle;
  try { handle ? localStorage.setItem("handle", handle) : localStorage.removeItem("handle"); } catch {}
  if (!handle) forgetHandle();
  render();
}

// After a logout, this browser keeps no trace of the handle: not in the login field, not in the saved marks.
function forgetHandle() {
  $("login-handle").value = "";
  try {
    for (const key of Object.keys(localStorage).filter((k) => k.startsWith("marks:"))) {
      const saved = JSON.parse(localStorage.getItem(key));
      localStorage.setItem(key, JSON.stringify({ ...saved, own: [], handle: "" }));
    }
  } catch {}
}

// A login or logout in another tab of this browser applies here too.
function handleChanged(event) {
  if (event.key !== "handle") return;
  const handle = (event.newValue || "").toLowerCase();
  state.handle = HANDLE.test(handle) ? handle : "";
  if (!state.handle) $("login-handle").value = "";
  if (state.view !== "list") go({});  // the handle's own pages close with it
  else render();
}

function login(event) {
  event.preventDefault();
  const handle = $("login-handle").value.trim().toLowerCase();  // handles are lower case: one spelling, one Firestore query
  if (!HANDLE.test(handle) || handle === LAB) {
    $("login-note").textContent = handle === LAB ? "This handle is reserved." : "A handle is 2–20 letters, digits or _.";
    $("login-note").classList.add("error");
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
  $("login-note").classList.remove("error");
  afterLogin = null;
  syncExpanded();
  $("login-open").focus({ preventScroll: true });
}

function toggleScoreNote(open = $("score-note").hidden) {
  $("score-note").hidden = !open;
  $("score-help").setAttribute("aria-expanded", open);
}

// "past": a drop-down of all months under the link; it covers the page instead of moving it.
function togglePast(open = $("past").hidden) {
  const past = $("past");
  if (!state.months.length) open = false;  // nothing to list yet
  if (open) {
    past.replaceChildren(...[...state.months].reverse().map((m) => {
      const current = m === state.month && state.view === "list";
      const a = Object.assign(el("a", current ? "current" : "", monthName(m)), { href: `?month=${m}` });
      if (current) a.setAttribute("aria-current", "page");
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
  const search = String(new URLSearchParams(params));
  if (search !== location.search.slice(1)) history.pushState(null, "", `?${search}`);
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
  renderBar();
}

async function showUser() {
  // the count is the link to the papers: "3 papers", dashed like Details
  const handle = state.handle, total = Object.assign(el("a", "dashed", "…"), { href: `?interested=${handle}` }), table = el("div", "user");
  total.addEventListener("click", link(() => go({ interested: handle })));
  for (const [label, value] of [["handle:", el("span", "", handle)], ["interested in:", total]]) {
    const row = el("div", "row");
    row.append(el("span", "label", label), value);
    table.append(row);
  }
  showPage("user", table);
  try {
    const marks = await myMarks();
    if (state.view !== "user" || state.handle !== handle) return;
    total.textContent = `${marks.length} paper${marks.length === 1 ? "" : "s"}`;
  } catch (e) {
    console.warn(e);
    total.replaceWith(el("span", "", "unavailable"));
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
  const empty = el("li", "empty", "Nothing yet: click the triangle beside a paper.");
  const syncEmpty = () => { empty.remove(); if ([...list.children].every((li) => li.hidden)) list.append(empty); };
  list.replaceChildren(...marks.map(({ month, paper: p }) => {
    const li = el("li", "mark"), title = el("a", "title", p.title), url = httpUrl(p.url);
    if (url) Object.assign(title, { href: url, target: "_blank", rel: "noopener noreferrer" });
    const monthLink = Object.assign(el("a", "", monthName(month)), { href: `?month=${month}` });
    monthLink.addEventListener("click", link(() => go({ month })));
    const undo = Object.assign(el("a", "", "not interested"), { href: "#" });
    undo.addEventListener("click", link(async () => {
      const ref = voteRef(month, p.id, handle);
      try {
        if (!(await signedIn())) return;
        await fb.deleteDoc(ref);
        li.hidden = true;
        syncEmpty();
        toast("Removed.", async () => {
          try {
            await fb.setDoc(ref, { paper: p.id, handle });
            li.hidden = false;
            syncEmpty();
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
  syncEmpty();
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
      note(form.lookup.surname ? "" : "Could not find the first author: the short name says NA; replace it if you like.");
    } catch (e) {
      console.warn(e);
    }
  }
  refreshShortName();
}

async function submitPaper(event) {
  event.preventDefault();
  const paper = { journal: field("journal").value.trim(), title: field("title").value.trim(), url: field("url").value.trim(), short_name: field("short").value.trim() };
  if (needHandle(() => { openPanel("add"); $("add").requestSubmit(); })) return;  // the form keeps its fields while the login shows
  if (!httpUrl(paper.url)) return note("The URL must start with http:// or https://.", true);
  const doi = urlDoi(paper.url), title = plainTitle(paper.title);
  if (items().some((p) => p.url === paper.url || (doi && (p.doi || urlDoi(p.url)) === doi) || plainTitle(p.title) === title)) {
    return note("This paper is already on the list.", true);
  }
  try {
    const month = state.month;
    if (!(await signedIn())) return;
    const ref = await fb.addDoc(fb.collection(db, "months", month, "submissions"),
      { ...paper, uid: state.uid, created: fb.serverTimestamp(), name: state.handle });
    closeForm();
    $("add-open").focus({ preventScroll: true });
    await vote(ref.id, month);  // adding a paper marks it, and the mark can be taken back like any other
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
  syncExpanded();
}

// Show one of the two forms (login, add), or hide it if it is open.
function openPanel(name) {
  const other = name === "add" ? "login" : "add";
  $(other).hidden = true;
  $(name).hidden = !$(name).hidden;
  afterLogin = null;  // the login opened or closed by hand: nothing waits for it
  syncExpanded();
  if (!$(name).hidden) $(name).querySelector("input").focus();
}

// ---------------------------------------------------------------- controls

// The list as shown, as the four-column table: tab-separated, pastes into a spreadsheet.
function tableText(shown) {
  return [TABLE_HEADER, ...shown.map((p) => [p.journal, p.short_name, p.title, p.url])]
    .map((row) => row.map((cell) => String(cell).replace(/\s+/g, " ")).join("\t")).join("\n");
}

// The export menu beside "Papers of 2026/10": copy the table, or download it as a .tsv file.
function toggleExport(open = $("export").hidden) {
  $("export").hidden = !open;
  $("export-open").setAttribute("aria-expanded", open);
}

function downloadTable() {
  const a = Object.assign(el("a"), {
    href: URL.createObjectURL(new Blob([`${tableText(visible())}\n`], { type: "text/tab-separated-values" })),
    download: `statgenpapers-${state.month}.tsv`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function copyTable() {
  const shown = visible(), text = tableText(shown);
  try {
    await navigator.clipboard.writeText(text);
    toast(`Copied ${shown.length} paper${shown.length === 1 ? "" : "s"}: ${TABLE_HEADER.join(", ")}.`);
  } catch {
    toast("Copying is blocked in this browser.");
  }
}

async function init() {
  try { const saved = (localStorage.getItem("handle") || "").toLowerCase(); if (HANDLE.test(saved)) state.handle = saved; } catch {}
  connect();  // in parallel with the month index; listening starts once a month is shown
  $("export-open").addEventListener("click", link(() => toggleExport()));
  $("copy").addEventListener("click", link(() => { toggleExport(false); copyTable(); }));
  $("download").addEventListener("click", link(() => { toggleExport(false); downloadTable(); }));
  $("add-open").addEventListener("click", link(async () => {
    if (!state.months.length) return toast("There is no list to add to yet.");
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
    if (!e.target.closest("#score-note, #score-help")) toggleScoreNote(false);
    if (!e.target.closest("#export, #export-open")) toggleExport(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      // closing a pop-up puts the focus back on its link
      for (const [pop, opener, close] of [["past", "past-open", togglePast], ["score-note", "score-help", toggleScoreNote], ["export", "export-open", toggleExport]]) {
        if ($(pop).hidden) continue;
        const inside = $(pop).contains(document.activeElement);
        close(false);
        if (inside) $(opener).focus();
      }
    }
    // links that act like buttons (href="#") answer Space as buttons do
    if (e.key === " " && e.target.matches?.('a[href="#"]')) { e.preventDefault(); e.target.click(); }
  });
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
  addEventListener("storage", handleChanged);
  addEventListener("resize", syncAccountSep, { passive: true });
  await route();
}

init();
