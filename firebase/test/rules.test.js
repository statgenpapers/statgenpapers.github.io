// Security-rule tests against the local Firestore emulator: `npm test` in firebase/.
import { test, before, after, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc, deleteField } from "firebase/firestore";

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
