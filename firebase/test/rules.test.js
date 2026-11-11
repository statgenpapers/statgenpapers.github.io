// Security-rule tests against the local Firestore emulator: `npm test` in firebase/.
import { test, before, after, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, query, where, setDoc, updateDoc, deleteDoc, serverTimestamp } from "firebase/firestore";

let env;
const M = "months/2026-10", P = "10.1038_s41588-026-00001-1";
const db = (uid) => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore();
// An upvote is the document months/{m}/votes/{paper}~{handle in lower case}.
const vote = (uid, handle, { paper = P, id = `${paper}~${String(handle).toLowerCase()}`, month = M, ...extra } = {}) =>
  setDoc(doc(db(uid), `${month}/votes/${id}`), { paper, handle, ...extra });

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-statgenpapers",
    firestore: { rules: readFileSync(new URL("../firestore.rules", import.meta.url), "utf8"), host: "127.0.0.1", port: 8085 },
  });
});
after(() => env.cleanup());
beforeEach(async () => {
  await env.clearFirestore();
  await assertSucceeds(vote("uid-a", "alice"));
});

test("anyone can read votes without signing in", () => assertSucceeds(getDocs(collection(db(null), `${M}/votes`))));
test("unauthenticated cannot vote", () => assertFails(vote(null, "carol")));
test("a second handle upvotes the same paper", () => assertSucceeds(vote("uid-b", "bob")));
test("one upvote per handle and paper: a second write is an update, which is closed", () =>
  assertFails(vote("uid-b", "alice")));
test("an upvote cannot be edited", () => assertFails(updateDoc(doc(db("uid-a"), `${M}/votes/${P}~alice`), { handle: "ALICE" })));
test("the id must be paper~handle; handles are lower case", async () => {
  await assertFails(vote("uid-b", "bob", { id: `${P}~carol` }));
  await assertFails(vote("uid-b", "Dave", { id: `${P}~Dave` }));
  await assertFails(vote("uid-b", "Dave"));
  await assertFails(vote("uid-b", "bob", { id: `other~bob` }));
});
test("handles are 2-20 lower-case letters, digits or _", async () => {
  await assertFails(vote("uid-b", "e"));
  await assertFails(vote("uid-b", "e.f"));
  await assertFails(vote("uid-b", "a".repeat(21)));
  await assertFails(vote("uid-b", 12, { id: `${P}~12` }));
  await assertSucceeds(vote("uid-b", "under_score9"));
});
test("no other fields, so no downvote or weight", () => assertFails(vote("uid-b", "bob", { v: -1 })));
test("an upvote stores no time", () => assertFails(vote("uid-b", "bob", { created: serverTimestamp() })));
test("paper id must be well formed", () => assertFails(vote("uid-b", "bob", { paper: "a b" })));
test("month must be well formed", () => assertFails(vote("uid-b", "bob", { month: "months/junk" })));
test("any signed-in browser may take back a handle's upvote (handles have no password)", () =>
  assertSucceeds(deleteDoc(doc(db("uid-b"), `${M}/votes/${P}~alice`))));
test("unauthenticated cannot take back an upvote", () => assertFails(deleteDoc(doc(db(null), `${M}/votes/${P}~alice`))));
test("the uid-keyed papers collection of the first version is closed", async () => {
  await assertFails(setDoc(doc(db("uid-a"), `${M}/papers/${P}`), { votes: { "uid-a": { v: 1 } } }));
  await assertFails(getDoc(doc(db(null), `${M}/papers/${P}`)));
});
test("the handle admin is reserved for the lab's user", async () => {
  const LAB = "Yo7cchMxl7X4zHq5vOE9VmS2dOp1";
  await assertFails(vote("uid-b", "admin"));
  await assertSucceeds(vote(LAB, "admin"));
  await assertFails(deleteDoc(doc(db("uid-b"), `${M}/votes/${P}~admin`)));
  await assertSucceeds(deleteDoc(doc(db(LAB), `${M}/votes/${P}~admin`)));
});
test("cannot write elsewhere", () => assertFails(setDoc(doc(db("uid-a"), "other/x"), { a: 1 })));

// Papers added by visitors
const SUB = `${M}/submissions/Ab3dEf6hIj9kLmNoPq2r`;
const paper = (uid, extra = {}) => ({ journal: "PNAS", title: "A paper the pipeline missed", url: "https://doi.org/10.1073/pnas.1",
  short_name: "PNAS_Smith_2026_PaperPipelineMissed", uid, created: serverTimestamp(), name: "bob", ...extra });
const submit = (uid, extra, path = SUB) => setDoc(doc(db(uid), path), paper(uid, extra));

test("signed-in visitor submits a paper under a handle", () => assertSucceeds(submit("bob")));
test("only the lab's user adds papers as admin", async () => {
  await assertFails(submit("bob", { name: "admin" }));
  await assertSucceeds(submit("Yo7cchMxl7X4zHq5vOE9VmS2dOp1", { name: "admin" }));
});
test("anyone can read submissions without signing in", () => assertSucceeds(getDoc(doc(db(null), SUB))));
test("unauthenticated cannot submit", () => assertFails(setDoc(doc(db(null), SUB), paper("bob"))));
test("cannot submit under another uid", () => assertFails(setDoc(doc(db("bob"), SUB), paper("alice"))));
test("a submission needs a valid handle", async () => {
  const { name, ...anonymous } = paper("bob");
  await assertFails(setDoc(doc(db("bob"), SUB), anonymous));
  await assertFails(submit("bob", { name: "a b" }));
});
test("cannot submit a non-http url", () => assertFails(submit("bob", { url: "javascript:alert(1)" })));
test("cannot submit an empty or oversized title", async () => {
  await assertFails(submit("bob", { title: "" }));
  await assertFails(submit("bob", { title: "x".repeat(401) }));
});
test("cannot submit extra or missing fields", async () => {
  await assertFails(submit("bob", { score: 99 }));
  await assertFails(setDoc(doc(db("bob"), SUB), { journal: "PNAS", title: "t", url: "https://x.org", uid: "bob", created: serverTimestamp(), name: "bob" }));
});
test("cannot backdate a submission", () => assertFails(submit("bob", { created: new Date(0) })));
test("cannot submit under a malformed month or id", async () => {
  await assertFails(submit("bob", {}, "months/junk/submissions/abc"));
  await assertFails(submit("bob", {}, `${M}/submissions/10.1038_x`));
});
test("nobody can edit a submission", async () => {
  await assertSucceeds(submit("bob"));
  await assertFails(updateDoc(doc(db("bob"), SUB), { title: "Changed" }));
  await assertFails(submit("bob", { title: "Changed" }));
});
test("only the submitter can delete a submission", async () => {
  await assertSucceeds(submit("bob"));
  await assertFails(deleteDoc(doc(db("alice"), SUB)));
  await assertSucceeds(deleteDoc(doc(db("bob"), SUB)));
});
test("a submitted paper can be upvoted like any other, by its submission id", async () => {
  await assertSucceeds(submit("bob"));
  await assertSucceeds(vote("uid-a", "alice", { paper: SUB.split("/").pop() }));
});
test("a handle's marks can be listed with one query", () =>
  assertSucceeds(getDocs(query(collection(db(null), `${M}/votes`), where("handle", "==", "alice")))));
