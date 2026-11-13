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
const nextMonth = (m) => { const [y, n] = m.split("-").map(Number); return n === 12 ? `${y + 1}-01` : `${y}-${String(n + 1).padStart(2, "0")}`; };
// Papers are added to the month in progress, the one after the latest list: its monthly run (on the 10th of the month
// after it) scores them and lists them with the model's papers, so an added paper is never shown without a Score.
const addMonth = () => (state.months.length ? nextMonth(state.months.at(-1)) : null);  // null until the month index is in
const upcoming = () => state.view === "list" && Boolean(state.month) && state.month === addMonth();  // the "add to next month" page: its form and the papers added so far
const httpUrl = (url) => (/^https?:\/\/\S+$/.test(url) ? url : null);
// Crossref (JATS) and Europe PMC markup as plain text: an exponent after "10" kept as ⁻¹⁶, citation superscripts
// ("inference<sup>1,2</sup>.") dropped, then the other tags dropped and entities (&lt;) decoded
const SUP = (tag) => new RegExp(`\\s*<(?:jats:)?sup>\\s*(${tag})\\s*</(?:jats:)?sup>`, "g");
const stripTags = (s) => new DOMParser().parseFromString(s
  .replace(new RegExp(`\\b10${SUP("[-−–]?\\d{1,3}").source}`, "g"), (_, e) => `10${sup(e)}`)
  .replace(SUP("[\\d,–-]+"), ""), "text/html").body.textContent.replace(/\s+/g, " ").trim();
const source = (p) => `(${[p.journal, p.date?.replaceAll("-", "/")].filter(Boolean).join(", ")})`;  // dates as months are written: 2026/10/05

// DOI shown in a paper URL, without a preprint version, a page suffix or trailing punctuation; "" if none.
// nature.com/articles/X is the paper with DOI 10.1038/X.
function urlDoi(url) {
  const nature = url.match(/nature\.com\/articles\/([^\s?#/]+)/i), arxiv = url.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/i);
  const doi = nature ? `10.1038/${nature[1]}` : arxiv ? `10.48550/arxiv.${arxiv[1]}` : url.match(/10\.\d{4,9}\/[^\s?#]+/)?.[0];
  return doi ? doi.replace(/[.,;)\]]+$/, "").replace(/(\.full\.pdf\+html|\.full\.pdf|\.full-text|\.full|\.abstract|\.pdf|\/full|\/abstract)$/, "").replace(/v\d+$/, "").toLowerCase() : "";
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
const RESERVED = "admin";  // the cold start's handle: only dev/lab_marks.py writes as it, through the API
const count = (id) => state.votes.get(id)?.size ?? 0;
const mine = (id) => Boolean(state.handle) && (state.votes.get(id)?.has(state.handle) ?? false);
const voteRef = (month, id, handle = state.handle) => fb.doc(db, "months", month, "votes", `${id}~${handle}`);

// A preprint is a preprint: any preprint server is shown as "Preprint", by its name or its URL (10.1101: bioRxiv, medRxiv).
const PREPRINT = /(bio|med|chem|psy|eco|soc)rxiv|arxiv|zenodo|preprint|research ?square|ssrn|osf\.io|authorea|qeios|10\.1101\/|10\.64898\/|10\.5281\//i;
const shownJournal = (journal, url) => (PREPRINT.test(journal) || PREPRINT.test(url) ? "Preprint" : journal);

// Listed papers and added papers in one shape: an added paper shows once the monthly run has scored it (data.added: id → score)
function items() {
  const listed = state.data?.papers || [], dois = new Set(listed.map((p) => p.doi)), scored = state.data?.added || {};
  return [...listed, ...state.subs.filter((s) => (s.id in scored || state.data?.upcoming) && !dois.has(urlDoi(s.url)))
    .map((s) => ({ ...s, journal: shownJournal(s.journal, s.url), authors: Array.isArray(s.authors) ? s.authors : [], added: true,
      p_pick: scored[s.id] }))];
}

// By marks, then by Score (an added paper's too). Unscored added papers (the next month's page) go oldest first.
function visible() {
  const rank = (p) => p.p_pick ?? -(p.created ?? 0) / 1e15;
  return items().sort((a, b) => count(b.id) - count(a.id) || rank(b) - rank(a));
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

// A short note just under a control, for a tap where a hover title cannot show; one at a time, gone after
// 3 s or at the next click elsewhere.
function showTip(anchor, text) {
  document.querySelector(".tip")?.remove();
  const tip = el("span", "tip", text);
  tip.setAttribute("role", "status");
  anchor.after(tip);
  const close = (event) => {
    if (event?.target === anchor) return;
    tip.remove();
    document.removeEventListener("click", close, true);
  };
  setTimeout(() => document.addEventListener("click", close, true));
  setTimeout(close, 3000);
}

function createRow(p) {
  const month = state.month;  // a row belongs to one month: a late click never marks a paper of another
  const li = $("row").content.firstElementChild.cloneNode(true);
  const q = (sel) => li.querySelector(sel);
  const url = httpUrl(p.url);
  q(".title").textContent = p.title;
  url ? (q(".title").href = url) : q(".title").removeAttribute("href");
  q(".source").textContent = source(p);
  q(".source").title = p.type === "preprint" || p.added ? "" : p.venue_name || "";  // a journal's full name; preprints stay "Preprint"
  const a = p.authors || [], cut = a.length === 100;  // a preprint source may cut the list at 100 authors
  q(".meta").textContent = a.length <= 4 ? a.join(", ") : `${a.slice(0, 2).join(", ")}, …${cut ? "" : `, ${a.slice(-2).join(", ")}`}`;  // first two … last two
  q(".added-icon").hidden = !p.added;  // an added paper: a person-plus icon at the Score column's left edge
  q(".added-icon").addEventListener("click", (event) => showTip(event.currentTarget, "Added by a reader, not chosen by the model."));
  q(".edit-own").addEventListener("click", link(() => editSubmission(li.paper)));
  q(".remove-own").addEventListener("click", link(() => removeSubmission(li.paper)));
  if (p.added && p.p_pick == null) {  // next month's page: scored by its run
    q(".pct").textContent = "–";
    q(".pick").title = `Scored when the ${monthName(state.month)} list comes out, on ${monthName(nextMonth(state.month))}/10`;
  } else if (p.p_pick != null) {
    q(".pct").textContent = `${Math.round(100 * p.p_pick)}%`;
    q(".pick").title = p.added ? "Added by a reader, not chosen by the model; the model's prediction of how likely it is to be marked"
      : `The model's prediction of how likely this paper is to be marked (raw score ${p.score.toFixed(2)})`;
  }
  q(".toggle").addEventListener("click", link(() => {
    const open = q(".details").hidden;
    q(".details").hidden = !open;
    q(".toggle").setAttribute("aria-expanded", open);
  }));
  q(".up").addEventListener("click", () => vote(p.id, month));  // no hover colour: grey or blue only
  li.addEventListener("animationend", () => li.classList.remove("new"));

  const details = q(".details");
  q(".toggle").hidden = p.added && !p.abstract && a.length <= 4;  // an added paper may have no abstract or authors
  if (!q(".toggle").hidden) {
    details.append(el("p", "", tidyAbstract(p.abstract || "") || "No abstract available."));
    // a consortium paper can list hundreds: the first 30 and the last 5
    const names = a.length > 35 ? [...a.slice(0, 30), "…", ...a.slice(-5)] : cut ? [...a, "…"] : a;
    if (a.length > 4) details.append(el("p", "authors", `Authors: ${names.join(", ")}`));
  }
  return li;
}

// OpenAlex abstracts lose their markup: "5×10<sup>−8</sup>)" arrives as "5x10 -8 )". Restore the exponent
// after "5x10" (signed or after a space) or after "= 10 " (signed only, so "n = 105" and "> 100,000" stay),
// drop citation numbers left before punctuation ("inference 1,2 ." -> "inference."), the spaces inside brackets
// and before punctuation, and a leading "Abstract".
// No lookbehind: Safari before 16.4 cannot parse it.
const SUPERSCRIPT = Object.fromEntries([..."0123456789-−–"].map((c, i) => [c, "⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁻⁻"[i]]));
const sup = (e) => [...e].map((c) => SUPERSCRIPT[c]).join("");
function tidyAbstract(text) {
  return text.replace(/^abstract[\s:.]+(?=[A-Z])/i, "")
    .replace(/(\d ?[x×] ?10)(?: ?([-−–]\d{1,3})| (\d{1,3}))(?![\d.,]?\d)/g, (_, base, e1, e2) => base + sup(e1 ?? e2))
    .replace(/([=<>≤≥] ?10) ([-−–]\d{1,3})(?![\d.,]?\d)/g, (_, base, e) => base + sup(e))
    .replace(/([a-z]) \d{1,3}(?:[,–-]\d{1,3})* (?=[.,;])/g, "$1")
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
  li.paper = p;  // the latest copy: the saved one first shows without handles
  q(".own").hidden = !ownAdded(p);  // one's own added paper, until the run lists it: edit and remove
}

// A paper the logged-in handle added to the month in progress: it may remove it until the run lists it
const ownAdded = (p) => p.added && !!state.handle && p.name === state.handle && upcoming();

// The list: (1) shows at once, in the order last seen in this browser or else by score; (2) when marks
// arrive or change, re-sorts at once: passed rows ease aside, a paper whose count changed fades in at
// its new place. README "How it works" says the same.
function render() {
  const list = $("list");
  if (state.view === "list" && !state.data) return renderBar();  // the list shows as soon as its file is in
  const before = new Map([...list.children].map((li) => [li, li.getBoundingClientRect().top]));
  const nodes = visible().map((p) => {
    const content = JSON.stringify([p.title, p.url, p.journal, p.date, p.authors, p.abstract]);  // an added paper can be edited
    if (rows.get(p.id)?.content !== content) rows.set(p.id, Object.assign(createRow(p), { content }));
    updateRow(rows.get(p.id), p);
    return rows.get(p.id);
  });
  const sameRows = nodes.length === list.children.length && [...list.children].every((li) => li.isConnected && nodes.includes(li));
  const reorder = nodes.some((n, i) => n !== list.children[i]);
  if (!nodes.length) {
    list.replaceChildren(el("li", "empty", upcoming()
      ? `Nothing added yet. Papers added now join the ${monthName(state.month)} list on ${monthName(nextMonth(state.month))}/10.`
      : "No list for this month yet."));
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
  $("list-month").replaceChildren(...(upcoming()
    ? [`Added to ${monthName(state.month)} so far `, el("span", "head-note", "(Score will be provided when the list is published)")]
    : [listed ? `Papers of ${monthName(state.month)}` : "Papers"]));
  $("listview").classList.toggle("upcoming", upcoming());  // no Score column before the run
  $("me-wrap").hidden = $("interested-wrap").hidden = !state.handle;
  $("me").textContent = state.handle;
  $("me").href = `?user=${state.handle}`;
  $("interested-open").href = `?interested=${state.handle}`;
  $("add-open").href = `?month=${addMonth()}`;
  for (const [a, current] of [[$("me"), state.view === "user"], [$("interested-open"), state.view === "interested"], [$("add-open"), upcoming()]]) {
    a.classList.toggle("current", current);
    current ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current");
  }
  $("login-open").textContent = state.handle ? "logout" : "login";
  syncExpanded();
  syncAccountSep();
  document.title = { list: upcoming() ? "Next month · StatGen Papers" : listed && state.month !== state.months.at(-1) ? `${monthName(state.month)} · StatGen Papers` : "StatGen Papers",
    user: "Your handle · StatGen Papers", interested: "Interested · StatGen Papers" }[state.view];
}

// When the account block wraps onto two lines, the "|" after "interested" ends a line: hide it.
function syncAccountSep() {
  $("account-sep").hidden = false;
  $("account-sep").hidden = $("login-open").parentElement.offsetTop > $("interested-wrap").offsetTop;
}

// The "login" link says whether its form is open.
function syncExpanded() {
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
  history.replaceState(null, "", `?month=${month}`);  // the latest month too: the address always names the month shown
  closeForm();  // the form shows only on the next month's page
  listen();
  const data = month === addMonth() ? { papers: [], added: {}, upcoming: true } : await monthData(month);  // next month has no file yet
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
  const subs = state.subs.map(({ name, ...s }) => s);  // no reader's handle
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
    const ref = voteRef(month, id), handle = state.handle;
    if (!mine(id)) await fb.setDoc(ref, { paper: id, handle });
    else {
      await fb.deleteDoc(ref);
      clearTimeout(slow);
      toast("Unmarked.", () => fb.setDoc(ref, { paper: id, handle })
        .catch((e) => { console.warn(e); toast("Could not restore the mark."); }));
    }
  } catch (e) {
    console.warn(e);
    toast("Your mark was not saved.");
  } finally {
    clearTimeout(slow);
    voting.delete(id);
  }
}

// Edit a paper this handle added: the add form, filled with it, saves over it (its marks stay)
function editSubmission(p) {
  closeForm();
  form.editing = p.id;
  form.lookup = { doi: urlDoi(p.url) };  // no lookup unless the link changes
  const values = { url: p.url, title: p.title, journal: p.journal, authors: (p.authors || []).join(", "), date: p.date?.replaceAll("-", "/"), abstract: p.abstract };
  for (const [name, value] of Object.entries(values)) field(name).value = value || "";
  resetAnyway();
  fitAbstract();
  note("Editing the paper you added.");
  $("login").hidden = true;
  $("add").hidden = false;
  $("add").scrollIntoView({ block: "nearest" });
  field("title").focus({ preventScroll: true });
}

// Remove a paper this browser added, and its marks, which would otherwise be read on every visit.
async function removeSubmission(p) {
  const month = state.month, handles = [...(state.votes.get(p.id) ?? [])].filter((h) => HANDLE.test(h));
  if (!confirm(`Remove "${p.title}" from the list?`)) return;
  if (!(await signedIn())) return;
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

// localStorage, which may be off: read with one argument, write with two (null removes)
function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value);
  } catch {}
  return null;
}

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
  if (!HANDLE.test(handle) || handle === RESERVED) {
    $("login-note").textContent = handle === RESERVED ? "This handle is reserved." : "A handle is 2–20 letters, digits or _.";
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

// "past": a drop-down of all months under the link, 6 a column; it covers the page instead of moving it.
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

// The URL says what to show: ?user=h, ?interested=h, ?month=YYYY-MM, or nothing for the latest month (then named).
// The handle pages open only for the handle logged in here: nobody browses another reader's marks.
function route() {
  const q = new URLSearchParams(location.search), month = q.get("month"), own = (h) => h && state.handle && h.toLowerCase() === state.handle;
  if (own(q.get("user"))) return showUser();
  if (own(q.get("interested"))) return showInterested();
  return loadMonth(state.months.includes(month) || month === addMonth() ? month : state.months.at(-1));
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
  const months = await Promise.all([...state.months, addMonth()].map(async (m) => {  // with the papers added to the month in progress
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
  // the count is the link to the papers: "3 papers", a plain link, as it goes to another page
  const handle = state.handle, total = Object.assign(el("a", "", "…"), { href: `?interested=${handle}` }), table = el("div", "user");
  total.addEventListener("click", link(() => go({ interested: handle })));
  const change = Object.assign(el("a", "dashed change", "change"), { href: "#" }), name = el("span", "", handle);
  change.addEventListener("click", link(() => name.replaceWith(handleForm(handle, name))));
  name.append(" ", change);
  for (const [label, value] of [["handle", name], ["interested in", total]]) {
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

// The user page's form for a new handle: on save, the marks and added papers move to it
function handleForm(from, shown) {
  const form = el("form", "handle-form"), input = Object.assign(el("input"), { value: from, maxLength: 20, ariaLabel: "New handle" });
  const save = Object.assign(el("button", "", "save"), { type: "submit" }), cancel = Object.assign(el("button", "", "cancel"), { type: "button" });
  const say = el("span", "hint");
  say.setAttribute("role", "status");
  cancel.addEventListener("click", () => form.replaceWith(shown));
  const actions = el("span", "actions");
  actions.append(save, " ", cancel);
  form.append(input, " ", actions, say);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const to = input.value.trim().toLowerCase();
    const problem = to === from ? "That is your handle already." : to === RESERVED ? "This handle is reserved."
      : !HANDLE.test(to) ? "A handle is 2–20 letters, digits or _." : "";
    if (problem) return (say.textContent = problem), say.classList.add("error");
    save.disabled = true;
    say.classList.remove("error");
    say.textContent = "Moving your marks…";
    try {
      const moved = await changeHandle(from, to);
      if (moved === null) return (say.textContent = "Someone uses this handle already."), say.classList.add("error");
      setHandle(to);
      go({ user: to });
      toast(`Your handle is now ${to}: ${moved} mark${moved === 1 ? "" : "s"} moved.`);
    } catch (e) {
      console.warn(e);
      say.textContent = "The handle was not changed. Please try again later.";
      say.classList.add("error");
    } finally {
      save.disabled = false;
    }
  });
  setTimeout(() => input.select());
  return form;
}

// Move a handle's marks (created under the new handle, deleted under the old) and rename its added papers, month by
// month; null if the new handle has a mark or a paper already. A failure halfway can be retried: what moved is gone.
async function changeHandle(from, to) {
  await connected;
  if (!db) throw new Error("Firestore is unavailable");
  const months = [...state.months, addMonth()], col = (m, c) => fb.collection(db, "months", m, c);
  const mine = (m, c, h) => fb.getDocs(fb.query(col(m, c), fb.where(c === "votes" ? "handle" : "name", "==", h)));
  // a change cut short (closed tab, lost connection) leaves the new handle in use; trying the same change again finishes it
  const pending = JSON.stringify({ from, to }), resuming = store("handleChange") === pending;
  if (!resuming) {
    const used = await Promise.all(months.flatMap((m) => ["votes", "submissions"].map((c) =>
      fb.getDocs(fb.query(col(m, c), fb.where(c === "votes" ? "handle" : "name", "==", to), fb.limit(1))))));
    if (used.some((snap) => !snap.empty)) return null;
  }
  if (!(await signedIn())) throw new Error("not signed in");
  store("handleChange", pending);
  let moved = 0;
  for (const m of months) {
    const [votes, subs] = await Promise.all([mine(m, "votes", from), mine(m, "submissions", from)]);
    const ops = [
      ...votes.docs.flatMap((d) => [(b) => b.set(voteRef(m, d.data().paper, to), { paper: d.data().paper, handle: to }),
        (b) => b.delete(d.ref)]),
      ...subs.docs.map((d) => (b) => b.update(d.ref, { name: to })),
    ];
    for (let i = 0; i < ops.length; i += 400) {  // a batch holds at most 500 writes; a mark's two stay in one batch
      const batch = fb.writeBatch(db);
      ops.slice(i, i + 400).forEach((op) => op(batch));
      await batch.commit();
    }
    moved += votes.size;
  }
  store("handleChange", null);
  return moved;
}

// By month, newest first: each month's heading links to its list; "not interested" at each paper's right
async function showInterested() {
  const handle = state.handle, box = el("div", "marks");
  box.append(el("p", "empty", "Loading…"));
  showPage("interested", el("p", "page-head", "Papers you are interested in"), box);
  let marks;
  try {
    marks = await myMarks();
  } catch (e) {
    console.warn(e);
    box.replaceChildren(el("p", "empty", "Unavailable right now; try again later."));
    return;
  }
  if (state.view !== "interested" || state.handle !== handle) return;
  const empty = el("p", "empty", "Nothing yet: click the triangle beside a paper.");
  const groups = new Map();  // not Map.groupBy: Safari before 17.4 lacks it
  for (const m of marks) groups.set(m.month, [...(groups.get(m.month) ?? []), m]);
  // a month whose papers are all taken back hides; with none left, the page says so
  const sync = () => {
    for (const section of box.querySelectorAll("section")) section.hidden = [...section.querySelectorAll("li")].every((li) => li.hidden);
    empty.remove();
    if ([...box.querySelectorAll("section")].every((s) => s.hidden)) box.append(empty);
  };
  box.replaceChildren(...[...groups].map(([month, items]) => {
    const head = Object.assign(el("a", "", monthName(month)), { href: `?month=${month}` });
    head.addEventListener("click", link(() => go({ month })));
    const list = el("ol", "list");
    list.append(...items.map(({ paper: p }) => {
      const li = el("li", "mark"), main = el("div", "main"), title = el("a", "title", p.title), url = httpUrl(p.url);
      if (url) Object.assign(title, { href: url, target: "_blank", rel: "noopener noreferrer" });
      main.append(title, " ", el("span", "source", source(p)));
      const undo = Object.assign(el("a", "dashed unmark", "not interested"), { href: "#" });
      undo.addEventListener("click", link(async () => {
        const ref = voteRef(month, p.id, handle);
        try {
          if (!(await signedIn())) return;
          await fb.deleteDoc(ref);
          li.hidden = true;
          sync();
          toast("Removed.", async () => {
            try {
              await fb.setDoc(ref, { paper: p.id, handle });
              li.hidden = false;
              sync();
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
      li.append(main, undo);
      return li;
    }));
    const section = el("section");
    section.append(el("h2", "month-head"), list);
    section.firstChild.append(head);
    return section;
  }));
  sync();
}

// ---------------------------------------------------------------- add a paper

const form = { lookup: {} };
const field = (name) => $(`add-${name}`);

// The line under the DOI field: how the lookup went, or else what the field does
function note(message, error = false) {
  $("add-note").textContent = message || "Paste the DOI first: title, journal, authors, date and abstract fill in from it.";
  $("add-note").classList.toggle("error", error);
}

// The table's short name, Journal_FirstAuthor_Year_Keyword, made on submit: the surname from the DOI record, or else
// from the authors typed or pasted ("Žiga Avsec, …" -> "Avsec"), "NA" if neither
function formShortName(journal, title) {
  const typed = field("authors").value.split(",")[0].trim().split(/\s+/).at(-1) || undefined;
  return shortName(journal, form.lookup.surname || typed, formDate().slice(0, 4) || String(new Date().getFullYear()), title).slice(0, 150);
}

// The date field, shown as the site writes dates (2026/11/05), as stored: "2026/11/5" -> "2026-11-05"; "" if empty
const formDate = () => field("date").value.trim().split(/[-/]/).filter(Boolean).map((n, i) => (i ? n.padStart(2, "0") : n)).join("-");

// What is known about a DOI, in one shape, or null: Crossref has journals, bioRxiv and medRxiv; DataCite has
// Zenodo and arXiv. Each answers in well under a second; after 8 s a lookup gives up.
// The journals the run reads, by full name, as the site shows them: keep in step with config/sources.toml
const ABBR = { "nature": "Nature", "nature genetics": "Nat Genet", "nature communications": "Nat Commun",
  "nature reviews genetics": "Nat Rev Genet", "nature medicine": "Nat Med", "nature human behaviour": "Nat Hum Behav",
  "science": "Science", "science translational medicine": "Sci Transl Med", "cell": "Cell", "cell genomics": "Cell Genom",
  "american journal of human genetics": "Am J Hum Genet" };
const abbreviate = (name) => ABBR[(name || "").toLowerCase().replace(/^the /, "")];

// An abstract from OpenAlex, which has many that Crossref lacks (Elsevier's): its word index put back in order
async function openAlexAbstract(doi) {
  const index = await fetch(`https://api.openalex.org/works/doi:${encodeURIComponent(doi)}?select=abstract_inverted_index`,
    { signal: AbortSignal.timeout(8000) }).then((r) => (r.ok ? r.json() : null), () => null).then((w) => w?.abstract_inverted_index);
  if (!index) return "";
  const words = [];
  for (const [word, places] of Object.entries(index)) for (const i of places) words[i] = word;
  return words.filter(Boolean).join(" ");
}

// PubMed's abstract through Europe PMC (PubMed itself refuses browser requests), where OpenAlex has none
async function europePmcAbstract(doi) {
  const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(`DOI:"${doi}"`)}&resultType=core&format=json&pageSize=1`;
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) }).then((r) => (r.ok ? r.json() : null), () => null);
  return stripTags(r?.resultList?.result?.[0]?.abstractText || "").replace(/\s+/g, " ").trim();
}

async function metadata(doi) {
  const get = (url) => fetch(url, { signal: AbortSignal.timeout(8000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const date = (parts) => parts.filter(Boolean).map((n, i) => (i ? String(n).padStart(2, "0") : n)).join("-");
  const w = (await get(`https://api.crossref.org/works/${encodeURIComponent(doi)}`))?.message;
  if (w) {
    return {
      title: stripTags(w.title?.[0] || ""), surname: w.author?.[0]?.family, date: date(w.issued?.["date-parts"]?.[0] ?? []),
      authors: (w.author || []).map((x) => [x.given, x.family].filter(Boolean).join(" ") || x.name).filter(Boolean),
      abstract: tidyAbstract(stripTags(w.abstract || "")),
      journal: w.type === "posted-content" || PREPRINT.test(doi) ? "Preprint"
        : abbreviate(w["container-title"]?.[0]) || w["short-container-title"]?.[0] || w["container-title"]?.[0] || "",
    };
  }
  const a = (await get(`https://api.datacite.org/dois/${encodeURIComponent(doi)}`))?.data?.attributes;
  if (!a) return null;
  const publisher = a.publisher?.name ?? a.publisher ?? "";
  return {
    title: a.titles?.[0]?.title || "", surname: a.creators?.[0]?.familyName || a.creators?.[0]?.name?.split(",")[0],
    date: String(a.publicationYear || ""),
    authors: (a.creators || []).map((c) => [c.givenName, c.familyName].filter(Boolean).join(" ") || c.name).filter(Boolean),
    abstract: stripTags(a.descriptions?.find((d) => d.descriptionType === "Abstract")?.description || ""),
    journal: a.types?.resourceTypeGeneral === "Preprint" || PREPRINT.test(`${publisher} ${doi}`) ? "Preprint" : a.container?.title || publisher,
  };
}

// A link without a DOI may still name its paper: a promise of the DOI, or null. A cell.com or ScienceDirect link has
// an Elsevier PII, which Crossref keeps, without punctuation, as an alternative id; a bioRxiv or medRxiv "early" or
// PDF link has the id without its DOI prefix (10.64898 since 2025, 10.1101 before).
function piiDoi(url) {
  const get = (u) => fetch(u, { signal: AbortSignal.timeout(8000) }).then((r) => (r.ok ? r.json() : null), () => null);
  const rxiv = url.match(/(?:bio|med)rxiv\.org\/.*?(\d{4}\.\d\d\.\d\d\.\d{6,8})/i)?.[1];
  if (rxiv) {
    return (async () => {
      for (const prefix of ["10.64898", "10.1101"]) if (await get(`https://api.crossref.org/works/${prefix}/${rxiv}`)) return `${prefix}/${rxiv}`;
      return "";
    })();
  }
  const pii = url.match(/\/(S\d{4}-?\d{3}[\dX](?:\(\d\d\)|\d\d)\d{5}-?[\dX])(?:[/?#]|$)/i)?.[1];  // any cell.com or ScienceDirect path
  if (!pii) return null;
  const id = pii.replace(/[^\dXS]/gi, "").toUpperCase();
  return get(`https://api.crossref.org/works?filter=alternative-id:${id},prefix:10.1016&rows=1&select=DOI`)
    .then((d) => d?.message?.items?.[0]?.DOI?.toLowerCase() ?? "");
}

// Text pasted from a PDF: lines joined, a word broken by a hyphen at a line end rejoined (only before a lower-case
// letter, so "single-\ncell" loses its hyphen too: rare in titles and abstracts, and easy to fix).
const joinLines = (t) => t.replace(/\u00ad/g, "").replace(/(\p{Ll})-[ \t]*\r?\n\s*(?=\p{Ll})/gu, "$1").replace(/\s+/g, " ").trim();
const PASTED = {
  title: joinLines,
  abstract: (t) => joinLines(t).replace(/^abstract[\s.:]*/i, ""),
  // "Žiga Avsec1,2,*, Natasha Latysheva1 and Jun Cheng†" -> "Žiga Avsec, Natasha Latysheva, Jun Cheng"
  authors: (t) => t.replace(/(\p{L}\.?)[\d⁰¹²³⁴-⁹*†‡§¶#✉]+(?:,[\d⁰¹²³⁴-⁹*†‡§¶#✉]+)*/gu, "$1")
    .split(/\s*(?:[,;\n]|\band\b|&)\s*/).map((a) => a.replace(/\s+/g, " ").trim()).filter(Boolean).join(", "),
};

// On a pasted or changed URL: fill the empty fields from the DOI's record, and say how it went. Whatever is
// filled can be edited; nothing found leaves the form to be typed by hand.
// The DOI field as a URL: a bare DOI becomes its doi.org link
const linkValue = () => field("url").value.trim().replace(/^(?:doi:\s*)?(10\.\d{4,9}\/\S+)$/i, "https://doi.org/$1");

async function lookUp() {
  const url = linkValue(), pii = !urlDoi(url) && piiDoi(url);
  if (pii) note("Looking up the DOI…");
  const doi = urlDoi(url) || (pii && (await pii)) || "";
  if (linkValue() !== url || doi === form.lookup.doi) return;
  form.lookup = { doi };
  if (!url || !doi) {
    return note(url ? "No DOI found for this link: type the title, journal and abstract (a DOI fills them in)." : "");
  }
  note("Looking up the DOI…");
  const m = await metadata(doi);
  if (form.lookup.doi !== doi) return;  // the URL changed meanwhile
  if (!m) {
    return note("Nothing found for this DOI: type the title, journal and abstract.");
  }
  if (!m.abstract) m.abstract = tidyAbstract((await openAlexAbstract(doi)) || (await europePmcAbstract(doi)));
  if (form.lookup.doi !== doi) return;
  form.lookup = { doi, url, surname: m.surname };
  for (const [name, value] of [["title", m.title], ["journal", m.journal], ["authors", m.authors.join(", ")], ["date", m.date.replaceAll("-", "/")], ["abstract", m.abstract]]) {
    if (!field(name).value.trim() && value) field(name).value = value;
  }
  fitAbstract();
  note(m.abstract ? "Filled from the DOI; edit anything that is off." : "Filled from the DOI, which has no abstract: paste it from the paper.");
  const copy = await findCopy({ url, doi, title: field("title").value }).catch(() => null);  // warn before the rest is typed
  if (copy && form.lookup.doi === doi) note(`Filled from the DOI. ${copy.message}`, true);
}

// Where this paper is already: on any month's list (its added papers included) or added to the month in progress,
// matched by link, DOI or title (ignoring case and punctuation). null if nowhere; `here`: added to the month in progress.
// Listed months come from their static files (data.added_papers): only the month in progress is read from Firestore.
async function findCopy({ url, doi, title }) {
  const t = plainTitle(title), months = [...state.months].reverse(), next = addMonth();  // newest list first
  const same = (p) => (url && p.url === url) || (doi && (p.doi || urlDoi(p.url)) === doi) || (t && plainTitle(p.title) === t);
  const added = async (m) => (await fb.getDocs(fb.collection(db, "months", m, "submissions"))).docs
    .filter((d) => d.id !== form.editing).map((d) => d.data());  // the paper being edited is not a copy of itself
  if ((await added(next)).some(same)) return { here: true, message: `Someone has added this paper to ${monthName(next)} already: mark it below.` };
  const lists = await Promise.all(months.map(monthData));
  const i = months.findIndex((m, k) => lists[k].papers.some(same) || Object.values(lists[k].added_papers || {}).some(same));
  return i < 0 ? null : { message: `This paper is on the ${monthName(months[i])} list already.` };
}

const submitLabel = () => (form.editing ? "save" : "add");
function resetAnyway() {
  form.anyway = null;
  $("add").querySelector("button[type=submit]").textContent = submitLabel();
  $("add-cancel").textContent = form.editing ? "cancel" : "clear";
  $("add-warn").textContent = "";
}

// The abstract box grows with its text, filled, pasted or typed, up to 60% of the screen; then it scrolls
function fitAbstract() {
  const box = field("abstract");
  box.style.height = "";
  if (box.value) box.style.height = `${Math.min(box.scrollHeight + box.offsetHeight - box.clientHeight, innerHeight * 0.6)}px`;
}

// A paper on an earlier list may still be added: the first "add" warns, next to the button, and a second one adds it
function warnOnce(message) {
  form.anyway = message;
  $("add").querySelector("button[type=submit]").textContent = `${submitLabel()} anyway`;
  $("add-warn").textContent = message;
  if ($("add-note").textContent.includes(message)) note("Filled from the DOI.");  // said once, by the button
}

async function submitPaper(event) {
  event.preventDefault();
  await form.pending;  // leaving the URL field for "add" starts a lookup: let it fill the form first
  const paper = { journal: field("journal").value.trim(), title: field("title").value.trim(), url: linkValue() };
  paper.short_name = formShortName(paper.journal, paper.title);
  // optional: authors, abstract and date, so an added paper shows like the others
  const authors = field("authors").value.split(/\s*[,;]\s*/).filter(Boolean).slice(0, 300), abstract = field("abstract").value.trim();
  Object.assign(paper, authors.length ? { authors } : {}, abstract ? { abstract: abstract.slice(0, 10000) } : {},
    formDate() ? { date: formDate() } : {});
  if (needHandle(() => { $("add").hidden = false; $("add").requestSubmit(); })) return;  // the form keeps its fields while the login shows
  if (!httpUrl(paper.url)) return note("Enter a DOI (10.…) or a link starting with http:// or https://.", true);
  // a link without a DOI (cell.com) whose DOI the lookup found is stored as a DOI link: the run and the duplicate check use it
  if (!urlDoi(paper.url) && form.lookup.doi && form.lookup.url === paper.url) paper.url = `https://doi.org/${form.lookup.doi}`;
  const month = addMonth();
  try {
    const copy = await findCopy({ url: paper.url, doi: urlDoi(paper.url), title: paper.title });
    if (copy?.here) return note(copy.message, true);
    if (copy && form.anyway !== copy.message) return warnOnce(copy.message);
    if (!(await signedIn())) return;
    if (form.editing) {  // a field left empty is removed from the paper
      await fb.updateDoc(fb.doc(db, "months", month, "submissions", form.editing),
        { authors: fb.deleteField(), abstract: fb.deleteField(), date: fb.deleteField(), ...paper });
      closeForm();
      return toast("Saved.");
    }
    const ref = await fb.addDoc(fb.collection(db, "months", month, "submissions"),
      { ...paper, uid: state.uid, created: fb.serverTimestamp(), name: state.handle });
    closeForm();
    $("add-open").focus({ preventScroll: true });
    // adding a paper marks it (not through vote(), which marks only the month shown); the mark shows on the handle's page
    await fb.setDoc(voteRef(month, ref.id), { paper: ref.id, handle: state.handle });
    toast(`Added to ${monthName(month)}; it gets a Score on ${monthName(nextMonth(month))}/10.`);
  } catch (e) {
    console.warn(e);
    note(`The paper was not ${form.editing ? "saved" : "added"}. Please try again later.`, true);
  }
}

function closeForm() {
  $("add").hidden = !upcoming();
  $("add").reset();
  form.lookup = {};
  form.editing = null;
  resetAnyway();
  fitAbstract();
  note("");
  syncExpanded();
}

// Show one of the two forms (login, add), or hide it if it is open.
function openPanel(name) {
  const other = name === "add" ? "login" : "add";
  if (!(other === "add" && upcoming())) $(other).hidden = true;  // the next month's page keeps its form under the login
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
  $("copy").addEventListener("click", link(copyTable));
  $("download").addEventListener("click", link(downloadTable));
  $("add-open").addEventListener("click", link(async () => {
    if (!state.months.length) return toast("There is no list to add to yet.");
    if (!upcoming()) await go({ month: addMonth() });
    $("login").hidden = true;
    $("add").hidden = false;
    field("url").focus();
  }));
  $("add-cancel").addEventListener("click", () => { closeForm(); field("url").focus(); });  // clears the form
  $("add").addEventListener("submit", submitPaper);
  $("login-open").addEventListener("click", link(() => {
    if (!state.handle) return openPanel("login");
    setHandle("");
    if (state.view !== "list") go({});  // the handle's own pages close with it
  }));
  $("login-cancel").addEventListener("click", closeLogin);
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
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      // closing a pop-up puts the focus back on its link
      for (const [pop, opener, close] of [["past", "past-open", togglePast], ["score-note", "score-help", toggleScoreNote]]) {
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
  // a lookup in flight is awaited by submitPaper, so its last note cannot overwrite the submit's
  for (const [name, tidy] of Object.entries(PASTED)) {  // text pasted from a PDF goes in tidied
    field(name).addEventListener("paste", (event) => {
      const text = event.clipboardData?.getData("text/plain");
      if (!text) return;
      event.preventDefault();
      const input = field(name);
      input.setRangeText(tidy(text), input.selectionStart, input.selectionEnd, "end");
      if (name === "abstract") fitAbstract();
    });
  }
  field("abstract").addEventListener("input", fitAbstract);
  $("add").addEventListener("input", () => form.anyway && resetAnyway());  // an edited form is checked afresh
  field("url").addEventListener("change", () => { form.pending = lookUp(); });
  field("url").addEventListener("paste", () => setTimeout(() => { form.pending = lookUp(); }));  // a pasted URL is looked up at once

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
