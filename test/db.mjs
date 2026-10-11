// A local Postgres (in-process) loaded with the real schema, reached the same way the web API reaches it:
// every call runs as the unprivileged "anon" role in its own transaction.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SETUP_CODE = "TEST-CODE-1234";

// ER_BACKEND=real runs everything against a real PostgreSQL server with PostgREST in front (see real.mjs).
export async function createDb() {
  if (process.env.ER_BACKEND === "real") return (await import("./real.mjs")).createDb();
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec("create role anon nologin; create role authenticated nologin; create role service_role nologin;");
  await db.exec(fs.readFileSync(path.join(here, "..", "db", "schema.sql"), "utf8"));
  const hash = crypto.createHash("sha256").update(SETUP_CODE.toUpperCase().replace(/[^A-Z0-9]/g, "")).digest("hex");
  await db.query("update app.meta set setup_hash = $1", [hash]);
  let chain = Promise.resolve();
  const serial = (fn) => { const next = chain.then(fn, fn); chain = next.catch(() => {}); return next; };
  // what the web API does for POST /rest/v1/rpc/<fn>
  const rpc = (fn, args = {}) => serial(async () => {
    if (!/^er_[a-z_]+$/.test(fn)) throw Object.assign(new Error("no such function"), { status: 404 });
    const keys = Object.keys(args);
    for (const k of keys) if (!/^p_[a-z_]+$/.test(k)) throw Object.assign(new Error("bad argument"), { status: 400 });
    const sql = "select public." + fn + "(" + keys.map((k, i) => k + " => $" + (i + 1)).join(", ") + ") as r";
    const params = keys.map((k) => { const v = args[k]; return v !== null && typeof v === "object" ? JSON.stringify(v) : v; });
    await db.exec("begin; set local role anon;");
    try {
      const res = await db.query(sql, params);
      await db.exec("commit;");
      return res.rows[0].r;
    } catch (e) {
      await db.exec("rollback;");
      throw e;
    }
  });
  const sql = (text, params) => serial(() => db.query(text, params));   // superuser, for arranging test data
  const asAnon = (text) => serial(async () => {
    await db.exec("begin; set local role anon;");
    try { const r = await db.query(text); await db.exec("commit;"); return r; } catch (e) { await db.exec("rollback;"); throw e; }
  });
  return { db, rpc, sql, asAnon, close: async () => {} };
}
