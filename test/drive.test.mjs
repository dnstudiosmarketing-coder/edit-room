// Checks the Google Drive upload end to end against the real database stack, with Google stood in for by a
// local server (google-fake.mjs): connecting the admin's Drive, picking folders, and an editor's video going
// from a real browser straight into the chosen folder, a piece at a time, carrying on after the line drops
// and after the page is closed part way, until the brief is submitted with the file's link.
//   ER_BACKEND=real POSTGREST=/path/to/postgrest node drive.test.mjs
import crypto from "node:crypto";
import postgres from "postgres";
import { startServer } from "./server.mjs";
import { startGoogle } from "./google-fake.mjs";
import { handle, settings, forgetStored } from "../supabase/functions/dn-drive/drive.js";

if (process.env.ER_BACKEND !== "real") { console.log("drive.test.mjs needs the real stack: ER_BACKEND=real POSTGREST=/path/to/postgrest node drive.test.mjs"); process.exit(1); }
const out = [];
let failed = 0;
const ok = (cond, label, extra) => { if (!cond) failed++; out.push((cond ? "PASS " : "FAIL ") + label + (extra ? "  -> " + extra : "")); };

const google = await startGoogle();
let cfg = null;            // filled in once the app's address is known
const fn = (req) => handle(req, sql, cfg);
const srv = await startServer(0, {
  functions: { "/functions/v1/dn-drive": (req) => fn(req) },
  html: (text) => text.replace(/https:\/\/www\.googleapis\.com/g, google.url),       // the stand-in takes Google's place in the pages' security policy
});
const APP = srv.url, APP_URL = APP + "/", SELF = APP + "/functions/v1/dn-drive";       // where Google sends the admin back: the function, mounted on the test server
const env = { GOOGLE_CLIENT_ID: google.clientId, GOOGLE_CLIENT_SECRET: google.clientSecret, GOOGLE_API_KEY: "test-api-key", GOOGLE_APP_ID: "123456789012",
  DRIVE_SELF_URL: SELF, APP_ORIGINS: APP + ",https://dn.example", APP_URL: APP_URL, GOOGLE_AUTH_URL: google.url + "/auth", GOOGLE_TOKEN_URL: google.url + "/token",
  GOOGLE_REVOKE_URL: google.url + "/revoke", GOOGLE_API: google.url };
cfg = settings((k) => env[k]);
const sql = postgres("postgres://postgres@127.0.0.1:" + (Number(process.env.ER_PG_PORT) || 54329) + "/er_test", { max: 3, prepare: false, onnotice: () => {} });
const db = { rpc: srv.rpc, sql: srv.sql };

// one call to the function, the way a browser page or Google makes it
const call = async (body, origin) => {
  const r = await fn(new Request(SELF, { method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, origin === null ? {} : { Origin: origin || APP }), body: JSON.stringify(body) }));
  let parsed = null;
  try { parsed = await r.json(); } catch (e) { /* none */ }
  return { status: r.status, body: parsed || {}, headers: r.headers };
};
const back = async (query) => {          // Google sending the admin back to the function
  const r = await fn(new Request(SELF + "?" + new URLSearchParams(query).toString(), { method: "GET" }));
  return { status: r.status, location: r.headers.get("location") };
};
const stateOf = (u) => new URL(u).searchParams.get("state");

try {
  // ---- the team
  const setup = await db.rpc("er_setup", { p_code: srv.code, p_name: "Sam Okafor", p_username: "sam", p_password: "admin-pass-1" });
  const A = setup.token;
  await db.rpc("er_add_user", { p_token: A, p_name: "Ada Obi", p_username: "ada", p_password: "ada-pass-1" });
  await db.rpc("er_add_user", { p_token: A, p_name: "Tunde Bello", p_username: "tunde", p_password: "tunde-pass-1" });
  const TA = (await db.rpc("er_login", { p_username: "ada", p_password: "ada-pass-1" })).token;
  const TT = (await db.rpc("er_login", { p_username: "tunde", p_password: "tunde-pass-1" })).token;
  const cat = (await db.rpc("er_save_category", { p_token: A, p_id: null, p_name: "Proxan", p_rate: 15 })).id;

  // ---- before Google is set up
  const bare = settings((k) => ({ APP_ORIGINS: APP }[k]));
  const plain = await handle(new Request(SELF, { method: "POST", headers: { "Content-Type": "application/json", Origin: APP }, body: JSON.stringify({ action: "connect", token: A, back: APP_URL }) }), sql, bare);
  ok((await plain.json()).error === "not_set_up", "until Google is set up, connecting says so");

  // ---- the browser's preflight and who may ask
  const pre = await fn(new Request(SELF, { method: "OPTIONS", headers: { Origin: APP, "Access-Control-Request-Method": "POST" } }));
  const preBad = await fn(new Request(SELF, { method: "OPTIONS", headers: { Origin: "https://evil.example" } }));
  ok(pre.status === 204 && pre.headers.get("access-control-allow-origin") === APP && preBad.status === 403 && !preBad.headers.get("access-control-allow-origin"), "only the app's own pages may call it from a browser");
  ok((await call({ action: "connect", token: TA, back: APP_URL })).body.error === "forbidden", "an editor can't connect Drive");
  ok((await call({ action: "connect", token: "x".repeat(64), back: APP_URL })).body.error === "auth", "nor can someone signed out");
  ok((await call({ action: "connect", token: A, back: "https://evil.example/" })).body.error === "invalid", "and Google can only send the admin back to the app");
  ok((await call({ action: "bogus", token: A })).body.error === "invalid", "unknown requests are refused");

  // ---- connecting
  let r = await call({ action: "connect", token: A, back: APP_URL + "?tab=settings#x" });
  const auth = new URL(r.body.url);
  ok(auth.origin + auth.pathname === google.url + "/auth" && auth.searchParams.get("client_id") === google.clientId && auth.searchParams.get("redirect_uri") === SELF
    && auth.searchParams.get("scope") === "https://www.googleapis.com/auth/drive.file openid email" && auth.searchParams.get("access_type") === "offline"
    && auth.searchParams.get("prompt") === "consent" && /^[0-9a-f]{48}$/.test(auth.searchParams.get("state")), "connecting sends the admin to Google, asking only for the files the app uses", r.body.url);
  let b = await back({ state: auth.searchParams.get("state"), code: google.code(SELF) });
  ok(b.status === 302 && b.location === APP_URL + "?drive=connected", "Google's answer is turned into a lasting connection, and the admin goes back to the app", JSON.stringify(b));
  let dv = (await db.rpc("er_state", { p_token: A })).settings.drive;
  ok(dv.on === true && dv.email === "studio@example.com", "the admin sees which Google account is connected", JSON.stringify(dv));
  b = await back({ state: auth.searchParams.get("state"), code: google.code(SELF) });
  ok(b.location === APP_URL + "?drive=expired" && (await db.sql("select count(*)::int as n from app.drive")).rows[0].n === 1, "the same answer can't be used twice");
  r = await call({ action: "connect", token: A, back: APP_URL });
  b = await back({ state: stateOf(r.body.url), error: "access_denied" });
  ok(b.location === APP_URL + "?drive=cancelled", "cancelling on Google's screen comes back as cancelled");
  r = await call({ action: "connect", token: A, back: APP_URL });
  b = await back({ state: stateOf(r.body.url), code: google.code(SELF, "openid https://www.googleapis.com/auth/userinfo.email") });
  ok(b.location === APP_URL + "?drive=noaccess" && (await db.sql("select count(*)::int as n from app.drive where ended_at is null")).rows[0].n === 1 && (await db.sql("select count(*)::int as n from app.drive")).rows[0].n === 1, "if Drive is unticked on Google's screen, nothing changes and the admin is told");

  // ---- the folder picker, and the folders
  ok((await call({ action: "picker", token: TA })).body.error === "forbidden", "an editor can't open the folder picker");
  r = await call({ action: "picker", token: A });
  ok(/^at-/.test(r.body.token) && r.body.key === "test-api-key" && r.body.app === "123456789012", "the admin's folder picker gets an hour-long key and what Google's picker needs");
  // the client's id, the API key and the project number can live in the database, with only the secret as a setting
  await db.sql("update app.meta set google_client_id = $1, google_api_key = $2, google_app_id = $3 where id", [google.clientId, "dbKey-0123456789abcdefghij", "987654321098"]);
  forgetStored();
  const fromDb = settings((k) => ({ GOOGLE_CLIENT_SECRET: google.clientSecret, DRIVE_SELF_URL: SELF, APP_ORIGINS: APP, APP_URL: APP_URL, GOOGLE_AUTH_URL: google.url + "/auth",
    GOOGLE_TOKEN_URL: google.url + "/token", GOOGLE_REVOKE_URL: google.url + "/revoke", GOOGLE_API: google.url }[k]));
  const viaDb = async (body) => (await handle(new Request(SELF, { method: "POST", headers: { "Content-Type": "application/json", Origin: APP }, body: JSON.stringify(body) }), sql, fromDb)).json();
  const dbUrl = new URL((await viaDb({ action: "connect", token: A, back: APP_URL })).url);
  const dbPick = await viaDb({ action: "picker", token: A });
  ok(dbUrl.searchParams.get("client_id") === google.clientId && dbPick.key === "dbKey-0123456789abcdefghij" && dbPick.app === "987654321098" && /^at-/.test(dbPick.token),
    "the public values Google issued can come from the database, with only the client's secret as a function setting", JSON.stringify(dbPick));
  const fProxan = google.folder("Proxan"), fMeno = google.folder("Menoprime"), fBin = google.folder("Old", { trashed: true }), fLocked = google.folder("Not mine", { canAddChildren: false });
  const notFolder = "file" + crypto.randomBytes(9).toString("base64url");
  google.files.set(notFolder, { id: notFolder, name: "a.mp4", mimeType: "video/mp4", trashed: false, parents: [fProxan] });
  ok((await call({ action: "folders", token: TA, ids: [fProxan] })).body.error === "forbidden", "only an admin can add folders");
  ok((await call({ action: "folders", token: A, ids: ["no spaces!"] })).body.error === "invalid", "folder ids are checked before anything is asked of Google");
  r = await call({ action: "folders", token: A, ids: [fProxan, fMeno, fBin, fLocked, notFolder, "missing0000000000"] });
  ok(r.body.added === 2 && r.body.usable === 2 && r.body.refused === 4, "only real folders the app may put files in are added", JSON.stringify(r.body));
  dv = (await db.rpc("er_state", { p_token: TA })).settings.drive;
  ok(dv.on && dv.folders.map((f) => f.name).join() === "Menoprime,Proxan" && !JSON.stringify(dv).includes(fProxan), "editors see the folders by name", JSON.stringify(dv));
  const folderId = (name) => dv.folders.find((f) => f.name === name).id;

  // ---- an upload, as the function sees it
  const p1 = (await db.rpc("er_log_brief", { p_token: TA, p_name: "Proxan video 13", p_category: cat })).id;
  const bytes = crypto.randomBytes(3 * 262144 + 1000);
  ok((await call({ action: "start", token: TT, project: p1, folder: folderId("Proxan"), size: bytes.length, type: "video/mp4", ext: "mp4" })).body.error === "not_found", "nobody can upload to someone else's brief");
  ok((await call({ action: "start", token: TA, project: p1, folder: folderId("Proxan"), size: 60e9, type: "video/mp4", ext: "mp4" })).body.error === "too_big", "a file over 50 GB is refused");
  ok((await call({ action: "start", token: TA, project: "not-an-id", folder: folderId("Proxan"), size: 10 })).body.error === "invalid", "and a request that doesn't make sense");
  r = await call({ action: "start", token: TA, project: p1, folder: folderId("Proxan"), size: bytes.length, type: "video/mp4", ext: ".mp4" });
  const up1 = r.body, sid = up1.url && new URL(up1.url).searchParams.get("upload_id"), sess = google.sessions.get(sid);
  ok(up1.upload && sess && sess.origin === APP && sess.meta.parents[0] === fProxan && sess.meta.name === "Proxan video 13 (Ada Obi).mp4" && sess.meta.appProperties.dnUpload === up1.upload
    && sess.mime === "video/mp4" && sess.size === bytes.length, "Google is asked for an upload address in the chosen folder, for the editor's page, with the file named after the brief and editor", JSON.stringify(sess && sess.meta));
  const put = (from, to) => fetch(up1.url, { method: "PUT", headers: { "Content-Range": "bytes " + from + "-" + (to - 1) + "/" + bytes.length, Origin: APP }, body: bytes.subarray(from, to) });
  let pr = await put(0, 262144);
  ok(pr.status === 308 && pr.headers.get("range") === "bytes=0-262143", "the first piece goes in");
  r = await call({ action: "status", token: TA, upload: up1.upload });
  ok(r.body.offset === 262144 && r.body.complete === false, "the function can say how much Google has, for carrying on", JSON.stringify(r.body));
  ok((await call({ action: "status", token: TT, upload: up1.upload })).body.error === "not_found", "but only to whoever is uploading");
  ok((await call({ action: "finish", token: TA, upload: up1.upload })).body.error === "not_done", "it can't be finished before it's all there");
  pr = await put(262144, bytes.length);
  const made = await pr.json();
  ok(pr.status === 200 && made.id && google.files.get(made.id).sha256 === crypto.createHash("sha256").update(bytes).digest("hex"), "the rest goes in, and the file in Drive is exactly the video");
  const decoy = "file" + crypto.randomBytes(9).toString("base64url");
  google.files.set(decoy, { id: decoy, name: "other.mp4", mimeType: "video/mp4", size: bytes.length, parents: [fProxan], appProperties: {}, trashed: false });
  ok((await call({ action: "finish", token: TA, upload: up1.upload, file: decoy })).body.error === "not_done", "finishing with some other file in the folder is refused");
  const p1Before = (await db.rpc("er_state", { p_token: TA })).projects.find((p) => p.id === p1);
  r = await call({ action: "finish", token: TA, upload: up1.upload, file: made.id, note: "Final cut" });
  const p1After = (await db.rpc("er_state", { p_token: TA })).projects.find((p) => p.id === p1);
  ok(r.body.ok && r.body.link === "https://drive.google.com/file/d/" + made.id + "/view" && p1Before.status === "active" && p1After.status === "submitted" && p1After.link === r.body.link && p1After.note === "Final cut",
    "once it's in, the brief is submitted with the file's link and the editor's note", JSON.stringify(r.body));
  ok(google.perms.some((x) => x.file === made.id && x.type === "anyone" && x.role === "reader"), "and anyone with the link can view it, so it plays in the app");
  const row = (await db.sql("select done_at is not null as done, file_id, link, result from app.uploads where id = $1", [up1.upload])).rows[0];
  ok(row.done && row.file_id === made.id && row.result === "submitted", "the upload is recorded as done", JSON.stringify(row));
  ok((await call({ action: "finish", token: TA, upload: up1.upload, file: made.id })).body.link === r.body.link, "finishing again just gives the link back");
  ok((await call({ action: "start", token: TA, project: p1, folder: folderId("Proxan"), size: 10, type: "video/mp4" })).body.error === "not_found", "a submitted brief can't take another upload");
  // with the studio's Drive connected, uploading is the only way to submit: the web API refuses a pasted link
  const pasted = (await db.rpc("er_log_brief", { p_token: TA, p_name: "Proxan video 15", p_category: cat })).id;
  let refused = null;
  try { await db.rpc("er_submit", { p_token: TA, p_project: pasted, p_link: "https://drive.google.com/file/d/pasted15/view" }); } catch (e) { refused = String(e && e.message); }
  ok(/upload_only/.test(refused) && (await db.sql("select status from app.projects where id = $1", [pasted])).rows[0].status === "active", "a pasted link is refused: the brief stays in progress", refused);
  await db.rpc("er_delete_project", { p_token: A, p_project: pasted });

  // ---- keys that run out, a folder that's gone, a connection Google ends
  const p2 = (await db.rpc("er_log_brief", { p_token: TA, p_name: "Proxan video 14", p_category: cat })).id;
  google.expireAccess();
  r = await call({ action: "start", token: TA, project: p2, folder: folderId("Menoprime"), size: 100, type: "video/quicktime", ext: "MOV" });
  ok(r.body.upload && google.sessions.get(new URL(r.body.url).searchParams.get("upload_id")).meta.name === "Proxan video 14 (Ada Obi).mov", "when the hour-long key has run out, a new one is fetched without anyone noticing", JSON.stringify(r.body));
  google.files.get(fMeno).trashed = true;
  google.sessions.clear();
  google.files.delete(fMeno);
  ok((await call({ action: "start", token: TA, project: p2, folder: folderId("Menoprime"), size: 100, type: "video/mp4" })).body.error === "no_folder", "a folder deleted in Drive is reported as gone");
  google.revokeAll();
  google.expireAccess();
  r = await call({ action: "start", token: TA, project: p2, folder: folderId("Proxan"), size: 100, type: "video/mp4" });
  dv = (await db.rpc("er_state", { p_token: A })).settings.drive;
  ok(r.body.error === "drive_lost" && dv.on === false && dv.lost === true && (await db.rpc("er_state", { p_token: TA })).settings.drive.folders.length === 0, "if Google ends the connection, uploads stop and the admin is told to connect again", JSON.stringify(dv));

  // ---- connecting again, and disconnecting
  r = await call({ action: "connect", token: A, back: APP_URL });
  b = await back({ state: stateOf(r.body.url), code: google.code(SELF) });
  ok(b.location === APP_URL + "?drive=connected" && (await db.rpc("er_state", { p_token: A })).settings.drive.lost === false, "connecting again brings it back");
  ok((await call({ action: "check", token: A })).body.ok === true, "and the admin can check it works");
  const liveKey = (await db.sql("select refresh_token from app.drive where ended_at is null")).rows[0].refresh_token;
  ok((await call({ action: "disconnect", token: TA })).body.error === "forbidden", "an editor can't disconnect it");
  r = await call({ action: "disconnect", token: A });
  ok(r.body.ok && google.revoked.includes(liveKey) && (await db.rpc("er_state", { p_token: A })).settings.drive.on === false, "disconnecting ends it here and asks Google to forget the key");
  ok((await call({ action: "start", token: TA, project: p2, folder: folderId("Proxan"), size: 100, type: "video/mp4" })).body.error === "drive_off", "with Drive disconnected, nobody can upload");
  r = await call({ action: "connect", token: A, back: APP_URL });
  await back({ state: stateOf(r.body.url), code: google.code(SELF) });

  // ---- scripts: the admin sends one, it's kept in a folder of its own in Drive, and opened from there
  const adaId = (await db.sql("select id from app.users where username = 'ada'")).rows[0].id;
  const doc = crypto.randomBytes(9300), docB64 = doc.toString("base64");
  const send = (tok, extra) => call(Object.assign({ action: "script_send", token: tok, editor: adaId, category: cat, name: "", file: { name: "Proxan script 15.docx", data: docB64 } }, extra || {}));
  ok((await send(TA)).body.error === "forbidden", "only an admin can send a script");
  ok((await send(A, { file: null })).body.error === "invalid" && (await send(A, { file: { name: "virus.exe", data: docB64 } })).body.error === "not_script", "it must come with a document");
  r = await send(A);
  const sc = r.body, inDrive = Array.from(google.files.values()).filter((f) => f.appProperties && f.appProperties.dnScript === sc.script);
  const scFolder = Array.from(google.files.values()).filter((f) => f.name === "DN Studios scripts");
  ok(sc.ok && sc.name === "Proxan script 15" && inDrive.length === 1 && scFolder.length === 1 && inDrive[0].parents[0] === scFolder[0].id && inDrive[0].name === "Proxan script 15.docx"
    && inDrive[0].mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" && Buffer.compare(inDrive[0].content, doc) === 0,
    "the script goes into a DN Studios scripts folder the app makes in Drive, exactly as sent", JSON.stringify(sc));
  const scRow = (await db.sql("select status, file_id, size from app.scripts where id = $1", [sc.script])).rows[0];
  ok(scRow.status === "waiting" && scRow.file_id === inDrive[0].id && scRow.size === doc.length && (await db.rpc("er_state", { p_token: TA })).scripts.some((x) => x.id === sc.script), "and waits for the editor, with only its Drive id kept in the database", JSON.stringify(scRow));
  r = await send(A, { name: "Proxan script 16" });
  ok(r.body.ok && Array.from(google.files.values()).filter((f) => f.name === "DN Studios scripts").length === 1, "the next one goes into the same folder");
  google.files.get(scFolder[0].id).trashed = true;
  r = await send(A, { name: "Proxan script 17" });
  const folders2 = Array.from(google.files.values()).filter((f) => f.name === "DN Studios scripts" && !f.trashed);
  ok(r.body.ok && folders2.length === 1 && folders2[0].id !== scFolder[0].id && (await db.sql("select scripts_folder from app.drive where ended_at is null")).rows[0].scripts_folder === folders2[0].id, "if the folder is put in the bin, a new one is made");
  google.failSmall = 1;
  r = await send(A, { name: "Unlucky script" });
  const failedRow = (await db.sql("select status, note from app.scripts where name = 'Unlucky script'")).rows[0];
  ok(r.body.error === "google" && failedRow.status === "failed" && /503/.test(failedRow.note) && !(await db.rpc("er_state", { p_token: TA })).scripts.some((x) => x.name === "Unlucky script"), "if Google fails, the script is marked failed and nobody sees it", JSON.stringify(failedRow));
  const open = (tok, id) => call({ action: "script_open", token: tok, script: id || sc.script });
  ok((await open(TA)).body.error === "not_found" && (await open(TT)).body.error === "not_found", "the editor can't open it before taking it on, and nobody else can");
  r = await open(A);
  ok(r.body.name === "Proxan script 15.docx" && Buffer.compare(Buffer.from(r.body.data, "base64"), doc) === 0, "an admin can open it, straight from Drive");
  await db.rpc("er_accept_script", { p_token: TA, p_script: sc.script });
  r = await open(TA);
  ok(r.body.mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" && Buffer.compare(Buffer.from(r.body.data, "base64"), doc) === 0, "once the editor takes it on, they can open it");
  ok((await open(TT)).body.error === "not_found", "still nobody else on the team can");
  google.files.delete(inDrive[0].id);
  ok((await open(TA)).body.error === "script_gone", "a script deleted from Drive is reported as gone");
  globalThis.__drive = { A, TA, TT, cat, fProxan, adaId };
} catch (e) {
  ok(false, "the run stopped early", String(e && e.stack).split("\n").slice(0, 4).join(" / "));
}

// ---- the same, in a real browser: the admin's Settings and the editor's upload
await import("./drive-browser.mjs").then((m) => m.run({ ok, srv, google, sql, db, cfg, SELF, APP, APP_URL, call, back, stateOf, ids: globalThis.__drive || {} })).catch((e) => ok(false, "the browser part stopped early", String(e && e.stack).split("\n").slice(0, 5).join(" / ")));

console.log(out.join("\n"));
console.log("\n" + (failed ? failed + " failed" : "all " + out.length + " passed"));
await sql.end().catch(() => {});
await google.close();
await srv.close();
process.exit(failed ? 1 : 0);
