# DN Studios team app

A small web app for DN Studios' video editors and the people who run the team. (The repository and the web address keep the app's first name, Edit Room.)

- **Editors** log each brief the moment they get it, move it through three stages, and submit it with a Google Drive link. A brief's name, category and deadline are fixed once it is logged.
- **Admins** see what is waiting to download, what is past its deadline and by how long, how each editor and each video category is doing, and can reassign a script, send work back, set what each category pays, and award bonuses.
- An admin can make any finished video a **Video of the moment**: it then shows at the top of everyone's home screen with the editor's name, and plays inside the app in Google Drive's own player (the page's security rules allow a frame from drive.google.com and nothing else). Up to five show at once. A file plays for everyone only if it is shared as "Anyone with the link"; a link that isn't a Drive file opens where it lives.
- Everyone on the team sees a leaderboard of on-time submissions; each editor sees what they have earned.
- **Phone notifications**, once each person turns them on: an admin's phone pings when a video is submitted, an editor's when a video reaches its deadline and the grace period starts. They arrive even when the app is closed. On iPhone the app has to be added to the home screen first.
- On a submitted video, **Mark received** glows until the admin presses it.
- Once a video's deadline passes, the editor's card shows the **grace period as a green battery** that drains in real time, with the time left above it; it's empty, with a red outline, when the grace period is over. The charge flows out of it like a phone's fast-charge animation run backwards (kept still for anyone who asks their phone for reduced motion).
- An admin can **send a reminder** from Settings, picking one of three: a new profile picture (every editor), payment details (editors who haven't added them) or late videos (editors with a video past its deadline, named in the message). Editors with notifications on get it on their phone, and their home screen asks too. The sheet says how many editors each one reaches and how many have notifications on; the same reminder can't go out twice within 10 minutes.
- Tapping a picture (anyone's, for an admin; the leaderboard, for editors) shows it full size.
- Each editor has a **Videos** page listing every video they have submitted, playable in the app; an admin can open anyone's from the Editors screen.
- **Day or night**: under Your account (tap your name at the top), anyone can pick Day, Night, or Same as phone. The choice stays on that phone.
- **Payment details**: each editor adds their full name (as on their bank account), phone number, bank and 10-digit account number under Your account, and sees a reminder on their home screen until they do. An admin finds them under **Profile** on the Editors screen, with a button that copies the account number; when an editor's bank or account number changed in the last 30 days, the profile says so and where pay went before. Only the editor and the admins can read them.

It opens from a link on any phone or computer and can be added to the home screen like an app.

**Live at:** https://dnstudiosmarketing-coder.github.io/edit-room/

## How it is put together

| Part | Where | Notes |
| --- | --- | --- |
| The pages | This repository, served by GitHub Pages from the `gh-pages` branch | Plain HTML, CSS and JavaScript. No build step. |
| The data | A Supabase project (`edit-room`, region us-west-1) | PostgreSQL. All rules live in `db/schema.sql`. |
| Sign-in | The app's own usernames and passwords | Created by an admin inside the app. Supabase Auth is not used. |
| Notifications | A Supabase Edge Function, `dn-push` (`supabase/functions/dn-push/`) | Sends Web Push messages. The database nudges it; a timer (pg_cron, every minute) catches anything missed and notices deadlines. |

Files at the top level (`index.html`, `app.js`, `theme.js`, `styles.css`, `fonts.css`, `fonts/`, `config.js`, `sw.js`, `manifest.webmanifest`, icons) are the app itself. `db/` holds the database script, `supabase/functions/dn-push/` the notification sender. `test/` holds the checks.

### Notifications, in short

A phone that allows notifications leaves its push address in `app.push_subs` (belonging to whoever is signed in on it; signing out lets it go). Things worth a ping go into `app.outbox`: a submission (for every admin), a deadline passing (for the editor, once, within 6 hours of it), a test. Reminders an admin sends from Settings go into `app.reminders` instead (outbox's list of kinds is fixed, and older picture requests stay there as `picture`); `er_remind` works out who each one is for. Each insert nudges the sender through `pg_net`; the sender takes a batch from both tables with `app.push_claim`, encrypts each message for each phone (RFC 8291) and signs it (VAPID, RFC 8292), and reports back with `app.push_report`. A phone its push service calls gone is stamped `gone_at`; a busy push service is tried again after 2 minutes, five times at most.

Nothing secret passes through anyone's hands. The nudge carries `app.meta.push_secret`, made inside the database; the sender checks it against the same row. The sender makes its own signing keys on its first run and keeps them in `app.meta`; phones get only the public half, through `er_state`. The sender connects to the database with `SUPABASE_DB_URL`, which Supabase gives every edge function. It is deployed with JWT checks off, because it checks the secret itself.

On the live project, `app.meta.push_url` holds the sender's address and `app.meta.push_contact` the contact shown to push services; both are left empty in `db/schema.sql`, so a local or test database never sends anything.

### The look, in short

Gray is the room, white is the paper, black is the slate, yellow is the signal. Each main screen opens on a black panel that carries its headline numbers. Yellow is kept for the main action, the section you are in, and rewards (bonuses, first place). Orange and red mean late and overdue, green means on time. There is one type family, Barlow. Day and night follow the phone's own setting, unless someone picks one under Your account: `theme.js`, which runs before the page is drawn, keeps that choice on the phone (`editroom.theme`) and marks the page `data-theme="light"` or `"dark"`, and sets the status bar to match.

Every colour is a named value at the top of `styles.css`, once for light and once for dark; change it there and the whole app follows. The dark values are written out twice, once for a phone set to dark and once for anyone who picks Night. Keep the two the same: the browser checks fail if they differ. The studio's name is set in three places: `APP` at the top of `app.js`, the heading and title in `index.html`, and `manifest.webmanifest` (the name under the home-screen icon). The saved sign-in on each phone is still stored under `editroom.*`; leave those names alone, or everyone is signed out.

### The database, in short

Every table sits in a private `app` schema that the web API does not expose. The app can only call the `er_*` functions in `public`; each one checks the caller's session token and then decides what that person may see or change. Passwords are stored as bcrypt hashes, sessions as hashes of a random token. Deadlines run on the database clock, so a phone with the wrong time changes nothing.

`config.js` holds the project's address and its *publishable* key. Both are meant to be public: on their own they only reach the functions above.

Payment details live in `app.details`: saving a change adds a row, and the newest row is the one in use, so every earlier account stays on record. They reach an admin only through `er_details`, one editor at a time, never in `er_state`.

Nothing in the database ever removes a row. Sessions are revoked, projects and logins are marked as removed. Keep it that way: it preserves the record, and it means changes can be applied without a destructive statement.

## Making a change

1. Edit the files.
2. Run the checks (below).
3. If `index.html`, `app.js`, `theme.js`, `styles.css`, `fonts.css` or `config.js` changed, raise the `?v=` number on the five lines in `index.html` that load them, so phones pick up the new files together. If a file is added to the app, add it to the list at the top of `sw.js` and raise the number in `CACHE` there.
4. Publish: `git push origin main main:gh-pages`. The site updates within a few minutes.

If `db/schema.sql` changed, apply the changed statements to the Supabase project as a migration. The file is written so the whole of it can be run again safely. If a function's list of arguments changes, the old version has to be removed by hand first, or the web API will see two functions with one name.

If `supabase/functions/dn-push/` changed, deploy it again as the `dn-push` edge function, with JWT checks off.

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
- pg_cron writes one line to its own log, `cron.job_run_details`, for every run: about 1,440 a day, very roughly 80 MB a year. That is pg_cron's diary, not the team's records. If the database ever nears the free plan's size limit, clear the old lines in the SQL editor: `delete from cron.job_run_details where end_time < now() - interval '7 days';`
- **Notifications stopped?** Check the job is there (`select * from cron.job`), that `app.meta.push_url` is set, and the `dn-push` function's logs in the Supabase dashboard.
- The font (Barlow) is served from `fonts/` under the SIL Open Font License; the licence text is in that folder.
