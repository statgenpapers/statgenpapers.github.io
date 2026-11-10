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
  votes: new Map(),  // paper id -> { uid: { v: 1, name? } }
  subs: [],          // papers added by visitors
  uid: null, live: false,
};
const rows = new Map();  // paper id -> <li>
let fb = null, db = null, unsubscribe = [];

// ---------------------------------------------------------------- helpers

function toast(message) {
  const t = $("toast");
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3500);
}

const monthName = (m) => new Date(+m.slice(0, 4), +m.slice(5) - 1).toLocaleString("en", { month: "long", year: "numeric" });
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

// Upvotes of a paper: [uid, { v, name? }] pairs. Only v = 1 counts.
const upvotes = (id) => Object.entries(state.votes.get(id) || {}).filter(([, x]) => x.v === 1);
const mine = (id) => state.votes.get(id)?.[state.uid]?.v === 1;

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

// ---------------------------------------------------------------- rendering

function createRow(p) {
  const li = $("row").content.firstElementChild.cloneNode(true);
  const q = (sel) => li.querySelector(sel);
  const url = httpUrl(p.url);
  q(".abbr").textContent = p.journal;
  q(".abbr").title = p.venue_name || "";
  if (p.added) q(".journal").append(el("span", "kind", "added"));
  q(".short").append(...p.short_name.split("_").flatMap((part, i) => (i ? ["_", document.createElement("wbr"), part] : [part])));  // wrap after underscores first
  q(".title").textContent = p.title;
  q(".url").textContent = (p.url || "").replace(/^https?:\/\/(www\.)?/i, "");
  q(".url").title = p.url || "";
  for (const a of [q(".title"), q(".url")]) url ? (a.href = url) : a.removeAttribute("href");
  const a = p.authors || [], cut = a.length === 100;  // OpenAlex lists at most 100 authors, so the last ones are unknown
  const authors = a.length <= 4 ? a.join(", ") : `${a.slice(0, 2).join(", ")}, …${cut ? "" : `, ${a.slice(-2).join(", ")}`}`;  // first two … last two
  const meta = p.added ? [`Added by ${p.name || "a visitor"}`] : [authors, p.date, `score ${p.score.toFixed(2)}`];
  q(".meta").append(...meta.filter(Boolean).flatMap((text, i) => [i ? " · " : "", el("span", i ? "nowrap" : "", text)]));
  q(".toggle").textContent = p.added ? "Details" : "Abstract";
  q(".toggle").addEventListener("click", () => {
    const open = q(".details").hidden;
    q(".details").hidden = !open;
    q(".toggle").setAttribute("aria-expanded", open);
  });
  q(".up").addEventListener("click", () => vote(p.id));

  const details = q(".details");
  if (!p.added) {
    details.append(el("p", "", (p.abstract || "").replace(/^abstract[\s:.]+(?=[A-Z])/i, "") || "No abstract available."));
    if (a.length > 4) details.append(el("p", "who", `Authors: ${a.join(", ")}${cut ? ", …" : ""}`));
  }
  details.append(el("p", "who voters"));
  if (p.added) {
    const remove = el("button", "remove", "Remove this paper");
    remove.hidden = true;
    remove.addEventListener("click", () => removeSubmission(p));
    details.append(remove);
  }
  return li;
}

function updateRow(li, p) {
  const ups = upvotes(p.id), q = (sel) => li.querySelector(sel);
  const named = ups.map(([, x]) => x.name).filter(Boolean), anonymous = ups.length - named.length;
  q(".count").textContent = ups.length;
  q(".up").setAttribute("aria-pressed", mine(p.id));
  q(".up").setAttribute("aria-label", mine(p.id) ? "Remove your upvote" : "Upvote");
  q(".up").disabled = !state.uid;
  q(".voters").textContent = ups.length ? `Upvoted by ${[...named, ...(anonymous ? [`${anonymous} anonymous`] : [])].join(", ")}` : "No votes yet.";
  if (p.added) q(".remove").hidden = p.uid !== state.uid;
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
  const d = state.data, all = items(), added = all.length - (d?.papers.length || 0);
  const votes = all.reduce((sum, p) => sum + upvotes(p.id).length, 0);
  const status = $("status");
  status.textContent = d
    ? `Top ${d.papers.length} of ${d.pool.toLocaleString("en")} candidates${added ? `, plus ${added} added by visitors` : ""} · ${votes} vote${votes === 1 ? "" : "s"} · `
    : "";
  if (d) status.append(el("span", state.live ? "live" : "", state.live ? "● live" : "connecting…"));
}

// ---------------------------------------------------------------- data

async function loadMonth(month) {
  state.month = month;
  state.data = null;
  state.votes = new Map();
  state.subs = [];
  rows.clear();
  $("month").value = month;
  $("prev").disabled = state.months.indexOf(month) <= 0;
  $("next").disabled = state.months.indexOf(month) >= state.months.length - 1;
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
  unsubscribe.push(fb.onSnapshot(at("papers"), (snap) => {
    state.votes = new Map(snap.docs.map((d) => [d.id, d.data().votes || {}]));
    state.live = true;
    render();
  }, (e) => { state.live = false; console.warn("votes", e); render(); }));
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
    if (!user.currentUser) {  // silent: no prompt, the id stays in this browser
      await fb.signInAnonymously(user).catch((e) => { console.warn(e); toast("Voting is unavailable right now; the list is still live."); });
    }
    fb.onAuthStateChanged(user, (u) => { state.uid = u?.uid || null; render(); });
    // Long-polling, not the default streaming with proxy auto-detection: in tests the default showed
    // another browser's vote more than half a minute late after about 1 page load in 50.
    db = fb.initializeFirestore(instance, { experimentalForceLongPolling: true });
    listen();
  } catch (e) {
    console.warn(e);
    toast("Voting is unavailable right now; the list is still readable.");
  }
}

// ---------------------------------------------------------------- writes

const myName = () => $("name").value.trim().slice(0, 40);

// Upvote a paper, or take the upvote back if this browser already gave one.
async function vote(id) {
  if (!state.uid) return toast("Still connecting; try again in a moment.");
  const ref = fb.doc(db, "months", state.month, "papers", id), field = `votes.${state.uid}`;
  const entry = { v: 1, ...(myName() && { name: myName() }) };
  try {
    if (mine(id)) await fb.updateDoc(ref, { [field]: fb.deleteField() });
    else if (state.votes.has(id)) await fb.updateDoc(ref, { [field]: entry });
    else await fb.setDoc(ref, { votes: { [state.uid]: entry } }, { merge: true });  // first vote on this paper
  } catch (e) {
    console.warn(e);
    toast("Your vote was not saved.");
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
  if (!httpUrl(paper.url)) return note("The URL must start with http:// or https://.", true);
  const doi = urlDoi(paper.url);
  if (items().some((p) => p.url === paper.url || (doi && (p.doi || urlDoi(p.url)) === doi))) return note("This paper is already on the list.", true);
  try {
    const ref = await fb.addDoc(fb.collection(db, "months", state.month, "submissions"),
      { ...paper, uid: state.uid, created: fb.serverTimestamp(), ...(myName() && { name: myName() }) });
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
  $("name").value = localStorage.getItem("name") || "";
  $("name").addEventListener("input", () => localStorage.setItem("name", myName()));
  $("copy").addEventListener("click", copyTable);
  $("add-open").addEventListener("click", () => { $("add").hidden = !$("add").hidden; if (!$("add").hidden) field("url").focus(); });
  $("add-cancel").addEventListener("click", closeForm);
  $("add").addEventListener("submit", submitPaper);
  field("url").addEventListener("change", lookUp);
  field("journal").addEventListener("input", refreshShortName);
  field("title").addEventListener("input", refreshShortName);
  field("short").addEventListener("input", () => { form.edited = field("short").value !== ""; });
  $("month").addEventListener("change", () => loadMonth($("month").value));
  const step = (by) => () => loadMonth(state.months[state.months.indexOf(state.month) + by]);
  $("prev").addEventListener("click", step(-1));
  $("next").addEventListener("click", step(1));

  const index = await fetch("data/index.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : { months: [] }), () => ({ months: [] }));
  state.months = index.months;
  if (!state.months.length) {
    $("status").textContent = "No lists yet.";
    return;
  }
  $("month").replaceChildren(...[...state.months].reverse().map((m) => Object.assign(el("option", "", monthName(m)), { value: m })));
  const asked = new URLSearchParams(location.search).get("month");
  connect();
  await loadMonth(state.months.includes(asked) ? asked : state.months.at(-1));
}

init();
