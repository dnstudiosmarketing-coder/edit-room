// The Drive upload in a real browser on a phone-sized screen, run from drive.test.mjs once the function's own
// checks are done: the admin's Settings (folders, Google's folder picker, disconnecting and connecting again)
// and an editor's video going straight to the stand-in Google, carrying on after the line drops, after the
// app is closed part way, and after the editor stops it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const local = createRequire(import.meta.url);
const need = (name) => { try { return local(name); } catch (e) { if (!process.env.GLOBAL_MODULES) throw e; return createRequire(process.env.GLOBAL_MODULES)(name); } };

// Google's folder picker can't load here, so a small stand-in takes the place of Google's script: it reports
// how the page set it up, then "picks" the folders the test chose (window.__pick), or cancels.
const FAKE_PICKER = `
window.gapi = { load: function (name, o) { setTimeout(function () { (o.callback || o)(); }, 0); } };
window.google = { picker: (function () {
  function DocsView(id) { this.id = id; this.opts = {}; }
  ["setIncludeFolders", "setSelectFolderEnabled", "setMimeTypes"].forEach(function (m) { DocsView.prototype[m] = function (v) { this.opts[m] = v; return this; }; });
  function PickerBuilder() { this.cfg = { views: [], features: [] }; }
  var P = PickerBuilder.prototype;
  P.setTitle = function (t) { this.cfg.title = t; return this; };
  P.addView = function (v) { this.cfg.views.push({ id: v.id, opts: v.opts }); return this; };
  P.enableFeature = function (f) { this.cfg.features.push(f); return this; };
  P.setOAuthToken = function (t) { this.cfg.token = t; return this; };
  P.setDeveloperKey = function (k) { this.cfg.key = k; return this; };
  P.setAppId = function (a) { this.cfg.app = a; return this; };
  P.setOrigin = function (o) { this.cfg.origin = o; return this; };
  P.setCallback = function (cb) { this.cb = cb; return this; };
  P.build = function () { var b = this; return { setVisible: function () {
    if (window.__report) window.__report(b.cfg);
    var ids = window.__pick || [];
    setTimeout(function () { b.cb(ids.length ? { action: "picked", docs: ids.map(function (id) { return { id: id }; }) } : { action: "cancel" }); }, 50);
  } }; };
  return { DocsView: DocsView, PickerBuilder: PickerBuilder, ViewId: { FOLDERS: "folders" }, Feature: { MULTISELECT_ENABLED: "multiselect", SUPPORT_DRIVES: "drives" },
    Action: { PICKED: "picked", CANCEL: "cancel" }, Response: { ACTION: "action", DOCUMENTS: "docs" }, Document: { ID: "id" } };
})() };`;

export async function run({ ok, srv, google, sql, db, SELF, APP, APP_URL, ids }) {
  if (!ids.A) { ok(false, "the browser part needs the first part to have finished"); return; }
  const { chromium } = need("playwright");
  const browser = await chromium.launch();
  const SHOTS = path.join(process.cwd(), "shots-drive");
  fs.mkdirSync(SHOTS, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dn-drive-"));
  const problems = [];
  const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "en-NG", timezoneId: "Africa/Lagos", reducedMotion: "reduce" };
  const expected = (u) => u.includes("/rest/v1/rpc/") || u.includes("/functions/v1/dn-drive") || u.startsWith(google.url);     // refusals and the cut line are part of the test
  async function context(name, token) {
    const ctx = await browser.newContext(PHONE);
    await ctx.addInitScript((t) => { try { localStorage.setItem("editroom.token", t); localStorage.setItem("editroom.pushAsk", String(Date.now())); } catch (e) { /* none */ } }, token);
    await ctx.route("https://apis.google.com/js/api.js", (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: FAKE_PICKER }));
    // every message shown, and every line the upload's progress showed, so nothing brief is missed
    await ctx.addInitScript(() => {
      window.__toasts = []; window.__lines = [];
      const watch = () => {
        const t = document.getElementById("toast"), l = document.getElementById("s-progress");
        if (t && !t.hidden && window.__toasts[window.__toasts.length - 1] !== t.textContent) window.__toasts.push(t.textContent);
        if (l && window.__lines[window.__lines.length - 1] !== l.textContent) window.__lines.push(l.textContent);
      };
      new MutationObserver(watch).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    });
    ctx.on("page", (page) => {
      page.setDefaultTimeout(15000);
      page.on("console", (m) => { if ((m.type() === "error" || m.type() === "warning") && !expected(String(m.location().url)) && !/ERR_CONNECTION|net::ERR/.test(m.text())) problems.push(name + " console: " + m.text()); });
      page.on("pageerror", (e) => problems.push(name + " page error: " + e.message));
      page.on("requestfailed", (r) => { if (!expected(r.url())) problems.push(name + " request failed: " + r.url()); });
    });
    return ctx;
  }
  const opened = async (ctx) => { const p = await ctx.newPage(); await p.goto(APP_URL); await p.locator("#tabs").waitFor(); return p; };
  const toast = async (page, text, timeout) => { if (!(await until(() => page.evaluate((t) => window.__toasts.some((x) => x.includes(t)), text).catch(() => false), timeout || 15000))) throw new Error("no message: " + text); };
  const sheet = (page) => page.locator("#sheet");
  const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, name + ".png") });
  const until = async (fn, ms) => { const stop = Date.now() + (ms || 15000); while (Date.now() < stop) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };
  const video = (name, size) => { const buf = crypto.randomBytes(size), file = path.join(tmp, name); fs.writeFileSync(file, buf); return { file, size, hash: crypto.createHash("sha256").update(buf).digest("hex") }; };
  const inDrive = (name) => Array.from(google.files.values()).find((f) => f.name === name);
  const sessionFor = (name) => Array.from(google.sessions.entries()).find(([, s]) => s.meta.name === name);
  const project = async (id) => (await sql`select status, link from app.projects where id = ${id}`)[0];

  try {
    /* ------------------------------------------------ the admin's Settings */
    const actx = await context("admin", ids.A);
    let seen = null;
    await actx.exposeBinding("__report", (src, cfg) => { seen = cfg; });
    const admin = await opened(actx);
    await admin.locator('#tabs button[data-tab="settings"]').click();
    const panel = admin.locator("#drive-panel");
    await panel.getByText("Connected to").waitFor();
    ok(/Connected to studio@example\.com\. Editors can upload to these folders:/.test(await panel.innerText()) && (await panel.locator(".rows .row-title").allInnerTexts()).join() === "Menoprime,Proxan",
      "Settings show which Google account is connected, and the folders editors can upload to", (await panel.innerText()).replace(/\n/g, " | "));
    await panel.scrollIntoViewIfNeeded();
    await shot(admin, "1-settings-drive");
    await panel.getByRole("button", { name: "Remove Menoprime" }).click();
    await toast(admin, "Folder taken off the list. It stays in your Drive.");
    ok(await until(async () => (await panel.locator(".rows .row-title").allInnerTexts()).join() === "Proxan"), "the admin can take a folder off the list");
    const fMenotea = google.folder("Menotea");
    await actx.addInitScript((id) => { window.__pick = [id]; }, fMenotea);
    await panel.getByRole("link", { name: "Add folders" }).click();
    await toast(admin, "1 folder added. Editors can upload to it now.");
    ok(admin.url() === APP_URL && (await panel.locator(".rows .row-title").allInnerTexts()).join() === "Menotea,Proxan", "Add folders opens Google's picker, and the folders picked join the list", admin.url());
    ok(seen && seen.key === "test-api-key" && seen.app === "123456789012" && /^at-/.test(seen.token) && seen.origin === APP && seen.features.includes("multiselect")
      && seen.views[0].id === "folders" && seen.views[0].opts.setSelectFolderEnabled === true && seen.views[0].opts.setMimeTypes === "application/vnd.google-apps.folder",
      "the picker shows only folders, lets several be chosen, and is set up with the studio's key and project", JSON.stringify(seen));
    // cancelling the picker goes back, and changes nothing
    await actx.addInitScript(() => { window.__pick = []; });
    await panel.getByRole("link", { name: "Add folders" }).click();
    await admin.waitForURL(APP_URL);
    await admin.locator("#drive-panel").getByText("Connected to").waitFor();
    ok((await admin.locator("#drive-panel .rows .row-title").allInnerTexts()).join() === "Menotea,Proxan", "closing the picker goes back to Settings and changes nothing");
    // disconnecting, and connecting again through Google's screen
    await admin.locator("#drive-panel").getByRole("button", { name: "Disconnect" }).click();
    await sheet(admin).getByRole("button", { name: "Disconnect" }).click();
    await toast(admin, "Google Drive disconnected");
    await admin.locator("#drive-connect").waitFor();
    ok(/Connect the studio's Google Drive/.test(await admin.locator("#drive-panel").innerText()) && !/\b(null|undefined)\b/.test(await admin.locator("#drive-panel").innerText()), "once disconnected, Settings offer to connect it", await admin.locator("#drive-panel").innerText());
    await admin.route(google.url + "/auth**", (route) => {        // Google's screen, where the admin says yes
      const state = new URL(route.request().url()).searchParams.get("state");
      route.fulfill({ status: 302, headers: { Location: SELF + "?state=" + state + "&code=" + google.code(SELF) } });
    });
    await admin.locator("#drive-connect").click();
    await toast(admin, "Google Drive connected. Now add the folders editors can upload to.");
    await admin.locator("#drive-panel").getByText("Connected to").waitFor();
    ok(admin.url() === APP_URL && (await admin.locator("#drive-panel .rows .row-title").allInnerTexts()).join() === "Menotea,Proxan",
      "Connect Google Drive goes to Google and comes back connected, with the folders as they were", admin.url());

    /* ------------------------------------------------ an editor's upload, with the line dropping part way */
    const brief = (await db.rpc("er_log_brief", { p_token: ids.TA, p_name: "Proxan video 21", p_category: ids.cat })).id;
    const ectx = await context("ada", ids.TA);
    let ada = await opened(ectx);
    const card = (page, name) => page.locator("article.clip", { hasText: name });
    await card(ada, "Proxan video 21").getByRole("button", { name: "Submit video" }).click();
    await sheet(ada).getByRole("button", { name: "Upload the video" }).waitFor();
    const proxanId = (await db.rpc("er_state", { p_token: ids.TA })).settings.drive.folders.find((f) => f.name === "Proxan").id;
    ok((await ada.locator("#s-folder").inputValue()) === proxanId, "the folder named like the brief's category is chosen for the editor");
    const v1 = video("proxan21.mp4", 20 * 1024 * 1024 + 12345);
    await ada.setInputFiles("#s-file", v1.file);
    ok((await ada.locator("#s-file-info").innerText()) === "proxan21.mp4, 21 MB.", "the chosen video shows with its size", await ada.locator("#s-file-info").innerText());
    await shot(ada, "2-upload-ready");
    google.cut = 2; google.cutSkip = 1;            // the line drops part way through the second piece (and the browser's own quiet retry of it)
    await sheet(ada).getByRole("button", { name: "Upload and submit" }).click();
    await toast(ada, "Uploaded and submitted. The video is in your admin's Google Drive.", 40000);
    const lines = await ada.evaluate(() => window.__lines);
    ok(lines.some((l) => l === "The connection dropped. Trying again…") && lines.some((l) => /^\d+(\.\d)? MB of 21 MB uploaded \(\d+%\)/.test(l)) && google.cut === 0, "when the line drops, the editor is told it's trying again, and sees how far it has got", lines.slice(0, 12).join(" | "));
    const f1 = inDrive("Proxan video 21 (Ada Obi).mp4");
    ok(f1 && f1.sha256 === v1.hash && f1.parents[0] === ids.fProxan && f1.size === v1.size, "the video arrives whole in the chosen folder, despite the dropped line", f1 && JSON.stringify({ size: f1.size, parents: f1.parents }));
    const p1 = await project(brief);
    ok(p1.status === "submitted" && f1 && p1.link === "https://drive.google.com/file/d/" + f1.id + "/view" && google.perms.some((x) => x.file === f1.id && x.type === "anyone"), "the brief is submitted with the file's link, and the link opens it", JSON.stringify(p1));
    await card(ada, "Proxan video 21").getByText("Waiting for admin").waitFor();
    ok((await ada.evaluate((id) => localStorage.getItem("editroom.upload." + id), brief)) === null, "and the phone forgets the finished upload");

    /* ------------------------------------------------ the app closed part way, then opened again */
    const brief2 = (await db.rpc("er_log_brief", { p_token: ids.TA, p_name: "Proxan video 22", p_category: ids.cat })).id;
    await ada.reload();
    await card(ada, "Proxan video 22").getByRole("button", { name: "Submit video" }).click();
    const v2 = video("proxan22.mov", 20 * 1024 * 1024 + 777);
    await ada.setInputFiles("#s-file", v2.file);
    google.pieceDelay = 700;
    await sheet(ada).getByRole("button", { name: "Upload and submit" }).click();
    ok(await until(() => { const s = sessionFor("Proxan video 22 (Ada Obi).mov"); return !!s && s[1].received >= 8 * 1024 * 1024; }, 20000), "the first piece reaches Google");
    await shot(ada, "4-uploading");
    await ada.close();                               // the editor closes the app part way
    google.pieceDelay = 0;
    ada = await opened(ectx);
    await card(ada, "Proxan video 22").getByRole("button", { name: "Submit video" }).click();
    ok((await ada.locator("#s-file-info").innerText()) === "You started uploading proxan22.mov (21 MB). Choose the same video to carry on from where it stopped.", "opening it again offers to carry on", await ada.locator("#s-file-info").innerText());
    await ada.setInputFiles("#s-file", v2.file);
    ok(/It carries on from where the last upload stopped\.$/.test(await ada.locator("#s-file-info").innerText()), "and recognises the same video");
    await sheet(ada).getByRole("button", { name: "Upload and submit" }).click();
    await toast(ada, "Uploaded and submitted.", 30000);
    const [sid2] = sessionFor("Proxan video 22 (Ada Obi).mov") || [];
    const f2 = inDrive("Proxan video 22 (Ada Obi).mov");
    ok(f2 && f2.sha256 === v2.hash && f2.mimeType === "video/quicktime", "the video arrives whole", f2 && f2.mimeType);
    ok(google.bytesIn.get(sid2) === v2.size && Array.from(google.sessions.values()).filter((s) => s.meta.name === "Proxan video 22 (Ada Obi).mov").length === 1, "it carried on in the same upload: nothing Google already had was sent again", String(google.bytesIn.get(sid2)) + " of " + v2.size);
    ok((await project(brief2)).status === "submitted", "and the brief is submitted");

    /* ------------------------------------------------ stopping an upload, and carrying on */
    const brief3 = (await db.rpc("er_log_brief", { p_token: ids.TA, p_name: "Proxan video 23", p_category: ids.cat })).id;
    await ada.reload();
    await card(ada, "Proxan video 23").getByRole("button", { name: "Submit video" }).click();
    const v3 = video("proxan23.mp4", 10 * 1024 * 1024 + 99);
    await ada.setInputFiles("#s-file", v3.file);
    google.pieceDelay = 700;
    await sheet(ada).getByRole("button", { name: "Upload and submit" }).click();
    await until(() => { const s = sessionFor("Proxan video 23 (Ada Obi).mp4"); return !!s && s[1].received >= 8 * 1024 * 1024; }, 20000);
    await ada.keyboard.press("Escape");
    ok(await sheet(ada).evaluate((d) => d.open), "while a video uploads, the sheet doesn't close by accident");
    await sheet(ada).getByRole("button", { name: "Stop upload" }).click();
    await sheet(ada).getByRole("button", { name: "Carry on uploading" }).waitFor();
    ok(/^Upload stopped at .+ of 10 MB\. Press Carry on uploading, or come back later and choose the same video\.$/.test(await ada.locator("#s-file-info").innerText()), "Stop upload stops it and says how far it got", await ada.locator("#s-file-info").innerText());
    await shot(ada, "5-upload-stopped");
    google.pieceDelay = 0;
    await sheet(ada).getByRole("button", { name: "Carry on uploading" }).click();
    await toast(ada, "Uploaded and submitted.", 30000);
    const f3 = inDrive("Proxan video 23 (Ada Obi).mp4");
    ok(f3 && f3.sha256 === v3.hash && (await project(brief3)).status === "submitted", "Carry on uploading finishes it");

    /* ------------------------------------------------ pasting a link still works, and so does a phone without Drive */
    const brief4 = (await db.rpc("er_log_brief", { p_token: ids.TA, p_name: "Proxan video 24", p_category: ids.cat })).id;
    await ada.reload();
    await card(ada, "Proxan video 24").getByRole("button", { name: "Submit video" }).click();
    await sheet(ada).getByRole("button", { name: "Paste a link" }).click();
    await ada.fill("#s-link", "https://drive.google.com/file/d/pasted24/view");
    await sheet(ada).getByRole("button", { name: "Submit project" }).click();
    await toast(ada, "Submitted. It's now in your admin's inbox.");
    ok((await project(brief4)).link === "https://drive.google.com/file/d/pasted24/view", "the editor can still paste a link instead");
    await admin.locator("#drive-panel").getByRole("button", { name: "Disconnect" }).click();
    await sheet(admin).getByRole("button", { name: "Disconnect" }).click();
    await toast(admin, "Google Drive disconnected");
    const brief5 = (await db.rpc("er_log_brief", { p_token: ids.TA, p_name: "Proxan video 25", p_category: ids.cat })).id;
    await ada.reload();
    await card(ada, "Proxan video 25").getByRole("button", { name: "Submit with Drive link" }).waitFor();
    ok(!!brief5, "with Drive disconnected, editors submit with a link as before");
    await browser.close();
  } catch (e) {
    ok(false, "the browser run stopped early", String(e && e.message).split("\n").slice(0, 4).join(" / "));
    await browser.close().catch(() => {});
  }
  ok(!problems.length, "no browser errors, blocked requests or security-policy violations", problems.slice(0, 8).join(" || "));
}
