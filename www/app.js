/* Kada Billing — billing for any shop, with owner / admin / sales users. */
"use strict";

/* ---------- small helpers ---------- */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const inr = (n) => "₹" + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });
const pad = (n) => String(n).padStart(2, "0");
const dkey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const pkey = (k) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
const timeOf = (ts) => new Date(ts).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
const prettyDate = (k) => pkey(k).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const digits = (v) => String(v || "").replace(/\D/g, "").slice(-10);
let DEVICE = "d" + Math.random().toString(36).slice(2, 8);
try { const v = localStorage.getItem("kb-device"); if (v) DEVICE = v; else localStorage.setItem("kb-device", DEVICE); } catch (e) {}

const SYN_DOMAIN = "@users.example.com"; // staff logins without a real email
const PW_MIN = 6;
const THEMES = [["green", "Green"], ["brown", "Brown"], ["blue", "Blue"]];
const ROLE_LABEL = { owner: "Owner", admin: "Admin", sales: "Sales" };
const CAN = {
  owner: { delBill: 1, editItem: 1, cost: 1, purchases: 1, reports: 1, users: 1, approve: 1, shop: 1, backup: 1 },
  admin: { delBill: 1, editItem: 1, cost: 1, purchases: 1, reports: 1, users: 1 },
  sales: {},
};
const ICON = {
  bill: '<svg viewBox="0 0 24 24"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/></svg>',
  items: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><path d="M16.5 14v6M13.5 17h6"/></svg>',
  purchases: '<svg viewBox="0 0 24 24"><path d="M3 5h3l2 11h11l2-8H7"/><circle cx="9" cy="20" r="1.3"/><circle cx="18" cy="20" r="1.3"/></svg>',
  reports: '<svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2"/><path d="M3 20c.6-3.4 3-5.4 6-5.4s5.4 2 6 5.4"/><circle cx="17.5" cy="9" r="2.4"/><path d="M16 14.4c2.6 0 4.4 1.7 5 4.6"/></svg>',
};

/* ---------- state ---------- */
const S = {
  db: null, dl: null, B: null, ready: false, shopDoc: {}, members: [], images: {}, sid: null, me: null, authBusy: false, legacy: [],
  items: [], days: [], purchases: [], cart: [],
  tab: "bill", cat: "All", q: "", iq: "", pay: "Cash", disc: "", cust: "",
  period: "day", offset: 0, editing: null, confirm: null, pDate: null, marked: {}, inv: null,
  pick: {}, pickRemove: {}, iFilter: "all", pItem: "", lg: { step: "login" }, lgErr: "",
  restoreAsk: null, justReset: false, resetFor: null,
};
const shop = () => S.shopDoc || {};
const role = () => (S.me ? S.me.role : null);
const can = (k) => !!(S.me && CAN[S.me.role] && CAN[S.me.role][k]);
const shopUsers = () => S.members;
const uname = (v) => String(v || "").trim().toLowerCase();
const synthEmail = (u) => `${u}.${Math.random().toString(36).slice(2, 8)}${SYN_DOMAIN}`;
const okUser = (u) => /^[a-z0-9._-]{3,30}$/.test(u);
const pendingCount = () => shopUsers().filter((u) => u.status === "pending").length;

function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2800); }
function notice(msg, bad) { const n = $("#notice"); if (!msg) { n.hidden = true; return; } n.textContent = msg; n.className = "notice" + (bad ? " bad" : ""); n.hidden = false; }

/* ---------- data loading ---------- */
let shopUnsubs = [], purUnsub = null;

async function boot() {
  S.B = window.kadaBackend;
  await S.B.ready;
  if (S.B.unavailable) { S.ready = true; S.lgErr = ""; return render(); }
  S.dl = await claude.use("downloads");
  S.db = await claude.use("db");
  if (S.B.startError) notice("Couldn't connect to the online database. Working on this phone only for now.", true);
  try { S.legacy = await window.kadaLegacy.shops(); } catch (e) { S.legacy = []; }
  S.B.auth.onChange(onAuth);
}

async function onAuth(u) {
  if (S.authBusy) return;
  S.ready = true;
  if (!u) { if (S.me) logout(); else render(); return; }
  if (S.me && S.me.id === u.uid) return;
  await enter(u);
}

// A login account is signed in: check its place in the shop before opening it.
async function enter(u) {
  let sid = u.sid;
  if (!sid) { try { sid = localStorage.getItem("kb-sid") || ""; } catch (e) {} }
  const out = (msg) => { S.lgErr = msg; S.lg = { step: "login" }; S.authBusy = true; S.B.auth.signOut().finally(() => { S.authBusy = false; render(); }); };
  if (!sid) return out("This login isn't linked to a shop.");
  let snap;
  try { snap = await S.db.doc(`shops/${sid}/members/${u.uid}`).get(); }
  catch (e) { return out(S.B.mode === "online" ? "Couldn't reach the server. Check the internet and try again." : "Couldn't open this login."); }
  if (!snap.exists) return out("This login has been removed. Ask the shop owner.");
  const m = { id: u.uid, ...snap.data() };
  if (m.status === "pending") return out("This user is waiting for the shop owner's approval.");
  if (m.status !== "active") return out("This user is turned off. Ask the shop owner.");
  if (m.mustChange) { S.lg = { step: "setpw", sid, uid: u.uid, member: m }; S.lgErr = ""; S.justReset = true; return render(); }
  loginAs(sid, m);
}

function subscribePurchases() {
  if (purUnsub) { purUnsub(); purUnsub = null; }
  S.purchases = [];
  if (can("purchases")) purUnsub = S.db.collection(`shops/${S.sid}/purchases`).onSnapshot((snap) => { S.purchases = snap.docs.map((d) => ({ id: d.id, ...d.data() })); render(); }, () => {});
}
function openShop(sid) {
  shopUnsubs.forEach((f) => f && f()); shopUnsubs = [];
  S.items = []; S.days = []; S.purchases = []; S.members = []; S.images = {}; S.shopDoc = {};
  const sub = (path, fn, onErr) => shopUnsubs.push(S.db.collection(path).onSnapshot(fn, onErr || ((e) => console.warn(path, e))));
  shopUnsubs.push(S.db.doc(`shops/${sid}`).onSnapshot((d) => { S.shopDoc = d.exists ? d.data() : {}; render(); }, () => {}));
  sub(`shops/${sid}/members`, (snap) => {
    S.members = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const mine = S.members.find((x) => x.id === (S.me && S.me.id));
    if (S.me && (!mine || mine.status !== "active")) { logout(mine ? "Your access was turned off. Ask the shop owner." : "This login has been removed. Ask the shop owner."); return; }
    if (mine) { const roleChanged = mine.role !== S.me.role; S.me = { ...mine }; if (roleChanged) subscribePurchases(); }
    render();
  }, (e) => { if (S.me && e && e.code === "permission-denied") logout("Your access was turned off. Ask the shop owner."); });
  sub(`shops/${sid}/items`, (snap) => { S.items = snap.docs.map((d) => ({ id: d.id, ...d.data() })); render(); });
  sub(`shops/${sid}/days`, (snap) => { S.days = snap.docs.map((d) => ({ id: d.id, ...d.data() })); render(); });
  sub(`shops/${sid}/images`, (snap) => { const m = {}; for (const d of snap.docs) m[d.id] = d.data().data; S.images = m; render(); });
  subscribePurchases();
}

function resetWork() {
  Object.assign(S, { tab: "bill", cat: "All", q: "", iq: "", cart: [], disc: "", cust: "", pay: "Cash", editing: null, confirm: null, marked: {}, inv: null, iFilter: "all", pItem: "", period: "day", offset: 0, resetFor: null, restoreAsk: null });
  for (const t of Object.keys(S.pick)) clearPick(t);
  S.pickRemove = {};
}
function loginAs(sid, m, quiet) {
  resetWork();
  S.sid = sid; S.me = { ...m }; S.lg = { step: "login" }; S.lgErr = "";
  try { localStorage.setItem("kb-sid", sid); } catch (e) {}
  openShop(sid);
  S.justReset = true; render(); window.scrollTo(0, 0);
  if (!quiet) toast(`Welcome, ${m.name || m.username}`);
}
function logout(msg) {
  shopUnsubs.forEach((f) => f && f()); shopUnsubs = [];
  if (purUnsub) { purUnsub(); purUnsub = null; }
  resetWork();
  S.me = null; S.sid = null; S.items = []; S.days = []; S.purchases = []; S.members = []; S.images = {}; S.shopDoc = {};
  S.lg = { step: "login" }; S.lgErr = msg || "";
  S.authBusy = true; Promise.resolve(S.B.auth.signOut()).finally(() => { S.authBusy = false; });
  S.justReset = true; render(); window.scrollTo(0, 0);
}

/* ---------- derived ---------- */
const items = () => S.items.slice().sort((a, b) => a.name.localeCompare(b.name));
function allBills() { const out = []; for (const d of S.days) for (const b of d.bills || []) out.push({ ...b, _doc: d.id, _date: d.date }); return out; }
function todayBills() { const k = dkey(new Date()); return allBills().filter((b) => b._date === k).sort((a, b) => b.ts - a.ts); }
function cartTotals() { const sub = S.cart.reduce((s, l) => s + l.price * l.qty, 0); const disc = Math.min(Math.max(parseFloat(S.disc) || 0, 0), sub); return { sub, disc, total: sub - disc }; }
const stockOf = (i) => (i.stock === null || i.stock === undefined || i.stock === "" ? null : Number(i.stock));
const isOut = (i) => stockOf(i) !== null && stockOf(i) <= 0;
const isLow = (i) => stockOf(i) !== null && stockOf(i) > 0 && stockOf(i) <= Number(i.low || 0);
const needBuy = () => items().filter((i) => isOut(i) || isLow(i));
function stockBadge(i) {
  const n = stockOf(i); if (n === null) return "";
  if (n <= 0) return `<span class="stock out">Out of stock</span>`;
  return isLow(i) ? `<span class="stock low">Only ${n} left</span>` : `<span class="stock">${n} in stock</span>`;
}
const imgUrl = (ref) => (!ref ? "" : ref.startsWith("fs:") ? S.images[ref.slice(3)] || "" : ref.startsWith("data:") ? ref : "");
function photoTag(ref, label, cls) { const s = imgUrl(ref); return s ? `<img class="${cls}" src="${esc(s)}" alt="" loading="lazy">` : `<span class="${cls}">${esc((label || "?").trim().charAt(0).toUpperCase())}</span>`; }
const photo = (i, cls) => photoTag(i.img, i.name, cls);
const isMine = (b) => b.by === S.me.username || b.uid === S.me.id;
const findBill = (key) => { const [doc, id] = key.split("|"); const d = S.days.find((x) => x.id === doc); return { d, b: d && (d.bills || []).find((x) => x.id === id) }; };
const prefixOf = (sh) => sh.prefix || (sh.name || "B").trim().charAt(0).toUpperCase();

/* ---------- photo picking ---------- */
async function shrink(file, max = 420) {
  const url = URL.createObjectURL(file); const img = new Image();
  await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = url; });
  const sc = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight)); const c = document.createElement("canvas");
  c.width = Math.round(img.naturalWidth * sc); c.height = Math.round(img.naturalHeight * sc);
  const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
  URL.revokeObjectURL(url); return await new Promise((r) => c.toBlob(r, "image/jpeg", 0.72));
}
function clearPick(t) { if (S.pick[t]) URL.revokeObjectURL(S.pick[t].url); delete S.pick[t]; delete S.pickRemove[t]; }
function picker(target, ref, emptyText) {
  const p = S.pick[target]; const src = p ? p.url : ref && !S.pickRemove[target] ? imgUrl(ref) : "";
  return `<div class="photo-pick">${src ? `<img class="prev" src="${esc(src)}" alt="">` : `<span class="prev">${emptyText}</span>`}
    <div class="btns"><label class="btn small" for="${target}Cam">Take photo</label><label class="btn small" for="${target}Gal">Choose photo</label>${src ? `<button class="btn small" type="button" data-act="nophoto" data-p="${target}">Remove</button>` : ""}</div>
    <input id="${target}Cam" data-photo="${target}" type="file" accept="image/*" capture="environment" hidden><input id="${target}Gal" data-photo="${target}" type="file" accept="image/*" hidden></div>`;
}
const IMG = {
  async save(sid, blob) { const id = "i" + newId(); await S.db.doc(`shops/${sid}/images/${id}`).set({ data: "data:image/jpeg;base64," + (await window.kadaFiles.blobToBase64(blob)) }); return "fs:" + id; },
  remove(ref) { if (ref && ref.startsWith("fs:") && S.sid) S.db.doc(`shops/${S.sid}/images/${ref.slice(3)}`).delete().catch(() => {}); },
};
async function savePick(target, sid, oldRef) {
  if (S.pick[target]) { const ref = await IMG.save(sid, S.pick[target].blob); if (oldRef) IMG.remove(oldRef); return ref; }
  if (S.pickRemove[target]) { if (oldRef) IMG.remove(oldRef); return ""; }
  return oldRef || "";
}

/* ---------- period ---------- */
function range() {
  const now = new Date(); now.setHours(0, 0, 0, 0); let start, end, buckets = null, title;
  if (S.period === "day") {
    start = new Date(now); start.setDate(now.getDate() + S.offset); end = new Date(start); end.setDate(start.getDate() + 1);
    title = S.offset === 0 ? "Today, " + start.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : start.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  } else if (S.period === "week") {
    start = new Date(now); start.setDate(now.getDate() - ((now.getDay() + 6) % 7) + 7 * S.offset); end = new Date(start); end.setDate(start.getDate() + 7); buckets = [];
    for (let i = 0; i < 7; i++) { const d = new Date(start); d.setDate(start.getDate() + i); buckets.push({ key: dkey(d), label: d.toLocaleDateString("en-IN", { weekday: "short" }) }); }
    const e = new Date(end); e.setDate(e.getDate() - 1);
    title = `${start.toLocaleDateString("en-IN", { day: "numeric", month: "short" })} – ${e.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}`;
  } else if (S.period === "month") {
    start = new Date(now.getFullYear(), now.getMonth() + S.offset, 1); end = new Date(start.getFullYear(), start.getMonth() + 1, 1); buckets = [];
    for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) buckets.push({ key: dkey(d), label: String(d.getDate()) });
    title = start.toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  } else {
    start = new Date(now.getFullYear() + S.offset, 0, 1); end = new Date(start.getFullYear() + 1, 0, 1); buckets = [];
    for (let m = 0; m < 12; m++) { const d = new Date(start.getFullYear(), m, 1); buckets.push({ key: `${d.getFullYear()}-${pad(m + 1)}`, label: d.toLocaleDateString("en-IN", { month: "short" }) }); }
    title = String(start.getFullYear());
  }
  return { s: dkey(start), e: dkey(end), buckets, title };
}
const bucketOf = (k) => (S.period === "year" ? k.slice(0, 7) : k);
function reportData() {
  const R = range();
  const bills = allBills().filter((b) => b._date >= R.s && b._date < R.e).sort((a, b) => b.ts - a.ts);
  const purs = S.purchases.filter((p) => p.date >= R.s && p.date < R.e);
  const sales = bills.reduce((s, b) => s + b.total, 0), pur = purs.reduce((s, p) => s + p.amount, 0);
  const disc = bills.reduce((s, b) => s + (b.disc || 0), 0);
  const pays = {}; for (const b of bills) pays[b.pay] = (pays[b.pay] || 0) + b.total;
  const top = {}; for (const b of bills) for (const l of b.lines) { const t = top[l.name] || (top[l.name] = { qty: 0, amt: 0 }); t.qty += l.qty; t.amt += l.qty * l.price; }
  const byUser = {}; for (const b of bills) { const k = b.byName || b.by || "Earlier bills"; const t = byUser[k] || (byUser[k] = { n: 0, amt: 0 }); t.n++; t.amt += b.total; }
  return { R, bills, purs, sales, pur, disc, pays, top: Object.entries(top).sort((a, b) => b[1].amt - a[1].amt), byUser: Object.entries(byUser).sort((a, b) => b[1].amt - a[1].amt) };
}

/* ---------- login / register views ---------- */
function vLogin() {
  const L = S.lg, err = S.lgErr ? `<p class="err" role="alert">${esc(S.lgErr)}</p>` : "";
  const mark = `<div class="mark"><span style="background:var(--juice)"></span><span style="background:var(--wood)"></span><span style="background:var(--blue)"></span></div>`;
  const modeNote = S.B && S.B.mode === "phone" ? `<p class="muted small">Phone-only mode: data stays on this phone.</p>` : "";
  if (S.B && S.B.unavailable) return `<div class="login"><div class="login-card">${mark}<div><h1>Kada Billing</h1></div><p class="err">This page can't open its saved data here. Sign in to Claude, and ask the shop owner to share the page with you so you can use it.</p></div></div>`;
  if (L.step === "register") {
    return `<div class="login"><div class="login-card wide">${mark}<div><h1>Register your shop</h1><p class="muted" style="margin:4px 0 0">You become the owner of this shop. You can add staff later.</p></div>${err}
    <form id="regForm" class="stack">
      <h3 class="sub">Shop details</h3>
      ${picker("logo", "", "Shop logo")}
      <label class="field"><span>Shop name</span><input id="rName" type="text" required placeholder="e.g. Sreerathnam Furniture"></label>
      <label class="field"><span>Address</span><input id="rAddr" type="text" placeholder="Building, street, town"></label>
      <label class="field"><span>Shop phone</span><input id="rPhone" type="tel" inputmode="tel" required placeholder="10-digit mobile"></label>
      <label class="field"><span>GSTIN (optional)</span><input id="rGst" type="text" autocapitalize="characters" placeholder="Leave empty if you don't have one"></label>
      <label class="field"><span>App colour</span><select id="rTheme">${THEMES.map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select></label>
      <h3 class="sub">Owner login</h3>
      <label class="field"><span>Your name</span><input id="rOwner" type="text" required></label>
      <label class="field"><span>Username</span><input id="rUser" type="text" autocapitalize="none" autocomplete="username" required placeholder="small letters or numbers, no spaces"></label>
      ${S.B && S.B.mode === "online" ? `<label class="field"><span>Email (to reset your password if you forget it)</span><input id="rEmail" type="email" autocomplete="email" placeholder="you@gmail.com"></label>` : ""}
      <label class="field"><span>Password (at least ${PW_MIN} characters)</span><input id="rPass" type="password" autocomplete="new-password" required minlength="${PW_MIN}"></label>
      <label class="field"><span>Type the password again</span><input id="rPass2" type="password" autocomplete="new-password" required minlength="${PW_MIN}"></label>
      <button class="btn primary" type="submit">Create shop</button>
    </form><button class="linkbtn" data-act="lgback">Back to login</button></div></div>`;
  }
  if (L.step === "setpw") {
    const m = L.member || {};
    return `<div class="login"><div class="login-card">${mark}<div><h1>Set your password</h1><p class="muted" style="margin:4px 0 0">${esc(m.name || "")} · @${esc(m.username || "")}. Choose a password only you know.</p></div>${err}
    <form id="setpwForm" class="stack">
      <label class="field"><span>New password (at least ${PW_MIN} characters)</span><input id="sPass" type="password" autocomplete="new-password" required minlength="${PW_MIN}"></label>
      <label class="field"><span>Type the password again</span><input id="sPass2" type="password" autocomplete="new-password" required minlength="${PW_MIN}"></label>
      <button class="btn primary" type="submit">Save and continue</button>
    </form><button class="linkbtn" data-act="lgcancel">Cancel</button></div></div>`;
  }
  if (L.step === "forgot") {
    return `<div class="login"><div class="login-card">${mark}<div><h1>Forgot password</h1><p class="muted" style="margin:4px 0 0">Owners who saved an email get a reset link by email. Staff: ask your shop owner to reset your password.</p></div>${err}
    ${L.sent ? `<p class="okmsg">${esc(L.sent)}</p>` : `<form id="forgotForm" class="stack">
      <label class="field"><span>Username</span><input id="fUser" type="text" autocapitalize="none" required></label>
      <button class="btn primary" type="submit">Send reset link</button>
    </form>`}<button class="linkbtn" data-act="lgback">Back to login</button></div></div>`;
  }
  return `<div class="login"><div class="login-card">${mark}<div><h1>Kada Billing</h1><p class="muted" style="margin:4px 0 0">Log in with your username and password.</p></div>${err}
    <form id="loginForm" class="stack">
      <label class="field"><span>Username</span><input id="lUser" type="text" autocapitalize="none" autocomplete="username" required></label>
      <label class="field"><span>Password</span><input id="lPass" type="password" autocomplete="current-password" required></label>
      <button class="btn primary" type="submit">Login</button>
    </form>
    <div class="row" style="justify-content:space-between"><button class="linkbtn" data-act="lgforgot">Forgot password?</button><button class="linkbtn" data-act="lgregister">Register a new shop</button></div>${modeNote}</div></div>`;
}

/* ---------- app views ---------- */
function lowAlert() {
  const n = needBuy().length; if (!n) return "";
  return `<div class="alert"><span>${n} item${n > 1 ? "s" : ""} running low or out of stock</span>${can("purchases") ? `<button class="btn small" data-act="tolow">See and buy</button>` : ""}</div>`;
}
function pendingAlert() {
  const n = can("approve") ? pendingCount() : 0; if (!n) return "";
  return `<div class="alert info"><span>${n} new user${n > 1 ? "s" : ""} waiting for your approval</span><button class="btn small" data-act="tab" data-t="more">Review</button></div>`;
}

function vBill() {
  const its = items(), cats = ["All", ...new Set(its.map((i) => i.cat || "Other"))];
  const q = S.q.trim().toLowerCase();
  const shown = its.filter((i) => (S.cat === "All" || (i.cat || "Other") === S.cat) && (!q || i.name.toLowerCase().includes(q)));
  const inCart = Object.fromEntries(S.cart.map((l) => [l.id, l.qty]));
  const t = cartTotals(), tb = todayBills(), mine = role() === "sales" ? tb.filter(isMine) : tb;
  const sum = mine.reduce((s, b) => s + b.total, 0);
  return `${pendingAlert()}${lowAlert()}<div class="bill-grid">
  <section class="card"><div class="spread"><h2>Tap items to add</h2><span class="muted">${its.length} items</span></div>
  ${its.length ? `<input id="q" type="search" placeholder="Search items" value="${esc(S.q)}" aria-label="Search items">
    <div class="chips">${cats.map((c) => `<button class="chip" data-act="cat" data-c="${esc(c)}" aria-pressed="${S.cat === c}">${esc(c)}</button>`).join("")}</div>
    <div class="tiles">${shown.map((i) => `<button class="tile${isOut(i) ? " out" : ""}" data-act="add" data-id="${esc(i.id)}">${photo(i, "ph")}<b>${esc(i.name)}</b><span class="num">${inr(i.price)}</span>${stockBadge(i)}${inCart[i.id] ? `<span class="qty">${inCart[i.id]}</span>` : ""}</button>`).join("") || `<p class="muted">No items match.</p>`}</div>`
    : `<div class="empty"><b>No items yet</b><span>${can("editItem") ? "Add what you sell with its price, then come back here to make bills." : "Ask the shop owner or admin to add items."}</span>${can("editItem") ? `<button class="btn primary" data-act="tab" data-t="items">Add items</button>` : ""}</div>`}
  </section>
  <section class="card cart-card"><div class="spread"><h2>Current bill</h2>${S.cart.length ? `<button class="btn small" data-act="clear">Clear</button>` : ""}</div>
   ${S.cart.length ? `<div>${S.cart.map((l) => `<div class="cart-line"><div class="name">${esc(l.name)}<small class="num">${inr(l.price)} each</small></div>
     <div class="qtybox"><button class="icon-btn" data-act="dec" data-id="${esc(l.id)}" aria-label="Less">−</button><span class="num">${l.qty}</span><button class="icon-btn" data-act="inc" data-id="${esc(l.id)}" aria-label="More">+</button></div>
     <span class="num">${inr(l.price * l.qty)}</span></div>`).join("")}</div>
     <div class="row"><label class="field"><span>Customer (optional)</span><input id="cust" type="text" value="${esc(S.cust)}" placeholder="Name or phone"></label>
     <label class="field" style="flex:0 1 120px"><span>Discount ₹</span><input id="disc" type="number" min="0" inputmode="decimal" value="${esc(S.disc)}" placeholder="0"></label></div>
     <div class="seg" role="group" aria-label="Payment">${["Cash", "UPI", "Card", "Credit"].map((p) => `<button data-act="pay" data-p="${p}" aria-pressed="${S.pay === p}">${p}</button>`).join("")}</div>
     ${t.disc ? `<div class="spread muted"><span>Subtotal ${inr(t.sub)}</span><span>Discount −${inr(t.disc)}</span></div>` : ""}
     <div class="total-row"><span class="label">Total</span><span class="num" id="totalNum">${inr(t.total)}</span></div>
     <button class="btn primary" data-act="save">Save bill</button>`
    : `<p class="muted">Bill is empty. Tap an item to start.</p>`}
  </section></div>
  <section class="card"><div class="spread"><h2>${role() === "sales" ? "My bills today" : "Today's bills"}</h2><span class="num">${mine.length} bills · ${inr(sum)}</span></div>
  ${mine.length ? `<div class="list">${mine.map(billRow).join("")}</div>` : `<p class="muted">Bills saved today will be listed here.</p>`}</section>`;
}
function billRow(b) {
  const key = b._doc + "|" + b.id, conf = S.confirm === key;
  return `<div class="li"><div class="main"><b>${esc(b.no)}</b> <span class="pill">${esc(b.pay)}</span>${b.cust ? ` <span class="muted">· ${esc(b.cust)}</span>` : ""}
   <small>${prettyDate(b._date)} ${timeOf(b.ts)}${b.byName ? " · by " + esc(b.byName) : ""} · ${b.lines.map((l) => `${esc(l.name)} ×${l.qty}`).join(", ")}</small></div>
   <div class="row"><span class="num">${inr(b.total)}</span><button class="btn small" data-act="view" data-k="${esc(key)}">View</button>
   ${can("delBill") ? (conf ? `<span class="confirm">Delete bill? <button class="btn small danger" data-act="delbill" data-k="${esc(key)}">Delete</button><button class="btn small" data-act="noconf">Keep</button></span>` : `<button class="btn small" data-act="conf" data-k="${esc(key)}">Delete</button>`) : ""}</div></div>`;
}

function vItems() {
  const its = items(), ed = S.editing ? its.find((i) => i.id === S.editing) : null;
  const cats = [...new Set([...its.map((i) => i.cat).filter(Boolean), "Other"])];
  const low = needBuy();
  const list = (S.iFilter === "low" ? low : its).filter((i) => !S.iq || i.name.toLowerCase().includes(S.iq.toLowerCase()));
  const form = can("editItem") ? `<section class="card"><h2>${ed ? "Edit item" : "Add an item"}</h2>
  <form id="itemForm" class="row" style="align-items:flex-end">
   ${picker("item", ed && ed.img, "No photo")}
   <label class="field" style="flex:2 1 200px"><span>Item name</span><input id="iName" type="text" required value="${esc(ed ? ed.name : "")}"></label>
   <label class="field"><span>Selling price ₹</span><input id="iPrice" type="number" min="0" step="0.01" inputmode="decimal" required value="${ed ? esc(ed.price) : ""}"></label>
   <label class="field"><span>Category</span><input id="iCat" type="text" list="catList" value="${esc(ed ? ed.cat || "" : "")}" placeholder="e.g. Juice, Sofa"><datalist id="catList">${cats.map((c) => `<option value="${esc(c)}">`).join("")}</datalist></label>
   <label class="field"><span>Stock now (optional)</span><input id="iStock" type="number" step="any" inputmode="decimal" value="${ed && stockOf(ed) !== null ? esc(ed.stock) : ""}" placeholder="Leave empty to not count"></label>
   <label class="field"><span>Warn me when stock is at</span><input id="iLow" type="number" min="0" step="any" inputmode="decimal" value="${ed ? esc(ed.low ?? "") : ""}" placeholder="e.g. 5"></label>
   <label class="field"><span>Buying price ₹ (optional)</span><input id="iCost" type="number" min="0" step="0.01" inputmode="decimal" value="${ed ? esc(ed.cost ?? "") : ""}"></label>
   <div class="row"><button class="btn primary" type="submit">${ed ? "Save changes" : "Add item"}</button>${ed ? `<button class="btn" type="button" data-act="canceledit">Cancel</button>` : ""}</div>
  </form></section>` : "";
  return `${form}${lowAlert()}
  <section class="card"><div class="spread"><h2>${can("editItem") ? "My items" : "Item list"}</h2><span class="muted">${its.length} items</span></div>
  ${its.length ? `<p class="muted" style="margin:0">Tick the items the customer is buying, then tap <b>Make bill</b>.</p>
   <input id="iq" type="search" placeholder="Search items" value="${esc(S.iq)}" aria-label="Search items">
   <div class="chips"><button class="chip" data-act="ifilter" data-f="all" aria-pressed="${S.iFilter !== "low"}">All items</button><button class="chip" data-act="ifilter" data-f="low" aria-pressed="${S.iFilter === "low"}">Running low (${low.length})</button></div>
   <div class="icards">${list.map((i) => { const conf = S.confirm === "item|" + i.id, on = !!S.marked[i.id]; return `<div class="icard${on ? " on" : ""}">
   <label><input type="checkbox" id="mk-${esc(i.id)}" data-act="mark" data-id="${esc(i.id)}" ${on ? "checked" : ""}>${photo(i, "thumb")}<span class="main"><b>${esc(i.name)}</b><small>${esc(i.cat || "Other")}${can("cost") && i.cost != null && i.cost !== "" ? ` · buy ${inr(i.cost)}` : ""}</small> ${stockBadge(i)}</span><span class="price">${inr(i.price)}</span></label>
   ${can("editItem") ? `<div class="acts">${conf ? `<span class="confirm">Remove? <button class="btn small danger" data-act="delitem" data-id="${esc(i.id)}">Remove</button><button class="btn small" data-act="noconf">Keep</button></span>`
    : `<button class="btn small" data-act="buy" data-id="${esc(i.id)}">Buy stock</button><button class="btn small" data-act="edit" data-id="${esc(i.id)}">Edit</button><button class="btn small" data-act="conf" data-k="item|${esc(i.id)}">Remove</button>`}</div>` : ""}</div>`; }).join("") || `<p class="muted">Nothing here.</p>`}</div>`
    : `<p class="muted">No items yet.${can("editItem") ? " Items you add here show up as buttons on the Billing screen." : ""}</p>`}</section>`;
}

function vMarkbar() {
  const ids = Object.keys(S.marked).filter((id) => S.items.some((i) => i.id === id));
  if (S.tab !== "items" || !ids.length) return "";
  const sum = ids.reduce((s, id) => s + Number(S.items.find((i) => i.id === id).price), 0);
  return `<div class="markbar"><div class="in"><span><b>${ids.length} marked</b> · <span class="num">${inr(sum)}</span></span>
   <span class="row"><button class="btn small" data-act="clearmarks">Clear</button><button class="btn small primary" data-act="makebill">Make bill</button></span></div></div>`;
}

function vInvoice() {
  if (!S.inv) return ""; const { b } = findBill(S.inv); if (!b) return "";
  const sh = shop(), logo = imgUrl(sh.logo);
  return `<div class="sheet-bg" data-act="closeinv"><div class="sheet" role="dialog" aria-modal="true" aria-label="Bill ${esc(b.no)}">
   <div class="invoice">
    <div class="head">${logo ? `<img class="inv-logo" src="${esc(logo)}" alt="">` : ""}<h3>${esc(sh.name)}</h3>${sh.addr ? `<small>${esc(sh.addr)}</small>` : ""}${sh.phone ? `<small>Ph: ${esc(sh.phone)}</small>` : ""}${sh.gst ? `<small>GSTIN: ${esc(sh.gst)}</small>` : ""}</div>
    <div class="meta"><span>Bill no: <b>${esc(b.no)}</b></span><span>${new Date(b.ts).toLocaleDateString("en-IN")} ${timeOf(b.ts)}</span>
     <span>${b.cust ? "Customer: " + esc(b.cust) : ""}</span><span>Paid by ${esc(b.pay)}</span></div>
    <table><thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead>
    <tbody>${b.lines.map((l) => `<tr><td>${esc(l.name)}</td><td class="r num">${l.qty}</td><td class="r num">${inr(l.price)}</td><td class="r num">${inr(l.qty * l.price)}</td></tr>`).join("")}</tbody></table>
    ${b.disc ? `<div class="spread muted"><span>Subtotal</span><span class="num">${inr(b.sub)}</span></div><div class="spread muted"><span>Discount</span><span class="num">−${inr(b.disc)}</span></div>` : ""}
    <div class="tot"><span class="label">Total</span><span class="num">${inr(b.total)}</span></div>
    <div class="thanks">${b.byName ? `Billed by ${esc(b.byName)} · ` : ""}Thank you. Visit again!</div>
   </div>
   <div class="row">${S.dl ? `<button class="btn primary" data-act="pdf" style="flex:1">Download PDF</button>` : ""}<button class="btn" data-act="copy" data-k="${esc(S.inv)}">Copy</button><button class="btn" data-act="closeinv" id="closeInvBtn">Close</button></div>
  </div></div>`;
}

function vPurchases() {
  const r = new Date(), mk = dkey(r).slice(0, 7);
  const list = S.purchases.slice().sort((a, b) => b.date.localeCompare(a.date) || b.ts - a.ts);
  const mSum = list.filter((p) => p.date.slice(0, 7) === mk).reduce((s, p) => s + p.amount, 0);
  const its = items(), low = needBuy(), it = its.find((i) => i.id === S.pItem);
  return `${low.length ? `<section class="card"><div class="spread"><h2>Need to buy</h2><span class="muted">${low.length} items</span></div>
   <div class="list">${low.map((i) => `<div class="li"><div class="row" style="flex:1 1 180px;min-width:0;flex-wrap:nowrap">${photo(i, "thumb")}<div class="main"><b>${esc(i.name)}</b><small>${i.low ? `Warn at ${esc(i.low)}` : ""}</small> ${stockBadge(i)}</div></div>
   <button class="btn small primary" data-act="buy" data-id="${esc(i.id)}">Buy</button></div>`).join("")}</div></section>` : ""}
  <section class="card" id="purCard"><h2>Record a purchase</h2><p class="muted" style="margin:0">Pick an item to add to its stock, or choose <b>Other expense</b> for rent, transport and the like.</p>
  <form id="purForm" class="row" style="align-items:flex-end">
   <label class="field" style="flex:2 1 220px"><span>Item</span><select id="pItem"><option value="">Other expense (not an item)</option>${its.map((i) => `<option value="${esc(i.id)}" ${i.id === S.pItem ? "selected" : ""}>${esc(i.name)}${stockOf(i) !== null ? ` (stock ${stockOf(i)})` : ""}</option>`).join("")}</select></label>
   ${it ? `<label class="field"><span>Quantity bought</span><input id="pQty" type="number" min="0" step="any" inputmode="decimal" required></label>
   <label class="field"><span>Buying price per piece ₹</span><input id="pCost" type="number" min="0" step="0.01" inputmode="decimal" required value="${esc(it.cost ?? "")}"></label>`
    : `<label class="field" style="flex:2 1 200px"><span>What was bought</span><input id="pDesc" type="text" required placeholder="e.g. Fruits 10 kg, transport"></label>
   <label class="field"><span>Amount ₹</span><input id="pAmt" type="number" min="0" step="0.01" inputmode="decimal" required></label>`}
   <label class="field"><span>Date</span><input id="pDate" type="date" required value="${S.pDate || dkey(r)}"></label>
   <label class="field"><span>Supplier</span><input id="pSup" type="text" placeholder="Optional"></label>
   ${it ? `<span class="calc" id="pTot" style="flex:1 1 100%">Total: ${inr(0)}</span>` : ""}
   <button class="btn primary" type="submit">Save purchase</button>
  </form></section>
  <section class="card"><div class="spread"><h2>Purchases</h2><span class="num">This month ${inr(mSum)}</span></div>
  ${list.length ? `<div class="list">${list.slice(0, 60).map((p) => { const conf = S.confirm === "pur|" + p.id; return `<div class="li"><div class="main"><b>${esc(p.desc)}</b>${p.qty ? ` <span class="pill">+${esc(p.qty)} stock</span>` : ""}<small>${prettyDate(p.date)}${p.sup ? " · " + esc(p.sup) : ""}${p.byName ? " · by " + esc(p.byName) : ""}</small></div>
   <div class="row"><span class="num">${inr(p.amount)}</span>${conf ? `<span class="confirm">Delete?${p.qty ? " Stock goes back down." : ""} <button class="btn small danger" data-act="delpur" data-id="${esc(p.id)}">Delete</button><button class="btn small" data-act="noconf">Keep</button></span>` : `<button class="btn small" data-act="conf" data-k="pur|${esc(p.id)}">Delete</button>`}</div></div>`; }).join("")}</div>
   ${list.length > 60 ? `<p class="muted">Showing the latest 60. Reports include all of them.</p>` : ""}`
    : `<p class="muted">No purchases recorded yet.</p>`}</section>`;
}
function pTotal() { const q = parseFloat(($("#pQty") || {}).value) || 0, c = parseFloat(($("#pCost") || {}).value) || 0, t = $("#pTot"); if (t) t.textContent = "Total: " + inr(q * c); }

function vReports() {
  const full = can("reports"), D = reportData(), R = D.R;
  const bills = full ? D.bills : D.bills.filter(isMine);
  const sales = bills.reduce((s, b) => s + b.total, 0);
  const diff = D.sales - D.pur;
  const pays = {}; for (const b of bills) pays[b.pay] = (pays[b.pay] || 0) + b.total;
  const bs = {}, bp = {};
  if (R.buckets) { for (const b of bills) { const k = bucketOf(b._date); bs[k] = (bs[k] || 0) + b.total; } if (full) for (const p of D.purs) { const k = bucketOf(p.date); bp[k] = (bp[k] || 0) + p.amount; } }
  const top = full ? D.top : (() => { const t = {}; for (const b of bills) for (const l of b.lines) { const x = t[l.name] || (t[l.name] = { qty: 0, amt: 0 }); x.qty += l.qty; x.amt += l.qty * l.price; } return Object.entries(t).sort((a, b) => b[1].amt - a[1].amt); })();
  return `<section class="card">
   <div class="seg" role="group" aria-label="Period">${[["day", "Daily"], ["week", "Weekly"], ["month", "Monthly"], ["year", "Yearly"]].map(([k, l]) => `<button data-act="period" data-p="${k}" aria-pressed="${S.period === k}">${l}</button>`).join("")}</div>
   <div class="spread"><button class="icon-btn" data-act="prev" aria-label="Previous">‹</button><h2 style="text-align:center;flex:1">${R.title}</h2><button class="icon-btn" data-act="next" aria-label="Next" ${S.offset >= 0 ? "disabled" : ""}>›</button></div>
   <div class="stats">
    <div class="stat"><span class="label">${full ? "Sales" : "My sales"}</span><span class="num">${inr(sales)}</span></div>
    <div class="stat"><span class="label">Bills</span><span class="num">${bills.length}</span></div>
    ${full ? `<div class="stat"><span class="label">Purchases</span><span class="num">${inr(D.pur)}</span></div>
    <div class="stat ${diff >= 0 ? "pos" : "neg"}"><span class="label">Sales − Purchases</span><span class="num">${diff < 0 ? "−" : ""}${inr(Math.abs(diff))}</span></div>`
    : `<div class="stat"><span class="label">Cash</span><span class="num">${inr(pays.Cash || 0)}</span></div><div class="stat"><span class="label">UPI</span><span class="num">${inr(pays.UPI || 0)}</span></div>`}
   </div>
   ${R.buckets ? `<div class="legend"><span><i style="background:var(--accent)"></i>Sales</span>${full ? `<span><i style="background:var(--muted);opacity:.55"></i>Purchases</span>` : ""}</div><div class="chart-box">${chart(R.buckets, bs, bp)}</div>` : ""}
   ${S.dl ? `<button class="btn" data-act="reportpdf">Download ${S.period === "day" ? "daily" : S.period === "week" ? "weekly" : S.period === "month" ? "monthly" : "yearly"} report (PDF)</button>` : ""}
  </section>
  <div class="bill-grid">
  <section class="card"><h2>Items sold</h2>${top.length ? `<div class="list">${top.slice(0, 15).map(([n, v]) => `<div class="li"><div class="main"><b>${esc(n)}</b><small>${v.qty} sold</small></div><span class="num">${inr(v.amt)}</span></div>`).join("")}</div>` : `<p class="muted">No sales in this period.</p>`}</section>
  <section class="card"><h2>Payment modes</h2>${Object.keys(pays).length ? `<div class="list">${Object.entries(pays).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<div class="li"><div class="main"><b>${esc(k)}</b></div><span class="num">${inr(v)}</span></div>`).join("")}</div>` : `<p class="muted">No sales in this period.</p>`}
   ${full && D.byUser.length ? `<h3 class="sub" style="margin-top:6px">Sales by staff</h3><div class="list">${D.byUser.map(([k, v]) => `<div class="li"><div class="main"><b>${esc(k)}</b><small>${v.n} bills</small></div><span class="num">${inr(v.amt)}</span></div>`).join("")}</div>` : ""}
  </section></div>
  <section class="card"><h2>Bills</h2>${bills.length ? `<div class="list">${bills.slice(0, 60).map(billRow).join("")}</div>${bills.length > 60 ? `<p class="muted">Showing the latest 60 of ${bills.length}. The PDF report has all of them.</p>` : ""}` : `<p class="muted">No bills in this period.</p>`}</section>`;
}
function chart(buckets, bs, bp) {
  const W = Math.max(560, buckets.length * 24), H = 210, L = 52, B = 24, T = 10, cw = (W - L - 8) / buckets.length;
  let max = 0; for (const b of buckets) max = Math.max(max, bs[b.key] || 0, bp[b.key] || 0);
  if (!max) max = 1000; const mag = Math.pow(10, Math.floor(Math.log10(max))); const step = [1, 2, 2.5, 5, 10].map((x) => x * mag).find((s) => max / s <= 4) || mag * 10; const top = Math.ceil(max / step) * step;
  const y = (v) => T + (H - T - B) * (1 - v / top);
  let g = ""; for (let v = 0; v <= top + 1e-9; v += step) g += `<line class="grid" x1="${L}" x2="${W - 4}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v >= 1e5 ? (v / 1e5).toFixed(v % 1e5 ? 1 : 0) + "L" : v >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + "k" : v}</text>`;
  const bw = Math.min(14, cw * 0.36);
  buckets.forEach((b, i) => {
    const x = L + i * cw + cw / 2; const s = bs[b.key] || 0, p = bp[b.key] || 0;
    if (s) g += `<rect class="bar-s" x="${x - bw - 1}" y="${y(s)}" width="${bw}" height="${y(0) - y(s)}" rx="2"><title>Sales ${inr(s)}</title></rect>`;
    if (p) g += `<rect class="bar-p" x="${x + 1}" y="${y(p)}" width="${bw}" height="${y(0) - y(p)}" rx="2"><title>Purchases ${inr(p)}</title></rect>`;
    const show = buckets.length <= 12 || i === 0 || (i + 1) % 5 === 0; if (show) g += `<text class="axis" x="${x}" y="${H - 6}" text-anchor="middle">${esc(b.label)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="min-width:${Math.min(W, 560)}px" role="img" aria-label="Sales and purchases chart">${g}</svg>`;
}

function vMore() {
  const sh = shop(), me = S.me;
  const order = { pending: 0, active: 1, disabled: 2, rejected: 3 }, rank = { owner: 0, admin: 1, sales: 2 };
  const list = shopUsers().slice().sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || (rank[a.role] ?? 9) - (rank[b.role] ?? 9) || (a.name || "").localeCompare(b.name || ""));
  const statusPill = (u) => u.status === "pending" ? `<span class="stock low">Waiting for approval</span>` : u.status === "active" ? "" : `<span class="stock out">${u.status === "rejected" ? "Rejected" : "Turned off"}</span>`;
  const userRow = (u) => {
    const self = u.id === me.id, conf = S.confirm === "user|" + u.id;
    let acts = "";
    if (can("approve") && !self && u.role !== "owner") {
      if (u.status === "pending") acts = `<button class="btn small primary" data-act="approve" data-id="${esc(u.id)}">Approve</button><button class="btn small" data-act="reject" data-id="${esc(u.id)}">Reject</button>`;
      else if (u.status === "active") acts = conf ? `<span class="confirm">Turn off ${esc(u.name || u.username)}? <button class="btn small danger" data-act="disable" data-id="${esc(u.id)}">Turn off</button><button class="btn small" data-act="noconf">Keep</button></span>`
        : `<button class="btn small" data-act="setrole" data-id="${esc(u.id)}" data-r="${u.role === "admin" ? "sales" : "admin"}">Make ${u.role === "admin" ? "Sales" : "Admin"}</button><button class="btn small" data-act="resetpw" data-id="${esc(u.id)}">Reset password</button><button class="btn small" data-act="conf" data-k="user|${esc(u.id)}">Turn off</button>`;
      else acts = conf ? `<span class="confirm">Delete for good? <button class="btn small danger" data-act="deluser" data-id="${esc(u.id)}">Delete</button><button class="btn small" data-act="noconf">Keep</button></span>`
        : `<button class="btn small" data-act="enable" data-id="${esc(u.id)}">Turn on</button><button class="btn small" data-act="conf" data-k="user|${esc(u.id)}">Delete</button>`;
    }
    const reset = S.resetFor === u.id ? `<form id="resetForm" class="row" style="align-items:flex-end;flex:1 1 100%"><label class="field"><span>New password for ${esc(u.username)}</span><input id="rpNew" type="text" required minlength="6"></label><button class="btn small primary" type="submit">Save</button><button class="btn small" type="button" data-act="noreset">Cancel</button></form>` : "";
    return `<div class="li"><div class="main"><b>${esc(u.name || u.username)}</b>${self ? ` <span class="muted">(you)</span>` : ""} <span class="pill role-${u.role}">${ROLE_LABEL[u.role] || u.role}</span> ${statusPill(u)}
      <small>@${esc(u.username)}${u.addedBy ? " · added by " + esc(u.addedBy) : ""}</small></div><div class="row">${acts}</div>${reset}</div>`;
  };
  return `${pendingAlert()}<section class="card"><div class="spread"><h2>My account</h2><span class="pill role-${me.role}">${ROLE_LABEL[me.role]}</span></div>
   <p class="muted" style="margin:0"><b>${esc(me.name || "")}</b> · @${esc(me.username)} · ${esc(sh.name)}</p>
   <p class="muted small" style="margin:0">${S.B.mode === "phone" ? "Phone-only mode: data stays on this phone." : "Online: every phone of this shop sees the same data."}</p>
   <form id="cpForm" class="row" style="align-items:flex-end">
    <label class="field"><span>Current password</span><input id="cpOld" type="password" autocomplete="current-password" required></label>
    <label class="field"><span>New password</span><input id="cpNew" type="password" autocomplete="new-password" required minlength="6"></label>
    <label class="field"><span>New password again</span><input id="cpNew2" type="password" autocomplete="new-password" required minlength="6"></label>
    <button class="btn" type="submit">Change password</button>
   </form>
   <button class="btn danger" data-act="logout" style="align-self:flex-start">Logout</button>
  </section>
  ${can("shop") ? `<section class="card"><h2>Shop details</h2><p class="muted" style="margin:0">These show on every bill and PDF.</p>
   <form id="shopForm" class="row" style="align-items:flex-end">
    ${picker("logo", sh.logo, "Shop logo")}
    <label class="field" style="flex:2 1 220px"><span>Shop name</span><input id="shName" type="text" required value="${esc(sh.name)}"></label>
    <label class="field" style="flex:2 1 220px"><span>Address</span><input id="shAddr" type="text" value="${esc(sh.addr || "")}"></label>
    <label class="field"><span>Phone</span><input id="shPhone" type="tel" inputmode="tel" value="${esc(sh.phone || "")}"></label>
    <label class="field"><span>GSTIN (optional)</span><input id="shGst" type="text" value="${esc(sh.gst || "")}"></label>
    <label class="field"><span>Bill number letter</span><input id="shPrefix" type="text" maxlength="4" value="${esc(prefixOf(sh))}"></label>
    <label class="field"><span>App colour</span><select id="shTheme">${THEMES.map(([k, l]) => `<option value="${k}" ${(sh.theme || "green") === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
    <button class="btn primary" type="submit">Save shop details</button>
   </form></section>` : ""}
  ${can("users") ? `<section class="card"><div class="spread"><h2>Users</h2><span class="muted">${list.length}</span></div>
   <div class="list">${list.map(userRow).join("")}</div>
   <h3 class="sub">Add a user</h3>
   <p class="muted" style="margin:0">${can("approve") ? "<b>Sales</b> can make bills and see items and their own sales. <b>Admin</b> can also add and edit items, record purchases, see reports and add users." : "New users can log in after the owner approves them."}</p>
   <form id="userForm" class="row" style="align-items:flex-end">
    <label class="field"><span>Name</span><input id="uName" type="text" required></label>
    <label class="field"><span>Username</span><input id="uUser" type="text" autocapitalize="none" required placeholder="small letters or numbers"></label>
    <label class="field"><span>Password</span><input id="uPass" type="text" required minlength="6" placeholder="At least 6 characters"></label>
    <label class="field"><span>Role</span><select id="uRole"><option value="sales">Sales</option><option value="admin">Admin</option></select></label>
    <button class="btn primary" type="submit">${can("approve") ? "Add user" : "Send for approval"}</button>
   </form></section>` : ""}
  ${can("backup") && S.legacy.length ? `<section class="card"><h2>Data from the old version</h2><p class="muted" style="margin:0">This phone still has shops from before the online upgrade. Copy one into <b>${esc(sh.name)}</b> to keep its items, bills and purchases.</p>
   <div class="list">${S.legacy.map((l) => { const done = (() => { try { return localStorage.getItem("kb-imported-" + l.sid) === S.sid; } catch (e) { return false; } })(); const conf = S.confirm === "imp|" + l.sid;
     return `<div class="li"><div class="main"><b>${esc(l.name)}</b><small>${l.items} items · ${l.bills} bills · ${l.purchases} purchases</small></div><div class="row">${done ? `<span class="pill">Copied</span>`
      : conf ? `<span class="confirm">Copy into ${esc(sh.name)}? <button class="btn small primary" data-act="importold" data-id="${esc(l.sid)}">Copy</button><button class="btn small" data-act="noconf">Cancel</button></span>` : `<button class="btn small" data-act="conf" data-k="imp|${esc(l.sid)}">Copy into this shop</button>`}</div></div>`; }).join("")}</div></section>` : ""}
  ${can("backup") ? `<section class="card"><h2>Backup</h2><p class="muted" style="margin:0">${S.B.mode !== "phone" ? "Your data is kept online. For an extra copy, tap <b>Save backup</b> and keep the file in Drive or Gmail." : "Data is saved on this phone. Tap <b>Save backup</b> now and then and keep the file in Drive or Gmail."} Restoring adds the backup's items, bills, purchases and photos back into this shop.</p>
   <div class="row"><button class="btn primary" data-act="backup">Save backup</button><label class="btn" for="restoreFile" style="cursor:pointer">Restore from backup</label><input id="restoreFile" type="file" accept=".json,application/json" hidden></div>
   ${S.restoreAsk ? `<div class="notice bad">Restore this backup into ${esc(sh.name)}? Entries with the same id are replaced. <span class="row" style="margin-top:8px"><button class="btn small danger" data-act="restoreyes">Restore</button><button class="btn small" data-act="restoreno">Cancel</button></span></div>` : ""}
  </section>` : ""}`;
}

/* ---------- PDFs ---------- */
async function dataUrlOf(src) {
  if (!src) return null;
  try { const r = await fetch(src); const b = await r.blob(); return await new Promise((ok) => { const f = new FileReader(); f.onload = () => ok(f.result); f.onerror = () => ok(null); f.readAsDataURL(b); }); } catch (e) { return null; }
}
const rs = (n) => "Rs. " + Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
async function pdfHeader(doc, W, title) {
  const sh = shop(); let y = 14;
  const logo = await dataUrlOf(imgUrl(sh.logo));
  if (logo) { try { doc.addImage(logo, "JPEG", W / 2 - 9, y - 4, 18, 18); y += 18; } catch (e) {} }
  doc.setFont("helvetica", "bold"); doc.setFontSize(16); doc.text(sh.name || "", W / 2, y, { align: "center" });
  doc.setFont("helvetica", "normal"); doc.setFontSize(9);
  for (const t of [sh.addr, sh.phone && "Ph: " + sh.phone, sh.gst && "GSTIN: " + sh.gst].filter(Boolean)) { y += 5; doc.text(String(t), W / 2, y, { align: "center" }); }
  if (title) { y += 7; doc.setFont("helvetica", "bold"); doc.setFontSize(12); doc.text(title, W / 2, y, { align: "center" }); doc.setFont("helvetica", "normal"); }
  return y;
}
async function makePdf(b) {
  const { jsPDF } = window.jspdf; const doc = new jsPDF({ unit: "mm", format: "a5" }); const W = 148, M = 12;
  let y = await pdfHeader(doc, W);
  y += 5; doc.setLineDashPattern([1, 1], 0); doc.line(M, y, W - M, y); doc.setLineDashPattern([], 0);
  y += 6; doc.setFontSize(10); doc.text("Bill no: " + b.no, M, y); doc.text(new Date(b.ts).toLocaleString("en-IN"), W - M, y, { align: "right" });
  y += 5; if (b.cust) doc.text("Customer: " + b.cust, M, y); doc.text("Paid by " + b.pay, W - M, y, { align: "right" });
  y += 8; doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.text("ITEM", M, y); doc.text("QTY", 84, y, { align: "right" }); doc.text("RATE", 108, y, { align: "right" }); doc.text("AMOUNT", W - M, y, { align: "right" });
  y += 2; doc.line(M, y, W - M, y); doc.setFont("helvetica", "normal"); doc.setFontSize(10);
  for (const l of b.lines) {
    const nm = doc.splitTextToSize(l.name, 62); if (y + nm.length * 5 + 6 > 195) { doc.addPage(); y = 16; }
    y += 6; doc.text(nm, M, y); doc.text(String(l.qty), 84, y, { align: "right" }); doc.text(rs(l.price), 108, y, { align: "right" }); doc.text(rs(l.qty * l.price), W - M, y, { align: "right" }); y += (nm.length - 1) * 5;
  }
  y += 4; doc.line(M, y, W - M, y);
  if (b.disc) { y += 6; doc.text("Subtotal", M, y); doc.text(rs(b.sub), W - M, y, { align: "right" }); y += 5; doc.text("Discount", M, y); doc.text("- " + rs(b.disc), W - M, y, { align: "right" }); }
  y += 8; doc.setFont("helvetica", "bold"); doc.setFontSize(13); doc.text("TOTAL", M, y); doc.text(rs(b.total), W - M, y, { align: "right" });
  y += 10; doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.text((b.byName ? "Billed by " + b.byName + " - " : "") + "Thank you. Visit again!", W / 2, y, { align: "center" });
  return doc.output("blob");
}
async function makeReportPdf() {
  const { jsPDF } = window.jspdf; const doc = new jsPDF({ unit: "mm", format: "a4" }); const W = 210, M = 14, BOT = 282;
  const D = reportData(), full = can("reports");
  const bills = full ? D.bills : D.bills.filter(isMine);
  const sales = bills.reduce((s, b) => s + b.total, 0);
  const pays = {}; for (const b of bills) pays[b.pay] = (pays[b.pay] || 0) + b.total;
  const kind = { day: "Daily", week: "Weekly", month: "Monthly", year: "Yearly" }[S.period];
  let y = await pdfHeader(doc, W, `${kind} sales report - ${D.R.title}`);
  doc.setFontSize(9); y += 5; doc.text(`Made by ${S.me.name || S.me.username} on ${new Date().toLocaleString("en-IN")}`, W / 2, y, { align: "center" });
  const need = (h) => { if (y + h > BOT) { doc.addPage(); y = 16; } };
  const heading = (t) => { need(14); y += 10; doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.text(t, M, y); y += 2; doc.line(M, y, W - M, y); doc.setFont("helvetica", "normal"); doc.setFontSize(10); };
  const row = (a, b, bold) => { need(7); y += 6; doc.setFont("helvetica", bold ? "bold" : "normal"); doc.text(String(a), M, y); doc.text(String(b), W - M, y, { align: "right" }); doc.setFont("helvetica", "normal"); };
  heading("Summary");
  row(full ? "Total sales" : "My sales", rs(sales), true); row("Number of bills", bills.length);
  if (D.disc && full) row("Discounts given", rs(D.disc));
  if (full) { row("Purchases", rs(D.pur)); row("Sales minus purchases", rs(D.sales - D.pur), true); }
  heading("Payment modes"); if (!Object.keys(pays).length) row("No sales", ""); for (const [k, v] of Object.entries(pays)) row(k, rs(v));
  if (full && D.byUser.length) { heading("Sales by staff"); for (const [k, v] of D.byUser) row(`${k} (${v.n} bills)`, rs(v.amt)); }
  const t = {}; for (const b of bills) for (const l of b.lines) { const x = t[l.name] || (t[l.name] = { qty: 0, amt: 0 }); x.qty += l.qty; x.amt += l.qty * l.price; }
  heading("Items sold"); const tl = Object.entries(t).sort((a, b) => b[1].amt - a[1].amt); if (!tl.length) row("No items sold", ""); for (const [k, v] of tl) row(`${k}  x ${v.qty}`, rs(v.amt));
  if (full && D.purs.length) { heading("Purchases"); for (const p of D.purs.slice().sort((a, b) => a.date.localeCompare(b.date))) row(`${prettyDate(p.date)}  ${p.desc}${p.qty ? " x " + p.qty : ""}`, rs(p.amount)); }
  heading("Bills");
  if (!bills.length) row("No bills", "");
  for (const b of bills.slice().reverse()) {
    need(7); y += 6; doc.setFontSize(9);
    doc.text(`${b.no}`, M, y); doc.text(`${prettyDate(b._date)} ${timeOf(b.ts)}`, M + 30, y); doc.text(String(b.pay), M + 78, y); doc.text(String(b.byName || ""), M + 98, y); doc.text(rs(b.total), W - M, y, { align: "right" });
  }
  return doc.output("blob");
}

/* ---------- render ---------- */
function tabsFor() {
  if (role() === "sales") return [["bill", "Billing", "bill"], ["items", "Items", "items"], ["reports", "My sales", "reports"], ["more", "Account", "more"]];
  return [["bill", "Billing", "bill"], ["items", "Items", "items"], ["purchases", "Purchases", "purchases"], ["reports", "Reports", "reports"], ["more", role() === "owner" ? "Shop" : "More", "more"]];
}
function keepVals() { const k = {}; document.querySelectorAll("#view input[id], #view select[id]").forEach((i) => { if (i.type !== "file" && i.type !== "checkbox") k[i.id] = i.value; }); return k; }
function putVals(k) { if (S.justReset) { S.justReset = false; return; } for (const [id, v] of Object.entries(k)) { const el = document.getElementById(id); if (el && el.type !== "file") el.value = v; } }
function render() {
  const sh = shop();
  document.body.dataset.shop = S.me ? sh.theme || "green" : "green";
  const a = document.activeElement, fid = a && a.id, sel = a && a.selectionStart, kept = keepVals();
  if (!S.ready || !S.me) {
    document.body.classList.add("locked"); document.body.classList.remove("has-mark");
    $("#view").innerHTML = S.ready && S.B ? vLogin() : `<div class="login"><p class="muted">Opening…</p></div>`;
    $("#inv").innerHTML = ""; $("#markbar").innerHTML = "";
    putVals(kept); if (fid) { const el = document.getElementById(fid); if (el) el.focus(); }
    return;
  }
  document.body.classList.remove("locked");
  const tabs = tabsFor(); if (!tabs.some((t) => t[0] === S.tab)) S.tab = "bill";
  const logo = imgUrl(sh.logo);
  $("#shopLogo").innerHTML = logo ? `<img src="${esc(logo)}" alt="">` : `<span>${esc((sh.name || "?").charAt(0).toUpperCase())}</span>`;
  $("#shopTitle").textContent = sh.name || "";
  $("#whoLbl").textContent = `${S.me.name || S.me.username} · ${ROLE_LABEL[S.me.role]} · ${new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`;
  const pc = can("approve") ? pendingCount() : 0;
  const nav = $("#tabs"); nav.style.gridTemplateColumns = `repeat(${tabs.length},1fr)`;
  nav.innerHTML = tabs.map(([k, l, ic]) => `<button data-act="tab" data-t="${k}" ${S.tab === k ? 'aria-current="page"' : ""}>${ICON[ic]}${esc(l)}${k === "more" && pc ? `<span class="badge">${pc}</span>` : ""}</button>`).join("");
  $("#view").innerHTML = { bill: vBill, items: vItems, purchases: vPurchases, reports: vReports, more: vMore }[S.tab]();
  putVals(kept); pTotal();
  const hadInv = !!$("#inv").firstChild;
  $("#inv").innerHTML = vInvoice(); $("#markbar").innerHTML = vMarkbar();
  document.body.classList.toggle("has-mark", !!$("#markbar").firstChild);
  if (!hadInv && $("#inv").firstChild) { const c = $("#closeInvBtn"); if (c) c.focus(); return; }
  if (fid) { const el = document.getElementById(fid); if (el) { el.focus(); try { if (sel != null) el.setSelectionRange(sel, sel); } catch (e) {} } }
}

/* ---------- writes ---------- */
const queues = {};
function serial(key, fn) { const p = (queues[key] || Promise.resolve()).then(fn, fn); queues[key] = p.catch(() => {}); return p; }
const failed = (e) => { console.error(e); toast("Couldn't save. Try again."); };
const sp = (p) => `shops/${S.sid}/${p}`;
async function addStock(id, delta) {
  const it = S.items.find((i) => i.id === id); if (!it || stockOf(it) === null || !delta) return;
  await S.db.doc(sp(`items/${id}`)).update({ stock: Math.round((stockOf(it) + delta) * 1000) / 1000 });
}
function warnStock(id) {
  const it = S.items.find((i) => i.id === id), l = S.cart.find((x) => x.id === id); const n = it ? stockOf(it) : null;
  if (n !== null && l && l.qty > n) toast(n <= 0 ? `${it.name} is out of stock` : `Only ${n} ${it.name} in stock`);
}
async function saveBill(btn) {
  if (!S.cart.length) return;
  btn.disabled = true; const sh = shop(), t = cartTotals(), now = new Date(), date = dkey(now), docId = `${date}_${DEVICE}`;
  const count = allBills().filter((b) => b._date === date).length + 1;
  const bill = {
    id: newId(), no: `${prefixOf(sh)}-${date.slice(5).replace("-", "")}-${pad(count)}`, ts: now.getTime(),
    lines: S.cart.map((l) => ({ id: l.id, name: l.name, qty: l.qty, price: l.price })), sub: t.sub, disc: t.disc, total: t.total, pay: S.pay, cust: S.cust.trim(),
    uid: S.me.id, by: S.me.username, byName: S.me.name || S.me.username,
  };
  try {
    await serial(docId, () => { const cur = S.days.find((d) => d.id === docId); return S.db.doc(sp(`days/${docId}`)).set({ date, device: DEVICE, bills: [...((cur && cur.bills) || []), bill] }); });
    for (const l of bill.lines) await addStock(l.id, -l.qty);
    S.cart = []; S.disc = ""; S.cust = ""; toast(`Bill ${bill.no} saved · ${inr(bill.total)}`);
    if (S.tab === "bill") S.inv = `${docId}|${bill.id}`; render();
  } catch (e) { btn.disabled = false; failed(e); }
}
async function usernameTaken(u) { const d = await S.db.doc(`usernames/${u}`).get(); return d.exists; }
async function writeBatchDocs(base, map) { for (const [id, d] of Object.entries(map || {})) await S.db.doc(`${base}/${id}`).set(d); }
async function importData(data, idPrefix) {
  const sid = S.sid;
  await writeBatchDocs(`shops/${sid}/images`, Object.fromEntries(Object.entries(data.images || {}).map(([k, v]) => [k, { data: v }])));
  await writeBatchDocs(`shops/${sid}/items`, data.items);
  await writeBatchDocs(`shops/${sid}/days`, Object.fromEntries(Object.entries(data.days || {}).map(([k, v]) => [idPrefix + k, v])));
  await writeBatchDocs(`shops/${sid}/purchases`, data.purchases);
}

/* ---------- events ---------- */
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act]"); if (!el) return; const act = el.dataset.act, id = el.dataset.id;
  const go = (fn) => { e.preventDefault(); fn(); };
  switch (act) {
    case "lgregister": return go(() => { S.lg = { step: "register" }; S.lgErr = ""; clearPick("logo"); S.justReset = true; render(); window.scrollTo(0, 0); });
    case "lgforgot": return go(() => { S.lg = { step: "forgot" }; S.lgErr = ""; S.justReset = true; render(); });
    case "lgback": return go(() => { S.lg = { step: "login" }; S.lgErr = ""; S.justReset = true; render(); });
    case "lgcancel": return go(() => logout());
    case "logout": return logout();
    case "nophoto": S.pickRemove[el.dataset.p] = true; if (S.pick[el.dataset.p]) { URL.revokeObjectURL(S.pick[el.dataset.p].url); delete S.pick[el.dataset.p]; } return render();
    case "closeinv": if (el.classList.contains("sheet-bg") && e.target !== el) return; S.inv = null; return render();
    case "view": S.inv = el.dataset.k; return render();
    case "mark": if (S.marked[id]) delete S.marked[id]; else S.marked[id] = 1; return render();
    case "clearmarks": S.marked = {}; return render();
    case "makebill": {
      for (const id2 of Object.keys(S.marked)) { const it = S.items.find((i) => i.id === id2); if (!it) continue; const l = S.cart.find((x) => x.id === id2); if (l) l.qty++; else S.cart.push({ id: id2, name: it.name, price: Number(it.price), qty: 1 }); }
      S.marked = {}; S.tab = "bill"; render(); window.scrollTo(0, 0);
      const out = S.cart.filter((l) => { const it = S.items.find((i) => i.id === l.id); return it && stockOf(it) !== null && l.qty > stockOf(it); });
      return toast(out.length ? `Low stock: ${out.map((l) => l.name).join(", ")}` : "Items added to the bill. Change quantities, then Save bill.");
    }
    case "pdf": {
      const { b } = findBill(S.inv); if (!b || !S.dl) return;
      try { await S.dl.save({ filename: `${b.no}.pdf`, data: await makePdf(b) }); toast("PDF ready"); }
      catch (err) { if (err && err.code === "declined") return; toast("Couldn't make the PDF. Try again."); }
      return;
    }
    case "reportpdf": {
      if (!S.dl) return; el.disabled = true;
      try { const R = range(); await S.dl.save({ filename: `report-${S.period}-${R.s}.pdf`, data: await makeReportPdf() }); toast("Report ready"); }
      catch (err) { if (!err || err.code !== "declined") toast("Couldn't make the report. Try again."); }
      el.disabled = false; return;
    }
    case "backup": {
      const pack = (list) => Object.fromEntries(list.map(({ id, ...d }) => [id, d]));
      const data = { app: "kada-billing", version: 3, savedAt: new Date().toISOString(), shop: { ...shop() }, items: pack(S.items), days: pack(S.days), purchases: pack(S.purchases), images: { ...S.images } };
      try { await S.dl.save({ filename: `kada-billing-backup-${dkey(new Date())}.json`, data: JSON.stringify(data) }); toast("Backup ready"); } catch (err) { if (!err || err.code !== "declined") toast("Couldn't make the backup"); }
      return;
    }
    case "restoreno": S.restoreAsk = null; return render();
    case "restoreyes": {
      if (!can("backup")) return; let data; try { data = JSON.parse(S.restoreAsk); } catch (e) { data = null; } S.restoreAsk = null;
      if (!data || data.app !== "kada-billing" || !data.items) { toast("That file isn't a Kada Billing backup"); return render(); }
      el.disabled = true; try { await importData(data, ""); toast("Backup restored"); } catch (err) { failed(err); } return render();
    }
    case "importold": {
      if (!can("backup")) return; S.confirm = null; el.disabled = true; toast("Copying…");
      try { const data = await window.kadaLegacy.exportShop(id); await importData(data, "old-"); try { localStorage.setItem("kb-imported-" + id, S.sid); } catch (e) {}
        toast(`Copied ${Object.keys(data.items).length} items and ${Object.values(data.days).reduce((s, d) => s + (d.bills || []).length, 0)} bills`); } catch (err) { failed(err); }
      return render();
    }
    case "tab": S.tab = el.dataset.t; S.confirm = null; S.resetFor = null; S.justReset = true; render(); return window.scrollTo(0, 0);
    case "cat": S.cat = el.dataset.c; return render();
    case "add": case "inc": { const it = S.items.find((i) => i.id === id); const l = S.cart.find((x) => x.id === id); if (l) l.qty++; else if (it) S.cart.push({ id, name: it.name, price: Number(it.price), qty: 1 }); render(); return warnStock(id); }
    case "dec": { const i = S.cart.findIndex((x) => x.id === id); if (i > -1) { S.cart[i].qty--; if (!S.cart[i].qty) S.cart.splice(i, 1); } return render(); }
    case "clear": S.cart = []; S.disc = ""; S.cust = ""; return render();
    case "pay": S.pay = el.dataset.p; return render();
    case "save": return saveBill(el);
    case "conf": S.confirm = el.dataset.k; return render();
    case "noconf": S.confirm = null; return render();
    case "delbill": {
      if (!can("delBill")) return; const { d, b } = findBill(el.dataset.k); const bid = el.dataset.k.split("|")[1]; S.confirm = null; if (!d) return render();
      try { await serial(d.id, () => S.db.doc(sp(`days/${d.id}`)).set({ date: d.date, device: d.device || "", bills: ((S.days.find((x) => x.id === d.id) || {}).bills || []).filter((x) => x.id !== bid) }));
        for (const l of b ? b.lines : []) if (l.id) await addStock(l.id, l.qty); toast("Bill deleted. Stock put back."); } catch (err) { failed(err); }
      return;
    }
    case "copy": {
      const { b } = findBill(el.dataset.k); if (!b) return;
      const txt = [shop().name, `Bill ${b.no} · ${new Date(b.ts).toLocaleString("en-IN")}`, ...b.lines.map((l) => `${l.name} x${l.qty} = ${inr(l.qty * l.price)}`), b.disc ? `Discount -${inr(b.disc)}` : "", `Total: ${inr(b.total)} (${b.pay})`].filter(Boolean).join("\n");
      try { await navigator.clipboard.writeText(txt); toast("Bill copied. Paste it in WhatsApp or SMS."); } catch (err) { toast("Copy isn't allowed here"); }
      return;
    }
    case "edit": if (!can("editItem")) return; S.editing = id; clearPick("item"); S.justReset = true; render(); return window.scrollTo(0, 0);
    case "canceledit": S.editing = null; clearPick("item"); S.justReset = true; return render();
    case "delitem": { if (!can("editItem")) return; S.confirm = null; const old = S.items.find((i) => i.id === id);
      try { await S.db.doc(sp(`items/${id}`)).delete(); toast("Item removed"); if (old && old.img) IMG.remove(old.img); } catch (err) { failed(err); } return; }
    case "delpur": { if (!can("purchases")) return; S.confirm = null; const p = S.purchases.find((x) => x.id === id);
      try { await S.db.doc(sp(`purchases/${id}`)).delete(); if (p && p.itemId && p.qty) await addStock(p.itemId, -Number(p.qty)); toast("Purchase deleted"); } catch (err) { failed(err); } return; }
    case "buy": if (!can("purchases")) return; S.pItem = id; S.tab = "purchases"; S.confirm = null; S.justReset = true; render(); { const c = $("#purCard"); if (c) c.scrollIntoView({ block: "start" }); const q = $("#pQty"); if (q) q.focus(); } return;
    case "tolow": S.tab = "purchases"; S.justReset = true; render(); return window.scrollTo(0, 0);
    case "ifilter": S.iFilter = el.dataset.f; return render();
    case "period": S.period = el.dataset.p; S.offset = 0; return render();
    case "prev": S.offset--; return render();
    case "next": if (S.offset < 0) S.offset++; return render();
    case "approve": case "reject": case "enable": case "disable": case "setrole": case "deluser": {
      if (!can("approve")) return; const u = shopUsers().find((x) => x.id === id); if (!u || u.role === "owner") return; S.confirm = null;
      try {
        const ref = S.db.doc(sp(`members/${id}`));
        if (act === "approve" || act === "enable") await ref.update({ status: "active" });
        else if (act === "reject") await ref.update({ status: "rejected" });
        else if (act === "disable") await ref.update({ status: "disabled" });
        else if (act === "setrole") await ref.update({ role: el.dataset.r });
        else { await ref.delete(); await S.db.doc(`usernames/${uname(u.username)}`).delete(); }
        toast({ approve: `${u.name || u.username} can log in now`, reject: "Request rejected", enable: "User turned on", disable: "User turned off", setrole: `${u.name || u.username} is now ${ROLE_LABEL[el.dataset.r]}`, deluser: "User deleted" }[act]);
      } catch (err) { failed(err); }
      return;
    }
    case "resetpw": S.resetFor = id; render(); { const f = $("#rpNew"); if (f) f.focus(); } return;
    case "noreset": S.resetFor = null; return render();
  }
});
document.addEventListener("input", (e) => {
  const t = e.target;
  if (t.id === "q") { S.q = t.value; render(); }
  else if (t.id === "iq") { S.iq = t.value; render(); }
  else if (t.id === "disc") { S.disc = t.value; const n = $("#totalNum"); if (n) n.textContent = inr(cartTotals().total); }
  else if (t.id === "cust") S.cust = t.value;
  else if (t.id === "pDate") S.pDate = t.value;
  else if (t.id === "pQty" || t.id === "pCost") pTotal();
});
document.addEventListener("change", async (e) => {
  const t = e.target;
  if (t.id === "disc") render();
  else if (t.id === "pItem") { S.pItem = t.value; render(); const it = S.items.find((i) => i.id === S.pItem), c = $("#pCost"); if (c) c.value = it && it.cost != null ? it.cost : ""; pTotal(); }
  else if (t.dataset && t.dataset.photo && t.files[0]) {
    const target = t.dataset.photo;
    try { const blob = await shrink(t.files[0]); clearPick(target); S.pick[target] = { blob, url: URL.createObjectURL(blob) }; render(); }
    catch (err) { toast("Couldn't open that photo. Try another one."); }
  } else if (t.id === "restoreFile" && t.files[0]) { S.restoreAsk = await t.files[0].text(); render(); }
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && S.inv) { S.inv = null; render(); } });

async function authSubmit(id, form) {
  const fail = (m) => { S.lgErr = m; render(); const er = $(".err"); if (er) er.scrollIntoView({ block: "center" }); };
  const btn = form.querySelector("button[type=submit]");
  const busy = (on) => { if (btn) { btn.disabled = on; btn.classList.toggle("loading", on); } };
  if (id === "loginForm") {
    const raw = $("#lUser").value.trim(), pw = $("#lPass").value;
    busy(true); S.lgErr = "";
    try {
      let email = raw;
      if (!raw.includes("@")) {
        const d = await S.db.doc(`usernames/${uname(raw)}`).get();
        if (!d.exists) { busy(false); $("#lPass").value = ""; return fail("Wrong username or password."); }
        email = d.data().email;
      }
      await S.B.auth.signIn(email, pw); // onAuth opens the shop
    } catch (e) { busy(false); $("#lPass") && ($("#lPass").value = ""); return fail(String(e.code || "").startsWith("auth/") ? e.message : "Couldn't log in. Check the internet and try again."); }
    return;
  }
  if (id === "regForm") {
    const name = $("#rName").value.trim(), owner = $("#rOwner").value.trim(), user = uname($("#rUser").value), p1 = $("#rPass").value, p2 = $("#rPass2").value, phone = $("#rPhone").value.trim();
    const realEmail = $("#rEmail") ? $("#rEmail").value.trim() : "";
    if (!name) return fail("Enter the shop name.");
    if (digits(phone).length < 10) return fail("Enter a 10-digit shop phone number.");
    if (!owner) return fail("Enter your name.");
    if (!okUser(user)) return fail("Username needs 3 to 30 small letters or numbers, with no spaces.");
    if (realEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(realEmail)) return fail("That email address doesn't look right.");
    if (p1.length < PW_MIN) return fail(`The password needs at least ${PW_MIN} characters.`);
    if (p1 !== p2) return fail("The two passwords don't match.");
    busy(true); S.authBusy = true; let signedUp = false;
    try {
      if (await usernameTaken(user)) { S.authBusy = false; busy(false); return fail("That username is already taken. Pick another one."); }
      const sid = "s" + newId();
      const email = realEmail || synthEmail(user);
      const u = await S.B.auth.signUp(email, p1, sid); signedUp = true;
      await S.db.doc(`shops/${sid}`).set({ name, addr: $("#rAddr").value.trim(), phone, gst: $("#rGst").value.trim().toUpperCase(), logo: "", prefix: name.charAt(0).toUpperCase(), theme: $("#rTheme").value, ownerUid: u.uid, createdAt: Date.now() });
      const m = { name: owner, username: user, role: "owner", status: "active", phone, mustChange: false, createdAt: Date.now() };
      await S.db.doc(`shops/${sid}/members/${u.uid}`).set(m);
      await S.db.doc(`usernames/${user}`).set({ uid: u.uid, sid, email });
      if (S.pick.logo) { const logo = await IMG.save(sid, S.pick.logo.blob); await S.db.doc(`shops/${sid}`).update({ logo }); }
      clearPick("logo"); S.authBusy = false; toast("Shop created");
      return loginAs(sid, { id: u.uid, ...m }, true);
    } catch (e) {
      console.error(e); busy(false);
      if (signedUp) { await Promise.resolve(S.B.auth.signOut()).catch(() => {}); }
      S.authBusy = false; return fail(e.message && e.code ? e.message : "Couldn't create the shop. Check the internet and try again.");
    }
  }
  if (id === "setpwForm") {
    const { sid, uid, member } = S.lg; const p1 = $("#sPass").value, p2 = $("#sPass2").value;
    if (p1.length < PW_MIN) return fail(`The password needs at least ${PW_MIN} characters.`);
    if (p1 !== p2) return fail("The two passwords don't match.");
    busy(true);
    try { await S.B.auth.setPassword(p1); await S.db.doc(`shops/${sid}/members/${uid}`).update({ mustChange: false }); toast("Password saved"); return loginAs(sid, { ...member, id: uid, mustChange: false }, true); }
    catch (e) { busy(false); return fail(e.message || "Couldn't save. Try again."); }
  }
  if (id === "forgotForm") {
    const user = uname($("#fUser").value); busy(true);
    try {
      const d = await S.db.doc(`usernames/${user}`).get();
      if (!d.exists) { busy(false); return fail("No login with that username."); }
      const email = d.data().email || "";
      if (email.endsWith(SYN_DOMAIN)) { busy(false); return fail("This login has no email saved. Ask your shop owner to reset your password."); }
      await S.B.auth.sendReset(email);
      const [a, b] = email.split("@"); S.lg = { step: "forgot", sent: `We sent a password reset link to ${a.slice(0, 2)}***@${b}. Open it, set a new password, then log in.` }; S.lgErr = ""; return render();
    } catch (e) { busy(false); return fail(e.message || "Couldn't send the link. Try again."); }
  }
}

document.addEventListener("submit", async (e) => {
  e.preventDefault(); const f = e.target, id = f.id;
  if (["loginForm", "regForm", "setpwForm", "forgotForm"].includes(id)) return authSubmit(id, f);
  if (!S.me) return;
  const num = (v) => (String(v).trim() === "" ? null : Number(v));
  const btn = f.querySelector("button[type=submit]");
  if (id === "itemForm") {
    if (!can("editItem")) return;
    const name = $("#iName").value.trim(), price = parseFloat($("#iPrice").value); if (!name || !(price >= 0)) return;
    const old = S.editing ? S.items.find((i) => i.id === S.editing) : null; const iid = old ? old.id : newId();
    if (btn) btn.disabled = true;
    try {
      const img = await savePick("item", S.sid, old && old.img);
      await S.db.doc(sp(`items/${iid}`)).set({ name, price, cat: $("#iCat").value.trim() || "Other", img, stock: num($("#iStock").value), low: num($("#iLow").value), cost: num($("#iCost").value) });
      toast(old ? "Item updated" : "Item added"); clearPick("item"); S.editing = null; S.justReset = true; render(); const n = $("#iName"); if (n) n.focus();
    } catch (err) { if (btn) btn.disabled = false; failed(err); }
  } else if (id === "purForm") {
    if (!can("purchases")) return;
    const date = $("#pDate").value, sup = $("#pSup").value.trim(); if (!date) return;
    const it = S.items.find((i) => i.id === S.pItem), by = { uid: S.me.id, byName: S.me.name || S.me.username };
    try {
      if (it) {
        const qty = parseFloat($("#pQty").value), cost = parseFloat($("#pCost").value); if (!(qty > 0) || !(cost >= 0)) return;
        const newStock = Math.round(((stockOf(it) || 0) + qty) * 1000) / 1000;
        await S.db.collection(sp("purchases")).add({ date, desc: it.name, sup, amount: Math.round(qty * cost * 100) / 100, qty, cost, itemId: it.id, ts: Date.now(), ...by });
        await S.db.doc(sp(`items/${it.id}`)).update({ stock: newStock, cost });
        toast(`Purchase saved. ${it.name} stock is now ${newStock}`); S.pItem = "";
      } else {
        const desc = $("#pDesc").value.trim(), amount = parseFloat($("#pAmt").value); if (!desc || !(amount >= 0)) return;
        await S.db.collection(sp("purchases")).add({ date, desc, sup, amount, ts: Date.now(), ...by }); toast("Purchase saved");
      }
      S.pDate = date; S.justReset = true; render();
    } catch (err) { failed(err); }
  } else if (id === "shopForm") {
    if (!can("shop")) return; const sh = shop(); if (btn) btn.disabled = true;
    try {
      const logo = await savePick("logo", S.sid, sh.logo);
      await S.db.doc(`shops/${S.sid}`).update({ name: $("#shName").value.trim() || sh.name, addr: $("#shAddr").value.trim(), phone: $("#shPhone").value.trim(), gst: $("#shGst").value.trim().toUpperCase(), prefix: ($("#shPrefix").value.trim() || prefixOf(sh)).toUpperCase(), theme: $("#shTheme").value, logo });
      clearPick("logo"); toast("Shop details saved"); S.justReset = true; render();
    } catch (err) { if (btn) btn.disabled = false; failed(err); }
  } else if (id === "userForm") {
    if (!can("users")) return;
    const name = $("#uName").value.trim(), user = uname($("#uUser").value), pw = $("#uPass").value, r = $("#uRole").value;
    if (!okUser(user)) return toast("Username needs 3 to 30 small letters or numbers, with no spaces.");
    if (pw.length < PW_MIN) return toast(`The password needs at least ${PW_MIN} characters.`);
    const owner = can("approve"); if (btn) btn.disabled = true;
    try {
      if (await usernameTaken(user)) { if (btn) btn.disabled = false; return toast("That username is already taken. Pick another one."); }
      const email = synthEmail(user);
      const acc = await S.B.auth.createOther(email, pw, S.sid);
      await S.db.doc(sp(`members/${acc.uid}`)).set({ name, username: user, role: r, status: owner ? "active" : "pending", phone: "", mustChange: true, addedBy: S.me.name || S.me.username, createdAt: Date.now() });
      await S.db.doc(`usernames/${user}`).set({ uid: acc.uid, sid: S.sid, email });
      toast(owner ? `${name} added. Share the username and password with them.` : `${name} sent to the owner for approval`); S.justReset = true; render();
    } catch (err) { if (btn) btn.disabled = false; toast(err.message || "Couldn't add the user."); }
  } else if (id === "resetForm") {
    // A new login replaces the old one: the staff member keeps their username, bills and role.
    if (!can("approve") || !S.resetFor) return; const pw = $("#rpNew").value; if (pw.length < PW_MIN) return toast(`The password needs at least ${PW_MIN} characters.`);
    const old = S.members.find((x) => x.id === S.resetFor); if (!old) return; if (btn) btn.disabled = true;
    try {
      const email = synthEmail(uname(old.username));
      const acc = await S.B.auth.createOther(email, pw, S.sid);
      const { id: _drop, ...rest } = old;
      await S.db.doc(sp(`members/${acc.uid}`)).set({ ...rest, status: "active", mustChange: true });
      await S.db.doc(`usernames/${uname(old.username)}`).update({ uid: acc.uid, email });
      await S.db.doc(sp(`members/${old.id}`)).delete();
      S.resetFor = null; toast("Password reset. They will set their own at next login."); render();
    } catch (err) { if (btn) btn.disabled = false; toast(err.message || "Couldn't reset the password."); }
  } else if (id === "cpForm") {
    const oldPw = $("#cpOld").value, p1 = $("#cpNew").value, p2 = $("#cpNew2").value;
    if (p1.length < PW_MIN) return toast(`The new password needs at least ${PW_MIN} characters.`);
    if (p1 !== p2) return toast("The two new passwords don't match.");
    try { await S.B.auth.changePassword(oldPw, p1); toast("Password changed"); S.justReset = true; render(); } catch (err) { toast(err.message || "Couldn't change the password."); }
  }
});

window.addEventListener("kada-write-failed", (e) => toast(e.detail === "permission-denied" ? "Not saved: your login isn't allowed to change this." : "A change couldn't be saved to the server."));
window.addEventListener("kada-storage-full", () => notice("This browser's storage is full, so the last change may not be saved. Remove old item photos, or use the Android app.", true));
if ("serviceWorker" in navigator && location.protocol === "https:" && window.kadaBackend.mode !== "artifact" && !(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

render();
boot();
