// Security-rule tests against the local Firestore emulator: `npm test` in firebase/.
import { test, before, after, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { arrayRemove, arrayUnion, collection, deleteDoc, deleteField, doc, getDoc, getDocs, increment, serverTimestamp,
  setDoc, updateDoc, writeBatch } from "firebase/firestore";

let env;
const M = "2026-10", P = "10.1038_s41588-026-00001-1", Q = "10.1101_2026.10.01.123456";
const OPEN = "2099-02", CLOSED = "2020-02", SID = "Ab3dEf6hIj9kLmNoPq2r";  // a month still taking added papers, one long listed
const db = (uid) => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore();
const monthRef = (d, m = M) => doc(d, "months", m);
const interestRef = (d, handle, m = M) => doc(d, "months", m, "interests", handle);
const subRef = (d, m = OPEN, id = SID) => doc(d, "months", m, "submissions", id);
const seed = (path, data) => env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), path), data));
async function count(m, p) {
  let n = 0;
  await env.withSecurityRulesDisabled(async (ctx) => { n = (await getDoc(doc(ctx.firestore(), "months", m))).get("counts")?.[p] ?? 0; });
  return n;
}

// The site's writes: interest in a paper, or none any more, with its count
function interest(uid, handle, p, on, { m = M, step = on ? 1 : -1, list = true, counts = true } = {}) {
  const d = db(uid), batch = writeBatch(d);
  if (list) batch.set(interestRef(d, handle, m), { papers: on ? arrayUnion(p) : arrayRemove(p), paper: p }, { merge: true });
  if (counts) batch.set(monthRef(d, m), { counts: { [p]: increment(step) }, paper: p }, { merge: true });
  return batch.commit();
}
const paper = (extra = {}) => ({ journal: "PNAS", title: "A paper the model missed", url: "https://doi.org/10.1073/pnas.1",
  short_name: "PNAS_Smith_2026_PaperPipelineMissed", created: serverTimestamp(), ...extra });
// Add a paper: the paper, the adder's interest in it and its count, in one batch
function addPaper(uid, handle, { m = OPEN, id = SID, extra = {}, list = true } = {}) {
  const d = db(uid), batch = writeBatch(d);
  batch.set(subRef(d, m, id), paper(extra));
  if (list) batch.set(interestRef(d, handle, m), { papers: arrayUnion(id), added: arrayUnion(id), paper: id }, { merge: true });
  batch.set(monthRef(d, m), { counts: { [id]: increment(1) }, paper: id }, { merge: true });
  return batch.commit();
}
function removePaper(uid, handle, { m = OPEN, id = SID, sub = true } = {}) {
  const d = db(uid), batch = writeBatch(d);
  if (sub) batch.delete(subRef(d, m, id));
  batch.set(interestRef(d, handle, m), { papers: arrayRemove(id), added: arrayRemove(id), paper: id }, { merge: true });
  batch.set(monthRef(d, m), { counts: { [id]: deleteField() }, paper: id }, { merge: true });
  return batch.commit();
}

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-statgenpapers",
    firestore: { rules: readFileSync(new URL("firestore.rules", import.meta.url), "utf8"), host: "127.0.0.1", port: 8085 },
  });
});
after(() => env.cleanup());
beforeEach(async () => {
  await env.clearFirestore();
  await assertSucceeds(interest("uid-a", "alice", P, true));
});

// Counts
test("anyone reads a month's counts without signing in", () => assertSucceeds(getDoc(monthRef(db(null)))));
test("interest raises a count by one; taking it back lowers it", async () => {
  await assertSucceeds(interest("uid-b", "bob", P, true));
  assert(await count(M, P) === 2);
  await assertSucceeds(interest("uid-b", "bob", P, false));
  assert(await count(M, P) === 1);
});
test("unauthenticated browsers cannot write", async () => {
  await assertFails(interest(null, "bob", P, true));
  await assertFails(setDoc(monthRef(db(null)), { counts: { [P]: increment(1) }, paper: P }, { merge: true }));
});
test("a count moves by one, of the paper named, and never below 0", async () => {
  const d = db("uid-b");
  await assertFails(setDoc(monthRef(d), { counts: { [P]: increment(2) }, paper: P }, { merge: true }));
  await assertFails(setDoc(monthRef(d), { counts: { [P]: increment(1) }, paper: Q }, { merge: true }));
  await assertFails(setDoc(monthRef(d), { counts: { [P]: increment(1), [Q]: increment(1) }, paper: P }, { merge: true }));
  await assertFails(setDoc(monthRef(d), { counts: { [P]: "2" }, paper: P }, { merge: true }));
  await assertFails(setDoc(monthRef(d), { counts: { [P]: increment(1) }, paper: P, by: "bob" }, { merge: true }));
  await assertFails(setDoc(monthRef(d), { counts: { "a b": increment(1) }, paper: "a b" }, { merge: true }));
  await assertSucceeds(setDoc(monthRef(d), { counts: { [Q]: increment(1) }, paper: Q }, { merge: true }));
  await assertSucceeds(setDoc(monthRef(d), { counts: { [Q]: increment(-1) }, paper: Q }, { merge: true }));
  await assertFails(setDoc(monthRef(d), { counts: { [Q]: increment(-1) }, paper: Q }, { merge: true }));
});
test("a count is not dropped, except with its added paper", () =>
  assertFails(setDoc(monthRef(db("uid-b")), { counts: { [P]: deleteField() }, paper: P }, { merge: true })));
test("the frozen interest of admin keeps its counts at 1 or more", async () => {
  await seed(`months/${M}/interests/admin`, { papers: [Q] });
  await seed(`months/${M}`, { counts: { [P]: 1, [Q]: 1 } });
  await assertFails(setDoc(monthRef(db("uid-b")), { counts: { [Q]: increment(-1) }, paper: Q }, { merge: true }));
  await assertSucceeds(setDoc(monthRef(db("uid-b")), { counts: { [P]: increment(-1) }, paper: P }, { merge: true }));
});
test("month ids are checked", () => assertFails(interest("uid-b", "bob", P, true, { m: "2026-13" })));

// A handle's interest
test("a handle's interest is read by its exact handle, never listed", async () => {
  await assertSucceeds(getDoc(interestRef(db(null), "alice")));
  await assertFails(getDocs(collection(db(null), "months", M, "interests")));
  await assertFails(getDocs(collection(db("uid-a"), "months", M, "interests")));
});
test("interest and its count change together", async () => {
  await assertFails(interest("uid-b", "alice", Q, true, { counts: false }));
  await assertFails(interest("uid-b", "alice", P, false, { counts: false }));
  await assertFails(interest("uid-b", "alice", Q, true, { step: -1 }));
  await assertSucceeds(interest("uid-b", "alice", Q, true));
});
test("interest in a paper counts once: a second, from another tab, is refused", async () => {
  await assertFails(interest("uid-b", "alice", P, true));
  assert(await count(M, P) === 1);
  await assertFails(interest("uid-b", "alice", Q, false));
});
test("a change is one paper, the one named", async () => {
  const d = db("uid-b");
  const batch = writeBatch(d);
  batch.set(interestRef(d, "alice"), { papers: arrayUnion(Q, "other"), paper: Q }, { merge: true });
  batch.set(monthRef(d), { counts: { [Q]: increment(1) }, paper: Q }, { merge: true });
  await assertFails(batch.commit());
  await assertFails(updateDoc(interestRef(d, "alice"), { papers: [P], paper: P, extra: 1 }));
});
test("handles are 2-20 lower-case letters, digits or _; admin is frozen", async () => {
  for (const handle of ["e", "E_f", "e.f", "a".repeat(21), "admin"]) await assertFails(interest("uid-b", handle, Q, true));
  await assertSucceeds(interest("uid-b", "under_score9", Q, true));
  await seed(`months/${M}/interests/admin`, { papers: [Q] });
  await assertFails(interest("uid-b", "admin", Q, false));
  await assertFails(deleteDoc(interestRef(db("uid-b"), "admin")));
});
test("a changed handle: its interest moves to a new document", async () => {
  const d = db("uid-b"), batch = writeBatch(d);
  batch.set(interestRef(d, "alicia"), { papers: [P], added: [] });
  batch.delete(interestRef(d, "alice"));
  await assertSucceeds(batch.commit());
  await assertSucceeds(interest("uid-a", "alicia", P, false));
});
test("a handle's lists are bounded in size", async () => {  // the rules cannot check each element: join bounds them all
  await assertFails(setDoc(interestRef(db("uid-b"), "carol"), { papers: ["x".repeat(151001)], added: [] }));
  await assertFails(setDoc(interestRef(db("uid-b"), "carol"), { papers: [], added: ["x".repeat(4101)] }));
});
test("a handle's interest cannot be written over another's", async () => {
  await assertSucceeds(interest("uid-b", "bob", Q, true));
  await assertFails(setDoc(interestRef(db("uid-a"), "bob"), { papers: [P], added: [] }));
});

// Added papers
test("a paper is added with the adder's interest and its count", async () => {
  await assertSucceeds(addPaper("uid-b", "bob"));
  assert(await count(OPEN, SID) === 1);
  await assertSucceeds(addPaper("uid-b", "carol", { id: "Second0paper" }));  // a handle's first write of the month
  await assertSucceeds(addPaper("uid-b", "carol", { id: "Third0paper" }));  // and a later one
  assert(await count(OPEN, "Third0paper") === 1);
});
test("an added paper's interest and count need the paper", async () => {
  await assertSucceeds(interest("uid-b", "bob", Q, true, { m: OPEN }));
  const d = db("uid-b"), batch = writeBatch(d);
  batch.set(interestRef(d, "bob", OPEN), { papers: arrayUnion(SID), added: arrayUnion(SID), paper: SID }, { merge: true });
  batch.set(monthRef(d, OPEN), { counts: { [SID]: increment(1) }, paper: SID }, { merge: true });
  await assertFails(batch.commit());
});
test("anyone reads and lists added papers without signing in", async () => {
  await assertSucceeds(addPaper("uid-b", "bob"));
  await assertSucceeds(getDocs(collection(db(null), "months", OPEN, "submissions")));
});
test("an added paper names no reader, and is checked", async () => {
  for (const extra of [{ name: "bob" }, { uid: "uid-b" }, { score: 99 }, { url: "javascript:alert(1)" }, { title: "" },
    { title: "x".repeat(401) }, { authors: "A. Smith" }, { authors: ["x".repeat(10001)] },
    { abstract: "x".repeat(10001) }, { date: "October" }, { created: new Date(0) }]) {
    await assertFails(addPaper("uid-b", "bob", { extra }));
  }
  await assertFails(setDoc(subRef(db("uid-b")), { journal: "PNAS", title: "t", url: "https://x.org", created: serverTimestamp() }));
  await assertFails(addPaper("uid-b", "bob", { id: "10.1038_x" }));
  await assertSucceeds(addPaper("uid-b", "bob", { extra: { authors: ["A. Smith"], abstract: "We show.", date: "2026-10-05" } }));
});
test("papers are added to a month until the 15th of the next", async () => {
  await assertFails(addPaper("uid-b", "bob", { m: CLOSED }));
  await assertFails(setDoc(subRef(db("uid-b"), CLOSED), paper()));
  await assertFails(setDoc(subRef(db(null)), paper()));
});
test("an added paper's content can be edited while its month is open; never its time", async () => {
  await assertSucceeds(addPaper("uid-b", "bob"));
  await assertSucceeds(updateDoc(subRef(db("uid-c")), { title: "Changed", date: "2026-10-05", abstract: "We show." }));
  await assertSucceeds(updateDoc(subRef(db("uid-b")), { date: deleteField() }));
  await assertFails(updateDoc(subRef(db(null)), { title: "Changed again" }));
  for (const change of [{ title: "" }, { date: "October" }, { url: "javascript:alert(1)" }, { created: new Date(0) }, { name: "bob" }]) {
    await assertFails(updateDoc(subRef(db("uid-b")), change));
  }
  await seed(`months/${CLOSED}/submissions/${SID}`, paper({ created: new Date(0) }));
  await assertFails(updateDoc(subRef(db("uid-b"), CLOSED), { title: "Changed" }));
});
test("an added paper is removed with its count and from its adder's interest", async () => {
  await assertSucceeds(addPaper("uid-b", "bob"));
  await assertSucceeds(interest("uid-a", "alice", SID, true, { m: OPEN }));
  await assertFails(removePaper("uid-b", "alice"));  // only by the handle that added it
  await assertSucceeds(removePaper("uid-c", "bob"));
  assert((await getDoc(subRef(db(null)))).exists() === false);
  assert(await count(OPEN, SID) === 0);
});
test("a count is dropped only with its paper", async () => {
  await assertSucceeds(addPaper("uid-b", "bob"));
  await assertFails(removePaper("uid-b", "bob", { sub: false }));
});
test("once its month is closed, an added paper stays", async () => {
  await seed(`months/${CLOSED}/submissions/${SID}`, paper({ created: new Date(0) }));
  await seed(`months/${CLOSED}/interests/bob`, { papers: [SID], added: [SID] });
  await seed(`months/${CLOSED}`, { counts: { [SID]: 1 } });
  await assertFails(deleteDoc(subRef(db("uid-b"), CLOSED)));
  await assertFails(removePaper("uid-b", "bob", { m: CLOSED }));
});
test("everything else is closed, including the votes of the first version", async () => {
  await assertFails(setDoc(doc(db("uid-a"), "months", M, "votes", `${P}~alice`), { paper: P, handle: "alice" }));
  await assertFails(getDocs(collection(db(null), "months", M, "votes")));
  await assertFails(getDocs(collection(db(null), "months")));
  await assertFails(setDoc(doc(db("uid-a"), "other/x"), { a: 1 }));
});

function assert(ok) {
  if (!ok) throw new Error("assertion failed");
}
