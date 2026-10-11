(function () {
"use strict";

const APP = "DN Studios";
if (window.top !== window.self) {      // never run inside a frame on someone else's page
  const a = document.createElement("a");
  a.href = location.href; a.target = "_top"; a.rel = "noopener"; a.textContent = "Open " + APP;
  document.body.replaceChildren(a);
  return;
}

const CFG = window.EDIT_ROOM_CONFIG || {};
const API = String(CFG.url || "").replace(/\/+$/, "") + "/rest/v1/rpc/";
const DAY = 864e5, HOUR = 36e5, MIN = 6e4;
const STAGES = ["Started", "Rough cut", "Polishing"];
const STAGE_AT = ["16.667%", "50%", "83.333%"];
const STATUS_FILTERS = [["active", "In progress"], ["late", "Past deadline"], ["over", "Grace over"], ["waiting", "Waiting for you"], ["ontime", "Submitted on time"], ["sublate", "Submitted late"], ["received", "Received"], ["reassigned", "Reassigned"], ["all", "All projects"]];
const ADMIN_TABS = [["inbox", "Inbox"], ["projects", "Projects"], ["editors", "Editors"], ["settings", "Settings"]];
const EDITOR_TABS = [["work", "My work"], ["board", "Leaderboard"], ["earn", "Earnings"]];
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Oops extends Error {}
class ApiError extends Error { constructor(code, status) { super(code); this.code = code; this.status = status; } }

const state = {
  phase: "boot",               // boot | down | setup | login | ready
  online: true, token: null, skew: 0, cursor: null, lastFull: 0, wantFull: false,
  me: { id: null, name: "", username: "", role: "editor", owner: false, av: 0, has: false },
  isAdmin: false,
  config: { categories: [], weeklyTarget: null, deliveryHours: 24, graceHours: 48, currency: "", tz: "UTC" },
  prefs: { bonusAmount: null },
  cats: new Map(), users: new Map(), projects: new Map(), bonuses: new Map(),
  board: { week: [], month: [], awards: [] }, weeks: [0, 0, 0, 0, 0, 0], month: 0, totals: { videos: 0, bonus: 0, month: 0 },
  stats: { editors: new Map(), cats: new Map() },     // admin only: figures worked out by the server
  horizon: null,                                      // admin only: where history older than the loaded projects starts
};
// Older projects for the admin's Projects list, fetched a page at a time for the filters in use.
const hist = { key: null, rows: new Map(), next: null, more: false, busy: false, failed: false };
function resetHist() { hist.key = null; hist.rows = new Map(); hist.next = null; hist.more = false; hist.busy = false; hist.failed = false; }
const ui = { view: "editor", tab: "inbox", etab: "work", fStatus: "active", fEditor: "all", fCat: "all", period: "week", manage: null, limit: 40, older: false, earnAll: false, spark: null };
const pics = new Map();        // user id -> { ver, url }

/* ---------- small helpers ---------- */
function h(tag, props) {
  const el = document.createElement(tag);
  if (props) for (const k of Object.keys(props)) {
    const v = props[k];
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (v === true) { if (k in el) el[k] = true; else el.setAttribute(k, ""); }
    else el.setAttribute(k, String(v));
  }
  for (let i = 2; i < arguments.length; i++) add(el, arguments[i]);
  return el;
}
function add(el, kid) {
  if (kid == null || kid === false) return;
  if (Array.isArray(kid)) { for (const k of kid) add(el, k); return; }
  el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
}
const ICONS = {       // line drawings on a 24-unit square
  out: "M9 4.5h10.5V15M19.5 4.5L5.5 18.5",
  next: "M9 5l7 7-7 7",
  inbox: "M4 13l2.3-6.4a1.5 1.5 0 0 1 1.4-1h8.6a1.5 1.5 0 0 1 1.4 1L20 13v4.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5V13zM4 13h4.3l1.1 2.3h5.2l1.1-2.3H20",
  projects: "M5.5 4.5h13A1.5 1.5 0 0 1 20 6v12a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18V6a1.5 1.5 0 0 1 1.5-1.5zM8.5 4.5v15M15.5 4.5v15M4 9.5h4.5M4 14.5h4.5M15.5 9.5H20M15.5 14.5H20",
  editors: "M9 11.2a3.3 3.3 0 1 0 0-6.6 3.3 3.3 0 0 0 0 6.6zM3 19.4c0-3 2.7-5 6-5s6 2 6 5M15.6 4.9a3.3 3.3 0 0 1 0 6M17.6 14.8c2 .7 3.4 2.3 3.4 4.6",
  settings: "M4 7.5h7.5M18 7.5h2M4 16.5h2M12.5 16.5H20M14.75 5.2a2.3 2.3 0 1 0 0 4.6 2.3 2.3 0 0 0 0-4.6zM9.25 14.2a2.3 2.3 0 1 0 0 4.6 2.3 2.3 0 0 0 0-4.6z",
  work: "M4 10.5h16v7.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18v-7.5zM4 10.5l-.7-3.4 15.1-3.2.7 3.4L4 10.5zM8 6.1l2.6 3M12.9 5.1l2.6 3",
  board: "M8 4.5h8v4.7a4 4 0 0 1-8 0V4.5zM8 6.3H5.2v.7A2.8 2.8 0 0 0 8 9.8M16 6.3h2.8v.7A2.8 2.8 0 0 1 16 9.8M12 13.2v3.3M8.5 19.5h7M10 16.5h4v3h-4z",
  earn: "M17.5 8.5V7a1.5 1.5 0 0 0-1.5-1.5H6A2 2 0 0 0 4 7.5V17a2 2 0 0 0 2 2h12.5a1.5 1.5 0 0 0 1.5-1.5V10a1.5 1.5 0 0 0-1.5-1.5H6a2 2 0 0 1-2-1.5M16 13.8h.2",
};
function icon(name, size, weight) {
  const NS = "http://www.w3.org/2000/svg", s = document.createElementNS(NS, "svg"), p = document.createElementNS(NS, "path");
  s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("width", String(size || 22)); s.setAttribute("height", String(size || 22)); s.setAttribute("aria-hidden", "true");
  p.setAttribute("d", ICONS[name]); p.setAttribute("fill", "none"); p.setAttribute("stroke", "currentColor");
  p.setAttribute("stroke-width", String(weight || 2)); p.setAttribute("stroke-linecap", "round"); p.setAttribute("stroke-linejoin", "round");
  s.append(p);
  return s;
}
const str = (v, max) => (typeof v === "string" ? v : "").slice(0, max);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const amount = (v) => { const n = num(v); return n != null && n >= 0 && n <= 1e9 ? n : null; };
const plural = (n, one, many) => n + " " + (n === 1 ? one : many);
const esc = (s) => String(s).replace(/["\\]/g, "\\$&");
const tidy = (s) => String(s || "").trim().replace(/\s+/g, " ");
const now = () => Date.now() + state.skew;     // the server's clock, so a wrong phone clock changes nothing

/* ---------- time and money ---------- */
const fmtDay = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const fmtStamp = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const fmtMonth = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
const shortDate = (ms) => fmtDay.format(new Date(ms));
const stamp = (ms) => fmtStamp.format(new Date(ms));
let team = { tz: null, day: fmtDay, month: fmtMonth };
function teamFmt() {    // weeks and months are the team's, whatever time zone this phone is in
  const tz = state.config.tz;
  if (team.tz !== tz) {
    try { team = { tz: tz, day: new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", timeZone: tz }), month: new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: tz }) }; }
    catch (e) { team = { tz: tz, day: fmtDay, month: fmtMonth }; }
  }
  return team;
}
const teamDay = (ms) => teamFmt().day.format(new Date(ms));
const teamMonth = (ms) => teamFmt().month.format(new Date(ms));
function ago(ms) {
  const d = now() - ms;
  if (d < MIN) return "just now";
  if (d < HOUR) return Math.floor(d / MIN) + "m ago";
  if (d < DAY) return Math.floor(d / HOUR) + "h ago";
  if (d < 14 * DAY) return Math.floor(d / DAY) + "d ago";
  return shortDate(ms);
}
function span(ms) {   // a length of time, to the minute: "18h 20m", "3d 4h"
  const m = Math.floor(Math.max(0, ms) / MIN);
  if (m < 60) return Math.max(1, m) + "m";
  const hh = Math.floor(m / 60);
  if (hh < 48) return hh + "h" + (m % 60 ? " " + (m % 60) + "m" : "");
  return Math.floor(hh / 24) + "d" + (hh % 24 ? " " + (hh % 24) + "h" : "");
}
const windows = () => ({ weeks: state.weeks, month: state.month });
function money(n) {
  const x = n || 0, whole = Math.abs(x - Math.round(x)) < 0.005;
  const v = x.toLocaleString(undefined, whole ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 }), c = state.config.currency;
  return c ? (/^[A-Za-z]{2,}$/.test(c) ? c + " " + v : c + v) : v;
}
function parseAmount(text) {
  const s = String(text == null ? "" : text).replace(/[,\s]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= 1e9 ? Math.round(n * 100) / 100 : null;
}

/* ---------- talking to the server ---------- */
const HEADERS = { "Content-Type": "application/json" };
if (CFG.key) { HEADERS.apikey = CFG.key; HEADERS.Authorization = "Bearer " + CFG.key; }
async function api(fn, args) {
  const stop = new AbortController(), timer = setTimeout(() => stop.abort(), 25000);
  let res;
  try {
    res = await fetch(API + fn, { method: "POST", headers: HEADERS, body: JSON.stringify(args || {}), cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer", signal: stop.signal });
  } catch (e) { throw new ApiError("offline", 0); }
  finally { clearTimeout(timer); }
  let body = null;
  try { body = await res.json(); } catch (e) { /* an empty or unreadable reply */ }
  if (!res.ok) throw new ApiError(body && typeof body.message === "string" ? body.message : "server", res.status);
  return body;
}
async function call(fn, args) {
  try { return await api(fn, Object.assign({ p_token: state.token }, args || {})); }
  catch (e) { if (e.code === "auth") leave("You've been signed out. Sign in again."); throw e; }
}
async function run(fn, args) {       // do something, then pull the result back in
  const r = await call(fn, args);
  await sync();
  return r;
}
const ERRORS = {
  offline: "Can't reach the server. Check your connection and try again.",
  auth: "You've been signed out. Sign in again.",
  forbidden: "Your login isn't allowed to do that.",
  not_found: "That has changed since you opened it. Check the list and try again.",
  need_category: "Choose a category.",
  bad_name: "Enter a name. It may be too long or empty.",
  bad_link: "Paste the full link, starting with https://",
  weak_password: "Use a password of at least 8 characters.",
  bad_username: "Usernames are 3 to 24 characters: small letters, numbers, dots and dashes.",
  taken: "That name is already taken.",
  invalid: "That value isn't allowed. Check it and try again.",
  bad_picture: "That picture couldn't be used. Try another one.",
  full: "The list is full. Remove one before adding another.",
  bad_login: "Wrong username or password.",
  locked: "Too many wrong tries. Wait 15 minutes and try again.",
  inactive: "This login has been switched off. Ask your admin.",
  busy: "Too many sign-in attempts right now. Try again in a minute.",
  bad_code: "That setup code isn't right.",
  setup_done: APP + " is already set up. Reload and sign in.",
  bad_name_setup: "Enter your name.",
  in_use: "This login has work or bonuses on record, so it can't be deleted. Switch it off instead.",
};
const errText = (e) => ERRORS[e && e.code] || "That didn't work. Try again in a moment.";
async function act(btn, fn, okMsg) {
  if (btn) btn.disabled = true;
  try { await fn(); if (okMsg) toast(okMsg); }
  catch (e) { toast(e instanceof Oops ? e.message : errText(e), true); if (btn && btn.isConnected) btn.disabled = false; }
}

function normProject(r) {
  return {
    id: String(r.id), name: str(r.name, 140) || "Untitled project", catId: r.cat ? String(r.cat) : null,
    stage: Math.min(3, Math.max(1, Math.round(num(r.stage) || 1))),
    status: r.status === "submitted" || r.status === "reassigned" ? r.status : "active",
    startedAt: num(r.started) || 0, updatedAt: num(r.updated) || num(r.started) || 0, submittedAt: num(r.submitted),
    due: num(r.due) || 0, graceEnd: num(r.grace) || num(r.due) || 0, touched: num(r.touched) || num(r.started) || 0,
    link: str(r.link, 600) || null, note: str(r.note, 400), update: str(r.progress, 240),
    backAt: num(r.back), backNote: str(r.backNote, 300),
    from: r.from ? String(r.from) : null, movedTo: r.to ? String(r.to) : null, movedAt: num(r.moved), seenMoved: r.seen === true,
    receivedAt: num(r.received), amount: amount(r.amount),
  };
}
function applyState(d) {
  const wasAdmin = state.isAdmin, hadMe = state.me.id;
  state.skew = Number(d.now) - Date.now();
  const m = d.me || {};
  state.me = { id: String(m.id), name: str(m.name, 40), username: str(m.username, 24), role: m.role === "admin" ? "admin" : "editor", owner: m.owner === true, av: num(m.av) || 0, has: m.has === true };
  state.isAdmin = state.me.role === "admin";
  const s = d.settings || {}, active = [];
  state.cats = new Map();
  for (const c of Array.isArray(d.cats) ? d.cats : []) {
    const cat = { id: String(c.id), name: str(c.name, 40), rate: amount(c.rate), archived: c.archived === true };
    state.cats.set(cat.id, cat);
    if (!cat.archived) active.push(cat);
  }
  state.config = { categories: active, weeklyTarget: num(s.target), deliveryHours: num(s.delivery) || 24, graceHours: num(s.grace) == null ? 48 : num(s.grace), currency: str(s.currency, 6), tz: str(s.tz, 64) || "UTC" };
  state.prefs = { bonusAmount: amount(s.bonus) };
  state.users = new Map();
  for (const u of Array.isArray(d.users) ? d.users : []) {
    state.users.set(String(u.id), { id: String(u.id), name: str(u.name, 40) || "Unnamed", username: str(u.username, 24), role: u.role === "admin" ? "admin" : "editor", owner: u.owner === true, active: u.active !== false, av: num(u.av) || 0, has: u.has === true, seen: num(u.seen), earned: amount(u.earned) || 0, bonus: amount(u.bonus) || 0, last: num(u.last) || 0, moved: num(u.moved) || 0 });
  }
  if (Array.isArray(d.weeks) && d.weeks.length === 6) state.weeks = d.weeks.map(Number);
  state.month = Number(d.month) || 0;
  const rows = (a) => (Array.isArray(a) ? a : []).map((r) => ({ u: String(r.u), on: num(r.on) || 0, late: num(r.late) || 0 }));
  const b = d.board || {};
  state.board = { week: rows(b.week), month: rows(b.month), awards: (Array.isArray(b.awards) ? b.awards : []).map((x) => ({ u: String(x.u), at: num(x.at) || 0, label: str(x.label, 80) })) };
  state.bonuses = new Map();
  for (const x of Array.isArray(d.bonuses) ? d.bonuses : []) {
    const uid = String(x.u), list = state.bonuses.get(uid) || [];
    list.push({ id: String(x.id), at: num(x.at) || 0, amt: amount(x.amt) || 0, label: str(x.label, 80) });
    state.bonuses.set(uid, list);
  }
  const t = d.totals || {};
  state.totals = { videos: amount(t.videos) || 0, bonus: amount(t.bonus) || 0, month: amount(t.month) || 0 };
  const st = d.stats || {}, ed = new Map(), ct = new Map();
  for (const e of Array.isArray(st.editors) ? st.editors : []) {
    const w = Array.isArray(e.w) ? e.w : [], mo = Array.isArray(e.mo) ? e.mo : [], four = Array.isArray(e.four) ? e.four : [], weeks = [];
    for (let i = 0; i < 6; i++) weeks.push({ on: num(w[2 * i]) || 0, late: num(w[2 * i + 1]) || 0 });
    ed.set(String(e.u), { weeks: weeks, moOn: num(mo[0]) || 0, moLate: num(mo[1]) || 0, on4: num(four[0]) || 0, late4: num(four[1]) || 0, turn: num(four[2]) || 0 });
  }
  for (const c of Array.isArray(st.cats) ? st.cats : []) ct.set(c.cat ? String(c.cat) : "none", { on: num(c.on) || 0, late: num(c.late) || 0, lateMs: num(c.lateMs) || 0 });
  state.stats = { editors: ed, cats: ct };
  if (d.full) { state.projects = new Map(); state.horizon = typeof d.horizon === "string" ? d.horizon : null; resetHist(); }
  for (const r of Array.isArray(d.projects) ? d.projects : []) {
    const uid = String(r.u), id = String(r.id), map = state.projects.get(uid) || new Map();
    if (r.deleted) map.delete(id); else map.set(id, normProject(r));
    if (map.size) state.projects.set(uid, map); else state.projects.delete(uid);
    hist.rows.delete(id);       // the fresh copy above replaces an older page's copy
  }
  state.cursor = num(d.cursor);
  if (hadMe && wasAdmin !== state.isAdmin) { state.cursor = null; ui.view = state.isAdmin ? "admin" : "editor"; }   // a changed role changes what this login may load
}
let syncTimer = 0, syncing = null, syncAgain = false;
function plan() {
  clearTimeout(syncTimer);
  if (state.phase !== "ready") return;
  syncTimer = setTimeout(() => { if (document.hidden) plan(); else sync(); }, !state.online ? 8000 : state.isAdmin ? 20000 : 40000);
}
function sync() {       // only what changed since last time; everything again after the app has been away a while
  if (state.phase !== "ready") return Promise.resolve();
  if (syncing) { syncAgain = true; return syncing; }
  syncing = (async () => {
    const full = !state.cursor || state.wantFull;
    try {
      const d = await api("er_state", { p_token: state.token, p_since: full ? null : state.cursor });
      applyState(d);
      if (d.full) { state.lastFull = Date.now(); state.wantFull = false; }
      state.online = true;
    } catch (e) {
      if (e.code === "auth") { syncing = null; leave("You've been signed out. Sign in again."); return; }
      state.online = false;
    }
    syncing = null;
    schedule(); plan(); loadPics();
    if (syncAgain) { syncAgain = false; await sync(); }
  })();
  return syncing;
}
function saveToken(t) {
  state.token = t;
  try { if (t) localStorage.setItem("editroom.token", t); else localStorage.removeItem("editroom.token"); } catch (e) { /* stays signed in for this visit only */ }
}
async function enter(token) {
  const d = await api("er_state", { p_token: token, p_since: null });
  saveToken(token);
  state.me.id = null; state.isAdmin = false;
  applyState(d);
  state.lastFull = Date.now(); state.wantFull = false; state.online = true; state.phase = "ready";
  ui.view = state.isAdmin ? "admin" : "editor";
  try {
    const t = localStorage.getItem("editroom.tab"), e = localStorage.getItem("editroom.etab");
    if (ADMIN_TABS.some((x) => x[0] === t)) ui.tab = t;
    if (EDITOR_TABS.some((x) => x[0] === e)) ui.etab = e;
  } catch (e) { /* start on the first tab */ }
  authPanel = null;
  render(); plan(); loadPics();
}
function leave(msg) {
  saveToken(null);
  clearTimeout(syncTimer);
  state.phase = "login"; state.cursor = null; state.projects = new Map(); state.users = new Map();
  state.stats = { editors: new Map(), cats: new Map() }; state.horizon = null; resetHist();
  closeSheet(); render();
  if (msg) toast(msg, true);
}
let picBusy = false;
async function loadPics() {
  if (picBusy || state.phase !== "ready") return;
  const want = [];
  for (const u of state.users.values()) {
    const have = pics.get(u.id);
    if (u.has && (!have || have.ver !== u.av)) want.push(u.id);
    else if (!u.has && have) { pics.delete(u.id); schedule(); }
  }
  if (!want.length) return;
  picBusy = true;
  try {
    const r = (await call("er_avatars", { p_ids: want.slice(0, 24) })) || {};
    for (const id of want.slice(0, 24)) {
      const u = state.users.get(id), url = typeof r[id] === "string" && /^data:image\/(jpeg|png|webp);base64,/.test(r[id]) ? r[id] : "";
      pics.set(id, { ver: u ? u.av : 0, url: url });
    }
    schedule();
    if (want.length > 24) { picBusy = false; loadPics(); return; }
  } catch (e) { /* initials stay until the next try */ }
  picBusy = false;
}

/* ---------- reading the data ---------- */
function catOf(p) {
  const c = p.catId ? state.cats.get(p.catId) : null;
  return c ? { name: c.name, rate: c.rate, id: c.id, archived: c.archived } : { name: "No category", rate: null, id: null, archived: false };
}
const rateOf = (p) => catOf(p).rate;
function flagsOf(p) {
  const received = p.status === "submitted" && p.receivedAt != null;
  const deadline = p.due;       // fixed when the brief was logged; time waiting with the admin is added on
  const f = { received: received, receivedAt: received ? p.receivedAt : null, amt: received ? p.amount : null, deadline: deadline, graceEnd: p.graceEnd, phase: null, overBy: 0, lateBy: null, onTime: null };
  if (p.status === "active") {
    const t = now();
    f.overBy = t - deadline;
    f.phase = t <= deadline ? "ontrack" : t <= f.graceEnd ? "late" : "over";
  } else if (p.status === "submitted" && p.submittedAt) {
    f.lateBy = p.submittedAt - deadline;
    f.onTime = f.lateBy <= 0;
  }
  return f;
}
function collect() {
  const out = [];
  for (const [uid, m] of state.projects) for (const p of m.values()) out.push({ uid: uid, p: p, f: flagsOf(p) });
  return out;
}
const hasWork = (uid) => { const m = state.projects.get(uid); return (!!m && m.size > 0) || state.stats.editors.has(uid); };
function rosterIds() {      // people who edit: active editors, plus any admin who has logged work
  const ids = [];
  for (const u of state.users.values()) if (u.active && (u.role === "editor" || hasWork(u.id))) ids.push(u.id);
  return ids;
}
function displayName(uid) {
  const u = state.users.get(uid);
  return u ? u.name : uid === state.me.id ? state.me.name : "Former editor";
}
function earnedOf(uid) {
  const u = state.users.get(uid), videos = u ? u.earned : 0, bonus = u ? u.bonus : 0;
  return { videos: videos, bonus: bonus, total: videos + bonus };
}
function editorStats(uid) {      // submitted work is counted by the server; what is open right now is counted here
  const m = state.projects.get(uid), sv = state.stats.editors.get(uid), u = state.users.get(uid);
  let active = 0, lateOpen = 0, overOpen = 0;
  if (m) for (const p of m.values()) if (p.status === "active") {
    const f = flagsOf(p);
    active++;
    if (f.phase === "late") lateOpen++; else if (f.phase === "over") overOpen++;
  }
  const weeks = sv ? sv.weeks : state.weeks.map(() => ({ on: 0, late: 0 })), n4 = sv ? sv.on4 + sv.late4 : 0;
  return { uid: uid, weeks: weeks, wkOn: weeks[5].on, wkLate: weeks[5].late, moOn: sv ? sv.moOn : 0, moLate: sv ? sv.moLate : 0,
    rate: n4 ? sv.on4 / n4 : null, on4: sv ? sv.on4 : 0, avg: n4 ? sv.turn / n4 : null, last: u ? u.last : 0,
    active: active, lateOpen: lateOpen, overOpen: overOpen, moved: u ? u.moved : 0, earned: earnedOf(uid) };
}

/* ---------- shared pieces ---------- */
const pill = (kind, text) => h("span", { class: "pill" + (kind ? " " + kind : ""), text: text });
const tape = (cat) => h("span", { class: "tape", text: cat.name });
const quote = (label, text) => h("div", { class: "quote" }, h("span", { class: "quote-label", text: label }), h("p", { text: text }));
// A label with its figure under it. These sit inside a <dl>: stat on the black slate, fact on a card.
const stat = (n, label, flag) => h("div", { class: "stat" + (flag ? " flag-" + flag : "") }, h("dt", { class: "stat-label", text: label }), h("dd", { class: "stat-num" + (String(n).length > 4 ? " long" : ""), text: String(n) }));
const fact = (value, label, sub) => h("div", { class: "fact" }, h("dt", { class: "fact-label", text: label }), h("dd", { class: "fact-num", text: value }), sub ? h("dd", { class: "fact-sub", text: sub }) : null);
const empty = (title, text) => h("div", { class: "empty" }, h("strong", { text: title }), text ? h("span", { text: text }) : null);
function hero(value, rest) {      // a slate's headline figure; long amounts step down in size so they stay on one line
  const text = String(value), n = text.length;
  return h("p", { class: "slate-hero" }, h("span", { class: "week-num" + (n > 12 ? " tiny" : n > 9 ? " small" : n > 6 ? " mid" : ""), text: text }), rest || null);
}
function avatar(uid, size, urlOverride) {
  const cls = "avatar" + (size ? " " + size : ""), pic = pics.get(uid), url = urlOverride != null ? urlOverride : pic ? pic.url : "";
  if (url) return h("img", { class: cls, src: url, alt: "" });
  return h("span", { class: cls, "aria-hidden": "true", text: (displayName(uid).trim()[0] || "?") });
}
function person(uid, size) {
  return h("div", { class: "person" + (size ? " big" : "") }, avatar(uid, size), h("span", { class: "person-name", text: displayName(uid) + (uid === state.me.id ? " (you)" : "") }));
}
function meter(n, target) {
  const m = h("div", { class: "meter", role: "img", "aria-label": n + " of " + target + " submitted this week" }, h("i"));
  m.style.setProperty("--at", Math.min(100, Math.round((n / target) * 100)) + "%");
  return m;
}
function splitBar(on, late, max) {      // one thin bar: how many were on time, then how many were late
  const total = on + late, lane = h("span", { class: "split-lane", role: "img", "aria-label": on + " on time, " + late + " late" });
  if (!total) return lane;
  const bar = h("span", { class: "split" });
  bar.style.setProperty("--w", Math.max(3, Math.round((total / Math.max(max, total)) * 1000) / 10) + "%");
  for (const part of [[on, "on"], [late, "late"]]) if (part[0]) { const seg = h("i", { class: part[1] }); seg.style.setProperty("--n", String(part[0])); bar.append(seg); }
  lane.append(bar);
  return lane;
}
const legend = () => h("div", { class: "legend" }, h("span", { class: "key", text: "On time" }), h("span", { class: "key late", text: "Late" }));
function periodSeg() {
  const b = (id, label) => h("button", { type: "button", "aria-pressed": String(ui.period === id), dataset: { fk: "per:" + id }, onclick: () => { ui.period = id; ui.spark = null; schedule(); } }, label);
  return h("div", { class: "seg inline", role: "group", "aria-label": "Period" }, b("week", "This week"), b("month", "This month"));
}
function trackBlock(p, editable) {
  const track = h("div", { class: "track", role: "img", "aria-label": "Stage " + p.stage + " of 3: " + STAGES[p.stage - 1] }, h("i", { class: "track-fill" }), h("b", { class: "playhead" }));
  track.style.setProperty("--at", STAGE_AT[p.stage - 1]);
  const row = editable
    ? h("div", { class: "seg", role: "group", "aria-label": "How far along is it?" }, STAGES.map((s, i) => h("button", { type: "button", "aria-pressed": String(p.stage === i + 1), dataset: { fk: "stage:" + p.id + ":" + i }, onclick: () => { if (p.stage !== i + 1) act(null, () => run("er_set_stage", { p_project: p.id, p_stage: i + 1 })); } }, s)))
    : h("div", { class: "stage-labels", "aria-hidden": "true" }, STAGES.map((s, i) => h("span", { class: p.stage === i + 1 ? "now" : null, text: s })));
  return h("div", { class: "timeline" }, track, row);
}
function deadlinePill(x, forEditor) {
  const p = x.p, f = x.f;
  if (p.status === "active") {
    if (f.phase === "ontrack") return pill("", "Due in " + span(-f.overBy));
    if (f.phase === "late") return pill("warn", forEditor ? "Deadline passed " + span(f.overBy) + " ago" : "Past deadline by " + span(f.overBy));
    return pill("crit", "Grace over by " + span(now() - f.graceEnd));
  }
  if (p.status === "submitted" && f.onTime != null) return f.onTime ? pill("good", "On time") : pill("warn", "Late by " + span(f.lateBy));
  return null;
}
function statusPills(x, forAdmin) {
  const p = x.p, f = x.f, out = [deadlinePill(x, !forAdmin)];
  if (p.status === "submitted") out.push(f.received ? pill("good", "Received") : pill("info", forAdmin ? "Waiting for you" : "Waiting for admin"));
  else if (p.status === "reassigned") out.push(pill("", "Reassigned"));
  return out;
}
function metaRow(x, brief) {
  const p = x.p, f = x.f, items = [];
  const it = (label, value) => h("div", null, h("dt", { text: label }), h("dd", { text: value }));
  if (p.status === "active") {
    items.push(it("Started", stamp(p.startedAt)));
    items.push(it("Due", stamp(f.deadline)));
    if (f.phase !== "ontrack") items.push(it(f.phase === "over" ? "Grace ended" : "Grace ends", stamp(f.graceEnd)));
    if (p.updatedAt > p.startedAt) items.push(it("Updated", ago(p.updatedAt)));
  } else if (p.status === "submitted") {
    items.push(it("Submitted", stamp(p.submittedAt || p.updatedAt)));
    items.push(it("Was due", stamp(f.deadline)));
    if (f.received && !brief) items.push(it("Received", ago(f.receivedAt)));
  } else {
    items.push(it("Started", stamp(p.startedAt)));
    if (p.movedAt) items.push(it("Reassigned", stamp(p.movedAt)));
  }
  return h("dl", { class: "meta" }, items);
}
function parseLink(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const host = u.hostname.toLowerCase();
    if (!host.includes(".")) return null;
    return { href: u.href, host: host, google: host === "google.com" || host.endsWith(".google.com") };
  } catch (e) { return null; }
}
function readLink(text) {
  let v = String(text || "").trim();
  if (!v) return null;
  const m = v.match(/https?:\/\/[^\s<>"']+/i);
  if (m) v = m[0];
  else {
    v = v.split(/\s+/)[0];
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+([/?#].*)?$/i.test(v)) return null;
    v = "https://" + v;
  }
  return parseLink(v);
}
function linkLine(link, raw) {      // a Drive link needs no caption; anything else says where it points
  if (!link) return h("p", { class: "error", text: raw ? "The pasted link isn't a valid web address: " + raw : "No link was added." });
  return link.google ? null : h("p", { class: "linkline" }, h("span", { text: link.host }), pill("warn", "Not a Google Drive link"));
}
const openLink = (link, small, key) => h("a", { class: "btn" + (small ? " small" : " primary full"), href: link.href, target: "_blank", rel: "noopener noreferrer", dataset: { fk: "open:" + key } }, link.google ? "Open Drive link" : "Open link", icon("out", 16, 2.6));

/* ---------- keeping the app on the phone ---------- */
let installEvent = null;
const isInstalled = () => navigator.standalone === true || (typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches);
function fillInstall(box) {
  if (isInstalled()) { box.replaceChildren(); box.hidden = true; return; }
  box.hidden = false;
  if (installEvent) {
    box.replaceChildren(
      h("button", { class: "btn small", type: "button", onclick: async () => {
        const ev = installEvent;
        if (!ev) return;
        installEvent = null;
        try { ev.prompt(); await ev.userChoice; } catch (e) { /* the browser decides whether to ask */ }
        refreshInstall();
      } }, "Install " + APP + " on this phone"),
      h("span", { class: "hint", text: "It then opens from your home screen like any other app." }));
    return;
  }
  const ua = navigator.userAgent || "", apple = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  box.replaceChildren(h("span", { class: "hint", text: apple
    ? "To keep " + APP + " on your iPhone: open this page in Safari, tap the Share button, then Add to Home Screen."
    : "To keep " + APP + " on your phone: open your browser's menu and choose Install app or Add to Home screen." }));
}
function installBox() {
  const box = h("div", { class: "install", dataset: { install: "1" } });
  fillInstall(box);
  return box;
}
function refreshInstall() { for (const box of document.querySelectorAll("[data-install]")) fillInstall(box); }
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvent = e; refreshInstall(); });
window.addEventListener("appinstalled", () => { installEvent = null; refreshInstall(); });

/* ---------- signing in ---------- */
let authPanel = null;
function authView() {
  if (authPanel && authPanel.phase === state.phase) return authPanel.node;
  const err = h("p", { class: "error", role: "alert", hidden: true });
  const fail = (ex) => { err.textContent = ex instanceof Oops ? ex.message : errText(ex); err.hidden = false; };
  const head = (title, note) => h("div", { class: "slate" }, h("h2", { class: "slate-title", text: title }), h("p", { class: "slate-label", text: note }));
  let node;
  if (state.phase === "setup") {
    const code = h("input", { class: "input", id: "su-code", type: "text", autocomplete: "off", autocapitalize: "characters", spellcheck: "false" });
    const name = h("input", { class: "input", id: "su-name", type: "text", maxlength: "40", autocomplete: "name" });
    const user = h("input", { class: "input", id: "su-user", type: "text", maxlength: "24", autocomplete: "username", autocapitalize: "none", spellcheck: "false" });
    const pass = h("input", { class: "input", id: "su-pass", type: "password", autocomplete: "new-password" });
    const go = h("button", { class: "btn primary", type: "submit" }, "Create my admin login");
    node = h("section", { class: "auth" },
      head("Set up " + APP, "This creates the admin login for this app. It is done once."),
      h("div", { class: "panel" }, h("form", { class: "form", novalidate: true, oninput: () => { err.hidden = true; }, onsubmit: async (e) => {
        e.preventDefault();
        if (go.disabled) return;
        err.hidden = true; go.disabled = true;
        try {
          let tz = null;
          try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (ex) { /* the server falls back to UTC */ }
          const r = await api("er_setup", { p_code: code.value, p_name: tidy(name.value), p_username: user.value, p_password: pass.value, p_tz: tz });
          if (!r || !r.ok) throw new Oops(ERRORS[r && r.error === "bad_name" ? "bad_name_setup" : r && r.error] || "That didn't work. Try again.");
          await enter(r.token);
        } catch (ex) { fail(ex); go.disabled = false; }
      } },
        field("Setup code", code, "The one-time code you were given with the link to this app."),
        field("Your name", name),
        field("Username", user, "3 to 24 characters: small letters, numbers, dots and dashes."),
        field("Password", pass, "At least 8 characters. There is no email reset, so keep it somewhere safe."),
        err, go)),
      installBox());
  } else {
    const user = h("input", { class: "input", id: "li-user", type: "text", maxlength: "24", autocomplete: "username", autocapitalize: "none", spellcheck: "false" });
    const pass = h("input", { class: "input", id: "li-pass", type: "password", autocomplete: "current-password" });
    const go = h("button", { class: "btn primary", type: "submit" }, "Sign in");
    node = h("section", { class: "auth" },
      head("Sign in", "Use the username and password your admin gave you."),
      h("div", { class: "panel" }, h("form", { class: "form", novalidate: true, oninput: () => { err.hidden = true; }, onsubmit: async (e) => {
        e.preventDefault();
        if (go.disabled) return;
        err.hidden = true; go.disabled = true;
        try {
          const r = await api("er_login", { p_username: user.value, p_password: pass.value });
          if (!r || !r.ok) throw new Oops(ERRORS[r && r.error] || "That didn't work. Try again.");
          await enter(r.token);
        } catch (ex) { fail(ex); go.disabled = false; }
      } }, field("Username", user), field("Password", pass), err, go)),
      installBox());
  }
  authPanel = { phase: state.phase, node: node };
  return node;
}

/* ---------- editor screens ---------- */
function viewWork(all) {
  const uid = state.me.id, out = [], cfg = state.config;
  const mine = all.filter((x) => x.uid === uid);
  const active = mine.filter((x) => x.p.status === "active").sort((a, b) => a.f.deadline - b.f.deadline);
  const done = mine.filter((x) => x.p.status === "submitted").sort((a, b) => (b.p.submittedAt || 0) - (a.p.submittedAt || 0));
  const moved = mine.filter((x) => x.p.status === "reassigned").sort((a, b) => (b.p.movedAt || 0) - (a.p.movedAt || 0));

  // deadline alerts start the moment the delivery time is up
  const over = active.filter((x) => x.f.phase === "over"), late = active.filter((x) => x.f.phase === "late"), notices = [];
  if (over.length) notices.push(h("div", { class: "notice crit" },
    h("strong", { text: over.length === 1 ? "Grace period over: " + over[0].p.name : "Grace period over on " + over.length + " projects" }),
    h("span", { text: "Your admin can now reassign " + (over.length === 1 ? "this script" : "these scripts") + " to another editor. Submit as soon as you can." })));
  if (late.length) notices.push(h("div", { class: "notice warn" },
    h("strong", { text: late.length === 1 ? "Deadline passed: " + late[0].p.name : "Deadline passed on " + late.length + " projects" }),
    h("span", { text: "Submit before the grace period ends, or your admin can reassign " + (late.length === 1 ? "it." : "them.") })));
  for (const x of moved.filter((m) => !m.p.seenMoved).slice(0, 3)) notices.push(h("div", { class: "notice" },
    h("strong", { text: "Reassigned: " + x.p.name }),
    h("span", { text: "Your admin moved this script to another editor." }),
    h("button", { class: "btn small", type: "button", dataset: { fk: "ack:" + x.p.id }, onclick: (e) => act(e.currentTarget, () => run("er_ack_moved", { p_project: x.p.id })) }, "Got it")));
  if (notices.length) out.push(h("div", { class: "notices" }, notices));

  const wk = state.weeks[5], target = cfg.weeklyTarget;
  const week = done.filter((x) => (x.p.submittedAt || 0) >= wk), onTime = week.filter((x) => x.f.onTime === true).length, lateN = week.length - onTime;
  const waiting = done.filter((x) => !x.f.received).length;
  out.push(h("section", { class: "slate", "aria-label": "Your week" },
    h("p", { class: "slate-label", text: "This week, " + teamDay(wk) + " to " + teamDay(wk + 6.5 * DAY) }),
    hero(week.length, [
      h("span", { class: "week-of", text: (target ? "of " + target + " " : "") + (week.length === 1 && !target ? "video submitted" : "videos submitted") }),
      target && week.length >= target ? pill("gold", "Target hit") : null]),
    target ? meter(week.length, target) : null,
    h("dl", { class: "fields four" }, stat(onTime, "On time"), stat(lateN, "Late", lateN ? "warn" : ""), stat(active.length, "In progress"), stat(waiting, "With admin")),
    h("button", { class: "btn primary", type: "button", dataset: { fk: "log" }, onclick: () => openBrief() }, "Log a new brief")));

  out.push(h("section", { class: "section" },
    h("h2", { class: "section-title", text: "In progress" }),
    active.length ? h("div", { class: "grid" }, active.map(editorCard))
      : empty("Nothing in progress.", "Got a new brief? Log it straight away. Your " + cfg.deliveryHours + "-hour deadline starts when you log it.")));

  const shown = ui.older ? done : done.slice(0, 6);
  out.push(h("section", { class: "section" },
    h("h2", { class: "section-title", text: "Submitted" }),
    shown.length ? h("div", { class: "grid" }, shown.map(doneCard)) : empty("Nothing submitted yet.", "Finished projects show up here once you submit them with a Drive link."),
    done.length > 6 ? h("div", { class: "btn-row" }, h("button", { class: "btn small", type: "button", dataset: { fk: "older" }, onclick: () => { ui.older = !ui.older; schedule(); } }, ui.older ? "Show fewer" : "Show all " + done.length)) : null));

  if (moved.length) out.push(h("section", { class: "section" },
    h("h2", { class: "section-title", text: "Moved to another editor" }),
    h("div", { class: "grid" }, moved.slice(0, 12).map((x) => h("article", { class: "clip" },
      h("div", { class: "clip-top" }, tape(catOf(x.p)), h("span", { class: "pills" }, statusPills(x, false))),
      h("h3", { class: "clip-title", text: x.p.name }),
      metaRow(x))))));
  return out;
}
function editorCard(x) {
  const p = x.p, cat = catOf(p);
  return h("article", { class: "clip" },
    h("div", { class: "clip-top" }, tape(cat), h("span", { class: "pills" }, statusPills(x, false))),
    h("h3", { class: "clip-title", text: p.name }),
    p.from ? h("p", { class: "hint", text: "Assigned to you by your admin." }) : null,
    p.backAt ? quote("Sent back by your admin " + ago(p.backAt), p.backNote || "Check the link and submit again.") : null,
    trackBlock(p, true),
    p.update ? quote("Your last update", p.update) : null,
    metaRow(x),
    h("div", { class: "btn-row" },
      h("button", { class: "btn primary full", type: "button", dataset: { fk: "submit:" + p.id }, onclick: () => openSubmit(p) }, "Submit with Drive link"),
      h("button", { class: "btn grow", type: "button", dataset: { fk: "upd:" + p.id }, onclick: () => openUpdate(p) }, "Add update")));
}
function doneCard(x) {
  const p = x.p, f = x.f, cat = catOf(p), link = parseLink(p.link);
  const pay = f.received ? (f.amt != null ? "Earned " + money(f.amt) : "Received. Your admin hasn't set the amount yet.") : cat.rate != null ? money(cat.rate) + " once your admin marks it received" : null;
  return h("article", { class: "clip" },
    h("div", { class: "clip-top" }, tape(cat), h("span", { class: "pills" }, statusPills(x, false))),
    h("h3", { class: "clip-title", text: p.name }),
    metaRow(x, true),
    pay ? h("p", { class: "payline", text: pay }) : null,
    linkLine(link, p.link),
    link ? h("div", { class: "btn-row" }, openLink(link, true, "mine:" + p.id)) : null);
}
function viewBoard() {
  const kind = ui.period, rows = state.board[kind], me = state.me.id, out = [], hours = state.config.deliveryHours;
  const start = kind === "week" ? state.weeks[5] : state.month;
  const rank = (r) => 1 + rows.filter((o) => o.on > r.on).length;
  const won = (u) => state.board.awards.some((x) => x.u === u && x.at >= start);
  const name = (u) => displayName(u) + (u === me ? " (you)" : "");
  const top = rows.slice(0, 3), rest = rows.slice(3);
  out.push(h("section", { class: "section" },
    h("div", { class: "slate" },
      h("div", { class: "slate-head" }, h("h2", { class: "slate-title", text: "Leaderboard" }), periodSeg()),
      h("p", { class: "slate-label", text: (kind === "week" ? "Week of " + teamDay(start) : teamMonth(start)) + ". Ranked by videos submitted within the " + hours + "-hour deadline." }),
      rows.length
        ? h("ol", { class: "podium n" + top.length }, top.map((r) => h("li", { class: "podium-cell" + (rank(r) === 1 ? " first" : "") + (r.u === me ? " me" : "") },
            h("span", { class: "podium-pic" }, avatar(r.u, "xl"), h("span", { class: "rank", text: String(rank(r)) })),
            h("span", { class: "podium-name", text: name(r.u) }),
            h("span", { class: "podium-count", text: r.on + " on time" }),
            won(r.u) ? pill("gold", "Bonus") : null)))
        : h("div", { class: "slate-empty" },
            h("strong", { text: kind === "week" ? "No on-time submissions yet this week." : "No on-time submissions yet this month." }),
            h("span", { text: "Submit within " + hours + " hours of logging a brief to get on the board." }))),
    rest.length ? h("ol", { class: "rows" }, rest.map((r) => h("li", { class: "rank-row" + (r.u === me ? " me" : "") },
      h("span", { class: "rank", text: String(rank(r)) }), avatar(r.u),
      h("span", { class: "person-name", text: name(r.u) }),
      h("span", { class: "rank-count", text: r.on + " on time" }),
      won(r.u) ? pill("gold", "Bonus") : null))) : null,
    rows.length && !state.isAdmin && !rows.some((r) => r.u === me) ? h("p", { class: "hint", text: "You're not on the board yet " + (kind === "week" ? "this week." : "this month.") }) : null));
  const awards = state.board.awards.slice(0, 8);
  if (awards.length) out.push(h("section", { class: "section" },
    h("h2", { class: "section-title", text: "Bonuses awarded" }),
    h("ul", { class: "rows" }, awards.map((x) => h("li", null,
      h("div", { class: "row-main" }, person(x.u), h("span", { class: "hint", text: x.label || "Bonus" })),
      h("span", { class: "rank-count", text: shortDate(x.at) }))))));
  return out;
}
function viewEarn(all) {
  const uid = state.me.id, mine = all.filter((x) => x.uid === uid), lines = [], out = [];
  let pendSum = 0;
  for (const x of mine) if (x.f.received) lines.push({ at: x.f.receivedAt, amt: x.f.amt, title: x.p.name, sub: catOf(x.p).name + ", received " + shortDate(x.f.receivedAt) });
  for (const b of state.bonuses.get(uid) || []) lines.push({ at: b.at, amt: b.amt, title: b.label || "Bonus", bonus: true });
  lines.sort((a, b) => b.at - a.at);
  const pending = mine.filter(isWaiting).sort((a, b) => (b.p.submittedAt || 0) - (a.p.submittedAt || 0));
  for (const x of pending) pendSum += rateOf(x.p) || 0;
  const shown = ui.earnAll ? lines : lines.slice(0, 20);
  const row = (label, value) => h("div", null, h("dt", { text: label }), h("dd", { text: value }));
  out.push(h("section", { class: "slate", "aria-label": "Your earnings" },
    h("p", { class: "slate-label", text: "Total earned" }),
    hero(money(state.totals.videos + state.totals.bonus)),
    h("dl", { class: "slate-rows" }, row("This month", money(state.totals.month)), row("From bonuses", money(state.totals.bonus)), row("Waiting for admin", money(pendSum))),
    h("p", { class: "hint", text: "A video is added to your earnings when your admin marks it received." })));
  out.push(h("section", { class: "section" },
    h("h2", { class: "section-title", text: "What you earned" }),
    shown.length ? h("ul", { class: "rows" }, shown.map((l) => h("li", null,
      h("div", { class: "row-main" }, h("span", { class: "row-title", text: l.title }),
        l.bonus ? h("span", { class: "linkline" }, pill("gold", "Bonus"), shortDate(l.at)) : h("span", { class: "hint", text: l.sub })),
      h("span", { class: "amount", text: l.amt != null ? money(l.amt) : "Not set yet" }))))
      : empty("Nothing earned yet.", "Each video appears here with its amount once your admin marks it received."),
    lines.length > 20 ? h("div", { class: "btn-row" }, h("button", { class: "btn small", type: "button", dataset: { fk: "earnall" }, onclick: () => { ui.earnAll = !ui.earnAll; schedule(); } }, ui.earnAll ? "Show fewer" : "Show all " + lines.length)) : null));
  if (pending.length) out.push(h("section", { class: "section" },
    h("h2", { class: "section-title", text: "Waiting for your admin" }),
    h("ul", { class: "rows" }, pending.map((x) => { const r = rateOf(x.p); return h("li", null,
      h("div", { class: "row-main" }, h("span", { class: "row-title", text: x.p.name }), h("span", { class: "hint", text: catOf(x.p).name + ", submitted " + shortDate(x.p.submittedAt || x.p.updatedAt) })),
      h("span", { class: "amount", text: r != null ? money(r) : "Rate not set" })); }))));
  return out;
}

/* ---------- admin screens ---------- */
const isWaiting = (x) => x.p.status === "submitted" && !x.f.received;
function setupCard() {
  const hasCats = state.config.categories.length > 0;
  const editors = Array.from(state.users.values()).filter((u) => u.role === "editor").length;
  if (hasCats && editors > 0) return null;
  return h("section", { class: "panel" },
    h("h2", { class: "section-title", text: "Get your team started" }),
    h("ol", { class: "steps" },
      h("li", { class: hasCats ? "done" : null }, h("div", { class: "step-body" },
        h("span", { class: "step-title", text: "Add your video categories and what each pays" }),
        h("span", { class: "hint", text: hasCats ? "Done. Editors pick one of these for every brief." : "Editors pick a category for every brief they log. The pay rate decides what each video adds to their earnings." }),
        hasCats ? null : h("button", { class: "btn small", type: "button", dataset: { fk: "tosettings" }, onclick: () => setTab("settings") }, "Open Settings"))),
      h("li", { class: editors ? "done" : null }, h("div", { class: "step-body" },
        h("span", { class: "step-title", text: "Create a login for each editor" }),
        h("span", { class: "hint", text: editors ? "Done. " + plural(editors, "editor has", "editors have") + " a login." : "In Settings, add each editor and send them the link, username and password it gives you." }),
        editors ? null : h("button", { class: "btn small", type: "button", dataset: { fk: "toteam" }, onclick: () => setTab("settings") }, "Open Settings"))),
      h("li", null, h("div", { class: "step-body" },
        h("span", { class: "step-title", text: "Download finished work from this inbox" }),
        h("span", { class: "hint", text: "Editors log a brief when they get it and submit with a Drive link. Each submission lands here, and anything past its deadline is listed below it." })))));
}
function viewInbox(all) {
  const out = [];
  const waiting = all.filter(isWaiting).sort((a, b) => (a.p.submittedAt || 0) - (b.p.submittedAt || 0));
  const active = all.filter((x) => x.p.status === "active");
  const past = active.filter((x) => x.f.phase !== "ontrack").sort((a, b) => a.f.deadline - b.f.deadline);
  const over = past.filter((x) => x.f.phase === "over").length;
  out.push(h("section", { class: "slate", "aria-label": "At a glance" },
    hero(waiting.length, h("span", { class: "week-of", text: waiting.length === 1 ? "video ready to download" : "videos ready to download" })),
    h("dl", { class: "fields three" },
      stat(active.length, "In progress"), stat(past.length, "Past deadline", past.length ? "warn" : ""), stat(over, "Grace over", over ? "crit" : ""))));
  const setup = setupCard();
  if (setup) out.push(setup);
  out.push(h("section", { class: "section" },
    h("div", { class: "section-head" }, h("h2", { class: "section-title", text: "Ready to download" }), waiting.length > 1 ? h("p", { class: "section-note", text: "Oldest first" }) : null),
    waiting.length ? h("div", { class: "grid" }, waiting.map(inboxCard))
      : empty("Nothing waiting.", "When an editor submits a project with a Drive link, it lands here for you to download.")));
  if (past.length) out.push(h("section", { class: "section" },
    h("div", { class: "section-head" }, h("h2", { class: "section-title", text: "Past the deadline" }), past.length > 1 ? h("p", { class: "section-note", text: "Most overdue first" }) : null),
    h("div", { class: "grid" }, past.map(pastCard))));
  return out;
}
function receive(btn, uid, p) {
  return act(btn, async () => {
    const r = await run("er_receive", { p_project: p.id, p_on: true }), paid = r ? amount(r.amount) : null;
    toast(paid != null ? "Received. " + money(paid) + " added to " + displayName(uid) + "'s earnings." : "Received. No pay rate is set for this category, so no amount was added.");
  });
}
function inboxCard(x) {
  const uid = x.uid, p = x.p, cat = catOf(p), key = uid + ":" + p.id, link = parseLink(p.link);
  return h("article", { class: "clip" },
    h("div", { class: "clip-top" }, tape(cat), h("span", { class: "pills" }, deadlinePill(x, false), pill("info", "Submitted " + ago(p.submittedAt || p.updatedAt)))),
    h("h3", { class: "clip-title", text: p.name }),
    person(uid),
    p.note ? quote("Note from the editor", p.note) : null,
    metaRow(x),
    h("p", { class: "hint", text: cat.rate != null ? "Marking it received adds " + money(cat.rate) + " to their earnings." : "No pay rate is set for this category." }),
    linkLine(link, p.link),
    h("div", { class: "btn-row" },
      link ? openLink(link, false, key) : null,
      h("button", { class: "btn grow", type: "button", dataset: { fk: "recv:" + key }, onclick: (e) => receive(e.currentTarget, uid, p) }, "Mark received"),
      h("button", { class: "btn grow", type: "button", dataset: { fk: "back:" + key }, onclick: () => openSendBack(uid, p) }, "Send back")));
}
function pastCard(x) {
  const uid = x.uid, p = x.p, cat = catOf(p), key = uid + ":" + p.id;
  return h("article", { class: "clip" },
    h("div", { class: "clip-top" }, tape(cat), h("span", { class: "pills" }, statusPills(x, true))),
    h("h3", { class: "clip-title", text: p.name }),
    person(uid),
    trackBlock(p, false),
    p.update ? quote("Latest update", p.update) : null,
    metaRow(x),
    h("div", { class: "btn-row" }, h("button", { class: "btn grow", type: "button", dataset: { fk: "re:" + key }, onclick: () => openReassign(uid, p) }, "Reassign")));
}
function adminCard(x) {
  const uid = x.uid, p = x.p, f = x.f, cat = catOf(p), key = uid + ":" + p.id, link = parseLink(p.link), open = ui.manage === key;
  const tools = [];
  if (p.status === "active") tools.push(h("button", { class: "btn small", type: "button", dataset: { fk: "re:" + key }, onclick: () => openReassign(uid, p) }, "Reassign"));
  if (isWaiting(x)) tools.push(h("button", { class: "btn small", type: "button", dataset: { fk: "back:" + key }, onclick: () => openSendBack(uid, p) }, "Send back"));
  if (f.received) tools.push(h("button", { class: "btn small", type: "button", dataset: { fk: "amt:" + key }, onclick: () => openAmount(uid, p, f.amt) }, "Change amount"));
  if (f.received) tools.push(h("button", { class: "btn small", type: "button", dataset: { fk: "unrecv:" + key }, onclick: (e) => act(e.currentTarget, () => run("er_receive", { p_project: p.id, p_on: false }), "Moved back to the inbox") }, "Undo received"));
  tools.push(h("button", { class: "btn small", type: "button", dataset: { fk: "del:" + key }, onclick: () => openDelete(uid, p) }, "Delete"));
  return h("article", { class: "clip" },
    h("div", { class: "clip-top" }, tape(cat), h("span", { class: "pills" }, statusPills(x, true))),
    h("h3", { class: "clip-title", text: p.name }),
    person(uid),
    p.from ? h("p", { class: "hint", text: "Reassigned from " + displayName(p.from) }) : null,
    p.status === "reassigned" && p.movedTo ? h("p", { class: "hint", text: "Now with " + displayName(p.movedTo) }) : null,
    p.status === "active" && p.backAt ? quote("Sent back " + ago(p.backAt), p.backNote || "No reason given.") : null,
    p.status === "active" ? trackBlock(p, false) : null,
    p.status === "active" && p.update ? quote("Latest update", p.update) : null,
    p.status === "submitted" && p.note ? quote("Note from the editor", p.note) : null,
    metaRow(x),
    f.received ? h("p", { class: "payline", text: f.amt != null ? "Paid into earnings: " + money(f.amt) : "No amount set for this video." }) : null,
    p.status === "submitted" ? linkLine(link, p.link) : null,
    h("div", { class: "btn-row" },
      p.status === "submitted" && link ? openLink(link, true, key) : null,
      isWaiting(x) ? h("button", { class: "btn small", type: "button", dataset: { fk: "recv:" + key }, onclick: (e) => receive(e.currentTarget, uid, p) }, "Mark received") : null,
      h("button", { class: "btn small", type: "button", "aria-expanded": String(open), dataset: { fk: "mg:" + key }, onclick: () => { ui.manage = open ? null : key; schedule(); } }, open ? "Hide options" : "Manage")),
    open ? h("div", { class: "btn-row tools" }, tools) : null);
}

let projPanel = null;
function projectsPanel() {
  if (projPanel) return projPanel;
  const mk = (id, label, key) => {
    const sel = h("select", { class: "input", id: id, onchange: (e) => { ui[key] = e.target.value; ui.limit = 40; schedule(); } });
    return { sel: sel, node: h("div", { class: "field" }, h("label", { for: id, text: label }), sel) };
  };
  const a = mk("f-status", "Status", "fStatus"), b = mk("f-editor", "Editor", "fEditor"), c = mk("f-cat", "Category", "fCat");
  const head = h("section", { class: "slate", "aria-label": "Deadlines over the last 10 weeks" });
  const count = h("p", { class: "section-note" }), list = h("div", { class: "grid" }), more = h("div", { class: "btn-row" }), sum = h("ul", { class: "rows" });
  projPanel = {
    node: h("div", { class: "stack" },
      head,
      h("section", { class: "section" },
        h("div", { class: "section-head" }, h("h2", { class: "section-title", text: "Deadlines by category" }), legend()),
        sum),
      h("section", { class: "section", id: "p-list" },
        h("div", { class: "section-head" }, h("h2", { class: "section-title", text: "Projects" }), count),
        h("div", { class: "filters" }, a.node, b.node, c.node), list, more)),
    head: head, status: a.sel, editor: b.sel, cat: c.sel, count: count, list: list, more: more, sum: sum,
  };
  return projPanel;
}
function syncSelect(sel, items, value) {
  if (document.activeElement === sel) return true;
  const sig = items.map((it) => it[0] + "\u0001" + it[1]).join("\u0002");
  if (sel.dataset.sig !== sig) { sel.dataset.sig = sig; sel.replaceChildren.apply(sel, items.map((it) => h("option", { value: it[0], text: it[1] }))); }
  sel.value = value;
  return sel.value === value;
}
function catSummary(all) {      // on time and late come from the server (last 70 days); past deadline right now is counted here
  const groups = new Map();
  const group = (key) => {
    if (!groups.has(key)) { const c = key === "none" ? null : state.cats.get(key); groups.set(key, { id: key, name: c ? c.name : "No category", on: 0, late: 0, lateSum: 0, open: 0, openMax: 0 }); }
    return groups.get(key);
  };
  for (const c of state.config.categories) group(c.id);
  for (const [key, v] of state.stats.cats) { const g = group(key); g.on = v.on; g.late = v.late; g.lateSum = v.lateMs; }
  for (const x of all) if (x.p.status === "active" && x.f.phase !== "ontrack") { const g = group(catOf(x.p).id || "none"); g.open++; g.openMax = Math.max(g.openMax, x.f.overBy); }
  return Array.from(groups.values());
}
const HISTORY = { ontime: 1, sublate: 1, received: 1, reassigned: 1, all: 1 };      // lists that reach back past the loaded projects
async function loadOlder() {
  if (hist.busy || !hist.more) return;
  const key = hist.key;
  hist.busy = true; hist.failed = false;
  try {
    const r = await call("er_history", {
      p_before: hist.next ? hist.next.at : state.horizon, p_before_id: hist.next ? hist.next.id : null, p_status: ui.fStatus,
      p_editor: ui.fEditor === "all" ? null : ui.fEditor, p_category: ui.fCat === "all" || ui.fCat === "none" ? null : ui.fCat, p_uncat: ui.fCat === "none" });
    if (hist.key !== key) return;       // the filters changed while this was on its way
    for (const row of Array.isArray(r && r.rows) ? r.rows : []) hist.rows.set(String(row.id), { uid: String(row.u), p: normProject(row) });
    hist.next = r && r.next && typeof r.next.at === "string" && r.next.id ? { at: r.next.at, id: String(r.next.id) } : null;
    hist.more = !!hist.next;
  } catch (e) {
    if (hist.key === key) hist.failed = true;
  }
  if (hist.key === key) { hist.busy = false; schedule(); }
}
function fillProjects(all) {
  const P = projectsPanel(), groups = catSummary(all);
  const tot = { on: 0, late: 0, lateSum: 0, open: 0 };
  let most = 1;
  for (const g of groups) { tot.on += g.on; tot.late += g.late; tot.lateSum += g.lateSum; tot.open += g.open; most = Math.max(most, g.on + g.late); }
  const sent = tot.on + tot.late;
  P.head.replaceChildren(
    h("p", { class: "slate-label", text: "Last 10 weeks, all categories" }),
    hero(tot.on, h("span", { class: "week-of", text: (sent ? "of " + sent + " " : "") + (sent === 1 ? "video" : "videos") + " submitted on time" })),
    sent ? splitBar(tot.on, tot.late, sent) : null,
    h("dl", { class: "fields three" },
      stat(tot.late, "Late", tot.late ? "warn" : ""), stat(tot.late ? span(tot.lateSum / tot.late) : "–", "Average delay"), stat(tot.open, "Past deadline", tot.open ? "warn" : "")));
  // a small table: one row per category, its bar under the name, the three counts in columns
  const num = (n, flag) => h("span", { class: "cat-n" + (n ? (flag ? " flag" : "") : " zero"), text: String(n) });
  P.sum.replaceChildren.apply(P.sum, groups.length ? [h("li", { class: "cat-head", "aria-hidden": "true" },
    h("span"), h("span", { text: "On time" }), h("span", { text: "Late" }), h("span", { text: "Past deadline" }), h("span"))].concat(groups.map((g) => {
    const lateBy = g.late ? span(g.lateSum / g.late) : "", openBy = g.open ? span(g.openMax) : "", notes = [];
    if (g.late) notes.push("Late by " + lateBy + " on average.");
    if (g.open) notes.push("Up to " + openBy + " past the deadline now.");
    return h("li", { class: "cat-row" }, h("button", { class: "cat-btn", type: "button", dataset: { fk: "cat:" + g.id },
      "aria-label": g.name + ": " + g.on + " on time, " + g.late + " late" + (g.late ? " by " + lateBy + " on average" : "") + ", " + g.open + " past deadline" + (g.open ? " by up to " + openBy : "") + ". Show its projects.",
      onclick: () => { ui.fCat = g.id; ui.fStatus = "all"; ui.limit = 40; schedule(); const el = $("p-list"); if (el && el.scrollIntoView) el.scrollIntoView({ block: "start" }); } },
      h("span", { class: "cat-name", text: g.name }), num(g.on), num(g.late), num(g.open, true), icon("next", 16, 2.6),
      g.on + g.late ? splitBar(g.on, g.late, most) : null,
      notes.length ? h("span", { class: "cat-note", text: notes.join(" ") }) : null));
  })) : [h("li", { class: "rows-empty", text: "Add categories in Settings to see how each one is doing." })]);
  const catItems = [["all", "All categories"]];
  for (const g of groups) catItems.push([g.id, g.name]);
  syncSelect(P.status, STATUS_FILTERS, ui.fStatus);
  if (!syncSelect(P.editor, [["all", "All editors"]].concat(Array.from(state.users.values()).filter((u) => u.role === "editor" || hasWork(u.id)).map((u) => [u.id, u.name + (u.active ? "" : " (switched off)")])), ui.fEditor)) { ui.fEditor = "all"; P.editor.value = "all"; }
  if (!syncSelect(P.cat, catItems, ui.fCat)) { ui.fCat = "all"; P.cat.value = "all"; }
  const s = ui.fStatus, key = s + "|" + ui.fEditor + "|" + ui.fCat;
  if (hist.key !== key) { resetHist(); hist.key = key; hist.more = !!HISTORY[s] && !!state.horizon; }
  const merged = new Map();        // what is loaded comes first; older pages fill in behind it
  for (const x of all) merged.set(x.p.id, x);
  for (const [id, v] of hist.rows) if (!merged.has(id)) merged.set(id, { uid: v.uid, p: v.p, f: flagsOf(v.p) });
  const rows = Array.from(merged.values()).filter((x) => {
    if (s === "active" && x.p.status !== "active") return false;
    if (s === "late" && !(x.p.status === "active" && x.f.phase !== "ontrack")) return false;
    if (s === "over" && x.f.phase !== "over") return false;
    if (s === "waiting" && !isWaiting(x)) return false;
    if (s === "ontime" && x.f.onTime !== true) return false;
    if (s === "sublate" && x.f.onTime !== false) return false;
    if (s === "received" && !x.f.received) return false;
    if (s === "reassigned" && x.p.status !== "reassigned") return false;
    if (ui.fEditor !== "all" && x.uid !== ui.fEditor) return false;
    if (ui.fCat !== "all" && (catOf(x.p).id || "none") !== ui.fCat) return false;
    return true;
  });
  let order = "";
  if (s === "active") { rows.sort((a, b) => a.f.deadline - b.f.deadline); order = "soonest deadline first"; }
  else if (s === "late" || s === "over") { rows.sort((a, b) => a.f.deadline - b.f.deadline); order = "most overdue first"; }
  else rows.sort((a, b) => b.p.touched - a.p.touched || (a.p.id < b.p.id ? 1 : -1));
  // keep one screenful ahead: fetch the next older page whenever the list on screen is not full
  if (hist.more && !hist.busy && !hist.failed && rows.length <= ui.limit) loadOlder();
  const open = hist.more || hist.busy;
  P.count.textContent = (open ? rows.length + "+ projects" : plural(rows.length, "project", "projects")) + (order && rows.length > 1 ? ", " + order : "");
  const shown = rows.slice(0, ui.limit);
  P.list.replaceChildren.apply(P.list, shown.length ? shown.map(adminCard)
    : [hist.busy ? empty("Looking through older projects…") : empty("No projects match these filters.", all.length ? "Try a different status, editor or category." : "Projects appear here as soon as an editor logs a brief.")]);
  const foot = [];
  if (hist.failed) {
    foot.push(h("span", { class: "hint", text: "Older projects couldn't be loaded." }));
    foot.push(h("button", { class: "btn small", type: "button", dataset: { fk: "older" }, onclick: () => { hist.failed = false; schedule(); } }, "Try again"));
  } else if (rows.length > shown.length || hist.more) {
    foot.push(h("button", { class: "btn small", type: "button", dataset: { fk: "more" }, onclick: () => { ui.limit += 40; schedule(); } }, "Show more"));
  } else if (hist.busy && shown.length) foot.push(h("span", { class: "hint", text: "Loading older projects…" }));
  P.more.replaceChildren.apply(P.more, foot);
}

function viewEditors() {
  const ids = rosterIds(), target = state.config.weeklyTarget, win = windows(), per = ui.period, hours = state.config.deliveryHours;
  if (!ids.length) return [h("section", { class: "section" }, h("h2", { class: "section-title", text: "Editors" }),
    empty("No editors yet.", "Create a login for each editor in Settings. They appear here as soon as they have one."))];
  const on = per === "week" ? "wkOn" : "moOn", late = per === "week" ? "wkLate" : "moLate";
  const rows = ids.map((uid) => editorStats(uid)).sort((a, b) => b[on] - a[on] || a[late] - b[late] || b.on4 - a.on4 || (a.uid < b.uid ? -1 : 1));
  const sum = { on: 0, late: 0, active: 0, past: 0 };
  let peak = 1;
  for (const s of rows) {
    sum.on += s[on]; sum.late += s[late]; sum.active += s.active; sum.past += s.lateOpen + s.overOpen;
    for (const w of s.weeks) peak = Math.max(peak, w.on + w.late);
  }
  return [
    h("section", { class: "slate", "aria-label": "The team" },
      h("div", { class: "slate-head" }, h("p", { class: "slate-label", text: per === "week" ? "The team, week of " + teamDay(win.weeks[5]) : "The team, " + teamMonth(win.month) }), periodSeg()),
      hero(sum.on, h("span", { class: "week-of", text: (sum.on === 1 ? "video" : "videos") + " submitted on time" })),
      h("dl", { class: "fields three" },
        stat(sum.late, "Late", sum.late ? "warn" : ""), stat(sum.active, "In progress"), stat(sum.past, "Past deadline", sum.past ? "warn" : ""))),
    h("section", { class: "section" },
      h("p", { class: "section-note", text: "Top performers first, ranked by videos submitted within the " + hours + "-hour deadline " + (per === "week" ? "this week." : "this month.") + " This is the order editors see on their leaderboard." }),
      h("div", { class: "chart-key" }, h("span", { class: "hint", text: "Weekly bars, one scale for everyone" }), legend()),
      h("div", { class: "grid" }, rows.map((s) => rosterCard(s, win, target, s[on] > 0 ? 1 + rows.filter((o) => o[on] > s[on]).length : 0, peak))))];
}
function sparkNode(s, weekStartsList, max) {      // max is the busiest week of anyone on the team
  const H = 50, sel = ui.spark && ui.spark.uid === s.uid ? ui.spark.i : -1;
  const box = h("div", { class: "spark" + (sel >= 0 ? " picked" : ""), role: "group", "aria-label": "Videos submitted per week, last 6 weeks" });
  s.weeks.forEach((w, i) => {
    const total = w.on + w.late;
    const label = "Week of " + teamDay(weekStartsList[i]) + ": " + plural(total, "video", "videos") + " submitted, " + w.on + " on time, " + w.late + " late";
    const bar = h("button", { class: "bar", type: "button", "aria-pressed": String(sel === i), "aria-label": label, title: label, dataset: { fk: "bar:" + s.uid + ":" + i }, onclick: () => { ui.spark = sel === i ? null : { uid: s.uid, i: i }; schedule(); } });
    if (total) {
      const gap = w.on && w.late ? 2 : 0, full = Math.max(gap + 6, Math.round((total / max) * H));
      const onH = w.on ? (w.late ? Math.max(3, Math.round(((full - gap) * w.on) / total)) : full) : 0;
      if (w.on) { const seg = h("i", { class: "on" }); seg.style.height = onH + "px"; bar.append(seg); }
      if (w.late) { const seg = h("i", { class: "late" }); seg.style.height = Math.max(3, full - gap - onH) + "px"; bar.append(seg); }
    }
    box.append(bar);
  });
  const w = sel >= 0 ? s.weeks[sel] : null;
  return h("div", { class: "chart" },
    h("div", { class: "plot" },
      box,
      h("div", { class: "axis", "aria-hidden": "true" }, h("span", { text: "Week of " + teamDay(weekStartsList[0]) }), h("span", { text: "This week" }))),
    w ? h("p", { class: "readout" }, h("b", { text: plural(w.on + w.late, "video", "videos") }), " in the week of " + teamDay(weekStartsList[sel]) + ": " + w.on + " on time, " + w.late + " late.")
      : h("p", { class: "readout", text: "Videos submitted each week. Tap a bar for that week's numbers." }));
}
function rosterCard(s, win, target, rank, peak) {
  const per = ui.period, on = per === "week" ? s.wkOn : s.moOn, late = per === "week" ? s.wkLate : s.moLate;
  const since = per === "week" ? win.weeks[5] : win.month, bonuses = state.bonuses.get(s.uid) || [];
  const chips = [], quiet = s.last ? Math.floor((now() - s.last) / DAY) : null;
  if (bonuses.some((b) => b.at >= since)) chips.push(pill("gold", per === "week" ? "Bonus this week" : "Bonus this month"));
  if (s.overOpen) chips.push(pill("crit", s.overOpen + " grace over"));
  if (s.lateOpen) chips.push(pill("warn", s.lateOpen + " past deadline"));
  if (quiet != null && quiet >= 7) chips.push(pill("", "Quiet for " + quiet + " days"));
  if (!s.last) chips.push(pill("", "No activity yet"));
  if (s.moved) chips.push(pill("", s.moved + " reassigned away"));
  const week = s.wkOn + s.wkLate;
  return h("article", { class: "clip" },
    h("div", { class: "clip-top" }, h("div", { class: "ranked" }, rank ? h("span", { class: "rank" + (rank === 1 ? " first" : ""), text: String(rank) }) : null, person(s.uid, "lg")), chips.length ? h("span", { class: "pills" }, chips) : null),
    h("div", { class: "week" },
      h("p", { class: "week-line" }, h("span", { class: "fact-num", text: String(on) }), h("span", { class: "hint", text: "on time " + (per === "week" ? "this week" : "this month") + (late ? ", " + late + " late" : "") })),
      target && per === "week" ? meter(week, target) : null,
      target && per === "week" ? h("p", { class: "hint", text: week + " of " + target + " submitted against the weekly target." }) : null),
    s.weeks.some((w) => w.on + w.late > 0) ? sparkNode(s, win.weeks, peak) : h("p", { class: "hint", text: "Nothing submitted in the last 6 weeks." }),
    h("dl", { class: "facts" },
      fact(String(s.active), "In progress"), fact(s.rate != null ? Math.round(s.rate * 100) + "%" : "–", "On time, last 4 weeks"),
      fact(s.avg != null ? span(s.avg) : "–", "Average turnaround"), fact(money(s.earned.total), "Earned in total", s.earned.bonus ? "includes " + money(s.earned.bonus) + " in bonuses" : null)),
    s.last ? h("p", { class: "hint", text: "Last active " + ago(s.last) + "." }) : null,
    h("div", { class: "btn-row" },
      h("button", { class: "btn small", type: "button", dataset: { fk: "view:" + s.uid }, onclick: () => { ui.fEditor = s.uid; ui.fStatus = "all"; ui.fCat = "all"; ui.limit = 40; setTab("projects"); } }, "View projects"),
      h("button", { class: "btn small", type: "button", dataset: { fk: "bonus:" + s.uid }, onclick: () => openBonuses(s.uid) }, "Bonuses")));
}

let setPanel = null;
function settingsPanel() {
  if (setPanel) return setPanel;
  const teamList = h("ul", { class: "rows" }), list = h("ul", { class: "rows" });
  const input = h("input", { class: "input", id: "cat-new", type: "text", maxlength: "40", autocomplete: "off", placeholder: "New category name", "aria-label": "New category name" });
  const rate = h("input", { class: "input narrow", id: "cat-rate", type: "text", inputmode: "decimal", autocomplete: "off", placeholder: "Pay per video", "aria-label": "Pay per video" });
  const addBtn = h("button", { class: "btn primary", type: "submit" }, "Add");
  const form = h("form", { class: "inline-form", novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    const name = tidy(input.value), raw = rate.value.trim(), pay = raw ? parseAmount(raw) : null;
    if (!name) { input.focus(); return; }
    if (raw && pay == null) { toast("Enter the pay as a number, or leave it empty.", true); return; }
    addBtn.disabled = true;
    try { await run("er_save_category", { p_id: null, p_name: name, p_rate: pay }); input.value = ""; rate.value = ""; toast("Category added"); }
    catch (ex) { toast(ex.code === "taken" ? "That category is already on the list." : errText(ex), true); }
    addBtn.disabled = false;
  } }, input, rate, addBtn);
  const numField = (id, min, max) => h("input", { class: "input", id: id, type: "number", min: String(min), max: String(max), step: "1", inputmode: "numeric" });
  const delivery = numField("set-delivery", 1, 720), grace = numField("set-grace", 0, 720), target = numField("set-target", 1, 999);
  target.setAttribute("placeholder", "No target");
  const currency = h("input", { class: "input", id: "set-currency", type: "text", maxlength: "6", autocomplete: "off", placeholder: "₦" });
  const bonus = h("input", { class: "input", id: "set-bonus", type: "text", inputmode: "decimal", autocomplete: "off", placeholder: "No default" });
  const save = async () => {
    const d = Math.round(Number(delivery.value)), g = Math.round(Number(grace.value)), t = target.value.trim() === "" ? null : Math.round(Number(target.value));
    const cur = currency.value.trim(), rawB = bonus.value.trim(), b = rawB ? parseAmount(rawB) : null;
    if (!(d >= 1 && d <= 720)) { toast("Enter a delivery time between 1 and 720 hours.", true); return; }
    if (!(g >= 0 && g <= 720) || grace.value.trim() === "") { toast("Enter a grace period between 0 and 720 hours.", true); return; }
    if (t != null && !(t >= 1 && t <= 999)) { toast("Enter a weekly target between 1 and 999, or leave it empty.", true); return; }
    if (rawB && b == null) { toast("Enter the bonus as a number, or leave it empty.", true); return; }
    const c = state.config;
    if (d === c.deliveryHours && g === c.graceHours && t === c.weeklyTarget && cur === c.currency && b === state.prefs.bonusAmount) return;
    try { await run("er_save_settings", { p_delivery: d, p_grace: g, p_target: t, p_currency: cur, p_bonus: b }); toast("Saved"); }
    catch (ex) { toast(errText(ex), true); }
  };
  for (const el of [delivery, grace, target, currency, bonus]) el.addEventListener("change", save);
  const tryBox = h("section", { class: "section" },
    h("h2", { class: "section-title", text: "Try the editor screen" }),
    h("div", { class: "panel" },
      h("p", null, "See what your editors see, including their leaderboard and earnings. Anything you log there is saved under your name, and you can delete it from Projects afterwards."),
      h("div", { class: "btn-row" }, h("button", { class: "btn", type: "button", id: "try-editor", onclick: () => { ui.view = "editor"; ui.etab = "work"; window.scrollTo(0, 0); schedule(); } }, "Open the editor screen"))));
  setPanel = {
    node: h("div", { class: "stack" },
      h("section", { class: "section" },
        h("div", { class: "section-head" }, h("h2", { class: "section-title", text: "Team logins" }), h("button", { class: "btn small primary", type: "button", id: "add-user", onclick: () => openAddUser() }, "Add an editor")),
        h("p", { class: "section-note", text: "Each person signs in with the username and password you give them." }),
        teamList),
      h("section", { class: "section" },
        h("h2", { class: "section-title", text: "Video categories and pay" }),
        h("p", { class: "section-note", text: "Editors pick a category for every brief. Its pay is added to their earnings when you mark the video received." }),
        list, form),
      h("section", { class: "section" },
        h("h2", { class: "section-title", text: "Deadlines" }),
        h("div", { class: "panel" },
          h("div", { class: "field-grid" },
            h("div", { class: "field" }, h("label", { for: "set-delivery", text: "Delivery time (hours)" }), delivery, h("p", { class: "hint", text: "Counted from the moment an editor logs a brief. Alerts start when it runs out." })),
            h("div", { class: "field" }, h("label", { for: "set-grace", text: "Grace period (hours)" }), grace, h("p", { class: "hint", text: "When this also runs out, the project is flagged for you to reassign." }))),
          h("p", { class: "hint", text: "A change applies to briefs logged from then on. Briefs already logged keep the deadline they started with." }))),
      h("section", { class: "section" },
        h("h2", { class: "section-title", text: "Pay and targets" }),
        h("div", { class: "panel" },
          h("div", { class: "field-grid" },
            h("div", { class: "field" }, h("label", { for: "set-currency", text: "Currency symbol" }), currency),
            h("div", { class: "field" }, h("label", { for: "set-bonus", text: "Usual bonus amount" }), bonus, h("p", { class: "hint", text: "Filled in for you when you award a bonus. Only admins see it." })),
            h("div", { class: "field" }, h("label", { for: "set-target", text: "Weekly target per editor (videos)" }), target, h("p", { class: "hint", text: "Optional. Weeks run Monday to Sunday." }))))),
      tryBox),
    teamList: teamList, list: list, delivery: delivery, grace: grace, target: target, currency: currency, bonus: bonus,
  };
  return setPanel;
}
function teamRow(u) {
  const me = state.me, manage = u.id !== me.id && !u.owner && (u.role !== "admin" || me.owner);
  return h("li", null,
    h("div", { class: "row-main" },
      h("div", { class: "row-head" }, person(u.id), u.owner ? pill("info", "Owner") : u.role === "admin" ? pill("info", "Admin") : null, u.active ? null : pill("warn", "Switched off")),
      h("span", { class: "hint", text: "@" + u.username + (u.seen ? ", last seen " + ago(u.seen) : ", hasn't signed in yet") })),
    manage ? h("div", { class: "row-actions" }, h("button", { class: "btn small", type: "button", dataset: { fk: "user:" + u.id }, onclick: () => openUser(u.id) }, "Manage")) : null);
}
function fillSettings() {
  const S = settingsPanel(), cfg = state.config, cats = cfg.categories;
  S.teamList.replaceChildren.apply(S.teamList, Array.from(state.users.values()).map(teamRow));
  S.list.replaceChildren.apply(S.list, cats.length ? cats.map((c) => h("li", null,
    h("div", { class: "row-main" }, h("span", { class: "tape", text: c.name }),
      h("span", { class: "hint", text: c.rate != null ? money(c.rate) + " per video" : "No pay rate set" })),
    h("div", { class: "row-actions" }, h("button", { class: "btn small", type: "button", dataset: { fk: "catedit:" + c.id }, onclick: () => openCat(c) }, "Edit"))))
    : [h("li", { class: "rows-empty", text: "No categories yet. Add your first one below." })]);
  const put = (el, v) => { if (document.activeElement !== el) el.value = v; };
  put(S.delivery, String(cfg.deliveryHours)); put(S.grace, String(cfg.graceHours));
  put(S.target, cfg.weeklyTarget == null ? "" : String(cfg.weeklyTarget));
  put(S.currency, cfg.currency);
  put(S.bonus, state.prefs.bonusAmount == null ? "" : String(state.prefs.bonusAmount));
}

/* ---------- dialogs ---------- */
const sheet = $("sheet");
let returnEl = null, returnKey = null;
function openSheet(title, nodes) {
  if (!sheet.open) {
    const a = document.activeElement;
    returnEl = a && a !== document.body ? a : null;
    returnKey = returnEl && returnEl.dataset ? returnEl.dataset.fk || null : null;
  }
  $("sheet-title").textContent = title;
  $("sheet-content").replaceChildren.apply($("sheet-content"), nodes);
  if (!sheet.open) { try { sheet.showModal(); } catch (e) { sheet.setAttribute("open", ""); } }
  seatToast();
  const first = sheet.querySelector("input:not([type=radio]):not([type=file]), select, textarea") || sheet.querySelector("input, button");
  if (first) first.focus();
}
function sheetClosed() {
  if (sheet.open) return;        // another sheet was opened straight after this one closed
  seatToast();
  $("sheet-content").replaceChildren();
  let el = returnEl && returnEl.isConnected ? returnEl : null;
  if (!el && returnKey) el = document.querySelector('[data-fk="' + esc(returnKey) + '"]');
  if (el) el.focus({ preventScroll: true });
  returnEl = null; returnKey = null;
}
function closeSheet() {
  if (!sheet.open) return;
  try { sheet.close(); } catch (e) { sheet.removeAttribute("open"); sheetClosed(); }
}
sheet.addEventListener("close", sheetClosed);
sheet.addEventListener("click", (e) => { if (e.target === sheet) closeSheet(); });

function formSheet(o) {
  const err = h("p", { class: "error", role: "alert", hidden: true });
  const go = o.submit ? h("button", { class: "btn grow " + (o.danger ? "danger" : "primary"), type: "submit" }, o.submit) : null;
  let busy = false;
  const form = h("form", { class: "form", novalidate: true, oninput: () => { err.hidden = true; }, onsubmit: async (e) => {
    e.preventDefault();
    if (busy || !go) return;
    busy = true; go.disabled = true; err.hidden = true;
    try {
      const msg = await o.run();
      if (typeof msg === "function") msg();        // the next sheet takes over
      else { closeSheet(); if (msg) toast(msg); }
    } catch (ex) { err.textContent = ex instanceof Oops ? ex.message : errText(ex); err.hidden = false; go.disabled = false; }
    busy = false;
  } }, o.body, err, h("div", { class: "btn-row" }, go, h("button", { class: "btn grow", type: "button", onclick: closeSheet }, go ? "Cancel" : "Close")), o.foot || null);
  openSheet(o.title, [form]);
}
const field = (label, control, hint) => h("div", { class: "field" }, h("label", { for: control.id, text: label }), control, hint ? h("p", { class: "hint", text: hint }) : null);
const moneyLabel = (label) => label + (state.config.currency ? " (" + state.config.currency + ")" : "");

function openBrief() {
  const cats = state.config.categories, hours = state.config.deliveryHours;
  const name = h("input", { class: "input", id: "b-name", type: "text", maxlength: "120", autocomplete: "off" });
  const cat = h("select", { class: "input", id: "b-cat" }, h("option", { value: "", text: cats.length ? "Choose a category" : "No categories yet" }), cats.map((c) => h("option", { value: c.id, text: c.name })));
  formSheet({
    title: "Log a new brief", submit: "Log brief",
    body: [
      field("Project name", name, "Use the script or video title from your brief."),
      field("Category", cat, cats.length ? null : "Your admin hasn't added categories yet. You can still log the brief."),
      h("p", { class: "warnline", text: "Your " + hours + "-hour deadline starts as soon as you log it. Check the name and category first: they can't be changed afterwards." })],
    run: async () => {
      const n = tidy(name.value);
      if (!n) throw new Oops("Enter the project name.");
      if (cats.length && !cat.value) throw new Oops("Choose a category.");
      await run("er_log_brief", { p_name: n, p_category: cat.value || null });
      return "Brief logged. Your " + hours + "-hour deadline has started.";
    },
  });
}
function openSubmit(p) {
  const link = h("input", { class: "input", id: "s-link", type: "url", inputmode: "url", autocomplete: "off", autocapitalize: "off", spellcheck: "false", placeholder: "https://drive.google.com/…" });
  const warn = h("p", { class: "warnline", hidden: true, text: "This doesn't look like a Google Drive link. You can still send it." });
  const note = h("textarea", { class: "input", id: "s-note", maxlength: "300", rows: "3" });
  link.addEventListener("input", () => { const r = readLink(link.value); warn.hidden = !(r && !r.google); });
  formSheet({
    title: "Submit project", submit: "Submit project",
    body: [
      h("p", null, h("strong", { text: p.name })),
      field("Google Drive link", link, "Paste the share link to the finished video, and check that your admin has access to the file. The link can't be changed after you submit."),
      warn,
      field("Note for your admin (optional)", note)],
    run: async () => {
      const r = readLink(link.value);
      if (!r) throw new Oops("Paste the full Google Drive link to your finished video.");
      await run("er_submit", { p_project: p.id, p_link: r.href, p_note: note.value.trim() });
      return "Submitted. It's now in your admin's inbox.";
    },
  });
}
function openUpdate(p) {
  const text = h("textarea", { class: "input", id: "u-text", maxlength: "200", rows: "3" });
  formSheet({
    title: "Add an update", submit: "Save update",
    body: [h("p", null, h("strong", { text: p.name })), field("What's the latest?", text, "A short line your admin will see, such as what you're waiting on or when you expect to finish.")],
    run: async () => {
      const v = tidy(text.value);
      if (!v) throw new Oops("Write a short update first.");
      await run("er_add_update", { p_project: p.id, p_text: v });
      return "Update saved";
    },
  });
}
function openCat(c) {
  const input = h("input", { class: "input", id: "c-name", type: "text", maxlength: "40", autocomplete: "off" });
  const rate = h("input", { class: "input", id: "c-rate", type: "text", inputmode: "decimal", autocomplete: "off", placeholder: "No pay rate" });
  input.value = c.name;
  if (c.rate != null) rate.value = String(c.rate);
  formSheet({
    title: "Edit category", submit: "Save",
    body: [
      field("Category name", input, "Projects already logged under it show the new name."),
      field(moneyLabel("Pay per video"), rate, "Used from now on. Videos you already marked received keep the amount they were given.")],
    foot: h("div", { class: "btn-row tools" }, h("button", { class: "btn small", type: "button", onclick: () => openRemoveCat(c) }, "Remove category")),
    run: async () => {
      const v = tidy(input.value), raw = rate.value.trim(), pay = raw ? parseAmount(raw) : null;
      if (!v) throw new Oops("Enter a name.");
      if (raw && pay == null) throw new Oops("Enter the pay as a number, or leave it empty.");
      try { await run("er_save_category", { p_id: c.id, p_name: v, p_rate: pay }); }
      catch (ex) { if (ex.code === "taken") throw new Oops("Another category already has that name."); throw ex; }
      return "Category saved";
    },
  });
}
function openRemoveCat(c) {
  let n = 0;
  for (const x of collect()) if (x.p.catId === c.id) n++;
  formSheet({
    title: "Remove category", submit: "Remove category", danger: true,
    body: [h("p", null, "Remove ", h("strong", { text: c.name }), " from the list editors pick from? " + (n ? plural(n, "recent project uses", "recent projects use") + " it. Projects already logged keep the name." : "No recent project uses it."))],
    run: async () => { await run("er_remove_category", { p_id: c.id }); return "Category removed"; },
  });
}
function openReassign(uid, p) {
  const others = rosterIds().filter((id) => id !== uid).map((id) => editorStats(id)).sort((a, b) => b.wkOn - a.wkOn || a.wkLate - b.wkLate || b.on4 - a.on4);
  if (!others.length) {
    formSheet({ title: "Reassign project", submit: null, body: [h("p", { text: "There is no other editor to give it to yet. Add one in Settings first." })] });
    return;
  }
  const opts = others.map((s, i) => h("label", { class: "option" },
    h("input", { type: "radio", name: "r-to", id: "r-to-" + i, value: s.uid }),
    h("span", { class: "option-main" },
      h("span", { class: "option-name", text: displayName(s.uid) }),
      h("span", { class: "hint", text: s.wkOn + " on time this week, " + s.active + " in progress" + (s.lateOpen + s.overOpen ? ", " + (s.lateOpen + s.overOpen) + " past deadline" : "") }))));
  formSheet({
    title: "Reassign project", submit: "Reassign",
    body: [
      h("p", null, h("strong", { text: p.name }), " is with " + displayName(uid) + ". Pick who takes it over."),
      h("div", { class: "options", role: "radiogroup", "aria-label": "New editor" }, opts),
      h("p", { class: "hint", text: "The new editor gets it as a fresh brief with a new " + state.config.deliveryHours + "-hour deadline. " + displayName(uid) + " sees a notice that it was reassigned, and keeps it on their record." })],
    run: async () => {
      const pick = sheet.querySelector('input[name="r-to"]:checked');
      if (!pick) throw new Oops("Pick an editor.");
      await run("er_reassign", { p_project: p.id, p_to: pick.value });
      ui.manage = null;
      return "Reassigned to " + displayName(pick.value);
    },
  });
}
function openSendBack(uid, p) {
  const note = h("textarea", { class: "input", id: "sb-note", maxlength: "300", rows: "3" });
  formSheet({
    title: "Send back", submit: "Send back",
    body: [
      h("p", null, "Send ", h("strong", { text: p.name }), " back to " + displayName(uid) + " to submit again. The time it waited in your inbox is added to their deadline, so they aren't marked late for it."),
      field("What's wrong? (the editor sees this)", note, "For example: the link doesn't open, or it's the wrong file.")],
    run: async () => { await run("er_send_back", { p_project: p.id, p_note: note.value.trim() }); ui.manage = null; return "Sent back to " + displayName(uid); },
  });
}
function openAmount(uid, p, cur) {
  const input = h("input", { class: "input", id: "am-amt", type: "text", inputmode: "decimal", autocomplete: "off" });
  if (cur != null) input.value = String(cur);
  formSheet({
    title: "Change the amount", submit: "Save amount",
    body: [h("p", null, h("strong", { text: p.name }), " by " + displayName(uid) + "."), field(moneyLabel("Amount for this video"), input, "This is what the editor sees on their earnings screen.")],
    run: async () => {
      const v = parseAmount(input.value);
      if (v == null) throw new Oops("Enter an amount. Use 0 for none.");
      await run("er_set_amount", { p_project: p.id, p_amount: v });
      return "Amount saved";
    },
  });
}
function openBonuses(uid) {
  const list = state.bonuses.get(uid) || [];
  const amt = h("input", { class: "input", id: "bn-amt", type: "text", inputmode: "decimal", autocomplete: "off" });
  const label = h("input", { class: "input", id: "bn-label", type: "text", maxlength: "80", autocomplete: "off" });
  if (state.prefs.bonusAmount != null) amt.value = String(state.prefs.bonusAmount);
  label.value = ui.period === "week" ? "Top performer, week of " + teamDay(state.weeks[5]) : "Top performer, " + teamMonth(state.month);
  formSheet({
    title: "Bonuses", submit: "Award bonus",
    body: [
      h("p", null, "For ", h("strong", { text: displayName(uid) }), ". A bonus is added to their earnings and shown on the leaderboard every editor sees. The amount stays between you and them."),
      list.length ? h("ul", { class: "rows" }, list.map((b) => h("li", null,
        h("div", { class: "row-main" }, h("span", { class: "row-title", text: b.label || "Bonus" }), h("span", { class: "hint", text: money(b.amt) + ", awarded " + shortDate(b.at) })),
        h("button", { class: "btn small", type: "button", onclick: (e) => act(e.currentTarget, async () => { await run("er_remove_bonus", { p_bonus: b.id }); closeSheet(); }, "Bonus removed") }, "Remove")))) : null,
      field(moneyLabel("Bonus amount"), amt),
      field("What it's for", label, "Editors see this line on the leaderboard.")],
    run: async () => {
      const v = parseAmount(amt.value);
      if (v == null || v <= 0) throw new Oops("Enter the bonus amount.");
      await run("er_award_bonus", { p_editor: uid, p_amount: v, p_label: tidy(label.value) });
      return "Bonus of " + money(v) + " awarded to " + displayName(uid);
    },
  });
}
function openDelete(uid, p) {
  formSheet({
    title: "Delete project", submit: "Delete project", danger: true,
    body: [h("p", null, "Delete ", h("strong", { text: p.name }), " from " + displayName(uid) + "'s record? Any amount it added to their earnings is removed too. This can't be undone.")],
    run: async () => { await run("er_delete_project", { p_project: p.id }); ui.manage = null; return "Project deleted"; },
  });
}

/* ---------- logins and accounts ---------- */
function newPassword() {
  const abc = "abcdefghjkmnpqrstuvwxyz23456789", a = new Uint32Array(10);
  crypto.getRandomValues(a);
  let s = "";
  for (let i = 0; i < 10; i++) { s += abc[a[i] % abc.length]; if (i === 4) s += "-"; }
  return s;
}
function openCreds(title, name, username, password) {
  const text = APP + " login for " + name + "\nOpen: " + location.origin + location.pathname + "\nUsername: " + username + "\nPassword: " + password;
  const pre = h("pre", { class: "cred", id: "cred-text", text: text });
  const copy = h("button", { class: "btn primary grow", type: "button", onclick: async () => {
    try { await navigator.clipboard.writeText(text); copy.textContent = "Copied"; }
    catch (e) { const r = document.createRange(); r.selectNodeContents(pre); const s = getSelection(); s.removeAllRanges(); s.addRange(r); copy.textContent = "Selected: copy it now"; }
  } }, "Copy");
  openSheet(title, [h("div", { class: "form" },
    h("p", { text: "Send this to " + name + ". The password is shown only now, so copy it before you close this." }),
    pre,
    h("div", { class: "btn-row" }, copy, h("button", { class: "btn grow", type: "button", onclick: closeSheet }, "Done")))]);
}
function openAddUser() {
  const name = h("input", { class: "input", id: "nu-name", type: "text", maxlength: "40", autocomplete: "off" });
  const user = h("input", { class: "input", id: "nu-user", type: "text", maxlength: "24", autocomplete: "off", autocapitalize: "none", spellcheck: "false" });
  const pass = h("input", { class: "input", id: "nu-pass", type: "text", maxlength: "72", autocomplete: "off", autocapitalize: "none", spellcheck: "false" });
  const role = h("select", { class: "input", id: "nu-role" }, h("option", { value: "editor", text: "Editor" }), h("option", { value: "admin", text: "Admin (sees and manages everything)" }));
  pass.value = newPassword();
  let typed = false;
  user.addEventListener("input", () => { typed = true; });
  name.addEventListener("input", () => { if (!typed) user.value = name.value.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "").slice(0, 24); });
  formSheet({
    title: "Add a login", submit: "Create login",
    body: [
      field("Name", name, "Shown on their work and on the leaderboard."),
      field("Username", user, "3 to 24 characters: small letters, numbers, dots and dashes."),
      field("Password", pass, "At least 8 characters. They can change it after signing in."),
      state.me.owner ? field("Role", role) : null],
    run: async () => {
      const n = tidy(name.value), un = user.value.trim().toLowerCase(), pw = pass.value;
      if (!n) throw new Oops("Enter their name.");
      try { await run("er_add_user", { p_name: n, p_username: un, p_password: pw, p_role: state.me.owner ? role.value : "editor" }); }
      catch (ex) { if (ex.code === "taken") throw new Oops("That username is already in use."); throw ex; }
      return () => openCreds("Login created", n, un, pw);
    },
  });
}
function openUser(id) {
  const u = state.users.get(id), me = state.me;
  if (!u) return;
  const name = h("input", { class: "input", id: "mu-name", type: "text", maxlength: "40", autocomplete: "off" });
  const role = h("select", { class: "input", id: "mu-role" }, h("option", { value: "editor", text: "Editor" }), h("option", { value: "admin", text: "Admin (sees and manages everything)" }));
  name.value = u.name; role.value = u.role;
  const quick = (args, msg) => (e) => act(e.currentTarget, async () => { await run("er_update_user", Object.assign({ p_user: u.id }, args)); closeSheet(); }, msg);
  formSheet({
    title: "Manage login", submit: "Save",
    body: [
      h("div", { class: "pic-row" }, avatar(u.id, "lg"), h("div", { class: "row-main" },
        h("span", { class: "row-title", text: "@" + u.username }),
        h("span", { class: "hint", text: u.seen ? "Last seen " + ago(u.seen) : "Hasn't signed in yet" }),
        u.active ? null : pill("warn", "Switched off"))),
      field("Name", name, "Shown on their work, their pay and the leaderboard."),
      me.owner ? field("Role", role) : null],
    foot: h("div", { class: "btn-row tools" },
      h("button", { class: "btn small", type: "button", onclick: () => openPassword(u) }, "New password"),
      u.active
        ? h("button", { class: "btn small", type: "button", onclick: () => openSwitchOff(u) }, "Switch off")
        : h("button", { class: "btn small", type: "button", onclick: quick({ p_active: true }, u.name + "'s login is back on") }, "Switch on"),
      u.has ? h("button", { class: "btn small", type: "button", onclick: quick({ p_avatar: "" }, "Picture removed") }, "Remove picture") : null,
      h("button", { class: "btn small", type: "button", onclick: () => openDeleteUser(u) }, "Delete login")),
    run: async () => {
      const n = tidy(name.value), args = {};
      if (!n) throw new Oops("Enter their name.");
      if (n !== u.name) args.p_name = n;
      if (me.owner && role.value !== u.role) args.p_role = role.value;
      if (!Object.keys(args).length) return "";
      await run("er_update_user", Object.assign({ p_user: u.id }, args));
      return args.p_role ? n + " is now " + (args.p_role === "admin" ? "an admin" : "an editor") : "Saved";
    },
  });
}
function openSwitchOff(u) {
  formSheet({
    title: "Switch off login", submit: "Switch off", danger: true,
    body: [h("p", null, "Switch off ", h("strong", { text: u.name }), "'s login? They are signed out at once and can't sign in until you switch it back on. Their work and earnings stay on record.")],
    run: async () => { await run("er_update_user", { p_user: u.id, p_active: false }); return u.name + "'s login is switched off"; },
  });
}
function openDeleteUser(u) {
  formSheet({
    title: "Delete login", submit: "Delete login", danger: true,
    body: [h("p", null, "Delete ", h("strong", { text: u.name }), "'s login (@" + u.username + ")? This is for a login made by mistake. It can't be undone."),
      h("p", { class: "hint", text: "A login that has work or bonuses on record can't be deleted. Switch it off instead, so past projects and pay keep their name." })],
    run: async () => { await run("er_delete_user", { p_user: u.id }); return "Login deleted"; },
  });
}
function openPassword(u) {
  const pass = h("input", { class: "input", id: "pw-new", type: "text", maxlength: "72", autocomplete: "off", autocapitalize: "none", spellcheck: "false" });
  pass.value = newPassword();
  formSheet({
    title: "New password", submit: "Set password",
    body: [h("p", null, "Set a new password for ", h("strong", { text: u.name }), ". Their old one stops working and they are signed out."), field("New password", pass, "At least 8 characters.")],
    run: async () => {
      const pw = pass.value;
      await run("er_update_user", { p_user: u.id, p_password: pw });
      return () => openCreds("Password changed", u.name, u.username, pw);
    },
  });
}
async function shrink(file) {      // a small square picture, so it loads fast for everyone
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("bad")); i.src = url; });
    const size = 128, c = document.createElement("canvas"), s = Math.min(img.naturalWidth, img.naturalHeight);
    if (!s) throw new Error("bad");
    c.width = c.height = size;
    c.getContext("2d").drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, size, size);
    const out = c.toDataURL("image/jpeg", 0.82);
    if (!/^data:image\/jpeg;base64,/.test(out) || out.length > 60000) throw new Error("bad");
    return out;
  } finally { URL.revokeObjectURL(url); }
}
function openAccount() {
  const me = state.me, admin = me.role === "admin";
  let picked = null;        // null = keep, "" = remove, otherwise the new picture
  const slot = h("span", { id: "ac-pic" });
  const file = h("input", { class: "vh", id: "ac-file", type: "file", accept: "image/*", "aria-label": "Choose a picture", tabindex: "-1" });
  const perr = h("p", { class: "error", hidden: true, text: "That picture couldn't be used. Try another one." });
  const remove = h("button", { class: "btn small quiet", type: "button", onclick: () => { picked = ""; show(); } }, "Remove");
  const show = () => {
    const cur = pics.get(me.id), url = picked != null ? picked : cur ? cur.url : "";
    slot.replaceChildren(avatar(me.id, "xl", url));
    remove.hidden = !url;
  };
  show();
  file.addEventListener("change", async () => {
    const f = file.files && file.files[0];
    if (!f) return;
    try { picked = await shrink(f); perr.hidden = true; show(); }
    catch (e) { perr.hidden = false; }
    file.value = "";
  });
  const name = h("input", { class: "input", id: "ac-name", type: "text", maxlength: "40", autocomplete: "name" });
  name.value = me.name;
  formSheet({
    title: "Your account", submit: admin ? "Save" : "Save picture",
    body: [
      h("div", { class: "pic-row" }, slot, file, h("button", { class: "btn small", type: "button", onclick: () => file.click() }, "Choose a picture"), remove),
      perr,
      admin ? field("Your name", name, "Signed in as @" + me.username + ". Your picture and name show wherever your work does.")
        : h("p", { class: "hint", text: "Signed in as @" + me.username + ". Your picture shows next to your name on the leaderboard. Your name is set by your admin." })],
    foot: h("div", { class: "btn-row tools" },
      h("button", { class: "btn small", type: "button", onclick: openChangePassword }, "Change password"),
      h("button", { class: "btn small", type: "button", onclick: () => { const t = state.token; leave(); api("er_logout", { p_token: t }).catch(() => {}); } }, "Sign out"),
      installBox()),
    run: async () => {
      const args = { p_avatar: picked };
      if (admin) {
        const n = tidy(name.value);
        if (!n) throw new Oops("Enter your name.");
        args.p_name = n;
      } else if (picked == null) return "";
      await run("er_set_profile", args);
      return "Saved";
    },
  });
}
function openChangePassword() {
  const old = h("input", { class: "input", id: "cp-old", type: "password", autocomplete: "current-password" });
  const neu = h("input", { class: "input", id: "cp-new", type: "password", autocomplete: "new-password" });
  formSheet({
    title: "Change password", submit: "Change password",
    body: [field("Current password", old), field("New password", neu, "At least 8 characters.")],
    run: async () => {
      if (neu.value.length < 8) throw new Oops("Use a new password of at least 8 characters.");
      const r = await call("er_change_password", { p_old: old.value, p_new: neu.value });
      if (!r || !r.ok) throw new Oops("Your current password isn't right.");
      return "Password changed";
    },
  });
}

/* ---------- drawing ---------- */
let toastTimer = 0;
const toastEl = $("toast");
function seatToast() {      // while a sheet is open the message lives inside it, so it shows above the sheet and is read out
  const home = sheet.open ? sheet : document.body;
  if (toastEl.parentNode !== home) home.append(toastEl);
}
function toast(msg, bad) {
  clearTimeout(toastTimer);
  seatToast();
  toastEl.textContent = msg; toastEl.className = "toast" + (bad ? " bad" : ""); toastEl.hidden = false;
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, bad ? 6000 : 3600);
}
function setTab(id) {
  const admin = ui.view === "admin";
  if (admin) ui.tab = id; else ui.etab = id;
  ui.manage = null;
  try { localStorage.setItem(admin ? "editroom.tab" : "editroom.etab", id); } catch (e) { /* remembering the tab is optional */ }
  window.scrollTo(0, 0);
  schedule();
}
function renderWho() {
  const who = $("who"), on = state.phase === "ready";
  who.hidden = !on;
  if (!on) { who.dataset.sig = ""; return; }
  const pic = pics.get(state.me.id), sig = state.me.name + "|" + ui.view + "|" + (pic ? pic.ver + pic.url.length : "");
  if (who.dataset.sig === sig) return;
  who.dataset.sig = sig;
  who.setAttribute("aria-label", "Your account: " + state.me.name + ", " + (ui.view === "admin" ? "admin" : "editor"));
  who.replaceChildren(
    h("span", { class: "who-text" }, h("span", { class: "who-name", text: state.me.name }), h("span", { class: "who-role", text: ui.view === "admin" ? "Admin" : "Editor" })),
    avatar(state.me.id));
}
$("who").addEventListener("click", () => { if (state.phase === "ready") openAccount(); });
function renderTabs(all) {
  const nav = $("tabs"), on = state.phase === "ready";
  nav.hidden = !on;
  if (!on) return;
  const admin = ui.view === "admin", defs = admin ? ADMIN_TABS : EDITOR_TABS, cur = admin ? ui.tab : ui.etab;
  if (nav.dataset.kind !== ui.view) {
    nav.dataset.kind = ui.view;
    nav.replaceChildren.apply(nav, defs.map((d, i) => h("button", { class: "tab", type: "button", dataset: { tab: d[0] }, onclick: () => setTab(d[0]) },
      h("span", { class: "tab-ic" }, icon(d[0])), h("span", { class: "tab-label", text: d[1] }),
      i === 0 ? h("span", { class: "count" + (admin ? "" : " alert"), hidden: true }) : null)));
  }
  const n = admin ? all.filter(isWaiting).length : all.filter((x) => x.uid === state.me.id && x.p.status === "active" && x.f.phase !== "ontrack").length;
  for (const b of nav.children) {
    if (b.dataset.tab === cur) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    const c = b.querySelector(".count");
    if (c) { c.hidden = !n; c.textContent = String(n); c.setAttribute("aria-label", n + (admin ? " waiting" : " past deadline")); }
  }
}
function renderBanners() {
  const out = [];
  if (state.phase === "ready" && !state.online) out.push(h("div", { class: "notice warn" }, h("strong", { text: "Can't reach the server." }), h("span", { text: "You're seeing the last loaded data. It will catch up when the connection is back." })));
  if (state.phase === "ready" && state.isAdmin && ui.view === "editor") out.push(h("div", { class: "notice" },
    h("strong", { text: "This is the editor screen, as your editors see it." }),
    h("span", { text: "Anything you log here is saved under your name. You can delete it from Projects afterwards." }),
    h("button", { class: "btn small", type: "button", id: "back-admin", onclick: () => { ui.view = "admin"; window.scrollTo(0, 0); schedule(); } }, "Back to admin")));
  const box = $("banners"), sig = out.map((n) => n.textContent).join("|");
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.replaceChildren.apply(box, out);
}
function pin(view, node) { if (view.firstChild !== node || view.childNodes.length !== 1) view.replaceChildren(node); }
function render() {
  const view = $("view"), a = document.activeElement;
  const fk = a && a.dataset && view.contains(a) ? a.dataset.fk || null : null;
  renderWho(); renderBanners();
  const ready = state.phase === "ready", all = ready ? collect() : [];
  renderTabs(all);
  if (state.phase === "boot") return;
  if (state.phase === "down") {
    if (view.dataset.down !== "1") {
      view.dataset.down = "1";
      view.replaceChildren(h("div", { class: "notice" }, h("strong", { text: "Can't reach " + APP + " right now" }), h("span", { text: "Check your connection, then try again." }), h("button", { class: "btn small", type: "button", onclick: (e) => { e.currentTarget.disabled = true; e.currentTarget.textContent = "Trying…"; view.dataset.down = ""; boot(); } }, "Try again")));
    }
    return;
  }
  view.dataset.down = "";
  if (!ready) { pin(view, authView()); return; }
  if (ui.view === "admin" && !state.isAdmin) ui.view = "editor";
  if (ui.view === "admin" && ui.tab === "projects") { pin(view, projectsPanel().node); fillProjects(all); }
  else if (ui.view === "admin" && ui.tab === "settings") { pin(view, settingsPanel().node); fillSettings(); }
  else if (ui.view === "admin" && ui.tab === "editors") view.replaceChildren.apply(view, viewEditors());
  else if (ui.view === "admin") view.replaceChildren.apply(view, viewInbox(all));
  else if (ui.etab === "board") view.replaceChildren.apply(view, viewBoard());
  else if (ui.etab === "earn") view.replaceChildren.apply(view, viewEarn(all));
  else view.replaceChildren.apply(view, viewWork(all));
  if (fk && !view.contains(document.activeElement)) {
    const el = view.querySelector('[data-fk="' + esc(fk) + '"]');
    if (el) el.focus({ preventScroll: true });
  }
}
let raf = 0;
function schedule() {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; render(); });
}

/* ---------- start ---------- */
async function boot() {
  state.phase = "boot";
  let saved = null;
  try { saved = localStorage.getItem("editroom.token"); } catch (e) { /* no saved sign-in */ }
  try {
    if (saved) {
      try { await enter(saved); return; }
      catch (e) { if (e.code !== "auth") throw e; saveToken(null); }
    }
    const s = await api("er_status");
    state.phase = s && s.ready ? "login" : "setup";
  } catch (e) { state.phase = "down"; }
  render();
}
boot();
setInterval(() => { if (!document.hidden && state.phase === "ready") schedule(); }, 60000);
document.addEventListener("visibilitychange", () => {
  if (document.hidden || state.phase !== "ready") return;
  if (Date.now() - state.lastFull > 30 * MIN) state.wantFull = true;
  schedule(); sync();
});
if ("serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
