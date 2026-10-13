// The DN Studios Google Drive uploader (Supabase Edge Function "dn-drive").
//
// An admin connects the studio's Google Drive once, in Settings, and picks the folders editors may upload to
// with Google's own folder picker. An editor then uploads a finished video straight into one of those folders:
// this function asks Google for an upload address for that one file and hands it to the editor's browser,
// which sends the video there itself, a piece at a time, so a dropped connection costs only the piece in
// flight and the rest carries on later. Once it's all there, the function checks the file, lets anyone with
// its link view it (as the links editors send already do, so it plays inside the app), and submits the brief
// with that link.
//
// It works with Drive's narrowest permission, drive.file: the folders the admin picked and the files the app
// put there, nothing else in the Drive. Who may do what is decided by the app's own logins, in the database;
// nothing here takes the browser's word for anything else. Google's addresses can be pointed elsewhere for
// tests (see settings below).

const SCOPE = "https://www.googleapis.com/auth/drive.file openid email";
const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
const FOLDER = "application/vnd.google-apps.folder";
const CODES = new Set(["auth", "forbidden", "not_found", "no_folder", "drive_off", "drive_lost", "too_big", "not_video", "too_many", "invalid", "full",
  "bad_link", "not_set_up", "google", "expired", "not_done"]);

export class Stop extends Error {
  constructor(code, detail) { super(code); this.detail = detail || null; }
}

// Where Google is, and what Google issued this app. get(name) reads one setting (Deno.env.get on the live
// project). GOOGLE_CLIENT_SECRET is the secret of the OAuth client made in Google Cloud for the studio, and is
// only ever a function secret. The client's id, and the API key and Cloud project number Google's folder
// picker needs, aren't secret: they can be settings too, but on the live project they're kept in the database
// (app.meta, read through app.drive_config). DRIVE_SELF_URL is this function's own address, which Google sends
// people back to; it defaults to the one Supabase gives it.
export function settings(get) {
  const val = (k) => String(get(k) || "").trim();
  const base = val("SUPABASE_URL").replace(/\/+$/, "");
  return {
    clientId: val("GOOGLE_CLIENT_ID"), clientSecret: val("GOOGLE_CLIENT_SECRET"), apiKey: val("GOOGLE_API_KEY"), appId: val("GOOGLE_APP_ID"),
    self: val("DRIVE_SELF_URL") || (base ? base + "/functions/v1/dn-drive" : ""),
    origins: (val("APP_ORIGINS") || "https://dnstudiosmarketing-coder.github.io").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean),
    appUrl: val("APP_URL") || "https://dnstudiosmarketing-coder.github.io/edit-room/",
    authUrl: val("GOOGLE_AUTH_URL") || "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: val("GOOGLE_TOKEN_URL") || "https://oauth2.googleapis.com/token",
    revokeUrl: val("GOOGLE_REVOKE_URL") || "https://oauth2.googleapis.com/revoke",
    api: (val("GOOGLE_API") || "https://www.googleapis.com").replace(/\/+$/, ""),
    share: val("DRIVE_SHARE") !== "off",
    fetch: (...a) => globalThis.fetch(...a),
  };
}
const ready = (cfg) => !!(cfg.clientId && cfg.clientSecret && cfg.self);
// Settings missing from the function's own are taken from the database, and kept for a minute.
let stored = { at: 0, row: null };
export function forgetStored() { stored = { at: 0, row: null }; }
async function withStored(sql, cfg) {
  if (cfg.clientId && cfg.apiKey && cfg.appId) return cfg;
  if (!stored.row || Date.now() - stored.at > 60000) {
    const rows = await sql`select * from app.drive_config()`;
    stored = { at: Date.now(), row: rows[0] || {} };
  }
  const r = stored.row;
  return Object.assign({}, cfg, { clientId: cfg.clientId || r.client_id || "", apiKey: cfg.apiKey || r.api_key || "", appId: cfg.appId || r.app_id || "" });
}
const isId = (v) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const isDriveId = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{10,200}$/.test(v);
const codeOf = (e) => (e instanceof Stop ? e.message : CODES.has(String(e && e.message)) ? String(e.message) : "failed");

const json = (body, status, extra) => new Response(JSON.stringify(body), { status: status || 200, headers: Object.assign({ "Content-Type": "application/json", "Cache-Control": "no-store" }, extra || {}) });
const redirect = (to) => new Response(null, { status: 302, headers: { Location: to, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });

export async function handle(req, sql, base) {
  const url = new URL(req.url);
  const cfg = req.method === "OPTIONS" ? base : await withStored(sql, base);
  const origin = req.headers.get("origin");
  const known = !!origin && cfg.origins.includes(origin);
  const cors = known ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : { Vary: "Origin" };
  if (req.method === "OPTIONS") {
    return new Response(null, { status: known ? 204 : 403, headers: Object.assign({ "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "content-type", "Access-Control-Max-Age": "86400" }, cors) });
  }
  if (req.method === "GET" && url.searchParams.has("state")) return callback(url, sql, cfg);
  if (req.method !== "POST") return json({ error: "invalid" }, 405, cors);
  let body = null;
  try { body = await req.json(); } catch (e) { /* not JSON */ }
  if (!body || typeof body !== "object") return json({ error: "invalid" }, 400, cors);
  try {
    return json(await act(body, sql, cfg, known ? origin : null), 200, cors);
  } catch (e) {
    const code = codeOf(e);
    if (code === "failed" || code === "google") console.error("dn-drive " + String(body.action) + ": " + (e instanceof Stop ? e.detail || code : String((e && e.message) || e)).slice(0, 300));
    return json({ error: code }, code === "failed" ? 500 : 400, cors);
  }
}

function act(b, sql, cfg, origin) {
  const token = typeof b.token === "string" ? b.token : "";
  switch (b.action) {
    case "connect": return connect(token, b.back, sql, cfg);
    case "picker": return picker(token, sql, cfg);
    case "folders": return addFolders(token, b.ids, sql, cfg);
    case "start": return start(token, b, sql, cfg, origin);
    case "status": return status(token, b.upload, sql, cfg);
    case "finish": return finish(token, b, sql, cfg);
    case "disconnect": return disconnect(token, sql, cfg);
    case "check": return check(token, sql, cfg);
    default: throw new Stop("invalid");
  }
}

/* ---------- connecting: Google's sign-in and its answer ---------- */

async function connect(token, back, sql, cfg) {
  await sql`select (app.admin(${token})).id`;
  if (!ready(cfg)) throw new Stop("not_set_up");
  let to;
  try { to = new URL(String(back || "")); } catch (e) { throw new Stop("invalid"); }
  if (!cfg.origins.includes(to.origin)) throw new Stop("invalid");
  const [{ s }] = await sql`select app.drive_begin(${token}, ${to.origin + to.pathname}) as s`;
  const q = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: cfg.self, response_type: "code", scope: SCOPE, access_type: "offline",
    prompt: "consent", include_granted_scopes: "true", state: s });
  return { url: cfg.authUrl + "?" + q.toString() };
}

// Google sends the admin back here. Every outcome ends back in the app, which says what happened.
async function callback(url, sql, cfg) {
  const rows = await sql`select * from app.drive_take(${url.searchParams.get("state") || ""})`;
  if (!rows.length) return redirect(cfg.appUrl + "?drive=expired");
  const who = rows[0].who, home = (result) => redirect(rows[0].back + "?drive=" + result);
  const code = url.searchParams.get("code"), err = url.searchParams.get("error");
  if (err || !code) return home(err === "access_denied" ? "cancelled" : "failed");
  if (!ready(cfg)) return home("failed");
  let t;
  try {
    t = await form(cfg, cfg.tokenUrl, { code: code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.self, grant_type: "authorization_code" });
  } catch (e) {
    console.error("dn-drive connect: " + String(e.message).slice(0, 200));
    return home("failed");
  }
  if (!String(t.scope || "").split(/\s+/).includes(DRIVE_FILE)) return home("noaccess");       // Drive was unticked on Google's screen
  if (!t.refresh_token) return home("failed");
  const [{ id }] = await sql`select app.drive_link(${who}, ${emailOf(t.id_token)}, ${t.refresh_token}) as id`;
  keep(id, t);
  return home("connected");
}

// The account's address, from the sign-in token Google returned with the keys (fetched from Google directly,
// over a secure connection, so its contents can be read as they are).
function emailOf(idToken) {
  try {
    const part = String(idToken || "").split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part + "===".slice((part.length + 3) % 4)), (c) => c.charCodeAt(0))));
    return typeof claims.email === "string" ? claims.email.slice(0, 320) : null;
  } catch (e) { return null; }
}

async function form(cfg, url, fields) {
  const res = await cfg.fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
  let body = {};
  try { body = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok) { const e = new Error("google " + res.status + " " + (body.error || "") + " " + (body.error_description || "")); e.google = body.error || String(res.status); throw e; }
  return body;
}

/* ---------- the hour-long key Google gives in exchange for the connection's lasting one ---------- */

const cache = { conn: null, token: null, until: 0 };
function keep(conn, t) {
  if (!t || !t.access_token) return;
  cache.conn = conn; cache.token = t.access_token; cache.until = Date.now() + (Number(t.expires_in) || 3600) * 1000;
}
async function accessToken(sql, cfg, fresh) {
  if (!ready(cfg)) throw new Stop("not_set_up");
  const rows = await sql`select * from app.drive_key()`;
  if (!rows.length) throw new Stop("drive_off");
  const { conn, refresh } = rows[0];
  if (!fresh && cache.conn === conn && cache.token && Date.now() < cache.until - 120000) return cache.token;
  let t;
  try {
    t = await form(cfg, cfg.tokenUrl, { client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: refresh, grant_type: "refresh_token" });
  } catch (e) {
    if (e.google === "invalid_grant") {        // access was taken away in Google's settings, or it lapsed
      await sql`select app.drive_lost(${conn}, ${"Google said the connection is no longer valid"})`;
      cache.conn = null; cache.token = null;
      throw new Stop("drive_lost");
    }
    throw new Stop("google", e.message);
  }
  keep(conn, t);
  return t.access_token;
}

// One call to Drive. If the hour-long key has just run out, it gets a new one and tries once more.
async function drive(sql, cfg, method, path, body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const at = await accessToken(sql, cfg, attempt > 0);
    const headers = { Authorization: "Bearer " + at };
    if (body) headers["Content-Type"] = "application/json; charset=UTF-8";
    const res = await cfg.fetch(cfg.api + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 401 && attempt === 0) { cache.token = null; continue; }
    let parsed = null;
    try { parsed = await res.json(); } catch (e) { /* no body */ }
    return { ok: res.ok, status: res.status, body: parsed || {} };
  }
}

/* ---------- the admin's side: the folder picker, the folders, disconnecting ---------- */

async function picker(token, sql, cfg) {
  await sql`select (app.admin(${token})).id`;
  if (!ready(cfg) || !cfg.apiKey || !cfg.appId) throw new Stop("not_set_up");
  return { token: await accessToken(sql, cfg), key: cfg.apiKey, app: cfg.appId };
}

// The folders picked, checked with Google one by one: each must be a folder the app may now put files in.
async function addFolders(token, ids, sql, cfg) {
  await sql`select (app.admin(${token})).id`;
  if (!Array.isArray(ids) || !ids.length || ids.length > 50 || !ids.every(isDriveId)) throw new Stop("invalid");
  const good = [];
  for (const id of Array.from(new Set(ids))) {
    const r = await drive(sql, cfg, "GET", "/drive/v3/files/" + encodeURIComponent(id) + "?supportsAllDrives=true&fields=id,name,mimeType,trashed,capabilities/canAddChildren");
    const f = r.body;
    if (r.ok && f.mimeType === FOLDER && !f.trashed && !(f.capabilities && f.capabilities.canAddChildren === false) && isDriveId(f.id)) good.push({ id: f.id, name: String(f.name || "Untitled folder").slice(0, 200) });
  }
  const [{ n }] = good.length ? await sql`select app.drive_add_folders(${token}, (${JSON.stringify(good)}::text)::jsonb) as n` : [{ n: 0 }];
  return { added: n, usable: good.length, refused: ids.length - good.length };
}

async function disconnect(token, sql, cfg) {
  const [{ r }] = await sql`select app.drive_unlink(${token}) as r`;
  cache.conn = null; cache.token = null;
  if (r) {
    try { await cfg.fetch(cfg.revokeUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: r }).toString() }); }
    catch (e) { /* Settings shows it disconnected either way; Google lets the key go unused */ }
  }
  return { ok: true };
}

// Whether the connection still works, for the admin's Settings.
async function check(token, sql, cfg) {
  await sql`select (app.admin(${token})).id`;
  if (!ready(cfg)) return { ready: false };
  await accessToken(sql, cfg, true);
  return { ready: true, ok: true };
}

/* ---------- the editor's side: an upload, from start to submitted ---------- */

async function start(token, b, sql, cfg, origin) {
  if (!ready(cfg)) throw new Stop("not_set_up");
  const size = Number(b.size);
  if (!isId(b.project) || !isId(b.folder) || !Number.isSafeInteger(size) || size < 1) throw new Stop("invalid");
  const [{ s }] = await sql`select app.drive_start(${token}, ${b.project}, ${b.folder}, ${size}, ${String(b.type || "").slice(0, 100)}, ${String(b.ext || "").slice(0, 10)}) as s`;
  const meta = { name: s.name, parents: [s.folder], mimeType: s.mime, appProperties: { dnUpload: s.upload },
    description: ("Uploaded through DN Studios by " + s.editor + " for the brief " + s.brief + ".").slice(0, 900) };
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers = { Authorization: "Bearer " + await accessToken(sql, cfg, attempt > 0), "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": s.mime, "X-Upload-Content-Length": String(size) };
    if (origin) headers.Origin = origin;          // so Google lets the editor's browser send the file to this address
    const res = await cfg.fetch(cfg.api + "/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id", { method: "POST", headers: headers, body: JSON.stringify(meta) });
    if (res.status === 401 && attempt === 0) { cache.token = null; continue; }
    const loc = res.headers.get("location");
    if (res.ok && loc) {
      await sql`select app.drive_session(${s.upload}, ${loc})`;
      return { upload: s.upload, url: loc, name: s.name };
    }
    const why = await res.text().catch(() => "");
    if (res.status === 404) throw new Stop("no_folder");                 // the folder was deleted, or the app can no longer reach it
    throw new Stop("google", "start " + res.status + " " + why.slice(0, 200));
  }
}

async function uploadOf(token, upload, sql) {
  if (!isId(upload)) throw new Stop("invalid");
  const [{ u }] = await sql`select app.drive_upload(${token}, ${upload}) as u`;
  return u;
}

// How much of the file Google has, asked of Google directly, for carrying on after a break.
async function probe(cfg, u) {
  const res = await cfg.fetch(u.session, { method: "PUT", headers: { "Content-Range": "bytes */" + u.size }, body: "" });
  if (res.status === 308) {
    const m = /bytes=0-(\d+)/.exec(res.headers.get("range") || "");
    return { offset: m ? Number(m[1]) + 1 : 0 };
  }
  if (res.status === 200 || res.status === 201) {
    let f = null;
    try { f = await res.json(); } catch (e) { /* no body */ }
    return { offset: Number(u.size), file: f && isDriveId(f.id) ? f.id : null };
  }
  if (res.status === 404 || res.status === 410) throw new Stop("expired");
  throw new Stop("google", "status " + res.status);
}

async function status(token, upload, sql, cfg) {
  const u = await uploadOf(token, upload, sql);
  if (u.done) return { done: true, offset: Number(u.size) };
  if (!u.session || !u.fresh) throw new Stop("expired");
  const p = await probe(cfg, u);
  return { offset: p.offset, complete: p.offset >= Number(u.size) };
}

async function finish(token, b, sql, cfg) {
  const u = await uploadOf(token, b.upload, sql);
  if (u.done) return { ok: true, link: u.link };
  let file = isDriveId(b.file) ? b.file : null;
  if (!file) {
    if (!u.session) throw new Stop("expired");
    file = (await probe(cfg, u)).file;
    if (!file) throw new Stop("not_done");
  }
  const r = await drive(sql, cfg, "GET", "/drive/v3/files/" + encodeURIComponent(file) + "?supportsAllDrives=true&fields=id,name,size,parents,appProperties,trashed");
  const f = r.body;
  if (!r.ok || f.trashed || !f.appProperties || f.appProperties.dnUpload !== u.upload || !(f.parents || []).includes(u.folder) || Number(f.size) !== Number(u.size)) {
    await sql`select app.drive_done(${u.upload}, ${file}, ${null}, ${"the file in Drive didn't match this upload"})`;
    throw new Stop("not_done");
  }
  let note = "submitted";
  if (cfg.share) {
    const p = await drive(sql, cfg, "POST", "/drive/v3/files/" + encodeURIComponent(file) + "/permissions?supportsAllDrives=true", { role: "reader", type: "anyone" });
    if (!p.ok) note = "submitted; sharing by link was refused (" + p.status + ")";
  }
  const link = "https://drive.google.com/file/d/" + file + "/view";
  try {
    await sql`select public.er_submit(${token}, ${u.project}, ${link}, ${String(b.note || "").slice(0, 400)})`;
  } catch (e) {
    await sql`select app.drive_done(${u.upload}, ${file}, ${null}, ${"in Drive, but the brief couldn't be submitted: " + codeOf(e)})`;
    throw e;
  }
  await sql`select app.drive_done(${u.upload}, ${file}, ${link}, ${note})`;
  return { ok: true, link: link };
}
