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
const DRIVE = String(CFG.url || "").replace(/\/+$/, "") + "/functions/v1/dn-drive";        // the Google Drive upload function
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
  isAdmin: false, isBuyer: false,
  config: { categories: [], weeklyTarget: null, deliveryHours: 24, graceHours: 48, currency: "", tz: "UTC", drive: { on: false, email: null, lost: false, folders: [] } },
  prefs: { bonusAmount: null },
  cats: new Map(), users: new Map(), projects: new Map(), bonuses: new Map(),
  board: { week: [], month: [], awards: [] }, weeks: [0, 0, 0, 0, 0, 0], month: 0, totals: { videos: 0, bonus: 0, month: 0 },
  featured: [],                                       // "Video of the moment": up to five finished videos the admin put on everyone's home screen
  stats: { editors: new Map(), cats: new Map() },     // admin only: figures worked out by the server
  horizon: null,                                      // admin only: where history older than the loaded projects starts
  scripts: [],                                        // scripts not yet taken on: all of them for an admin, an editor's own waiting ones
  videos: new Map(),                                  // media buyer only: the approved videos, by id
  seenBefore: 0,                                      // media buyer only: when they last opened the app, so newer videos show as new
};
// Older projects for the admin's Projects list, fetched a page at a time for the filters in use.
const hist = { key: null, rows: new Map(), next: null, more: false, busy: false, failed: false };
function resetHist() { hist.key = null; hist.rows = new Map(); hist.next = null; hist.more = false; hist.busy = false; hist.failed = false; }
const ui = { view: "editor", tab: "inbox", etab: "work", fStatus: "active", fEditor: "all", fCat: "all", period: "week", manage: null, limit: 40, older: false, earnAll: false, spark: null, bCat: "all", bLimit: 30, allOnTime: false };
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
  star: "M12 4.2l2.3 4.8 5.2.7-3.8 3.7.9 5.2L12 16.1l-4.6 2.5.9-5.2-3.8-3.7 5.2-.7L12 4.2z",
  play: "M9 6.5v11l9-5.5-9-5.5z",
  close: "M6.5 6.5l11 11M17.5 6.5l-11 11",
};
const SOLID = { play: true };      // drawn filled in
function icon(name, size, weight) {
  const NS = "http://www.w3.org/2000/svg", s = document.createElementNS(NS, "svg"), p = document.createElementNS(NS, "path");
  s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("width", String(size || 22)); s.setAttribute("height", String(size || 22)); s.setAttribute("aria-hidden", "true");
  p.setAttribute("d", ICONS[name]); p.setAttribute("fill", SOLID[name] ? "currentColor" : "none"); p.setAttribute("stroke", "currentColor");
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
// The Google Drive upload function (supabase/functions/dn-drive). It answers { error: code } when it refuses,
// with the same codes the database uses where they mean the same thing.
async function driveCall(action, args) {
  const stop = new AbortController(), timer = setTimeout(() => stop.abort(), 30000);
  let res;
  try {
    res = await fetch(DRIVE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.assign({ action: action, token: state.token }, args || {})),
      cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer", signal: stop.signal });
  } catch (e) { throw new ApiError("offline", 0); }
  finally { clearTimeout(timer); }
  let body = null;
  try { body = await res.json(); } catch (e) { /* an empty or unreadable reply */ }
  if (!res.ok || !body || body.error) {
    const code = body && typeof body.error === "string" ? body.error : "server";
    if (code === "auth") leave("You've been signed out. Sign in again.");
    throw new ApiError(code, res.status);
  }
  return body;
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
  push_failed: "This phone couldn't turn notifications on. Try again in a moment.",
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
  bad_full_name: "Enter your full name, as it appears on your bank account.",
  bad_phone: "Enter your phone number, like 0803 123 4567.",
  bad_bank: "Enter the name of your bank.",
  bad_account: "Enter your 10-digit account number.",
  too_many: "You've changed your details a lot today. Try again tomorrow.",
  not_script: "That isn't a script file. Send a Word document (.doc or .docx), a PDF or a text file.",
  script_gone: "That script isn't in your admin's Google Drive any more. Ask your admin to send it again.",
};
// What can go wrong with Google Drive, said the same way wherever it comes up.
const DRIVE_ERRORS = {
  not_set_up: "Google Drive isn't set up for this app yet.",
  drive_off: "Google Drive isn't connected right now. Paste a Drive link instead, or ask your admin.",
  drive_lost: "Google ended the Drive connection, so uploads are paused. Your admin needs to connect it again in Settings.",
  no_folder: "That folder can't be used any more. Pick another one, or ask your admin.",
  too_big: "That file is too big. Videos can be up to 50 GB.",
  not_video: "That isn't a video file. Choose the finished video.",
  too_many: "You've started a lot of uploads today. Try again tomorrow, or paste a Drive link instead.",
  expired: "That upload went too long without finishing. Start it again.",
  not_done: "The video didn't arrive in full. Upload it again.",
  google: "Google Drive didn't answer as expected. Try again in a minute.",
  offline: "Can't reach Google Drive. Check your connection and try again.",
};
const driveErr = (e) => DRIVE_ERRORS[e && e.code] || errText(e);
const errText = (e) => ERRORS[e && e.code] || "That didn't work. Try again in a moment.";
async function act(btn, fn, okMsg) {
  if (btn) btn.disabled = true;
  try { await fn(); if (okMsg) toast(okMsg); }
  catch (e) { toast(e instanceof Oops ? e.message : errText(e), true); if (btn && btn.isConnected) btn.disabled = false; }
}

// Payment details as the server sends them: the name on the bank account, a phone number, the bank, and a
// 10-digit account number. Anything that doesn't look right counts as none.
function normDetails(d) {
  if (!d || typeof d !== "object" || !/^[0-9]{10}$/.test(String(d.account))) return null;
  return { name: str(d.name, 80), phone: str(d.phone, 20), bank: str(d.bank, 60), account: String(d.account), at: num(d.at) };
}
// Google Drive as the server describes it: connected or not, and the folders editors may upload to. Only an
// admin is told the account's address, and whether Google ended the last connection.
function normDrive(d) {
  const x = d && typeof d === "object" ? d : {};
  const folders = (Array.isArray(x.folders) ? x.folders : []).filter((f) => f && typeof f.id === "string" && /^[0-9a-f-]{36}$/.test(f.id)).slice(0, 100)
    .map((f) => ({ id: f.id, name: str(f.name, 200) || "Untitled folder" }));
  return { on: x.on === true, email: str(x.email, 320) || null, lost: x.lost === true, folders: folders };
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
    receivedAt: num(r.received), amount: amount(r.amount), script: typeof r.script === "string" && /^[0-9a-f-]{36}$/.test(r.script) ? r.script : null,
  };
}
const roleOf = (r) => (r === "admin" || r === "buyer" ? r : "editor");
const viewFor = () => (state.isAdmin ? "admin" : state.isBuyer ? "buyer" : "editor");
function normScript(x) {
  return { id: String(x.id), uid: x.u ? String(x.u) : state.me.id, catId: x.cat ? String(x.cat) : null, name: str(x.name, 140) || "Untitled script", file: str(x.file, 200),
    size: num(x.size) || 0, at: num(x.at) || 0, status: x.status === "declined" ? "declined" : "waiting", note: str(x.note, 300), by: x.by ? String(x.by) : null, declined: num(x.declined) };
}
function applyState(d) {
  const wasRole = state.me.role, hadMe = state.me.id;
  state.skew = Number(d.now) - Date.now();
  const m = d.me || {};
  state.me = { id: String(m.id), name: str(m.name, 40), username: str(m.username, 24), role: roleOf(m.role), owner: m.owner === true, av: num(m.av) || 0, has: m.has === true, avAt: num(m.avAt), phones: num(m.phones) || 0, details: normDetails(m.details) };
  state.isAdmin = state.me.role === "admin"; state.isBuyer = state.me.role === "buyer";
  const s = d.settings || {}, active = [];
  state.cats = new Map();
  for (const c of Array.isArray(d.cats) ? d.cats : []) {
    const cat = { id: String(c.id), name: str(c.name, 40), rate: amount(c.rate), archived: c.archived === true };
    state.cats.set(cat.id, cat);
    if (!cat.archived) active.push(cat);
  }
  state.config = { categories: active, weeklyTarget: num(s.target), deliveryHours: num(s.delivery) || 24, graceHours: num(s.grace) == null ? 48 : num(s.grace), currency: str(s.currency, 6), tz: str(s.tz, 64) || "UTC",
    push: typeof s.push === "string" && /^[A-Za-z0-9_-]{86,88}$/.test(s.push) ? s.push : null, picAsk: num(s.picAsk), detailsAsk: num(s.detailsAsk), lateAsk: num(s.lateAsk),
    drive: normDrive(s.drive) };
  state.prefs = { bonusAmount: amount(s.bonus) };
  state.users = new Map();
  for (const u of Array.isArray(d.users) ? d.users : []) {
    state.users.set(String(u.id), { id: String(u.id), name: str(u.name, 40) || "Unnamed", username: str(u.username, 24), role: roleOf(u.role), owner: u.owner === true, active: u.active !== false, av: num(u.av) || 0, has: u.has === true, seen: num(u.seen), earned: amount(u.earned) || 0, bonus: amount(u.bonus) || 0, last: num(u.last) || 0, moved: num(u.moved) || 0, avAt: num(u.avAt), push: u.push === true, pay: u.pay === true });
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
  state.featured = (Array.isArray(d.featured) ? d.featured : []).slice(0, 5).map((x) => ({ id: String(x.id), uid: String(x.u), name: str(x.name, 140) || "Untitled project", catId: x.cat ? String(x.cat) : null, link: str(x.link, 600) || null, at: num(x.at) || 0 }));
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
  state.scripts = (Array.isArray(d.scripts) ? d.scripts : []).filter((x) => x && typeof x.id === "string").map(normScript);
  if (state.isBuyer) {
    if (d.full) state.videos = new Map();
    for (const v of Array.isArray(d.videos) ? d.videos : []) {
      if (!v || !v.id) continue;
      if (v.gone) state.videos.delete(String(v.id));
      else state.videos.set(String(v.id), { id: String(v.id), name: str(v.name, 140) || "Untitled video", catId: v.cat ? String(v.cat) : null, link: str(v.link, 600) || null, at: num(v.at) || 0, by: str(v.by, 40) });
    }
  } else state.videos = new Map();
  state.cursor = num(d.cursor);
  if (hadMe && wasRole !== state.me.role) { state.cursor = null; ui.view = viewFor(); }   // a changed role changes what this login may load
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
  state.me.id = null; state.isAdmin = false; state.isBuyer = false;
  applyState(d);
  state.lastFull = Date.now(); state.wantFull = false; state.online = true; state.phase = "ready";
  ui.view = viewFor();
  if (state.isBuyer) {      // videos approved since this phone last opened the app are marked new for this visit
    let last = null;
    try { last = Number(localStorage.getItem("editroom.seenVideos")) || null; localStorage.setItem("editroom.seenVideos", String(now())); } catch (e) { /* nothing is marked new */ }
    state.seenBefore = last || now();
  }
  try {
    const t = localStorage.getItem("editroom.tab"), e = localStorage.getItem("editroom.etab");
    if (ADMIN_TABS.some((x) => x[0] === t)) ui.tab = t;
    if (EDITOR_TABS.some((x) => x[0] === e)) ui.etab = e;
  } catch (e) { /* start on the first tab */ }
  authPanel = null;
  driveReturn();
  restorePics();
  render(); plan(); loadPics(); pushRefresh();
}
// Coming back from Google (connecting Drive) or from the folder picker page: say how it went, on Settings,
// and take the note off the address so a reload doesn't say it again.
function driveReturn() {
  let q;
  try { q = new URLSearchParams(location.search); } catch (e) { return; }
  const r = q.get("drive");
  if (!r) return;
  try { history.replaceState(null, "", location.pathname); } catch (e) { /* the note stays in the address */ }
  if (!state.isAdmin) return;
  const n = Number(q.get("n")) || 0, usable = Number(q.get("u")) || 0;
  const added = n === 1 ? "1 folder added. Editors can upload to it now." : n + " folders added. Editors can upload to them now.";
  const msg = {
    connected: ["Google Drive connected. Now add the folders editors can upload to.", false],
    cancelled: ["Google Drive wasn't connected, because the Google sign-in was cancelled.", true],
    noaccess: ["Google Drive wasn't connected. On Google's screen, tick the box that lets DN Studios use your Drive files, then try again.", true],
    expired: ["That Google sign-in took too long. Press Connect Google Drive again.", true],
    failed: ["Google Drive couldn't be connected. Try again in a minute.", true],
    folders: [n ? added : usable ? "Those folders were already on the list." : "None of those folders could be used. Pick folders you can add files to.", !n && !usable],
  }[r];
  ui.view = "admin"; ui.tab = "settings";
  if (msg) setTimeout(() => toast(msg[0], msg[1]), 0);
}
function leave(msg) {
  saveToken(null);
  clearTimeout(syncTimer);
  state.phase = "login"; state.cursor = null; state.projects = new Map(); state.users = new Map(); state.featured = []; state.scripts = []; state.videos = new Map();
  state.stats = { editors: new Map(), cats: new Map() }; state.horizon = null; resetHist();
  setPanel = null;          // Settings start afresh for whoever signs in next, with no half-made changes left in them
  if (activeUpload) activeUpload.stop();
  forgetPics();
  closeSheet(true); closePlayer(); render();
  if (msg) toast(msg, true);
}
// Profile pictures are kept on this phone between visits ("editroom.pics": each person's picture with its
// version), so opening the app shows them at once and downloads only the ones changed since. Fetching
// everyone's picture at every visit was most of what the app downloaded. Signing out clears them.
const PIC_URL = /^data:image\/(jpeg|png|webp);base64,/;
const PIC_KEY = "editroom.pics";
function restorePics() {
  let kept = null;
  try { const o = JSON.parse(localStorage.getItem(PIC_KEY) || "null"); if (o && o.v === 1 && o.p && typeof o.p === "object") kept = o.p; } catch (e) { /* nothing kept */ }
  if (!kept) return;
  for (const u of state.users.values()) {
    const k = kept[u.id];
    if (u.has && !pics.has(u.id) && Array.isArray(k) && k[0] === u.av && typeof k[1] === "string" && PIC_URL.test(k[1])) pics.set(u.id, { ver: u.av, url: k[1] });
  }
}
function keepPics() {
  const p = {};
  for (const [id, pic] of pics) if (pic.url && state.users.has(id)) p[id] = [pic.ver, pic.url];
  try { localStorage.setItem(PIC_KEY, JSON.stringify({ v: 1, p: p })); }
  catch (e) { try { localStorage.removeItem(PIC_KEY); } catch (e2) { /* none kept: they download at each visit, as before */ } }
}
function forgetPics() {
  pics.clear();
  try { localStorage.removeItem(PIC_KEY); } catch (e) { /* nothing was kept */ }
}
let picBusy = false;
async function loadPics() {
  if (picBusy || state.phase !== "ready") return;
  const want = [];        // [id, version asked for]: if a picture changes while this one downloads, the next look fetches it again
  let dropped = false;
  for (const u of state.users.values()) {
    const have = pics.get(u.id);
    if (u.has && (!have || have.ver !== u.av)) want.push([u.id, u.av]);
    else if (!u.has && have) { pics.delete(u.id); dropped = true; }
  }
  if (dropped) { keepPics(); schedule(); }
  if (!want.length) return;
  picBusy = true;
  try {
    const batch = want.slice(0, 24);
    const r = (await call("er_avatars", { p_ids: batch.map((w) => w[0]) })) || {};
    if (state.phase !== "ready") { picBusy = false; return; }          // signed out while it downloaded
    for (const [id, ver] of batch) pics.set(id, { ver: ver, url: typeof r[id] === "string" && PIC_URL.test(r[id]) ? r[id] : "" });
    keepPics();
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
// A picture that opens full size when tapped (people without a picture just show their initial).
function zoomable(uid, size) {
  const pic = pics.get(uid);
  if (!pic || !pic.url) return avatar(uid, size);
  return h("button", { class: "pic-btn" + (size ? "" : " small"), type: "button", "aria-label": "See " + displayName(uid) + "'s picture", dataset: { fk: "pic:" + uid + ":" + (size || "") }, onclick: () => openPic(uid) }, avatar(uid, size));
}
// An admin can tap anyone's picture; elsewhere it opens only where the caller asks (the leaderboard).
function person(uid, size, zoom) {
  const z = zoom == null ? ui.view === "admin" : zoom;
  return h("div", { class: "person" + (size ? " big" : "") }, z ? zoomable(uid, size) : avatar(uid, size), h("span", { class: "person-name", text: displayName(uid) + (uid === state.me.id ? " (you)" : "") }));
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
// Once the deadline has passed, the grace period drains like a phone battery, on the editor's card and on the
// admin's: green, with charge flowing out to the left, shrinking in step with the time that's left. The bar
// keeps draining between redraws, and the flow keeps its place when the screen is drawn again. Empty, with a
// red outline, once it's over.
function graceBar(x) {
  const f = x.f, total = f.graceEnd - f.deadline;
  if (x.p.status !== "active" || f.phase === "ontrack" || !(total > 0)) return null;
  const left = Math.max(0, f.graceEnd - now()), over = f.phase === "over" || left === 0;
  const fill = h("i", { class: "grace-fill" });
  fill.style.width = over ? "0%" : (100 * left / total).toFixed(3) + "%";
  if (!over) {
    fill.style.setProperty("--drain", left + "ms");
    fill.style.setProperty("--flow", -(Date.now() % 700) + "ms");
    fill.style.setProperty("--sheen", -(Date.now() % 2200) + "ms");
  }
  return h("div", { class: "grace" + (over ? " over" : ""), role: "img", "aria-label": over ? "Grace period over" : "Grace period: " + span(left) + " left of " + span(total) },
    h("div", { class: "grace-head", "aria-hidden": "true" }, h("span", { text: "Grace period" }), h("span", { class: "grace-left", text: over ? "Over" : span(left) + " left" })),
    h("div", { class: "grace-batt", "aria-hidden": "true" }, fill));
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

/* ---------- video of the moment ---------- */
const isFeatured = (id) => state.featured.some((x) => x.id === id);
const momentPill = (p) => (isFeatured(p.id) ? pill("gold", "Video of the moment") : null);
function feature(btn, id, on) {
  return act(btn, async () => {
    const r = await run("er_feature", { p_project: id, p_on: on });
    toast(!on ? "Taken down from the home screen." : r && r.dropped ? "Added. The oldest video came down to keep it to five." : "Now showing on everyone's home screen.");
  });
}
function featureBtn(p, key) {      // on a finished video's card, for an admin
  const up = isFeatured(p.id);
  return h("button", { class: "btn small", type: "button", dataset: { fk: "feat:" + key }, onclick: (e) => feature(e.currentTarget, p.id, !up) }, up ? null : icon("star", 18), up ? "Take down from home screen" : "Make video of the moment");
}
// A Google Drive file plays inside the app, in Drive's own player; any other link opens where it lives.
// The player's address is built only from the file's id, plus the link key Drive needs for some shared
// files, never from the pasted text itself.
function driveEmbed(raw) {
  let u;
  try { u = new URL(String(raw || "")); } catch (e) { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase(), path = u.pathname;
  if (host !== "drive.google.com" && host !== "docs.google.com" && host !== "drive.usercontent.google.com") return null;
  const m = /\/file\/(?:u\/\d+\/)?d\/([^/]+)/.exec(path);
  const id = m ? m[1] : /^\/(?:u\/\d+\/)?(?:open|uc|download)\/?$/.test(path) ? u.searchParams.get("id") : null;
  if (!id || !/^[A-Za-z0-9_-]{5,128}$/.test(id)) return null;
  const key = u.searchParams.get("resourcekey");
  return "https://drive.google.com/file/d/" + id + "/preview" + (key && /^[A-Za-z0-9_-]{1,128}$/.test(key) ? "?resourcekey=" + key : "");
}
function shot(x) {      // one featured video: a black screen that plays it
  const link = parseLink(x.link), embed = link ? driveEmbed(link.href) : null, cat = x.catId ? state.cats.get(x.catId) : null, mine = x.uid === state.me.id;
  const kids = [
    cat ? h("span", { class: "shot-cat", text: cat.name }) : h("span"),
    h("span", { class: "shot-play", "aria-hidden": "true" }, icon("play", 26)),
    h("span", { class: "shot-title", text: x.name }),
    h("span", { class: "shot-by" }, avatar(x.uid), h("span", { text: displayName(x.uid) + (mine ? " (you)" : "") }))];
  const label = (embed ? "Play " : "Watch ") + x.name + ", by " + displayName(x.uid);
  if (embed) return h("button", { class: "shot", type: "button", dataset: { fk: "shot:" + x.id }, "aria-label": label, onclick: () => openPlayer(x, embed, link) }, kids);
  return link ? h("a", { class: "shot", href: link.href, target: "_blank", rel: "noopener noreferrer", dataset: { fk: "shot:" + x.id }, "aria-label": label }, kids)
    : h("div", { class: "shot" }, kids);
}
function momentPanel() {      // on everyone's home screen; an admin also gets the controls
  const list = state.featured, admin = ui.view === "admin";
  if (!list.length && !admin) return null;
  const head = h("div", { class: "section-head" }, h("h2", { class: "section-title", text: "Video of the moment" }),
    admin ? h("button", { class: "btn small", type: "button", dataset: { fk: "moment-add" }, onclick: () => openMoment() }, "Add a video") : null);
  if (!list.length) return h("section", { class: "section" }, head, empty("Nothing is showing yet.", "Pick a submitted video and it appears here, on every editor's home screen."));
  return h("section", { class: "section" }, head,
    admin ? h("p", { class: "section-note", text: "Everyone on the team sees these and can play them in the app. Set each Drive file to Anyone with the link so it plays for everyone." }) : null,
    h("ul", { class: "reel" + (list.length === 1 ? " solo" : "") }, list.map((x) => h("li", { class: "reel-item" }, shot(x),
      admin ? h("button", { class: "btn small", type: "button", dataset: { fk: "down:" + x.id }, onclick: (e) => feature(e.currentTarget, x.id, false) }, "Take down") : null))));
}

/* ---------- scripts sent through the app, and finished videos to download ---------- */
const SCRIPT_ACCEPT = ".doc,.docx,.pdf,.txt,.rtf,.odt,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf,text/plain,application/rtf,application/vnd.oasis.opendocument.text";
const SCRIPT_MAX = 10 * 1024 * 1024;
function scriptErr(e) {
  const c = e && e.code, admin = state.isAdmin;
  if (e instanceof Oops) return e.message;
  if (c === "drive_off" || c === "not_set_up") return admin ? "Google Drive isn't connected, so scripts can't be sent or opened. Connect it in Settings." : "Google Drive isn't connected right now, so the script can't be opened. Ask your admin.";
  if (c === "drive_lost") return admin ? "Google ended the Drive connection, so scripts can't be sent or opened. Connect it again in Settings." : "Google ended the Drive connection, so the script can't be opened. Ask your admin.";
  if (c === "too_big") return "That file is too big. Scripts can be up to 10 MB.";
  return driveErr(e);
}
// A script's file comes from the studio's Google Drive, through the Drive function, and is handed to the phone
// as a download under its own name, so it opens in Word or whatever the phone reads documents with.
async function openScript(id, btn) {
  const label = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "Opening…"; }
  try {
    const r = await driveCall("script_open", { script: id });
    const bin = atob(String(r.data || "")), data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([data], { type: str(r.mime, 120) || "application/octet-stream" }));
    const a = h("a", { href: url, download: str(r.name, 200) || "script", hidden: true });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) { toast(scriptErr(e), true); }
  finally { if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = label; } }
}
const scriptBtn = (id, key, small) => h("button", { class: "btn " + (small ? "small" : "grow"), type: "button", dataset: { fk: "script:" + key }, onclick: (e) => openScript(id, e.currentTarget) }, "Open script");
function readB64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(new Oops(file.name + " couldn't be read. Choose it again."));
    r.readAsDataURL(file);
  });
}
const stem = (name) => String(name || "").replace(/\.[A-Za-z0-9]{1,5}$/, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
function guessCat(name) {       // the category whose name is in the file's name, the longest one if several are
  const n = String(name || "").toLowerCase();
  const hits = state.config.categories.filter((c) => c.name.length > 2 && n.includes(c.name.toLowerCase())).sort((a, b) => b.name.length - a.name.length);
  return hits.length ? hits[0].id : "";
}
// Editors to pick from, each with what they have on: briefs in progress, scripts waiting for them, anything late.
function editorOptions(name, list) {
  return h("div", { class: "options", role: "radiogroup", "aria-label": "Editor" }, list.map((u, i) => {
    const st = editorStats(u.id), waiting = state.scripts.filter((x) => x.uid === u.id && x.status === "waiting").length, late = st.lateOpen + st.overOpen;
    const bits = [st.active + " in progress"];
    if (waiting) bits.push(plural(waiting, "script", "scripts") + " waiting");
    if (late) bits.push(late + " past deadline");
    return h("label", { class: "option" },
      h("input", { type: "radio", name: name, id: name + "-" + i, value: u.id }),
      h("span", { class: "option-main" }, h("span", { class: "option-name", text: u.name }), h("span", { class: "hint", text: bits.join(", ") })));
  }));
}
const activeEditors = () => Array.from(state.users.values()).filter((u) => u.role === "editor" && u.active).sort((a, b) => a.name.localeCompare(b.name));
// The address that downloads a Google Drive file straight away (for a big file, Drive asks once first). Links to
// anywhere else get null: they open where they live instead.
function driveDownload(raw) {
  let u;
  try { u = new URL(String(raw || "")); } catch (e) { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  if (host !== "drive.google.com" && host !== "docs.google.com" && host !== "drive.usercontent.google.com") return null;
  const m = /\/file\/(?:u\/\d+\/)?d\/([^/]+)/.exec(u.pathname);
  const id = m ? m[1] : u.searchParams.get("id"), key = u.searchParams.get("resourcekey");
  if (!id || !/^[A-Za-z0-9_-]{5,128}$/.test(id)) return null;
  return "https://drive.google.com/uc?export=download&id=" + id + (key && /^[A-Za-z0-9_-]{1,128}$/.test(key) ? "&resourcekey=" + key : "");
}

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
  box.replaceChildren(h("span", { class: "hint", text: isApple()
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
function isApple() { const ua = navigator.userAgent || ""; return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1); }

/* ---------- phone notifications ---------- */
// Each phone signs up for notifications once, after its owner taps "Turn on notifications". The phone's
// push address goes to the database, which queues a notification when a video comes in (for admins) or a
// deadline passes (for the editor); the sender delivers it even when the app is closed.
const pushable = () => !!state.config.push && "serviceWorker" in navigator && "PushManager" in window && typeof Notification !== "undefined" && window.isSecureContext;
const needsHomeScreen = () => !!state.config.push && isApple() && !isInstalled() && !("PushManager" in window);   // iPhones allow them only from the home screen
const pushPerm = () => (typeof Notification !== "undefined" ? Notification.permission : "denied");
const within = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error("slow")), ms))]);
function keyBytes(text) {
  const s = String(text).replace(/-/g, "+").replace(/_/g, "/"), bin = atob(s + "===".slice((s.length + 3) % 4)), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function sameKey(buf, bytes) {
  if (!buf) return false;
  const a = new Uint8Array(buf);
  return a.length === bytes.length && a.every((v, i) => v === bytes[i]);
}
async function phoneSub() {      // this phone's sign-up, if it has one
  const reg = await within(navigator.serviceWorker.ready, 8000);
  return { reg: reg, sub: await reg.pushManager.getSubscription() };
}
async function pushSignUp() {
  const key = keyBytes(state.config.push), cur = await phoneSub();
  let sub = cur.sub;
  if (sub && !sameKey(sub.options && sub.options.applicationServerKey, key)) { try { await sub.unsubscribe(); } catch (e) { /* replaced below */ } sub = null; }
  if (!sub) sub = await cur.reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const j = sub.toJSON();
  await call("er_save_push", { p_endpoint: j.endpoint, p_key: j.keys.p256dh, p_auth: j.keys.auth });
}
async function turnOnPush(btn) {      // from a tap: the phone asks its owner, then this phone signs up
  if (btn) btn.disabled = true;
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") {
      toast(perm === "denied" ? "Notifications are blocked for " + APP + ". Allow them in your phone's settings to get pings." : "Notifications are still off.", perm === "denied");
      return;
    }
    await pushSignUp();
    await sync();
    toast("Notifications are on for this phone.");
  } catch (e) { toast(e instanceof ApiError ? errText(e) : ERRORS.push_failed, true); }
  finally { if (btn && btn.isConnected) btn.disabled = false; schedule(); }
}
async function turnOffPush(btn) {
  if (btn) btn.disabled = true;
  try {
    const cur = await phoneSub();
    if (cur.sub) { await call("er_drop_push", { p_endpoint: cur.sub.endpoint }); try { await cur.sub.unsubscribe(); } catch (e) { /* the server has already let it go */ } }
    await sync();
    toast("Notifications are off for this phone.");
  } catch (e) { toast(errText(e), true); }
  finally { if (btn && btn.isConnected) btn.disabled = false; schedule(); }
}
function testPush(btn) {
  return act(btn, async () => {
    const r = await call("er_test_push");
    if (r && r.queued) toast("Test sent. It should arrive in a few seconds.");
    else toast("This phone isn't signed up yet. Turn notifications on first.", true);
  });
}
async function pushRefresh() {      // on start: keep this phone's sign-up current, without asking anything
  if (!pushable() || pushPerm() !== "granted") return;
  try { await pushSignUp(); } catch (e) { /* tried again next time the app opens */ }
}
async function pushDrop(token) {      // signing out: this phone stops getting that person's notifications
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  try {
    const reg = await within(navigator.serviceWorker.getRegistration(), 3000), sub = reg ? await reg.pushManager.getSubscription() : null;
    if (sub) await api("er_drop_push", { p_token: token, p_endpoint: sub.endpoint });
  } catch (e) { /* whoever signs in next on this phone takes it over */ }
}
function snoozed() { try { return Number(localStorage.getItem("editroom.pushAsk") || 0) > Date.now() - 7 * DAY; } catch (e) { return false; } }
// On the home screen until notifications are on, refused, or put off for a week.
function pushCard() {
  if (state.phase !== "ready" || snoozed()) return null;
  const home = needsHomeScreen();
  if (!home && !(pushable() && pushPerm() === "default")) return null;
  const v = ui.view;
  const later = h("button", { class: "btn small quiet", type: "button", dataset: { fk: "push-later" }, onclick: () => { try { localStorage.setItem("editroom.pushAsk", String(Date.now())); } catch (e) { /* asked again next time */ } schedule(); } }, "Not now");
  return h("section", { class: "panel push-card", "aria-label": "Notifications" },
    h("h2", { class: "section-title", text: v === "admin" ? "Get a ping when a video comes in" : v === "buyer" ? "Get a ping when a new video is ready" : "Get a ping for new scripts and deadlines" }),
    h("p", { text: home ? "On iPhone, add " + APP + " to your home screen first, then open it from there to turn on notifications."
      : v === "admin" ? "Turn on notifications and this phone pings as soon as an editor submits a video, even when the app is closed."
        : v === "buyer" ? "Turn on notifications and this phone pings as soon as a video is approved, even when the app is closed. Tap the ping to download the video."
          : "Turn on notifications and this phone pings when your admin sends you a script, and when a video reaches its deadline, even when the app is closed." }),
    h("div", { class: "btn-row" },
      home ? h("button", { class: "btn small", type: "button", dataset: { fk: "push-how" }, onclick: () => openAccount() }, "How to add it")
        : h("button", { class: "btn small primary", type: "button", dataset: { fk: "push-on" }, onclick: (e) => turnOnPush(e.currentTarget) }, "Turn on notifications"),
      later));
}
// In the account sheet: what notifications are doing on this phone, and the switch.
function notifyBox() {
  const box = h("div", { class: "part", id: "ac-notify" });
  if (!state.config.push) { box.hidden = true; return box; }
  const line = (text, buttons) => {         // (replaceChildren would print a missing row as the word "null")
    box.replaceChildren(h("h3", { class: "part-title", text: "Notifications" }), h("p", { class: "hint", text: text }));
    if (buttons) box.append(h("div", { class: "btn-row" }, buttons));
  };
  if (needsHomeScreen()) { line("To get notifications on iPhone, add " + APP + " to your home screen, then open it from there."); return box; }
  if (!pushable()) { line("This browser can't show notifications."); return box; }
  if (pushPerm() === "denied") { line("Notifications are blocked for " + APP + " on this phone. Allow them in your phone's settings, then come back here."); return box; }
  line("Checking this phone…");
  phoneSub().then((cur) => {
    if (cur.sub && pushPerm() === "granted") line("Notifications are on for this phone.", [
      h("button", { class: "btn small", type: "button", id: "push-test", onclick: (e) => testPush(e.currentTarget) }, "Send a test"),
      h("button", { class: "btn small", type: "button", id: "push-off", onclick: async (e) => { await turnOffPush(e.currentTarget); box.replaceWith(notifyBox()); } }, "Turn off")]);
    else line("Notifications are off for this phone.", [h("button", { class: "btn small primary", type: "button", id: "push-on2", onclick: async (e) => { await turnOnPush(e.currentTarget); box.replaceWith(notifyBox()); } }, "Turn on notifications")]);
  }).catch(() => line("Notifications aren't available on this phone right now."));
  return box;
}
// An editor is reminded to add payment details until they have.
const detailsMissing = () => state.me.role === "editor" && !state.me.details;
// Once the admin has sent the profile picture reminder, an editor without a picture is asked for one until they add it.
const pictureAsked = () => state.me.role === "editor" && state.config.picAsk != null && !state.me.has;
// Keeps a glowing button's pulse in step across the screen redrawing every few seconds.
function glow(el) { el.style.animationDelay = -(Date.now() % 2000) + "ms"; return el; }

/* ---------- signing in ---------- */
let authPanel = null;
function authView() {
  if (authPanel && authPanel.phase === state.phase) return authPanel.node;
  const err = h("p", { class: "error", role: "alert", hidden: true });
  const fail = (ex) => { err.textContent = ex instanceof Oops ? ex.message : errText(ex); err.hidden = false; };
  const head = (title, note) => h("div", { class: "slate" }, h("h2", { class: "slate-title", text: title }), h("p", { class: "slate-label", text: note }));
  const foot = () => h("p", { class: "auth-foot" }, h("a", { href: "privacy.html" }, "Privacy policy"));
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
      installBox(), foot());
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
      installBox(), foot());
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
  if (pictureAsked()) notices.push(h("div", { class: "notice gold" },
    h("strong", { text: "Add a profile picture" }),
    h("span", { text: "Your admin asked you to add one. It shows next to your name on the leaderboard." }),
    h("button", { class: "btn small primary", type: "button", dataset: { fk: "newpic" }, onclick: () => openAccount(true) }, "Add my picture")));
  if (detailsMissing()) notices.push(h("div", { class: "notice gold" },
    h("strong", { text: "Add your payment details" }),
    h("span", { text: "Your admin needs your full name, phone number and bank account to pay you." }),
    h("button", { class: "btn small primary", type: "button", dataset: { fk: "paydetails" }, onclick: () => openDetails() }, "Add my details")));
  if (notices.length) out.push(h("div", { class: "notices" }, notices));
  const ask = pushCard();
  if (ask) out.push(ask);
  const incoming = state.isAdmin ? [] : state.scripts.slice().sort((a, b) => a.at - b.at);      // an admin trying this screen sees no one's scripts
  if (incoming.length) out.push(h("section", { class: "section", id: "new-scripts" },
    h("h2", { class: "section-title", text: incoming.length === 1 ? "New script" : incoming.length + " new scripts" }),
    h("div", { class: "grid" }, incoming.map(incomingCard))));

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
  const moment = momentPanel();
  if (moment) out.push(moment);

  out.push(h("section", { class: "section" },
    h("h2", { class: "section-title", text: "In progress" }),
    active.length ? h("div", { class: "grid" }, active.map(editorCard))
      : empty("Nothing in progress.", "Got a new brief? Log it straight away. Your " + cfg.deliveryHours + "-hour deadline starts when you log it.")));

  const shown = ui.older ? done : done.slice(0, 6);
  out.push(h("section", { class: "section" },
    h("div", { class: "section-head" }, h("h2", { class: "section-title", text: "Submitted" }),
      done.some((x) => x.p.link) ? h("button", { class: "btn small", type: "button", dataset: { fk: "myvids" }, onclick: () => openVideos(uid) }, "All my videos") : null),
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
function incomingCard(sc) {
  return h("article", { class: "clip" },
    h("div", { class: "clip-top" }, tape(catOf(sc)), h("span", { class: "pills" }, pill("gold", "New"))),
    h("h3", { class: "clip-title", text: sc.name }),
    h("p", { class: "hint", text: "From your admin, " + ago(sc.at) + ". Accept it to open the script. Your " + state.config.deliveryHours + "-hour deadline starts when you do." }),
    h("div", { class: "btn-row" },
      h("button", { class: "btn primary grow", type: "button", dataset: { fk: "acc:" + sc.id }, onclick: (e) => acceptScript(e.currentTarget, sc) }, "Accept and open"),
      h("button", { class: "btn grow", type: "button", dataset: { fk: "dec:" + sc.id }, onclick: () => openDecline(sc) }, "Can't take it")));
}
// Taking a script on makes its brief, so the deadline starts now; then the script opens.
async function acceptScript(btn, sc) {
  btn.disabled = true;
  try {
    await call("er_accept_script", { p_script: sc.id });
    await sync();
    toast("Accepted. Your " + state.config.deliveryHours + "-hour deadline has started.");
    openScript(sc.id);
  } catch (e) { toast(errText(e), true); if (btn.isConnected) btn.disabled = false; }
}
function editorCard(x) {
  const p = x.p, cat = catOf(p);
  return h("article", { class: "clip" },
    h("div", { class: "clip-top" }, tape(cat), h("span", { class: "pills" }, statusPills(x, false))),
    h("h3", { class: "clip-title", text: p.name }),
    p.from ? h("p", { class: "hint", text: "Assigned to you by your admin." }) : null,
    p.backAt ? quote("Sent back by your admin " + ago(p.backAt), p.backNote || "Check the link and submit again.") : null,
    graceBar(x),
    trackBlock(p, true),
    p.update ? quote("Your last update", p.update) : null,
    metaRow(x),
    h("div", { class: "btn-row" },
      h("button", { class: "btn primary full", type: "button", dataset: { fk: "submit:" + p.id }, onclick: () => openSubmit(p) }, state.config.drive.on && state.config.drive.folders.length ? "Submit video" : "Submit with Drive link"),
      p.script ? scriptBtn(p.script, p.id) : null,
      h("button", { class: "btn grow", type: "button", dataset: { fk: "upd:" + p.id }, onclick: () => openUpdate(p) }, "Add update")));
}
function doneCard(x) {
  const p = x.p, f = x.f, cat = catOf(p), link = parseLink(p.link);
  const pay = f.received ? (f.amt != null ? "Earned " + money(f.amt) : "Received. Your admin hasn't set the amount yet.") : cat.rate != null ? money(cat.rate) + " once your admin marks it received" : null;
  return h("article", { class: "clip" },
    h("div", { class: "clip-top" }, tape(cat), h("span", { class: "pills" }, statusPills(x, false), momentPill(p))),
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
            h("span", { class: "podium-pic" }, zoomable(r.u, "xl"), h("span", { class: "rank", text: String(rank(r)) })),
            h("span", { class: "podium-name", text: name(r.u) }),
            h("span", { class: "podium-count", text: r.on + " on time" }),
            won(r.u) ? pill("gold", "Bonus") : null)))
        : h("div", { class: "slate-empty" },
            h("strong", { text: kind === "week" ? "No on-time submissions yet this week." : "No on-time submissions yet this month." }),
            h("span", { text: "Submit within " + hours + " hours of logging a brief to get on the board." }))),
    rest.length ? h("ol", { class: "rows" }, rest.map((r) => h("li", { class: "rank-row" + (r.u === me ? " me" : "") },
      h("span", { class: "rank", text: String(rank(r)) }), zoomable(r.u),
      h("span", { class: "person-name", text: name(r.u) }),
      h("span", { class: "rank-count", text: r.on + " on time" }),
      won(r.u) ? pill("gold", "Bonus") : null))) : null,
    rows.length && !state.isAdmin && !rows.some((r) => r.u === me) ? h("p", { class: "hint", text: "You're not on the board yet " + (kind === "week" ? "this week." : "this month.") }) : null));
  const awards = state.board.awards.slice(0, 8);
  if (awards.length) out.push(h("section", { class: "section" },
    h("h2", { class: "section-title", text: "Bonuses awarded" }),
    h("ul", { class: "rows" }, awards.map((x) => h("li", null,
      h("div", { class: "row-main" }, person(x.u, null, true), h("span", { class: "hint", text: x.label || "Bonus" })),
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

/* ---------- the media buyer's screen ---------- */
// Every video an admin has approved, from every category, newest first, each with a button that downloads it.
function viewVideos() {
  const out = [], all = Array.from(state.videos.values()).sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));
  const fresh = all.filter((v) => v.at > state.seenBefore).length;
  out.push(h("section", { class: "slate", "aria-label": "Finished videos" },
    h("h2", { class: "slate-title", text: "Finished videos" }),
    hero(fresh || all.length, h("span", { class: "week-of", text: fresh ? "new since your last visit" : all.length === 1 ? "video ready to download" : "videos ready to download" })),
    h("p", { class: "slate-label", text: "Every video your admin approves, from every category, newest first." })));
  const ask = pushCard();
  if (ask) out.push(ask);
  const counts = new Map();
  for (const v of all) counts.set(v.catId || "none", (counts.get(v.catId || "none") || 0) + 1);
  const cats = Array.from(state.cats.values()).filter((c) => !c.archived || counts.has(c.id));
  if (ui.bCat !== "all" && !cats.some((c) => c.id === ui.bCat) && !(ui.bCat === "none" && counts.has("none"))) ui.bCat = "all";
  const pick = h("select", { class: "input", id: "v-cat", "aria-label": "Category", dataset: { fk: "vcat" }, onchange: (e) => { ui.bCat = e.target.value; ui.bLimit = 30; schedule(); } },
    h("option", { value: "all", text: "All categories (" + all.length + ")" }),
    cats.map((c) => h("option", { value: c.id, text: c.name + " (" + (counts.get(c.id) || 0) + ")" })),
    counts.has("none") ? h("option", { value: "none", text: "No category (" + counts.get("none") + ")" }) : null);
  pick.value = ui.bCat;
  const shown = ui.bCat === "all" ? all : all.filter((v) => (v.catId || "none") === ui.bCat);
  out.push(h("section", { class: "section" },
    h("div", { class: "section-head" }, h("h2", { class: "section-title", text: "Videos" }), h("div", { class: "filter" }, pick)),
    shown.length ? h("div", { class: "grid" }, shown.slice(0, ui.bLimit).map(videoCard))
      : all.length ? empty("No videos in this category yet.", "When your admin approves one, it shows up here.")
        : empty("No finished videos yet.", "When your admin approves a video, it shows up here and your phone pings."),
    shown.length > ui.bLimit ? h("div", { class: "btn-row" }, h("button", { class: "btn small", type: "button", dataset: { fk: "vmore" }, onclick: () => { ui.bLimit += 30; schedule(); } }, "Show more")) : null));
  return out;
}
function videoCard(v) {
  const cat = v.catId ? state.cats.get(v.catId) : null, link = parseLink(v.link), dl = driveDownload(v.link), embed = link ? driveEmbed(link.href) : null;
  return h("article", { class: "clip" },
    h("div", { class: "clip-top" }, tape(cat || { name: "No category" }), h("span", { class: "pills" }, v.at > state.seenBefore ? pill("gold", "New") : null)),
    h("h3", { class: "clip-title", text: v.name }),
    h("p", { class: "hint", text: ("Approved " + ago(v.at) + (v.by ? ", made by " + v.by : "")).replace(/[^.!?]$/, "$&.") }),
    h("div", { class: "btn-row" },
      dl ? h("a", { class: "btn primary grow", href: dl, target: "_blank", rel: "noopener noreferrer", dataset: { fk: "dl:" + v.id } }, "Download")
        : link ? openLink(link, false, "v:" + v.id) : h("p", { class: "error", text: "This video has no link." }),
      embed ? h("button", { class: "btn grow", type: "button", dataset: { fk: "watch:" + v.id }, onclick: () => openPlayer({ id: v.id, name: v.name, catId: v.catId, by: v.by }, embed, link) }, "Watch") : null));
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
        h("span", { class: "hint", text: "Editors log a brief when they get it and submit with a Drive link. Each submission lands here. Briefs in progress are listed below it, newest first, then anything past its deadline." })))));
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
      stat(active.length, "In progress"), stat(past.length, "Past deadline", past.length ? "warn" : ""), stat(over, "Grace over", over ? "crit" : "")),
    h("button", { class: "btn primary", type: "button", id: "assign", dataset: { fk: "assign" }, onclick: () => openAssign() }, "Assign a script")));
  const setup = setupCard();
  if (setup) out.push(setup);
  const ask = pushCard();
  if (ask) out.push(ask);
  const moment = momentPanel();
  if (moment) out.push(moment);
  out.push(h("section", { class: "section" },
    h("div", { class: "section-head" }, h("h2", { class: "section-title", text: "Ready to download" }), waiting.length > 1 ? h("p", { class: "section-note", text: "Oldest first" }) : null),
    waiting.length ? h("div", { class: "grid" }, waiting.map(inboxCard))
      : empty("Nothing waiting.", "When an editor submits a project with a Drive link, it lands here for you to download.")));
  // scripts nobody has taken on yet: the ones turned down first, as they need the admin; then the oldest
  const scripts = state.scripts.slice().sort((a, b) => (a.status === b.status ? a.at - b.at : a.status === "declined" ? -1 : 1));
  if (scripts.length) out.push(h("section", { class: "section", id: "scripts" },
    h("div", { class: "section-head" }, h("h2", { class: "section-title", text: "Scripts not taken on yet" }),
      scripts.length > 1 ? h("p", { class: "section-note", text: scripts.some((x) => x.status === "declined") ? "Turned down first" : "Oldest first" }) : null),
    h("div", { class: "grid" }, scripts.map(scriptCard))));
  // briefs still on time, newest first, so a job an editor has just logged shows up here straight away (the
  // late ones follow, in a section of their own)
  const onTime = active.filter((x) => x.f.phase === "ontrack").sort((a, b) => b.p.startedAt - a.p.startedAt || (a.p.id < b.p.id ? 1 : -1));
  if (onTime.length) out.push(h("section", { class: "section", id: "in-progress" },
    h("div", { class: "section-head" }, h("h2", { class: "section-title", text: "In progress" }), h("p", { class: "section-note", text: onTime.length > 1 ? "On time, newest first" : "On time" })),
    h("ul", { class: "rows" }, (ui.allOnTime || onTime.length <= 10 ? onTime : onTime.slice(0, 8)).map(progressRow)),
    onTime.length > 10 ? h("div", { class: "btn-row" }, h("button", { class: "btn small", type: "button", dataset: { fk: "ontime" }, onclick: () => { ui.allOnTime = !ui.allOnTime; schedule(); } }, ui.allOnTime ? "Show fewer" : "Show all " + onTime.length)) : null));
  if (past.length) out.push(h("section", { class: "section" },
    h("div", { class: "section-head" }, h("h2", { class: "section-title", text: "Past the deadline" }), past.length > 1 ? h("p", { class: "section-note", text: "Most overdue first" }) : null),
    h("div", { class: "grid" }, past.map(pastCard))));
  return out;
}
// One line per brief in progress: what it is, who has it, how far along, and how long is left.
function progressRow(x) {
  const p = x.p, bits = [catOf(p).name, "logged " + ago(p.startedAt), p.stage === 1 ? "just started" : STAGES[p.stage - 1].toLowerCase()];
  if (p.from) bits.push("reassigned from " + displayName(p.from));
  if (p.backAt) bits.push("sent back " + ago(p.backAt));
  return h("li", null,
    h("div", { class: "row-main" },
      h("span", { class: "row-title", text: p.name }),
      h("div", { class: "row-head spread" }, person(x.uid), deadlinePill(x, false)),
      h("span", { class: "hint", text: bits.join(", ") }),
      p.update ? h("span", { class: "hint", text: "Latest update: " + p.update }) : null));
}
function scriptCard(sc) {
  const cat = catOf(sc), key = "sc:" + sc.id, declined = sc.status === "declined";
  return h("article", { class: "clip" },
    h("div", { class: "clip-top" }, tape(cat), h("span", { class: "pills" }, declined ? pill("warn", "Can't take it") : pill("", "Sent " + ago(sc.at)))),
    h("h3", { class: "clip-title", text: sc.name }),
    person(sc.uid),
    declined ? quote(displayName(sc.uid) + " couldn't take it " + ago(sc.declined || sc.at), sc.note || "They didn't say why.")
      : h("p", { class: "hint", text: "Waiting for them to accept it. Their " + state.config.deliveryHours + "-hour deadline starts when they do." }),
    h("div", { class: "btn-row" },
      h("button", { class: "btn full" + (declined ? " primary" : ""), type: "button", dataset: { fk: "mv:" + key }, onclick: () => openMoveScript(sc) }, "Give to someone else"),
      scriptBtn(sc.id, key),
      h("button", { class: "btn grow", type: "button", dataset: { fk: "wd:" + key }, onclick: () => openWithdraw(sc) }, "Take back")));
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
    h("div", { class: "clip-top" }, tape(cat), h("span", { class: "pills" }, deadlinePill(x, false), pill("info", "Submitted " + ago(p.submittedAt || p.updatedAt)), momentPill(p))),
    h("h3", { class: "clip-title", text: p.name }),
    person(uid),
    p.note ? quote("Note from the editor", p.note) : null,
    metaRow(x),
    h("p", { class: "hint", text: cat.rate != null ? "Marking it received adds " + money(cat.rate) + " to their earnings." : "No pay rate is set for this category." }),
    linkLine(link, p.link),
    h("div", { class: "btn-row" },
      link ? openLink(link, false, key) : null,
      glow(h("button", { class: "btn grow glow", type: "button", dataset: { fk: "recv:" + key }, onclick: (e) => receive(e.currentTarget, uid, p) }, "Mark received")),
      h("button", { class: "btn grow", type: "button", dataset: { fk: "back:" + key }, onclick: () => openSendBack(uid, p) }, "Send back")),
    link || p.script ? h("div", { class: "btn-row" }, link ? featureBtn(p, key) : null, p.script ? scriptBtn(p.script, key, true) : null) : null);
}
function pastCard(x) {
  const uid = x.uid, p = x.p, cat = catOf(p), key = uid + ":" + p.id;
  return h("article", { class: "clip" },
    h("div", { class: "clip-top" }, tape(cat), h("span", { class: "pills" }, statusPills(x, true))),
    h("h3", { class: "clip-title", text: p.name }),
    person(uid),
    graceBar(x),
    trackBlock(p, false),
    p.update ? quote("Latest update", p.update) : null,
    metaRow(x),
    h("div", { class: "btn-row" }, h("button", { class: "btn grow", type: "button", dataset: { fk: "re:" + key }, onclick: () => openReassign(uid, p) }, "Reassign"), p.script ? scriptBtn(p.script, key) : null));
}
function adminCard(x) {
  const uid = x.uid, p = x.p, f = x.f, cat = catOf(p), key = uid + ":" + p.id, link = parseLink(p.link), open = ui.manage === key;
  const tools = [];
  if (p.status === "active") tools.push(h("button", { class: "btn small", type: "button", dataset: { fk: "re:" + key }, onclick: () => openReassign(uid, p) }, "Reassign"));
  if (isWaiting(x)) tools.push(h("button", { class: "btn small", type: "button", dataset: { fk: "back:" + key }, onclick: () => openSendBack(uid, p) }, "Send back"));
  if (f.received) tools.push(h("button", { class: "btn small", type: "button", dataset: { fk: "amt:" + key }, onclick: () => openAmount(uid, p, f.amt) }, "Change amount"));
  if (f.received) tools.push(h("button", { class: "btn small", type: "button", dataset: { fk: "unrecv:" + key }, onclick: (e) => act(e.currentTarget, () => run("er_receive", { p_project: p.id, p_on: false }), "Moved back to the inbox") }, "Undo received"));
  if (p.status === "submitted" && link) tools.push(featureBtn(p, key));
  tools.push(h("button", { class: "btn small", type: "button", dataset: { fk: "del:" + key }, onclick: () => openDelete(uid, p) }, "Delete"));
  return h("article", { class: "clip" },
    h("div", { class: "clip-top" }, tape(cat), h("span", { class: "pills" }, statusPills(x, true), momentPill(p))),
    h("h3", { class: "clip-title", text: p.name }),
    person(uid),
    p.from ? h("p", { class: "hint", text: "Reassigned from " + displayName(p.from) }) : null,
    p.status === "reassigned" && p.movedTo ? h("p", { class: "hint", text: "Now with " + displayName(p.movedTo) }) : null,
    p.status === "active" && p.backAt ? quote("Sent back " + ago(p.backAt), p.backNote || "No reason given.") : null,
    graceBar(x),
    p.status === "active" ? trackBlock(p, false) : null,
    p.status === "active" && p.update ? quote("Latest update", p.update) : null,
    p.status === "submitted" && p.note ? quote("Note from the editor", p.note) : null,
    metaRow(x),
    f.received ? h("p", { class: "payline", text: f.amt != null ? "Paid into earnings: " + money(f.amt) : "No amount set for this video." }) : null,
    p.status === "submitted" ? linkLine(link, p.link) : null,
    h("div", { class: "btn-row" },
      p.status === "submitted" && link ? openLink(link, true, key) : null,
      p.script ? scriptBtn(p.script, key, true) : null,
      isWaiting(x) ? glow(h("button", { class: "btn small glow", type: "button", dataset: { fk: "recv:" + key }, onclick: (e) => receive(e.currentTarget, uid, p) }, "Mark received")) : null,
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
  const headline = [
    h("p", { class: "slate-label", text: "Last 10 weeks, all categories" }),
    hero(tot.on, h("span", { class: "week-of", text: (sent ? "of " + sent + " " : "") + (sent === 1 ? "video" : "videos") + " submitted on time" }))];
  if (sent) headline.push(splitBar(tot.on, tot.late, sent));
  headline.push(h("dl", { class: "fields three" },
    stat(tot.late, "Late", tot.late ? "warn" : ""), stat(tot.late ? span(tot.lateSum / tot.late) : "–", "Average delay"), stat(tot.open, "Past deadline", tot.open ? "warn" : "")));
  P.head.replaceChildren.apply(P.head, headline);
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
  const who = state.users.get(s.uid);
  if (who && who.role === "editor" && !who.pay) chips.push(pill("", "No payment details"));
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
      h("button", { class: "btn small", type: "button", dataset: { fk: "profile:" + s.uid }, onclick: () => openProfile(s.uid) }, "Profile"),
      h("button", { class: "btn small", type: "button", dataset: { fk: "vids:" + s.uid }, onclick: () => openVideos(s.uid) }, "Videos"),
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
  // Deadlines, and pay and targets, each have a Save changes button that saves only what is in that panel. It
  // lights up, with a note beside it, while a box in the panel differs from what is saved (fillSettings keeps
  // a note of that on each box, and leaves alone a box someone has changed but not saved yet).
  const savePanel = (id, heading, fields, read) => {
    const btn = h("button", { class: "btn", type: "submit", id: id, "aria-describedby": heading }, "Save changes");
    const note = h("span", { class: "unsaved", text: "Not saved yet", hidden: true });
    const P = { fields: fields, btn: btn, note: note };
    P.dirty = () => fields.some((el) => el.value.trim() !== (el.dataset.saved || ""));
    P.node = h("form", { class: "panel", novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      if (btn.disabled) return;
      const c = state.config, now = { d: c.deliveryHours, g: c.graceHours, t: c.weeklyTarget, cur: c.currency, b: state.prefs.bonusAmount };
      const v = read(Object.assign({}, now));
      if (!v) return;
      for (const el of fields) el.value = v.show(el);     // as it will be saved: 12.0 is 12
      showDirty();
      if (v.d === now.d && v.g === now.g && v.t === now.t && v.cur === now.cur && v.b === now.b) { toast("No changes to save."); return; }
      btn.disabled = true;
      try {
        await run("er_save_settings", { p_delivery: v.d, p_grace: v.g, p_target: v.t, p_currency: v.cur, p_bonus: v.b });
        toast(v.g !== now.g ? "Changes saved. Briefs in progress now have " + (v.g ? "a grace period of " + plural(v.g, "hour", "hours") + "." : "no grace period.") : "Changes saved");
      } catch (ex) { toast(errText(ex), true); }
      btn.disabled = false;
      showDirty();
    } });
    P.fill = (kids) => { add(P.node, kids); add(P.node, h("div", { class: "btn-row save" }, btn, note)); return P.node; };
    return P;
  };
  const bad = (el, msg) => { toast(msg, true); el.focus(); return null; };
  const deadlines = savePanel("save-deadlines", "deadlines-title", [delivery, grace], (v) => {
    const d = Math.round(Number(delivery.value)), g = Math.round(Number(grace.value));
    if (delivery.value.trim() === "" || !(d >= 1 && d <= 720)) return bad(delivery, "Enter a delivery time between 1 and 720 hours.");
    if (grace.value.trim() === "" || !(g >= 0 && g <= 720)) return bad(grace, "Enter a grace period between 0 and 720 hours.");
    return Object.assign(v, { d: d, g: g, show: (el) => String(el === delivery ? d : g) });
  });
  const payPanel = savePanel("save-pay", "pay-title", [currency, bonus, target], (v) => {
    const t = target.value.trim() === "" ? null : Math.round(Number(target.value)), rawB = bonus.value.trim(), b = rawB ? parseAmount(rawB) : null;
    if (t != null && !(t >= 1 && t <= 999)) return bad(target, "Enter a weekly target between 1 and 999, or leave it empty.");
    if (rawB && b == null) return bad(bonus, "Enter the bonus as a number, or leave it empty.");
    const cur = currency.value.trim();
    return Object.assign(v, { t: t, cur: cur, b: b, show: (el) => (el === currency ? cur : el === bonus ? (b == null ? "" : String(b)) : t == null ? "" : String(t)) });
  });
  const showDirty = () => { for (const P of [deadlines, payPanel]) { const d = P.dirty(); P.btn.classList.toggle("primary", d); P.note.hidden = !d; } };
  for (const el of [delivery, grace, target, currency, bonus]) el.addEventListener("input", showDirty);
  const drive = h("div", { class: "panel", id: "drive-panel" });
  const driveSection = h("section", { class: "section" }, h("h2", { class: "section-title", text: "Google Drive" }), drive);
  const picStatus = h("p", { class: "hint", id: "pic-status" }), payStatus = h("p", { class: "hint", id: "pay-status" }), lateStatus = h("p", { class: "hint", id: "late-status" });
  const remBox = h("section", { class: "section" },
    h("h2", { class: "section-title", text: "Reminders" }),
    h("div", { class: "panel" },
      h("p", null, "Remind editors to add a profile picture, add their payment details, or submit videos that are past their deadline. Each reminder goes only to the editors who haven't done it yet: to their phone if they have notifications on, and to their home screen until it's done."),
      h("ul", { class: "rem-list" },
        h("li", null, h("span", { class: "row-title", text: "Profile picture" }), picStatus),
        h("li", null, h("span", { class: "row-title", text: "Payment details" }), payStatus),
        h("li", null, h("span", { class: "row-title", text: "Late videos" }), lateStatus)),
      h("div", { class: "btn-row" }, h("button", { class: "btn", type: "button", id: "send-reminder", onclick: () => openRemind() }, "Send a reminder"))));
  const tryBox = h("section", { class: "section" },
    h("h2", { class: "section-title", text: "Try the editor screen" }),
    h("div", { class: "panel" },
      h("p", null, "See what your editors see, including their leaderboard and earnings. Anything you log there is saved under your name, and you can delete it from Projects afterwards."),
      h("div", { class: "btn-row" }, h("button", { class: "btn", type: "button", id: "try-editor", onclick: () => { ui.view = "editor"; ui.etab = "work"; window.scrollTo(0, 0); schedule(); } }, "Open the editor screen"))));
  setPanel = {
    node: h("div", { class: "stack" },
      h("section", { class: "section" },
        h("div", { class: "section-head" }, h("h2", { class: "section-title", text: "Team logins" }), h("button", { class: "btn small primary", type: "button", id: "add-user", onclick: () => openAddUser() }, "Add a login")),
        h("p", { class: "section-note", text: "Each person signs in with the username and password you give them." }),
        teamList),
      h("section", { class: "section" },
        h("h2", { class: "section-title", text: "Video categories and pay" }),
        h("p", { class: "section-note", text: "Editors pick a category for every brief. Its pay is added to their earnings when you mark the video received." }),
        list, form),
      h("section", { class: "section" },
        h("h2", { class: "section-title", id: "deadlines-title", text: "Deadlines" }),
        deadlines.fill([
          h("div", { class: "field-grid" },
            h("div", { class: "field" }, h("label", { for: "set-delivery", text: "Delivery time (hours)" }), delivery, h("p", { class: "hint", text: "Counted from the moment an editor logs a brief. Alerts start when it runs out." })),
            h("div", { class: "field" }, h("label", { for: "set-grace", text: "Grace period (hours)" }), grace, h("p", { class: "hint", text: "When this also runs out, the project is flagged for you to reassign." }))),
          h("p", { class: "hint", text: "A new grace period applies straight away, to briefs already in progress too. A new delivery time applies to briefs logged from then on, so deadlines already running don't move." })])),
      h("section", { class: "section" },
        h("h2", { class: "section-title", id: "pay-title", text: "Pay and targets" }),
        payPanel.fill([
          h("div", { class: "field-grid" },
            h("div", { class: "field" }, h("label", { for: "set-currency", text: "Currency symbol" }), currency),
            h("div", { class: "field" }, h("label", { for: "set-bonus", text: "Usual bonus amount" }), bonus, h("p", { class: "hint", text: "Filled in for you when you award a bonus. Only admins see it." })),
            h("div", { class: "field" }, h("label", { for: "set-target", text: "Weekly target per editor (videos)" }), target, h("p", { class: "hint", text: "Optional. Weeks run Monday to Sunday." })))])),
      driveSection,
      remBox,
      tryBox),
    teamList: teamList, list: list, delivery: delivery, grace: grace, target: target, currency: currency, bonus: bonus, picStatus: picStatus, payStatus: payStatus, lateStatus: lateStatus,
    showDirty: showDirty, drive: drive,
  };
  return setPanel;
}
// Settings: the studio's Google Drive, and the folders editors may upload to.
function driveSettings() {
  const d = state.config.drive;
  if (!d.on) {
    return [
      h("p", { text: d.lost ? "Google ended the Drive connection, so editors can't upload right now. Connect it again to carry on; the folder list is kept."
        : "Connect the studio's Google Drive and editors can upload finished videos straight into folders you choose, instead of sending links. The app can only see those folders and the videos it puts there." }),
      d.lost && d.folders.length ? h("p", { class: "hint", text: "Folders on the list: " + d.folders.map((f) => f.name).join(", ") + "." }) : null,
      h("div", { class: "btn-row" }, h("button", { class: "btn primary", type: "button", id: "drive-connect", dataset: { fk: "drive-connect" }, onclick: (e) => driveConnect(e.currentTarget) }, d.lost ? "Connect again" : "Connect Google Drive"))];
  }
  const rows = d.folders.length ? d.folders.map((f) => h("li", null,
    h("div", { class: "row-main" }, h("span", { class: "row-title", text: f.name })),
    h("div", { class: "row-actions" }, h("button", { class: "btn small", type: "button", dataset: { fk: "dfolder:" + f.id }, "aria-label": "Remove " + f.name, onclick: (e) => act(e.currentTarget, () => run("er_drive_remove_folder", { p_folder: f.id }), "Folder taken off the list. It stays in your Drive.") }, "Remove"))))
    : [h("li", { class: "rows-empty", text: "No folders yet. Add the folders editors should upload to." })];
  return [
    h("p", null, "Connected to ", h("strong", { text: d.email || "your Google account" }), ". Editors can upload to these folders:"),
    h("ul", { class: "rows" }, rows),
    h("p", { class: "hint", text: "Anyone with an uploaded video's link can watch it, like the links editors send now, so it plays in the app. Adding folders works best on a computer." }),
    h("div", { class: "btn-row" },
      h("a", { class: "btn primary", id: "drive-add", href: "drive-folders.html", dataset: { fk: "drive-add" } }, "Add folders"),
      h("button", { class: "btn", type: "button", id: "drive-off", dataset: { fk: "drive-off" }, onclick: () => openDriveOff() }, "Disconnect"))];
}
async function driveConnect(btn) {
  btn.disabled = true;
  try {
    const r = await driveCall("connect", { back: location.origin + location.pathname });
    location.href = r.url;            // Google's own sign-in; it sends the admin back here
  } catch (e) { toast(driveErr(e), true); btn.disabled = false; }
}
function openDriveOff() {
  formSheet({
    title: "Disconnect Google Drive", submit: "Disconnect", danger: true,
    body: [h("p", { text: "Editors won't be able to upload until you connect it again. Videos already uploaded stay in your Drive, and the folder list is kept." })],
    run: async () => {
      try { await driveCall("disconnect"); } catch (e) { throw new Oops(driveErr(e)); }
      await sync();
      return "Google Drive disconnected";
    },
  });
}
function teamRow(u) {
  const me = state.me, manage = u.id !== me.id && !u.owner && (u.role !== "admin" || me.owner);
  return h("li", null,
    h("div", { class: "row-main" },
      h("div", { class: "row-head" }, person(u.id), u.owner ? pill("info", "Owner") : u.role === "admin" ? pill("info", "Admin") : u.role === "buyer" ? pill("info", "Media buyer") : null, u.active ? null : pill("warn", "Switched off")),
      h("span", { class: "hint", text: "@" + u.username + (u.seen ? ", last seen " + ago(u.seen) : ", hasn't signed in yet") + (u.push ? ", notifications on" : "") })),
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
  // Each box follows the saved setting, unless it holds a change that hasn't been saved yet.
  const put = (el, v) => {
    const was = el.dataset.saved;
    if ((was == null || el.value.trim() === was) && el.value !== v) el.value = v;
    el.dataset.saved = v;
  };
  put(S.delivery, String(cfg.deliveryHours)); put(S.grace, String(cfg.graceHours));
  put(S.target, cfg.weeklyTarget == null ? "" : String(cfg.weeklyTarget));
  put(S.currency, cfg.currency);
  put(S.bonus, state.prefs.bonusAmount == null ? "" : String(state.prefs.bonusAmount));
  S.showDirty();
  const eds = Array.from(state.users.values()).filter((u) => u.role === "editor" && u.active), R = reminderTargets();
  const last = (at) => (at ? " Last reminded " + stamp(at) + "." : "");
  S.picStatus.textContent = (eds.length - R.picture.ids.length) + " of " + eds.length + " editors have a picture." + last(cfg.picAsk);
  S.payStatus.textContent = (eds.length - R.details.ids.length) + " of " + eds.length + " editors have added theirs." + last(cfg.detailsAsk);
  S.drive.replaceChildren.apply(S.drive, driveSettings().filter(Boolean));
  S.lateStatus.textContent = (R.overdue.videos ? plural(R.overdue.videos, "video", "videos") + " past the deadline, from " + plural(R.overdue.ids.length, "editor", "editors") + "." : "No videos are past their deadline.") + last(cfg.lateAsk);
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
function closeSheet(force) {
  if (!sheet.open || (sheetHold && force !== true)) return;
  try { sheet.close(); } catch (e) { sheet.removeAttribute("open"); sheetClosed(); }
}
sheet.addEventListener("close", sheetClosed);
sheet.addEventListener("cancel", (e) => { if (sheetHold) e.preventDefault(); });
sheet.addEventListener("click", (e) => { if (e.target === sheet) closeSheet(); });

// A featured video plays here, on a black screen of its own, in Drive's player. The page's security rules
// allow a frame from Drive and nothing else.
const player = $("player");
let playerFrom = null, playerKey = null;
function drivePlayer(src, name) {
  return h("iframe", { class: "player-frame", src: src, title: "Video: " + name, allow: "autoplay; picture-in-picture; encrypted-media", allowfullscreen: true, referrerpolicy: "strict-origin-when-cross-origin" });
}
// The black screen that plays a video or shows a picture full size: what it is on top, then the thing itself.
function showScreen(title, byline, stage, foot) {
  if (!player.open) {
    const a = document.activeElement;
    playerFrom = a && a !== document.body ? a : null;
    playerKey = playerFrom && playerFrom.dataset ? playerFrom.dataset.fk || null : null;
  }
  const parts = [
    h("div", { class: "player-top" },
      h("div", { class: "player-head" }, h("h2", { class: "player-title", id: "player-title", text: title }), byline),
      h("button", { class: "btn small player-close", type: "button", onclick: closePlayer }, icon("close", 18, 2.4), "Close")),
    h("div", { class: "player-stage" }, stage)];
  if (foot) parts.push(foot);
  player.replaceChildren.apply(player, parts);
  player.classList.toggle("no-foot", !foot);
  if (!player.open) { try { player.showModal(); } catch (e) { player.setAttribute("open", ""); } }
  seatToast();
  player.querySelector(".player-close").focus();
}
function openPlayer(x, embed, link) {
  const cat = x.catId ? state.cats.get(x.catId) : null, mine = x.uid === state.me.id;
  showScreen(x.name,
    h("p", { class: "player-by" }, x.uid ? avatar(x.uid) : null, h("span", { text: x.uid ? displayName(x.uid) + (mine ? " (you)" : "") : x.by || "" }), cat ? h("span", { class: "shot-cat", text: cat.name }) : null),
    [h("p", { class: "player-wait", text: "Loading the video…" }), drivePlayer(embed, x.name)],
    h("div", { class: "player-foot" },
      h("span", { text: "Not playing? Its Drive file may not be shared with you." }),
      h("a", { class: "btn small", href: link.href, target: "_blank", rel: "noopener noreferrer" }, "Open in Google Drive", icon("out", 16, 2.6))));
}
// A teammate's picture, full size. The small copy shows at once; the large one replaces it when it arrives.
const bigPics = new Map();        // user id -> { ver, url }
function openPic(uid) {
  const u = state.users.get(uid), ver = u ? u.av : uid === state.me.id ? state.me.av : 0, pic = pics.get(uid), have = bigPics.get(uid);
  const img = h("img", { class: "pic-full", alt: "Profile picture of " + displayName(uid), src: have && have.ver === ver ? have.url : pic ? pic.url : "" });
  showScreen(displayName(uid) + (uid === state.me.id ? " (you)" : ""), null, img, null);
  if (have && have.ver === ver) return;
  call("er_avatar_full", { p_user: uid }).then((r) => {
    if (!r || typeof r.url !== "string" || !/^data:image\/(jpeg|png|webp);base64,/.test(r.url)) return;
    bigPics.set(uid, { ver: num(r.ver) == null ? ver : num(r.ver), url: r.url });
    if (img.isConnected) img.src = r.url;
  }).catch(() => { /* the small copy stays */ });
}
function playerClosed() {
  if (player.open) return;
  player.replaceChildren();        // the frame goes with it, so the sound stops
  seatToast();
  let el = playerFrom && playerFrom.isConnected ? playerFrom : null;
  if (!el && playerKey) el = document.querySelector('[data-fk="' + esc(playerKey) + '"]');
  if (el) el.focus({ preventScroll: true });
  playerFrom = null; playerKey = null;
}
function closePlayer() {
  if (!player.open) return;
  try { player.close(); } catch (e) { player.removeAttribute("open"); }
  playerClosed();        // straight away, rather than when the browser gets round to the close event
}
player.addEventListener("close", playerClosed);

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
// Submitting a finished video. With the studio's Google Drive connected, the editor uploads it straight into a
// folder there; pasting a Drive link always works too.
function openSubmit(p) {
  const d = state.config.drive;
  if (!(d.on && d.folders.length)) return openLinkSubmit(p);
  let mode = "upload", chosen = null;
  const before = savedUpload(p.id);
  const modeBtn = (m, label) => h("button", { type: "button", "aria-pressed": String(m === mode), dataset: { mode: m }, onclick: () => setMode(m) }, label);
  const seg = h("div", { class: "seg", role: "group", "aria-label": "How to send the video" }, modeBtn("upload", "Upload the video"), modeBtn("link", "Paste a link"));
  // uploading
  const folder = h("select", { class: "input", id: "s-folder" }, h("option", { value: "", text: "Choose a folder" }), d.folders.map((f) => h("option", { value: f.id, text: f.name })));
  folder.value = before && d.folders.some((f) => f.id === before.folder) ? before.folder : guessFolder(p, d.folders);
  const file = h("input", { class: "vh", id: "s-file", type: "file", accept: "video/*", "aria-label": "Choose the video", tabindex: "-1" });
  const choose = h("button", { class: "btn", type: "button", id: "s-choose", onclick: () => file.click() }, "Choose the video");
  const info = h("p", { class: "hint", id: "s-file-info", text: before ? "You started uploading " + before.name + " (" + bytes(before.size) + "). Choose the same video to carry on from where it stopped."
    : "The finished video, straight from your phone or computer." });
  file.addEventListener("change", () => {
    chosen = file.files && file.files[0] ? file.files[0] : null;
    if (!chosen) return;
    choose.textContent = "Choose another video";
    info.textContent = chosen.name + ", " + bytes(chosen.size) + (sameFile(savedUpload(p.id), chosen) ? ". It carries on from where the last upload stopped." : ".");
    err.hidden = true;
  });
  const uploadPane = h("div", { class: "form" }, field("Folder in your admin's Google Drive", folder),
    h("div", { class: "field" }, h("label", { for: "s-file", text: "Video" }), h("div", { class: "btn-row" }, choose), info, file));
  // pasting a link
  const link = h("input", { class: "input", id: "s-link", type: "url", inputmode: "url", autocomplete: "off", autocapitalize: "off", spellcheck: "false", placeholder: "https://drive.google.com/…" });
  const warn = h("p", { class: "warnline", hidden: true, text: "This doesn't look like a Google Drive link. You can still send it." });
  link.addEventListener("input", () => { const r = readLink(link.value); warn.hidden = !(r && !r.google); });
  const linkPane = h("div", { class: "form", hidden: true }, field("Google Drive link", link, "Paste the share link to the finished video, and check that your admin has access to the file. The link can't be changed after you submit."), warn);
  const note = h("textarea", { class: "input", id: "s-note", maxlength: "300", rows: "3" });
  // how the upload is going
  const fill = h("i"), meter = h("div", { class: "meter upload-meter", role: "progressbar", "aria-label": "Upload progress", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": "0" }, fill);
  const upName = h("p", { class: "upload-name" }), upLine = h("p", { class: "upload-line", id: "s-progress" });
  const progress = h("div", { class: "upload", hidden: true }, upName, meter, upLine,
    h("p", { class: "hint", text: "Keep this screen open until it finishes. If the connection drops, it carries on from where it stopped." }));
  const err = h("p", { class: "error", role: "alert", hidden: true });
  const go = h("button", { class: "btn primary grow wide", type: "submit", id: "s-go" }, "Upload and submit");
  const cancel = h("button", { class: "btn grow", type: "button", id: "s-cancel", onclick: () => (activeUpload ? activeUpload.stop() : closeSheet()) }, "Cancel");
  const fields = h("div", { class: "form" }, seg, uploadPane, linkPane, field("Note for your admin (optional)", note));
  const form = h("form", { class: "form", novalidate: true, oninput: () => { err.hidden = true; }, onsubmit: (e) => { e.preventDefault(); submit(); } },
    h("p", null, h("strong", { text: p.name })), fields, progress, err, h("div", { class: "btn-row" }, go, cancel));
  function setMode(m) {
    mode = m;
    for (const b of seg.children) b.setAttribute("aria-pressed", String(b.dataset.mode === m));
    uploadPane.hidden = m !== "upload"; linkPane.hidden = m !== "link";
    go.textContent = m === "upload" ? "Upload and submit" : "Submit project";
    err.hidden = true;
  }
  const fail = (msg) => { err.textContent = msg; err.hidden = false; };
  async function submit() {
    if (activeUpload || go.disabled) return;
    err.hidden = true;
    if (mode === "link") {
      const r = readLink(link.value);
      if (!r) return fail("Paste the full Google Drive link to your finished video.");
      go.disabled = true;
      try { await run("er_submit", { p_project: p.id, p_link: r.href, p_note: note.value.trim() }); closeSheet(); toast("Submitted. It's now in your admin's inbox."); }
      catch (ex) { fail(errText(ex)); go.disabled = false; }
      return;
    }
    if (!folder.value) return fail("Choose the folder to upload to.");
    if (!chosen) return fail("Choose the video to upload.");
    try { localStorage.setItem("editroom.driveFolder", folder.value); } catch (e) { /* the folder isn't remembered for next time */ }
    await upload(chosen, folder.value);
  }
  async function upload(f, where) {
    const total = f.size, ctl = new AbortController();
    let sent = 0, since = Date.now(), from = 0;
    const show = (n, words) => {
      if (n != null) sent = n;
      const pct = Math.min(100, Math.floor((100 * sent) / total));
      fill.style.width = pct + "%";
      meter.setAttribute("aria-valuenow", String(pct));
      upLine.textContent = words || bytes(sent) + " of " + bytes(total) + " uploaded (" + pct + "%)" + timeLeft();
    };
    const timeLeft = () => {
      const secs = (Date.now() - since) / 1000, rate = (sent - from) / secs;
      if (secs < 8 || !(rate > 0)) return "";
      const left = (total - sent) / rate;
      return left >= 90 ? ", about " + Math.round(left / 60) + " min left" : left > 15 ? ", about a minute left" : "";
    };
    activeUpload = { stop: () => ctl.abort() };
    sheetHold = true; holdAwake(true);
    fields.hidden = true; progress.hidden = false; go.hidden = true; err.hidden = true; cancel.textContent = "Stop upload";
    upName.textContent = f.name + ", " + bytes(total);
    show(0, "Getting ready…");
    try {
      // carry on with the upload this video already started, if Google still has it; otherwise start one
      let up = null, offset = 0;
      const prev = savedUpload(p.id);
      if (prev && sameFile(prev, f) && prev.folder === where) {
        try {
          const st = await driveCall("status", { upload: prev.upload });
          up = prev; offset = st.done || st.complete ? total : Number(st.offset) || 0;
        } catch (e) {
          if (e.code === "offline") throw e;
          keepUpload(p.id, null);
        }
      }
      if (!up) {
        const r = await driveCall("start", { project: p.id, folder: where, size: total, type: f.type || "", ext: (/\.([A-Za-z0-9]{1,8})$/.exec(f.name) || [])[1] || "" });
        up = { upload: r.upload, url: r.url, name: f.name, size: total, modified: f.lastModified, folder: where, at: Date.now() };
        keepUpload(p.id, up);
      }
      from = offset; since = Date.now();
      show(offset);
      const made = await sendPieces(up, f, offset, (n) => show(n), () => show(null, "The connection dropped. Trying again…"), ctl.signal);
      show(total, "Checking the video in Drive…");
      await driveCall("finish", { upload: up.upload, file: made || undefined, note: note.value.trim() });
      keepUpload(p.id, null);
      activeUpload = null; sheetHold = false; holdAwake(false);
      closeSheet(true);
      toast("Uploaded and submitted. The video is in your admin's Google Drive.");
      sync();
    } catch (e) {
      activeUpload = null; sheetHold = false; holdAwake(false);
      if (!form.isConnected) return;            // the sheet has gone (signed out)
      fields.hidden = false; progress.hidden = true; go.hidden = false; cancel.textContent = "Cancel";
      if (e.code === "expired") keepUpload(p.id, null);
      if (e.code === "stopped") {
        go.textContent = "Carry on uploading";
        info.textContent = "Upload stopped at " + bytes(sent) + " of " + bytes(total) + ". Press Carry on uploading, or come back later and choose the same video.";
        return;
      }
      go.textContent = "Try again";
      fail(driveErr(e));
    }
  }
  openSheet("Submit project", [form]);
}
const UPLOAD_PIECE = 8 * 1024 * 1024;        // a video goes to Google a piece at a time; Google asks for multiples of 256 KB
let activeUpload = null, sheetHold = false;   // while a video uploads, its sheet stays open until the upload is stopped
// The upload this brief started on this phone, kept so it can carry on after the app is closed. Google keeps
// an unfinished upload for a week.
const upKey = (pid) => "editroom.upload." + pid;
function savedUpload(pid) {
  try {
    const v = JSON.parse(localStorage.getItem(upKey(pid)) || "null");
    return v && typeof v.upload === "string" && typeof v.url === "string" && Date.now() - Number(v.at) < 6 * DAY ? v : null;
  } catch (e) { return null; }
}
function keepUpload(pid, v) {
  try { if (v) localStorage.setItem(upKey(pid), JSON.stringify(v)); else localStorage.removeItem(upKey(pid)); }
  catch (e) { /* carrying on after the app is closed won't be offered */ }
}
const sameFile = (v, f) => !!v && !!f && v.name === f.name && v.size === f.size && v.modified === f.lastModified;
function bytes(n) {
  if (n < 1e6) return (n > 0 ? Math.max(1, Math.round(n / 1e3)) : 0) + " KB";
  if (n < 1e9) return (n < 1e7 ? (n / 1e6).toFixed(1) : Math.round(n / 1e6)) + " MB";
  return (n / 1e9).toFixed(n < 1e10 ? 2 : 1) + " GB";
}
// The folder named like the brief's category, else the one this editor used last, else none: they choose.
function guessFolder(p, folders) {
  const cat = catOf(p).name.toLowerCase();
  const byCat = folders.find((f) => f.name.toLowerCase() === cat) || folders.find((f) => cat.length > 2 && f.name.toLowerCase().includes(cat));
  if (byCat && catOf(p).id) return byCat.id;
  let last = null;
  try { last = localStorage.getItem("editroom.driveFolder"); } catch (e) { /* nothing remembered */ }
  return folders.some((f) => f.id === last) ? last : "";
}
// Sends the video from where Google's copy ends, a piece at a time. Each piece says where it starts; Google
// answers 308 with how much it has, or 200 once it has the lot. When the line drops, it waits a little longer
// each time, asks how much arrived, and carries on from there.
async function sendPieces(up, f, offset, onSent, onWait, signal) {
  let tries = 0;
  for (;;) {
    if (signal.aborted) throw new ApiError("stopped", 0);
    if (offset >= f.size) return null;            // Google has it all; the function finds the file
    const end = Math.min(offset + UPLOAD_PIECE, f.size), at = offset;
    let r = null;
    try { r = await putPiece(up.url, f.slice(at, end), at, f.size, (n) => onSent(at + n), signal); }
    catch (e) { if (e.code === "stopped") throw e; }
    if (r && r.status === 308) {
      tries = 0;
      const m = /bytes=0-(\d+)/.exec(r.range || "");
      offset = m ? Number(m[1]) + 1 : end;
      onSent(offset);
      continue;
    }
    if (r && (r.status === 200 || r.status === 201)) {
      let made = null;
      try { made = JSON.parse(r.text); } catch (e) { /* the function will find it */ }
      return made && typeof made.id === "string" ? made.id : null;
    }
    if (r && (r.status === 404 || r.status === 410)) throw new ApiError("expired", r.status);
    if (++tries > 8) throw new ApiError(r ? "google" : "offline", r ? r.status : 0);
    onWait(tries);
    await pause(Math.min(30000, 1000 * 2 ** tries), signal);
    try {
      const st = await driveCall("status", { upload: up.upload });
      offset = st.done || st.complete ? f.size : Number(st.offset) || 0;
    } catch (e) {
      if (e.code !== "offline" && e.code !== "google" && e.code !== "server") throw e;      // still no line: try the piece again
    }
  }
}
function putPiece(url, blob, from, total, onSent, signal) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    const quit = () => x.abort();
    x.open("PUT", url);
    x.timeout = 180000;
    x.setRequestHeader("Content-Range", "bytes " + from + "-" + (from + blob.size - 1) + "/" + total);
    x.upload.onprogress = (e) => onSent(e.loaded);
    x.onload = () => { signal.removeEventListener("abort", quit); resolve({ status: x.status, range: x.getResponseHeader("Range"), text: x.responseText }); };
    x.onerror = x.ontimeout = () => { signal.removeEventListener("abort", quit); reject(new ApiError("offline", 0)); };
    x.onabort = () => reject(new ApiError("stopped", 0));
    signal.addEventListener("abort", quit, { once: true });
    x.send(blob);
  });
}
const pause = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(t); reject(new ApiError("stopped", 0)); }, { once: true });
});
// Keeps the screen on while a video uploads, where the phone allows it; a sleeping phone stops sending.
let wakeLock = null, wantAwake = false;
async function holdAwake(on) {
  wantAwake = on;
  try {
    if (on && !wakeLock && navigator.wakeLock && document.visibilityState === "visible") {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } else if (!on && wakeLock) { const l = wakeLock; wakeLock = null; await l.release(); }
  } catch (e) { /* the screen may sleep; the upload carries on when it's back */ }
}
document.addEventListener("visibilitychange", () => { if (wantAwake && document.visibilityState === "visible") holdAwake(true); });
window.addEventListener("beforeunload", (e) => { if (sheetHold) { e.preventDefault(); e.returnValue = ""; } });
function openLinkSubmit(p) {
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
// Sending scripts: one or several files, a category and an editor. Each file is saved in the DN Studios scripts
// folder in the studio's Google Drive, and the editor's phone pings; their deadline starts when they accept it.
function openAssign() {
  const d = state.config.drive, cats = state.config.categories, hours = state.config.deliveryHours, eds = activeEditors();
  if (!d.on || !eds.length) {
    formSheet({ title: "Assign a script", submit: null, body: [
      h("p", { text: !d.on ? "Scripts are kept in your Google Drive, not in the app. Connect Google Drive in Settings first." : "Add an editor in Settings first. Scripts go to editors." }),
      h("div", { class: "btn-row" }, h("button", { class: "btn primary grow", type: "button", id: "as-settings", onclick: () => { closeSheet(); setTab("settings"); } }, "Open Settings"))] });
    return;
  }
  let files = [];
  const file = h("input", { class: "vh", id: "as-file", type: "file", multiple: true, accept: SCRIPT_ACCEPT, "aria-label": "Choose the script", tabindex: "-1" });
  const choose = h("button", { class: "btn", type: "button", id: "as-choose", onclick: () => file.click() }, "Choose the script");
  const info = h("p", { class: "hint", id: "as-file-info", text: "A Word document, PDF or text file, up to 10 MB. Choose several to send them all to the same editor." });
  const name = h("input", { class: "input", id: "as-name", type: "text", maxlength: "120", autocomplete: "off" });
  const nameField = field("Brief name", name, "What the brief will be called. It starts as the file's name.");
  const cat = h("select", { class: "input", id: "as-cat" }, h("option", { value: "", text: cats.length ? "Choose a category" : "No categories yet" }), cats.map((c) => h("option", { value: c.id, text: c.name })));
  const err = h("p", { class: "error", role: "alert", hidden: true });
  const fail = (msg) => { err.textContent = msg; err.hidden = false; };
  const go = h("button", { class: "btn primary grow", type: "submit", id: "as-go" }, "Send script");
  file.addEventListener("change", () => {
    const picked = Array.from(file.files || []);
    file.value = "";
    if (!picked.length) return;
    files = picked.slice(0, 10);
    choose.textContent = files.length > 1 ? "Choose other scripts" : "Choose another script";
    info.textContent = files.map((f) => f.name + " (" + bytes(f.size) + ")").join(", ") + (picked.length > 10 ? ". Only the first 10 go at once." : ".");
    nameField.hidden = files.length > 1;
    if (files.length === 1) name.value = stem(files[0].name);
    go.textContent = files.length > 1 ? "Send " + files.length + " scripts" : "Send script";
    if (!cat.value) cat.value = guessCat(files[0].name);
    err.hidden = true;
  });
  const form = h("form", { class: "form", novalidate: true, oninput: () => { err.hidden = true; }, onsubmit: (e) => { e.preventDefault(); send(); } },
    h("div", { class: "field" }, h("label", { for: "as-file", text: "Script" }), h("div", { class: "btn-row" }, choose), info, file),
    nameField, field("Category", cat, cats.length ? null : "Add categories in Settings to sort scripts by them."),
    h("fieldset", { class: "field" }, h("legend", { text: "Editor" }), editorOptions("as-ed", eds)),
    h("p", { class: "hint", text: "The script is saved in the DN Studios scripts folder in your Google Drive. The editor's phone pings, and their " + hours + "-hour deadline starts when they accept it." }),
    err, h("div", { class: "btn-row" }, go, h("button", { class: "btn grow", type: "button", onclick: () => closeSheet() }, "Cancel")));
  async function send() {
    if (go.disabled) return;
    err.hidden = true;
    const pick = form.querySelector('input[name="as-ed"]:checked');
    if (!files.length) return fail("Choose the script to send.");
    if (cats.length && !cat.value) return fail("Choose a category.");
    if (!pick) return fail("Pick the editor to send it to.");
    const big = files.find((f) => f.size > SCRIPT_MAX);
    if (big) return fail(big.name + " is too big. Scripts can be up to 10 MB.");
    const to = pick.value, total = files.length;
    let sent = 0;
    go.disabled = true; sheetHold = true;
    try {
      for (const f of files.slice()) {
        go.textContent = total > 1 ? "Sending " + (sent + 1) + " of " + total + "…" : "Sending…";
        await driveCall("script_send", { editor: to, category: cat.value || null, name: total === 1 ? tidy(name.value) : "", file: { name: f.name, data: await readB64(f) } });
        sent++;
        files = files.slice(1);
      }
      sheetHold = false; closeSheet(true);
      toast((sent === 1 ? "Script sent to " : sent + " scripts sent to ") + displayName(to) + ".");
      sync();
    } catch (e) {
      sheetHold = false;
      go.disabled = false; go.textContent = files.length > 1 ? "Send the other " + files.length : "Try again";
      info.textContent = files.map((f) => f.name + " (" + bytes(f.size) + ")").join(", ") + ".";
      fail((sent ? plural(sent, "script was", "scripts were") + " sent. " : "") + (sent || total > 1 ? files[0].name + " wasn't: " : "") + scriptErr(e));
      if (sent) sync();
    }
  }
  openSheet("Assign a script", [form]);
}
function openMoveScript(sc) {
  const eds = activeEditors().filter((u) => !(sc.status === "waiting" && u.id === sc.uid));
  if (!eds.length) { formSheet({ title: "Give to someone else", submit: null, body: [h("p", { text: "There is no other editor to give it to yet. Add one in Settings first." })] }); return; }
  formSheet({
    title: "Give to someone else", submit: "Send script",
    body: [
      h("p", null, h("strong", { text: sc.name }), sc.status === "declined" ? " was turned down by " + displayName(sc.uid) + ". Pick who gets it instead." : " is waiting for " + displayName(sc.uid) + ". Pick who gets it instead."),
      h("fieldset", { class: "field" }, h("legend", { class: "vh", text: "Editor" }), editorOptions("mv-ed", eds)),
      h("p", { class: "hint", text: "Their phone pings, and their " + state.config.deliveryHours + "-hour deadline starts when they accept it. The file stays where it is in your Google Drive." })],
    run: async () => {
      const pick = sheet.querySelector('input[name="mv-ed"]:checked');
      if (!pick) throw new Oops("Pick an editor.");
      await run("er_move_script", { p_script: sc.id, p_editor: pick.value });
      return "Script sent to " + displayName(pick.value) + ".";
    },
  });
}
function openWithdraw(sc) {
  formSheet({
    title: "Take back script", submit: "Take back", danger: true,
    body: [h("p", null, "Take back ", h("strong", { text: sc.name }), sc.status === "declined" ? "? It comes off this list." : " from " + displayName(sc.uid) + "? It comes off their screen."),
      h("p", { class: "hint", text: "The file stays in the DN Studios scripts folder in your Google Drive." })],
    run: async () => { await run("er_withdraw_script", { p_script: sc.id }); return "Script taken back"; },
  });
}
function openDecline(sc) {
  const note = h("textarea", { class: "input", id: "dc-note", maxlength: "300", rows: "3" });
  formSheet({
    title: "Can't take this script", submit: "Send it back",
    body: [h("p", null, h("strong", { text: sc.name }), " goes back to your admin, who can give it to someone else. No deadline starts."),
      field("Why not? (optional, your admin sees this)", note, "For example: you already have three briefs in progress.")],
    run: async () => { await run("er_decline_script", { p_script: sc.id, p_note: note.value.trim() }); return "Sent back. Your admin has been told."; },
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
function openMoment() {
  const rows = collect().filter((x) => x.p.status === "submitted" && parseLink(x.p.link) && !isFeatured(x.p.id)).sort((a, b) => (b.p.submittedAt || 0) - (a.p.submittedAt || 0));
  const title = "Add a video of the moment";
  if (!rows.length) {
    formSheet({ title: title, submit: null, body: [h("p", { text: state.featured.length ? "Every recent finished video is already showing. Older ones can be added from Projects." : "No editor has submitted a video yet. Once one does, you can add it here." })] });
    return;
  }
  const shown = rows.slice(0, 6);
  const opts = shown.map((x, i) => h("label", { class: "option" },
    h("input", { type: "radio", name: "m-pick", id: "m-pick-" + i, value: x.p.id }),
    h("span", { class: "option-main" },
      h("span", { class: "option-name", text: x.p.name }),
      h("span", { class: "hint", text: displayName(x.uid) + ", submitted " + shortDate(x.p.submittedAt || x.p.updatedAt) }))));
  formSheet({
    title: title, submit: "Add this video",
    body: [
      h("p", { text: "It shows on everyone's home screen with the editor's name, and plays right in the app, until you take it down. Five show at most: a sixth takes the oldest one down." }),
      h("div", { class: "options", role: "radiogroup", "aria-label": "Finished videos" }, opts),
      rows.length > shown.length ? h("p", { class: "hint", text: "These are the " + shown.length + " most recent. Any other finished video can be added from Projects." }) : null,
      h("p", { class: "hint", text: "Set the Drive file to Anyone with the link so it plays for everyone." })],
    run: async () => {
      const pick = sheet.querySelector('input[name="m-pick"]:checked');
      if (!pick) throw new Oops("Pick a video.");
      const r = await run("er_feature", { p_project: pick.value, p_on: true });
      return r && r.dropped ? "Added. The oldest video came down to keep it to five." : "Now showing on everyone's home screen.";
    },
  });
}
// Every video an editor has submitted, newest first, each one playable here. An editor sees their own
// (the latest 400 are already on the phone); an admin sees anyone's, with older ones a page at a time.
function videoRow(uid, p) {
  const f = flagsOf(p), link = parseLink(p.link), embed = link ? driveEmbed(link.href) : null, cat = catOf(p), admin = ui.view === "admin";
  const x = { id: p.id, uid: uid, name: p.name, catId: p.catId, link: p.link };
  return h("li", null,
    h("div", { class: "row-main" },
      h("span", { class: "row-title", text: p.name }),
      h("span", { class: "hint", text: cat.name + ", submitted " + stamp(p.submittedAt || p.updatedAt) }),
      h("span", { class: "pills" },
        f.onTime ? pill("good", "On time") : pill("warn", "Late by " + span(f.lateBy || 0)),
        f.received ? pill("", "Received") : pill("info", admin ? "Waiting for you" : "With your admin"))),
    h("div", { class: "row-actions" },
      embed ? h("button", { class: "btn small", type: "button", dataset: { fk: "vplay:" + p.id }, onclick: () => openPlayer(x, embed, link) }, icon("play", 16), "Play")
        : link ? h("a", { class: "btn small", href: link.href, target: "_blank", rel: "noopener noreferrer" }, "Open", icon("out", 15, 2.6)) : null));
}
function openVideos(uid) {
  const admin = ui.view === "admin", seen = new Map();
  const m = state.projects.get(uid);
  if (m) for (const p of m.values()) if (p.status === "submitted" && p.link) seen.set(p.id, p);
  const note = h("p", { class: "hint" }), list = h("ul", { class: "rows vid-list" }), more = h("div", { class: "btn-row" });
  let next = null, done = !admin || !state.isAdmin, busy = false, failed = false;
  const draw = () => {
    const rows = Array.from(seen.values()).sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
    note.textContent = rows.length ? plural(rows.length, "video", "videos") + (done ? "" : " so far") + ", newest first." : busy ? "Loading…" : "";
    list.replaceChildren.apply(list, rows.length ? rows.map((p) => videoRow(uid, p)) : [h("li", { class: "rows-empty", text: busy ? "Loading…" : uid === state.me.id && !admin ? "You haven't submitted a video yet." : "No videos submitted yet." })]);
    more.replaceChildren.apply(more, done ? [] : [h("button", { class: "btn small", type: "button", disabled: busy, onclick: () => page() }, failed ? "Try again" : busy ? "Loading…" : "Show older videos")]);
  };
  const page = async () => {
    if (busy || done) return;
    busy = true; failed = false; draw();
    try {
      const r = await call("er_history", { p_before: next ? next.at : state.horizon || new Date(now()).toISOString(), p_before_id: next ? next.id : null, p_status: "submitted", p_editor: uid });
      for (const row of (r && Array.isArray(r.rows) ? r.rows : [])) { const p = normProject(row); if (p.link) seen.set(p.id, p); }
      next = r && r.next && typeof r.next.at === "string" ? { at: r.next.at, id: String(r.next.id) } : null;
      done = !next;
    } catch (e) { failed = true; }
    busy = false;
    if (list.isConnected) draw();
  };
  openSheet(uid === state.me.id && !admin ? "Your videos" : displayName(uid) + "'s videos", [note, list, more, h("div", { class: "btn-row tools" }, h("button", { class: "btn grow", type: "button", onclick: closeSheet }, "Close"))]);
  draw();
  if (!done) page();
}
// Who each reminder would reach right now, from what the admin's app already has. The server works it out
// again when one is sent.
function reminderTargets() {
  const eds = Array.from(state.users.values()).filter((u) => u.role === "editor" && u.active), late = new Map();
  for (const x of collect()) {
    const u = state.users.get(x.uid);
    if (x.p.status === "active" && x.f.phase !== "ontrack" && u && u.active) late.set(x.uid, (late.get(x.uid) || 0) + 1);
  }
  const reach = (ids) => ({ ids: ids, phones: ids.filter((id) => { const u = state.users.get(id); return u && u.push; }).length });
  return {
    picture: reach(eds.filter((u) => !u.has).map((u) => u.id)),
    details: reach(eds.filter((u) => !u.pay).map((u) => u.id)),
    overdue: Object.assign(reach(Array.from(late.keys())), { videos: Array.from(late.values()).reduce((a, b) => a + b, 0) }),
  };
}
const phonesOn = (n, ph) => n === 1 ? (ph ? "They have notifications on." : "They haven't turned notifications on yet.")
  : ph ? ph + " of them " + (ph === 1 ? "has" : "have") + " notifications on." : "None of them has notifications on yet.";
function openRemind() {
  const T = reminderTargets(), cfg = state.config, eds = (n) => (n === 1 ? "The 1 editor" : "The " + n + " editors");
  const choices = [
    ["picture", "Profile picture", T.picture, (n) => eds(n) + " who don't have a picture yet.", cfg.picAsk, "Every editor has a picture."],
    ["details", "Payment details", T.details, (n) => eds(n) + " who haven't added theirs.", cfg.detailsAsk, "Every editor has added their payment details."],
    ["overdue", "Submit late videos", T.overdue, (n) => eds(n) + " with " + plural(T.overdue.videos, "video", "videos") + " past the deadline.", cfg.lateAsk, "No videos are past their deadline right now."]];
  const opts = choices.map(([kind, name, t, who, last, none]) => {
    const n = t.ids.length;
    return h("label", { class: "option" },
      h("input", { type: "radio", name: "rem-kind", id: "rem-" + kind, value: kind, disabled: n === 0 }),
      h("span", { class: "option-main" },
        h("span", { class: "option-name", text: name }),
        h("span", { class: "hint", text: n ? who(n) : none }),
        n ? h("span", { class: "hint", text: phonesOn(n, t.phones) + (last ? " Last sent " + stamp(last) + "." : "") }) : null));
  });
  formSheet({
    title: "Send a reminder", submit: "Send reminder",
    body: [
      h("p", { text: "Pick one. It goes only to the editors who haven't done it yet. Those with notifications on get it on their phone, and each of them sees it on their home screen." }),
      h("div", { class: "options", role: "radiogroup", "aria-label": "Reminder" }, opts)],
    run: async () => {
      const pick = sheet.querySelector('input[name="rem-kind"]:checked');
      if (!pick) throw new Oops("Pick the reminder to send.");
      const r = await run("er_remind", { p_kind: pick.value }), n = (r && r.editors) || 0, ph = (r && r.phones) || 0;
      if (r && r.again) return "You sent that reminder a few minutes ago, so nothing new went out.";
      if (!n) return "Nobody needs that reminder right now.";
      return n === 1 ? "Sent to 1 editor. " + phonesOn(1, ph) : "Sent to " + n + " editors. " + phonesOn(n, ph);
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
  const role = h("select", { class: "input", id: "nu-role" }, h("option", { value: "editor", text: "Editor" }), h("option", { value: "buyer", text: "Media buyer (downloads approved videos)" }),
    state.me.owner ? h("option", { value: "admin", text: "Admin (sees and manages everything)" }) : null);
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
      field("Role", role, "A media buyer sees only the videos you approve, from every category, and gets a ping with a download link for each.")],
    run: async () => {
      const n = tidy(name.value), un = user.value.trim().toLowerCase(), pw = pass.value;
      if (!n) throw new Oops("Enter their name.");
      try { await run("er_add_user", { p_name: n, p_username: un, p_password: pw, p_role: role.value }); }
      catch (ex) { if (ex.code === "taken") throw new Oops("That username is already in use."); throw ex; }
      return () => openCreds("Login created", n, un, pw);
    },
  });
}
function openUser(id) {
  const u = state.users.get(id), me = state.me;
  if (!u) return;
  const name = h("input", { class: "input", id: "mu-name", type: "text", maxlength: "40", autocomplete: "off" });
  const role = h("select", { class: "input", id: "mu-role" }, h("option", { value: "editor", text: "Editor" }), h("option", { value: "buyer", text: "Media buyer (downloads approved videos)" }), h("option", { value: "admin", text: "Admin (sees and manages everything)" }));
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
      return args.p_role ? n + " is now " + (args.p_role === "admin" ? "an admin" : args.p_role === "buyer" ? "a media buyer" : "an editor") : "Saved";
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
// Two copies of a chosen picture: a small square that loads fast in every list, and the whole picture,
// larger, for when someone taps it.
async function shrink(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("bad")); i.src = url; });
    const w = img.naturalWidth, hgt = img.naturalHeight, s = Math.min(w, hgt);
    if (!s) throw new Error("bad");
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    c.getContext("2d").drawImage(img, (w - s) / 2, (hgt - s) / 2, s, s, 0, 0, 128, 128);
    const thumb = c.toDataURL("image/jpeg", 0.82);
    if (!/^data:image\/jpeg;base64,/.test(thumb) || thumb.length > 60000) throw new Error("bad");
    let full = null;
    for (const [edge, q] of [[1080, 0.82], [800, 0.75], [560, 0.7]]) {
      const k = Math.min(1, edge / Math.max(w, hgt)), b = document.createElement("canvas");
      b.width = Math.max(1, Math.round(w * k)); b.height = Math.max(1, Math.round(hgt * k));
      const g = b.getContext("2d");
      g.fillStyle = "#FFFFFF"; g.fillRect(0, 0, b.width, b.height);        // see-through pictures get a white background
      g.drawImage(img, 0, 0, b.width, b.height);
      const out = b.toDataURL("image/jpeg", q);
      if (/^data:image\/jpeg;base64,/.test(out) && out.length <= 560000) { full = out; break; }
    }
    return { thumb: thumb, full: full };
  } finally { URL.revokeObjectURL(url); }
}
// Puts text on the clipboard. Where the clipboard can't be reached, the text is selected so it can be copied
// by hand.
async function copyText(text, el) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch (e) {
    if (!el) return false;
    const r = document.createRange(), s = getSelection();
    r.selectNodeContents(el); s.removeAllRanges(); s.addRange(r);
    try { return document.execCommand("copy"); } catch (x) { return false; }
  }
}
// Payment details, label above value. An admin gets a button to copy the account number.
function detailsList(d, canCopy) {
  const digits = h("span", { class: "acct-num", text: d.account }), tel = d.phone.replace(/[^0-9+]/g, "");
  return h("dl", { class: "details" },
    h("div", null, h("dt", { text: "Full name" }), h("dd", { text: d.name })),
    h("div", null, h("dt", { text: "Phone number" }), h("dd", null, h("a", { class: "tel", href: "tel:" + tel, text: d.phone }))),
    h("div", null, h("dt", { text: "Bank" }), h("dd", { text: d.bank })),
    h("div", { class: "acct" }, h("dt", { text: "Account number" }), h("dd", null, digits,
      canCopy ? h("button", { class: "btn small", type: "button", dataset: { fk: "copy-acct" }, onclick: async () => toast(await copyText(d.account, digits) ? "Account number copied" : "Selected. Copy it from your phone's menu.") }, "Copy") : null)));
}
// An editor's own payment details, in their account sheet.
function payBox() {
  const d = state.me.details;
  return h("div", { class: "part", id: "ac-pay" },
    h("h3", { class: "part-title", text: "Payment details" }),
    d ? detailsList(d, false) : null,
    h("p", { class: "hint", text: d ? "Only you and your admins can see these." : "Add your full name, phone number and bank account so your admin can pay you. Only you and your admins can see them." }),
    h("div", { class: "btn-row" }, d
      ? h("button", { class: "btn small", type: "button", id: "pay-edit", onclick: () => openDetails() }, "Change details")
      : h("button", { class: "btn small primary", type: "button", id: "pay-add", onclick: () => openDetails() }, "Add your details")));
}
function openDetails() {
  const d = state.me.details;
  const input = (id, type, max, extra) => h("input", Object.assign({ class: "input", id: id, type: type, maxlength: String(max) }, extra));
  const name = input("pd-name", "text", 80, { autocomplete: "name" });
  const phone = input("pd-phone", "tel", 20, { autocomplete: "tel", inputmode: "tel" });
  const bank = input("pd-bank", "text", 60, { autocomplete: "off" });
  const acct = input("pd-account", "text", 14, { autocomplete: "off", inputmode: "numeric" });
  if (d) { name.value = d.name; phone.value = d.phone; bank.value = d.bank; acct.value = d.account; }
  formSheet({
    title: "Payment details", submit: "Save details",
    body: [
      h("p", { text: "Your admin uses these to pay you. Only you and your admins can see them." }),
      field("Full name", name, "As it appears on your bank account."),
      field("Phone number", phone),
      field("Bank", bank, "For example GTBank, Access Bank or OPay."),
      field("Account number", acct, "10 digits.")],
    run: async () => {
      const n = tidy(name.value), p = tidy(phone.value), b = tidy(bank.value), a = acct.value.replace(/[\s-]/g, ""), digits = p.replace(/[^0-9]/g, "");
      if (n.length < 2) throw new Oops(ERRORS.bad_full_name);
      if (!/^\+?[0-9 ()-]+$/.test(p) || digits.length < 7 || digits.length > 15) throw new Oops(ERRORS.bad_phone);
      if (b.length < 2) throw new Oops(ERRORS.bad_bank);
      if (!/^[0-9]{10}$/.test(a)) throw new Oops(ERRORS.bad_account);
      const r = await run("er_save_details", { p_name: n, p_phone: p, p_bank: b, p_account: a });
      return r && r.same ? "Nothing changed" : "Payment details saved";
    },
  });
}
// An editor's profile, for an admin: who they are, and their payment details, fetched when it opens.
function openProfile(uid) {
  const u = state.users.get(uid);
  if (!u) return;
  const first = u.name.split(" ")[0], body = h("div", { class: "part", id: "pf-pay" });
  const draw = (nodes) => body.replaceChildren.apply(body, [h("h3", { class: "part-title", text: "Payment details" })].concat(nodes.filter(Boolean)));
  const load = async () => {
    draw([h("p", { class: "hint", text: "Loading…" })]);
    try {
      const r = await call("er_details", { p_user: uid }), d = normDetails(r && r.details), ch = r && r.changed && num(r.changed.at) ? r.changed : null;
      if (!body.isConnected) return;
      if (!d) { draw([empty("No payment details yet.", first + " sees a reminder on their home screen until they add them.")]); return; }
      draw([
        ch ? h("div", { class: "notice warn" }, h("strong", { text: "Bank details changed " + shortDate(num(ch.at)) }),
          h("span", { text: "Before, pay went to " + str(ch.bank, 60) + ", account ending " + str(ch.last4, 4) + ". If you didn't expect this, check with " + first + " before paying." })) : null,
        detailsList(d, true),
        d.at ? h("p", { class: "hint", text: "Updated " + stamp(d.at) + "." }) : null]);
    } catch (e) {
      if (!body.isConnected) return;
      draw([h("p", { class: "error", role: "alert", text: errText(e) }), h("div", { class: "btn-row" }, h("button", { class: "btn small", type: "button", onclick: load }, "Try again"))]);
    }
  };
  openSheet(u.name, [h("div", { class: "form" },
    h("div", { class: "pic-row" }, avatar(uid, "lg"), h("div", { class: "row-main" },
      h("span", { class: "row-title", text: "@" + u.username }),
      h("span", { class: "hint", text: u.seen ? "Last seen " + ago(u.seen) : "Hasn't signed in yet" }))),
    body,
    h("div", { class: "btn-row" }, h("button", { class: "btn grow", type: "button", onclick: closeSheet }, "Close")))]);
  load();
}
// Day, night, or whatever the phone is set to: for this phone only, and in effect at once. theme.js, which
// runs before the page is drawn, keeps the choice and applies it.
const THEMES = [["light", "Day"], ["dark", "Night"], [null, "Same as phone"]];
function themeBox() {
  const t = window.dnTheme, hint = h("p", { class: "hint", id: "ac-theme-hint" });
  const opts = THEMES.map(([value, label]) => h("button", { type: "button", dataset: { theme: value || "phone" }, onclick: () => { t.set(value); mark(); } }, label));
  const mark = () => {
    const pick = t.get();
    opts.forEach((b, i) => b.setAttribute("aria-pressed", String(THEMES[i][0] === pick)));
    hint.textContent = pick === "light" ? "The app stays in day mode on this phone, even when the phone is in dark mode."
      : pick === "dark" ? "The app stays in night mode on this phone, even when the phone is in light mode."
        : "The app follows your phone, which is in " + (t.dark() ? "dark" : "light") + " mode right now.";
  };
  const box = h("div", { class: "part", id: "ac-theme" },
    h("h3", { class: "part-title", id: "ac-theme-title", text: "Day or night" }),
    h("div", { class: "seg long-last", role: "group", "aria-labelledby": "ac-theme-title", "aria-describedby": "ac-theme-hint" }, opts),
    hint);
  if (!t) { box.hidden = true; return box; }      // theme.js didn't load: the phone's setting decides
  mark();
  // the phone switching between light and dark while this is open (once the sheet is gone, the listener goes too)
  const mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const follow = () => { if (box.isConnected) mark(); else mq.removeEventListener("change", follow); };
  if (mq && mq.addEventListener) mq.addEventListener("change", follow);
  return box;
}
function openAccount(forPicture) {
  const me = state.me, admin = me.role === "admin", buyer = me.role === "buyer";
  let picked = null;        // null = keep, "" = remove, otherwise { thumb, full } for the new picture
  const slot = h("span", { id: "ac-pic" });
  const file = h("input", { class: "vh", id: "ac-file", type: "file", accept: "image/*", "aria-label": "Choose a picture", tabindex: "-1" });
  const perr = h("p", { class: "error", hidden: true, text: "That picture couldn't be used. Try another one." });
  const remove = h("button", { class: "btn small quiet", type: "button", onclick: () => { picked = ""; show(); } }, "Remove");
  const show = () => {
    const cur = pics.get(me.id), url = picked === "" ? "" : picked ? picked.thumb : cur ? cur.url : "";
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
  const choose = h("button", { class: "btn small" + (forPicture ? " primary" : ""), type: "button", id: "ac-choose", onclick: () => file.click() }, "Choose a picture");
  formSheet({
    title: "Your account", submit: admin ? "Save" : "Save picture",
    body: [
      h("div", { class: "pic-row" }, slot, file, choose, remove),
      perr,
      admin ? field("Your name", name, "Signed in as @" + me.username + ". Your picture and name show wherever your work does.")
        : h("p", { class: "hint", text: "Signed in as @" + me.username + ". " + (buyer ? "" : "Your picture shows next to your name on the leaderboard. ") + "Your name is set by your admin." }),
      admin || buyer ? null : payBox(),
      themeBox(),
      notifyBox()],
    foot: h("div", { class: "btn-row tools" },
      h("button", { class: "btn small", type: "button", onclick: openChangePassword }, "Change password"),
      h("button", { class: "btn small", type: "button", onclick: () => { const t = state.token; leave(); pushDrop(t).finally(() => api("er_logout", { p_token: t }).catch(() => {})); } }, "Sign out"),
      h("a", { class: "btn small quiet", href: "privacy.html" }, "Privacy policy"),
      installBox()),
    run: async () => {
      if (admin) {
        const n = tidy(name.value);
        if (!n) throw new Oops("Enter your name.");
        if (n !== me.name) await call("er_set_profile", { p_name: n });
      } else if (picked == null) return "";
      if (picked != null) await call("er_set_picture", { p_avatar: picked === "" ? "" : picked.thumb, p_full: picked === "" ? null : picked.full });
      await sync();
      return "Saved";
    },
  });
  if (forPicture) choose.focus();
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
function seatToast() {      // while a sheet or the player is open the message lives inside it, so it shows on top and is read out
  const home = sheet.open ? sheet : player.open ? player : document.body;
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
  const roleName = ui.view === "admin" ? "Admin" : ui.view === "buyer" ? "Media buyer" : "Editor";
  who.setAttribute("aria-label", "Your account: " + state.me.name + ", " + roleName.toLowerCase());
  who.replaceChildren(
    h("span", { class: "who-text" }, h("span", { class: "who-name", text: state.me.name }), h("span", { class: "who-role", text: roleName })),
    avatar(state.me.id));
}
$("who").addEventListener("click", () => { if (state.phase === "ready") openAccount(); });
function renderTabs(all) {
  const nav = $("tabs"), on = state.phase === "ready" && ui.view !== "buyer";      // a media buyer has one screen
  nav.hidden = !on;
  if (!on) { nav.dataset.kind = ""; return; }
  const admin = ui.view === "admin", defs = admin ? ADMIN_TABS : EDITOR_TABS, cur = admin ? ui.tab : ui.etab;
  if (nav.dataset.kind !== ui.view) {
    nav.dataset.kind = ui.view;
    nav.replaceChildren.apply(nav, defs.map((d, i) => h("button", { class: "tab", type: "button", dataset: { tab: d[0] }, onclick: () => setTab(d[0]) },
      h("span", { class: "tab-ic" }, icon(d[0])), h("span", { class: "tab-label", text: d[1] }),
      i === 0 ? h("span", { class: "count" + (admin ? "" : " alert"), hidden: true }) : null)));
  }
  const n = admin ? all.filter(isWaiting).length + state.scripts.filter((x) => x.status === "declined").length
    : all.filter((x) => x.uid === state.me.id && x.p.status === "active" && x.f.phase !== "ontrack").length + (state.isAdmin ? 0 : state.scripts.length);
  for (const b of nav.children) {
    if (b.dataset.tab === cur) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    const c = b.querySelector(".count");
    if (c) { c.hidden = !n; c.textContent = String(n); c.setAttribute("aria-label", n + " need" + (n === 1 ? "s" : "") + " you"); }
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
  if ((ui.view === "admin" && !state.isAdmin) || (ui.view === "buyer") !== state.isBuyer) ui.view = viewFor();
  if (ui.view === "buyer") view.replaceChildren.apply(view, viewVideos());
  else if (ui.view === "admin" && ui.tab === "projects") { pin(view, projectsPanel().node); fillProjects(all); }
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
if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
  // a notification just arrived: fetch what changed, so the screen matches it
  navigator.serviceWorker.addEventListener("message", (e) => { if (e.data && e.data.type === "sync" && state.phase === "ready") sync(); });
}
})();
