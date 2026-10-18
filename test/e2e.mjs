// Walks the whole app in a real browser on a phone-sized screen: first-run setup, team logins, an editor's day,
// the admin's inbox, deadlines, reassigning, pay, bonuses, the leaderboard, accounts, and a dropped connection.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { startServer } from "./server.mjs";

// Playwright comes from this folder's node_modules, or from a shared install named in GLOBAL_MODULES.
const local = createRequire(import.meta.url);
const need = (name) => { try { return local(name); } catch (e) { if (!process.env.GLOBAL_MODULES) throw e; return createRequire(process.env.GLOBAL_MODULES)(name); } };
const { chromium } = need("playwright");

const SHOTS = process.env.SHOTS || path.join(process.cwd(), "shots");
fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
let failed = 0;
const ok = (cond, label, extra) => { if (!cond) failed++; results.push((cond ? "PASS " : "FAIL ") + label + (extra ? "  -> " + extra : "")); if (!cond) console.log("FAIL " + label + (extra ? "  -> " + extra : "")); };
const problems = [];

const srv = await startServer(0);
const browser = await chromium.launch();
// reduced motion: sheets and messages appear at once, so a screenshot never catches one halfway in
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "en-US", timezoneId: "America/Los_Angeles", reducedMotion: "reduce" };

async function open(name, extra) {
  const ctx = await browser.newContext(Object.assign({}, PHONE, extra || {}));
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  // a refused action (wrong password, taken name) is an expected "400" from the server, not a fault in the page
  page.on("console", (m) => { if ((m.type() === "error" || m.type() === "warning") && !String(m.location().url).includes("/rest/v1/rpc/")) problems.push(name + " console " + m.type() + ": " + m.text()); });
  page.on("pageerror", (e) => problems.push(name + " page error: " + e.message));
  page.on("requestfailed", (r) => { if (!r.url().includes("/rest/v1/rpc/")) problems.push(name + " request failed: " + r.url()); });
  // Google Drive's player is out of reach here, so a plain stand-in answers for it; every address asked for is kept
  await page.route("https://drive.google.com/**", (route) => {
    drive.push(route.request().url());
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: '<!doctype html><title>Drive player</title><body style="margin:0;height:100vh;display:grid;place-items:center;background:#111;color:#bbb;font:15px system-ui">Google Drive\'s player shows here</body>' });
  });
  await page.goto(srv.url + "/");
  return page;
}
const drive = [];
const playerOpen = (page) => page.evaluate(() => document.getElementById("player").open);
const frameSrc = (page) => page.evaluate(() => { const f = document.querySelector("#player iframe"); return f ? f.getAttribute("src") : null; });
const sql = (text, params) => srv.sql(text, params);
const sync = (page) => page.evaluate(() => { document.dispatchEvent(new Event("visibilitychange")); });
const tab = (page, id) => page.locator('#tabs button[data-tab="' + id + '"]').click();
const sheet = (page) => page.locator("#sheet");
const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const pick = async (page, sel, value) => { await page.selectOption(sel, value); await settle(page); };
const closed = (page) => page.waitForFunction(() => !document.getElementById("sheet").open);
const toast = async (page, text) => { await page.locator("#toast", { hasText: text }).waitFor(); };
const until = async (fn, ms) => { const stop = Date.now() + (ms || 8000); while (Date.now() < stop) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };
const see = async (page, text, label) => {
  try { await page.getByText(text).first().waitFor(); ok(true, label); }
  catch (e) { ok(false, label, "did not find: " + text); }
};
const gone = async (page, text, label) => {
  try { await page.getByText(text).first().waitFor({ state: "hidden" }); ok(true, label); }
  catch (e) { ok(false, label, "still showing: " + text); }
};
async function look(page, name, label) {
  await page.waitForTimeout(120);
  const m = await page.evaluate(() => {
    const d = document.documentElement, wide = d.scrollWidth - d.clientWidth;
    const unlabeled = Array.from(document.querySelectorAll("input, select, textarea")).filter((el) => el.type !== "hidden" && !(el.labels && el.labels.length) && !el.getAttribute("aria-label")).map((el) => el.id || el.name || el.type);
    const small = Array.from(document.querySelectorAll("button, a.btn, select, input:not([type=file]):not([type=radio])")).filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.height < 36 || r.width < 36) && !el.closest(".spark"); }).map((el) => (el.textContent || el.id || el.tagName).trim().slice(0, 24) + " " + Math.round(el.getBoundingClientRect().width) + "x" + Math.round(el.getBoundingClientRect().height));
    // a value that was never filled in shows up as one of these words
    const all = document.body.innerText + " " + Array.from(document.querySelectorAll("[aria-label], [title], [placeholder]")).map((el) => [el.getAttribute("aria-label"), el.getAttribute("title"), el.getAttribute("placeholder")].join(" ")).join(" ");
    const stray = Array.from(all.matchAll(/\b(null|undefined|NaN|Infinity)\b|\[object /g)).map((m) => JSON.stringify(all.slice(Math.max(0, m.index - 40), m.index + 20))).join(", ");      // with what's around it
    return { wide, unlabeled, small, stray };
  });
  ok(!m.stray, (label || name) + ": no unfilled values on screen", m.stray);
  ok(m.wide <= 1, (label || name) + ": no sideways scroll", m.wide + "px too wide");
  ok(!m.unlabeled.length, (label || name) + ": every field has a label", m.unlabeled.join(", "));
  ok(!m.small.length, (label || name) + ": touch targets are big enough", m.small.join(" | "));
  await page.screenshot({ path: path.join(SHOTS, name + ".png"), fullPage: !(await page.evaluate(() => document.getElementById("sheet").open || document.getElementById("player").open)) });
}

try {
  /* ------------------------------------------------------------ first run */
  const admin = await open("admin", { permissions: ["clipboard-read", "clipboard-write"] });
  await see(admin, "Set up DN Studios", "a fresh app opens on the setup screen");
  ok((await admin.title()) === "DN Studios" && (await admin.locator("h1.brand").innerText()).replace(/\s+/g, " ").trim() === "DN Studios", "the app carries the studio's name", await admin.locator("h1.brand").innerText());
  await look(admin, "01-setup", "setup screen");
  await admin.fill("#su-code", "nope-nope");
  await admin.fill("#su-name", "Sam Okafor");
  await admin.fill("#su-user", "sam");
  await admin.fill("#su-pass", "admin-pass-1");
  await admin.getByRole("button", { name: "Create my admin login" }).click();
  await see(admin, "That setup code isn't right.", "a wrong setup code is refused with a clear message");
  await admin.fill("#su-code", srv.code.toLowerCase());
  await admin.getByRole("button", { name: "Create my admin login" }).click();
  await see(admin, "Get your team started", "the right code creates the admin and opens the inbox");
  const navAt = await admin.evaluate(() => { const r = document.getElementById("tabs").getBoundingClientRect(); return { bottom: Math.round(innerHeight - r.bottom), fixed: getComputedStyle(document.getElementById("tabs")).position }; });
  ok(navAt.fixed === "fixed" && navAt.bottom === 0, "on a phone the sections sit in a bar along the bottom of the screen", JSON.stringify(navAt));
  ok((await admin.locator("#who").innerText()).replace(/\s+/g, " ").toLowerCase().includes("sam okafor admin"), "the header shows who is signed in and their role", await admin.locator("#who").innerText());
  await look(admin, "02-inbox-empty", "empty inbox");

  /* ------------------------------------------------------------ settings: categories, pay, team */
  await tab(admin, "settings");
  await see(admin, "Team logins", "settings opens");
  for (const [name, pay] of [["Shorts", "15"], ["Long form", "60"], ["Ads", ""]]) {
    await admin.fill("#cat-new", name);
    await admin.fill("#cat-rate", pay);
    await admin.locator(".inline-form button[type=submit]").click();
    await admin.locator(".rows .tape", { hasText: name }).waitFor();
  }
  ok((await admin.locator(".rows .tape").count()) === 3, "three categories are listed");
  await admin.fill("#cat-new", "shorts");
  await admin.locator(".inline-form button[type=submit]").click();
  await toast(admin, "already on the list");
  ok(true, "a duplicate category is refused");
  await admin.fill("#cat-new", "Made by mistake");
  await admin.fill("#cat-rate", "");
  await admin.locator(".inline-form button[type=submit]").click();
  const oops = admin.locator("#view .rows > li", { hasText: "Made by mistake" });
  await oops.getByRole("button", { name: "Edit" }).click();
  await sheet(admin).getByRole("button", { name: "Remove category" }).click();
  await sheet(admin).getByText("from the list editors pick from?").waitFor();
  await sheet(admin).getByRole("button", { name: "Remove category" }).click();
  await toast(admin, "Category removed");
  await closed(admin);
  ok((await admin.locator(".rows .tape").count()) === 3, "a category can be removed from its Edit sheet");
  await admin.fill("#cat-new", "");
  // each Settings panel has a Save changes button, which lights up while a change there isn't saved yet
  const savePay = admin.locator("#save-pay"), payNote = admin.locator("#save-pay + .unsaved");
  const lit = (loc) => loc.evaluate((b) => b.classList.contains("primary"));
  ok(!(await lit(savePay)) && !(await payNote.isVisible()) && (await savePay.innerText()) === "Save changes", "with nothing changed, Save changes is there but quiet");
  await admin.fill("#set-currency", "$");
  await admin.fill("#set-target", "5");
  await admin.fill("#set-bonus", "25");
  ok((await lit(savePay)) && (await payNote.innerText()) === "Not saved yet" && !(await lit(admin.locator("#save-deadlines"))), "a change lights up that panel's Save changes, and says it isn't saved yet");
  await tab(admin, "inbox");
  await tab(admin, "settings");
  ok((await admin.inputValue("#set-currency")) === "$" && (await admin.inputValue("#set-target")) === "5" && (await admin.inputValue("#set-bonus")) === "25" && (await lit(savePay)), "a change that isn't saved yet is still there after going to another screen and back");
  ok((await sql("select currency from app.meta")).rows[0].currency === "", "and nothing is saved until Save changes is pressed");
  await admin.locator("#set-bonus").scrollIntoViewIfNeeded();
  await look(admin, "02b-settings-unsaved", "settings with a change not saved yet");
  await savePay.click();
  await toast(admin, "Changes saved");
  const meta1 = (await sql("select currency, weekly_target, bonus_default::float as bonus from app.meta")).rows[0];
  ok(meta1.currency === "$" && meta1.weekly_target === 5 && meta1.bonus === 25 && !(await lit(savePay)) && !(await payNote.isVisible()), "Save changes saves them, and the button goes quiet again", JSON.stringify(meta1));
  await admin.locator("#toast").waitFor({ state: "hidden" });
  await admin.locator("#save-pay").click();
  await toast(admin, "No changes to save.");
  ok(true, "pressing it with nothing changed says so");
  await see(admin, "$15 per video", "pay rates show with the currency");

  const logins = {};
  for (const name of ["Ada Obi", "Tunde Bello", "Chidi Nwosu"]) {
    await admin.locator("#add-user").click();
    await admin.fill("#nu-name", name);
    const username = await admin.inputValue("#nu-user"), password = await admin.inputValue("#nu-pass");
    ok(username === name.toLowerCase().replace(" ", ".") && /^[a-z0-9]{5}-[a-z0-9]{5}$/.test(password), "a username and a strong password are suggested for " + name, username + " / " + password);
    if (name === "Ada Obi") await look(admin, "03-add-login", "add login sheet");
    await sheet(admin).getByRole("button", { name: "Create login" }).click();
    await sheet(admin).getByText("Login created").waitFor();
    const cred = await admin.locator("#cred-text").innerText();
    ok(cred.startsWith("DN Studios login for " + name) && cred.includes("Username: " + username) && cred.includes("Password: " + password) && cred.includes(srv.url + "/"), "the new login is shown once, with the link to the app", cred.replace(/\n/g, " | "));
    if (name === "Ada Obi") {
      await look(admin, "04-login-created", "login created sheet");
      await sheet(admin).getByRole("button", { name: "Copy" }).click();
      await sheet(admin).getByRole("button", { name: "Copied" }).waitFor();
      ok((await admin.evaluate(() => navigator.clipboard.readText())) === cred, "Copy puts the login details on the clipboard");
    }
    await sheet(admin).getByRole("button", { name: "Done" }).click();
    await closed(admin);
    logins[name] = { username, password };
  }
  await admin.locator("#add-user").click();
  await admin.fill("#nu-name", "Ada Again");
  await admin.fill("#nu-user", "ada.obi");
  await sheet(admin).getByRole("button", { name: "Create login" }).click();
  await see(admin, "That username is already in use.", "a taken username is refused");
  await admin.fill("#nu-user", "A B");
  await sheet(admin).getByRole("button", { name: "Create login" }).click();
  await see(admin, "Usernames are 3 to 24 characters", "a bad username is explained");
  await sheet(admin).getByRole("button", { name: "Cancel" }).click();
  await closed(admin);
  ok((await admin.locator("#view .rows").first().locator("> li").count()) === 4, "the team list shows the admin and three editors");
  await look(admin, "05-settings", "settings");

  /* ------------------------------------------------------------ an editor signs in and logs a brief */
  const ada = await open("ada");
  await see(ada, "Use the username and password your admin gave you.", "a set-up app opens on the sign-in screen");
  await look(ada, "06-sign-in", "sign-in screen");
  await ada.fill("#li-user", "ada.obi");
  await ada.fill("#li-pass", "not-the-password");
  await ada.getByRole("button", { name: "Sign in" }).click();
  await see(ada, "Wrong username or password.", "a wrong password is refused");
  await ada.fill("#li-user", " Ada.Obi ");
  await ada.fill("#li-pass", logins["Ada Obi"].password);
  await ada.getByRole("button", { name: "Sign in" }).click();
  await see(ada, "Nothing in progress.", "the editor lands on My work");
  ok((await ada.locator("#tabs button").allInnerTexts()).join("|").replace(/\s+/g, " ") === "My work|Leaderboard|Earnings", "an editor sees only the editor tabs", (await ada.locator("#tabs button").allInnerTexts()).join("|"));
  await look(ada, "07-editor-empty", "editor empty state");

  await ada.getByRole("button", { name: "Log a new brief" }).click();
  await sheet(ada).getByRole("button", { name: "Log brief" }).click();
  await see(ada, "Enter the project name.", "a brief needs a name");
  await ada.fill("#b-name", "Night market short");
  await sheet(ada).getByRole("button", { name: "Log brief" }).click();
  await see(ada, "Choose a category.", "a brief needs a category");
  await ada.selectOption("#b-cat", { label: "Shorts" });
  await look(ada, "08-log-brief", "log brief sheet");
  await sheet(ada).getByRole("button", { name: "Log brief" }).click();
  await toast(ada, "Your 24-hour deadline has started");
  await closed(ada);
  const card = ada.locator("article.clip", { hasText: "Night market short" });
  await card.waitFor();
  ok(/Due in (23h 5\dm|24h)/.test(await card.innerText()), "the 24-hour clock starts when the brief is logged", (await card.locator(".pills").innerText()).trim());
  ok((await card.getByRole("button").allInnerTexts()).join("|") === "Started|Rough cut|Polishing|Submit with Drive link|Add update", "a logged brief offers progress, an update and submit, and no way to edit or delete it", (await card.getByRole("button").allInnerTexts()).join("|"));
  await card.getByRole("button", { name: "Rough cut" }).click();
  await ada.locator('article.clip button[aria-pressed="true"]', { hasText: "Rough cut" }).waitFor();
  ok(true, "the editor can move the stage along");
  await card.getByRole("button", { name: "Add update" }).click();
  await ada.fill("#u-text", "Waiting on the voice-over");
  await sheet(ada).getByRole("button", { name: "Save update" }).click();
  await closed(ada);
  await see(ada, "Waiting on the voice-over", "the editor can add a progress update");
  await look(ada, "09-editor-working", "editor with a brief in progress");

  // the admin sees it in progress without doing anything
  await sync(admin);
  await tab(admin, "inbox");
  await admin.locator(".stat", { hasText: "In progress" }).locator(".stat-num", { hasText: "1" }).waitFor();
  ok(true, "the admin's inbox counts the brief as in progress");
  const inRow = admin.locator("#in-progress li", { hasText: "Night market short" });
  await inRow.waitFor();
  ok(/Ada Obi/.test(await inRow.innerText()) && /Shorts, logged (just now|\dm ago), rough cut/.test(await inRow.innerText()) && /Latest update: Waiting on the voice-over/.test(await inRow.innerText()) && /Due in 2[34]h/.test(await inRow.innerText()),
    "and lists it under In progress, with who has it, how far along it is and how long is left", (await inRow.innerText()).replace(/\n/g, " | "));
  await admin.locator("#in-progress").scrollIntoViewIfNeeded();
  await look(admin, "10a-admin-inbox-progress", "admin inbox with a brief in progress");
  await tab(admin, "projects");
  const aCard = admin.locator("#p-list article.clip", { hasText: "Night market short" });
  await aCard.waitFor();
  ok(/Ada Obi/.test(await aCard.innerText()) && /Waiting on the voice-over/.test(await aCard.innerText()) && /Stage 2 of 3/.test(await aCard.locator(".track").getAttribute("aria-label")), "the admin sees who has it, the stage and the latest update");
  await look(admin, "10-admin-projects-active", "admin projects, one in progress");

  await card.getByRole("button", { name: "Submit with Drive link" }).click();
  await sheet(ada).getByRole("button", { name: "Submit project" }).click();
  await see(ada, "Paste the full Google Drive link", "submitting needs a link");
  await ada.fill("#s-link", "drive.google.com/file/d/abc123/view?usp=sharing");
  await ada.fill("#s-note", "Final cut, captions burned in");
  await look(ada, "11-submit", "submit sheet");
  await sheet(ada).getByRole("button", { name: "Submit project" }).click();
  await toast(ada, "It's now in your admin's inbox");
  await closed(ada);
  const done = ada.locator("article.clip", { hasText: "Night market short" });
  ok(/On time/.test(await done.innerText()) && /Waiting for admin/.test(await done.innerText()) && /\$15 once your admin marks it received/.test(await done.innerText()), "the submitted project shows on time, waiting, and what it will pay", (await done.innerText()).replace(/\n/g, " | "));
  ok((await done.getByRole("button").count()) === 0, "nothing on a submitted project can be changed by the editor");
  await tab(ada, "earn");
  await see(ada, "Waiting for your admin", "earnings lists work that is waiting");
  await look(ada, "12-earnings-waiting", "earnings before anything is received");

  /* ------------------------------------------------------------ the admin downloads and receives */
  await tab(admin, "inbox");
  await sync(admin);
  const inbox = admin.locator("article.clip", { hasText: "Night market short" });
  await inbox.getByRole("button", { name: "Mark received" }).waitFor();
  const href = await inbox.getByRole("link", { name: "Open Drive link" }).getAttribute("href");
  ok(href === "https://drive.google.com/file/d/abc123/view?usp=sharing" && (await inbox.getByRole("link", { name: "Open Drive link" }).getAttribute("target")) === "_blank", "the Drive link opens in one tap, in a new tab", href);
  ok(/Final cut, captions burned in/.test(await inbox.innerText()) && (await admin.locator('#tabs button[data-tab="inbox"] .count').innerText()) === "1", "the inbox shows the editor's note and counts what is waiting");
  const recvBtn = inbox.getByRole("button", { name: "Mark received" });
  const glowing = await recvBtn.evaluate((b) => ({ cls: b.classList.contains("glow"), ring: getComputedStyle(b).boxShadow }));
  ok(glowing.cls && /rgba\(255, 210, 30/.test(glowing.ring), "a submitted video's Mark received button glows (still, for people who turn off motion)", JSON.stringify(glowing));
  const moving = await browser.newContext(Object.assign({}, PHONE, { reducedMotion: "no-preference" }));
  const mp = await moving.newPage();
  await mp.goto(srv.url + "/");
  await mp.evaluate((t) => localStorage.setItem("editroom.token", t), await admin.evaluate(() => localStorage.getItem("editroom.token")));
  await mp.reload();
  const pulse = await mp.locator("article.clip", { hasText: "Night market short" }).getByRole("button", { name: "Mark received" }).evaluate((b) => getComputedStyle(b).animationName + " " + getComputedStyle(b).animationIterationCount);
  ok(pulse === "glow infinite", "and pulses for everyone else", pulse);
  await moving.close();
  await look(admin, "13-inbox-waiting", "inbox with a submission");

  /* ------------------------------------------------------------ video of the moment */
  ok((await admin.locator(".reel").count()) === 0 && /Nothing is showing yet\./.test(await admin.locator("#view").innerText()), "the admin's home screen has a Video of the moment panel, empty to begin with");
  await tab(ada, "work");
  await sync(ada);
  await ada.locator("article.clip", { hasText: "Night market short" }).waitFor();
  ok((await ada.getByText("Video of the moment").count()) === 0, "with nothing featured, editors see no panel at all");
  await inbox.getByRole("button", { name: "Make video of the moment" }).click();
  await toast(admin, "Now showing on everyone's home screen");
  const tile = admin.locator(".reel .shot", { hasText: "Night market short" });
  await tile.waitFor();
  ok((await tile.evaluate((el) => el.tagName)) === "BUTTON" && (await tile.getAttribute("aria-label")) === "Play Night market short, by Ada Obi" && /Ada Obi/.test(await tile.innerText()) && /Shorts/.test(await tile.innerText()), "one click puts the video on the admin's home screen, ready to play", (await tile.innerText()).replace(/\n/g, " | "));
  ok(/Video of the moment/.test(await inbox.locator(".pills").innerText()) && (await inbox.getByRole("button", { name: "Take down from home screen" }).count()) === 1, "the video's card says it is showing, and offers to take it down");
  await look(admin, "13b-inbox-moment", "inbox with a video of the moment");
  // tapping it plays it right here, in Drive's own player
  await tile.click();
  await admin.locator("#player .player-frame").waitFor();
  ok((await frameSrc(admin)) === "https://drive.google.com/file/d/abc123/preview", "tapping it opens Drive's player inside the app, for that file", await frameSrc(admin));
  await admin.frameLocator("#player .player-frame").getByText("Google Drive's player shows here").waitFor();
  ok(drive.includes("https://drive.google.com/file/d/abc123/preview"), "the page's security rules let Drive's player load");
  const pl = admin.locator("#player");
  ok((await pl.locator(".player-title").innerText()) === "Night market short" && /Ada Obi/.test(await pl.locator(".player-by").innerText()) && /Shorts/.test(await pl.locator(".player-by").innerText()), "the player says what the video is and whose it is", (await pl.locator(".player-head").innerText()).replace(/\n/g, " | "));
  const out = pl.getByRole("link", { name: "Open in Google Drive" });
  ok((await out.getAttribute("href")) === href && (await out.getAttribute("target")) === "_blank" && /may not be shared with you/.test(await pl.locator(".player-foot").innerText()), "if the player can't show it, the Drive file is one tap away", await out.getAttribute("href"));
  ok(await admin.evaluate(() => document.activeElement && document.activeElement.classList.contains("player-close")), "the Close button has the focus, so the video closes with one key");
  const fr = await admin.evaluate(() => { const f = document.querySelector("#player iframe"); const r = f.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), allow: f.getAttribute("allow"), full: f.hasAttribute("allowfullscreen"), ref: f.getAttribute("referrerpolicy") }; });
  ok(fr.w === 390 && fr.h > 560 && fr.full && fr.ref === "strict-origin-when-cross-origin", "the player fills the screen and can go full screen, so upright and wide videos both fit", JSON.stringify(fr));
  await look(admin, "13d-player", "video playing in the app");
  await admin.keyboard.press("Escape");
  await admin.waitForFunction(() => !document.getElementById("player").open && !document.querySelector("#player iframe"));
  ok((await admin.locator("#player iframe").count()) === 0 && (await admin.evaluate(() => document.activeElement && document.activeElement.dataset.fk)) === (await tile.getAttribute("data-fk")), "closing stops the video and puts you back on its tile");
  await sync(ada);
  const mine = ada.locator(".reel .shot", { hasText: "Night market short" });
  await mine.waitFor();
  ok(/Ada Obi \(you\)/.test(await mine.innerText()) && (await ada.locator(".reel-item > button:not(.shot)").count()) === 0 && (await ada.getByRole("button", { name: "Add a video" }).count()) === 0, "every editor sees it on their home screen, and has no way to change it");
  await mine.click();
  await ada.locator("#player .player-frame").waitFor();
  ok((await frameSrc(ada)) === "https://drive.google.com/file/d/abc123/preview" && /Ada Obi \(you\)/.test(await ada.locator("#player .player-by").innerText()), "an editor plays it in the app too", await frameSrc(ada));
  await ada.locator("#player").getByRole("button", { name: "Close" }).click();
  ok(!(await playerOpen(ada)) && (await ada.locator("#player iframe").count()) === 0, "the Close button stops the video at once");
  ok(/Video of the moment/.test(await ada.locator("article.clip", { hasText: "Night market short" }).locator(".pills").innerText()), "the editor's own card carries the Video of the moment mark");
  await look(ada, "13c-editor-moment", "editor home screen with a video of the moment");
  await tab(ada, "earn");
  await inbox.getByRole("button", { name: "Mark received" }).click();
  await toast(admin, "$15 added to Ada Obi's earnings");
  await see(admin, "Nothing waiting.", "a received project leaves the inbox");
  await sync(ada);
  await ada.locator(".week-num", { hasText: "$15" }).waitFor();
  ok(/Night market short/.test(await ada.locator("#view").innerText()), "the editor's earnings show the video and the total");
  await look(ada, "14-earnings-paid", "earnings after a video is received");

  /* ------------------------------------------------------------ deadlines: 24 hours, then grace, then reassign */
  await tab(ada, "work");
  await ada.getByRole("button", { name: "Log a new brief" }).click();
  await ada.fill("#b-name", "Fuel prices explained");
  await ada.selectOption("#b-cat", { label: "Long form" });
  await sheet(ada).getByRole("button", { name: "Log brief" }).click();
  await closed(ada);
  await sql("update app.projects set started_at = now() - interval '30 hours', updated_at = now() - interval '30 hours' where name = 'Fuel prices explained' and status = 'active'");
  await sync(ada);
  await see(ada, "Deadline passed: Fuel prices explained", "once 24 hours are up the editor gets a deadline alert");
  ok(/Deadline passed 6h ago|Deadline passed 5h 5\dm ago/.test(await ada.locator("article.clip", { hasText: "Fuel prices explained" }).innerText()) && (await ada.locator('#tabs button[data-tab="work"] .count').innerText()) === "1", "the alert says how long ago, and the tab carries a red count");
  await look(ada, "15-editor-late", "editor past the deadline");
  await sync(admin);
  await see(admin, "Past the deadline", "the admin's inbox lists work past its deadline");
  ok(/Past deadline by (6h|5h 5\dm)/.test(await admin.locator("article.clip", { hasText: "Fuel prices explained" }).innerText()), "the admin sees by how long");
  await sql("update app.projects set started_at = now() - interval '80 hours', updated_at = now() - interval '80 hours' where name = 'Fuel prices explained' and status = 'active'");
  await sync(ada);
  await see(ada, "Grace period over: Fuel prices explained", "when the grace period ends the editor is told it can be reassigned");
  await look(ada, "16-editor-grace-over", "editor after the grace period");
  await sync(admin);
  const pastCard = admin.locator("article.clip", { hasText: "Fuel prices explained" });
  await pastCard.getByText(/Grace over by (8h|7h 5\dm)/).waitFor();
  ok((await admin.locator(".stat.flag-crit .stat-num").innerText()) === "1", "the admin sees the grace period is over");
  await look(admin, "17-inbox-overdue", "inbox with overdue work");
  await pastCard.getByRole("button", { name: "Reassign" }).click();
  await sheet(admin).getByText("Pick who takes it over").waitFor();
  ok((await sheet(admin).locator(".option-name").allInnerTexts()).join("|") === "Tunde Bello|Chidi Nwosu", "reassign offers the other editors", (await sheet(admin).locator(".option-name").allInnerTexts()).join("|"));
  await sheet(admin).getByRole("button", { name: "Reassign" }).click();
  await see(admin, "Pick an editor.", "reassign needs a choice");
  await sheet(admin).locator(".option", { hasText: "Tunde Bello" }).click();
  await look(admin, "18-reassign", "reassign sheet");
  await sheet(admin).getByRole("button", { name: "Reassign" }).click();
  await toast(admin, "Reassigned to Tunde Bello");
  await closed(admin);
  await sync(ada);
  await see(ada, "Reassigned: Fuel prices explained", "the first editor is told the script was reassigned");
  await look(ada, "19-editor-reassigned", "editor told of the reassignment");
  await ada.getByRole("button", { name: "Got it" }).click();
  await gone(ada, "Reassigned: Fuel prices explained", "the notice can be dismissed");
  await see(ada, "Moved to another editor", "the reassigned project stays on the first editor's record");

  const tunde = await open("tunde");
  await tunde.fill("#li-user", logins["Tunde Bello"].username);
  await tunde.fill("#li-pass", logins["Tunde Bello"].password);
  await tunde.getByRole("button", { name: "Sign in" }).click();
  const tCard = tunde.locator("article.clip", { hasText: "Fuel prices explained" });
  await tCard.waitFor();
  ok(/Assigned to you by your admin/.test(await tCard.innerText()) && /Due in (23h 5\dm|24h)/.test(await tCard.innerText()), "the new editor gets it as a fresh brief with a fresh 24 hours");
  const seen = tunde.locator(".reel .shot", { hasText: "Night market short" });
  await seen.waitFor();
  ok(/Ada Obi/.test(await seen.innerText()) && !/\(you\)/.test(await seen.innerText()) && (await seen.getAttribute("aria-label")) === "Play Night market short, by Ada Obi", "another editor sees the video of the moment, whose it is, and can play it");

  /* ------------------------------------------------------------ send back, submit again */
  await tCard.getByRole("button", { name: "Submit with Drive link" }).click();
  await tunde.fill("#s-link", "https://example.com/wrong-file");
  await see(tunde, "This doesn't look like a Google Drive link", "a link that isn't Google Drive gets a warning");
  await sheet(tunde).getByRole("button", { name: "Submit project" }).click();
  await closed(tunde);
  await sync(admin);
  const back = admin.locator("article.clip", { hasText: "Fuel prices explained" });
  await back.getByRole("button", { name: "Send back" }).waitFor();
  ok(/Not a Google Drive link/.test(await back.innerText()), "the admin is warned about a link that isn't Google Drive");
  await back.getByRole("button", { name: "Send back" }).click();
  await admin.fill("#sb-note", "Wrong file, please send the final cut");
  await sheet(admin).getByRole("button", { name: "Send back" }).click();
  await toast(admin, "Sent back to Tunde Bello");
  await closed(admin);
  await sync(tunde);
  await see(tunde, "Wrong file, please send the final cut", "the editor sees why it came back");
  await look(tunde, "20-sent-back", "editor with work sent back");
  await tunde.locator("article.clip", { hasText: "Fuel prices explained" }).getByRole("button", { name: "Submit with Drive link" }).click();
  await tunde.fill("#s-link", "https://drive.google.com/file/d/final999/view");
  await sheet(tunde).getByRole("button", { name: "Submit project" }).click();
  await closed(tunde);
  await sync(admin);
  await admin.locator("article.clip", { hasText: "Fuel prices explained" }).getByRole("button", { name: "Mark received" }).click();
  await toast(admin, "$60 added to Tunde Bello's earnings");
  await admin.getByRole("button", { name: "Add a video" }).click();
  await sheet(admin).getByText("Add a video of the moment").waitFor();
  ok((await sheet(admin).locator(".option-name").allInnerTexts()).join("|") === "Fuel prices explained", "Add a video lists the finished videos that are not showing yet", (await sheet(admin).locator(".option-name").allInnerTexts()).join("|"));
  await sheet(admin).getByRole("button", { name: "Add this video" }).click();
  await see(admin, "Pick a video.", "adding needs a choice");
  await sheet(admin).locator(".option", { hasText: "Fuel prices explained" }).click();
  await look(admin, "20b-add-moment", "add a video of the moment sheet");
  await sheet(admin).getByRole("button", { name: "Add this video" }).click();
  await toast(admin, "Now showing on everyone's home screen");
  await closed(admin);
  ok((await admin.locator(".reel .shot-title").allInnerTexts()).join("|") === "Fuel prices explained|Night market short", "the newest pick comes first in the panel", (await admin.locator(".reel .shot-title").allInnerTexts()).join("|"));
  await look(admin, "20c-moment-two", "two videos of the moment");
  await sync(tunde);
  await tunde.locator(".reel .shot", { hasText: "Fuel prices explained" }).waitFor();
  ok(/Tunde Bello \(you\)/.test(await tunde.locator(".reel .shot", { hasText: "Fuel prices explained" }).innerText()), "the editor whose video was picked sees it marked as theirs");
  // other ways of writing a Drive link play too; a link that isn't a Drive file still opens where it lives
  const relink = async (link) => {
    await sql("update app.projects set link = $1 where name = 'Fuel prices explained' and status = 'submitted'", [link]);
    await tunde.reload();
    await tunde.locator(".reel .shot", { hasText: "Fuel prices explained" }).waitFor();
  };
  const playAt = async () => {
    await tunde.locator(".reel .shot", { hasText: "Fuel prices explained" }).click();
    await tunde.locator("#player .player-frame").waitFor();
    const s = await frameSrc(tunde);
    await tunde.keyboard.press("Escape");
    await tunde.waitForFunction(() => !document.getElementById("player").open && !document.querySelector("#player iframe"));
    return s;
  };
  await relink("https://drive.google.com/file/d/final999/view?usp=sharing&resourcekey=0-AbC_d-Ef");
  let at = await playAt();
  ok(at === "https://drive.google.com/file/d/final999/preview?resourcekey=0-AbC_d-Ef", "a shared link's key goes with it, which Drive needs for some shared files", at);
  await relink("https://drive.google.com/open?id=final999");
  at = await playAt();
  ok(at === "https://drive.google.com/file/d/final999/preview", "an older style of Drive link plays too", at);
  await relink("https://drive.google.com/drive/folders/folder777");
  const folder = tunde.locator(".reel .shot", { hasText: "Fuel prices explained" });
  ok((await folder.evaluate((el) => el.tagName)) === "A" && (await folder.getAttribute("href")) === "https://drive.google.com/drive/folders/folder777" && (await folder.getAttribute("target")) === "_blank", "a Drive folder, which can't be played, still opens in Drive");
  await relink("https://drive.google.com/file/d/final999/view");
  await admin.locator(".reel-item", { hasText: "Night market short" }).getByRole("button", { name: "Take down" }).click();
  await toast(admin, "Taken down from the home screen");
  await admin.locator(".reel .shot", { hasText: "Night market short" }).waitFor({ state: "hidden" });
  await sync(tunde);
  await tunde.locator(".reel .shot", { hasText: "Night market short" }).waitFor({ state: "hidden" });
  ok((await tunde.locator(".reel .shot").count()) === 1, "taking a video down removes it from everyone's home screen");

  /* ------------------------------------------------------------ projects: by category, filters, amounts, delete */
  await tab(admin, "projects");
  await see(admin, "Deadlines by category", "projects opens with the category summary");
  const sumRow = admin.locator("#view .rows > li", { hasText: "Long form" });
  const sumText = await sumRow.getByRole("button").getAttribute("aria-label");
  ok(/^Long form: 1 on time, 0 late, 0 past deadline\./.test(sumText) && (await sumRow.locator(".cat-n").allInnerTexts()).join("|") === "1|0|0" && (await admin.locator("#view .cat-head").innerText()).replace(/\s+/g, " ").trim() === "On time Late Past deadline", "each category shows what was on time, what was late and what is past its deadline", sumText);
  await pick(admin, "#f-status", "all");
  await admin.locator("#p-list .section-note", { hasText: /^3 projects/ }).waitFor();
  ok((await admin.locator("#p-list article.clip").count()) === 3, "all projects are listed: received, received, reassigned", String(await admin.locator("#p-list article.clip").count()));
  await look(admin, "21-projects-all", "admin projects, everything");
  await pick(admin, "#f-status", "ontime");
  await admin.locator("#p-list .section-note", { hasText: /^2 projects/ }).waitFor();
  ok((await admin.locator("#p-list article.clip").count()) === 2, "the admin can list what was submitted within the deadline");
  await pick(admin, "#f-status", "reassigned");
  await admin.locator("#p-list .section-note", { hasText: /^1 project/ }).waitFor();
  ok((await admin.locator("#p-list article.clip").count()) === 1 && /Now with Tunde Bello/.test(await admin.locator("#p-list").innerText()), "the admin can list what was reassigned and to whom");
  await pick(admin, "#f-status", "received");
  const paid = admin.locator("#p-list article.clip", { hasText: "Fuel prices explained" });
  await paid.getByRole("button", { name: "Manage" }).click();
  await paid.getByRole("button", { name: "Take down from home screen" }).waitFor();
  const other = admin.locator("#p-list article.clip", { hasText: "Night market short" });
  await other.getByRole("button", { name: "Manage" }).click();
  await other.getByRole("button", { name: "Make video of the moment" }).waitFor();
  ok(true, "a finished video can be featured or taken down from the Projects list too");
  await paid.getByRole("button", { name: "Manage" }).click();
  await paid.getByRole("button", { name: "Change amount" }).click();
  await admin.fill("#am-amt", "72.50");
  await sheet(admin).getByRole("button", { name: "Save amount" }).click();
  await closed(admin);
  await see(admin, "Paid into earnings: $72.50", "the admin can change what one video paid");
  await pick(admin, "#f-status", "reassigned");
  const old = admin.locator("#p-list article.clip", { hasText: "Fuel prices explained" });
  await old.getByRole("button", { name: "Manage" }).click();
  await old.getByRole("button", { name: "Delete" }).click();
  await look(admin, "22-delete", "delete confirmation");
  await sheet(admin).getByRole("button", { name: "Delete project" }).click();
  await toast(admin, "Project deleted");
  await see(admin, "No projects match these filters.", "a deleted project is gone");
  await pick(admin, "#f-status", "active");

  /* ------------------------------------------------------------ editors, bonus, leaderboard */
  await tab(admin, "editors");
  const adaCard = admin.locator("article.clip", { hasText: "Ada Obi" });
  await adaCard.waitFor();
  ok((await admin.locator("#view article.clip").count()) === 3 && /Earned in total/.test(await adaCard.innerText()), "every editor has a card with their numbers");
  await look(admin, "23-editors", "admin editors");
  // each editor's submitted videos, on a page of their own
  await adaCard.getByRole("button", { name: "Videos", exact: true }).click();
  await sheet(admin).getByText("Ada Obi's videos").waitFor();
  const vrow = sheet(admin).locator(".vid-list > li", { hasText: "Night market short" });
  await vrow.waitFor();
  await sheet(admin).getByText("1 video, newest first.").waitFor();
  ok(/On time/.test(await vrow.innerText()) && /Received/.test(await vrow.innerText()) && /Shorts, submitted /.test(await vrow.innerText()), "an editor's videos page lists what they submitted: when, on time or late, received or not", (await vrow.innerText()).replace(/\n/g, " | "));
  await look(admin, "23b-editor-videos", "one editor's videos");
  await vrow.getByRole("button", { name: "Play" }).click();
  await admin.locator("#player .player-frame").waitFor();
  ok((await frameSrc(admin)) === "https://drive.google.com/file/d/abc123/preview", "each video plays straight from the list");
  await admin.keyboard.press("Escape");
  await admin.waitForFunction(() => !document.getElementById("player").open);
  ok(await admin.evaluate(() => document.getElementById("sheet").open), "closing the video goes back to the list");
  await sheet(admin).getByRole("button", { name: "Close" }).click();
  await closed(admin);
  await adaCard.getByRole("button", { name: "Bonuses" }).click();
  ok((await admin.inputValue("#bn-amt")) === "25" && /^Top performer, week of /.test(await admin.inputValue("#bn-label")), "the bonus sheet starts with the admin's usual amount", await admin.inputValue("#bn-label"));
  await look(admin, "24-bonus", "bonus sheet");
  await sheet(admin).getByRole("button", { name: "Award bonus" }).click();
  await toast(admin, "Bonus of $25 awarded to Ada Obi");
  await closed(admin);
  await adaCard.getByText("Bonus this week").waitFor();
  await sync(ada);
  await tab(ada, "board");
  await see(ada, "Bonuses awarded", "the leaderboard shows who was awarded a bonus");
  const podium = (await ada.locator(".podium").innerText()).replace(/\n+/g, " ");
  ok(/Ada Obi \(you\)/.test(podium) && /Tunde Bello/.test(podium) && /1 on time/.test(podium) && !/\$/.test(await ada.locator("#view").innerText()), "the leaderboard names the top performers and shows no amounts", podium);
  await look(ada, "25-leaderboard", "leaderboard");
  await tab(ada, "earn");
  await ada.locator(".week-num", { hasText: "$40" }).waitFor();
  ok(/From bonuses/.test(await ada.locator("#view").innerText()) && /Top performer, week of/.test(await ada.locator("#view").innerText()), "the bonus is added to the editor's earnings");
  await look(ada, "26-earnings-bonus", "earnings with a bonus");

  /* ------------------------------------------------------------ reminders, starting with a new picture */
  await tab(admin, "settings");
  ok(/^0 of 3 editors have a picture\.$/.test(await admin.locator("#pic-status").innerText()), "settings say how many editors have a picture", await admin.locator("#pic-status").innerText());
  ok(/^0 of 3 editors have added theirs\.$/.test(await admin.locator("#pay-status").innerText()), "and how many have added payment details", await admin.locator("#pay-status").innerText());
  await admin.locator("#send-reminder").click();
  await sheet(admin).getByRole("button", { name: "Send reminder" }).waitFor();
  ok((await sheet(admin).locator('input[name="rem-kind"]').count()) === 3 && /The 3 editors who don't have a picture yet\./.test(await sheet(admin).innerText()) && /The 3 editors who haven't added theirs\./.test(await sheet(admin).innerText()), "the admin picks from three reminders, each saying who it's for", (await sheet(admin).innerText()).replace(/\n/g, " | "));
  await look(admin, "26b-reminders", "send a reminder");
  await sheet(admin).getByRole("button", { name: "Send reminder" }).click();
  await sheet(admin).getByText("Pick the reminder to send.").waitFor();
  ok((await sql("select count(*)::int as n from app.reminders")).rows[0].n === 0 && (await sql("select pic_ask_at from app.meta")).rows[0].pic_ask_at === null, "nothing is sent until one is picked");
  await sheet(admin).locator("label.option", { hasText: "Profile picture" }).click();
  await sheet(admin).getByRole("button", { name: "Send reminder" }).click();
  await toast(admin, "Sent to 3 editors. None of them has notifications on yet.");
  await closed(admin);
  ok(/^0 of 3 editors have a picture\. Last reminded .+\.$/.test(await admin.locator("#pic-status").innerText()), "the admin sees when they asked and how many have a picture", await admin.locator("#pic-status").innerText());
  await tab(ada, "work");
  await sync(ada);
  await see(ada, "Add a profile picture", "an editor without a picture is asked on their home screen");
  await look(ada, "26c-picture-asked", "editor asked for a new picture");
  // an editor's own list of everything they've submitted
  await ada.getByRole("button", { name: "All my videos" }).click();
  await sheet(ada).getByText("Your videos").waitFor();
  const myRow = sheet(ada).locator(".vid-list > li", { hasText: "Night market short" });
  await myRow.waitFor();
  ok(/Received/.test(await myRow.innerText()) && (await myRow.getByRole("button", { name: "Play" }).count()) === 1, "editors have a page of every video they've submitted, each one playable", (await myRow.innerText()).replace(/\n/g, " | "));
  await look(ada, "26d-my-videos", "an editor's own videos");
  await sheet(ada).getByRole("button", { name: "Close" }).click();
  await closed(ada);

  /* ------------------------------------------------------------ account: picture, name, password, sign out */
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAEAAAAAoCAIAAADBrGu+AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAPUlEQVRYw+3PQQkAAAgEsItjRMMaxgw+hcEKLNP1WgQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQELhYkk9jT5G7+yQAAAABJRU5ErkJggg==", "base64");      // a small orange picture
  await ada.getByRole("button", { name: "Add my picture" }).click();
  await sheet(ada).getByText("Your account").waitFor();
  ok((await ada.evaluate(() => document.activeElement && document.activeElement.id)) === "ac-choose", "the reminder's button goes straight to choosing a picture");
  ok((await ada.locator("#ac-name").count()) === 0 && /Your name is set by your admin/.test(await sheet(ada).innerText()) && !(await sheet(ada).getByRole("button", { name: "Remove" }).isVisible()), "an editor can set a picture but not change their own name");
  await ada.setInputFiles("#ac-file", { name: "me.png", mimeType: "image/png", buffer: png });
  await ada.locator("#ac-pic img").waitFor();
  ok(await sheet(ada).getByRole("button", { name: "Remove" }).isVisible(), "a chosen picture can be removed again");
  await look(ada, "27-account", "account sheet");
  await sheet(ada).getByRole("button", { name: "Save picture" }).click();
  await closed(ada);
  await ada.locator("#who img.avatar").waitFor();
  ok(true, "the picture is saved and shows in the header");
  await gone(ada, "Add a profile picture", "adding a picture clears the reminder");
  const stored = (await sql("select avatar_full, avatar_full_ver = avatar_ver as current from app.users where username = 'ada.obi'")).rows[0];
  ok(/^data:image\/jpeg;base64,/.test(stored.avatar_full || "") && stored.current, "a larger copy of the whole picture is kept for tapping on", (stored.avatar_full || "").length + " characters");
  await sync(admin);
  await admin.locator("#pic-status", { hasText: "1 of 3 editors have a picture." }).waitFor();
  ok(/^1 of 3 editors have a picture\. Last reminded .+\.$/.test(await admin.locator("#pic-status").innerText()), "the admin sees the editor has added one", await admin.locator("#pic-status").innerText());
  await tab(admin, "editors");
  await admin.locator("article.clip", { hasText: "Ada Obi" }).locator("img.avatar").waitFor();
  ok(true, "the admin sees the editor's picture");
  // the admin taps it: the whole picture, full size
  await admin.locator("article.clip", { hasText: "Ada Obi" }).locator(".pic-btn").click();
  await admin.locator("#player .pic-full").waitFor();
  await admin.waitForFunction((src) => document.querySelector("#player .pic-full").getAttribute("src") === src, stored.avatar_full);
  ok((await admin.locator("#player .player-title").innerText()) === "Ada Obi", "tapping an editor's picture opens the whole picture, large");
  await look(admin, "27a-picture-full", "an editor's picture, full size");
  await admin.keyboard.press("Escape");
  await admin.waitForFunction(() => !document.getElementById("player").open);
  ok(await admin.evaluate(() => document.activeElement && document.activeElement.classList.contains("pic-btn")), "closing it goes back to the picture");
  // the admin fixes the editor's name
  await tab(admin, "settings");
  await admin.locator("#view .rows").first().locator("> li", { hasText: "Ada Obi" }).getByRole("button", { name: "Manage" }).click();
  await sheet(admin).getByText("Manage login").waitFor();
  await look(admin, "27b-manage-login", "manage login sheet");
  await admin.fill("#mu-name", "Ada O.");
  await sheet(admin).getByRole("button", { name: "Save", exact: true }).click();
  await closed(admin);
  await sync(ada);
  await ada.locator("#who", { hasText: "Ada O." }).waitFor();
  ok(true, "the admin can correct an editor's name");
  await sync(tunde);
  await tab(tunde, "board");
  await tunde.locator(".podium img.avatar").first().waitFor();
  ok(/Ada O\./.test(await tunde.locator(".podium").innerText()), "other editors see the top performer's picture and name on the leaderboard");
  await look(tunde, "28-leaderboard-pictures", "leaderboard with pictures");
  await tunde.locator(".podium .pic-btn").first().click();
  await tunde.locator("#player .pic-full").waitFor();
  await tunde.waitForFunction((src) => document.querySelector("#player .pic-full").getAttribute("src") === src, stored.avatar_full);
  ok((await tunde.locator("#player .player-title").innerText()) === "Ada O.", "an editor can tap a picture on the leaderboard to see it full size");
  await tunde.locator("#player").getByRole("button", { name: "Close" }).click();
  ok((await tunde.locator(".podium .pic-btn").count()) === 1 && (await tunde.locator("#view .reel .pic-btn, #view article.clip .pic-btn").count()) === 0, "elsewhere, an editor's screen keeps pictures as they were");
  // pictures are kept on the phone: opening the app again shows them without downloading them again
  const picAsks = [], onPicAsk = (r) => { if (r.url().endsWith("/rpc/er_avatars")) picAsks.push(r.postData() || ""); };
  tunde.on("request", onPicAsk);
  await tunde.reload();
  await tunde.locator(".podium img.avatar").first().waitFor();
  tunde.off("request", onPicAsk);
  ok(picAsks.length === 0, "opening the app again shows the pictures kept on the phone, without downloading them", picAsks.length + " downloads");

  await ada.locator("#who").click();
  await sheet(ada).getByRole("button", { name: "Change password" }).click();
  await ada.fill("#cp-old", "wrong-old-pass");
  await ada.fill("#cp-new", "my-own-pass-9");
  await sheet(ada).getByRole("button", { name: "Change password" }).click();
  await see(ada, "Your current password isn't right.", "changing a password needs the current one");
  await ada.fill("#cp-old", logins["Ada Obi"].password);
  await sheet(ada).getByRole("button", { name: "Change password" }).click();
  await toast(ada, "Password changed");
  await closed(ada);
  const keptBefore = await ada.evaluate(() => localStorage.getItem("editroom.pics"));
  await ada.locator("#who").click();
  await sheet(ada).getByRole("button", { name: "Sign out" }).click();
  await see(ada, "Use the username and password your admin gave you.", "signing out returns to the sign-in screen");
  ok((await ada.evaluate(() => localStorage.getItem("editroom.token"))) === null, "signing out forgets the session on this phone");
  ok(/^\{"v":1,"p":\{"[0-9a-f-]{36}":\[\d+,"data:image\//.test(keptBefore || "") && (await ada.evaluate(() => localStorage.getItem("editroom.pics"))) === null, "and the pictures kept on it", (keptBefore || "").slice(0, 60));
  await ada.fill("#li-user", "ada.obi");
  await ada.fill("#li-pass", logins["Ada Obi"].password);
  await ada.getByRole("button", { name: "Sign in" }).click();
  await see(ada, "Wrong username or password.", "the old password no longer works");
  await ada.fill("#li-pass", "my-own-pass-9");
  await ada.getByRole("button", { name: "Sign in" }).click();
  await ada.locator("#who img.avatar").waitFor();
  ok(true, "the new password signs in");

  /* ------------------------------------------------------------ managing logins */
  await tab(admin, "settings");
  const team = admin.locator("#view .rows").first();
  const manage = async (name) => { await team.locator("> li", { hasText: name }).getByRole("button", { name: "Manage" }).click(); await sheet(admin).getByText("Manage login").waitFor(); };
  ok((await team.locator("> li", { hasText: "Sam Okafor" }).getByRole("button").count()) === 0, "the owner's own row has nothing to switch off by mistake");
  await manage("Tunde Bello");
  await sheet(admin).getByRole("button", { name: "New password" }).click();
  const newPw = await admin.inputValue("#pw-new");
  await sheet(admin).getByRole("button", { name: "Set password" }).click();
  await sheet(admin).getByText("Password changed").waitFor();
  ok((await admin.locator("#cred-text").innerText()).includes("Password: " + newPw), "a new password is shown once for the admin to pass on");
  await sheet(admin).getByRole("button", { name: "Done" }).click();
  await closed(admin);
  await sync(tunde);
  await see(tunde, "Use the username and password your admin gave you.", "a password reset signs that editor out");
  await tunde.fill("#li-user", "tunde.bello");
  await tunde.fill("#li-pass", newPw);
  await tunde.getByRole("button", { name: "Sign in" }).click();
  await tunde.locator("#tabs button").first().waitFor();
  ok(true, "the editor signs in with the new password");

  const cRow = team.locator("> li", { hasText: "Chidi Nwosu" });
  await manage("Chidi Nwosu");
  await sheet(admin).getByRole("button", { name: "Switch off" }).click();
  await sheet(admin).getByText("They are signed out at once").waitFor();
  await look(admin, "29-switch-off", "switch-off confirmation");
  await sheet(admin).getByRole("button", { name: "Switch off" }).click();
  await closed(admin);
  await cRow.getByText("Switched off").waitFor();
  const chidi = await open("chidi");
  await chidi.fill("#li-user", logins["Chidi Nwosu"].username);
  await chidi.fill("#li-pass", logins["Chidi Nwosu"].password);
  await chidi.getByRole("button", { name: "Sign in" }).click();
  await see(chidi, "This login has been switched off. Ask your admin.", "a switched-off login cannot sign in");
  await manage("Chidi Nwosu");
  await sheet(admin).getByRole("button", { name: "Switch on" }).click();
  await closed(admin);
  await cRow.getByText("Switched off").waitFor({ state: "hidden" });
  await chidi.getByRole("button", { name: "Sign in" }).click();
  await see(chidi, "Nothing in progress.", "switched back on, it works again");
  await manage("Chidi Nwosu");
  await admin.selectOption("#mu-role", "admin");
  await sheet(admin).getByRole("button", { name: "Save", exact: true }).click();
  await toast(admin, "Chidi Nwosu is now an admin");
  await cRow.getByText("Admin", { exact: true }).waitFor();
  await sync(chidi);
  await chidi.locator('#tabs button[data-tab="inbox"]').waitFor();
  ok(true, "someone made an admin gets the admin screens");
  await tab(chidi, "settings");
  await chidi.getByText("Team logins").waitFor();
  ok((await chidi.locator("#view .rows").first().locator("> li", { hasText: "Sam Okafor" }).getByRole("button").count()) === 0 && (await chidi.locator("#view .rows").first().locator("> li", { hasText: "Tunde Bello" }).getByRole("button", { name: "Manage" }).count()) === 1, "a second admin can manage editors but not the owner");
  await manage("Chidi Nwosu");
  await admin.selectOption("#mu-role", "editor");
  await sheet(admin).getByRole("button", { name: "Save", exact: true }).click();
  await closed(admin);
  await sync(chidi);
  await chidi.locator('#tabs button[data-tab="work"]').waitFor();
  ok((await chidi.locator('#tabs button[data-tab="inbox"]').count()) === 0, "made an editor again, the admin screens go away");
  await chidi.close();

  // a login made by mistake can be deleted; one with work on record cannot
  await admin.locator("#add-user").click();
  await admin.fill("#nu-name", "Tpyo Login");
  await sheet(admin).getByRole("button", { name: "Create login" }).click();
  await sheet(admin).getByText("Login created").waitFor();
  await sheet(admin).getByRole("button", { name: "Done" }).click();
  await closed(admin);
  await manage("Tpyo Login");
  await sheet(admin).getByRole("button", { name: "Delete login" }).click();
  await sheet(admin).getByText("This is for a login made by mistake").waitFor();
  await sheet(admin).getByRole("button", { name: "Delete login" }).click();
  await toast(admin, "Login deleted");
  await team.locator("> li", { hasText: "Tpyo Login" }).waitFor({ state: "hidden" });
  ok((await team.locator("> li").count()) === 4, "a login made by mistake can be deleted");
  await manage("Ada O.");
  await sheet(admin).getByRole("button", { name: "Delete login" }).click();
  await sheet(admin).getByRole("button", { name: "Delete login" }).click();
  await see(admin, "This login has work or bonuses on record, so it can't be deleted.", "a login with work on record cannot be deleted");
  await sheet(admin).getByRole("button", { name: "Cancel" }).click();
  await closed(admin);

  // messages show above an open sheet
  await manage("Ada O.");
  srv.flags.down = true;
  await sheet(admin).getByRole("button", { name: "Remove picture" }).click();
  await toast(admin, "Can't reach the server");
  const onTop = await admin.evaluate(() => { const t = document.getElementById("toast"), r = t.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === t; });
  ok(onTop, "a message raised while a sheet is open shows above it");
  await look(admin, "29b-toast-over-sheet", "message above an open sheet");
  srv.flags.down = false;
  await sheet(admin).getByRole("button", { name: "Remove picture" }).click();
  await toast(admin, "Picture removed");
  await closed(admin);
  await sync(ada);
  await ada.locator("#who img.avatar").waitFor({ state: "hidden" });
  ok(true, "the admin can take an editor's picture down");
  await sync(tunde);
  await tunde.waitForFunction(() => { try { return Object.keys(JSON.parse(localStorage.getItem("editroom.pics")).p).length === 0; } catch (e) { return false; } });
  ok(true, "and other phones drop the copy of it they kept");

  /* ------------------------------------------------------------ the admin tries the editor screen */
  await admin.locator("#try-editor").click();
  await see(admin, "This is the editor screen, as your editors see it.", "the admin can preview the editor screen");
  await tab(admin, "board");
  await see(admin, "Leaderboard", "including the leaderboard");
  await look(admin, "30-admin-as-editor", "admin previewing the editor screen");
  await admin.locator("#back-admin").click();
  await admin.locator('#tabs button[data-tab="inbox"]').waitFor();

  /* ------------------------------------------------------------ a dropped connection, a reload, a timed-out session */
  srv.flags.down = true;
  await sync(admin);
  await see(admin, "Can't reach the server.", "a dropped connection is said plainly");
  await tab(admin, "settings");
  await admin.fill("#cat-new", "Offline try");
  await admin.locator(".inline-form button[type=submit]").click();
  await toast(admin, "Can't reach the server");
  ok(true, "saving while offline fails with a clear message");
  await admin.fill("#cat-new", "");
  srv.flags.down = false;
  await sync(admin);
  await gone(admin, "Can't reach the server.", "it recovers by itself when the connection is back");
  await admin.reload();
  await see(admin, "Team logins", "a reload keeps the admin signed in, on the same tab");
  const sw = await admin.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return !!(r && (r.active || r.installing || r.waiting)); });
  ok(sw, "the offline helper is installed");
  await sql("delete from app.sessions where user_id = (select id from app.users where username = 'tunde.bello')");
  await sync(tunde);
  await toast(tunde, "You've been signed out");
  ok(true, "an ended session returns to sign-in with an explanation");

  /* ------------------------------------------------------------ months of history: figures, and older projects a page at a time */
  const adaId = (await sql("select id from app.users where username = 'ada.obi'")).rows[0].id;
  const shortsId = (await sql("select id from app.categories where name = 'Shorts'")).rows[0].id;
  // 100 finished videos from 10 to 47 days ago; every fifth one took 30 hours (6 hours late)
  await sql(`insert into app.projects (editor_id, name, category_id, stage, status, started_at, updated_at, submitted_at, link, received_at, amount)
    select $1, 'Archive video ' || lpad(g::text, 3, '0'), $2, 3, 'submitted',
           now() - g * interval '9 hours' - interval '10 days',
           now() - g * interval '9 hours' - interval '10 days' + (case when g % 5 = 0 then 30 else 6 end) * interval '1 hour',
           now() - g * interval '9 hours' - interval '10 days' + (case when g % 5 = 0 then 30 else 6 end) * interval '1 hour',
           'https://drive.google.com/file/d/arch' || g || '/view', now() - g * interval '9 hours' - interval '8 days 12 hours', 15
      from generate_series(1, 100) g`, [adaId, shortsId]);
  await admin.waitForTimeout(5600);        // real projects arrive one at a time; let this batch age so it counts as history
  await admin.reload();
  await see(admin, "Team logins", "the admin's app reloads");
  await tab(admin, "projects");
  const shortsRow = admin.locator("#view .rows > li", { hasText: "Shorts" });
  await shortsRow.getByText("81", { exact: true }).waitFor();
  const shortsText = await shortsRow.getByRole("button").getAttribute("aria-label");
  ok(/^Shorts: 81 on time, 20 late by 6h on average, 0 past deadline\./.test(shortsText) && /Late by 6h on average\./.test(await shortsRow.innerText()), "category figures count the whole 10 weeks, worked out by the server", shortsText);
  const headline = (await admin.locator("#view .slate").first().innerText()).replace(/\s+/g, " ");
  ok(/8\d of 10\d videos submitted on time/.test(headline) && /Late 2\d/.test(headline), "the headline adds the categories up", headline);
  await shortsRow.getByRole("button").click();
  await settle(admin);
  ok((await admin.inputValue("#f-cat")) !== "all" && (await admin.inputValue("#f-status")) === "all", "tapping a category lists its projects");
  await pick(admin, "#f-cat", "all");
  await pick(admin, "#f-status", "received");
  const note = admin.locator("#p-list .section-note");
  await note.getByText(/^42\+ projects/).waitFor();
  ok((await admin.locator("#p-list article.clip").count()) === 40, "the list starts with the recent projects and the first page of older ones", await note.innerText());
  await look(admin, "30b-history", "projects with older history");
  await admin.locator("#p-list").getByRole("button", { name: "Show more" }).click();
  await note.getByText(/^82\+ projects/).waitFor();
  ok((await admin.locator("#p-list article.clip").count()) === 80, "Show more brings the next page");
  await admin.locator("#p-list").getByRole("button", { name: "Show more" }).click();
  await note.getByText(/^102 projects/).waitFor();
  const names = await admin.locator("#p-list article.clip .clip-title").allInnerTexts();
  ok(names.length === 102 && names[2] === "Archive video 001" && names[101] === "Archive video 100" && (await admin.locator("#p-list").getByRole("button", { name: "Show more" }).count()) === 0, "every older project can be reached, newest first, and the list says when it is complete", names.length + " shown, third is " + names[2]);
  await pick(admin, "#f-status", "sublate");
  await pick(admin, "#f-editor", adaId);
  await note.getByText(/^20 projects/).waitFor();
  ok(/Late by 6h/.test(await admin.locator("#p-list article.clip").first().innerText()), "older late submissions can be listed for one editor, each with how late it was");
  await pick(admin, "#f-editor", "all");
  await pick(admin, "#f-status", "active");
  await tab(admin, "editors");
  const adaHist = admin.locator("article.clip", { hasText: "Ada O." });
  await adaHist.locator(".spark").waitFor();
  const bars = await adaHist.locator(".spark .bar").evaluateAll((els) => els.filter((b) => b.children.length > 0).length);
  // the rate the server should give, worked out here the same way (which videos fall in the last four weeks moves with the clock)
  const four = (await sql("select count(*) filter (where p.submitted_at <= p.due_at)::int as on_n, count(*)::int as n from app.projects p, app.meta m where p.editor_id = $1 and p.status = 'submitted' and not p.deleted and p.submitted_at >= (date_trunc('week', now() at time zone m.tz) - interval '21 days') at time zone m.tz", [adaId])).rows[0];
  const rate4 = Math.round((four.on_n / four.n) * 100) + "%", facts = (await adaHist.locator(".facts").innerText()).replace(/\s+/g, " ");
  ok(bars >= 5 && four.n > 20 && four.on_n < four.n && facts.includes("On time, last 4 weeks " + rate4), "each editor's six weeks and on-time rate cover work older than what is loaded", bars + " weeks with bars; expected " + rate4 + " of " + four.n + "; " + facts);
  await adaHist.locator(".spark .bar").nth(3).click();
  await adaHist.locator(".readout b").waitFor();
  ok(/videos? in the week of .*: \d+ on time, \d+ late\./.test(await adaHist.locator(".readout").innerText()), "tapping a week's bar gives that week's numbers", await adaHist.locator(".readout").innerText());
  await look(admin, "30c-editors-history", "editors with weeks of history");
  // the videos page reaches back through all of them, a page at a time
  const adaTotal = (await sql("select count(*)::int as n from app.projects where editor_id = $1 and status = 'submitted' and not deleted and link is not null", [adaId])).rows[0].n;
  await adaHist.getByRole("button", { name: "Videos", exact: true }).click();
  await sheet(admin).getByText(/videos so far, newest first\./).waitFor();
  for (let i = 0; i < 6 && (await sheet(admin).getByRole("button", { name: "Show older videos" }).count()); i++) {
    await sheet(admin).getByRole("button", { name: "Show older videos" }).click();
    await admin.waitForTimeout(250);
  }
  await sheet(admin).getByText(adaTotal + " videos, newest first.").waitFor();
  const vnames = await sheet(admin).locator(".vid-list .row-title").allInnerTexts();
  ok(vnames.length === adaTotal && vnames.includes("Archive video 100") && vnames.includes("Night market short"), "every video an editor ever submitted can be reached from their page", vnames.length + " of " + adaTotal);
  await sheet(admin).getByRole("button", { name: "Close" }).click();
  await closed(admin);

  // a changed delivery time applies to new briefs
  await tab(admin, "settings");
  await admin.fill("#set-delivery", "12");
  await admin.locator("#save-deadlines").click();
  await toast(admin, "Changes saved");
  ok((await admin.locator("#toast").innerText()) === "Changes saved", "saving a new delivery time doesn't claim anything about the grace period", await admin.locator("#toast").innerText());
  await sync(ada);
  await tab(ada, "work");
  await ada.getByRole("button", { name: "Log a new brief" }).click();
  await sheet(ada).getByText("Your 12-hour deadline starts as soon as you log it.").waitFor();
  await ada.fill("#b-name", "Quick turnaround");
  await ada.selectOption("#b-cat", { label: "Ads" });
  await sheet(ada).getByRole("button", { name: "Log brief" }).click();
  await closed(ada);
  ok(/Due in (11h 5\dm|12h)/.test(await ada.locator("article.clip", { hasText: "Quick turnaround" }).innerText()), "a brief logged after the admin changes the delivery time gets the new deadline");
  await admin.locator("#toast").waitFor({ state: "hidden" });
  await admin.fill("#set-delivery", "24");
  await admin.locator("#set-delivery").press("Enter");
  await toast(admin, "Changes saved");
  ok((await sql("select delivery_hours from app.meta")).rows[0].delivery_hours === 24, "pressing Enter in a box saves too");
  await sync(ada);
  await ada.waitForTimeout(300);
  ok(/Due in (11h 5\dm|12h)/.test(await ada.locator("article.clip", { hasText: "Quick turnaround" }).innerText()), "and keeps it when the setting changes again");

  /* ------------------------------------------------------------ dark theme and a wide screen */
  await admin.emulateMedia({ colorScheme: "dark" });
  await tab(admin, "editors");
  await look(admin, "31-dark-editors", "dark editors");
  await tab(admin, "inbox");
  await look(admin, "32-dark-inbox", "dark inbox");
  await ada.emulateMedia({ colorScheme: "dark" });
  await tab(ada, "work");
  await look(ada, "33-dark-editor", "dark editor work");
  await tab(ada, "board");
  await look(ada, "34-dark-leaderboard", "dark leaderboard");
  await admin.emulateMedia({ colorScheme: "light" });
  await admin.setViewportSize({ width: 1280, height: 800 });
  await tab(admin, "editors");
  const wideNav = await admin.evaluate(() => { const t = document.getElementById("tabs"), top = document.querySelector("header.top").getBoundingClientRect(), r = t.getBoundingClientRect(); return getComputedStyle(t).position !== "fixed" && r.top >= top.top && r.bottom <= top.bottom; });
  ok(wideNav, "on a wide screen the sections sit in the top bar");
  await look(admin, "35-wide-editors", "wide editors");
  await tab(admin, "settings");
  await look(admin, "36-wide-settings", "wide settings");
  await admin.setViewportSize({ width: 320, height: 640 });
  await tab(admin, "editors");
  await look(admin, "37-narrow-editors", "narrowest phone, editors");
  await tab(admin, "projects");
  await pick(admin, "#f-status", "all");
  await look(admin, "38-narrow-projects", "narrowest phone, projects");

  /* ------------------------------------------------------------ day or night */
  const looks = (page) => page.evaluate(() => ({
    attr: document.documentElement.getAttribute("data-theme"),
    bg: getComputedStyle(document.body).backgroundColor,
    scheme: getComputedStyle(document.documentElement).colorScheme,
    bars: Array.from(document.querySelectorAll('meta[name="theme-color"]')).map((m) => m.content).join(","),
    kept: (() => { try { return localStorage.getItem("editroom.theme"); } catch (e) { return "blocked"; } })(),
  }));
  const DAY = "rgb(233, 233, 233)", NIGHT = "rgb(28, 28, 28)";
  const site = (f) => fs.readFileSync(new URL("../" + f, import.meta.url), "utf8");
  const css = site("styles.css"), head = site("index.html").split("</head>")[0];
  const auto = /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{([^}]*)\}\s*\}/.exec(css), chosen = /:root\[data-theme="dark"\] \{([^}]*)\}/.exec(css);
  const flat = (s) => s.replace(/\s+/g, " ").trim();
  ok(auto && chosen && flat(auto[1]) === flat(chosen[1]), "the dark colours for a phone set to dark and for Night picked in the app are the same");
  ok(head.includes('src="theme.js') && head.indexOf('src="theme.js') < head.indexOf('rel="stylesheet"'), "the day or night choice is applied in the page's head, before the styles");
  const versions = Array.from(site("index.html").matchAll(/\?v=(\d+)"/g), (m) => m[1]);
  ok(versions.length === 5 && new Set(versions).size === 1 && /"theme\.js"/.test(site("sw.js")), "every file the page loads carries the same version, and the offline helper keeps theme.js", versions.join(","));
  const others = ["drive-folders.html", "privacy.html"].flatMap((f) => Array.from(site(f).matchAll(/\?v=(\d+)"/g), (m) => m[1]));
  ok(others.length === 8 && others.every((v) => v === versions[0]), "the folder picker and privacy pages load the same version as the app", others.join(","));
  // Ada's phone is set to dark (from the checks above)
  await ada.emulateMedia({ colorScheme: "dark" });
  let th = await looks(ada);
  ok(th.attr === null && th.bg === NIGHT && th.kept === null, "with no choice made, the app follows a phone set to dark", JSON.stringify(th));
  await ada.locator("#who").click();
  const dn = sheet(ada).locator("#ac-theme");
  await dn.waitFor();
  ok((await dn.getByRole("button", { name: "Same as phone" }).getAttribute("aria-pressed")) === "true" && (await dn.getByRole("button").count()) === 3, "the account sheet offers Day, Night and Same as phone, starting on Same as phone");
  ok((await sheet(ada).getByRole("link", { name: "Privacy policy" }).getAttribute("href")) === "privacy.html", "the account sheet links to the privacy page");
  await see(ada, "The app follows your phone, which is in dark mode right now.", "and says what the phone is set to");
  await dn.getByRole("button", { name: "Day" }).click();
  th = await looks(ada);
  ok(th.attr === "light" && th.bg === DAY && th.scheme === "light" && th.bars === "#E9E9E9,#E9E9E9" && th.kept === "light", "picking Day turns the app light at once on a phone set to dark, status bar too", JSON.stringify(th));
  ok((await dn.getByRole("button", { name: "Day" }).getAttribute("aria-pressed")) === "true" && (await dn.getByRole("button", { name: "Same as phone" }).getAttribute("aria-pressed")) === "false", "and the choice shows as picked");
  await look(ada, "41-day-on-dark-phone", "Day picked on a dark phone");
  await sheet(ada).getByRole("button", { name: "Cancel" }).click();
  await closed(ada);
  ok((await looks(ada)).attr === "light", "closing the sheet keeps the choice (it doesn't wait for Save)");
  // the choice is in place before anything is drawn, so the wrong one never flashes
  const early = await ada.context().newPage();
  await early.addInitScript(() => {
    new MutationObserver((list, obs) => { if (document.body) { window.__atBody = document.documentElement.getAttribute("data-theme"); obs.disconnect(); } }).observe(document, { childList: true, subtree: true });
  });
  await early.emulateMedia({ colorScheme: "dark" });
  await early.goto(srv.url + "/");
  await early.locator("#tabs").waitFor();
  ok((await early.evaluate(() => window.__atBody)) === "light" && (await looks(early)).bg === DAY, "opened again, the app is light from the first moment", String(await early.evaluate(() => window.__atBody)));
  // another open copy of the app follows along
  await ada.locator("#who").click();
  await dn.getByRole("button", { name: "Night" }).click();
  await early.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "dark");
  ok((await looks(early)).bg === NIGHT, "a second copy of the app open on the same phone changes too");
  await early.close();
  // Night on a phone set to light
  await ada.emulateMedia({ colorScheme: "light" });
  th = await looks(ada);
  ok(th.attr === "dark" && th.bg === NIGHT && th.scheme === "dark" && th.bars === "#1C1C1C,#1C1C1C" && th.kept === "dark", "Night keeps the app dark on a phone set to light, status bar too", JSON.stringify(th));
  await see(ada, "The app stays in night mode on this phone, even when the phone is in light mode.", "and says it will stay that way");
  await look(ada, "42-night-on-light-phone", "Night picked on a light phone");
  // and back to the phone's own setting
  await dn.getByRole("button", { name: "Same as phone" }).click();
  th = await looks(ada);
  ok(th.attr === null && th.bg === DAY && th.bars === "#E9E9E9,#1C1C1C" && th.kept === null, "Same as phone hands it back to the phone", JSON.stringify(th));
  await ada.emulateMedia({ colorScheme: "dark" });
  ok((await looks(ada)).bg === NIGHT, "and the app changes when the phone does");
  await see(ada, "The app follows your phone, which is in dark mode right now.", "and the sheet keeps up with the phone");
  await sheet(ada).getByRole("button", { name: "Cancel" }).click();
  await closed(ada);

  /* ------------------------------------------------------------ payment details */
  await ada.emulateMedia({ colorScheme: "light" });
  await tab(ada, "work");
  await see(ada, "Add your payment details", "an editor without payment details is reminded on their home screen");
  await ada.getByRole("button", { name: "Add my details" }).click();
  await sheet(ada).locator("#pd-name").waitFor();
  ok((await ada.locator("#pd-phone").getAttribute("type")) === "tel" && (await ada.locator("#pd-account").getAttribute("inputmode")) === "numeric", "the phone and account number fields bring up the number keys");
  await ada.fill("#pd-name", "Adaeze  Obi");
  await ada.fill("#pd-phone", "0803 123 4567");
  await ada.fill("#pd-bank", "GTBank");
  await ada.fill("#pd-account", "012345678");
  await sheet(ada).getByRole("button", { name: "Save details" }).click();
  await sheet(ada).getByText("Enter your 10-digit account number.").waitFor();
  ok((await sql("select count(*)::int as n from app.details")).rows[0].n === 0, "a 9-digit account number is caught before anything is saved");
  await look(ada, "43-pay-form", "the payment details form");
  await ada.fill("#pd-account", "0123 456 789");
  await sheet(ada).getByRole("button", { name: "Save details" }).click();
  await toast(ada, "Payment details saved");
  await gone(ada, "Add your payment details", "once they're saved, the reminder goes");
  const kept = (await sql("select d.full_name, d.phone, d.bank_name, d.bank_account from app.details d join app.users x on x.id = d.user_id where x.username = 'ada.obi'")).rows;
  ok(kept.length === 1 && kept[0].full_name === "Adaeze Obi" && kept[0].bank_account === "0123456789" && kept[0].phone === "0803 123 4567", "the details are saved tidied up", JSON.stringify(kept));
  await ada.locator("#who").click();
  const myPay = sheet(ada).locator("#ac-pay");
  await myPay.getByText("0123456789").waitFor();
  ok(/Adaeze Obi/.test(await myPay.innerText()) && /GTBank/.test(await myPay.innerText()) && (await myPay.getByRole("button", { name: "Copy" }).count()) === 0, "the editor sees their payment details in their account");
  await look(ada, "44-pay-account", "payment details in the editor's account");
  await sheet(ada).getByRole("button", { name: "Cancel" }).click();
  await closed(ada);
  // the admin's side
  await admin.setViewportSize({ width: 390, height: 844 });
  await sync(admin);
  await tab(admin, "editors");
  const roster = admin.locator("article.clip", { hasText: "Earned in total" }), payAda = roster.filter({ hasText: "Ada O." }), payTunde = roster.filter({ hasText: "Tunde" });
  await payAda.waitFor();
  ok((await payAda.getByText("No payment details").count()) === 0 && (await payTunde.getByText("No payment details").count()) === 1, "on the Editors screen the admin can see who hasn't added payment details");
  await payAda.getByRole("button", { name: "Profile" }).click();
  const prof = sheet(admin).locator("#pf-pay");
  await prof.getByText("0123456789").waitFor();
  ok(/Adaeze Obi/.test(await prof.innerText()) && /GTBank/.test(await prof.innerText()) && /0803 123 4567/.test(await prof.innerText()), "an editor's profile shows the admin their payment details");
  ok((await prof.locator('a[href^="tel:"]').getAttribute("href")) === "tel:08031234567", "the phone number rings when tapped");
  await prof.getByRole("button", { name: "Copy" }).click();
  await toast(admin, "Account number copied");
  ok((await admin.evaluate(() => navigator.clipboard.readText())) === "0123456789", "Copy puts the account number on the clipboard, digits only");
  await look(admin, "45-profile", "an editor's profile, for the admin");
  await sheet(admin).getByRole("button", { name: "Close" }).click();
  await closed(admin);
  await payTunde.getByRole("button", { name: "Profile" }).click();
  await sheet(admin).locator("#pf-pay").getByText("No payment details yet.").waitFor();
  ok(true, "an editor who hasn't added details shows none, and the admin is told they've been reminded");
  await sheet(admin).getByRole("button", { name: "Close" }).click();
  await closed(admin);
  // a new bank account is pointed out to the admin
  await ada.locator("#who").click();
  await sheet(ada).getByRole("button", { name: "Change details" }).click();
  ok((await ada.inputValue("#pd-account")) === "0123456789" && (await ada.inputValue("#pd-name")) === "Adaeze Obi", "changing details starts from the saved ones");
  await ada.fill("#pd-bank", "OPay");
  await ada.fill("#pd-account", "8031234567");
  await sheet(ada).getByRole("button", { name: "Save details" }).click();
  await toast(ada, "Payment details saved");
  await payAda.getByRole("button", { name: "Profile" }).click();
  await sheet(admin).locator("#pf-pay").getByText("8031234567").waitFor();
  await see(admin, "Before, pay went to GTBank, account ending 6789.", "when an editor's bank account changes, the admin is warned, with where pay went before");
  await look(admin, "46-profile-changed", "a changed bank account");
  await sheet(admin).getByRole("button", { name: "Close" }).click();
  await closed(admin);
  // an editor can't read anyone else's
  const peek = await ada.evaluate(async (args) => {
    const tok = localStorage.getItem("editroom.token");
    const r = await fetch(args.api + "er_details", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ p_token: tok, p_user: args.uid }) });
    return r.status + " " + (await r.text());
  }, { api: srv.url + "/rest/v1/rpc/", uid: (await sql("select id from app.users where username = 'tunde.bello'")).rows[0].id });
  ok(/^400 .*forbidden/.test(peek), "an editor can't read another editor's details", peek);

  /* ------------------------------------------------------------ phone notifications */
  // A phone's push service can't be reached from here, so the browser's notification permission and push
  // sign-up are stood in for; everything from the app's side, and the database's, is real.
  const pushPhone = async (name, who) => {
    const ctx = await browser.newContext(PHONE);
    await ctx.addInitScript(() => {
      let perm = "default", sub = null;
      const endpoint = "https://fcm.googleapis.com/fcm/send/e2e-" + Math.random().toString(36).slice(2, 10) + "-" + "x".repeat(30);
      Object.defineProperty(Notification, "permission", { get: () => perm, configurable: true });
      Notification.requestPermission = async () => { perm = window.__answer || "granted"; return perm; };
      PushManager.prototype.subscribe = async function (opts) {
        sub = { endpoint: endpoint, options: { applicationServerKey: opts.applicationServerKey },
          toJSON: () => ({ endpoint: endpoint, keys: { p256dh: "B" + "Q".repeat(86), auth: "a".repeat(22) } }),
          unsubscribe: async () => { sub = null; return true; } };
        return sub;
      };
      PushManager.prototype.getSubscription = async function () { return sub; };
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(8000);
    page.on("console", (m) => { if ((m.type() === "error" || m.type() === "warning") && !String(m.location().url).includes("/rest/v1/rpc/")) problems.push(name + " console " + m.type() + ": " + m.text()); });
    page.on("pageerror", (e) => problems.push(name + " page error: " + e.message));
    await page.goto(srv.url + "/");
    await page.fill("#li-user", who[0]);
    await page.fill("#li-pass", who[1]);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.locator("#tabs").waitFor();
    return page;
  };
  const phonesOf = async (username) => (await sql("select endpoint from app.push_subs s join app.users x on x.id = s.user_id where x.username = $1 and s.gone_at is null", [username])).rows.map((r) => r.endpoint);
  const pa0 = await pushPhone("push admin before", ["sam", "admin-pass-1"]);
  ok((await pa0.getByText("Get a ping when a video comes in").count()) === 0, "until the sender is set up, nobody is offered notifications");
  await pa0.context().close();
  await sql("update app.meta set vapid_public = $1", ["B" + "k".repeat(86)]);
  const pa = await pushPhone("push admin", ["sam", "admin-pass-1"]);
  await see(pa, "Get a ping when a video comes in", "then the admin's home screen offers phone notifications");
  await look(pa, "39-push-offer", "notifications offered to the admin");
  await pa.getByRole("button", { name: "Turn on notifications" }).click();
  await toast(pa, "Notifications are on for this phone.");
  ok((await phonesOf("sam")).length === 1 && (await pa.getByText("Get a ping when a video comes in").count()) === 0, "turning them on signs this phone up, and the offer goes away");
  await pa.locator("#who").click();
  await sheet(pa).locator("#ac-notify").getByText("Notifications are on for this phone.").waitFor();
  await look(pa, "40-push-account", "notifications in the account sheet");
  await sheet(pa).getByRole("button", { name: "Send a test" }).click();
  await toast(pa, "Test sent. It should arrive in a few seconds.");
  ok((await sql("select count(*)::int as n from app.outbox o join app.users x on x.id = o.user_id where x.username = 'sam' and o.kind = 'test'")).rows[0].n === 1, "a test notification is queued for the admin's phone");
  await sheet(pa).getByRole("button", { name: "Cancel" }).click();
  await closed(pa);
  // an editor puts it off for now
  const pe = await pushPhone("push editor", ["tunde.bello", newPw]);      // the password the admin reset earlier
  await see(pe, "Get a ping for new scripts and deadlines", "editors are offered pings about new scripts and their deadlines");
  await pe.getByRole("button", { name: "Not now" }).click();
  await gone(pe, "Get a ping for new scripts and deadlines", "Not now puts the offer away");
  await pe.reload();
  await pe.locator("#tabs").waitFor();
  ok((await pe.getByText("Get a ping for new scripts and deadlines").count()) === 0, "and it stays away for a while");
  // an editor submitting pings the admin's phone
  await tab(ada, "work");
  await ada.locator("article.clip", { hasText: "Quick turnaround" }).getByRole("button", { name: "Submit with Drive link" }).click();
  await ada.fill("#s-link", "https://drive.google.com/file/d/quick42/view");
  await sheet(ada).getByRole("button", { name: "Submit project" }).click();
  await closed(ada);
  const pinged = (await sql("select o.title, o.body from app.outbox o join app.users x on x.id = o.user_id where x.username = 'sam' and o.kind = 'submitted'")).rows;
  ok(pinged.length === 1 && pinged[0].title === "Video submitted: Quick turnaround" && pinged[0].body === "Ada O. submitted it on time.", "an editor submitting a video queues a ping for the admin's phone", JSON.stringify(pinged));
  // turning it off, and signing out, stop the pings
  await pa.locator("#who").click();
  await sheet(pa).getByRole("button", { name: "Turn off" }).click();
  await toast(pa, "Notifications are off for this phone.");
  ok((await phonesOf("sam")).length === 0, "turning notifications off on the phone stops them");
  await sheet(pa).getByRole("button", { name: "Turn on notifications" }).click();
  await toast(pa, "Notifications are on for this phone.");
  ok((await phonesOf("sam")).length === 1, "and they can be turned back on from the account sheet");
  await sheet(pa).getByRole("button", { name: "Sign out" }).click();
  await see(pa, "Use the username and password your admin gave you.", "the admin signs out of that phone");
  await pa.waitForTimeout(400);
  ok((await phonesOf("sam")).length === 0, "and that phone stops getting the admin's notifications");
  await pa.context().close();
  await pe.context().close();

  /* ------------------------------------------------------------ reminders: payment details and late videos */
  const tp2 = await pushPhone("push tunde", ["tunde.bello", newPw]);
  await tp2.locator("#who").click();
  await sheet(tp2).getByRole("button", { name: "Turn on notifications" }).click();
  await toast(tp2, "Notifications are on for this phone.");
  await sheet(tp2).getByRole("button", { name: "Cancel" }).click();
  await closed(tp2);
  await tab(tp2, "work");
  await tp2.getByRole("button", { name: "Log a new brief" }).click();
  await tp2.fill("#b-name", "Reminder test brief");
  await tp2.selectOption("#b-cat", { label: "Ads" });
  await sheet(tp2).getByRole("button", { name: "Log brief" }).click();
  await closed(tp2);
  const tundeId = (await sql("select id from app.users where username = 'tunde.bello'")).rows[0].id;
  await sql("update app.projects set started_at = now() - interval '200 hours' where editor_id = $1 and name = 'Reminder test brief'", [tundeId]);
  const lateNow = (await sql("select p.editor_id, count(*)::int as n from app.projects p join app.users x on x.id = p.editor_id where p.status = 'active' and not p.deleted and p.due_at <= now() and x.active and x.removed_at is null group by p.editor_id")).rows;
  const tundeLate = lateNow.find((r) => r.editor_id === tundeId);
  await sync(admin);
  await tab(admin, "settings");
  await admin.locator("#late-status", { hasText: "past the deadline" }).waitFor();
  await admin.locator("#send-reminder").click();
  await sheet(admin).locator("label.option", { hasText: "Submit late videos" }).click();
  await sheet(admin).getByRole("button", { name: "Send reminder" }).click();
  await toast(admin, lateNow.length === 1 ? "Sent to 1 editor. They have notifications on." : "Sent to " + lateNow.length + " editors. 1 of them has notifications on.");
  await closed(admin);
  const lateRem = (await sql("select r.title, r.body, x.username from app.reminders r join app.users x on x.id = r.user_id where r.kind = 'overdue'")).rows;
  ok(lateRem.length === 1 && lateRem[0].username === "tunde.bello" && lateRem[0].title === (tundeLate.n === 1 ? "Submit your video: Reminder test brief" : "Submit your " + tundeLate.n + " late videos"), "the late videos reminder reaches the editor whose video is past its deadline, and names it", JSON.stringify(lateRem));
  await admin.locator("#send-reminder").click();
  const payOpt = sheet(admin).locator("label.option", { hasText: "Payment details" });
  ok(/The 2 editors who haven't added theirs\./.test(await payOpt.innerText()) && /1 of them has notifications on\./.test(await payOpt.innerText()), "the payment details reminder is for the editors who haven't added theirs, and says how many will get a ping", (await payOpt.innerText()).replace(/\n/g, " | "));
  ok(/Last sent/.test(await sheet(admin).locator("label.option", { hasText: "Submit late videos" }).innerText()), "each reminder says when it was last sent");
  await payOpt.click();
  await sheet(admin).getByRole("button", { name: "Send reminder" }).click();
  await toast(admin, "Sent to 2 editors. 1 of them has notifications on.");
  await closed(admin);
  ok((await sql("select count(*)::int as n from app.reminders r join app.users x on x.id = r.user_id where r.kind = 'details' and x.username = 'tunde.bello'")).rows[0].n === 1, "and the editor with notifications on gets it on their phone");
  await admin.locator("#send-reminder").click();
  await sheet(admin).locator("label.option", { hasText: "Payment details" }).click();
  await sheet(admin).getByRole("button", { name: "Send reminder" }).click();
  await toast(admin, "You sent that reminder a few minutes ago, so nothing new went out.");
  await closed(admin);
  ok((await sql("select count(*)::int as n from app.reminders where kind = 'details'")).rows[0].n === 1, "sending the same reminder again straight away sends nothing new");
  ok(/Last reminded/.test(await admin.locator("#pay-status").innerText()) && /Last reminded/.test(await admin.locator("#late-status").innerText()), "Settings show when each reminder last went out");
  // an editor who already has a picture isn't asked for one again, on their phone or on their home screen
  await tp2.locator("#who").click();
  await sheet(tp2).getByText("Your account").waitFor();
  await tp2.setInputFiles("#ac-file", { name: "me.png", mimeType: "image/png", buffer: png });
  await tp2.locator("#ac-pic img").waitFor();
  await sheet(tp2).getByRole("button", { name: "Save picture" }).click();
  await closed(tp2);
  await tp2.locator("#who img.avatar").waitFor();
  await sql("update app.meta set pic_ask_at = now() - interval '11 minutes'");       // the last picture reminder went out a while ago
  await sync(admin);
  await admin.locator("#pic-status", { hasText: "1 of 3 editors have a picture." }).waitFor();
  await admin.locator("#send-reminder").click();
  const picOpt = sheet(admin).locator("label.option", { hasText: "Profile picture" });
  ok(/The 2 editors who don't have a picture yet\./.test(await picOpt.innerText()) && /None of them has notifications on yet\./.test(await picOpt.innerText()), "the picture reminder is only for the editors without a picture", (await picOpt.innerText()).replace(/\n/g, " | "));
  await picOpt.click();
  await sheet(admin).getByRole("button", { name: "Send reminder" }).click();
  await toast(admin, "Sent to 2 editors. None of them has notifications on yet.");
  await closed(admin);
  ok((await sql("select count(*)::int as n from app.reminders r join app.users x on x.id = r.user_id where r.kind = 'picture' and x.username = 'tunde.bello'")).rows[0].n === 0, "an editor who already has a picture isn't pinged, even with notifications on");
  await sync(tp2);
  await tp2.waitForTimeout(400);
  ok((await tp2.getByText("Add a profile picture").count()) === 0 && (await tp2.getByText("Add your payment details").count()) === 1, "and isn't asked on their home screen, where what they still have to do is");
  await sync(ada);
  await see(ada, "Add a profile picture", "an editor without a picture is still asked");
  await look(admin, "47-reminders-settings", "reminders in Settings");

  /* ------------------------------------------------------------ the grace period, as a battery that drains */
  await tp2.getByRole("button", { name: "Log a new brief" }).click();
  await tp2.fill("#b-name", "Grace bar brief");
  await tp2.selectOption("#b-cat", { label: "Ads" });
  await sheet(tp2).getByRole("button", { name: "Log brief" }).click();
  await closed(tp2);
  const graceCard = tp2.locator("article.clip", { hasText: "Grace bar brief" });
  await graceCard.waitFor();
  ok((await graceCard.locator(".grace").count()) === 0, "before its deadline, a brief has no grace bar");
  await sql("update app.projects set started_at = now() - interval '36 hours' where editor_id = $1 and name = 'Grace bar brief'", [tundeId]);
  await sync(tp2);
  const gb = graceCard.locator(".grace");
  await gb.waitFor();
  const level = await gb.evaluate((g) => {
    const f = g.querySelector(".grace-fill"), b = g.querySelector(".grace-batt"), cs = getComputedStyle(b);
    return { pct: 100 * f.getBoundingClientRect().width / (b.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)), left: g.querySelector(".grace-left").textContent, label: g.getAttribute("aria-label"),
      drain: getComputedStyle(f).animationName, flow: getComputedStyle(f, "::before").animationName };
  });
  ok(Math.abs(level.pct - 75) < 1.5 && /^(36h|35h 5\dm) left$/.test(level.left) && /^Grace period: .+ left of 2d$/.test(level.label), "12 hours into a 48-hour grace period, the battery shows three quarters left, and how long", JSON.stringify(level));
  ok(level.drain === "grace-drain" && level.flow === "none", "it keeps draining on its own between redraws; with reduced motion the charge doesn't flow", JSON.stringify(level));
  await tp2.emulateMedia({ reducedMotion: "no-preference" });
  ok((await gb.evaluate((g) => getComputedStyle(g.querySelector(".grace-fill"), "::before").animationName)) === "grace-flow", "otherwise the charge flows out of it, like a phone's fast-charge animation run backwards");
  await tp2.emulateMedia({ reducedMotion: "reduce" });
  await graceCard.scrollIntoViewIfNeeded();
  await look(tp2, "48-grace-bar", "the grace period battery");
  const overBar = tp2.locator("article.clip", { hasText: "Reminder test brief" }).locator(".grace.over");
  ok((await overBar.count()) === 1 && /Over/.test(await overBar.innerText()) && (await overBar.locator(".grace-fill").evaluate((f) => f.getBoundingClientRect().width)) === 0, "once the grace period is over, the battery is empty and says so");
  // the admin sees the same battery, in the inbox and in Projects
  const levelOf = (loc) => loc.evaluate((g) => { const f = g.querySelector(".grace-fill"), b = g.querySelector(".grace-batt"), cs = getComputedStyle(b); return 100 * f.getBoundingClientRect().width / (b.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)); });
  await sync(admin);
  await tab(admin, "inbox");
  const inboxGrace = admin.locator("article.clip", { hasText: "Grace bar brief" }).locator(".grace");
  await inboxGrace.waitFor();
  ok(Math.abs((await levelOf(inboxGrace)) - 75) < 1.5 && /left$/.test(await inboxGrace.locator(".grace-left").innerText()), "the admin's inbox shows the same battery on a video past its deadline", String(await levelOf(inboxGrace)));
  await admin.locator("article.clip", { hasText: "Grace bar brief" }).scrollIntoViewIfNeeded();
  await look(admin, "49-grace-admin", "the grace battery for the admin");
  await tab(admin, "projects");
  await pick(admin, "#f-status", "late");
  const projGrace = admin.locator("article.clip", { hasText: "Grace bar brief" }).locator(".grace");
  await projGrace.waitFor();
  ok(Math.abs((await levelOf(projGrace)) - 75) < 1.5, "and so does Projects", String(await levelOf(projGrace)));
  await pick(admin, "#f-status", "over");
  await admin.locator("article.clip", { hasText: "Reminder test brief" }).locator(".grace.over").waitFor();
  ok(true, "a video whose grace period is over shows the empty battery to the admin too");
  await pick(admin, "#f-status", "active");
  // a new grace period, once saved in Settings, reaches the briefs already in progress
  const graceLeft = (page, re) => page.waitForFunction((src) => {
    const card = Array.from(document.querySelectorAll("article.clip")).find((a) => a.textContent.includes("Grace bar brief"));
    const left = card && card.querySelector(".grace-left");
    return !!left && new RegExp(src).test(left.textContent);
  }, re.source);
  await tab(admin, "settings");
  await admin.locator("#toast").waitFor({ state: "hidden" });
  await admin.fill("#set-grace", "24");
  ok((await lit(admin.locator("#save-deadlines"))) && (await admin.locator("#save-deadlines + .unsaved").isVisible()) && !(await lit(admin.locator("#save-pay"))), "changing the grace period lights up Save changes under Deadlines only");
  await admin.locator("#save-deadlines").scrollIntoViewIfNeeded();
  await look(admin, "50-grace-unsaved", "a new grace period, not saved yet");
  await admin.locator("#save-deadlines").click();
  await toast(admin, "Changes saved. Briefs in progress now have a grace period of 24 hours.");
  ok(true, "saving it says briefs in progress now have the new grace period");
  await sync(tp2);
  await graceLeft(tp2, /^(12h|11h 5\dm) left$/);
  ok(Math.abs((await levelOf(gb)) - 50) < 1.5 && /left of 24h$/.test(await gb.getAttribute("aria-label")), "the editor's battery follows on its next check: 12 hours into a 24-hour grace period, half is left", (await levelOf(gb)) + " / " + (await gb.getAttribute("aria-label")));
  await tab(admin, "inbox");
  await graceLeft(admin, /^(12h|11h 5\dm) left$/);
  ok(Math.abs((await levelOf(inboxGrace)) - 50) < 1.5, "and so does the admin's", String(await levelOf(inboxGrace)));
  await tab(admin, "settings");
  await admin.locator("#toast").waitFor({ state: "hidden" });
  await admin.fill("#set-grace", "48");
  await admin.locator("#set-grace").press("Enter");
  await toast(admin, "Changes saved. Briefs in progress now have a grace period of 48 hours.");
  await sync(tp2);
  await graceLeft(tp2, /^(36h|35h 5\dm) left$/);
  ok(Math.abs((await levelOf(gb)) - 75) < 1.5, "setting it back fills the battery back up", String(await levelOf(gb)));
  await tp2.context().close();

  /* ------------------------------------------------------------ a media buyer: the approved videos, to download */
  await tab(admin, "settings");
  await admin.locator("#add-user").click();
  await admin.fill("#nu-name", "Bola Buyer");
  await pick(admin, "#nu-role", "buyer");
  const buyerUser = await admin.inputValue("#nu-user"), buyerPass = await admin.inputValue("#nu-pass");
  await sheet(admin).getByRole("button", { name: "Create login" }).click();
  await sheet(admin).getByText("Login created").waitFor();
  await sheet(admin).getByRole("button", { name: "Done" }).click();
  await closed(admin);
  const buyerRow = admin.locator("#view .rows").first().locator("> li", { hasText: "Bola Buyer" });
  await buyerRow.waitFor();
  ok(/Media buyer/.test(await buyerRow.innerText()), "an admin can add a media buyer, who shows as one in the team list", (await buyerRow.innerText()).replace(/\n/g, " | "));
  const approvedNow = (await sql("select name, link from app.projects where status = 'submitted' and received_at is not null and not deleted order by (extract(epoch from received_at) * 1000)::bigint desc, id desc")).rows;
  const bola = await open("bola");
  await bola.fill("#li-user", buyerUser);
  await bola.fill("#li-pass", buyerPass);
  await bola.getByRole("button", { name: "Sign in" }).click();
  await bola.getByText("Finished videos").waitFor();
  ok((await bola.locator("#tabs").isHidden()) && (await bola.locator("#who .who-role").innerText()) === "Media buyer", "a media buyer gets one screen, and the header says what they are");
  const buyerCards = bola.locator("#view article.clip");
  ok(approvedNow.length > 30 && (await buyerCards.locator(".clip-title").allInnerTexts()).join("|") === approvedNow.slice(0, 30).map((r) => r.name).join("|"), "they see the approved videos, newest first, 30 at a time", (await buyerCards.locator(".clip-title").allInnerTexts()).slice(0, 5).join("|"));
  await bola.getByRole("button", { name: "Show more" }).click();
  ok(await until(async () => (await buyerCards.count()) === Math.min(60, approvedNow.length)), "Show more brings the next 30", String(await buyerCards.count()));
  const onDrive = approvedNow.find((r) => /^https:\/\/drive\.google\.com\/file\/d\/[^/]+/.test(r.link || ""));
  const dlHref = onDrive ? await bola.locator("article.clip", { hasText: onDrive.name }).getByRole("link", { name: "Download" }).getAttribute("href") : null;
  ok(onDrive && dlHref === "https://drive.google.com/uc?export=download&id=" + /\/file\/d\/([^/]+)/.exec(onDrive.link)[1], "each Drive video has a Download button that downloads the file itself", dlHref);
  ok((await bola.getByText("Log a new brief").count()) === 0 && (await bola.getByText("Leaderboard").count()) === 0 && (await bola.getByText("Payment details").count()) === 0, "and nothing of the editors' work, pay or leaderboard");
  await look(bola, "51-buyer-videos", "the media buyer's screen");
  await bola.locator("#who").click();
  await sheet(bola).getByText("Your account").waitFor();
  ok((await sheet(bola).locator("#ac-pay").count()) === 0 && /Your name is set by your admin\./.test(await sheet(bola).innerText()) && !/leaderboard/i.test(await sheet(bola).innerText()), "a media buyer's account sheet has no payment details", (await sheet(bola).innerText()).replace(/\n/g, " | ").slice(0, 200));
  await look(bola, "52-buyer-account", "the media buyer's account sheet");
  await sheet(bola).getByRole("button", { name: "Cancel" }).click();
  await closed(bola);
  // a video approved while they're there arrives at the top, marked new
  await tab(ada, "work");
  await ada.getByRole("button", { name: "Log a new brief" }).click();
  await ada.fill("#b-name", "Buyer test reel");
  await ada.selectOption("#b-cat", { label: "Ads" });
  await sheet(ada).getByRole("button", { name: "Log brief" }).click();
  await closed(ada);
  await ada.locator("article.clip", { hasText: "Buyer test reel" }).getByRole("button", { name: "Submit with Drive link" }).click();
  await ada.fill("#s-link", "https://drive.google.com/file/d/buyerReel77/view");
  await sheet(ada).getByRole("button", { name: "Submit project" }).click();
  await closed(ada);
  await sync(bola);
  await bola.waitForTimeout(300);
  ok((await bola.getByText("Buyer test reel").count()) === 0, "a video waiting for the admin doesn't reach the buyer");
  await tab(admin, "inbox");
  await sync(admin);
  await admin.locator("article.clip", { hasText: "Buyer test reel" }).getByRole("button", { name: "Mark received" }).click();
  await toast(admin, "Received.");
  await sync(bola);
  const fresh = buyerCards.first();
  await fresh.getByText("Buyer test reel").waitFor();
  ok(/New/.test(await fresh.locator(".pills").innerText()) && /Approved just now, made by Ada O\.(?!\.)/.test(await fresh.innerText()), "once the admin approves it, it's at the top of the buyer's list, marked new", (await fresh.innerText()).replace(/\n/g, " | "));
  // only the category they pick
  const adsId = (await sql("select id from app.categories where name = 'Ads' and not archived")).rows[0].id;
  await pick(bola, "#v-cat", adsId);
  const tapes = await buyerCards.locator(".tape").allInnerTexts();
  ok(tapes.length > 0 && tapes.every((t) => t === "Ads") && tapes.length < (await sql("select count(*)::int as n from app.projects where status = 'submitted' and received_at is not null and not deleted")).rows[0].n, "they can show one category at a time", tapes.join(","));
  await pick(bola, "#v-cat", "all");
  await fresh.getByRole("button", { name: "Watch" }).click();
  await bola.locator("#player iframe").waitFor();
  ok((await frameSrc(bola)) === "https://drive.google.com/file/d/buyerReel77/preview" && /Ada O\./.test(await bola.locator("#player .player-by").innerText()), "and watch a video in the app before downloading it", await frameSrc(bola));
  await bola.locator("#player").getByRole("button", { name: "Close" }).click();
  // the admin can look at the media buyer screen from Settings, any time, with the same list
  await tab(admin, "settings");
  await admin.locator("#try-buyer").click();
  await see(admin, "This is the media buyer screen, as your media buyers see it.", "the admin can open the media buyer screen from Settings");
  const peekCards = admin.locator("#view article.clip");
  await peekCards.first().waitFor();
  const buyerNames = (await buyerCards.locator(".clip-title").allInnerTexts()).slice(0, 30), peekNames = await peekCards.locator(".clip-title").allInnerTexts();
  ok((await admin.locator("#tabs").isHidden()) && peekNames.join("|") === buyerNames.join("|") && (await admin.locator("#view .pill.gold").count()) === 0 && (await admin.locator("#view .push-card").count()) === 0,
    "it shows exactly the videos the media buyer sees, in the same order, without marking any as new", peekNames.slice(0, 3).join("|") + " vs " + buyerNames.slice(0, 3).join("|"));
  await look(admin, "53-admin-as-buyer", "the admin looking at the media buyer screen");
  await admin.locator("#back-admin").click();
  await admin.locator("#try-buyer").waitFor();
  ok(!(await admin.locator("#tabs").isHidden()) && (await admin.getByText("This is the media buyer screen").count()) === 0, "Back to admin returns to Settings");
  await bola.context().close();
  // the offline helper shows what arrives, with the studio's badge, and buzzes (the lightweight test browser
  // can't show notifications at all, so this one check runs in the full one)
  const full = await chromium.launch({ channel: "chromium" });
  const nctx = await full.newContext(Object.assign({}, PHONE, { permissions: ["notifications"] }));
  const np = await nctx.newPage();
  await np.goto(srv.url + "/");
  await np.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  const cdp = await nctx.newCDPSession(np);
  const regs = [];
  cdp.on("ServiceWorker.workerRegistrationUpdated", (e) => regs.push(...e.registrations));
  await cdp.send("ServiceWorker.enable");
  for (let i = 0; i < 40 && !regs.some((r) => r.scopeURL === srv.url + "/" && !r.isDeleted); i++) await np.waitForTimeout(100);
  const reg = regs.find((r) => r.scopeURL === srv.url + "/" && !r.isDeleted);
  await cdp.send("ServiceWorker.deliverPushMessage", { origin: srv.url, registrationId: reg.registrationId, data: JSON.stringify({ title: "Video submitted: Night market short", body: "Ada Obi submitted it on time.", tag: "submitted:abc", url: "./" }) });
  let shown = [];
  for (let i = 0; i < 40 && !shown.length; i++) { await np.waitForTimeout(100); shown = await np.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => ({ title: n.title, body: n.body, tag: n.tag, badge: n.badge, icon: n.icon, vibrate: Array.from(n.vibrate || []) }))); }
  ok(shown.length === 1 && shown[0].title === "Video submitted: Night market short" && shown[0].body === "Ada Obi submitted it on time." && shown[0].tag === "submitted:abc" && /badge-96\.png$/.test(shown[0].badge) && /icon-192\.png$/.test(shown[0].icon) && shown[0].vibrate.join() === "180,80,180", "a notification arriving on the phone shows what came in, with the studio's badge and a buzz", JSON.stringify(shown));
  // a media buyer's ping keeps its download, for the tap to open; any other address is ignored
  await cdp.send("ServiceWorker.deliverPushMessage", { origin: srv.url, registrationId: reg.registrationId, data: JSON.stringify({ title: "New video: Night market short", body: "Shorts. Tap to download it.", tag: "video:abc", url: "https://drive.google.com/uc?export=download&id=abc123" }) });
  await cdp.send("ServiceWorker.deliverPushMessage", { origin: srv.url, registrationId: reg.registrationId, data: JSON.stringify({ title: "Odd", body: "x", tag: "odd", url: "javascript:alert(1)" }) });
  let taps = [];
  for (let i = 0; i < 40 && taps.length < 2; i++) { await np.waitForTimeout(100); taps = await np.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).filter((n) => n.tag !== "submitted:abc").map((n) => ({ tag: n.tag, url: n.data && n.data.url }))); }
  ok(taps.find((t) => t.tag === "video:abc").url === "https://drive.google.com/uc?export=download&id=abc123" && taps.find((t) => t.tag === "odd").url === "./", "a media buyer's video ping carries its download link; anything else opens the app", JSON.stringify(taps));
  await full.close();
} catch (e) {
  ok(false, "the run stopped early", String(e && e.message).split("\n").slice(0, 4).join(" / "));
}

ok(!problems.length, "no browser errors, blocked requests or security-policy violations", problems.slice(0, 12).join(" || "));
console.log("\n" + results.filter((r) => r.startsWith("PASS")).length + " passed, " + failed + " failed  (" + srv.calls.length + " server calls)");
if (process.env.VERBOSE) console.log(results.join("\n"));
await browser.close();
await srv.close();
process.exit(failed ? 1 : 0);
