// A stand-in for the live setup, for testing on one machine: serves the app's files and answers the same
// web calls the hosted database answers (POST /rest/v1/rpc/<function>), backed by a local in-process Postgres
// loaded with the real schema. The /__test/ routes exist only here; they let a test move time and cut the line.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, SETUP_CODE } from "./db.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(here, "..");          // the app's files sit at the top of the repository
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json", ".txt": "text/plain; charset=utf-8" };

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}

export async function startServer(port = 0) {
  const { rpc, sql, raw, close: closeDb } = await createDb();
  const flags = { down: false, delay: 0 };
  const calls = [];
  const send = (res, status, body, type) => { res.writeHead(status, { "Content-Type": type || "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");
      if (req.method === "POST" && url.pathname.startsWith("/rest/v1/rpc/")) {
        if (flags.down) { req.socket.destroy(); return; }
        const fn = url.pathname.slice("/rest/v1/rpc/".length);
        let args;
        try { args = JSON.parse((await readBody(req)) || "{}"); } catch (e) { return send(res, 400, { code: "PGRST102", message: "bad json" }); }
        calls.push(fn);
        if (flags.delay) await new Promise((r) => setTimeout(r, flags.delay));
        if (raw) {          // the real web API is running: pass its answer through untouched
          const r = await raw(fn, args, req.headers.prefer ? { Prefer: req.headers.prefer } : null);
          return send(res, r.status, r.text);
        }
        try { return send(res, 200, await rpc(fn, args)); }
        catch (e) {
          if (e.status === 404 || /does not exist/.test(String(e.message))) return send(res, 404, { code: "PGRST202", details: null, hint: null, message: "Could not find the function public." + fn + " in the schema cache" });
          return send(res, 400, { code: e.code || "P0001", details: null, hint: null, message: String(e.message) });
        }
      }
      if (req.method === "POST" && url.pathname === "/__test/sql") {
        const { text, params } = JSON.parse(await readBody(req));
        const r = await sql(text, params || []);
        return send(res, 200, { rows: r.rows });
      }
      if (req.method === "POST" && url.pathname === "/__test/flags") {
        Object.assign(flags, JSON.parse(await readBody(req)));
        return send(res, 200, flags);
      }
      if (req.method === "GET" && url.pathname === "/__test/calls") return send(res, 200, calls);
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { message: "no" });
      // tests talk to this machine, never to the live database
      if (url.pathname === "/config.js") return send(res, 200, 'window.EDIT_ROOM_CONFIG = { url: "", key: "" };\n', TYPES[".js"]);
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith("/")) rel += "index.html";
      if (/^\/(test|db|\.git)(\/|$)/.test(rel)) return send(res, 404, "Not found", "text/plain");
      const file = path.join(SITE, rel);
      if (!file.startsWith(SITE + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, "Not found", "text/plain");
      return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || "application/octet-stream");
    } catch (e) {
      try { send(res, 500, { message: String(e && e.message) }); } catch (x) { /* already answered */ }
    }
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  const at = "http://127.0.0.1:" + server.address().port;
  return { url: at, sql, rpc, flags, calls, code: SETUP_CODE, close: async () => { await new Promise((r) => server.close(r)); await closeDb(); } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = await startServer(Number(process.env.PORT) || 4173);
  console.log("Test server on " + s.url + "  (setup code: " + s.code + ")");
}
