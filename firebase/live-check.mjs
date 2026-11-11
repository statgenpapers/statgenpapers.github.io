// End-to-end check of the live Firebase project: `node live-check.mjs` in firebase/.
// Signs in two anonymous users, upvotes as two handles, adds a paper, checks that tampering is
// rejected, and removes the upvotes and the paper again, in months/2020-01 (a month the site never shows).
import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import { getFirestore, doc, getDoc, setDoc, updateDoc, onSnapshot, collection, addDoc, deleteDoc, serverTimestamp } from "firebase/firestore";
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
const MONTH = "months/2020-01", PAPER = "_selftest";
const check = (label, ok) => { console.log(ok ? "PASS" : "FAIL", label); if (!ok) process.exitCode = 1; };

const a = await client("a"), b = await client("b");
check("anonymous sign-in gives two distinct users", a.uid && b.uid && a.uid !== b.uid);
const ref = (c, handle) => doc(c.db, `${MONTH}/votes/${PAPER}~${handle.toLowerCase()}`);

const t0 = Date.now();
const seen = new Promise((resolve) => {
  const stop = onSnapshot(ref(b, "selftest_a"), (s) => { if (s.exists()) { stop(); resolve(Date.now() - t0); } });
});
await setDoc(ref(a, "selftest_a"), { paper: PAPER, handle: "SelfTest_A" });
check(`second client sees the upvote live (${await seen} ms)`, true);
await setDoc(ref(b, "selftest_b"), { paper: PAPER, handle: "selftest_b" });
check("each handle's upvote is stored", (await getDoc(ref(a, "selftest_b"))).exists());
check("a second upvote of the same handle is rejected", await denied(setDoc(ref(b, "selftest_a"), { paper: PAPER, handle: "selftest_a" })));
check("an upvote whose id does not match its handle is rejected", await denied(setDoc(ref(b, "selftest_c"), { paper: PAPER, handle: "other" })));
check("a downvote field is rejected", await denied(setDoc(ref(b, "selftest_d"), { paper: PAPER, handle: "selftest_d", v: -1 })));
check("writing to the old papers collection is rejected", await denied(setDoc(doc(b.db, `${MONTH}/papers/${PAPER}`), { votes: {} })));
check("writing elsewhere is rejected", await denied(setDoc(doc(b.db, "other/x"), { a: 1 })));
await deleteDoc(ref(b, "selftest_a"));  // handles have no password: any browser may take a handle's upvote back
await deleteDoc(ref(a, "selftest_b"));
check("upvotes removed again", !(await getDoc(ref(a, "selftest_a"))).exists() && !(await getDoc(ref(a, "selftest_b"))).exists());

const submissions = (c) => collection(c.db, "months/2020-01/submissions");
const paper = (c, extra = {}) => ({ journal: "Selftest", title: "Self-test paper", url: "https://example.org/selftest",
  short_name: "Selftest_2020_SelfTestPaper", uid: c.uid, created: serverTimestamp(), name: "selftest_a", ...extra });
const added = await addDoc(submissions(a), paper(a));
check("a visitor adds a paper", (await getDoc(doc(b.db, added.path))).data()?.title === "Self-test paper");
check("adding a paper under another uid is rejected", await denied(addDoc(submissions(b), paper(a))));
check("adding a paper with a non-http URL is rejected", await denied(addDoc(submissions(b), paper(b, { url: "javascript:alert(1)" }))));
check("editing someone else's paper is rejected", await denied(updateDoc(doc(b.db, added.path), { title: "Changed" })));
check("removing someone else's paper is rejected", await denied(deleteDoc(doc(b.db, added.path))));
await deleteDoc(added);
check("the submitter removes the paper again", !(await getDoc(doc(b.db, added.path))).exists());

for (const name of ["votes", "submissions"]) {
  const rest = await fetch(`https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/months/2020-01/${name}`);
  check(`unauthenticated REST read of ${name} works (HTTP ${rest.status}), as the monthly job needs`, rest.ok);
}
process.exit();
