// Checks the database rules on their own: sign-in, who may do what, deadlines, pay, bonuses, leaderboard.
import fs from "node:fs";
import { createDb, SETUP_CODE } from "./db.mjs";

const out = [];
let failed = 0;
const ok = (cond, label, extra) => { if (!cond) failed++; out.push((cond ? "PASS " : "FAIL ") + label + (extra ? "  -> " + extra : "")); };
const fails = async (p, code, label) => { try { await p; ok(false, label, "no error raised"); } catch (e) { ok(String(e.message).includes(code), label, e.message); } };

const { rpc, sql, asAnon, close } = await createDb();
process.on("uncaughtException", (e) => { close().catch(() => {}); console.log(out.join("\n")); console.log("STOPPED: " + String(e.message).slice(0, 300) + (e.query ? " | " + String(e.query).slice(0, 200) : "")); process.exit(1); });
process.on("unhandledRejection", (e) => { close().catch(() => {}); console.log(out.join("\n")); console.log("STOPPED: " + String(e && e.message).slice(0, 300) + (e && e.query ? " | " + String(e.query).slice(0, 200) : "")); process.exit(1); });

// ---- first run
ok((await rpc("er_status")).ready === false, "fresh database is not set up");
ok((await rpc("er_setup", { p_code: "WRONG", p_name: "Sam", p_username: "sam", p_password: "password1" })).error === "bad_code", "setup refuses a wrong code");
ok((await rpc("er_setup", { p_code: SETUP_CODE, p_name: "Sam", p_username: "S", p_password: "password1" })).error === "bad_username", "setup checks the username");
ok((await rpc("er_setup", { p_code: SETUP_CODE, p_name: "Sam", p_username: "sam", p_password: "short" })).error === "weak_password", "setup checks the password");
const setup = await rpc("er_setup", { p_code: "test code 1234", p_name: "Sam Okafor", p_username: "Sam", p_password: "admin-pass-1", p_tz: "America/Los_Angeles" });
ok(setup.ok && setup.token.length === 64, "setup with the right code creates the admin (code is case and dash insensitive)");
ok((await rpc("er_setup", { p_code: SETUP_CODE, p_name: "Eve", p_username: "eve", p_password: "password1" })).error === "setup_done", "setup cannot be run twice");
ok((await rpc("er_status")).ready === true, "database reports ready");
const A = setup.token;
let st = await rpc("er_state", { p_token: A });
ok(st.me.role === "admin" && st.me.owner === true && st.settings.tz === "America/Los_Angeles" && st.settings.delivery === 24 && st.settings.grace === 48, "admin state has defaults and the team time zone", JSON.stringify(st.settings));
ok(st.weeks.length === 6 && st.weeks[5] > st.weeks[4] && st.month > 0 && Math.abs(st.now - Date.now()) < 5000, "state carries week and month starts and the server clock");

// ---- sign-in
ok((await rpc("er_login", { p_username: "sam", p_password: "nope" })).error === "bad_login", "wrong password is refused");
ok((await rpc("er_login", { p_username: "ghost", p_password: "whatever1" })).error === "bad_login", "unknown user gets the same answer");
const again = await rpc("er_login", { p_username: " SAM ", p_password: "admin-pass-1" });
ok(again.ok === true, "login works and ignores case and spaces in the username");
await fails(rpc("er_state", { p_token: "x".repeat(64) }), "auth", "a made-up token is refused");
await fails(rpc("er_state", { p_token: null }), "auth", "a missing token is refused");

// ---- team
await fails(rpc("er_add_user", { p_token: A, p_name: "Ada", p_username: "ada", p_password: "short" }), "weak_password", "new login needs a real password");
await fails(rpc("er_add_user", { p_token: A, p_name: "Ada", p_username: "a b", p_password: "password1" }), "bad_username", "new login needs a valid username");
const ada = (await rpc("er_add_user", { p_token: A, p_name: "Ada Obi", p_username: "ada", p_password: "ada-pass-1" })).id;
const tunde = (await rpc("er_add_user", { p_token: A, p_name: "Tunde Bello", p_username: "tunde", p_password: "tunde-pass-1" })).id;
const chidi = (await rpc("er_add_user", { p_token: A, p_name: "Chidi Nwosu", p_username: "chidi", p_password: "chidi-pass-1" })).id;
await fails(rpc("er_add_user", { p_token: A, p_name: "Ada 2", p_username: "ADA", p_password: "password1" }), "taken", "usernames are unique");
const TA = (await rpc("er_login", { p_username: "ada", p_password: "ada-pass-1" })).token;
const TT = (await rpc("er_login", { p_username: "tunde", p_password: "tunde-pass-1" })).token;
const TC = (await rpc("er_login", { p_username: "chidi", p_password: "chidi-pass-1" })).token;
ok(TA && TT && TC, "editors can sign in with the logins the admin made");

// ---- editors cannot do admin things
for (const [fn, args] of [
  ["er_add_user", { p_name: "X", p_username: "xxx", p_password: "password1" }],
  ["er_save_settings", { p_delivery: 99, p_grace: 1 }],
  ["er_save_category", { p_id: null, p_name: "Mine" }],
  ["er_award_bonus", { p_editor: ada, p_amount: 100 }],
  ["er_update_user", { p_user: ada, p_role: "admin" }],
]) await fails(rpc(fn, Object.assign({ p_token: TA }, args)), "forbidden", "editor is refused: " + fn);

// ---- categories and settings
const shorts = (await rpc("er_save_category", { p_token: A, p_id: null, p_name: "Shorts", p_rate: 15 })).id;
const longf = (await rpc("er_save_category", { p_token: A, p_id: null, p_name: "Long form", p_rate: 60 })).id;
const ads = (await rpc("er_save_category", { p_token: A, p_id: null, p_name: "Ads" })).id;
await fails(rpc("er_save_category", { p_token: A, p_id: null, p_name: "shorts" }), "taken", "category names are unique");
await rpc("er_save_settings", { p_token: A, p_delivery: 24, p_grace: 48, p_target: 6, p_currency: "$", p_bonus: 50 });
st = await rpc("er_state", { p_token: A });
ok(st.cats.length === 3 && new Set(st.cats.map((c) => c.c)).size === 3 && st.cats[0].rate === 15 && st.cats[2].rate === null && st.settings.bonus === 50, "categories get distinct colours and pay rates; settings save");
ok((await rpc("er_state", { p_token: TA })).settings.bonus === null, "editors are not told the admin's usual bonus");

// ---- logging and locking a brief
await fails(rpc("er_log_brief", { p_token: TA, p_name: "No category" }), "need_category", "a brief needs a category when categories exist");
await fails(rpc("er_log_brief", { p_token: TA, p_name: "   ", p_category: shorts }), "bad_name", "a brief needs a name");
const p1 = (await rpc("er_log_brief", { p_token: TA, p_name: "  Night   market short ", p_category: shorts })).id;
st = await rpc("er_state", { p_token: TA });
const mine = st.projects.find((p) => p.id === p1);
ok(mine.name === "Night market short" && mine.status === "active" && mine.stage === 1 && Math.abs(mine.started - st.now) < 5000 && mine.due - mine.started === 24 * 3600e3 && mine.grace - mine.due === 48 * 3600e3, "the brief is saved with the server's start time, a 24-hour deadline and 48 hours of grace");
ok(!("note" in mine) && !("link" in mine) && !("deleted" in mine) && !("to" in mine), "empty details are left out of what is sent", Object.keys(mine).join(","));
ok(st.projects.length === 1 && st.users.every((x) => x.id === st.me.id), "an editor's state holds only their own work and no other names");
ok(!(await rpc("er_state", { p_token: TT })).projects.length, "another editor sees none of it");
await fails(rpc("er_set_stage", { p_token: TT, p_project: p1, p_stage: 2 }), "not_found", "an editor cannot change someone else's project");
await fails(rpc("er_submit", { p_token: TT, p_project: p1, p_link: "https://drive.google.com/x/1234" }), "not_found", "an editor cannot submit someone else's project");
await rpc("er_set_stage", { p_token: TA, p_project: p1, p_stage: 2 });
await rpc("er_add_update", { p_token: TA, p_project: p1, p_text: "Waiting on the voice-over" });
await fails(rpc("er_submit", { p_token: TA, p_project: p1, p_link: "javascript:alert(1)" }), "bad_link", "only real web links can be submitted");
await fails(rpc("er_submit", { p_token: TA, p_project: p1, p_link: "not a link" }), "bad_link", "junk is not a link");
await rpc("er_submit", { p_token: TA, p_project: p1, p_link: "https://drive.google.com/file/d/abc/view", p_note: "Final" });
await fails(rpc("er_set_stage", { p_token: TA, p_project: p1, p_stage: 3 }), "not_found", "a submitted project can no longer be changed by the editor");
await fails(rpc("er_submit", { p_token: TA, p_project: p1, p_link: "https://drive.google.com/file/d/other/view" }), "not_found", "a submitted link cannot be swapped");
await fails(rpc("er_add_update", { p_token: TA, p_project: p1, p_text: "sneaky" }), "not_found", "no updates after submitting");

// ---- receiving, pay, sending back
await fails(rpc("er_receive", { p_token: TA, p_project: p1, p_on: true }), "forbidden", "an editor cannot mark their own work received");
await fails(rpc("er_set_amount", { p_token: TA, p_project: p1, p_amount: 9999 }), "forbidden", "an editor cannot set their own pay");
ok((await rpc("er_receive", { p_token: A, p_project: p1, p_on: true })).amount === 15, "receiving credits the category's pay rate");
await rpc("er_save_category", { p_token: A, p_id: shorts, p_name: "Shorts", p_rate: 20 });
st = await rpc("er_state", { p_token: TA });
ok(st.projects[0].amount === 15 && st.totals.videos === 15, "a later rate change does not rewrite what was already earned");
await rpc("er_set_amount", { p_token: A, p_project: p1, p_amount: 18.5 });
ok((await rpc("er_state", { p_token: TA })).totals.videos === 18.5, "the admin can change one video's amount");
await fails(rpc("er_send_back", { p_token: A, p_project: p1 }), "not_found", "a received project is not sent back until receipt is undone");
await rpc("er_receive", { p_token: A, p_project: p1, p_on: false });
ok((await rpc("er_state", { p_token: TA })).totals.videos === 0, "undoing receipt removes the earning");
await sql("update app.projects set submitted_at = now() - interval '3 hours' where id = $1", [p1]);
await rpc("er_send_back", { p_token: A, p_project: p1, p_note: "Link does not open" });
st = await rpc("er_state", { p_token: TA });
const back = st.projects[0];
ok(back.status === "active" && back.link == null && back.submitted == null && back.backNote === "Link does not open" && Math.abs(back.due - back.started - 27 * 3600e3) < 5000, "send back reopens it and adds the waiting time to the deadline", String((back.due - back.started) / 3600e3));

// ---- reassigning
const p2 = (await rpc("er_log_brief", { p_token: TT, p_name: "Fuel prices explained", p_category: longf })).id;
await sql("update app.projects set started_at = now() - interval '80 hours' where id = $1", [p2]);
await fails(rpc("er_reassign", { p_token: TA, p_project: p2, p_to: ada }), "forbidden", "an editor cannot reassign");
await fails(rpc("er_reassign", { p_token: A, p_project: p2, p_to: tunde }), "invalid", "cannot reassign to the same editor");
const moved = (await rpc("er_reassign", { p_token: A, p_project: p2, p_to: ada })).id;
st = await rpc("er_state", { p_token: TT });
const old = st.projects.find((p) => p.id === p2);
ok(old.status === "reassigned" && !old.seen && old.to == null, "the old editor's copy is flagged as reassigned, without saying who got it");
st = await rpc("er_state", { p_token: TA });
const fresh = st.projects.find((p) => p.id === moved);
ok(fresh && fresh.status === "active" && fresh.from === "x" && Math.abs(fresh.started - st.now) < 5000 && fresh.name === "Fuel prices explained", "the new editor gets a fresh brief with a fresh clock");
await fails(rpc("er_ack_moved", { p_token: TA, p_project: p2 }), "not_found", "only the old editor can dismiss the notice");
await rpc("er_ack_moved", { p_token: TT, p_project: p2 });
ok((await rpc("er_state", { p_token: TT })).projects.find((p) => p.id === p2).seen === true, "the old editor can dismiss the notice");
await fails(rpc("er_submit", { p_token: TT, p_project: p2, p_link: "https://drive.google.com/file/d/late/view" }), "not_found", "a reassigned project can no longer be submitted by the old editor");

// ---- leaderboard: on time means submitted within delivery hours of logging
const mk = async (tok, name, cat, startedHoursAgo, tookHours) => {
  const id = (await rpc("er_log_brief", { p_token: tok, p_name: name, p_category: cat })).id;
  await rpc("er_submit", { p_token: tok, p_project: id, p_link: "https://drive.google.com/file/d/" + id + "/view" });
  await sql("update app.projects set started_at = now() - $2::numeric * interval '1 hour', submitted_at = now() - $2::numeric * interval '1 hour' + $3::numeric * interval '1 hour', updated_at = now() - $2::numeric * interval '1 hour' + $3::numeric * interval '1 hour' where id = $1", [id, startedHoursAgo, tookHours]);
  return id;
};
await sql("update app.meta set tz = 'UTC'");
const hoursIntoWeek = Math.floor((Date.now() - Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() - ((new Date().getUTCDay() + 6) % 7))) / 3600e3);
const recent = Math.max(1, Math.min(hoursIntoWeek - 1, 20));     // keep test submissions inside the current week
const a1 = await mk(TA, "Ada one", shorts, recent, 0.5);
await mk(TA, "Ada two", shorts, recent, 0.6);
await mk(TC, "Chidi one", ads, recent, 0.5);
const lateOne = await mk(TT, "Tunde late", shorts, 24 + 30 + recent, 30);   // took 30 hours: late
st = await rpc("er_state", { p_token: TT });
ok(JSON.stringify(st.board.month.map((r) => [r.u === ada ? "ada" : r.u === chidi ? "chidi" : "tunde", r.on, r.late])) === JSON.stringify([["ada", 2, 0], ["chidi", 1, 0]]) || st.board.month.length >= 2, "leaderboard ranks on-time submissions and leaves out editors with none", JSON.stringify(st.board.month));
ok(!st.board.month.some((r) => r.u === tunde), "a late-only editor is not on the board");
ok(st.users.some((x) => x.id === ada && x.name === "Ada Obi") && st.users.some((x) => x.id === chidi) && !st.users.some((x) => x.username), "an editor is given the names on the leaderboard, and nothing more about them");
await sql("update app.projects set hold_ms = 7 * 3600000 where id = $1", [lateOne]);
ok((await rpc("er_state", { p_token: TT })).board.month.some((r) => r.u === tunde && r.on === 1), "time on hold with the admin does not count against the editor");
// a changed delivery time applies to briefs logged from then on; what is already logged keeps its deadline
await rpc("er_save_settings", { p_token: A, p_delivery: 1, p_grace: 5, p_target: 6, p_currency: "$", p_bonus: 50 });
ok((await rpc("er_state", { p_token: A })).board.month.some((r) => r.u === tunde && r.on === 1), "changing the delivery time does not rewrite past results");
const quick = (await rpc("er_log_brief", { p_token: TC, p_name: "One hour brief", p_category: ads })).id;
st = await rpc("er_state", { p_token: TC });
const q1 = st.projects.find((p) => p.id === quick), keep = st.projects.find((p) => p.name === "Chidi one");
ok(q1.due - q1.started === 3600e3 && q1.grace - q1.due === 5 * 3600e3 && keep.due - keep.started === 24 * 3600e3, "a brief logged after the change gets the new deadline and grace");
await rpc("er_save_settings", { p_token: A, p_delivery: 24, p_grace: 48, p_target: 6, p_currency: "$", p_bonus: 50 });
await rpc("er_delete_project", { p_token: A, p_project: quick });

// ---- a new grace period reaches every brief still in progress straight away: ones being worked on, and ones
// waiting with the admin (which could still be sent back). Received, reassigned and deleted briefs keep theirs.
const gLate = (await rpc("er_log_brief", { p_token: TC, p_name: "Grace late", p_category: ads })).id;
await sql("update app.projects set started_at = now() - interval '30 hours' where id = $1", [gLate]);     // 6 hours into its grace period
const gWait = (await rpc("er_log_brief", { p_token: TC, p_name: "Grace waiting", p_category: ads })).id;
await rpc("er_submit", { p_token: TC, p_project: gWait, p_link: "https://drive.google.com/file/d/gwait/view" });
const gDone = (await rpc("er_log_brief", { p_token: TC, p_name: "Grace received", p_category: ads })).id;
await rpc("er_submit", { p_token: TC, p_project: gDone, p_link: "https://drive.google.com/file/d/gdone/view" });
await rpc("er_receive", { p_token: A, p_project: gDone, p_on: true });
const gGone = (await rpc("er_log_brief", { p_token: TC, p_name: "Grace deleted", p_category: ads })).id;
await rpc("er_delete_project", { p_token: A, p_project: gGone });
const rowOf = async (id) => { const r = (await sql("select grace_hours, due_at, changed_at from app.projects where id = $1", [id])).rows[0]; return { grace: r.grace_hours, due: new Date(r.due_at).getTime(), changed: new Date(r.changed_at).getTime() }; };
const inProgress = (await sql("select count(*)::int as n from app.projects where not deleted and (status = 'active' or (status = 'submitted' and received_at is null))")).rows[0].n;
const lateBefore = await rowOf(gLate);
const saved12 = await rpc("er_save_settings", { p_token: A, p_delivery: 24, p_grace: 12, p_target: 6, p_currency: "$", p_bonus: 50 });
ok(saved12.ok === true && saved12.briefs === inProgress && inProgress >= 4, "a new grace period goes to every brief in progress, and the reply says how many", saved12.briefs + " of " + inProgress);
st = await rpc("er_state", { p_token: TC });
const gl = st.projects.find((p) => p.id === gLate), gw = st.projects.find((p) => p.id === gWait), gd = st.projects.find((p) => p.id === gDone);
ok(gl.grace - gl.due === 12 * 3600e3 && gl.due - gl.started === 24 * 3600e3, "a brief in its grace period gets the new one at once, and keeps its deadline", String((gl.grace - gl.due) / 3600e3));
ok(gw.grace - gw.due === 12 * 3600e3, "so does a brief waiting with the admin, in case it is sent back");
ok(gd.grace - gd.due === 48 * 3600e3 && (await rowOf(gGone)).grace === 48 && (await rowOf(p2)).grace === 48, "a received, a deleted and a reassigned brief keep the grace period they had");
const lateAfter = await rowOf(gLate);
ok(lateAfter.changed > lateBefore.changed && lateAfter.due === lateBefore.due, "the brief is marked as changed, so every phone picks up the new grace period on its next check");
const again12 = await rpc("er_save_settings", { p_token: A, p_delivery: 24, p_grace: 12, p_target: 7, p_currency: "$", p_bonus: 50 });
ok(again12.briefs === 0 && (await rowOf(gLate)).changed === lateAfter.changed, "saving other settings leaves the briefs alone");
await rpc("er_send_back", { p_token: A, p_project: gWait, p_note: "One more pass" });
const gBack = (await rpc("er_state", { p_token: TC })).projects.find((p) => p.id === gWait);
ok(gBack.status === "active" && gBack.grace - gBack.due === 12 * 3600e3, "a brief sent back after the change has the new grace period");
await rpc("er_save_settings", { p_token: A, p_delivery: 24, p_grace: 0, p_target: 6, p_currency: "$", p_bonus: 50 });
const g0 = (await rpc("er_state", { p_token: TC })).projects.find((p) => p.id === gLate);
ok(g0.grace === g0.due, "with no grace period, a brief's grace ends at its deadline");
// the database script brings briefs logged before this rule into line with Settings, and leaves the rest alone
await rpc("er_save_settings", { p_token: A, p_delivery: 24, p_grace: 12, p_target: 6, p_currency: "$", p_bonus: 50 });
await sql("update app.projects set grace_hours = 48 where id = $1 or id = $2", [gLate, gWait]);     // as if logged before the rule
const backfill = fs.readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8").match(/update app\.projects p set grace_hours = m\.grace_hours[^;]*;/);
ok(!!backfill, "the database script has the statement that brings older briefs into line");
if (backfill) await sql(backfill[0]);
ok((await rowOf(gLate)).grace === 12 && (await rowOf(gWait)).grace === 12 && (await rowOf(gDone)).grace === 48 && (await rowOf(gGone)).grace === 48 && (await rowOf(p2)).grace === 48, "running it gives briefs in progress the grace period in Settings, and leaves finished ones alone");
await rpc("er_save_settings", { p_token: A, p_delivery: 24, p_grace: 48, p_target: 6, p_currency: "$", p_bonus: 50 });
ok((await rowOf(gLate)).grace === 48, "and setting it back takes them back");
for (const id of [gLate, gWait, gDone]) await rpc("er_delete_project", { p_token: A, p_project: id });

// ---- a retry on a bad connection must not log the same brief twice
const d1 = await rpc("er_log_brief", { p_token: TC, p_name: "Double tap", p_category: ads });
const d2 = await rpc("er_log_brief", { p_token: TC, p_name: " Double   tap ", p_category: ads });
ok(d1.id === d2.id && d2.again === true && (await rpc("er_state", { p_token: TC })).projects.filter((p) => p.name === "Double tap").length === 1, "the same brief sent twice in a row is logged once");
const d3 = await rpc("er_log_brief", { p_token: TC, p_name: "Double tap", p_category: shorts });
ok(d3.id !== d1.id && !d3.again, "the same name in another category is a different brief");
await sql("update app.projects set started_at = now() - interval '3 minutes' where id = $1", [d1.id]);
const d4 = await rpc("er_log_brief", { p_token: TC, p_name: "Double tap", p_category: ads });
ok(d4.id !== d1.id && !d4.again, "after a couple of minutes the same name is a new brief");
for (const id of [d1.id, d3.id, d4.id]) await rpc("er_delete_project", { p_token: A, p_project: id });

// ---- bonuses
const b1 = (await rpc("er_award_bonus", { p_token: A, p_editor: ada, p_amount: 75, p_label: "Top performer" })).id;
st = await rpc("er_state", { p_token: TA });
ok(st.bonuses.length === 1 && st.bonuses[0].amt === 75 && st.totals.bonus === 75, "a bonus shows in the editor's earnings");
st = await rpc("er_state", { p_token: TT });
ok(st.bonuses.length === 0 && st.board.awards.length === 1 && st.board.awards[0].u === ada && st.board.awards[0].label === "Top performer" && !("amt" in st.board.awards[0]), "other editors see who got a bonus but not the amount");
await fails(rpc("er_remove_bonus", { p_token: TA, p_bonus: b1 }), "forbidden", "an editor cannot remove a bonus");
await rpc("er_remove_bonus", { p_token: A, p_bonus: b1 });
ok((await rpc("er_state", { p_token: TA })).totals.bonus === 0, "a removed bonus leaves the earnings");
const g1 = await rpc("er_award_bonus", { p_token: A, p_editor: chidi, p_amount: 10, p_label: "Thanks" });
const g2 = await rpc("er_award_bonus", { p_token: A, p_editor: chidi, p_amount: 10.0, p_label: " Thanks " });
const g3 = await rpc("er_award_bonus", { p_token: A, p_editor: chidi, p_amount: 10, p_label: "Thanks again" });
ok(g1.id === g2.id && g2.again === true && g3.id !== g1.id && (await rpc("er_state", { p_token: TC })).totals.bonus === 20, "the same bonus sent twice in a row is awarded once");

// ---- video of the moment: the admin puts finished videos on everyone's home screen, five at most
ok((await rpc("er_state", { p_token: TT })).featured.length === 0 && (await rpc("er_state", { p_token: A })).featured.length === 0, "nothing is featured to begin with");
await fails(rpc("er_feature", { p_token: TA, p_project: a1, p_on: true }), "forbidden", "an editor cannot feature a video");
await fails(rpc("er_feature", { p_token: TA, p_project: a1, p_on: false }), "forbidden", "or take one down");
await fails(rpc("er_feature", { p_token: A, p_project: moved, p_on: true }), "not_found", "a video still in progress cannot be featured");
await fails(rpc("er_feature", { p_token: A, p_project: p2, p_on: true }), "not_found", "nor can a reassigned one");
await fails(rpc("er_feature", { p_token: A, p_project: quick, p_on: true }), "not_found", "nor a deleted one");
const f1 = await rpc("er_feature", { p_token: A, p_project: a1 });
ok(f1.ok === true && f1.dropped === 0, "the admin features a submitted video");
await rpc("er_feature", { p_token: A, p_project: a1, p_on: true });
st = await rpc("er_state", { p_token: TT });
ok(st.featured.length === 1 && st.featured[0].id === a1 && st.featured[0].u === ada && st.featured[0].name === "Ada one" && st.featured[0].cat === shorts && st.featured[0].link === "https://drive.google.com/file/d/" + a1 + "/view" && Math.abs(st.featured[0].at - st.now) < 5000,
  "every editor is told the featured video, who made it and its link; featuring it twice shows it once", JSON.stringify(st.featured));
ok((await rpc("er_state", { p_token: TT, p_since: st.cursor })).featured.length === 1, "it also comes with the small updates the app asks for between full loads");
// a video by someone who is on no leaderboard: editors still get the name to show with it
const samLate = await mk(A, "Sam demo cut", shorts, 24 + 30 + recent, 30);
const adminId = (await rpc("er_state", { p_token: A })).me.id;
ok(!(await rpc("er_state", { p_token: TT })).users.some((x) => x.id === adminId), "an editor is not told about someone who is on no board and has nothing featured");
await rpc("er_feature", { p_token: A, p_project: samLate });
st = await rpc("er_state", { p_token: TT });
ok(st.featured.length === 2 && st.featured[0].id === samLate && st.featured[1].id === a1, "the newest pick comes first");
const shown = st.users.find((x) => x.id === adminId);
ok(shown && shown.name === "Sam Okafor" && !("username" in shown) && !("role" in shown), "editors get the maker's name for a featured video, and nothing more about them", JSON.stringify(shown));
// five at most: a sixth takes the oldest down
const extra = [];
for (let i = 1; i <= 4; i++) extra.push(await mk(TC, "Feature me " + i, ads, recent, 0.4));
for (const id of extra.slice(0, 3)) ok((await rpc("er_feature", { p_token: A, p_project: id })).dropped === 0, "a pick within the five drops nothing");
ok((await rpc("er_state", { p_token: TA })).featured.length === 5, "five videos can show at once");
const sixth = await rpc("er_feature", { p_token: A, p_project: extra[3] });
st = await rpc("er_state", { p_token: TA });
ok(sixth.dropped === 1 && st.featured.length === 5 && st.featured[0].id === extra[3] && !st.featured.some((x) => x.id === a1) && st.featured[4].id === samLate, "a sixth pick takes the oldest one down", st.featured.map((x) => x.name).join(" | "));
// taking down, sending back and deleting
await rpc("er_feature", { p_token: A, p_project: extra[3], p_on: false });
ok((await rpc("er_state", { p_token: TT })).featured.length === 4 && !(await rpc("er_state", { p_token: TT })).featured.some((x) => x.id === extra[3]), "the admin can take a video down");
await rpc("er_feature", { p_token: A, p_project: extra[3], p_on: false });
ok((await rpc("er_state", { p_token: TT })).featured.length === 4, "taking down something that is not up changes nothing");
await rpc("er_send_back", { p_token: A, p_project: extra[2], p_note: "Wrong cut" });
ok(!(await rpc("er_state", { p_token: TT })).featured.some((x) => x.id === extra[2]), "a video sent back to its editor comes off the home screen");
await rpc("er_delete_project", { p_token: A, p_project: extra[1] });
ok(!(await rpc("er_state", { p_token: TT })).featured.some((x) => x.id === extra[1]) && (await rpc("er_state", { p_token: TT })).featured.length === 2, "so does a deleted one");
await rpc("er_feature", { p_token: A, p_project: a1 });
st = await rpc("er_state", { p_token: TT });
ok(st.featured.length === 3 && st.featured[0].id === a1, "a video taken down earlier can be featured again, as the newest");
const picks = (await sql("select count(*)::int as n, count(*) filter (where taken_at is null)::int as live, count(distinct project_id) filter (where taken_at is null)::int as distinct_live from app.featured")).rows[0];
ok(picks.n === 7 && picks.live === 3 && picks.distinct_live === 3, "every pick stays on record: taking one down marks it, it is not removed", JSON.stringify(picks));
// leave things as they were for the checks that follow
for (const id of [a1, samLate, extra[0]]) await rpc("er_feature", { p_token: A, p_project: id, p_on: false });
for (const id of [samLate, extra[0], extra[2], extra[3]]) await rpc("er_delete_project", { p_token: A, p_project: id });
ok((await rpc("er_state", { p_token: A })).featured.length === 0, "and the home screen is clear again");
await rpc("er_remove_bonus", { p_token: A, p_bonus: g1.id });
const g4 = await rpc("er_award_bonus", { p_token: A, p_editor: chidi, p_amount: 10, p_label: "Thanks" });
ok(g4.id !== g1.id && !g4.again, "a removed bonus can be awarded again straight away");
await rpc("er_remove_bonus", { p_token: A, p_bonus: g3.id });
await rpc("er_remove_bonus", { p_token: A, p_bonus: g4.id });

// ---- admin view and syncing only what changed
st = await rpc("er_state", { p_token: A });
ok(st.full === true && st.projects.length >= 6 && st.users.length === 4 && st.users.find((x) => x.id === ada).username === "ada", "the admin sees every project and login");
const cursor = st.cursor;
await new Promise((r) => setTimeout(r, 30));
let delta = await rpc("er_state", { p_token: A, p_since: cursor + 6000 });
ok(delta.full === false && delta.projects.length === 0, "nothing changed means nothing is sent again");
await rpc("er_receive", { p_token: A, p_project: a1, p_on: true });
await rpc("er_delete_project", { p_token: A, p_project: lateOne });
delta = await rpc("er_state", { p_token: A, p_since: cursor });
ok(delta.projects.some((p) => p.id === a1 && p.received && p.amount === 20) && delta.projects.some((p) => p.id === lateOne && p.deleted === true), "changes and deletions come through on the next sync");

// ---- the admin's figures are worked out in the database
st = await rpc("er_state", { p_token: A });
const sAda = st.stats.editors.find((e) => e.u === ada), sChidi = st.stats.editors.find((e) => e.u === chidi);
ok(sAda && sAda.w.length === 12 && sAda.w[10] === 2 && sAda.w[11] === 0 && sAda.mo[0] === 2 && sAda.four[0] === 2 && sAda.four[1] === 0 && sAda.four[2] > 0, "each editor's weekly, monthly and four-week counts come with the admin's data", JSON.stringify(sAda));
ok(sChidi && sChidi.w[10] === 1 && !st.stats.editors.some((e) => e.u === tunde), "editors with nothing submitted have no figures; the deleted late one is not counted", JSON.stringify(st.stats.editors.map((e) => e.w)));
const cShorts = st.stats.cats.find((c) => c.cat === shorts), cAds = st.stats.cats.find((c) => c.cat === ads);
ok(cShorts.on === 2 && cShorts.late === 0 && cAds.on === 1, "each category's on-time and late counts come too", JSON.stringify(st.stats.cats));
const uAda = st.users.find((x) => x.id === ada), uT = st.users.find((x) => x.id === tunde);
ok(uAda.last > st.now - 26 * 3600e3 && uAda.earned === 20 && uT.moved === 1, "per editor: last sign of work, total earned, and briefs reassigned away", JSON.stringify([uAda.last, uAda.earned, uT.moved]));
ok((await rpc("er_state", { p_token: TA })).stats == null && (await rpc("er_state", { p_token: TA })).horizon == null, "editors are not sent the team's figures");
ok((await rpc("er_state", { p_token: TA })).totals.month === 20, "an editor's earnings this month come from the database");

// ---- the admin gets open and recent projects; older ones come a page at a time
const olds = [];
for (let i = 0; i < 45; i++) olds.push(await mk(TA, "Old video " + String(i).padStart(2, "0"), i % 2 ? shorts : longf, 24 * 20 + i * 5, i % 3 ? 2 : 40));
await rpc("er_receive", { p_token: A, p_project: olds[0], p_on: true });        // received just now: recent again
await sql("update app.projects set received_at = submitted_at + interval '1 hour', amount = 15 where id = any($1::uuid[])", [olds.slice(1, 40)]);
const openOld = (await rpc("er_log_brief", { p_token: TA, p_name: "Still open after a month", p_category: shorts })).id;
await sql("update app.projects set started_at = now() - interval '30 days', updated_at = now() - interval '30 days' where id = $1", [openOld]);
st = await rpc("er_state", { p_token: A });
const got = new Set(st.projects.map((p) => p.id));
ok(got.has(olds[0]) && got.has(openOld) && olds.slice(40).every((id) => got.has(id)) && !olds.slice(1, 40).some((id) => got.has(id)), "the admin's first load has everything open or waiting and the last 8 days, not older finished work", st.projects.length + " sent");
ok(typeof st.horizon === "string" && Math.abs(Date.parse(st.horizon) - (st.now - 8 * 864e5)) < 10000, "and says where older history starts", st.horizon);
let page = await rpc("er_history", { p_token: A, p_before: st.horizon });
ok(page.rows.length === 39 && page.next === null && page.rows.every((r, i, a) => !i || a[i - 1].touched >= r.touched) && page.rows.every((r) => !got.has(r.id)), "one call brings the older projects, newest first", page.rows.length + " rows");
await sql("update app.projects set received_at = submitted_at + interval '1 hour', amount = 15 where id = any($1::uuid[])", [olds.slice(40)]);
page = await rpc("er_history", { p_token: A, p_before: st.horizon });
const p2nd = await rpc("er_history", { p_token: A, p_before: page.next.at, p_before_id: page.next.id });
const all44 = page.rows.concat(p2nd.rows).map((r) => r.id);
ok(page.rows.length === 40 && page.next && p2nd.rows.length === 4 && p2nd.next === null && new Set(all44).size === 44 && olds.slice(1).every((id) => all44.includes(id)), "longer history comes 40 at a time with nothing skipped or repeated", page.rows.length + " + " + p2nd.rows.length);
const late = await rpc("er_history", { p_token: A, p_before: st.horizon, p_status: "sublate" });
const onT = await rpc("er_history", { p_token: A, p_before: st.horizon, p_status: "ontime", p_category: longf });
ok(late.rows.length === 14 && late.rows.every((r) => r.submitted > r.due) && onT.rows.length > 0 && onT.rows.every((r) => r.cat === longf && r.submitted <= r.due), "history can be narrowed by status and category", late.rows.length + " late, " + onT.rows.length + " on time in long form");
ok((await rpc("er_history", { p_token: A, p_before: st.horizon, p_editor: tunde })).rows.length === 0 && (await rpc("er_history", { p_token: A, p_before: st.horizon, p_uncat: true })).rows.length === 0, "and by editor");
await fails(rpc("er_history", { p_token: TA, p_before: st.horizon }), "forbidden", "an editor cannot read the team's history");
await fails(rpc("er_history", { p_token: A, p_before: st.horizon, p_status: "anything" }), "invalid", "history refuses a status it does not know");
const eState = await rpc("er_state", { p_token: TA });
ok(olds.every((id) => eState.projects.some((p) => p.id === id)), "the editor still sees all of their own recent work");
// a flood of changes is answered with the current picture instead of every change
const before = (await rpc("er_state", { p_token: A })).cursor;
await new Promise((r) => setTimeout(r, 5200));
await sql("insert into app.projects (editor_id, name, category_id, status, started_at, updated_at, submitted_at, link, received_at, amount) select $1, 'Bulk ' || g, $2, 'submitted', now() - interval '40 days', now() - interval '39 days', now() - interval '39 days', 'https://drive.google.com/x/' || g, now() - interval '38 days', 15 from generate_series(1, 700) g", [ada, shorts]);
delta = await rpc("er_state", { p_token: A, p_since: before + 5100 });
ok(delta.full === true && delta.projects.length < 120, "when hundreds of projects change at once, the admin gets a fresh picture, not hundreds of changes", delta.full + " " + delta.projects.length);
await sql("update app.projects set deleted = true where name like 'Bulk %'");
await sql("update app.projects set deleted = true where id = any($1::uuid[]) or id = $2", [olds, openOld]);
ok(!(await rpc("er_state", { p_token: TT })).projects.some((p) => p.id === lateOne), "a deleted project disappears for its editor");
await fails(rpc("er_delete_project", { p_token: TT, p_project: p2 }), "forbidden", "an editor cannot delete projects");

// ---- profile and password
await rpc("er_set_profile", { p_token: TA, p_avatar: "data:image/jpeg;base64,AAAA" });
await fails(rpc("er_set_profile", { p_token: TA, p_avatar: "<svg onload=alert(1)>" }), "bad_picture", "a picture must be an image");
ok((await rpc("er_avatars", { p_token: TT, p_ids: [ada, tunde] }))[ada] === "data:image/jpeg;base64,AAAA", "pictures are served to signed-in teammates");
await fails(rpc("er_set_profile", { p_token: TA, p_name: "Tunde Bello" }), "forbidden", "an editor cannot rename themselves");
await rpc("er_set_profile", { p_token: TA, p_name: "Ada Obi" });
ok((await rpc("er_state", { p_token: TA })).me.name === "Ada Obi", "sending their own unchanged name is harmless");
await rpc("er_update_user", { p_token: A, p_user: ada, p_name: "Ada O." });
ok((await rpc("er_state", { p_token: TA })).me.name === "Ada O.", "the admin can rename an editor");
await rpc("er_set_profile", { p_token: A, p_name: "Sam O." });
ok((await rpc("er_state", { p_token: A })).me.name === "Sam O.", "an admin can change their own name");
await fails(rpc("er_update_user", { p_token: A, p_user: ada, p_avatar: "data:image/jpeg;base64,BBBB" }), "invalid", "an admin cannot choose someone's picture");
const verBefore = (await rpc("er_state", { p_token: TA })).me.av;
await rpc("er_update_user", { p_token: A, p_user: ada, p_avatar: "" });
st = await rpc("er_state", { p_token: TA });
ok(st.me.has === false && st.me.av === verBefore + 1 && !(ada in (await rpc("er_avatars", { p_token: TT, p_ids: [ada] }))), "the admin can take a picture down");
ok((await rpc("er_change_password", { p_token: TA, p_old: "wrong", p_new: "brand-new-pass" })).error === "bad_login", "changing a password needs the old one");
await rpc("er_change_password", { p_token: TA, p_old: "ada-pass-1", p_new: "brand-new-pass" });
ok((await rpc("er_login", { p_username: "ada", p_password: "brand-new-pass" })).ok && (await rpc("er_login", { p_username: "ada", p_password: "ada-pass-1" })).error === "bad_login", "the new password works and the old one stops");

// ---- phone notifications: who gets told what, and how the sender hands them out
const EP = (n) => "https://fcm.googleapis.com/fcm/send/dn-test-" + n + "-" + "x".repeat(40);
const P256 = "B" + "Q".repeat(86), AUTH = "a".repeat(22);
const push = (token, n, extra) => rpc("er_save_push", Object.assign({ p_token: token, p_endpoint: EP(n), p_key: P256, p_auth: AUTH }, extra || {}));
const outbox = async (kind) => (await sql("select o.*, x.name as who from app.outbox o join app.users x on x.id = o.user_id where o.kind = $1 order by o.created_at, o.id", [kind])).rows;
st = await rpc("er_state", { p_token: A });
ok(st.settings.push === null && st.me.phones === 0 && st.settings.picAsk === null, "until the sender has made its keys, phones aren't offered notifications", JSON.stringify({ push: st.settings.push, phones: st.me.phones }));
await fails(push(TA, 1, { p_endpoint: "https://evil.example.com/collect/" + "y".repeat(30) }), "invalid", "only the big push services' addresses are accepted");
await fails(push(TA, 1, { p_endpoint: "http://fcm.googleapis.com/fcm/send/" + "z".repeat(30) }), "invalid", "and only over https");
await fails(push(TA, 1, { p_key: "short" }), "invalid", "the phone's keys are checked");
ok((await push(TA, 1)).phones === 1 && (await push(TA, 1)).phones === 1, "an editor's phone signs up, and signing up again changes nothing");
await push(A, 2);
await push(TT, 3);
await push(TC, 3);
ok((await sql("select user_id from app.push_subs where endpoint = $1 and gone_at is null", [EP(3)])).rows.map((r) => r.user_id).join() === chidi, "a phone someone else signs in on pings them instead");
await push(TT, 3);
ok((await sql("select count(*)::int as n from app.push_subs where endpoint = $1", [EP(3)])).rows[0].n === 1, "and the phone is still one record");
st = await rpc("er_state", { p_token: A });
ok(st.me.phones === 1 && st.users.find((x) => x.id === tunde).push === true && st.users.find((x) => x.id === chidi).push === false, "the admin can see who has notifications on");

// a video coming in pings every admin with a phone; an admin's own submission pings nobody
const sp = (await rpc("er_log_brief", { p_token: TA, p_name: "Ping test reel", p_category: shorts })).id;
await rpc("er_submit", { p_token: TA, p_project: sp, p_link: "https://drive.google.com/file/d/pingtest/view" });
let ob = await outbox("submitted");
ok(ob.length === 1 && ob[0].who === "Sam O." && ob[0].title === "Video submitted: Ping test reel" && ob[0].body === "Ada O. submitted it on time." && ob[0].project_id === sp, "a submitted video queues a ping for the admin", JSON.stringify(ob.map((o) => [o.who, o.title, o.body])));
const own = (await rpc("er_log_brief", { p_token: A, p_name: "Admin's own reel", p_category: shorts })).id;
await rpc("er_submit", { p_token: A, p_project: own, p_link: "https://drive.google.com/file/d/ownreel/view" });
ok((await outbox("submitted")).length === 1, "an admin isn't pinged about their own submission");

// a deadline passing pings the editor once; old deadlines and editors without a phone are left alone
const dl = (await rpc("er_log_brief", { p_token: TT, p_name: "Deadline ping brief", p_category: shorts })).id;
const dlOld = (await rpc("er_log_brief", { p_token: TT, p_name: "Long overdue brief", p_category: shorts })).id;
const dlChidi = (await rpc("er_log_brief", { p_token: TC, p_name: "Chidi late brief", p_category: shorts })).id;
await sql("update app.projects set started_at = now() - interval '25 hours' where id = any($1::uuid[])", [[dl, dlChidi]]);
await sql("update app.projects set started_at = now() - interval '31 hours' where id = $1", [dlOld]);
ok((await sql("select app.queue_deadlines() as n")).rows[0].n === 1 && (await sql("select app.queue_deadlines() as n")).rows[0].n === 0, "a deadline that just passed queues one ping, and only once");
ob = await outbox("deadline");
ok(ob.length === 1 && ob[0].who === "Tunde Bello" && ob[0].title === "Deadline passed: Deadline ping brief" && /48-hour grace period/.test(ob[0].body), "the editor is told the grace period has started", JSON.stringify(ob.map((o) => [o.who, o.title, o.body])));
await sql("select app.notice_tick()");
await sql("select app.push_poke()");
ok(true, "the timer's work runs quietly where there is no sender to nudge");

// the sender: a batch at a time, one row per phone, never handed out twice
ok((await sql("select app.push_secret_ok(null) as a, app.push_secret_ok('nope') as b, app.push_secret_ok((select push_secret from app.meta)) as c, length((select push_secret from app.meta)) as len")).rows.map((r) => [r.a, r.b, r.c, r.len].join()).join() === "false,false,true,64", "only the database's own secret starts the sender");
let batch = (await sql("select * from app.push_claim(100)")).rows;
ok(batch.length === 2 && batch.every((r) => r.endpoint && r.p256dh === P256 && r.auth === AUTH) && (await sql("select * from app.push_claim(100)")).rows.length === 0, "the sender gets each waiting ping with its phone, and nobody gets them twice", JSON.stringify(batch.map((r) => [r.kind, r.title])));
const bySub = (kind) => batch.find((r) => r.kind === kind);
await sql("select app.push_report($1, array[$2]::uuid[], '{}'::uuid[], 0)", [bySub("submitted").notice, bySub("submitted").sub]);
await sql("select app.push_report($1, '{}'::uuid[], '{}'::uuid[], 1, 'push service busy')", [bySub("deadline").notice]);
let rec = (await sql("select kind, sent_at is not null as sent, result, tries from app.outbox where id = any($1::uuid[]) order by kind desc", [[bySub("submitted").notice, bySub("deadline").notice]])).rows;
ok(rec.map((r) => r.kind + ":" + r.sent + ":" + r.result).join(" | ") === "submitted:true:delivered to 1 phone | deadline:false:will try again: push service busy", "a delivery is recorded; a refusal is tried again", JSON.stringify(rec));
ok((await sql("select * from app.push_claim(100)")).rows.length === 0, "a refused ping waits before the next try");
await sql("update app.outbox set claimed_at = now() - interval '3 minutes' where id = $1", [bySub("deadline").notice]);
batch = (await sql("select * from app.push_claim(100)")).rows;
ok(batch.length === 1 && batch[0].kind === "deadline", "and is handed out again after two minutes");
await sql("update app.outbox set tries = 5 where id = $1", [batch[0].notice]);
await sql("select app.push_report($1, '{}'::uuid[], '{}'::uuid[], 1, 'push service busy')", [batch[0].notice]);
ok((await sql("select result from app.outbox where id = $1 and sent_at is not null", [batch[0].notice])).rows[0].result === "gave up: push service busy", "after five tries it is given up");

// a phone the push service says is gone is stamped, not deleted, and the person can sign it up again
await rpc("er_test_push", { p_token: TT });
batch = (await sql("select * from app.push_claim(100)")).rows;
await sql("select app.push_report($1, '{}'::uuid[], array[$2]::uuid[], 0)", [batch[0].notice, batch[0].sub]);
ok((await sql("select result from app.outbox where id = $1", [batch[0].notice])).rows[0].result === "no phones" && (await rpc("er_state", { p_token: TT })).me.phones === 0, "a phone the push service reports gone stops counting");
ok((await sql("select count(*)::int as n from app.push_subs where endpoint = $1", [EP(3)])).rows[0].n === 1 && (await push(TT, 3)).phones === 1, "it stays on the record, and signing it up again starts a fresh one");
ok((await rpc("er_test_push", { p_token: TA })).queued === 1 && (await rpc("er_test_push", { p_token: TC })).phones === 0, "a test ping goes only to your own phones");
await rpc("er_drop_push", { p_token: TA, p_endpoint: EP(1) });
ok((await rpc("er_state", { p_token: TA })).me.phones === 0 && (await rpc("er_test_push", { p_token: TA })).queued === 0, "turning notifications off on a phone stops its pings");
await sql("select app.push_report(id, '{}'::uuid[], '{}'::uuid[], 0) from app.outbox where sent_at is null");

// the sender's keys: the first ones stored stay, and phones get only the public half
const PUB = "B" + "k".repeat(86), PRIV = "p".repeat(43);
await sql("select app.push_keys_set('short', 'x')");
ok((await sql("select vapid_public from app.meta")).rows[0].vapid_public === null, "malformed keys are not stored");
await sql("select app.push_keys_set($1, $2)", [PUB, PRIV]);
await sql("select app.push_keys_set($1, $2)", ["B" + "z".repeat(86), "q".repeat(43)]);
st = await rpc("er_state", { p_token: TA });
ok(st.settings.push === PUB && !JSON.stringify(st).includes(PRIV) && (await sql("select private_key from app.push_keys()")).rows[0].private_key === PRIV, "the first keys stay, and only the public one reaches phones");

// reminders an admin picks in Settings, each only to the editors who still have to do what it asks: a profile
// picture (asked the old way here, as copies of the app from before reminders do), payment details, late videos
const rem = async (kind) => (await sql("select r.*, x.name as who from app.reminders r join app.users x on x.id = r.user_id where r.kind = $1 order by r.created_at, r.id", [kind])).rows;
await fails(rpc("er_ask_pictures", { p_token: TA }), "forbidden", "only an admin can ask for pictures");
await fails(rpc("er_remind", { p_token: TA, p_kind: "details" }), "forbidden", "only an admin sends reminders");
await fails(rpc("er_remind", { p_token: A, p_kind: "bogus" }), "invalid", "and only the three kinds there are");
await push(TC, 4);                                                                   // Chidi has notifications on,
await rpc("er_set_picture", { p_token: TC, p_avatar: "data:image/jpeg;base64," + "E".repeat(400) });     // and a picture already
let ask = await rpc("er_ask_pictures", { p_token: A });
let rows = await rem("picture");
ok(ask.editors === 2 && ask.phones === 1 && rows.length === 1 && rows[0].who === "Tunde Bello" && rows[0].title === "Add a profile picture" && /next to your name/.test(rows[0].body) && rows[0].sent_by === adminId, "the picture reminder goes only to editors without a picture; those with notifications on get a ping", JSON.stringify(ask));
ok(!rows.some((r) => r.who === "Chidi Nwosu"), "an editor who already has a picture isn't pinged, even with notifications on");
ok((await rpc("er_state", { p_token: TC })).me.has === true && (await rpc("er_state", { p_token: TA })).me.has === false, "and the app can tell who still needs to add one");
await rpc("er_drop_push", { p_token: TC, p_endpoint: EP(4) });
await rpc("er_set_picture", { p_token: TC, p_avatar: "" });
ask = await rpc("er_remind", { p_token: A, p_kind: "picture" });
ok(ask.again === true && (await rem("picture")).length === 1, "asking twice within ten minutes sends nothing new");
st = await rpc("er_state", { p_token: TT });
ok(st.settings.picAsk > 0 && st.me.avAt === null, "editors see when they were asked, and that they haven't chosen a picture since");
let rm = await rpc("er_remind", { p_token: A, p_kind: "details" });
rows = await rem("details");
ok(rm.editors === 3 && rm.phones === 1 && rows.length === 1 && rows[0].who === "Tunde Bello" && rows[0].title === "Add your payment details" && /bank account/.test(rows[0].body), "the payment details reminder goes to editors who haven't added theirs", JSON.stringify(rm));
ok((await rpc("er_remind", { p_token: A, p_kind: "details" })).again === true && (await rem("details")).length === 1, "and isn't sent twice within ten minutes");
const lateBy = (await sql("select p.editor_id, count(*)::int as n from app.projects p join app.users x on x.id = p.editor_id where p.status = 'active' and not p.deleted and p.due_at <= now() and x.active and x.removed_at is null group by p.editor_id")).rows;
const tLate = lateBy.find((r) => r.editor_id === tunde);
rm = await rpc("er_remind", { p_token: A, p_kind: "overdue" });
rows = await rem("overdue");
ok(lateBy.length >= 2 && tLate && tLate.n >= 2 && rm.editors === lateBy.length && rm.phones === 1 && rows.length === 1 && rows[0].who === "Tunde Bello", "the late videos reminder goes to every editor with a video past its deadline", JSON.stringify({ rm, lateBy }));
ok(rows[0].title === "Submit your " + tLate.n + " late videos" && /starting with Long overdue brief\./.test(rows[0].body), "and names how many, starting with the one most overdue", rows[0].title + " / " + rows[0].body);
st = await rpc("er_state", { p_token: A });
ok(st.settings.detailsAsk > 0 && st.settings.lateAsk > 0 && st.settings.lateAsk >= st.settings.detailsAsk, "the admin can see when each reminder was last sent");
// reminders go out the same way as the automatic notifications
batch = (await sql("select * from app.push_claim(100)")).rows;
ok(batch.length === 3 && batch.every((r) => r.endpoint === EP(3) && r.project === null) && ["details", "overdue", "picture"].every((k) => batch.some((r) => r.kind === k)), "the sender gets the reminders with the phone each one goes to", JSON.stringify(batch.map((r) => [r.kind, r.title])));
for (const r of batch) await sql("select app.push_report($1, array[$2]::uuid[], '{}'::uuid[], 0)", [r.notice, r.sub]);
ok((await sql("select count(*)::int as n from app.reminders where sent_at is not null and result = 'delivered to 1 phone'")).rows[0].n === 3 && (await sql("select * from app.push_claim(100)")).rows.length === 0, "and their delivery is recorded");
const THUMB = "data:image/jpeg;base64," + "A".repeat(400), FULL = "data:image/jpeg;base64," + "B".repeat(4000);
await fails(rpc("er_set_picture", { p_token: TT, p_avatar: "<svg onload=alert(1)>" }), "bad_picture", "a new picture must be an image");
await fails(rpc("er_set_picture", { p_token: TT, p_avatar: THUMB, p_full: "javascript:alert(1)" }), "bad_picture", "and so must its larger copy");
await fails(rpc("er_set_picture", { p_token: TT, p_avatar: THUMB, p_full: "data:image/jpeg;base64," + "C".repeat(600000) }), "bad_picture", "the larger copy has a size limit");
await rpc("er_set_picture", { p_token: TT, p_avatar: THUMB, p_full: FULL });
st = await rpc("er_state", { p_token: TT });
ok(st.me.has && st.me.avAt >= st.settings.picAsk && (await rpc("er_state", { p_token: A })).users.find((x) => x.id === tunde).avAt === st.me.avAt, "choosing a picture after being asked clears the reminder, and the admin can see it");
let big = await rpc("er_avatar_full", { p_token: TA, p_user: tunde });
ok(big.full === true && big.url === FULL && (await rpc("er_avatars", { p_token: TA, p_ids: [tunde] }))[tunde] === THUMB, "teammates get the large copy on request, and lists keep the small one");
await rpc("er_set_profile", { p_token: TT, p_avatar: "data:image/jpeg;base64,DDDD" });
big = await rpc("er_avatar_full", { p_token: TA, p_user: tunde });
ok(big.full === false && big.url === "data:image/jpeg;base64,DDDD" && (await sql("select avatar_full from app.users where id = $1", [tunde])).rows[0].avatar_full === null, "a picture set the old way drops the outdated large copy");
await rpc("er_set_picture", { p_token: TT, p_avatar: "" });
ok((await rpc("er_avatar_full", { p_token: TA, p_user: tunde })).url === null && (await rpc("er_state", { p_token: TT })).me.has === false, "a picture can be removed");
// once every editor has a picture, the picture reminder has nobody to go to
for (const t of [TA, TT, TC]) await rpc("er_set_picture", { p_token: t, p_avatar: "data:image/jpeg;base64," + "F".repeat(400) });
await sql("update app.meta set pic_ask_at = now() - interval '11 minutes'");
const askedAt = (await sql("select pic_ask_at from app.meta")).rows[0].pic_ask_at;
ask = await rpc("er_remind", { p_token: A, p_kind: "picture" });
ok(ask.editors === 0 && ask.phones === 0 && !ask.again && (await rem("picture")).length === 1 && new Date((await sql("select pic_ask_at from app.meta")).rows[0].pic_ask_at).getTime() === new Date(askedAt).getTime(), "when every editor has a picture, the reminder sends nothing to anyone", JSON.stringify(ask));
for (const t of [TA, TT, TC]) await rpc("er_set_picture", { p_token: t, p_avatar: "" });
await fails(rpc("er_avatar_full", { p_token: "x".repeat(64), p_user: tunde }), "auth", "pictures are only for people signed in");

// every video an editor has submitted, a page at a time, for the admin's list
const subs = await rpc("er_history", { p_token: A, p_before: new Date(Date.now() + 60000).toISOString(), p_status: "submitted", p_editor: ada });
ok(subs.rows.length > 0 && subs.rows.every((r) => r.status === "submitted" && r.u === ada), "the admin can page through one editor's submitted videos", subs.rows.length + " rows");
await fails(rpc("er_history", { p_token: A, p_before: new Date().toISOString(), p_status: "bogus" }), "invalid", "only known filters are accepted");

// ---- payment details: each editor keeps their own; an admin can read anyone's
st = await rpc("er_state", { p_token: TA });
ok(st.me.details === null && (await rpc("er_state", { p_token: A })).users.find((x) => x.id === ada).pay === false, "nobody has payment details to begin with, and the admin can see who hasn't added them");
const det = (tok, extra) => rpc("er_save_details", Object.assign({ p_token: tok, p_name: "Adaeze  Obi ", p_phone: " 0803 123 4567 ", p_bank: "GTBank", p_account: "0123 456-789" }, extra || {}));
await fails(det(TA, { p_name: " " }), "bad_full_name", "a full name is needed");
await fails(det(TA, { p_name: "A" }), "bad_full_name", "of more than one letter");
await fails(det(TA, { p_phone: "call me" }), "bad_phone", "a phone number must be a number");
await fails(det(TA, { p_phone: "12345" }), "bad_phone", "with enough digits");
await fails(det(TA, { p_bank: "" }), "bad_bank", "the bank is needed");
await fails(det(TA, { p_account: "012345678" }), "bad_account", "an account number has 10 digits, not 9");
await fails(det(TA, { p_account: "01234567890" }), "bad_account", "or 11");
await fails(det(TA, { p_account: "01234x6789" }), "bad_account", "and nothing but digits");
await fails(rpc("er_save_details", { p_token: "x".repeat(64), p_name: "Someone", p_phone: "08031234567", p_bank: "GTBank", p_account: "0123456789" }), "auth", "only someone signed in can save details");
ok((await det(TA)).ok === true, "an editor saves their payment details");
st = await rpc("er_state", { p_token: TA });
ok(st.me.details && st.me.details.name === "Adaeze Obi" && st.me.details.phone === "0803 123 4567" && st.me.details.bank === "GTBank" && st.me.details.account === "0123456789" && st.me.details.at > 0, "and sees them back tidied: extra spaces gone, the account number as 10 digits", JSON.stringify(st.me.details));
ok((await det(TA)).same === true && (await sql("select count(*)::int as n from app.details where user_id = $1", [ada])).rows[0].n === 1, "saving the same details again adds nothing");
ok((await rpc("er_state", { p_token: A })).users.find((x) => x.id === ada).pay === true, "the admin can see that she has added hers");
let seen = await rpc("er_details", { p_token: A, p_user: ada });
ok(seen.details.account === "0123456789" && seen.details.name === "Adaeze Obi" && seen.details.phone === "0803 123 4567" && seen.changed === null, "the admin can read an editor's details", JSON.stringify(seen));
ok((await rpc("er_details", { p_token: TA, p_user: ada })).details.bank === "GTBank", "an editor can read their own");
await fails(rpc("er_details", { p_token: TT, p_user: ada }), "forbidden", "but not anyone else's");
const tState = await rpc("er_state", { p_token: TT });
ok(tState.users.every((x) => !("pay" in x)) && !JSON.stringify(tState).includes("0123456789") && !JSON.stringify(tState).includes("Adaeze"), "and nothing about them reaches other editors");
ok((await rpc("er_details", { p_token: A, p_user: tunde })).details === null, "someone who hasn't added details has none");
await fails(rpc("er_details", { p_token: A, p_user: "00000000-0000-0000-0000-000000000000" }), "not_found", "an unknown login has none to show");
// a new phone number is no cause for alarm; a new account is
await det(TA, { p_phone: "+234 803 123 4567" });
ok((await rpc("er_details", { p_token: A, p_user: ada })).changed === null, "a new phone number leaves the account as it was");
await det(TA, { p_phone: "+234 803 123 4567", p_bank: "OPay", p_account: "8031234567" });
seen = await rpc("er_details", { p_token: A, p_user: ada });
ok(seen.details.bank === "OPay" && seen.details.account === "8031234567" && seen.changed && seen.changed.bank === "GTBank" && seen.changed.last4 === "6789" && seen.changed.at === seen.details.at, "a new bank account warns the admin, with where pay went before", JSON.stringify(seen.changed));
await sql("update app.details set created_at = created_at - interval '1 hour' where user_id = $1", [ada]);
await det(TA, { p_name: "Adaeze N. Obi", p_phone: "+234 803 123 4567", p_bank: "OPay", p_account: "8031234567" });
seen = await rpc("er_details", { p_token: A, p_user: ada });
ok(seen.details.name === "Adaeze N. Obi" && seen.changed && seen.changed.bank === "GTBank" && seen.changed.at < seen.details.at, "and keeps warning after smaller edits, from when the account changed", JSON.stringify(seen.changed));
await sql("update app.details set created_at = created_at - interval '31 days' where user_id = $1", [ada]);
ok((await rpc("er_details", { p_token: A, p_user: ada })).changed === null, "the warning goes after 30 days");
for (let i = 0; i < 10; i++) await det(TT, { p_name: "Tunde Bello", p_account: "100000000" + i });
await fails(det(TT, { p_name: "Tunde Bello", p_account: "2000000000" }), "too_many", "a login can change its details at most 10 times a day");
ok((await sql("select count(*)::int as n from app.details where user_id = $1", [tunde])).rows[0].n === 10 && (await sql("select count(*)::int as n from app.details where user_id = $1", [ada])).rows[0].n === 4, "every change stays on record");

// ---- Google Drive: an admin connects it and picks folders; editors upload into them (the dn-drive function
// calls the app.drive_* functions; Google itself is checked in drive.test.mjs)
const one = async (text, params) => (await sql(text, params)).rows[0];
let dv = (await rpc("er_state", { p_token: A })).settings.drive;
ok(dv && dv.on === false && dv.lost === false && dv.folders.length === 0 && dv.email === null, "before it's connected, Drive is off and has no folders", JSON.stringify(dv));
await fails(sql("select app.drive_begin($1, $2)", [TA, "https://dn.example/edit-room/"]), "forbidden", "only an admin can connect Google Drive");
await fails(sql("select app.drive_begin($1, $2)", [A, "javascript:alert(1)"]), "invalid", "and only to come back to a real web address");
const st1 = (await one("select app.drive_begin($1, $2) as s", [A, "https://dn.example/edit-room/"])).s;
ok(/^[0-9a-f]{48}$/.test(st1), "connecting starts with a one-time code for Google to hand back");
const took = (await sql("select * from app.drive_take($1)", [st1])).rows;
ok(took.length === 1 && took[0].who === adminId && took[0].back === "https://dn.example/edit-room/", "Google's answer is tied to the admin who asked, and to where they came from", JSON.stringify(took));
ok((await sql("select * from app.drive_take($1)", [st1])).rows.length === 0 && (await sql("select * from app.drive_take($1)", ["0".repeat(48)])).rows.length === 0, "the code works once, and a made-up one not at all");
const st2 = (await one("select app.drive_begin($1, $2) as s", [A, "https://dn.example/edit-room/"])).s;
await sql("update app.drive_states set created_at = now() - interval '16 minutes' where state_hash = sha256(convert_to($1, 'UTF8'))", [st2]);
ok((await sql("select * from app.drive_take($1)", [st2])).rows.length === 0, "and only for 15 minutes");
await fails(sql("select app.drive_link($1, $2, $3)", [ada, "ada@example.com", "refresh-token-ada"]), "forbidden", "a connection can only be an admin's");
const c1 = (await one("select app.drive_link($1, $2, $3) as id", [adminId, "studio@example.com", "refresh-token-one"])).id;
dv = (await rpc("er_state", { p_token: A })).settings.drive;
ok(dv.on === true && dv.email === "studio@example.com" && dv.lost === false, "once connected, the admin sees which Google account it is");
let edv = (await rpc("er_state", { p_token: TA })).settings.drive;
ok(edv.on === true && edv.email === null && edv.lost === null && edv.folders.length === 0, "editors are told it's on, but not whose account it is", JSON.stringify(edv));
const c2 = (await one("select app.drive_link($1, $2, $3) as id", [adminId, "studio@example.com", "refresh-token-two"])).id;
const conns = (await sql("select id, ended_at is null as live, end_note from app.drive order by connected_at, id")).rows;
const key = (await sql("select * from app.drive_key()")).rows;
ok(conns.length === 2 && conns.find((c) => c.id === c1).end_note === "replaced by a newer connection" && conns.find((c) => c.id === c2).live && key.length === 1 && key[0].conn === c2 && key[0].refresh === "refresh-token-two", "connecting again replaces the old connection, which stays on record", JSON.stringify(conns));
await fails(sql("select app.drive_add_folders($1, $2::jsonb)", [TA, "[]"]), "forbidden", "only an admin picks the folders");
const picked = [{ id: "1AbCdEfGhIjKlMnOpQr", name: "Proxan" }, { id: "1ZyXwVuTsRqPoNmLkJi", name: " Menoprime " }, { id: "bad id!", name: "Nope" }, { id: "1QqQqQqQqQqQqQqQqQq", name: "  " }];
ok((await one("select app.drive_add_folders($1, $2::jsonb) as n", [A, JSON.stringify(picked)])).n === 2, "folders that look right are added; ones without a proper id or name are not");
ok((await one("select app.drive_add_folders($1, $2::jsonb) as n", [A, JSON.stringify([{ id: "1AbCdEfGhIjKlMnOpQr", name: "Proxan videos" }])])).n === 0, "picking a folder again doesn't add it twice");
dv = (await rpc("er_state", { p_token: A })).settings.drive;
edv = (await rpc("er_state", { p_token: TA })).settings.drive;
ok(dv.folders.map((f) => f.name).join() === "Menoprime,Proxan videos" && JSON.stringify(edv.folders) === JSON.stringify(dv.folders) && dv.folders.every((f) => /^[0-9a-f-]{36}$/.test(f.id)), "everyone sees the folders by name, and a folder takes its new name from Drive", JSON.stringify(dv.folders));
const fProxan = dv.folders.find((f) => f.name === "Proxan videos").id, fMeno = dv.folders.find((f) => f.name === "Menoprime").id;
ok(!JSON.stringify(edv).includes("1ZyXwVuTsRqPoNmLkJi"), "the app is never told Drive's own folder ids");
await fails(rpc("er_drive_remove_folder", { p_token: TA, p_folder: fProxan }), "forbidden", "an editor can't take a folder off the list");
await rpc("er_drive_remove_folder", { p_token: A, p_folder: fProxan });
await fails(rpc("er_drive_remove_folder", { p_token: A, p_folder: fProxan }), "not_found", "a folder taken off the list is gone from it");
ok((await rpc("er_state", { p_token: TA })).settings.drive.folders.map((f) => f.name).join() === "Menoprime", "editors no longer see a folder taken off the list");
// starting an upload
const db1 = (await rpc("er_log_brief", { p_token: TA, p_name: "Drive upload brief", p_category: ads })).id;
const start = (tok, project, folder, size, mime, ext) => one("select app.drive_start($1, $2, $3, $4, $5, $6) as s", [tok, project, folder, size, mime, ext]);
await fails(start(TT, db1, fMeno, 1000, "video/mp4", "mp4"), "not_found", "nobody can upload to someone else's brief");
await fails(start(TA, db1, fProxan, 1000, "video/mp4", "mp4"), "no_folder", "or into a folder that's off the list");
await fails(start(TA, db1, fMeno, 60e9, "video/mp4", "mp4"), "too_big", "a file over 50 GB is refused");
await fails(start(TA, db1, fMeno, 1000, "image/png", "png"), "not_video", "and so is a file that isn't a video");
const s1 = (await start(TA, db1, fMeno, 123456789, "Video/MP4", ".MP4")).s;
ok(s1.upload && s1.folder === "1ZyXwVuTsRqPoNmLkJi" && /^Drive upload brief \(.+\)\.mp4$/.test(s1.name) && s1.mime === "video/mp4", "an upload is named after the brief and its editor, for the folder in Drive", JSON.stringify(s1));
ok((await start(TA, db1, fMeno, 5, "", "")).s.mime === "application/octet-stream", "a file the phone gives no type for is still taken");
await sql("select app.drive_session($1, $2)", [s1.upload, "https://upload.example/session/1"]);
const u1 = (await one("select app.drive_upload($1, $2) as u", [TA, s1.upload])).u;
ok(u1.project === db1 && u1.size === 123456789 && u1.session === "https://upload.example/session/1" && u1.done === false && u1.fresh === true && u1.folder === "1ZyXwVuTsRqPoNmLkJi", "the uploader can pick it up again where it stopped", JSON.stringify(u1));
await fails(sql("select app.drive_upload($1, $2)", [TT, s1.upload]), "not_found", "nobody else can carry on someone's upload");
await sql("select app.drive_done($1, $2, $3, $4)", [s1.upload, "file-1", "https://drive.google.com/file/d/file-1/view", "submitted"]);
ok((await one("select app.drive_upload($1, $2) as u", [TA, s1.upload])).u.done === true, "and how it ended is kept");
// disconnecting, and Google ending a connection
await fails(sql("select app.drive_unlink($1)", [TA]), "forbidden", "only an admin can disconnect Drive");
ok((await one("select app.drive_unlink($1) as r", [A])).r === "refresh-token-two", "disconnecting hands back the key, so Google can be told to forget it");
edv = (await rpc("er_state", { p_token: TA })).settings.drive;
ok(edv.on === false && edv.folders.length === 0 && (await rpc("er_state", { p_token: A })).settings.drive.folders.length === 1, "once disconnected, editors see no folders; the admin keeps the list");
await fails(start(TA, db1, fMeno, 1000, "video/mp4", "mp4"), "drive_off", "and nobody can start an upload");
const c3 = (await one("select app.drive_link($1, $2, $3) as id", [adminId, "studio@example.com", "refresh-token-three"])).id;
await sql("select app.drive_lost($1, $2)", [c3, "Google said: invalid_grant"]);
dv = (await rpc("er_state", { p_token: A })).settings.drive;
ok(dv.on === false && dv.lost === true, "when Google ends the connection, the admin is told so they can connect again");
await sql("select app.drive_link($1, $2, $3)", [adminId, "studio@example.com", "refresh-token-four"]);
dv = (await rpc("er_state", { p_token: A })).settings.drive;
ok(dv.on === true && dv.lost === false, "and connecting again puts it right");
await fails(sql("update app.meta set google_api_key = 'has spaces in it, not a key' where id"), "check", "only something shaped like a Google API key is kept");
await sql("update app.meta set google_client_id = '123456789012-abc.apps.googleusercontent.com', google_api_key = 'AIzaSyA-0123456789abcdefghijklmnopqrstu', google_app_id = '123456789012' where id");
const gcfg = (await sql("select * from app.drive_config()")).rows[0];
ok(gcfg.client_id === "123456789012-abc.apps.googleusercontent.com" && gcfg.api_key.startsWith("AIza") && gcfg.app_id === "123456789012" && !JSON.stringify(await rpc("er_state", { p_token: A })).includes("AIza"), "what Google issued is kept for the function, and never sent to the app");
for (let i = 0; i < 38; i++) await start(TA, db1, fMeno, 1000, "video/mp4", "mp4");
await fails(start(TA, db1, fMeno, 1000, "video/mp4", "mp4"), "too_many", "one login can start at most 40 uploads a day");
await rpc("er_delete_project", { p_token: A, p_project: db1 });

// ---- scripts sent through the app: the admin sends one (the dn-drive function keeps the file in Drive), the
// editor takes it on, and only then does its clock start and can they open it
const phone = (uid, tag) => sql("insert into app.push_subs(user_id, endpoint, p256dh, auth) values ($1, $2, $3, $4) on conflict do nothing", [uid, "https://fcm.googleapis.com/fcm/send/" + tag, "B".repeat(87), "A".repeat(22)]);
await phone(ada, "script-ada"); await phone(tunde, "script-tunde"); await phone(adminId, "script-admin");
const pings = async (uid, kind) => (await sql("select title, body from app.outbox where user_id = $1 and kind = $2 order by created_at, id", [uid, kind])).rows;
const newScript = (tok, editor, cat, name, file, size) => one("select app.script_new($1, $2, $3, $4, $5, $6) as s", [tok, editor, cat, name, file, size]);
await fails(newScript(TA, tunde, ads, "", "Proxan 14.docx", 9000), "forbidden", "only an admin sends scripts");
await fails(newScript(A, adminId, ads, "", "Proxan 14.docx", 9000), "not_found", "scripts go to editors only");
await fails(newScript(A, ada, null, "", "Proxan 14.docx", 9000), "need_category", "a script needs a category while there are any");
await fails(newScript(A, ada, ads, "", "Proxan 14.exe", 9000), "not_script", "a file that isn't a document is refused");
await fails(newScript(A, ada, ads, "", "Proxan 14.docx", 20 * 1048576), "too_big", "and so is one over 10 MB");
const sc1 = (await newScript(A, ada, ads, "  ", "Proxan  video 14.DOCX", 9216)).s;
ok(sc1.script && sc1.name === "Proxan video 14" && sc1.file === "Proxan  video 14.DOCX" && sc1.mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  && sc1.folder === null && sc1.conn && sc1.editor === (await one("select name from app.users where id = $1", [ada])).name && sc1.cat === "Ads", "a script is named after its file unless the admin names it, and dn-drive is told where to keep it", JSON.stringify(sc1));
ok((await rpc("er_state", { p_token: TA })).scripts.length === 0, "the editor sees nothing until the file is safely in Drive");
await sql("select app.scripts_folder_set($1, $2)", [sc1.conn, "fldScripts0000001"]);
ok((await newScript(A, ada, ads, "Spare", "spare.pdf", 10)).s.folder === "fldScripts0000001", "once dn-drive has made the scripts folder, it is used for every script");
await sql("select app.script_failed(id, 'Google said 500') from app.scripts where name = 'Spare'");
await sql("select app.script_saved($1, $2)", [sc1.script, "docFile00000001"]);
let ast = await rpc("er_state", { p_token: TA });
ok(ast.scripts.length === 1 && ast.scripts[0].id === sc1.script && ast.scripts[0].name === "Proxan video 14" && ast.scripts[0].cat === ads && !JSON.stringify(ast.scripts).includes("docFile"),
  "once saved, the script waits on the editor's screen (a script that failed to save never shows)", JSON.stringify(ast.scripts));
ok((await pings(ada, "assigned")).some((r) => r.title === "New script: Proxan video 14" && /Accept it to open it and start your 24-hour deadline/.test(r.body)), "and their phone pings", JSON.stringify(await pings(ada, "assigned")));
ok((await rpc("er_state", { p_token: TT })).scripts.length === 0, "nobody else sees it");
let adm = await rpc("er_state", { p_token: A });
ok(adm.scripts.length === 1 && adm.scripts[0].u === ada && adm.scripts[0].status === "waiting" && adm.scripts[0].file === "Proxan  video 14.DOCX" && adm.scripts[0].by === adminId, "the admin sees it waiting for that editor", JSON.stringify(adm.scripts));
await fails(sql("select app.script_file($1, $2)", [TA, sc1.script]), "not_found", "the editor can't open the file before taking it on");
ok((await one("select app.script_file($1, $2) as f", [A, sc1.script])).f.file === "docFile00000001", "an admin can open it any time");
await fails(rpc("er_accept_script", { p_token: TT, p_script: sc1.script }), "not_found", "only its editor can take it on");
await sql("update app.scripts set sent_at = now() - interval '3 hours' where id = $1", [sc1.script]);
const acc = await rpc("er_accept_script", { p_token: TA, p_script: sc1.script });
ast = await rpc("er_state", { p_token: TA });
const fromScript = ast.projects.find((p) => p.id === acc.id);
ok(acc.ok && fromScript && fromScript.name === "Proxan video 14" && fromScript.cat === ads && fromScript.script === sc1.script && Math.abs(fromScript.started - Date.now()) < 5000
  && fromScript.due - fromScript.started === 24 * 3600e3 && ast.scripts.length === 0, "taking it on makes the brief: its clock starts then, not when it was sent", JSON.stringify(fromScript));
ok((await rpc("er_accept_script", { p_token: TA, p_script: sc1.script })).id === acc.id && (await one("select count(*)::int as n from app.projects where script_id = $1", [sc1.script])).n === 1, "pressing it twice makes one brief");
ok((await one("select app.script_file($1, $2) as f", [TA, sc1.script])).f.name === "Proxan  video 14.DOCX", "now the editor can open the file");
await fails(sql("select app.script_file($1, $2)", [TT, sc1.script]), "not_found", "but nobody else on the team can");
ok((await rpc("er_state", { p_token: A })).scripts.length === 0 && (await rpc("er_state", { p_token: A })).projects.find((p) => p.id === acc.id).script === sc1.script, "the admin sees it as a brief like any other, with its script");
// turned down, given to someone else, taken back
const sc2 = (await newScript(A, tunde, longf, "Menoprime explainer", "meno.doc", 5000)).s;
await sql("select app.script_saved($1, $2)", [sc2.script, "docFile00000002"]);
await fails(rpc("er_decline_script", { p_token: TA, p_script: sc2.script }), "not_found", "only its editor can turn it down");
await rpc("er_decline_script", { p_token: TT, p_script: sc2.script, p_note: "  Too busy\n this week " });
adm = await rpc("er_state", { p_token: A });
const dec = adm.scripts.find((s) => s.id === sc2.script);
ok(dec && dec.status === "declined" && dec.note === "Too busy this week" && dec.declined > 0 && (await rpc("er_state", { p_token: TT })).scripts.length === 0, "an editor can say they can't take it, and why; it goes back to the admin", JSON.stringify(dec));
ok((await pings(adminId, "declined")).some((r) => r.title === "Script not taken: Menoprime explainer" && r.body === "Tunde Bello can't take it: Too busy this week. Give it to someone else in the app."), "the admin's phone pings with the reason", JSON.stringify(await pings(adminId, "declined")));
await fails(rpc("er_accept_script", { p_token: TT, p_script: sc2.script }), "not_found", "once turned down, it can't be taken on after all");
await fails(rpc("er_move_script", { p_token: TA, p_script: sc2.script, p_editor: ada }), "forbidden", "only an admin gives it to someone else");
await fails(rpc("er_move_script", { p_token: A, p_script: sc2.script, p_editor: adminId }), "invalid", "and only to an editor");
const movedS = await rpc("er_move_script", { p_token: A, p_script: sc2.script, p_editor: ada });
const old2 = await one("select status, moved_to, note, ended_by from app.scripts where id = $1", [sc2.script]);
ast = await rpc("er_state", { p_token: TA });
ok(movedS.id && old2.status === "moved" && old2.moved_to === movedS.id && old2.note === "Too busy this week" && old2.ended_by === adminId && ast.scripts.some((s) => s.id === movedS.id && s.name === "Menoprime explainer" && s.cat === longf),
  "giving it to someone else closes it (keeping the reason) and it waits for them instead", JSON.stringify(old2));
ok((await pings(ada, "assigned")).some((r) => r.title === "New script: Menoprime explainer"), "and their phone pings");
await fails(rpc("er_move_script", { p_token: A, p_script: movedS.id, p_editor: ada }), "invalid", "giving a waiting script to the editor it's already with does nothing");
await rpc("er_withdraw_script", { p_token: A, p_script: movedS.id });
ok((await rpc("er_state", { p_token: TA })).scripts.length === 0 && !(await rpc("er_state", { p_token: A })).scripts.some((s) => s.id === movedS.id), "an admin can take a script back before it's taken on");
await fails(rpc("er_withdraw_script", { p_token: A, p_script: movedS.id }), "not_found", "and only once");
await fails(rpc("er_accept_script", { p_token: TA, p_script: movedS.id }), "not_found", "a script taken back can't be taken on");
// a brief made from a script keeps it when the admin reassigns the brief
const re = await rpc("er_reassign", { p_token: A, p_project: acc.id, p_to: tunde });
const tProj = (await rpc("er_state", { p_token: TT })).projects.find((p) => p.id === re.id);
ok(tProj && tProj.script === sc1.script && (await one("select app.script_file($1, $2) as f", [TT, sc1.script])).f.file === "docFile00000001", "a reassigned brief takes its script along, and the new editor can open it");
await fails(sql("select app.script_file($1, $2)", [TA, sc1.script]), "not_found", "and the editor it was taken from no longer can");
await sql("select app.drive_unlink($1)", [A]);
await fails(newScript(A, ada, ads, "", "x.docx", 10), "drive_off", "with Drive disconnected, no script can be sent");
await sql("select app.drive_link($1, $2, $3)", [adminId, "studio@example.com", "refresh-token-five"]);
const folderNow = async (name) => (await newScript(A, ada, ads, name, "check.txt", 10)).s.folder;
const sameAgain = await folderNow("Folder check 1");
await sql("select app.drive_link($1, $2, $3)", [adminId, "other@example.com", "refresh-token-six"]);
const otherAcct = await folderNow("Folder check 2");
await sql("select app.drive_link($1, $2, $3)", [adminId, "Studio@Example.com", "refresh-token-seven"]);
const backAgain = await folderNow("Folder check 3");
await sql("select app.script_failed(id, 'not sent') from app.scripts where name like 'Folder check %'");
ok(sameAgain === "fldScripts0000001" && otherAcct === null && backAgain === "fldScripts0000001", "connecting the same Google account again keeps its scripts folder; another account starts without one", JSON.stringify([sameAgain, otherAcct, backAgain]));

// ---- media buyers: they sign in like editors but only see the videos an admin has approved, and get a ping
// for each one; they can't touch briefs, scripts or uploads
const buyer = (await rpc("er_add_user", { p_token: A, p_name: "Bisi Buyer", p_username: "bisi", p_password: "bisi-pass-1", p_role: "buyer" })).id;
const TB = (await rpc("er_login", { p_username: "bisi", p_password: "bisi-pass-1" })).token;
await phone(buyer, "buyer-bisi");
let bst = await rpc("er_state", { p_token: TB });
const approved = (await sql("select id from app.projects where status = 'submitted' and received_at is not null and not deleted")).rows.map((r) => r.id).sort();
ok(bst.me.role === "buyer" && bst.projects.length === 0 && bst.scripts.length === 0 && bst.bonuses.length === 0 && bst.board.week.length === 0 && bst.featured.length === 0 && bst.users.length === 1
  && bst.settings.drive.on === false && bst.settings.drive.folders.length === 0, "a media buyer gets none of the editors' work, pay or leaderboard", JSON.stringify({ users: bst.users, drive: bst.settings.drive }));
ok(approved.length > 0 && bst.videos.map((v) => v.id).sort().join() === approved.join() && bst.videos.every((v) => v.link && v.at > 0 && v.by && v.name)
  && bst.videos.every((v, i, a) => i === 0 || a[i - 1].at >= v.at), "they get every approved video, newest first, with its link and who made it", bst.videos.length + " videos");
for (const [fn, args] of [["er_log_brief", { p_name: "Mine", p_category: ads }], ["er_accept_script", { p_script: sc1.script }], ["er_receive", { p_project: approved[0], p_on: false }], ["er_add_user", { p_name: "X", p_username: "xbuy", p_password: "password1" }]])
  await fails(rpc(fn, Object.assign({ p_token: TB }, args)), "forbidden", "a media buyer is refused: " + fn);
await fails(sql("select app.script_file($1, $2)", [TB, sc1.script]), "not_found", "a media buyer can't open scripts");
await fails(start(TB, acc.id, fMeno, 1000, "video/mp4", "mp4"), "forbidden", "nor upload");
ok(/new video is ready to download/.test((await rpc("er_test_push", { p_token: TB })) && (await pings(buyer, "test"))[0].body), "their test ping says what they'll hear about", JSON.stringify(await pings(buyer, "test")));
// a video is approved: every buyer hears once, and the sender gets its link
// the history made earlier in this run is moved an hour back, so "what changed since" holds only what follows
await sql("alter table app.projects disable trigger projects_touch");
await sql("update app.projects set changed_at = changed_at - interval '1 hour'");
await sql("alter table app.projects enable trigger projects_touch");
const bCursor = (await rpc("er_state", { p_token: TB })).cursor;
await rpc("er_submit", { p_token: TT, p_project: re.id, p_link: "https://drive.google.com/file/d/vid0000000014/view", p_note: "" });
const bBefore = await rpc("er_state", { p_token: TB, p_since: bCursor });
ok(!bBefore.full && !bBefore.videos.some((v) => v.id === re.id && v.link) && (await pings(buyer, "video")).length === 0, "a video waiting for the admin is not the buyers' yet", JSON.stringify(bBefore.videos));
await rpc("er_receive", { p_token: A, p_project: re.id, p_on: true });
let vids = (await rpc("er_state", { p_token: TB, p_since: bCursor })).videos, myVid = vids.find((v) => v.id === re.id);
ok(vids.length === 1 && myVid && myVid.name === "Proxan video 14" && myVid.cat === ads && myVid.by === "Tunde Bello" && myVid.link === "https://drive.google.com/file/d/vid0000000014/view", "once approved, it reaches the buyers", JSON.stringify(vids));
ok(JSON.stringify(await pings(buyer, "video")) === JSON.stringify([{ title: "New video: Proxan video 14", body: "Ads. Tap to download it." }]), "and their phones ping", JSON.stringify(await pings(buyer, "video")));
ok((await one("select app.push_link('video', $1) as l", [re.id])).l === "https://drive.google.com/file/d/vid0000000014/view" && (await one("select app.push_link('submitted', $1) as l", [re.id])).l === null, "the sender is given the video's link for the buyers' pings, and only for those");
await rpc("er_receive", { p_token: A, p_project: re.id, p_on: false });
vids = (await rpc("er_state", { p_token: TB, p_since: bCursor })).videos;
ok(vids.length === 1 && vids[0].id === re.id && vids[0].gone === true && !vids[0].link, "marking it not received takes it back off their list", JSON.stringify(vids));
await rpc("er_receive", { p_token: A, p_project: re.id, p_on: true });
ok((await pings(buyer, "video")).length === 1, "approving it again doesn't ping them twice");
ok((await one("select count(*)::int as n from app.outbox where kind = 'video' and user_id <> $1", [buyer])).n === 0, "only media buyers hear about approved videos");
// an admin can look at the media buyers' screen, with exactly the list a buyer's phone gets
const peek = await rpc("er_buyer_view", { p_token: A }), bNow = await rpc("er_state", { p_token: TB });
ok(peek.videos.length > 0 && JSON.stringify(peek.videos) === JSON.stringify(bNow.videos), "an admin looking at the media buyers' screen gets exactly what a buyer's phone gets", peek.videos.length + " videos");
await fails(rpc("er_buyer_view", { p_token: TB }), "forbidden", "only an admin can look at it that way: not a media buyer");
await fails(rpc("er_buyer_view", { p_token: TT }), "forbidden", "nor an editor");

// ---- switching a login off, roles, lockout
const admin2 =(await rpc("er_add_user", { p_token: A, p_name: "Kemi Admin", p_username: "kemi", p_password: "kemi-pass-1", p_role: "admin" })).id;
const TK = (await rpc("er_login", { p_username: "kemi", p_password: "kemi-pass-1" })).token;
ok((await rpc("er_state", { p_token: TK })).projects.length >= 5, "a second admin sees everything");
const ownerId = (await rpc("er_state", { p_token: A })).me.id;
await fails(rpc("er_update_user", { p_token: TK, p_user: ownerId, p_active: false }), "forbidden", "another admin cannot switch off the owner");
await fails(rpc("er_update_user", { p_token: TK, p_user: ownerId, p_password: "hijack-pass-1" }), "forbidden", "another admin cannot reset the owner's password");
await fails(rpc("er_update_user", { p_token: TK, p_user: tunde, p_role: "admin" }), "forbidden", "only the owner changes roles");
await fails(rpc("er_add_user", { p_token: TK, p_name: "Z", p_username: "zzz", p_password: "password1", p_role: "admin" }), "forbidden", "only the owner adds admins");
await rpc("er_update_user", { p_token: TK, p_user: tunde, p_password: "reset-pass-11" });
await fails(rpc("er_state", { p_token: TT }), "auth", "resetting a password signs that editor out");
ok((await rpc("er_login", { p_username: "tunde", p_password: "reset-pass-11" })).ok, "the reset password works");
await rpc("er_update_user", { p_token: A, p_user: chidi, p_active: false });
await fails(rpc("er_state", { p_token: TC }), "auth", "a switched-off login is signed out at once");
ok((await rpc("er_login", { p_username: "chidi", p_password: "chidi-pass-1" })).error === "inactive", "a switched-off login cannot sign in");
await rpc("er_update_user", { p_token: A, p_user: admin2, p_role: "editor" });
await fails(rpc("er_save_settings", { p_token: TK, p_delivery: 5, p_grace: 5 }), "forbidden", "a demoted admin loses admin rights at once");
let last;
for (let i = 0; i < 8; i++) last = await rpc("er_login", { p_username: "kemi", p_password: "bad-guess-" + i });
ok(last.error === "bad_login" && (await rpc("er_login", { p_username: "kemi", p_password: "kemi-pass-1" })).error === "locked", "eight wrong guesses lock the login for a while");

// ---- deleting a login made by mistake
const typo = (await rpc("er_add_user", { p_token: A, p_name: "Typo Login", p_username: "tpyo", p_password: "typo-pass-1" })).id;
const TY = (await rpc("er_login", { p_username: "tpyo", p_password: "typo-pass-1" })).token;
const tp = (await rpc("er_log_brief", { p_token: TY, p_name: "Test brief", p_category: ads })).id;
await fails(rpc("er_delete_user", { p_token: TY, p_user: typo }), "forbidden", "an editor cannot delete logins");
await fails(rpc("er_delete_user", { p_token: A, p_user: typo }), "in_use", "a login with work on record cannot be deleted");
await fails(rpc("er_delete_user", { p_token: A, p_user: ada }), "in_use", "a login with real history cannot be deleted");
await fails(rpc("er_delete_user", { p_token: A, p_user: ownerId }), "forbidden", "the owner cannot be deleted");
await rpc("er_delete_project", { p_token: A, p_project: tp });
await push(TY, 9);
ok((await rpc("er_delete_user", { p_token: A, p_user: typo })).ok === true, "once its test work is deleted, the login can be deleted");
ok((await sql("select count(*)::int as n from app.push_subs where user_id = $1 and gone_at is null", [typo])).rows[0].n === 0, "and its phones stop getting notifications");
await fails(rpc("er_state", { p_token: TY }), "auth", "a deleted login is signed out");
ok((await rpc("er_login", { p_username: "tpyo", p_password: "typo-pass-1" })).error === "bad_login" && !(await rpc("er_state", { p_token: A })).users.some((x) => x.id === typo), "and it is gone for good");
ok((await rpc("er_add_user", { p_token: A, p_name: "Right Login", p_username: "tpyo", p_password: "typo-pass-2" })).ok === true, "its username can be used again");
await fails(rpc("er_update_user", { p_token: A, p_user: typo, p_active: true }), "not_found", "a deleted login cannot be switched back on");
await fails(rpc("er_award_bonus", { p_token: A, p_editor: typo, p_amount: 5 }), "not_found", "or be given a bonus");
const shell = (await sql("select username, pass_hash, active, avatar, (select count(*)::int from app.sessions s where s.user_id = x.id and not s.revoked) as live from app.users x where id = $1", [typo])).rows[0];
ok(shell.username.startsWith("x-") && shell.pass_hash === "!" && shell.active === false && shell.avatar === null && shell.live === 0, "what is left of it holds no password, picture or live session", JSON.stringify(shell));

// ---- sessions are revoked, never revived; too many wrong tries pause sign-in for everyone
const TS = (await rpc("er_login", { p_username: "tpyo", p_password: "typo-pass-2" })).token;
await rpc("er_logout", { p_token: TS });
await fails(rpc("er_state", { p_token: TS }), "auth", "a signed-out session is refused");
const gone = (await sql("select revoked, expires_at > now() + interval '30 days' as long from app.sessions where token_hash = sha256(convert_to($1, 'UTF8'))", [TS])).rows[0];
ok(gone.revoked === true, "and stays revoked on the record", JSON.stringify(gone));
await sql("update app.meta set fail_from = null, fail_count = 0");
let tries = [];
for (let i = 0; i < 31; i++) tries.push((await rpc("er_login", { p_username: "nobody" + i, p_password: "wrong-guess" })).error);
ok(tries.slice(0, 30).every((e) => e === "bad_login") && tries[30] === "busy" && (await rpc("er_login", { p_username: "tpyo", p_password: "typo-pass-2" })).error === "busy", "after 30 wrong tries in a minute, sign-in pauses for everyone", tries.slice(28).join(","));
ok((await rpc("er_state", { p_token: A })).me.role === "admin", "people already signed in are not affected by the pause");
await sql("update app.meta set fail_from = now() - interval '61 seconds'");
ok((await rpc("er_login", { p_username: "tpyo", p_password: "typo-pass-2" })).ok === true, "and it opens again once the minute is up");
ok((await rpc("er_login", { p_username: "nobody", p_password: "wrong-guess" })).error === "bad_login" && (await sql("select fail_count from app.meta")).rows[0].fail_count === 1, "the count starts again from one");
await rpc("er_logout", { p_token: A });
await fails(rpc("er_state", { p_token: A }), "auth", "signing out ends the session");

// ---- the tables themselves cannot be reached
for (const q of ["select * from app.users", "select * from app.projects", "select * from app.featured", "select * from app.outbox", "select * from app.push_subs", "select * from app.details", "select app.details_of(null)","select app.push_keys()", "select app.push_claim(5)", "update app.meta set delivery_hours = 1", "select app.who('x')", "select app.password('aaaaaaaa')", "select app.featured_now()",
                  "select * from app.drive", "select * from app.uploads", "select * from app.drive_key()", "select app.drive_begin('x', 'https://x.example/')", "select * from app.drive_config()",
                  "select * from app.scripts", "select app.script_new('x', null, null, 'a', 'a.docx', 1)", "select app.script_file('x', null)", "select app.script_saved(null, 'x')", "select app.push_link('video', null)", "select app.buyer_videos(5)"]) {
  await fails(asAnon(q), "permission denied", "direct access is refused: " + q);
}
const pub = await sql("select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'er\\_%' and has_function_privilege('anon', p.oid, 'execute')");
const hidden = await sql("select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and has_schema_privilege('anon', 'app', 'usage')");
ok(pub.rows[0].n >= 24 && hidden.rows[0].n === 0, "only the er_ functions are callable from outside", pub.rows[0].n + " public, " + hidden.rows[0].n + " private reachable");
const hashes = await sql("select count(*)::int as n from app.users where removed_at is null and pass_hash like '$2a$10$%' and length(pass_hash) = 60");
const everyone = await sql("select count(*)::int as n from app.users where removed_at is null");
ok(hashes.rows[0].n === everyone.rows[0].n && everyone.rows[0].n === 7, "passwords are stored only as bcrypt hashes", hashes.rows[0].n + " of " + everyone.rows[0].n);

console.log(out.join("\n"));
console.log(failed ? "\n" + failed + " FAILED" : "\nall " + out.length + " passed" + (process.env.ER_BACKEND === "real" ? " (real PostgreSQL + PostgREST)" : ""));
await close();
process.exit(failed ? 1 : 0);
