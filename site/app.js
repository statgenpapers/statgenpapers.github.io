// StatGen Papers: static list from data/*.json, live upvotes and visitor-added papers from Firestore.
import { firebaseConfig } from "./config.js";

const SDK = "https://www.gstatic.com/firebasejs/11.10.0";
const TABLE_HEADER = ["Journal", "Short Name", "Title", "URL"];
const STOPWORDS = new Set("a an and are as at by for from in into is of on or the to via with across between through using".split(" "));
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls || "", textContent: text ?? "" });
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const state = {
  months: [], month: null, data: null,
  votes: new Map(),  // paper id -> { handle key: handle as typed }
  subs: [],          // papers added by visitors
  uid: null,
  handle: "",       // the visitor's handle as typed; "" when logged out
  view: "list",     // "list" (a month), "user" or "interested" (pages of one handle)
  page: "",         // the handle the user and interested pages are about
};
const rows = new Map();  // paper id -> <li>
const voting = new Set();  // paper ids with a vote write in flight: a second click must wait for it
let fb = null, db = null, unsubscribe = [];
let dbReady;
const connected = new Promise((resolve) => { dbReady = resolve; });  // settles once Firestore is set up, or failed

// ---------------------------------------------------------------- helpers

function toast(message) {
  const t = $("toast");
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3500);
}

const monthName = (m) => m.replace("-", "/");  // 2026-10 -> 2026/10
const httpUrl = (url) => (/^https?:\/\/\S+$/i.test(url) ? url : null);
const stripTags = (s) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

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

// A handle is the visitor's login: no password, so anyone who types it votes as its owner.
// Votes are keyed by the lower-case handle, so one handle has one vote per paper on any device.
const HANDLE = /^[A-Za-z0-9_]{2,20}$/;
const key = () => state.handle.toLowerCase();

// Upvotes of a paper: [handle key, handle] pairs, one Firestore document each (months/{m}/votes/{paper}~{key}).
const upvotes = (id) => Object.entries(state.votes.get(id) || {});
const mine = (id) => Boolean(state.handle) && key() in (state.votes.get(id) || {});

// Listed papers and visitor-added papers in one shape
function items() {
  const listed = state.data?.papers || [], dois = new Set(listed.map((p) => p.doi));
  return [...listed, ...state.subs.filter((s) => !dois.has(urlDoi(s.url))).map((s) => ({ ...s, added: true }))];
}

// By votes; equal votes by score. Added papers have no score: after the scored ones, oldest first.
function visible() {
  const votes = (p) => upvotes(p.id).length, score = (p) => p.score ?? -Infinity, age = (p) => p.created ?? 0;
  return items().sort((a, b) => votes(b) - votes(a) || (score(a) === score(b) ? age(a) - age(b) : score(b) - score(a)));
}

const link = (handler) => (event) => { event.preventDefault(); handler(event); };

// ---------------------------------------------------------------- rendering

function createRow(p) {
  const li = $("row").content.firstElementChild.cloneNode(true);
  const q = (sel) => li.querySelector(sel);
  const url = httpUrl(p.url);
  q(".title").textContent = p.title;
  url ? (q(".title").href = url) : q(".title").removeAttribute("href");
  q(".source").textContent = `(${[p.journal, p.date].filter(Boolean).join(", ")})`;
  q(".source").title = p.venue_name || "";
  const a = p.authors || [], cut = a.length === 100;  // OpenAlex lists at most 100 authors, so the last ones are unknown
  q(".meta").textContent = p.added ? `added by ${p.name || "a visitor"}`
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

  const details = q(".details");
  if (!p.added) {
    details.append(el("p", "", (p.abstract || "").replace(/^abstract[\s:.]+(?=[A-Z])/i, "") || "No abstract available."));
    if (a.length > 4) details.append(el("p", "who", `Authors: ${a.join(", ")}${cut ? ", …" : ""}`));
  }
  details.append(el("p", "who voters"));
  return li;
}

function updateRow(li, p) {
  const ups = upvotes(p.id), q = (sel) => li.querySelector(sel);
  q(".count").textContent = ups.length;
  q(".count").title = `${ups.length} interested`;
  q(".up").setAttribute("aria-pressed", mine(p.id));
  q(".up").setAttribute("aria-label", mine(p.id) ? "Not interested any more" : "Interested");
  q(".up").title = state.handle ? (mine(p.id) ? "Not interested any more" : "Interested") : "Log in with a handle to mark papers you are interested in";
  q(".up").disabled = !state.uid;
  q(".voters").replaceChildren(...(ups.length
    ? ["Interested: ", ...ups.flatMap(([, handle], i) => [i ? ", " : "", handleLink(handle)])]
    : ["No one interested yet."]));
  q(".remove-wrap").hidden = !p.added || p.uid !== state.uid;
}

function render() {
  const list = $("list"), shown = visible();
  const before = new Map([...list.children].map((li) => [li, li.getBoundingClientRect().top]));
  const nodes = shown.map((p) => {
    if (!rows.has(p.id)) rows.set(p.id, createRow(p));
    updateRow(rows.get(p.id), p);
    return rows.get(p.id);
  });
  if (!nodes.length) {
    list.replaceChildren(el("li", "empty", "No list for this month yet."));
  } else if (nodes.length !== list.children.length || nodes.some((n, i) => n !== list.children[i])) {
    const focused = document.activeElement;
    list.replaceChildren(...nodes);
    if (focused && list.contains(focused)) focused.focus({ preventScroll: true });
    if (!reduceMotion) {
      for (const li of nodes) {  // FLIP: start each row where it was, let it glide to its new place
        const dy = before.has(li) ? before.get(li) - li.getBoundingClientRect().top : 0;
        if (Math.abs(dy) > 1) li.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 450, easing: "cubic-bezier(.2,.7,.2,1)" });
      }
    }
  }
  // the month shown, in the top bar: "this month (October 2026)", or "past (September 2026)" for an earlier one
  // "this month" is always the latest list; "past – 2026/09" while an earlier month's list is shown
  const latest = state.month === state.months.at(-1), pastMonth = state.view === "list" && state.month && !latest;
  $("past-open").replaceChildren("past", ...(pastMonth ? [" – ", el("span", "when", monthName(state.month))] : []));
  const onList = state.view === "list";
  $("this-month").classList.toggle("current", onList && latest);
  $("past-open").classList.toggle("current", onList && Boolean(state.month) && !latest);
  $("me").hidden = !state.handle;
  $("me").textContent = state.handle;
  $("interested-wrap").hidden = !state.handle;
  $("copy-wrap").hidden = !onList;
  $("interested-open").classList.toggle("current", state.view === "interested" && state.page.toLowerCase() === key());
  $("login-open").textContent = state.handle ? "logout" : "login";
}

// ---------------------------------------------------------------- data

async function loadMonth(month) {
  state.view = "list";
  $("listview").hidden = false;
  $("page").hidden = true;
  state.month = month;
  state.data = null;
  state.votes = new Map();
  state.subs = [];
  rows.clear();
  history.replaceState(null, "", month === state.months.at(-1) ? location.pathname : `?month=${month}`);
  closeForm();
  listen();
  const response = await fetch(`data/${month}.json`, { cache: "no-cache" });
  if (state.month !== month) return;  // the visitor moved on while this was loading
  state.data = response.ok ? await response.json() : null;
  $("journals").replaceChildren(...[...new Set(items().map((p) => p.journal))].sort().map((j) => Object.assign(el("option"), { value: j })));
  render();
}

function listen() {
  unsubscribe.forEach((stop) => stop());
  unsubscribe = [];
  if (!db || !state.month) return;
  const month = state.month, at = (name) => fb.collection(db, "months", month, name);
  unsubscribe.push(fb.onSnapshot(at("votes"), (snap) => {
    state.votes = new Map();
    for (const d of snap.docs) {
      const { paper, handle } = d.data();
      state.votes.set(paper, { ...state.votes.get(paper), [handle.toLowerCase()]: handle });
    }
    render();
  }, (e) => { console.warn("votes", e); toast("Votes are unavailable right now; the list is still readable."); }));
  unsubscribe.push(fb.onSnapshot(at("submissions"), (snap) => {
    state.subs = snap.docs.map((d) => {
      const s = d.data({ serverTimestamps: "estimate" });
      return { ...s, id: d.id, created: s.created?.toMillis() ?? Date.now() };
    });
    render();
  }, (e) => console.warn("submissions", e)));
}

async function connect() {
  try {
    const [app, auth, firestore] = await Promise.all(["app", "auth", "firestore"].map((m) => import(`${SDK}/firebase-${m}.js`)));
    fb = { ...auth, ...firestore };
    const instance = app.initializeApp(firebaseConfig), user = fb.getAuth(instance);
    // Sign in before the first listener, so the connection opens once, as this visitor.
    await user.authStateReady();
    if (!user.currentUser) {  // silent: no prompt; the handle, not this id, is what votes
      await fb.signInAnonymously(user).catch((e) => { console.warn(e); toast("Voting is unavailable right now; the list is still live."); });
    }
    fb.onAuthStateChanged(user, (u) => { state.uid = u?.uid || null; render(); });
    // Long-polling, not the default streaming with proxy auto-detection: in tests the default showed
    // another browser's vote more than half a minute late after about 1 page load in 50.
    db = fb.initializeFirestore(instance, { experimentalForceLongPolling: true });
    dbReady();
    listen();
  } catch (e) {
    dbReady();
    console.warn(e);
    toast("Voting is unavailable right now; the list is still readable.");
  }
}

// ---------------------------------------------------------------- writes

function needHandle() {
  if (state.handle) return false;
  openPanel("login");
  toast("Log in with a handle to mark papers or add them.");
  return true;
}

// Upvote a paper, or take the upvote back if this handle already gave one.
async function vote(id) {
  if (!state.uid) return toast("Still connecting; try again in a moment.");
  if (needHandle()) return;
  if (voting.has(id)) return;
  voting.add(id);
  const ref = fb.doc(db, "months", state.month, "votes", `${id}~${key()}`);
  try {
    if (mine(id)) await fb.deleteDoc(ref);
    else await fb.setDoc(ref, { paper: id, handle: state.handle });
  } catch (e) {
    console.warn(e);
    toast("Your vote was not saved.");
  } finally {
    voting.delete(id);
  }
}

async function removeSubmission(p) {
  if (!confirm(`Remove "${p.title}" from the list?`)) return;
  try {
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
  if (!HANDLE.test(handle)) return toast("A handle is 2–20 letters, digits or _.");
  setHandle(handle);
  $("login").hidden = true;
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
      const a = Object.assign(el("a", m === state.month ? "current" : "", monthName(m)), { href: `?month=${m}`, role: "menuitem" });
      a.addEventListener("click", link(() => { togglePast(false); loadMonth(m); }));
      return a;
    }));
  }
  past.hidden = !open;
  $("past-open").setAttribute("aria-expanded", open);
}

// ---------------------------------------------------------------- pages of one handle

// The URL says what to show: ?user=h, ?interested=h, ?month=YYYY-MM, or nothing for the latest month.
function route() {
  const q = new URLSearchParams(location.search), user = q.get("user"), interested = q.get("interested"), month = q.get("month");
  if (user && HANDLE.test(user)) return showUser(user.toLowerCase());
  if (interested && HANDLE.test(interested)) return showInterested(interested.toLowerCase());
  return loadMonth(state.months.includes(month) ? month : state.months.at(-1));
}

function go(params) {
  history.pushState(null, "", `?${new URLSearchParams(params)}`);
  togglePast(false);
  route();
}

function handleLink(handle) {
  const a = Object.assign(el("a", "handle", handle), { href: `?user=${handle}` });
  a.addEventListener("click", link(() => go({ user: handle })));
  return a;
}

// Every paper `handle` is interested in, newest month first: [{ month, paper }].
async function marksOf(handle) {
  await connected;
  if (!db) throw new Error("Firestore is unavailable");
  const k = handle.toLowerCase();
  const months = await Promise.all(state.months.map(async (m) => {
    // Only this handle's marks are read (a query costs one read per result, at least one), and the month's added papers.
    const votes = fb.getDocs(fb.query(fb.collection(db, "months", m, "votes"), fb.where("handle", "==", k)));
    const [data, mine, subs] = await Promise.all([fetch(`data/${m}.json`, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : { papers: [] })),
      votes, fb.getDocs(fb.collection(db, "months", m, "submissions"))]);
    const papers = new Map([...subs.docs.map((d) => [d.id, { ...d.data(), id: d.id, added: true }]), ...data.papers.map((p) => [p.id, p])]);
    return mine.docs.map((d) => d.data()).filter((v) => papers.has(v.paper))
      .map((v) => ({ month: m, paper: papers.get(v.paper) }));
  }));
  return months.reverse().flat();
}

function showPage(handle, view, ...content) {
  state.view = view;
  state.page = handle;
  unsubscribe.forEach((stop) => stop());
  unsubscribe = [];
  closeForm();
  $("listview").hidden = true;
  $("page").hidden = false;
  $("page").replaceChildren(...content);
  render();
}

async function showUser(handle) {
  const count = el("span", "", "…");
  const table = el("div", "user");
  for (const [label, value] of [["user:", handle], ["interested in:", count]]) {
    const row = el("div", "row");
    row.append(el("span", "label", label), value instanceof Node ? value : el("span", "", value));
    table.append(row);
  }
  const shown = Object.assign(el("a", "", "interested papers"), { href: `?interested=${handle}` });
  shown.addEventListener("click", link(() => go({ interested: handle })));
  const more = el("p");
  more.append(shown);
  showPage(handle, "user", table, more);
  try {
    const marks = await marksOf(handle);
    if (state.view !== "user" || state.page !== handle) return;
    count.textContent = `${marks.length} paper${marks.length === 1 ? "" : "s"}`;
  } catch (e) {
    console.warn(e);
    count.textContent = "unavailable";
  }
}

async function showInterested(handle) {
  const list = el("ol", "list marks");
  list.append(el("li", "empty", "Loading…"));
  const own = handle.toLowerCase() === key();
  showPage(handle, "interested", el("p", "page-head", ""), list);
  $("page").firstChild.append(own ? "Papers you are interested in" : "Papers ", ...(own ? [] : [handleLink(handle), " is interested in"]));
  let marks;
  try {
    marks = await marksOf(handle);
  } catch (e) {
    console.warn(e);
    list.replaceChildren(el("li", "empty", "Unavailable right now; try again later."));
    return;
  }
  if (state.view !== "interested" || state.page !== handle) return;
  if (!marks.length) return list.replaceChildren(el("li", "empty", own ? "Nothing yet: click the triangle beside a paper." : "Nothing yet."));
  list.replaceChildren(...marks.map(({ month, paper: p }) => {
    const li = el("li", "mark"), title = el("a", "title", p.title), url = httpUrl(p.url);
    if (url) Object.assign(title, { href: url, target: "_blank", rel: "noopener noreferrer" });
    const monthLink = Object.assign(el("a", "", monthName(month)), { href: `?month=${month}` });
    monthLink.addEventListener("click", link(() => go({ month })));
    const sub = el("div", "sub");
    sub.append(monthLink);
    if (own) {
      const undo = Object.assign(el("a", "", "not interested"), { href: "#" });
      undo.addEventListener("click", link(async () => {
        try {
          await fb.deleteDoc(fb.doc(db, "months", month, "votes", `${p.id}~${key()}`));
          li.remove();
        } catch (e) {
          console.warn(e);
          toast("Could not remove the mark.");
        }
      }));
      sub.append(" · ", undo);
    }
    li.append(title, " ", el("span", "source", `(${[p.journal, p.date].filter(Boolean).join(", ")})`), sub);
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
  if (needHandle()) return;
  if (!httpUrl(paper.url)) return note("The URL must start with http:// or https://.", true);
  const doi = urlDoi(paper.url);
  if (items().some((p) => p.url === paper.url || (doi && (p.doi || urlDoi(p.url)) === doi))) return note("This paper is already on the list.", true);
  try {
    const ref = await fb.addDoc(fb.collection(db, "months", state.month, "submissions"),
      { ...paper, uid: state.uid, created: fb.serverTimestamp(), name: state.handle });
    closeForm();
    await vote(ref.id);  // adding a paper counts as an upvote, which can be taken back like any vote
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
    toast(`Copied ${shown.length} rows: Journal, Short Name, Title, URL.`);
  } catch {
    toast("Copying is blocked in this browser.");
  }
}

async function init() {
  try { const saved = (localStorage.getItem("handle") || "").toLowerCase(); if (HANDLE.test(saved)) state.handle = saved; } catch {}
  $("copy").addEventListener("click", link(copyTable));
  $("add-open").addEventListener("click", link(() => openPanel("add")));
  $("add-cancel").addEventListener("click", link(closeForm));
  $("add").addEventListener("submit", submitPaper);
  $("login-open").addEventListener("click", link(() => (state.handle ? setHandle("") : openPanel("login"))));
  $("login-cancel").addEventListener("click", link(() => { $("login").hidden = true; }));
  $("login").addEventListener("submit", login);
  $("past-open").addEventListener("click", link(() => togglePast()));
  $("me").addEventListener("click", link(() => go({ user: state.handle })));
  $("interested-open").addEventListener("click", link(() => go({ interested: state.handle })));
  // a click outside a pop-up, or Escape, closes it
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".links .menu")) togglePast(false);
    if (!e.target.closest(".pick-head .menu")) toggleScoreNote(false);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { togglePast(false); toggleScoreNote(false); } });
  $("score-help").addEventListener("click", link(() => toggleScoreNote()));
  $("this-month").addEventListener("click", link(() => loadMonth(state.months.at(-1))));
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
  connect();
  addEventListener("popstate", route);
  await route();
}

init();
