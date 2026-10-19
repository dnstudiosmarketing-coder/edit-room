# DN Studios team app

A small web app for DN Studios' video editors and the people who run the team. (The repository and the web address keep the app's first name, Edit Room.)

- **Editors** log each brief the moment they get it (or accept a script their admin sends through the app), move it through three stages, and submit the finished video by uploading it to the studio's Google Drive (see below). A brief's name, category and deadline are fixed once it is logged.
- **Admins** see what is waiting to download, what is in progress (newest first, so a brief an editor has just logged shows straight away), what is past its deadline and by how long, how each editor and each video category is doing, and can reassign a script, send work back, set what each category pays, and award bonuses. Tapping an editor's name anywhere opens their profile (below).
- An admin can make any finished video a **Video of the moment**: it then shows at the top of everyone's home screen with the editor's name, and plays inside the app in Google Drive's own player (the page's security rules allow a frame from drive.google.com and nothing else). Up to five show at once. A file plays for everyone only if it is shared as "Anyone with the link"; a link that isn't a Drive file opens where it lives.
- Editors and admins see a leaderboard of on-time submissions; each editor sees what they have earned since they were last paid, and their past payments.
- **Phone notifications**, once each person turns them on: an admin's phone pings when a video is submitted or an editor can't take a script; an editor's when a script arrives and when a video reaches its deadline and the grace period starts; a media buyer's or supervisor's when an admin approves a video. They arrive even when the app is closed. On iPhone the app has to be added to the home screen first.
- On a submitted video, **Mark received** glows until the admin presses it.
- **Deadlines** are set in Settings: the delivery time, counted from the moment a brief is logged, and the grace period after it. Settings has a **Save changes** button in each panel. A new delivery time applies to briefs logged from then on, so no deadline that is already running moves; a new grace period applies straight away, to briefs already in progress too.
- Once a video's deadline passes, its card shows the **grace period as a green battery** that drains in real time (for the editor on My work, and for an admin in the inbox and Projects), with the time left above it; it's empty, with a red outline, when the grace period is over. The charge flows out of it like a phone's fast-charge animation run backwards (kept still for anyone who asks their phone for reduced motion).
- An admin can **send a reminder** from Settings, picking one of three: a profile picture (editors who don't have one), payment details (editors who haven't added them) or late videos (editors with a video past its deadline, named in the message). Each goes only to the editors who still have to do what it asks. Those with notifications on get it on their phone, and their home screen asks too, until it's done. The sheet says how many editors each one reaches and how many have notifications on; the same reminder can't go out twice within 10 minutes.
- Tapping a picture (anyone's, for an admin; the leaderboard, for editors) shows it full size.
- Each editor has a **Videos** page listing every video they have submitted, playable in the app; an admin sees anyone's in their profile.
- **Profiles**: for an admin, an editor's name is a link wherever it shows (Inbox, Projects, Uploads, the Editors screen, the team list in Settings). It opens their profile: **To pay** (what they've earned since they were last paid), what they've earned in all, from videos and from bonuses, what has been paid and when, with **Reset payment** and **Bonuses**; how many videos they've made and how many are approved, what's in progress, their on-time rate and turnaround; every video they've submitted, newest first and playable, with what each paid (the latest five, then all of them, older ones a page at a time); their payments; and their payment details. Supervisors see names but can't open profiles.
- **Day or night**: under Your account (tap your name at the top), anyone can pick Day, Night, or Same as phone. The choice stays on that phone.
- **Uploads to Google Drive**: once an admin connects the studio's Google Drive (Settings → Google Drive) and picks the folders editors may use, an editor submits by uploading the finished video straight into one of those folders, from their phone or computer. The folder named like the brief's category is chosen for them. The video goes from the editor's device to Google a piece at a time, with a progress bar; if the line drops it carries on where it stopped, and if the app is closed part way, choosing the same video again carries on too (for up to a week). The video's file has to be named like the brief, so a video can't go into the wrong brief by mistake: capitals, spaces and symbols don't count, but every letter and number does. For a brief called Menotea 10, `MENOTEA_10.mp4` and `menotea10.mov` are fine, and `Menotea 11.mp4` or `Menotea 10 (1).mp4` is refused, with a message saying what the name has to be. Some phones don't pass the name on: Android's photo picker hands the app a number instead (`229149.mp4`). A name with no letters in it can't be checked, so the editor ticks a box confirming it's the video for that brief instead, and the copy in Drive is named after the brief all the same. A brief named after a script file may end in `.docx` or `.pdf`; the video fits with or without that ending. When it's all there, the brief is submitted with the file's link and the file can be watched by anyone with its link, so it plays in the app. Once the studio has connected its Drive, uploading is the only way to submit a video: there's no link to paste, and the database refuses one (`upload_only`). If the connection is ever lost, or no folder is on the list, nobody can submit until an admin puts it right: editors are told uploading is paused, and every admin screen says so. A studio that has never connected a Drive submits with links.
- **Scripts sent through the app**: in the inbox, **Assign a script** takes the script (a Word document, PDF or text file, up to 10 MB; several chosen at once all go to the same editor), its category and the editor. The file is saved in a folder the app makes in the studio's Google Drive, **DN Studios scripts**, not in the app's database. The editor's phone pings and the script waits at the top of My work until they press **Accept and open**: that logs the brief (named after the file, in the admin's category), so the deadline starts then, and downloads the script. **Can't take it** sends it back with a reason instead; the admin's phone pings, and the inbox lists it first, with **Give to someone else** and **Take back**. Before it is accepted only admins can open a script; after, the editor who has its brief (and whoever the brief is reassigned to). Editors can still log briefs they get some other way.
- **Media buyers** are a third kind of login (Settings → Add a login → Media buyer). A media buyer has one screen: every video an admin has approved (marked received), from every category, newest first, each with **Download** and **Watch**, and a category filter. Their phone pings for each new one, and tapping the ping downloads the video (for a big file Google asks once first, as it can't check it for viruses). They don't see briefs, scripts, pay, the leaderboard or anyone else's details.
- **Supervisors** are a fourth kind of login (Settings → Add a login → Supervisor). A supervisor sees everything a media buyer sees, on a **Videos** tab, and the same **Uploads** tab as admins (below). Their phone pings like a media buyer's. They can't change anything, and like media buyers they don't see briefs in progress, scripts, pay, the leaderboard or anyone's details.
- **Uploads by day**: the Uploads tab shows how many videos editors submitted today, yesterday, in the last 7 days and in the last 14, then one row per day, newest first, with its count and a bar on one scale for every day. Tapping a day lists its videos: name, editor, category, the time it came in, and whether it's approved yet. Every video submitted counts, uploaded or sent as a link, once, on the day it was submitted (a video sent back and submitted again counts on the day of its latest submission; a deleted one doesn't count). Days run midnight to midnight in the team's time zone. **Show 14 more days** reaches back further, up to 92 days.
- **See what your team sees**: in Settings, an admin can open the editor screen (to try it; anything logged there is saved under their name), the media buyer screen or the supervisor screen, which show exactly what those logins get (`er_buyer_view`, the same `app.buyer_videos` their phones use, and `er_uploads`). Back to admin returns to Settings.
- **Reset payment**: on the Editors screen, each editor's card shows **To pay**: what they've earned since they were last paid (videos marked received, and bonuses), with when they were last paid and how much. Once an admin has paid them, **Reset payment** asks to confirm the amount, then records the payment, and the editor's earnings start again from zero, on the admin's screen and theirs, counting from the next video marked received. Each editor's Earnings screen and their Profile list past payments. A video or bonus that has been paid for is marked **Paid** and can't be marked not received, given a different amount, deleted or removed afterwards.
- **Payment details**: each editor adds their full name (as on their bank account), phone number, bank and 10-digit account number under Your account, and sees a reminder on their home screen until they do. An admin finds them in the editor's profile, with a button that copies the account number; when an editor's bank or account number changed in the last 30 days, the profile says so and where pay went before. Only the editor and the admins can read them.

It opens from a link on any phone or computer and can be added to the home screen like an app.

**Live at:** https://dnstudiosmarketing-coder.github.io/edit-room/

## How it is put together

| Part | Where | Notes |
| --- | --- | --- |
| The pages | This repository, served by GitHub Pages from the `gh-pages` branch | Plain HTML, CSS and JavaScript. No build step. |
| The data | A Supabase project (`edit-room`, region us-west-1) | PostgreSQL. All rules live in `db/schema.sql`. |
| Sign-in | The app's own usernames and passwords | Created by an admin inside the app. Supabase Auth is not used. |
| Notifications | A Supabase Edge Function, `dn-push` (`supabase/functions/dn-push/`) | Sends Web Push messages. The database nudges it; a timer (pg_cron, every minute) catches anything missed and notices deadlines. |
| Drive uploads and scripts | A Supabase Edge Function, `dn-drive` (`supabase/functions/dn-drive/`), and a Google Cloud project on the studio's Google account | Connects the studio's Drive, hands out upload addresses, and saves and opens scripts. A video goes from the editor's browser straight to Google. |

Files at the top level (`index.html`, `app.js`, `theme.js`, `styles.css`, `fonts.css`, `fonts/`, `config.js`, `sw.js`, `manifest.webmanifest`, icons) are the app itself; `drive-folders.html` and `drive-folders.js` are the page where an admin picks Drive folders in Google's own picker. `privacy.html` is the privacy policy, linked from the sign-in screen and Your account, and the page Google's sign-in screen links to. `db/` holds the database script, `supabase/functions/dn-push/` the notification sender and `supabase/functions/dn-drive/` the Drive uploader. `test/` holds the checks.

### Notifications, in short

A phone that allows notifications leaves its push address in `app.push_subs` (belonging to whoever is signed in on it; signing out lets it go). Things worth a ping go into `app.outbox`: a submission (for every admin), a deadline passing (for the editor, once, within 6 hours of it), a script sent (`assigned`, for its editor), a script turned down (`declined`, for every admin), a video approved (`video`, for every media buyer, once per video), a test. Reminders an admin sends from Settings go into `app.reminders` instead (older picture requests stay in the outbox as `picture`); `er_remind` works out who each one is for. Each insert nudges the sender through `pg_net`; the sender takes a batch from both tables with `app.push_claim`, encrypts each message for each phone (RFC 8291) and signs it (VAPID, RFC 8292), and reports back with `app.push_report`. A phone its push service calls gone is stamped `gone_at`; a busy push service is tried again after 2 minutes, five times at most. Tapping a ping opens the app, except a media buyer's about a video: that one carries the video's download address (the sender gets the link from `app.push_link` and turns a Drive file link into Drive's download address), and `sw.js` opens it.

Nothing secret passes through anyone's hands. The nudge carries `app.meta.push_secret`, made inside the database; the sender checks it against the same row. The sender makes its own signing keys on its first run and keeps them in `app.meta`; phones get only the public half, through `er_state`. The sender connects to the database with `SUPABASE_DB_URL`, which Supabase gives every edge function. It is deployed with JWT checks off, because it checks the secret itself.

On the live project, `app.meta.push_url` holds the sender's address and `app.meta.push_contact` the contact shown to push services; both are left empty in `db/schema.sql`, so a local or test database never sends anything.

### Google Drive uploads, in short

The app asks Google for Drive's narrowest permission, `drive.file`: it can see the folders an admin picks in Google's folder picker and the files it puts there, and nothing else in the Drive. Google calls that permission non-sensitive, so the studio's Google Cloud project needs no review by Google.

- **Connecting.** Settings → Connect Google Drive asks `dn-drive` for Google's sign-in address, with a one-time code (`app.drive_states`, good for 15 minutes) tying Google's answer to that admin. Google sends the admin back to `dn-drive`, which trades the answer for a lasting key (Google's refresh token) and keeps it in `app.drive`, then sends the admin back to the app (`?drive=connected`, or why not). Connecting again or disconnecting closes the old connection; the row stays. If Google ends it (someone takes the app's access away in their Google account), the next call notices, the connection is marked ended, and Settings asks to connect again.
- **Folders.** Add folders opens `drive-folders.html`, a page of its own so the rest of the app can keep refusing outside scripts. Picking folders there is what lets the app put files in them. `dn-drive` checks each one with Google before it joins `app.drive_folders`; taking one off the list leaves it in Drive.
- **An upload.** `dn-drive` checks the brief is the editor's and still in progress, asks Google for an upload address in the chosen folder (sending the editor page's origin, so Google lets that page send to it) and records it in `app.uploads`. The browser sends 8 MB pieces straight to Google; Google says after each how much it has. After a dropped line the browser asks `dn-drive` how much arrived and carries on; the address lasts a week, and the phone keeps it (`editroom.upload.<brief>`) so closing the app doesn't lose the upload. When it's all there, `dn-drive` checks the file in Drive is that upload's (by a mark it put on the file, its folder and its size), lets anyone with the link view it, and submits the brief with `app.drive_submit` (the same submission as a pasted link, through `app.submit`), so the admin is pinged as for any submission. `er_submit`, the pasted-link route, refuses once the studio has connected a Drive (any row in `app.drive`; `drive_info` tells the app as `only`). The file is named after the brief and the editor, like `Proxan video 13 (Ada Obi).mp4`.
- **Scripts.** The admin's browser reads the file and sends it to `dn-drive` (`script_send`), which records it in `app.scripts` (`app.script_new`), saves it in the **DN Studios scripts** folder in one request, then marks it waiting, which pings the editor (`app.script_saved`), or failed, with Google's answer (`app.script_failed`). The folder is made the first time; its id is kept with the connection (`app.drive.scripts_folder`), carried over when the same Google account connects again, and made afresh if it was deleted or put in the bin. Only Drive's id for each file is in the database. Opening one (`script_open`) asks the database who may (`app.script_file`: an admin, or the editor who has its brief) and passes the file through from Drive; one deleted from Drive is reported as gone. Accepting (`er_accept_script`) makes the brief; turning down, giving to someone else and taking back are `er_decline_script`, `er_move_script` and `er_withdraw_script`. Rows are only ever closed (`status`, `ended_at`), never removed.

What Google issued the studio is kept in two places. The OAuth client's secret is an Edge Function secret, `GOOGLE_CLIENT_SECRET`, so the database alone opens nothing. The rest isn't secret and is kept in `app.meta`: `google_client_id` (the OAuth client, type Web application), `google_api_key` (an API key restricted to the Google Picker API and to `https://dnstudiosmarketing-coder.github.io/*` and `https://docs.google.com/*`) and `google_app_id` (the Cloud project's number); the last two are for the folder picker. Function settings of the same names (`GOOGLE_CLIENT_ID`, `GOOGLE_API_KEY`, `GOOGLE_APP_ID`) take their place if set. `dn-drive` works out its own address from the `SUPABASE_URL` Supabase gives it (`https://nzrsxjmkucceqakusjyw.supabase.co/functions/v1/dn-drive`), or takes `DRIVE_SELF_URL`. In Google Cloud, that address is the client's authorized redirect URI, `nzrsxjmkucceqakusjyw.supabase.co` is an authorized domain, `https://dnstudiosmarketing-coder.github.io` an authorized JavaScript origin, the Google Drive API and Google Picker API are turned on, and the app is published ("In production"): one left in Testing loses its connection after 7 days. Google won't publish it until the Branding page has the app's name, a support email, a home page (`https://dnstudiosmarketing-coder.github.io/edit-room/`) and a privacy policy (`https://dnstudiosmarketing-coder.github.io/edit-room/privacy.html`), with `dnstudiosmarketing-coder.github.io` among the authorized domains. Leave the logo empty: a logo needs Google's review. If what the app keeps or does with Google data changes, change `privacy.html` and its date too. Without the client's id and secret, Connect Google Drive says Drive isn't set up yet.

### The look, in short

Gray is the room, white is the paper, black is the slate, yellow is the signal. Each main screen opens on a black panel that carries its headline numbers. Yellow is kept for the main action, the section you are in, and rewards (bonuses, first place). Orange and red mean late and overdue, green means on time. There is one type family, Barlow. Day and night follow the phone's own setting, unless someone picks one under Your account: `theme.js`, which runs before the page is drawn, keeps that choice on the phone (`editroom.theme`) and marks the page `data-theme="light"` or `"dark"`, and sets the status bar to match.

Every colour is a named value at the top of `styles.css`, once for light and once for dark; change it there and the whole app follows. The dark values are written out twice, once for a phone set to dark and once for anyone who picks Night. Keep the two the same: the browser checks fail if they differ. The studio's name is set in three places: `APP` at the top of `app.js`, the heading and title in `index.html`, and `manifest.webmanifest` (the name under the home-screen icon). The saved sign-in on each phone is still stored under `editroom.*`; leave those names alone, or everyone is signed out.

### The database, in short

Every table sits in a private `app` schema that the web API does not expose. The app can only call the `er_*` functions in `public`; each one checks the caller's session token and then decides what that person may see or change. Passwords are stored as bcrypt hashes, sessions as hashes of a random token. Deadlines run on the database clock, so a phone with the wrong time changes nothing.

Each brief carries its own delivery time and grace period (`due_hours`, `grace_hours` in `app.projects`), copied from Settings when it is logged. Saving Settings (`er_save_settings`) also gives the new grace period to every brief still in progress, including ones waiting with an admin, since those can be sent back; finished, reassigned and deleted briefs keep theirs.

`config.js` holds the project's address and its *publishable* key. Both are meant to be public: on their own they only reach the functions above.

Logins have one of four roles: `admin`, `editor`, `buyer` (a media buyer) or `supervisor`. The functions for brief work (`er_log_brief`, `er_submit` and the like, and Drive uploads) go through `app.worker`, which lets admins and editors in and turns media buyers and supervisors away. For a media buyer or a supervisor, `er_state` returns only their own login and the approved videos (`videos`: the newest 300, then only what changed since the phone last asked). `er_uploads` (admins and supervisors only) returns every video submitted in the last 14 days, or up to 92 if asked, each with its day in the team's time zone (`app.meta.tz`) and its editor's id (`u`, so an admin can open their profile); the app groups and counts them. An admin's `er_state` gives each login `made`: how many videos they've submitted, and how many are approved.

Payments are rows in `app.payouts`. `app.owed` works out what an editor is owed since their latest payout: the videos marked received after it and the bonuses awarded after it. `er_reset_pay` (admins only) adds a payout with that amount, how many videos and bonuses it covers, who recorded it and when. It refuses when there is nothing to pay, or when the amount has changed since the admin's screen showed it (`p_expect`), so the payment on record is always the one the admin confirmed. `app.paid_for` tells whether a video is in a payout (marked received before its editor's latest one); `er_receive` (undo), `er_set_amount` and `er_delete_project` refuse those, and `er_remove_bonus` refuses a bonus a payout covers. The upload name check is in the app, in the submit sheet (`fitsBrief`): it compares the file's name, without its extension, with the brief's, letters and numbers only.

Payment details live in `app.details`: saving a change adds a row, and the newest row is the one in use, so every earlier account stays on record. They reach an admin only through `er_details`, one editor at a time, never in `er_state`.

Profile pictures reach the app through `er_avatars`, as small squares. The browser keeps them (`editroom.pics` in its storage, each with its version from `avatar_ver`), so opening the app downloads only the pictures that changed since; signing out clears them. Before, every visit fetched everyone's picture, which was most of what the app downloaded from Supabase.

Nothing in the database ever removes a row. Sessions are revoked, projects and logins are marked as removed. Keep it that way: it preserves the record, and it means changes can be applied without a destructive statement. The one thing cleared is pg_cron's own log of timer runs, which isn't the team's record (see the notes at the end).

## Making a change

1. Edit the files.
2. Run the checks (below).
3. If `index.html`, `app.js`, `theme.js`, `styles.css`, `fonts.css` or `config.js` changed, raise the `?v=` number on the five lines in `index.html` that load them, so phones pick up the new files together. If a file is added to the app, add it to the list at the top of `sw.js` and raise the number in `CACHE` there.
4. Publish: `git push origin main main:gh-pages`. The site updates within a few minutes.

If `db/schema.sql` changed, apply the changed statements to the Supabase project as a migration. The file is written so the whole of it can be run again safely. If a function's list of arguments changes, the old version has to be removed by hand first, or the web API will see two functions with one name.

If `supabase/functions/dn-push/` changed, deploy it again as the `dn-push` edge function, with JWT checks off. The same goes for `supabase/functions/dn-drive/` and the `dn-drive` edge function.

`drive-folders.html` and `drive-folders.js` are left out of the offline helper's list in `sw.js` on purpose: Google's picker needs a connection anyway. They load `theme.js`, `fonts.css` and `styles.css` with the same `?v=` number as `index.html`, and so does `privacy.html`; raise theirs too (`test/e2e.mjs` checks they match).

## Running the checks

```
cd test
npm install
node check-api.mjs          # every call the app makes names a real database function and its arguments
node db.test.mjs            # the database rules: sign-in, who may do what, deadlines, pay, bonuses, history
node e2e.mjs                # the whole app in a real browser on a phone-sized screen
```

The notification sender is checked end to end against the real stack, with a local stand-in for the push services (its messages are decrypted with an independent library):

```
ER_BACKEND=real POSTGREST=/path/to/postgrest node push.test.mjs
```

The Drive upload and scripts are checked the same way, against the real stack, with Google stood in for by `google-fake.mjs` (sign-in, Drive's file calls and resumable uploads that answer a browser the way Google's do, and can drop the line part way through a piece), in code and in a real browser:

```
ER_BACKEND=real POSTGREST=/path/to/postgrest node drive.test.mjs
```

The browser run needs Playwright: `npm install playwright && npx playwright install chromium` (or point `GLOBAL_MODULES` at a folder that already has it).

Those run against a small in-process PostgreSQL. To run the same checks against a real PostgreSQL server with PostgREST in front of it, the way the live app is served:

```
ER_BACKEND=real POSTGREST=/path/to/postgrest node db.test.mjs
ER_BACKEND=real POSTGREST=/path/to/postgrest node e2e.mjs
ER_BACKEND=real POSTGREST=/path/to/postgrest node deploy-shape.mjs   # pages in a sub-folder, data on another address
```

## Looking after it

- **First run.** A fresh database accepts one admin, created on the app's setup screen with a one-time setup code. Only a hash of the code is stored (`app.meta.setup_hash`), and it is cleared once used.
- **A lost admin password.** There is no email reset. In the Supabase SQL editor:

  ```sql
  update app.users set pass_hash = extensions.crypt('a-new-password', extensions.gen_salt('bf', 10)), failed = 0, locked_until = null where owner;
  update app.sessions set revoked = true where user_id = (select id from app.users where owner) and not revoked;
  ```

- **Supabase's advisor** lists the `er_*` functions as callable without a Supabase sign-in. That is how the app works: it has its own logins, and each function checks them.
- **Supabase's free plan** pauses a project after about a week with no use. Open the project in the Supabase dashboard and restore it; nothing is lost.
- `app.login_log` is an empty table left over from the first version of the sign-in code. It is not used and can be dropped.
- The `pg_net` extension lets the database nudge the notification sender; `pg_cron` runs `app.notice_tick()` every minute (job `dn-notices`). To see what was sent: `select kind, title, result, created_at from app.outbox order by created_at desc limit 20;` and, for reminders, the same from `app.reminders`.
- pg_cron writes one line to its own log, `cron.job_run_details`, for every run: about 1,440 a day, roughly 100 MB a year if kept. That is pg_cron's diary, not the team's records, so a second job, `dn-timer-log`, clears the lines older than a week every night at 03:17 UTC. A week is plenty to see whether the timer has been running.
- **Notifications stopped?** Check the job is there (`select * from cron.job`), that `app.meta.push_url` is set, and the `dn-push` function's logs in the Supabase dashboard.
- **Uploads stopped?** Settings → Google Drive says if Google ended the connection; Connect again fixes it. Otherwise check the `dn-drive` function's logs, that its secrets are set, and that the Google Cloud project is still published. What happened to each upload is in `app.uploads` (`result`), and every connection in `app.drive`. A script that couldn't be saved is in `app.scripts` with status `failed` and Google's answer in `note`.
- The font (Barlow) is served from `fonts/` under the SIL Open Font License; the licence text is in that folder.
