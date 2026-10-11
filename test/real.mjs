// The same interface as db.mjs, but against the real stack the live app runs on: a PostgreSQL server set up
// the way the hosting service sets one up (an owner role that is not a superuser, an "anon" role for the web
// API with a 3-second limit, pgcrypto in the "extensions" schema), with PostgREST in front of it.
// Needs a local PostgreSQL install and the PostgREST binary:
//   PG_BIN=/usr/lib/postgresql/16/bin  POSTGREST=/path/to/postgrest  ER_PG_DIR=/var/lib/postgresql/er-test
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SETUP_CODE = "TEST-CODE-1234";
const PG_BIN = process.env.PG_BIN || "/usr/lib/postgresql/16/bin";
const PG_DIR = process.env.ER_PG_DIR || "/var/lib/postgresql/er-test";
const POSTGREST = process.env.POSTGREST || "postgrest";
const PG_PORT = Number(process.env.ER_PG_PORT) || 54329;
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once("error", reject); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const DB = "er_test";
const JWT_SECRET = "local-test-secret-not-used-anywhere-else-0123456789";

const asPg = (cmd, args) => {       // the server refuses to run as root, so drop to the postgres user when we are root
  const root = typeof process.getuid === "function" && process.getuid() === 0;
  return execFileSync(root ? "runuser" : cmd, root ? ["-u", "postgres", "--", cmd].concat(args) : args, { stdio: ["ignore", "pipe", "pipe"] }).toString();
};
const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
function anonKey() {
  const head = b64({ alg: "HS256", typ: "JWT" }), body = b64({ role: "anon", iss: "local-test", exp: Math.floor(Date.now() / 1000) + 86400 });
  return head + "." + body + "." + crypto.createHmac("sha256", JWT_SECRET).update(head + "." + body).digest("base64url");
}
const connect = async (user, database) => { const c = new pg.Client({ host: "127.0.0.1", port: PG_PORT, user, database }); await c.connect(); return c; };

function startPostgres() {
  const data = path.join(PG_DIR, "data");
  if (!fs.existsSync(path.join(data, "PG_VERSION"))) {
    if (!fs.existsSync(PG_DIR)) { fs.mkdirSync(PG_DIR, { recursive: true }); if (process.getuid() === 0) execFileSync("chown", ["postgres:postgres", PG_DIR]); }
    asPg(path.join(PG_BIN, "initdb"), ["-D", data, "-U", "supabase_admin", "--auth=trust", "-E", "UTF8", "--locale=C.UTF-8"]);
  }
  let running = true;
  try { asPg(path.join(PG_BIN, "pg_ctl"), ["-D", data, "status"]); } catch (e) { running = false; }
  if (!running) asPg(path.join(PG_BIN, "pg_ctl"), ["-D", data, "-w", "-l", path.join(PG_DIR, "server.log"), "-o", "-p " + PG_PORT + " -c listen_addresses=127.0.0.1 -c unix_socket_directories=" + PG_DIR, "start"]);
}
export function stopPostgres() {
  try { asPg(path.join(PG_BIN, "pg_ctl"), ["-D", path.join(PG_DIR, "data"), "-m", "fast", "-w", "stop"]); } catch (e) { /* not running */ }
}

export async function createDb() {
  startPostgres();
  // a clean database, owned by a "postgres" role that is not a superuser
  const boot = await connect("supabase_admin", "postgres");
  await boot.query("drop database if exists " + DB + " with (force)");
  await boot.query(`do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'postgres') then create role postgres login createdb createrole bypassrls; end if;
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator login noinherit; end if;
  end $$`);
  await boot.query("grant anon, authenticated, service_role to authenticator");
  await boot.query("alter role anon set statement_timeout = '3s'");
  await boot.query("alter role authenticated set statement_timeout = '8s'");
  await boot.query("create database " + DB + " owner postgres");
  await boot.end();
  const su = await connect("supabase_admin", DB);
  await su.query(`
    create schema extensions authorization postgres;
    create extension pgcrypto with schema extensions;
    grant usage on schema extensions to postgres, anon, authenticated, service_role;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;`);
  // the schema goes in exactly as it will on the live project: as the owner role, in one go
  const owner = await connect("postgres", DB);
  await owner.query(fs.readFileSync(path.join(here, "..", "db", "schema.sql"), "utf8"));
  const hash = crypto.createHash("sha256").update(SETUP_CODE.toUpperCase().replace(/[^A-Z0-9]/g, "")).digest("hex");
  await owner.query("update app.meta set setup_hash = $1", [hash]);
  await owner.end();

  // a port of its own every run, so a leftover copy from an earlier run can never answer in its place
  const REST_PORT = await freePort();
  const rest = spawn(POSTGREST, [], { stdio: ["ignore", "pipe", "pipe"], env: Object.assign({}, process.env, {
    PGRST_DB_URI: "postgres://authenticator@127.0.0.1:" + PG_PORT + "/" + DB, PGRST_DB_SCHEMAS: "public", PGRST_DB_ANON_ROLE: "anon",
    PGRST_DB_EXTRA_SEARCH_PATH: "public,extensions", PGRST_JWT_SECRET: JWT_SECRET, PGRST_SERVER_HOST: "127.0.0.1", PGRST_SERVER_PORT: String(REST_PORT), PGRST_DB_POOL: "8",
  }) });
  let restLog = "", gone = false;
  rest.stdout.on("data", (d) => { restLog += d; });
  rest.stderr.on("data", (d) => { restLog += d; });
  rest.on("exit", () => { gone = true; });
  rest.on("error", (e) => { gone = true; restLog += "could not run \"" + POSTGREST + "\": " + e.message + " (set POSTGREST to the PostgREST program)"; });
  process.on("exit", () => { try { rest.kill("SIGKILL"); } catch (e) { /* already stopped */ } });
  const base = "http://127.0.0.1:" + REST_PORT, key = anonKey();
  const headers = { "Content-Type": "application/json", apikey: key, Authorization: "Bearer " + key };
  for (let i = 0; ; i++) {
    try { const r = await fetch(base + "/rpc/er_status", { method: "POST", headers, body: "{}" }); if (r.ok) break; } catch (e) { /* not up yet */ }
    if (gone || i > 100) throw new Error("PostgREST did not start:\n" + restLog.slice(-2000));
    await new Promise((r) => setTimeout(r, 100));
  }

  // what the browser does: POST /rest/v1/rpc/<fn> with the public key; errors come back as { code, message }
  const raw = async (fn, args, extra) => {
    const res = await fetch(base + "/rpc/" + fn, { method: "POST", headers: Object.assign({}, headers, extra || {}), body: JSON.stringify(args || {}) });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (e) { /* not json */ }
    return { status: res.status, body, text };
  };
  const rpc = async (fn, args = {}) => {
    const r = await raw(fn, args);
    if (r.status >= 200 && r.status < 300) return r.body;
    throw Object.assign(new Error(r.body && r.body.message ? r.body.message : "HTTP " + r.status + " " + r.text.slice(0, 200)), { status: r.status, code: r.body && r.body.code });
  };
  const sql = (text, params) => su.query(text, params || []);       // superuser, for arranging test data
  const anon = await connect("authenticator", DB);
  let chain = Promise.resolve();
  const asAnon = (text) => { const next = chain.then(async () => {
    await anon.query("begin"); await anon.query("set local role anon");
    try { const r = await anon.query(text); await anon.query("commit"); return r; } catch (e) { await anon.query("rollback"); throw e; }
  }); chain = next.catch(() => {}); return next; };
  const close = async () => { rest.kill("SIGTERM"); await su.end().catch(() => {}); await anon.end().catch(() => {}); };
  return { rpc, sql, asAnon, raw, base, key, close, real: true, log: () => restLog };
}
