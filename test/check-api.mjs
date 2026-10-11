// Every call the app makes must name a real function and only arguments that function takes.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const sql = fs.readFileSync(path.join(here, "..", "db", "schema.sql"), "utf8");
const js = fs.readFileSync(path.join(here, "..", "app.js"), "utf8");

const fns = new Map();
for (const m of sql.matchAll(/create or replace function public\.(er_[a-z_]+)\s*\(([^)]*)\)/g)) {
  const params = m[2].split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    const [name, ...rest] = s.split(/\s+/);
    return { name, required: !/\bdefault\b/i.test(rest.join(" ")) };
  });
  fns.set(m[1], params);
}
let bad = 0;
const seen = new Set();
// api("fn", {...}) uses the argument names as written; call()/run() add p_token themselves
for (const m of js.matchAll(/\b(api|call|run)\(\s*"(er_[a-z_]+)"\s*(?:,\s*(\{[^}]*\}|Object\.assign\(\{[^}]*\}\s*,\s*args\)))?/g)) {
  const [, via, fn, obj] = m;
  seen.add(fn);
  const params = fns.get(fn);
  if (!params) { console.log("MISSING FUNCTION", fn); bad++; continue; }
  const given = new Set(Array.from((obj || "").matchAll(/\b(p_[a-z_]+)\s*:/g)).map((x) => x[1]));
  if (via !== "api") given.add("p_token");
  const dynamic = /Object\.assign/.test(obj || "");
  for (const g of given) if (!params.some((p) => p.name === g)) { console.log("UNKNOWN ARGUMENT", fn, g); bad++; }
  if (!dynamic) for (const p of params) if (p.required && !given.has(p.name)) { console.log("MISSING ARGUMENT", fn, p.name); bad++; }
}
for (const fn of fns.keys()) if (!seen.has(fn)) console.log("note: not called by the app:", fn);
console.log(fns.size + " functions, " + seen.size + " used, " + bad + " problems");
process.exit(bad ? 1 : 0);
