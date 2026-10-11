// A short run in the shape the app is really deployed in: the pages sit in a sub-folder on one address
// (like GitHub Pages) and the data API is on a different address (like Supabase), so every call is
// cross-origin with a pre-flight check, and the page sends the same headers it sends in production.
// Needs the real backend:  ER_BACKEND=real POSTGREST=/path/to/postgrest node deploy-shape.mjs
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createDb, SETUP_CODE } from "./real.mjs";

// Playwright comes from this folder's node_modules, or from a shared install named in GLOBAL_MODULES.
const local = createRequire(import.meta.url);
const need = (name) => { try { return local(name); } catch (e) { if (!process.env.GLOBAL_MODULES) throw e; return createRequire(process.env.GLOBAL_MODULES)(name); } };
const { chromium } = need("playwright");
const here = path.dirname(fileURLToPath(import.meta.url)), SITE = path.join(here, "..");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };
const listen = (handler) => new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, "127.0.0.1", () => resolve(s)); });
const results = [];
let failed = 0;
const ok = (cond, label, extra) => { if (!cond) failed++; results.push((cond ? "PASS " : "FAIL ") + label + (extra ? "  -> " + extra : "")); };

const db = await createDb();
const seen = { preflights: 0, posts: 0, headers: new Set(), origins: new Set() };
// the "gateway": answers pre-flight checks the way the hosting service does and passes real calls to the API
const api = await listen(async (req, res) => {
  const cors = { "Access-Control-Allow-Origin": req.headers.origin || "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Max-Age": "3600" };
  if (req.method === "OPTIONS") { seen.preflights++; for (const h of String(req.headers["access-control-request-headers"] || "").split(",")) if (h.trim()) seen.headers.add(h.trim().toLowerCase()); res.writeHead(204, cors); return res.end(); }
  if (!req.url.startsWith("/rest/v1/rpc/") || req.method !== "POST") { res.writeHead(404, cors); return res.end("{}"); }
  if (!req.headers.apikey) { res.writeHead(401, Object.assign({ "Content-Type": "application/json" }, cors)); return res.end(JSON.stringify({ message: "No API key found in request" })); }
  seen.posts++; seen.origins.add(req.headers.origin);
  const parts = [];
  for await (const c of req) parts.push(c);
  const r = await fetch(db.base + req.url.slice("/rest/v1".length), { method: "POST", headers: { "Content-Type": "application/json", apikey: req.headers.apikey, Authorization: req.headers.authorization || "" }, body: Buffer.concat(parts) });
  res.writeHead(r.status, Object.assign({ "Content-Type": r.headers.get("content-type") || "application/json" }, cors));
  res.end(Buffer.from(await r.arrayBuffer()));
});
const apiUrl = "http://127.0.0.1:" + api.address().port;
const missing = [];
const site = await listen((req, res) => {
  const u = new URL(req.url, "http://x");
  if (!u.pathname.startsWith("/edit-room/")) { res.writeHead(404); return res.end("outside the app's folder"); }
  let rel = u.pathname.slice("/edit-room".length);
  if (rel.endsWith("/")) rel += "index.html";
  if (rel === "/config.js") { res.writeHead(200, { "Content-Type": TYPES[".js"] }); return res.end("window.EDIT_ROOM_CONFIG = { url: " + JSON.stringify(apiUrl) + ", key: " + JSON.stringify(db.key) + " };\n"); }
  const file = path.join(SITE, rel);
  if (/^\/(test|db|\.git)\//.test(rel) || !file.startsWith(SITE + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { missing.push(rel); res.writeHead(404); return res.end("Not found"); }
  let body = fs.readFileSync(file);
  // the page only allows calls to its own address and the live database; let it reach this run's stand-in instead
  if (rel === "/index.html") body = Buffer.from(body.toString("utf8").replace(/connect-src 'self' https:\/\/[a-z0-9.-]+;/, "connect-src 'self' " + apiUrl + ";"));
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "max-age=600" });
  res.end(body);
});
const home = "http://127.0.0.1:" + site.address().port + "/edit-room/";

const browser = await chromium.launch();
const problems = [];
const open = async (name) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  page.on("console", (m) => { if ((m.type() === "error" || m.type() === "warning") && !String(m.location().url).includes("/rest/v1/rpc/")) problems.push(name + ": " + m.text()); });
  page.on("pageerror", (e) => problems.push(name + ": " + e.message));
  await page.goto(home);
  return page;
};
try {
  const admin = await open("admin");
  await admin.getByText("Set up DN Studios").waitFor();
  await admin.fill("#su-code", SETUP_CODE);
  await admin.fill("#su-name", "Sam Okafor");
  await admin.fill("#su-user", "sam");
  await admin.fill("#su-pass", "admin-pass-1");
  await admin.getByRole("button", { name: "Create my admin login" }).click();
  await admin.getByText("Get your team started").waitFor();
  ok(true, "setup works from a sub-folder against an API on another address");
  await admin.locator('#tabs button[data-tab="settings"]').click();
  await admin.fill("#cat-new", "Shorts");
  await admin.fill("#cat-rate", "15");
  await admin.locator(".inline-form button[type=submit]").click();
  await admin.locator(".rows .tape", { hasText: "Shorts" }).waitFor();
  await admin.locator("#add-user").click();
  await admin.fill("#nu-name", "Ada Obi");
  const pw = await admin.inputValue("#nu-pass");
  await admin.locator("#sheet").getByRole("button", { name: "Create login" }).click();
  await admin.locator("#cred-text").waitFor();
  const cred = await admin.locator("#cred-text").innerText();
  ok(cred.includes("Open: " + home), "the login details an admin sends out carry the app's real address", cred.replace(/\n/g, " | "));
  await admin.locator("#sheet").getByRole("button", { name: "Done" }).click();

  const ada = await open("ada");
  await ada.fill("#li-user", "ada.obi");
  await ada.fill("#li-pass", pw);
  await ada.getByRole("button", { name: "Sign in" }).click();
  await ada.getByRole("button", { name: "Log a new brief" }).click();
  await ada.fill("#b-name", "Night market short");
  await ada.selectOption("#b-cat", { label: "Shorts" });
  await ada.locator("#sheet").getByRole("button", { name: "Log brief" }).click();
  await ada.locator("article.clip", { hasText: "Night market short" }).getByRole("button", { name: "Submit with Drive link" }).click();
  await ada.fill("#s-link", "https://drive.google.com/file/d/abc/view");
  await ada.locator("#sheet").getByRole("button", { name: "Submit project" }).click();
  await ada.locator("#toast", { hasText: "admin's inbox" }).waitFor();
  await admin.locator('#tabs button[data-tab="inbox"]').click();
  await admin.evaluate(() => { document.dispatchEvent(new Event("visibilitychange")); });
  await admin.locator("article.clip", { hasText: "Night market short" }).getByRole("button", { name: "Mark received" }).click();
  await admin.locator("#toast", { hasText: "Ada Obi's earnings" }).waitFor();
  ok(true, "an editor's brief goes from logged to submitted to received across the two addresses");

  const sw = await admin.evaluate(async () => { const r = await navigator.serviceWorker.ready; return { scope: r.scope, script: r.active && r.active.scriptURL }; });
  ok(sw.scope === home && sw.script === home + "sw.js", "the offline helper covers exactly the app's folder", JSON.stringify(sw));
  const man = await admin.evaluate(async () => { const l = document.querySelector('link[rel="manifest"]'); const r = await fetch(l.href); const m = await r.json(); return { status: r.status, start: new URL(m.start_url, l.href).href, scope: new URL(m.scope, l.href).href, icons: await Promise.all(m.icons.map(async (i) => (await fetch(new URL(i.src, l.href))).status)) }; });
  ok(man.status === 200 && man.start === home && man.scope === home && man.icons.every((s) => s === 200), "the home-screen details point at the app's folder and its icons load", JSON.stringify(man));
  const fonts = await admin.evaluate(() => document.fonts.ready.then(() => Array.from(document.fonts).filter((f) => f.status === "loaded").map((f) => f.family.replace(/"/g, "")).filter((v, i, a) => a.indexOf(v) === i).sort().join(", ")));
  ok(fonts === "Barlow", "the app's own font loads from its folder", fonts);
  ok(seen.preflights > 0 && seen.posts > 10 && ["apikey", "authorization", "content-type"].every((h) => seen.headers.has(h)) && seen.headers.size === 3, "every call was cross-origin and asked to send only the three expected headers", seen.preflights + " pre-flights, " + seen.posts + " calls, headers: " + Array.from(seen.headers).join(","));
  ok(seen.origins.size === 1 && seen.origins.has(new URL(home).origin), "calls came from the app's address", Array.from(seen.origins).join(","));
  // with the connection gone, the saved copy of the app still opens and says so plainly
  await new Promise((r) => site.close(r)); site.closeAllConnections && site.closeAllConnections();
  await new Promise((r) => api.close(r)); api.closeAllConnections && api.closeAllConnections();
  await admin.reload();
  await admin.getByText("Can't reach DN Studios right now").waitFor();
  ok(true, "with no connection at all, the app still opens from the phone and says it can't reach the server");
} catch (e) {
  ok(false, "the run stopped early", String(e && e.message).split("\n").slice(0, 3).join(" / "));
}
ok(!missing.length, "nothing the pages asked for was missing", missing.join(", "));
ok(!problems.filter((p) => !/ERR_CONNECTION_REFUSED|Failed to load resource/.test(p)).length, "no browser errors or security-policy violations", problems.slice(0, 6).join(" || "));
console.log(results.join("\n"));
console.log("\n" + (results.length - failed) + " passed, " + failed + " failed");
await browser.close();
await db.close();
process.exit(failed ? 1 : 0);
