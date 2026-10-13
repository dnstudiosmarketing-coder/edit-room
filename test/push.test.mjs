// Checks the phone notification sender (supabase/functions/dn-push) end to end, against the real database
// stack: the encryption is read back with an independent library, the signature is verified, and the
// sender's batches, retries and gone phones land in the database as they should. Push services are stood in
// for by a local server.   ER_BACKEND=real POSTGREST=/path/to/postgrest node push.test.mjs
import http from "node:http";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import postgres from "postgres";
import { encryptFor, vapidHeader, makeKeys, unb64u, b64u } from "../supabase/functions/dn-push/webpush.js";
import { handle } from "../supabase/functions/dn-push/sender.js";

const ece = createRequire(import.meta.url)("http_ece");
const out = [];
let failed = 0;
const ok = (cond, label, extra) => { if (!cond) failed++; out.push((cond ? "PASS " : "FAIL ") + label + (extra ? "  -> " + extra : "")); };

// ---- a phone: its own key pair and secret, as a browser makes them
function phone() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ecdh, auth, p256dh: b64u(ecdh.getPublicKey()), authText: b64u(auth) };
}
const readAs = (ph, body) => ece.decrypt(Buffer.from(body), { version: "aes128gcm", privateKey: ph.ecdh, authSecret: ph.auth }).toString("utf8");

// ---- the encryption and the signature, on their own
const ph1 = phone();
const msg = JSON.stringify({ title: "Video submitted: Night market short", body: "Ada Obi submitted it on time." });
const sealed = await encryptFor({ p256dh: ph1.p256dh, auth: ph1.authText }, msg);
ok(readAs(ph1, sealed) === msg, "a message encrypted for a phone reads back with an independent library");
ok(sealed.length < 4096 && sealed[20] === 65 && new DataView(sealed.buffer).getUint32(16) === 4096, "it is one record with the sender's key in its header", sealed.length + " bytes");
let wrong = "";
try { readAs(phone(), sealed); } catch (e) { wrong = e.message; }
ok(wrong !== "", "no other phone can read it", wrong.slice(0, 60));
const keys = await makeKeys();
ok(unb64u(keys.publicKey).length === 65 && unb64u(keys.privateKey).length === 32, "the sender's keys have the shape phones expect");
const auth = await vapidHeader("https://fcm.googleapis.com/fcm/send/abc", keys, "https://example.org/app/", 1_800_000_000);
const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(auth);
const claims = m ? JSON.parse(Buffer.from(m[2], "base64url").toString()) : {};
const pub = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(unb64u(keys.publicKey).slice(1, 33)), y: b64u(unb64u(keys.publicKey).slice(33)) }, format: "jwk" });
const verified = m && crypto.verify("sha256", Buffer.from(m[1] + "." + m[2]), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(m[3], "base64url"));
ok(verified && claims.aud === "https://fcm.googleapis.com" && claims.exp === 1_800_000_000 + 43200 && claims.sub === "https://example.org/app/" && m[4] === keys.publicKey, "the push service can verify who sent it, for 12 hours", JSON.stringify(claims));

// ---- the whole round, against the real database
const { createDb } = await import("./real.mjs");
const db = await createDb();
const sql = postgres("postgres://postgres@127.0.0.1:" + (Number(process.env.ER_PG_PORT) || 54329) + "/er_test", { max: 2, prepare: false, onnotice: () => {} });
const received = [];
const svc = await new Promise((resolve) => {
  const s = http.createServer(async (req, res) => {
    const parts = [];
    for await (const c of req) parts.push(c);
    received.push({ path: req.url, headers: req.headers, body: Buffer.concat(parts) });
    res.writeHead(req.url.includes("/gone/") ? 410 : req.url.includes("/busy/") ? 503 : 201);
    res.end(req.url.includes("/busy/") ? "try later" : "");
  });
  s.listen(0, "127.0.0.1", () => resolve(s));
});
const svcUrl = "http://127.0.0.1:" + svc.address().port;
try {
  const setup = await db.rpc("er_setup", { p_code: "TEST-CODE-1234", p_name: "Sam Okafor", p_username: "sam", p_password: "admin-pass-1" });
  const A = setup.token;
  await db.rpc("er_add_user", { p_token: A, p_name: "Ada Obi", p_username: "ada", p_password: "ada-pass-1" });
  const TA = (await db.rpc("er_login", { p_username: "ada", p_password: "ada-pass-1" })).token;
  const cat = (await db.rpc("er_save_category", { p_token: A, p_id: null, p_name: "Shorts", p_rate: 15 })).id;
  const ids = (await db.sql("select id, username from app.users")).rows.reduce((o, r) => Object.assign(o, { [r.username]: r.id }), {});
  // the admin has two phones, one of which its push service no longer knows; the editor has one
  const adminPhone = phone(), oldPhone = phone(), adaPhone = phone();
  const sub = (uid, ph, kind) => db.sql("insert into app.push_subs(user_id, endpoint, p256dh, auth) values ($1, $2, $3, $4) returning id", [uid, svcUrl + "/" + kind + "/" + crypto.randomUUID(), ph.p256dh, ph.authText]);
  await sub(ids.sam, adminPhone, "ok");
  const oldSub = (await sub(ids.sam, oldPhone, "gone")).rows[0].id;
  await sub(ids.ada, adaPhone, "ok");
  const secret = (await db.sql("select push_secret from app.meta")).rows[0].push_secret;
  const call = (s) => handle(new Request("http://sender/", { method: "POST", headers: { "x-push-secret": s } }), sql);

  let r = await call("not-the-secret");
  ok(r.status === 401 && (await db.sql("select vapid_public from app.meta")).rows[0].vapid_public === null, "a call without the database's secret is turned away and changes nothing");
  r = await call(secret);
  let body = await r.json();
  const vp = (await db.sql("select vapid_public from app.meta")).rows[0].vapid_public;
  ok(r.status === 200 && body.notices === 0 && /^[A-Za-z0-9_-]{87}$/.test(vp || ""), "the first call makes the sender's keys and finds nothing to send", JSON.stringify(body));
  ok((await db.rpc("er_state", { p_token: TA })).settings.push === vp, "phones are given the public key");

  // an editor submits: the admin's phones are pinged
  const p = (await db.rpc("er_log_brief", { p_token: TA, p_name: "Night market short", p_category: cat })).id;
  await db.rpc("er_submit", { p_token: TA, p_project: p, p_link: "https://drive.google.com/file/d/abc123/view" });
  r = await call(secret);
  body = await r.json();
  ok(body.notices === 1 && body.sent === 1 && body.gone === 1 && body.failed === 0, "one ping goes to the admin's phone; the gone phone is noticed", JSON.stringify(body));
  const got = received.find((x) => x.path.startsWith("/ok/"));
  const note = got ? JSON.parse(readAs(adminPhone, got.body)) : {};
  ok(note.title === "Video submitted: Night market short" && note.body === "Ada Obi submitted it on time." && note.tag === "submitted:" + p && note.url === "./", "the admin's phone reads who submitted what", JSON.stringify(note));
  ok(got && got.headers["content-encoding"] === "aes128gcm" && got.headers.ttl === "86400" && got.headers.urgency === "high" && /^vapid t=.+, k=/.test(got.headers.authorization || ""), "with the headers push services require");
  const subs = (await db.sql("select endpoint like '%/gone/%' as old, gone_at is not null as gone, ok_at is not null as ok from app.push_subs where user_id = $1 order by old", [ids.sam])).rows;
  ok(subs.map((x) => (x.old ? "old" : "new") + ":" + (x.gone ? "gone" : "live") + ":" + (x.ok ? "ok" : "-")).join(" ") === "new:live:ok old:gone:-", "the phone that is gone is stamped, the other marked delivered", JSON.stringify(subs));
  ok((await db.sql("select result from app.outbox where kind = 'submitted'")).rows[0].result === "delivered to 1 phone", "and the ping is recorded as delivered");

  // a deadline passes: the editor is pinged; a busy push service means a later try
  const late = (await db.rpc("er_log_brief", { p_token: TA, p_name: "Fuel prices explained", p_category: cat })).id;
  await db.sql("update app.projects set started_at = now() - interval '24 hours 5 minutes' where id = $1", [late]);
  await db.sql("select app.notice_tick()");
  r = await call(secret);
  body = await r.json();
  const dl = received.filter((x) => x.path.startsWith("/ok/")).map((x) => { try { return JSON.parse(readAs(adaPhone, x.body)); } catch (e) { return null; } }).find(Boolean);
  ok(body.sent === 1 && dl && dl.title === "Deadline passed: Fuel prices explained" && /48-hour grace period/.test(dl.body), "when a deadline passes, the editor's phone is told the grace period has started", JSON.stringify(dl));
  // a reminder the admin picks in Settings goes out the same way
  const rm = await db.rpc("er_remind", { p_token: A, p_kind: "details" });
  r = await call(secret);
  body = await r.json();
  const remMsg = received.filter((x) => x.path.startsWith("/ok/")).map((x) => { try { return JSON.parse(readAs(adaPhone, x.body)); } catch (e) { return null; } }).filter(Boolean).find((n) => n.tag === "details");
  ok(rm.phones === 1 && body.sent === 1 && remMsg && remMsg.title === "Add your payment details" && (await db.sql("select result from app.reminders where kind = 'details'")).rows[0].result === "delivered to 1 phone", "a reminder from the admin reaches the editor's phone, and its delivery is recorded", JSON.stringify(remMsg));
  await db.sql("update app.push_subs set endpoint = replace(endpoint, '/ok/', '/busy/') where user_id = $1", [ids.ada]);
  await db.rpc("er_test_push", { p_token: TA });
  r = await call(secret);
  body = await r.json();
  const busy = (await db.sql("select sent_at is null as waiting, result, tries from app.outbox where kind = 'test'")).rows[0];
  ok(body.failed === 1 && busy.waiting && /^will try again: push service said 503 try later$/.test(busy.result) && busy.tries === 1, "a push service that is busy gets the ping again later", JSON.stringify(busy));
  r = await call(secret);
  ok((await r.json()).notices === 0, "not straight away, though");
  ok(oldSub && received.length === 5, "every message went where it should, and nowhere else (two for the submission, one deadline, one reminder, one busy try)", received.length + " messages");
} catch (e) {
  ok(false, "the run stopped early", String(e && e.stack).split("\n").slice(0, 4).join(" / "));
}
console.log(out.join("\n"));
console.log(failed ? "\n" + failed + " FAILED" : "\nall " + out.length + " passed");
await sql.end({ timeout: 2 }).catch(() => {});
svc.close();
await db.close();
process.exit(failed ? 1 : 0);
