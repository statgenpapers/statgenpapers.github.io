// End-to-end check of the live Firebase project: `node live-check.mjs` in firebase/.
// Signs in two anonymous users, votes, adds a paper, checks that tampering is rejected, and
// removes the votes and the paper again. Leaves a document at months/2020-01/papers/_selftest
// (a month the site never shows).
import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import { getFirestore, doc, getDoc, setDoc, updateDoc, deleteField, onSnapshot, collection, addDoc, deleteDoc, serverTimestamp } from "firebase/firestore";
import { readFileSync } from "node:fs";

// site/ is served as browser ES modules without a package.json, so read the object literal directly
const firebaseConfig = new Function("return " + readFileSync(new URL("../site/config.js", import.meta.url), "utf8")
  .match(/firebaseConfig = (\{[\s\S]*?\});/)[1])();

const client = async (name) => {
  const app = initializeApp(firebaseConfig, name);
  const { user } = await signInAnonymously(getAuth(app));
  return { uid: user.uid, db: getFirestore(app) };
};
const denied = (p) => p.then(() => false, (e) => e.code === "permission-denied");
const PATH = "months/2020-01/papers/_selftest";
const check = (label, ok) => { console.log(ok ? "PASS" : "FAIL", label); if (!ok) process.exitCode = 1; };

const a = await client("a"), b = await client("b");
check("anonymous sign-in gives two distinct users", a.uid && b.uid && a.uid !== b.uid);
const ref = (c) => doc(c.db, PATH);
if (!(await getDoc(ref(a))).exists()) await setDoc(ref(a), { votes: {} });

const t0 = Date.now();
const seen = new Promise((resolve) => {
  const stop = onSnapshot(ref(b), (s) => { if (s.data()?.votes?.[a.uid]?.v === 1) { stop(); resolve(Date.now() - t0); } });
});
await updateDoc(ref(a), { [`votes.${a.uid}`]: { v: 1, name: "selftest" } });
check(`second client sees the vote live (${await seen} ms)`, true);
await updateDoc(ref(b), { [`votes.${b.uid}`]: { v: -1 } });
check("each user's vote is stored", Object.keys((await getDoc(ref(a))).data().votes).length >= 2);
check("changing another user's vote is rejected", await denied(updateDoc(ref(b), { [`votes.${a.uid}`]: { v: -1 } })));
check("vote weight other than +-1 is rejected", await denied(updateDoc(ref(b), { [`votes.${b.uid}`]: { v: 100 } })));
check("adding a counter field is rejected", await denied(updateDoc(ref(b), { count: 99 })));
check("writing outside months/*/papers is rejected", await denied(setDoc(doc(b.db, "other/x"), { a: 1 })));
await updateDoc(ref(a), { [`votes.${a.uid}`]: deleteField() });
await updateDoc(ref(b), { [`votes.${b.uid}`]: deleteField() });
const left = (await getDoc(ref(a))).data().votes;
check("own votes removed again", !(a.uid in left) && !(b.uid in left));

const submissions = (c) => collection(c.db, "months/2020-01/submissions");
const paper = (c, extra = {}) => ({ journal: "Selftest", title: "Self-test paper", url: "https://example.org/selftest",
  short_name: "Selftest_2020_SelfTestPaper", uid: c.uid, created: serverTimestamp(), ...extra });
const added = await addDoc(submissions(a), paper(a));
check("a visitor adds a paper", (await getDoc(doc(b.db, added.path))).data()?.title === "Self-test paper");
check("adding a paper under another uid is rejected", await denied(addDoc(submissions(b), paper(a))));
check("adding a paper with a non-http URL is rejected", await denied(addDoc(submissions(b), paper(b, { url: "javascript:alert(1)" }))));
check("editing someone else's paper is rejected", await denied(updateDoc(doc(b.db, added.path), { title: "Changed" })));
check("removing someone else's paper is rejected", await denied(deleteDoc(doc(b.db, added.path))));
await deleteDoc(added);
check("the submitter removes the paper again", !(await getDoc(doc(b.db, added.path))).exists());

for (const name of ["papers", "submissions"]) {
  const rest = await fetch(`https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/months/2020-01/${name}`);
  check(`unauthenticated REST read of ${name} works (HTTP ${rest.status}), as the monthly job needs`, rest.ok);
}
process.exit();
