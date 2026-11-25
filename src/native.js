// Kada Billing backend layer.
// window.kadaBackend gives the app one data + login API:
//  - "online": Firebase (Firestore + Email/Password Auth) when www/firebase-config.js has a config.
//    Every phone and browser of a shop then sees the same data; Firestore also keeps working offline.
//  - "phone":  everything stays on this device (used when Firebase isn't configured yet).
// It also offers PDF/backup saving and reading data left by older versions on this phone.
import { jsPDF } from "jspdf";
import { Capacitor } from "@capacitor/core";
import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { initializeApp, deleteApp } from "firebase/app";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, memoryLocalCache,
  doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, onSnapshot,
} from "firebase/firestore";
import {
  initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, inMemoryPersistence,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, updateProfile, updatePassword,
  reauthenticateWithCredential, EmailAuthProvider, sendPasswordResetEmail, signOut, onAuthStateChanged,
} from "firebase/auth";

// When this page runs as a claude.ai artifact, the platform gives us window.claude.use(); keep it before we add our own.
const PLATFORM = window.claude && typeof window.claude.use === "function" ? window.claude : null;
window.jspdf = { jsPDF };
const NATIVE = Capacitor.isNativePlatform();
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (d) => JSON.parse(JSON.stringify(d)); // Firestore refuses undefined values

class AuthError extends Error { constructor(code, message) { super(message || code); this.code = code; } }

/* ======================= online (Firebase) ======================= */
function firebaseBackend(cfg) {
  const app = initializeApp(cfg);
  let fdb;
  try { fdb = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
  catch (e) { fdb = initializeFirestore(app, { localCache: memoryLocalCache() }); }
  const auth = initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });

  // Writes go to the phone's copy at once and reach the server when there is internet.
  // We wait a moment for the server so permission errors show straight away; when offline we carry on.
  const write = (p) => {
    p.catch((e) => { console.error(e); window.dispatchEvent(new CustomEvent("kada-write-failed", { detail: e && e.code })); });
    return Promise.race([p, delay(900)]);
  };
  const wrap = (s) => ({ id: s.id, exists: s.exists(), data: () => s.data(), metadata: s.metadata });
  const docRef = (path) => {
    const r = doc(fdb, path);
    return {
      id: r.id, path,
      get: async () => wrap(await getDoc(r)),
      set: (d) => write(setDoc(r, clean(d))),
      update: (d) => write(updateDoc(r, clean(d))),
      delete: () => write(deleteDoc(r)),
      onSnapshot: (next, err) => onSnapshot(r, (s) => next(wrap(s)), err),
    };
  };
  const colRef = (path) => {
    const c = collection(fdb, path);
    return {
      path,
      doc: (id) => docRef(path + "/" + (id || newId())),
      add: async (d) => { const r = docRef(path + "/" + newId()); await r.set(d); return r; },
      get: async () => { const q = await getDocs(c); return { docs: q.docs.map(wrap), size: q.size, empty: q.empty }; },
      onSnapshot: (next, err) => onSnapshot(c, (q) => next({ docs: q.docs.map(wrap), size: q.size, metadata: q.metadata }), err),
    };
  };

  const MSG = {
    "auth/invalid-credential": "Wrong username or password.",
    "auth/wrong-password": "Wrong username or password.",
    "auth/user-not-found": "Wrong username or password.",
    "auth/invalid-email": "That email address doesn't look right.",
    "auth/email-already-in-use": "That email is already used by another login.",
    "auth/weak-password": "The password needs at least 6 characters.",
    "auth/network-request-failed": "No internet. Logging in needs internet the first time.",
    "auth/too-many-requests": "Too many tries. Wait a few minutes and try again.",
    "auth/requires-recent-login": "Please log out and log in again, then try once more.",
  };
  const fail = (e) => { throw new AuthError(e && e.code, MSG[e && e.code] || "Something went wrong. Check the internet and try again."); };
  const toUser = (u) => (u ? { uid: u.uid, sid: u.displayName || "", email: u.email } : null);

  return {
    mode: "online",
    db: { doc: docRef, collection: colRef },
    auth: {
      onChange: (cb) => onAuthStateChanged(auth, (u) => cb(toUser(u))),
      current: () => toUser(auth.currentUser),
      async signIn(email, pw) { try { return toUser((await signInWithEmailAndPassword(auth, email, pw)).user); } catch (e) { fail(e); } },
      async signUp(email, pw, sid) {
        try { const c = await createUserWithEmailAndPassword(auth, email, pw); await updateProfile(c.user, { displayName: sid }); return { uid: c.user.uid, sid, email }; }
        catch (e) { fail(e); }
      },
      // Make a login for a staff member without logging the current user out.
      async createOther(email, pw, sid) {
        const app2 = initializeApp(cfg, "staff-" + newId());
        try {
          const a2 = initializeAuth(app2, { persistence: inMemoryPersistence });
          const c = await createUserWithEmailAndPassword(a2, email, pw);
          await updateProfile(c.user, { displayName: sid });
          await signOut(a2);
          return { uid: c.user.uid };
        } catch (e) { fail(e); } finally { deleteApp(app2).catch(() => {}); }
      },
      async setPassword(pw) { try { await updatePassword(auth.currentUser, pw); } catch (e) { fail(e); } },
      async changePassword(oldPw, pw) {
        try { const u = auth.currentUser; await reauthenticateWithCredential(u, EmailAuthProvider.credential(u.email, oldPw)); await updatePassword(u, pw); }
        catch (e) { if (e && (e.code === "auth/invalid-credential" || e.code === "auth/wrong-password")) throw new AuthError(e.code, "Current password is wrong."); fail(e); }
      },
      async sendReset(email) { try { await sendPasswordResetEmail(auth, email); } catch (e) { fail(e); } },
      signOut: () => signOut(auth),
    },
  };
}

/* ======================= phone only ======================= */
function makeLocalStore(KEY, fileName) {
  let store = {};
  try { store = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch (e) { store = {}; }
  const listeners = new Set();
  const FILE = fileName && { path: fileName, directory: Directory.Data, encoding: Encoding.UTF8 };
  let fileTimer = null;
  async function saveFile() {
    clearTimeout(fileTimer); fileTimer = null;
    if (!NATIVE || !FILE) return;
    try { await Filesystem.writeFile({ ...FILE, data: JSON.stringify(store) }); } catch (e) { console.error("file save failed", e); }
  }
  const notify = () => { for (const l of listeners) l(); };
  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) { console.error(e); window.dispatchEvent(new CustomEvent("kada-storage-full")); }
    if (FILE) { clearTimeout(fileTimer); fileTimer = setTimeout(saveFile, 600); }
    notify();
  }
  document.addEventListener("visibilitychange", () => { if (document.hidden && fileTimer) saveFile(); });
  const ready = (NATIVE && FILE)
    ? Filesystem.readFile(FILE).then((r) => {
        const fromFile = JSON.parse(r.data || "{}") || {};
        if (!Object.keys(store).length && Object.keys(fromFile).length) { store = fromFile; try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) {} notify(); }
      }).catch(() => {})
    : Promise.resolve();
  const parent = (p) => p.split("/").slice(0, -1).join("/");
  const last = (p) => p.split("/").pop();
  const docSnap = (path) => { const d = store[path]; return { id: last(path), exists: !!d, data: () => (d ? JSON.parse(JSON.stringify(d)) : undefined), metadata: { fromCache: false } }; };
  const colSnap = (path) => { const docs = Object.keys(store).filter((k) => parent(k) === path).sort().map(docSnap); return { docs, size: docs.length, empty: !docs.length, metadata: { fromCache: false } }; };
  const docRef = (path) => ({
    id: last(path), path,
    get: async () => { await ready; return docSnap(path); },
    set: async (data) => { store[path] = clean(data); persist(); },
    update: async (data) => { if (!store[path]) throw new Error("not-found"); store[path] = { ...store[path], ...clean(data) }; persist(); },
    delete: async () => { delete store[path]; persist(); },
    onSnapshot(next) { const f = () => next(docSnap(path)); listeners.add(f); ready.then(() => setTimeout(f, 0)); return () => listeners.delete(f); },
  });
  const colRef = (path) => ({
    path,
    doc: (id) => docRef(path + "/" + (id || newId())),
    add: async (data) => { const r = docRef(path + "/" + newId()); await r.set(data); return r; },
    get: async () => { await ready; return colSnap(path); },
    onSnapshot(next) { const f = () => next(colSnap(path)); listeners.add(f); ready.then(() => setTimeout(f, 0)); return () => listeners.delete(f); },
  });
  return { db: { doc: docRef, collection: colRef }, raw: () => store, ready };
}

async function sha(txt) {
  try { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(txt)); return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join(""); }
  catch (e) { let h = 2166136261; for (const ch of txt) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return "f" + h.toString(16); }
}
// Username/password logins checked on the device against salted hashes kept in `acc` (used when Firebase isn't in play).
function hashAuth(acc, ready) {
  const SKEY = "kada-auth-session";
  let cur = null; const cbs = new Set();
  try { const v = JSON.parse(localStorage.getItem(SKEY) || "null"); if (v && v.uid && v.email) cur = v; } catch (e) {}
  const emit = () => { for (const cb of cbs) setTimeout(() => cb(cur), 0); };
  const setCur = (u) => { cur = u; try { if (u) localStorage.setItem(SKEY, JSON.stringify(u)); else localStorage.removeItem(SKEY); } catch (e) {} emit(); };
  const key = (e) => String(e).trim().toLowerCase();
  const weak = () => new AuthError("auth/weak-password", "The password needs at least 6 characters.");
  const bad = () => new AuthError("auth/invalid-credential", "Wrong username or password.");
  const make = async (email, pw, sid) => {
    if (pw.length < 6) throw weak();
    const k = key(email); if (await acc.get(k)) throw new AuthError("auth/email-already-in-use", "That login already exists.");
    const uid = "p" + newId(); await acc.set(k, { uid, sid, hash: await sha(k + ":" + pw) }); return { uid, sid, email: k };
  };
  return {
    onChange: (cb) => { cbs.add(cb); ready.then(() => setTimeout(() => cb(cur), 0)); return () => cbs.delete(cb); },
    current: () => cur,
    async signIn(email, pw) { const k = key(email); const a = await acc.get(k); if (!a || a.hash !== (await sha(k + ":" + pw))) throw bad(); setCur({ uid: a.uid, sid: a.sid, email: k }); return cur; },
    async signUp(email, pw, sid) { const u = await make(email, pw, sid); setCur(u); return u; },
    async createOther(email, pw, sid) { const u = await make(email, pw, sid); return { uid: u.uid }; },
    async setPassword(pw) { if (pw.length < 6) throw weak(); const a = await acc.get(cur.email); await acc.set(cur.email, { ...a, hash: await sha(cur.email + ":" + pw) }); },
    async changePassword(oldPw, pw) {
      const a = await acc.get(cur.email); if (!a || a.hash !== (await sha(cur.email + ":" + oldPw))) throw new AuthError("auth/invalid-credential", "Current password is wrong.");
      if (pw.length < 6) throw weak(); await acc.set(cur.email, { ...a, hash: await sha(cur.email + ":" + pw) });
    },
    async sendReset() { throw new AuthError("unavailable", "Password reset by email isn't available here. Ask the shop owner."); },
    async signOut() { setCur(null); },
  };
}

function phoneBackend() {
  const local = makeLocalStore("kada-store-v2", "kada-store-v2.json");
  const AKEY = "kada-accounts";
  const read = () => { try { return JSON.parse(localStorage.getItem(AKEY) || "{}"); } catch (e) { return {}; } };
  const acc = { get: async (k) => read()[k] || null, set: async (k, r) => { const a = read(); a[k] = r; localStorage.setItem(AKEY, JSON.stringify(a)); } };
  return { mode: "phone", db: local.db, auth: hashAuth(acc, local.ready) };
}

// Hosted as a claude.ai page: data lives in the page's shared database, so everyone the owner shares it with sees the same shop.
async function artifactBackend(platform) {
  const [db, dl] = await Promise.all([platform.use("db").catch(() => null), platform.use("downloads").catch(() => null)]);
  const noAuth = { onChange: (cb) => { setTimeout(() => cb(null), 0); return () => {}; }, current: () => null, signOut: async () => {} };
  if (!db) return { mode: "artifact", unavailable: true, db: null, dl, auth: noAuth };
  const acc = {
    get: async (k) => { const d = await db.doc("accounts/" + k).get(); return d.exists ? d.data() : null; },
    set: (k, r) => db.doc("accounts/" + k).set(r),
  };
  return { mode: "artifact", db, dl, auth: hashAuth(acc, Promise.resolve()) };
}

/* ======================= files, sharing ======================= */
function blobToBase64(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(blob); });
}
const downloads = {
  async save({ filename, data }) {
    const blob = data instanceof Blob ? data : new Blob([data]);
    if (NATIVE) {
      const w = await Filesystem.writeFile({ path: filename, data: await blobToBase64(blob), directory: Directory.Cache });
      try { await Share.share({ title: filename, files: [w.uri], dialogTitle: "Save or send " + filename }); }
      catch (e) { if (/cancel/i.test(String(e && e.message))) throw { code: "declined" }; throw e; }
      return { status: "saved" };
    }
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return { status: "saved" };
  },
};
window.kadaFiles = { blobToBase64 };

/* ======================= data from older versions on this phone ======================= */
// Versions before the online upgrade kept everything under "kadabill-store-v1" (photos as files in img/).
const legacyStore = makeLocalStore("kadabill-store-v1", "kada-store.json");
async function legacyImageData(ref) {
  if (!ref) return "";
  if (ref.startsWith("data:")) return ref;
  if (!NATIVE) return "";
  try { return "data:image/jpeg;base64," + (await Filesystem.readFile({ path: ref, directory: Directory.Data })).data; } catch (e) { return ""; }
}
window.kadaLegacy = {
  async shops() {
    await legacyStore.ready; const st = legacyStore.raw(); const ids = new Set();
    for (const k of Object.keys(st)) { const m = k.match(/^shops\/([^/]+)\/(items|days|purchases)\//); if (m) ids.add(m[1]); }
    return [...ids].map((sid) => {
      const name = (st[`shops/${sid}`] && st[`shops/${sid}`].name) || { juice: "Juice Bar Cafe", furniture: "Sreerathnam Furniture" }[sid] || sid;
      const count = (c) => Object.keys(st).filter((k) => k.startsWith(`shops/${sid}/${c}/`)).length;
      const bills = Object.keys(st).filter((k) => k.startsWith(`shops/${sid}/days/`)).reduce((s, k) => s + ((st[k].bills || []).length), 0);
      return { sid, name, items: count("items"), bills, purchases: count("purchases") };
    }).filter((s) => s.items || s.bills || s.purchases);
  },
  async exportShop(sid) {
    await legacyStore.ready; const st = legacyStore.raw(); const out = { items: {}, days: {}, purchases: {}, images: {} };
    for (const [k, v] of Object.entries(st)) {
      const m = k.match(new RegExp(`^shops/${sid}/(items|days|purchases)/([^/]+)$`)); if (!m) continue;
      const d = JSON.parse(JSON.stringify(v));
      if (m[1] === "items" && d.img) { const data = await legacyImageData(d.img); if (data) { const id = "i" + newId(); out.images[id] = data; d.img = "fs:" + id; } else d.img = ""; }
      out[m[1]][m[2]] = d;
    }
    return out;
  },
};

/* ======================= pick backend ======================= */
const cfg = window.KADA_FIREBASE_CONFIG;
const backend = {};
if (PLATFORM) {
  backend.mode = "artifact";
  backend.ready = artifactBackend(PLATFORM).then((b) => Object.assign(backend, b));
} else {
  let b;
  try { b = cfg && cfg.apiKey && cfg.projectId ? firebaseBackend(cfg) : phoneBackend(); }
  catch (e) { console.error("Firebase start failed", e); b = phoneBackend(); b.startError = String(e && e.message); }
  Object.assign(backend, b, { dl: downloads });
  backend.ready = Promise.resolve(backend);
}
window.kadaBackend = backend;
window.claude = { use: async (name) => { await backend.ready; return name === "db" ? backend.db : name === "downloads" ? backend.dl : null; } };
