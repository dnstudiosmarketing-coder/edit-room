# Edit Room

A small web app for a team of video editors and the people who run it.

- **Editors** log each brief the moment they get it, move it through three stages, and submit it with a Google Drive link. A brief's name, category and deadline are fixed once it is logged.
- **Admins** see what is waiting to download, what is past its deadline and by how long, how each editor and each video category is doing, and can reassign a script, send work back, set what each category pays, and award bonuses.
- Everyone on the team sees a leaderboard of on-time submissions; each editor sees what they have earned.

It opens from a link on any phone or computer and can be added to the home screen like an app.

**Live at:** https://dnstudiosmarketing-coder.github.io/edit-room/

## How it is put together

| Part | Where | Notes |
| --- | --- | --- |
| The pages | This repository, served by GitHub Pages from the `gh-pages` branch | Plain HTML, CSS and JavaScript. No build step. |
| The data | A Supabase project (`edit-room`, region us-west-1) | PostgreSQL. All rules live in `db/schema.sql`. |
| Sign-in | The app's own usernames and passwords | Created by an admin inside the app. Supabase Auth is not used. |

Files at the top level (`index.html`, `app.js`, `styles.css`, `fonts.css`, `fonts/`, `config.js`, `sw.js`, `manifest.webmanifest`, icons) are the app itself. `db/` holds the database script. `test/` holds the checks.

### The database, in short

Every table sits in a private `app` schema that the web API does not expose. The app can only call the `er_*` functions in `public`; each one checks the caller's session token and then decides what that person may see or change. Passwords are stored as bcrypt hashes, sessions as hashes of a random token. Deadlines run on the database clock, so a phone with the wrong time changes nothing.

`config.js` holds the project's address and its *publishable* key. Both are meant to be public: on their own they only reach the functions above.

Nothing in the database ever removes a row. Sessions are revoked, projects and logins are marked as removed. Keep it that way: it preserves the record, and it means changes can be applied without a destructive statement.

## Making a change

1. Edit the files.
2. Run the checks (below).
3. If `index.html`, `app.js`, `styles.css`, `fonts.css` or `config.js` changed, raise the `?v=` number on the four lines in `index.html` that load them, so phones pick up the new files together.
4. Publish: `git push origin main main:gh-pages`. The site updates within a few minutes.

If `db/schema.sql` changed, apply the changed statements to the Supabase project as a migration. The file is written so the whole of it can be run again safely. If a function's list of arguments changes, the old version has to be removed by hand first, or the web API will see two functions with one name.

## Running the checks

```
cd test
npm install
node check-api.mjs          # every call the app makes names a real database function and its arguments
node db.test.mjs            # the database rules: sign-in, who may do what, deadlines, pay, bonuses, history
node e2e.mjs                # the whole app in a real browser on a phone-sized screen
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
- The `pg_net` extension is switched on in the Supabase project. It lets the database make web requests: it was used to check the live web API from the inside, and deadline notifications will need it.
- The fonts (Barlow, Barlow Condensed, DM Mono) are served from `fonts/` under the SIL Open Font License; the licence texts are in that folder.
