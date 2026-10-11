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
  await page.goto(srv.url + "/");
  return page;
}
const sql = (text, params) => srv.sql(text, params);
const sync = (page) => page.evaluate(() => { document.dispatchEvent(new Event("visibilitychange")); });
const tab = (page, id) => page.locator('#tabs button[data-tab="' + id + '"]').click();
const sheet = (page) => page.locator("#sheet");
const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const pick = async (page, sel, value) => { await page.selectOption(sel, value); await settle(page); };
const closed = (page) => page.waitForFunction(() => !document.getElementById("sheet").open);
const toast = async (page, text) => { await page.locator("#toast", { hasText: text }).waitFor(); };
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
    return { wide, unlabeled, small };
  });
  ok(m.wide <= 1, (label || name) + ": no sideways scroll", m.wide + "px too wide");
  ok(!m.unlabeled.length, (label || name) + ": every field has a label", m.unlabeled.join(", "));
  ok(!m.small.length, (label || name) + ": touch targets are big enough", m.small.join(" | "));
  await page.screenshot({ path: path.join(SHOTS, name + ".png"), fullPage: !(await page.evaluate(() => document.getElementById("sheet").open)) });
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
  await admin.fill("#set-currency", "$");
  await admin.locator("#set-currency").blur();
  await toast(admin, "Saved");
  await admin.fill("#set-target", "5");
  await admin.locator("#set-target").blur();
  await admin.fill("#set-bonus", "25");
  await admin.locator("#set-bonus").blur();
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
  await look(admin, "13-inbox-waiting", "inbox with a submission");
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

  /* ------------------------------------------------------------ account: picture, name, password, sign out */
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAEAAAAAoCAIAAADBrGu+AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAPUlEQVRYw+3PQQkAAAgEsItjRMMaxgw+hcEKLNP1WgQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQELhYkk9jT5G7+yQAAAABJRU5ErkJggg==", "base64");      // a small orange picture
  await ada.locator("#who").click();
  await sheet(ada).getByText("Your account").waitFor();
  ok((await ada.locator("#ac-name").count()) === 0 && /Your name is set by your admin/.test(await sheet(ada).innerText()) && !(await sheet(ada).getByRole("button", { name: "Remove" }).isVisible()), "an editor can set a picture but not change their own name");
  await ada.setInputFiles("#ac-file", { name: "me.png", mimeType: "image/png", buffer: png });
  await ada.locator("#ac-pic img").waitFor();
  ok(await sheet(ada).getByRole("button", { name: "Remove" }).isVisible(), "a chosen picture can be removed again");
  await look(ada, "27-account", "account sheet");
  await sheet(ada).getByRole("button", { name: "Save picture" }).click();
  await closed(ada);
  await ada.locator("#who img.avatar").waitFor();
  ok(true, "the picture is saved and shows in the header");
  await sync(admin);
  await admin.locator("article.clip", { hasText: "Ada Obi" }).locator("img.avatar").waitFor();
  ok(true, "the admin sees the editor's picture");
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
  await ada.locator("#who").click();
  await sheet(ada).getByRole("button", { name: "Sign out" }).click();
  await see(ada, "Use the username and password your admin gave you.", "signing out returns to the sign-in screen");
  ok((await ada.evaluate(() => localStorage.getItem("editroom.token"))) === null, "signing out forgets the session on this phone");
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
  ok(bars >= 5 && /8\d%/.test(await adaHist.innerText()), "each editor's six weeks and on-time rate cover work older than what is loaded", bars + " weeks with bars; " + (await adaHist.locator(".facts").innerText()).replace(/\n/g, " "));
  await adaHist.locator(".spark .bar").nth(3).click();
  await adaHist.locator(".readout b").waitFor();
  ok(/videos? in the week of .*: \d+ on time, \d+ late\./.test(await adaHist.locator(".readout").innerText()), "tapping a week's bar gives that week's numbers", await adaHist.locator(".readout").innerText());
  await look(admin, "30c-editors-history", "editors with weeks of history");

  // a changed delivery time applies to new briefs
  await tab(admin, "settings");
  await admin.fill("#set-delivery", "12");
  await admin.locator("#set-delivery").blur();
  await toast(admin, "Saved");
  await sync(ada);
  await tab(ada, "work");
  await ada.getByRole("button", { name: "Log a new brief" }).click();
  await sheet(ada).getByText("Your 12-hour deadline starts as soon as you log it.").waitFor();
  await ada.fill("#b-name", "Quick turnaround");
  await ada.selectOption("#b-cat", { label: "Ads" });
  await sheet(ada).getByRole("button", { name: "Log brief" }).click();
  await closed(ada);
  ok(/Due in (11h 5\dm|12h)/.test(await ada.locator("article.clip", { hasText: "Quick turnaround" }).innerText()), "a brief logged after the admin changes the delivery time gets the new deadline");
  await admin.fill("#set-delivery", "24");
  await admin.locator("#set-delivery").blur();
  await toast(admin, "Saved");
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
} catch (e) {
  ok(false, "the run stopped early", String(e && e.message).split("\n").slice(0, 4).join(" / "));
}

ok(!problems.length, "no browser errors, blocked requests or security-policy violations", problems.slice(0, 12).join(" || "));
console.log("\n" + results.filter((r) => r.startsWith("PASS")).length + " passed, " + failed + " failed  (" + srv.calls.length + " server calls)");
if (process.env.VERBOSE) console.log(results.join("\n"));
await browser.close();
await srv.close();
process.exit(failed ? 1 : 0);
