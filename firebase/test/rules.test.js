// Security-rule tests against the local Firestore emulator: `npm test` in firebase/.
import { test, before, after, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc, deleteField, serverTimestamp } from "firebase/firestore";

let env;
const PATH = "months/2026-10/papers/10.1038_s41588-026-00001-1";
const db = (uid) => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore();
const vote = (uid, v, extra = {}) => updateDoc(doc(db(uid), PATH), { [`votes.${uid}`]: { v, ...extra } });

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-statgenpapers",
    firestore: { rules: readFileSync(new URL("../firestore.rules", import.meta.url), "utf8"), host: "127.0.0.1", port: 8085 },
  });
});
after(() => env.cleanup());
beforeEach(async () => {
  await env.clearFirestore();
  await assertSucceeds(setDoc(doc(db("alice"), PATH), { votes: { alice: { v: 1 } } }));
});

test("anyone can read without signing in", () => assertSucceeds(getDoc(doc(db(null), PATH))));
test("unauthenticated cannot vote", () => assertFails(setDoc(doc(db(null), "months/2026-10/papers/x"), { votes: {} })));
test("second voter adds own vote, with a name", () => assertSucceeds(vote("bob", -1, { name: "Bob" })));
test("voter changes own vote", () => assertSucceeds(vote("alice", -1)));
test("voter removes own vote", () => assertSucceeds(updateDoc(doc(db("alice"), PATH), { "votes.alice": deleteField() })));
test("cannot change another voter's vote", () => assertFails(updateDoc(doc(db("bob"), PATH), { "votes.alice": { v: -1 } })));
test("cannot remove another voter's vote", () => assertFails(updateDoc(doc(db("bob"), PATH), { "votes.alice": deleteField() })));
test("cannot overwrite the whole map", () => assertFails(setDoc(doc(db("bob"), PATH), { votes: { bob: { v: 1 } } })));
test("cannot vote with weight other than +-1", () => assertFails(vote("bob", 5)));
test("cannot add other fields to a vote", () => assertFails(vote("bob", 1, { admin: true })));
test("cannot add top-level fields", () => assertFails(updateDoc(doc(db("bob"), PATH), { count: 99 })));
test("name is capped at 40 characters", () => assertFails(vote("bob", 1, { name: "x".repeat(41) })));
test("cannot create a doc holding someone else's vote", () =>
  assertFails(setDoc(doc(db("bob"), "months/2026-10/papers/y"), { votes: { alice: { v: 1 } } })));
test("cannot create under a malformed month", () =>
  assertFails(setDoc(doc(db("bob"), "months/junk/papers/y"), { votes: { bob: { v: 1 } } })));
test("cannot delete a paper document", () => assertFails(deleteDoc(doc(db("alice"), PATH))));
test("cannot write elsewhere", () => assertFails(setDoc(doc(db("alice"), "other/x"), { a: 1 })));

// Papers added by visitors
const SUB = "months/2026-10/submissions/Ab3dEf6hIj9kLmNoPq2r";
const paper = (uid, extra = {}) => ({ journal: "PNAS", title: "A paper the pipeline missed", url: "https://doi.org/10.1073/pnas.1",
  short_name: "PNAS_Smith_2026_PaperPipelineMissed", uid, created: serverTimestamp(), ...extra });
const submit = (uid, extra, path = SUB) => setDoc(doc(db(uid), path), paper(uid, extra));

test("signed-in visitor submits a paper, with a name", () => assertSucceeds(submit("bob", { name: "Bob" })));
test("anyone can read submissions without signing in", () => assertSucceeds(getDoc(doc(db(null), SUB))));
test("unauthenticated cannot submit", () => assertFails(setDoc(doc(db(null), SUB), paper("bob"))));
test("cannot submit under another uid", () => assertFails(setDoc(doc(db("bob"), SUB), paper("alice"))));
test("cannot submit a non-http url", () => assertFails(submit("bob", { url: "javascript:alert(1)" })));
test("cannot submit an empty or oversized title", async () => {
  await assertFails(submit("bob", { title: "" }));
  await assertFails(submit("bob", { title: "x".repeat(401) }));
});
test("cannot submit extra or missing fields", async () => {
  await assertFails(submit("bob", { score: 99 }));
  await assertFails(setDoc(doc(db("bob"), SUB), { journal: "PNAS", title: "t", url: "https://x.org", uid: "bob", created: serverTimestamp() }));
});
test("cannot backdate a submission", () => assertFails(submit("bob", { created: new Date(0) })));
test("cannot submit under a malformed month or id", async () => {
  await assertFails(submit("bob", {}, "months/junk/submissions/abc"));
  await assertFails(submit("bob", {}, "months/2026-10/submissions/10.1038_x"));
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
test("a submitted paper can be voted on like any other", async () => {
  await assertSucceeds(submit("bob"));
  await assertSucceeds(setDoc(doc(db("alice"), SUB.replace("submissions", "papers")), { votes: { alice: { v: 1 } } }, { merge: true }));
});
