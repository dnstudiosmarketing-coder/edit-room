-- The DN Studios team app's database (the app was first called Edit Room, which is where "er_" comes from).
-- Every table lives in the private "app" schema, which the web API does not expose. The app reaches the data
-- only through the er_* functions in "public". Each one checks the caller's session token first and then
-- decides what that person may see or change. Times always come from the database clock.
--
-- The whole file can be run again at any time: it only adds what is missing and replaces the functions.
-- Nothing here ever removes a row: sessions are revoked, projects and logins are marked as removed. That keeps
-- a full record, and it means every later change to this file can be applied without a destructive statement.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists app;
revoke all on schema app from public;

-- ---------------------------------------------------------------- tables

create table if not exists app.meta (
  id boolean primary key default true check (id),
  setup_hash text,                                   -- sha256 of the one-time setup code; cleared once used
  setup_tries int not null default 0,
  delivery_hours int not null default 24 check (delivery_hours between 1 and 720),
  grace_hours int not null default 48 check (grace_hours between 0 and 720),
  weekly_target int check (weekly_target between 1 and 999),
  currency text not null default '' check (char_length(currency) <= 6),
  bonus_default numeric(12,2) check (bonus_default >= 0),
  tz text not null default 'UTC',
  fail_from timestamptz,                             -- wrong sign-in tries are counted a minute at a time
  fail_count int not null default 0
);
alter table app.meta add column if not exists fail_from timestamptz;
alter table app.meta add column if not exists fail_count int not null default 0;
insert into app.meta default values on conflict do nothing;

create table if not exists app.users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique check (username ~ '^[a-z0-9._-]{3,24}$'),
  name text not null check (char_length(name) between 1 and 40),
  role text not null check (role in ('admin', 'editor')),
  owner boolean not null default false,
  pass_hash text not null,
  active boolean not null default true,
  avatar text check (avatar is null or char_length(avatar) <= 60000),
  avatar_ver int not null default 0,
  failed int not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  last_seen timestamptz,
  removed_at timestamptz                             -- set when a login made by mistake is deleted; the row stays as an empty shell
);
alter table app.users add column if not exists removed_at timestamptz;

create table if not exists app.sessions (
  token_hash bytea primary key,
  user_id uuid not null references app.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked boolean not null default false             -- signed out, password changed, or login switched off
);
alter table app.sessions add column if not exists revoked boolean not null default false;
create index if not exists sessions_user on app.sessions(user_id);

create table if not exists app.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 40),
  color int not null default 0 check (color between 0 and 7),
  rate numeric(12,2) check (rate >= 0),
  archived boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists app.projects (
  id uuid primary key default gen_random_uuid(),
  editor_id uuid not null references app.users(id),
  name text not null check (char_length(name) between 1 and 140),
  category_id uuid references app.categories(id),
  stage int not null default 1 check (stage between 1 and 3),
  status text not null default 'active' check (status in ('active', 'submitted', 'reassigned')),
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),      -- the editor's last progress change
  due_hours int not null default 24 check (due_hours between 1 and 720),       -- the delivery time in force when the brief was logged
  grace_hours int not null default 48 check (grace_hours between 0 and 720),   -- and the grace period after it
  submitted_at timestamptz,
  link text check (link is null or char_length(link) <= 600),
  note text not null default '' check (char_length(note) <= 400),
  progress text not null default '' check (char_length(progress) <= 240),
  hold_ms bigint not null default 0 check (hold_ms >= 0),   -- time spent waiting with the admin before being sent back
  back_at timestamptz,
  back_note text not null default '' check (char_length(back_note) <= 300),
  from_editor uuid references app.users(id),
  moved_to uuid references app.users(id),
  moved_at timestamptz,
  seen_moved boolean not null default false,
  received_at timestamptz,
  amount numeric(12,2) check (amount >= 0),
  deleted boolean not null default false,
  due_at timestamptz not null,       -- kept by the trigger below: started_at + due_hours + time on hold
  touched_at timestamptz not null,   -- kept by the trigger: the latest of started, updated, submitted, moved, received
  changed_at timestamptz not null default clock_timestamp()
);
create index if not exists projects_editor on app.projects(editor_id, started_at desc);
create index if not exists projects_changed on app.projects(changed_at);
create index if not exists projects_touched on app.projects(touched_at desc, id desc) where not deleted;
create index if not exists projects_submitted on app.projects(submitted_at) where status = 'submitted' and not deleted;
create index if not exists projects_paid on app.projects(editor_id) include (amount) where received_at is not null and not deleted;
create index if not exists projects_moved on app.projects(moved_at) where status = 'reassigned' and not deleted;
create index if not exists projects_category on app.projects(category_id);
create index if not exists projects_from_editor on app.projects(from_editor);
create index if not exists projects_moved_to on app.projects(moved_to);

create table if not exists app.bonuses (
  id uuid primary key default gen_random_uuid(),
  editor_id uuid not null references app.users(id),
  amount numeric(12,2) not null check (amount > 0),
  label text not null default '' check (char_length(label) <= 80),
  awarded_at timestamptz not null default now(),
  removed boolean not null default false
);
create index if not exists bonuses_editor on app.bonuses(editor_id);

-- Videos an admin has put on everyone's home screen ("Video of the moment"). A pick is never deleted:
-- taking it down, or newer picks pushing it out, stamps taken_at.
create table if not exists app.featured (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references app.projects(id),
  picked_by uuid not null references app.users(id),
  picked_at timestamptz not null default now(),
  taken_at timestamptz
);
create unique index if not exists featured_live on app.featured(project_id) where taken_at is null;
create index if not exists featured_project on app.featured(project_id);
create index if not exists featured_picked_by on app.featured(picked_by);

-- Profile pictures: a small square for lists, and a larger copy of the whole picture for when someone taps
-- it. The larger copy only counts while it belongs to the current picture (avatar_full_ver = avatar_ver).
alter table app.users add column if not exists avatar_at timestamptz;          -- when the person last chose a picture
alter table app.users add column if not exists avatar_full text check (avatar_full is null or char_length(avatar_full) <= 600000);
alter table app.users add column if not exists avatar_full_ver int;
alter table app.meta add column if not exists pic_ask_at timestamptz;          -- when an admin last sent the profile picture reminder

-- Phone notifications. Each phone that allows them leaves its push address here; the address belongs to
-- whoever is signed in on that phone. A phone that is signed out, turned off, or reported gone by its push
-- service is stamped gone_at, never deleted.
create table if not exists app.push_subs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app.users(id),
  endpoint text not null check (char_length(endpoint) between 20 and 1000),
  p256dh text not null check (char_length(p256dh) between 80 and 100),
  auth text not null check (char_length(auth) between 16 and 40),
  created_at timestamptz not null default now(),
  seen_at timestamptz not null default now(),        -- the last time the phone confirmed it
  ok_at timestamptz,                                  -- the last delivery the push service accepted
  gone_at timestamptz
);
create unique index if not exists push_subs_live on app.push_subs(endpoint) where gone_at is null;
create index if not exists push_subs_user on app.push_subs(user_id);

-- Notifications waiting to go out, and a record of each one sent. The sender (an edge function) picks them
-- up within seconds; a timer catches anything it missed and notices deadlines as they pass.
create table if not exists app.outbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app.users(id),
  kind text not null check (kind in ('submitted', 'deadline', 'picture', 'test')),
  project_id uuid references app.projects(id),
  title text not null check (char_length(title) <= 120),
  body text not null check (char_length(body) <= 300),
  created_at timestamptz not null default now(),
  claimed_at timestamptz,                             -- taken by the sender; taken again if not sent within 2 minutes
  sent_at timestamptz,                                -- done: delivered, nobody to deliver to, or given up
  tries int not null default 0,
  result text
);
create index if not exists outbox_pending on app.outbox(created_at) where sent_at is null;
create index if not exists outbox_user on app.outbox(user_id);
create index if not exists outbox_project on app.outbox(project_id);
create unique index if not exists outbox_deadline_once on app.outbox(project_id, user_id) where kind = 'deadline';

-- What the sender needs. The secret is made here and never leaves the database: the database sends it with
-- each nudge, and the sender checks it against this row. The sender makes its own signing keys on its first
-- run and keeps them here; phones get only the public half.
alter table app.meta add column if not exists push_url text;                   -- where the sender runs; set on the live project only
alter table app.meta add column if not exists push_contact text;               -- shown to push services as the sender's contact
alter table app.meta add column if not exists push_secret text;
alter table app.meta add column if not exists vapid_public text;
alter table app.meta add column if not exists vapid_private text;
update app.meta set push_secret = encode(extensions.gen_random_bytes(32), 'hex') where id and push_secret is null;

-- Each editor's payment details: the name on their bank account, a phone number, their bank and the account
-- number. Saving a change adds a row, and the newest row is the one in use; older rows stay as the record,
-- so an admin can be warned when the account pay goes to has just changed.
create table if not exists app.details (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app.users(id),
  full_name text not null check (char_length(full_name) between 2 and 80),
  phone text not null check (char_length(phone) between 7 and 20),
  bank_name text not null check (char_length(bank_name) between 2 and 60),
  bank_account text not null check (bank_account ~ '^[0-9]{10}$'),      -- Nigerian account numbers (NUBAN) have 10 digits
  created_at timestamptz not null default now()
);
create index if not exists details_user on app.details(user_id, created_at desc);

-- Reminders an admin sends from Settings: a new profile picture, payment details, late videos. They wait and
-- go out like the automatic notifications in app.outbox (the sender takes from both) and are kept the same
-- way. They have a table of their own because app.outbox's list of kinds is fixed.
create table if not exists app.reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app.users(id),
  kind text not null check (kind in ('picture', 'details', 'overdue')),
  sent_by uuid references app.users(id),              -- the admin who sent it
  title text not null check (char_length(title) <= 120),
  body text not null check (char_length(body) <= 300),
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  tries int not null default 0,
  result text
);
create index if not exists reminders_pending on app.reminders(created_at) where sent_at is null;
create index if not exists reminders_user on app.reminders(user_id);
create index if not exists reminders_sent_by on app.reminders(sent_by);
alter table app.meta add column if not exists details_ask_at timestamptz;      -- when an admin last sent the payment details reminder
alter table app.meta add column if not exists late_ask_at timestamptz;         -- and the late videos one

-- Uploads to Google Drive. An admin connects the studio's Google Drive in Settings and picks the folders
-- editors may upload to; an editor then uploads a finished video from their phone or computer straight into
-- one of them, and the brief is submitted with the file's link. Only the dn-drive function talks to Google,
-- with Drive's narrowest permission ("drive.file"): the folders the admin picked and the files the app put
-- there, nothing else. The connection's long-lived key from Google (refresh_token) stays in this schema, out
-- of reach of the web API; connecting again or disconnecting closes the old connection, and the row stays.
create table if not exists app.drive (
  id uuid primary key default gen_random_uuid(),
  email text check (email is null or char_length(email) <= 320),       -- the Google account it belongs to
  refresh_token text not null check (char_length(refresh_token) between 10 and 2048),
  connected_by uuid not null references app.users(id),
  connected_at timestamptz not null default now(),
  ended_at timestamptz,
  ended_by uuid references app.users(id),                              -- empty when Google ended it
  end_note text check (end_note is null or char_length(end_note) <= 200)
);
create unique index if not exists drive_live on app.drive((true)) where ended_at is null;
create index if not exists drive_connected_by on app.drive(connected_by);
create index if not exists drive_ended_by on app.drive(ended_by);

-- The folders editors may upload to. Taking one off the list stamps removed_at; the file in Drive is untouched.
create table if not exists app.drive_folders (
  id uuid primary key default gen_random_uuid(),
  folder_id text not null check (folder_id ~ '^[A-Za-z0-9_-]{10,100}$'),  -- Drive's own id for it
  name text not null check (char_length(name) between 1 and 200),
  added_by uuid not null references app.users(id),
  added_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by uuid references app.users(id)
);
create unique index if not exists drive_folders_live on app.drive_folders(folder_id) where removed_at is null;
create index if not exists drive_folders_added_by on app.drive_folders(added_by);
create index if not exists drive_folders_removed_by on app.drive_folders(removed_by);

-- One-time codes that tie Google's answer to the admin who asked to connect (good for 15 minutes, once).
create table if not exists app.drive_states (
  state_hash bytea primary key,
  user_id uuid not null references app.users(id),
  back_to text not null check (char_length(back_to) <= 300),          -- the app's address, to send the admin back to
  created_at timestamptz not null default now(),
  used_at timestamptz
);
create index if not exists drive_states_user on app.drive_states(user_id, created_at desc);

-- Each upload: whose, for which brief, into which folder, and how it ended. session_url is Google's address
-- for sending this file, good for a week, so an upload cut off part way can carry on where it stopped.
create table if not exists app.uploads (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references app.projects(id),
  user_id uuid not null references app.users(id),
  folder uuid not null references app.drive_folders(id),
  file_name text not null check (char_length(file_name) between 1 and 300),
  size bigint not null check (size between 1 and 53687091200),         -- up to 50 GB
  mime text not null check (char_length(mime) between 3 and 100),
  session_url text check (session_url is null or char_length(session_url) <= 2000),
  created_at timestamptz not null default now(),
  file_id text check (file_id is null or char_length(file_id) <= 200),
  link text check (link is null or char_length(link) <= 600),
  done_at timestamptz,
  result text check (result is null or char_length(result) <= 300)
);
create index if not exists uploads_project on app.uploads(project_id);
create index if not exists uploads_user on app.uploads(user_id, created_at desc);
create index if not exists uploads_folder on app.uploads(folder);
-- What Google issued the studio for this, none of it secret: the OAuth client's id, and the API key and Cloud
-- project number Google's folder picker needs (the key only works from the app's pages, for the picker). The
-- client's secret is kept apart, as a secret of the dn-drive function, so this database alone opens nothing.
alter table app.meta add column if not exists google_client_id text check (google_client_id is null or google_client_id ~ '^[A-Za-z0-9._-]{10,200}$');
alter table app.meta add column if not exists google_api_key text check (google_api_key is null or google_api_key ~ '^[A-Za-z0-9_-]{20,100}$');
alter table app.meta add column if not exists google_app_id text check (google_app_id is null or google_app_id ~ '^[0-9]{6,20}$');

-- Row level security is on for every table, with a single rule that lets nobody through. The er_* functions
-- run as the tables' owner, which the rule does not apply to; any other route to the data is refused.
do $$
declare t text;
begin
  foreach t in array array['meta', 'users', 'sessions', 'categories', 'projects', 'bonuses', 'featured', 'push_subs', 'outbox', 'details', 'reminders',
                           'drive', 'drive_folders', 'drive_states', 'uploads'] loop
    execute format('alter table app.%I enable row level security', t);
    if not exists (select 1 from pg_policies where schemaname = 'app' and tablename = t and policyname = 'no_direct_access') then
      execute format('create policy no_direct_access on app.%I for all to public using (false) with check (false)', t);
    end if;
  end loop;
end $$;

create or replace function app.touch() returns trigger language plpgsql set search_path = '' as $$
begin
  new.changed_at := clock_timestamp();
  new.due_at := new.started_at + make_interval(hours => new.due_hours) + new.hold_ms * interval '1 millisecond';
  new.touched_at := greatest(new.started_at, new.updated_at, new.submitted_at, new.moved_at, new.received_at);
  return new;
end $$;
create or replace trigger projects_touch before insert or update on app.projects for each row execute function app.touch();

-- ---------------------------------------------------------------- helpers (private)

create or replace function app.ms(t timestamptz) returns bigint language sql immutable set search_path = '' as $$
  select (extract(epoch from t) * 1000)::bigint
$$;

create or replace function app.who(p_token text) returns app.users language plpgsql set search_path = '' as $$
declare u app.users;
begin
  if p_token is null or char_length(p_token) < 40 then raise exception 'auth'; end if;
  select x.* into u from app.sessions s join app.users x on x.id = s.user_id
   where s.token_hash = sha256(convert_to(p_token, 'UTF8')) and not s.revoked and s.expires_at > now() and x.active;
  if not found then raise exception 'auth'; end if;
  return u;
end $$;

create or replace function app.admin(p_token text) returns app.users language plpgsql set search_path = '' as $$
declare u app.users;
begin
  u := app.who(p_token);
  if u.role <> 'admin' then raise exception 'forbidden'; end if;
  return u;
end $$;

create or replace function app.clean(p text, maxlen int, code text) returns text language plpgsql immutable set search_path = '' as $$
declare v text := btrim(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g'));
begin
  if v = '' or char_length(v) > maxlen then raise exception '%', code; end if;
  return v;
end $$;

create or replace function app.username(p text) returns text language plpgsql immutable set search_path = '' as $$
declare v text := lower(btrim(coalesce(p, '')));
begin
  if v !~ '^[a-z0-9._-]{3,24}$' then raise exception 'bad_username'; end if;
  return v;
end $$;

create or replace function app.password(p text) returns text language plpgsql set search_path = '' as $$
begin
  if p is null or char_length(p) < 8 or octet_length(p) > 72 then raise exception 'weak_password'; end if;
  return extensions.crypt(p, extensions.gen_salt('bf', 10));
end $$;

-- Wrong sign-in tries are counted across all logins, a minute at a time (see er_login).
create or replace function app.failed_login() returns void language sql set search_path = '' as $$
  update app.meta
     set fail_count = case when fail_from is null or fail_from <= now() - interval '1 minute' then 1 else fail_count + 1 end,
         fail_from = case when fail_from is null or fail_from <= now() - interval '1 minute' then now() else fail_from end
   where id
$$;

create or replace function app.new_session(p_user uuid) returns text language plpgsql set search_path = '' as $$
declare t text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  insert into app.sessions(token_hash, user_id, expires_at) values (sha256(convert_to(t, 'UTF8')), p_user, now() + interval '60 days');
  return t;
end $$;

-- A project as the app receives it: "ja" for admins, "je" for the editor who owns it (who is not told
-- which teammate a brief came from or went to). Empty values are left out to keep the replies small.
create or replace view app.pv with (security_invoker = true) as
select p.id, p.editor_id, p.category_id, p.status, p.started_at, p.submitted_at, p.received_at, p.due_at, p.touched_at, p.changed_at, p.deleted,
  json_strip_nulls(json_build_object(
    'id', p.id, 'u', p.editor_id, 'name', p.name, 'cat', p.category_id, 'stage', p.stage, 'status', p.status,
    'started', (extract(epoch from p.started_at) * 1000)::bigint, 'updated', (extract(epoch from p.updated_at) * 1000)::bigint,
    'submitted', (extract(epoch from p.submitted_at) * 1000)::bigint,
    'due', (extract(epoch from p.due_at) * 1000)::bigint, 'grace', (extract(epoch from p.due_at) * 1000)::bigint + p.grace_hours * 3600000::bigint,
    'touched', (extract(epoch from p.touched_at) * 1000)::bigint,
    'link', p.link, 'note', nullif(p.note, ''), 'progress', nullif(p.progress, ''),
    'back', (extract(epoch from p.back_at) * 1000)::bigint, 'backNote', nullif(p.back_note, ''),
    'from', p.from_editor, 'to', p.moved_to,
    'moved', (extract(epoch from p.moved_at) * 1000)::bigint, 'seen', nullif(p.seen_moved, false),
    'received', (extract(epoch from p.received_at) * 1000)::bigint, 'amount', p.amount, 'deleted', nullif(p.deleted, false))) as ja,
  json_strip_nulls(json_build_object(
    'id', p.id, 'u', p.editor_id, 'name', p.name, 'cat', p.category_id, 'stage', p.stage, 'status', p.status,
    'started', (extract(epoch from p.started_at) * 1000)::bigint, 'updated', (extract(epoch from p.updated_at) * 1000)::bigint,
    'submitted', (extract(epoch from p.submitted_at) * 1000)::bigint,
    'due', (extract(epoch from p.due_at) * 1000)::bigint, 'grace', (extract(epoch from p.due_at) * 1000)::bigint + p.grace_hours * 3600000::bigint,
    'touched', (extract(epoch from p.touched_at) * 1000)::bigint,
    'link', p.link, 'note', nullif(p.note, ''), 'progress', nullif(p.progress, ''),
    'back', (extract(epoch from p.back_at) * 1000)::bigint, 'backNote', nullif(p.back_note, ''),
    'from', case when p.from_editor is not null then 'x' end,
    'moved', (extract(epoch from p.moved_at) * 1000)::bigint, 'seen', nullif(p.seen_moved, false),
    'received', (extract(epoch from p.received_at) * 1000)::bigint, 'amount', p.amount, 'deleted', nullif(p.deleted, false))) as je
from app.projects p;

-- top on-time performers since a point in time
create or replace function app.board(p_from timestamptz) returns json language sql stable set search_path = '' as $$
  select coalesce(json_agg(json_build_object('u', t.editor_id, 'on', t.on_n, 'late', t.late_n) order by t.on_n desc, t.late_n, t.editor_id), '[]'::json)
  from (
    select p.editor_id,
           count(*) filter (where p.submitted_at <= p.due_at) as on_n,
           count(*) filter (where p.submitted_at > p.due_at) as late_n
      from app.projects p join app.users x on x.id = p.editor_id and x.active
     where p.status = 'submitted' and not p.deleted and p.submitted_at >= p_from
     group by p.editor_id
    having count(*) filter (where p.submitted_at <= p.due_at) > 0
     order by 2 desc, 3, 1
     limit 10) t
$$;

-- What is on everyone's home screen right now: the newest five picks whose video is still a finished one.
-- Everyone on the team gets the video's name, who made it and its link, because the admin chose to show it.
create or replace function app.featured_now() returns json language sql stable set search_path = '' as $$
  select coalesce(json_agg(json_build_object('id', t.project_id, 'u', t.editor_id, 'name', t.name, 'cat', t.category_id, 'link', t.link, 'at', app.ms(t.picked_at))
                           order by t.picked_at desc, t.id desc), '[]'::json)
  from (
    select f.id, f.project_id, f.picked_at, p.editor_id, p.name, p.category_id, p.link
      from app.featured f join app.projects p on p.id = f.project_id
     where f.taken_at is null and p.status = 'submitted' and not p.deleted and p.link is not null
     order by f.picked_at desc, f.id desc
     limit 5) t
$$;

-- Someone's payment details as they stand now (their newest saved row), or null if they haven't added any.
create or replace function app.details_of(p_user uuid) returns json language sql stable set search_path = '' as $$
  select json_build_object('name', d.full_name, 'phone', d.phone, 'bank', d.bank_name, 'account', d.bank_account, 'at', app.ms(d.created_at))
    from app.details d where d.user_id = p_user
   order by d.created_at desc, d.id desc
   limit 1
$$;

-- What the app is told about Google Drive: whether it's connected, and the folders editors may upload to
-- (editors only see them while it is). Only admins are told which Google account it is, and whether Google
-- itself ended the last connection, so they know to connect again.
create or replace function app.drive_info(p_admin boolean) returns json language sql stable set search_path = '' as $$
  with last as (select d.* from app.drive d order by d.connected_at desc, d.id desc limit 1)
  select json_build_object(
    'on', coalesce((select l.ended_at is null from last l), false),
    'email', case when p_admin then (select l.email from last l where l.ended_at is null) end,
    'lost', case when p_admin then coalesce((select l.ended_at is not null and l.ended_by is null from last l), false) end,
    'folders', case when p_admin or exists (select 1 from last l where l.ended_at is null)
                    then coalesce((select json_agg(json_build_object('id', f.id, 'name', f.name) order by lower(f.name), f.id)
                                     from app.drive_folders f where f.removed_at is null), '[]'::json)
                    else '[]'::json end)
$$;

-- ---------------------------------------------------------------- phone notifications (private)

-- Queues one notification for each of these people who is still on the team and has a phone signed up.
create or replace function app.notify_many(p_users uuid[], p_kind text, p_project uuid, p_title text, p_body text) returns int
language plpgsql set search_path = '' as $$
declare n int;
begin
  insert into app.outbox(user_id, kind, project_id, title, body)
  select x.id, p_kind, p_project, left(p_title, 120), left(p_body, 300)
    from app.users x
   where x.id = any(coalesce(p_users, '{}')) and x.active and x.removed_at is null
     and exists (select 1 from app.push_subs s where s.user_id = x.id and s.gone_at is null)
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- An editor hears once when a brief's delivery time runs out and its grace period starts. Only deadlines
-- that passed in the last 6 hours count, so a phone signed up later is not flooded with old news.
create or replace function app.queue_deadlines() returns int
language plpgsql set search_path = '' as $$
declare n int;
begin
  insert into app.outbox(user_id, kind, project_id, title, body)
  select p.editor_id, 'deadline', p.id, 'Deadline passed: ' || left(p.name, 100),
         case when p.grace_hours > 0 then 'You''re in the ' || p.grace_hours || '-hour grace period now. Submit before it ends, or your admin can reassign it.'
              else 'Submit it as soon as you can. Your admin can now reassign it.' end
    from app.projects p join app.users x on x.id = p.editor_id and x.active and x.removed_at is null
   where p.status = 'active' and not p.deleted and p.due_at <= now() and p.due_at > now() - interval '6 hours'
     and exists (select 1 from app.push_subs s where s.user_id = p.editor_id and s.gone_at is null)
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- Nudges the sender when something is waiting. Where the sender isn't set up (or the web request extension
-- isn't installed) this does nothing; at most one nudge goes out per transaction.
create or replace function app.push_poke() returns void
language plpgsql security definer set search_path = '' as $$
declare m app.meta;
begin
  if current_setting('app.poked', true) = '1' then return; end if;
  select * into m from app.meta;
  if m.push_url is null or m.push_secret is null or to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then return; end if;
  if not exists (select 1 from app.outbox o where o.sent_at is null and (o.claimed_at is null or o.claimed_at < now() - interval '2 minutes'))
     and not exists (select 1 from app.reminders r where r.sent_at is null and (r.claimed_at is null or r.claimed_at < now() - interval '2 minutes')) then return; end if;
  perform set_config('app.poked', '1', true);
  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 20000)'
    using m.push_url, '{}'::jsonb, jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', m.push_secret);
end $$;

create or replace function app.outbox_poke() returns trigger
language plpgsql set search_path = '' as $$
begin
  perform app.push_poke();
  return null;
end $$;
create or replace trigger outbox_poke after insert on app.outbox for each statement execute function app.outbox_poke();
create or replace trigger reminders_poke after insert on app.reminders for each statement execute function app.outbox_poke();

-- Run by the timer every minute: notice deadlines that just passed, and nudge the sender about anything
-- still waiting (a phone that was off, a push service that was busy).
create or replace function app.notice_tick() returns void
language plpgsql set search_path = '' as $$
begin
  perform app.queue_deadlines();
  perform app.push_poke();
end $$;

-- The sender's side. It connects to the database directly and is the only caller of these.
create or replace function app.push_secret_ok(p text) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(m.push_secret is not null and p is not null and m.push_secret = p, false) from app.meta m
$$;

create or replace function app.push_keys() returns table (public_key text, private_key text, contact text)
language sql stable set search_path = '' as $$
  select m.vapid_public, m.vapid_private, m.push_contact from app.meta m
$$;

-- The first keys stored stay: a second sender starting at the same moment keeps the ones already there.
create or replace function app.push_keys_set(p_public text, p_private text) returns void
language sql set search_path = '' as $$
  update app.meta set vapid_public = p_public, vapid_private = p_private
   where id and vapid_public is null and p_public ~ '^[A-Za-z0-9_-]{86,88}$' and p_private ~ '^[A-Za-z0-9_-]{42,44}$'
$$;

-- Hands the sender a batch of waiting notifications and reminders, one row per phone (no phone: one row with
-- no address). Rows taken stay with that sender for 2 minutes; two senders never get the same one.
create or replace function app.push_claim(p_limit int default 100)
returns table (notice uuid, kind text, project uuid, title text, body text, sub uuid, endpoint text, p256dh text, auth text)
language plpgsql set search_path = '' as $$
#variable_conflict use_column
declare lim int := greatest(1, least(coalesce(p_limit, 100), 500));
begin
  return query
  with picked as (
    select o.id from app.outbox o
     where o.sent_at is null and (o.claimed_at is null or o.claimed_at < now() - interval '2 minutes')
     order by o.created_at
     limit lim
     for update skip locked),
  marked as (
    update app.outbox o set claimed_at = now(), tries = o.tries + 1
      from picked where o.id = picked.id
    returning o.id as nid, o.user_id as uid, o.kind as k, o.project_id as pid, o.title as t, o.body as b),
  picked_r as (
    select r.id from app.reminders r
     where r.sent_at is null and (r.claimed_at is null or r.claimed_at < now() - interval '2 minutes')
     order by r.created_at
     limit lim
     for update skip locked),
  marked_r as (
    update app.reminders r set claimed_at = now(), tries = r.tries + 1
      from picked_r where r.id = picked_r.id
    returning r.id as nid, r.user_id as uid, r.kind as k, null::uuid as pid, r.title as t, r.body as b),
  both_ as (select * from marked union all select * from marked_r)
  select m.nid, m.k, m.pid, m.t, m.b, s.id, s.endpoint, s.p256dh, s.auth
    from both_ m left join app.push_subs s on s.user_id = m.uid and s.gone_at is null
   order by m.nid;
end $$;

-- What happened to one notification or reminder. Delivered to any phone, or nobody left to deliver to: done.
-- Refused for another reason: tried again later, five times at most.
create or replace function app.push_report(p_notice uuid, p_ok uuid[], p_gone uuid[], p_failed int, p_note text default null) returns void
language plpgsql set search_path = '' as $$
declare n_ok int := coalesce(array_length(p_ok, 1), 0); n_fail int := greatest(coalesce(p_failed, 0), 0);
begin
  if n_ok > 0 then update app.push_subs set ok_at = now() where id = any(p_ok); end if;
  if coalesce(array_length(p_gone, 1), 0) > 0 then update app.push_subs set gone_at = now() where id = any(p_gone) and gone_at is null; end if;
  update app.outbox o
     set sent_at = case when n_ok > 0 or n_fail = 0 or o.tries >= 5 then now() end,
         result = case when n_ok > 0 then 'delivered to ' || n_ok || case when n_ok = 1 then ' phone' else ' phones' end
                       when n_fail = 0 then 'no phones'
                       when o.tries >= 5 then left('gave up: ' || coalesce(p_note, 'refused'), 200)
                       else left('will try again: ' || coalesce(p_note, 'refused'), 200) end
   where o.id = p_notice and o.sent_at is null;
  update app.reminders r
     set sent_at = case when n_ok > 0 or n_fail = 0 or r.tries >= 5 then now() end,
         result = case when n_ok > 0 then 'delivered to ' || n_ok || case when n_ok = 1 then ' phone' else ' phones' end
                       when n_fail = 0 then 'no phones'
                       when r.tries >= 5 then left('gave up: ' || coalesce(p_note, 'refused'), 200)
                       else left('will try again: ' || coalesce(p_note, 'refused'), 200) end
   where r.id = p_notice and r.sent_at is null;
end $$;

-- ---------------------------------------------------------------- sign-in

create or replace function public.er_status() returns json language sql stable security definer set search_path = '' as $$
  select json_build_object('ready', exists (select 1 from app.users), 'now', app.ms(clock_timestamp()))
$$;

-- First run only: whoever holds the setup code creates the owner's admin login.
create or replace function public.er_setup(p_code text, p_name text, p_username text, p_password text, p_tz text default null) returns json
language plpgsql security definer set search_path = '' as $$
declare m app.meta; v_id uuid; v_user text; v_name text; v_tz text := 'UTC';
begin
  select * into m from app.meta;
  if exists (select 1 from app.users) then return json_build_object('ok', false, 'error', 'setup_done'); end if;
  if m.setup_tries >= 10 then return json_build_object('ok', false, 'error', 'locked'); end if;
  if m.setup_hash is null or encode(sha256(convert_to(upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')), 'UTF8')), 'hex') <> m.setup_hash then
    update app.meta set setup_tries = setup_tries + 1 where id;
    return json_build_object('ok', false, 'error', 'bad_code');
  end if;
  v_user := lower(btrim(coalesce(p_username, '')));
  v_name := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  if v_user !~ '^[a-z0-9._-]{3,24}$' then return json_build_object('ok', false, 'error', 'bad_username'); end if;
  if v_name = '' or char_length(v_name) > 40 then return json_build_object('ok', false, 'error', 'bad_name'); end if;
  if p_password is null or char_length(p_password) < 8 or octet_length(p_password) > 72 then return json_build_object('ok', false, 'error', 'weak_password'); end if;
  if p_tz is not null and exists (select 1 from pg_catalog.pg_timezone_names where name = p_tz) then v_tz := p_tz; end if;
  insert into app.users(username, name, role, owner, pass_hash) values (v_user, v_name, 'admin', true, app.password(p_password)) returning id into v_id;
  update app.meta set setup_hash = null, tz = v_tz where id;
  return json_build_object('ok', true, 'token', app.new_session(v_id));
end $$;

-- Returns ok:false instead of raising, so the count of wrong tries is kept. Eight wrong tries lock one login
-- for 15 minutes; more than 30 wrong tries a minute across all logins pause sign-in until the minute is up.
create or replace function public.er_login(p_username text, p_password text) returns json
language plpgsql security definer set search_path = '' as $$
declare u app.users; m app.meta;
begin
  select * into m from app.meta;
  if m.fail_from is not null and m.fail_from > now() - interval '1 minute' and m.fail_count >= 30 then return json_build_object('ok', false, 'error', 'busy'); end if;
  select * into u from app.users where username = lower(btrim(coalesce(p_username, ''))) and removed_at is null;
  if not found then
    perform extensions.crypt(coalesce(p_password, ''), extensions.gen_salt('bf', 10));   -- same work as a real check
    perform app.failed_login();
    return json_build_object('ok', false, 'error', 'bad_login');
  end if;
  if u.locked_until is not null and u.locked_until > now() then return json_build_object('ok', false, 'error', 'locked'); end if;
  if u.pass_hash <> extensions.crypt(coalesce(p_password, ''), u.pass_hash) then
    if u.failed + 1 >= 8 then update app.users set failed = 0, locked_until = now() + interval '15 minutes' where id = u.id;
    else update app.users set failed = failed + 1 where id = u.id; end if;
    perform app.failed_login();
    return json_build_object('ok', false, 'error', 'bad_login');
  end if;
  if not u.active then return json_build_object('ok', false, 'error', 'inactive'); end if;
  update app.users set failed = 0, locked_until = null, last_seen = now() where id = u.id;
  return json_build_object('ok', true, 'token', app.new_session(u.id));
end $$;

create or replace function public.er_logout(p_token text) returns json
language plpgsql security definer set search_path = '' as $$
begin
  update app.sessions set revoked = true where token_hash = sha256(convert_to(coalesce(p_token, ''), 'UTF8')) and not revoked;
  return json_build_object('ok', true);
end $$;

create or replace function public.er_change_password(p_token text, p_old text, p_new text) returns json
language plpgsql security definer set search_path = '' as $$
declare u app.users;
begin
  u := app.who(p_token);
  if u.pass_hash <> extensions.crypt(coalesce(p_old, ''), u.pass_hash) then return json_build_object('ok', false, 'error', 'bad_login'); end if;
  update app.users set pass_hash = app.password(p_new) where id = u.id;
  update app.sessions set revoked = true where user_id = u.id and token_hash <> sha256(convert_to(p_token, 'UTF8')) and not revoked;
  return json_build_object('ok', true);
end $$;

-- Anyone can set or remove their own picture. Names show on work, pay and the leaderboard, so only an admin
-- can change one: their own here, an editor's through er_update_user.
create or replace function public.er_set_profile(p_token text, p_name text default null, p_avatar text default null) returns json
language plpgsql security definer set search_path = '' as $$
declare u app.users; v_name text;
begin
  u := app.who(p_token);
  if p_name is not null then
    v_name := app.clean(p_name, 40, 'bad_name');
    if v_name <> u.name then
      if u.role <> 'admin' then raise exception 'forbidden'; end if;
      update app.users set name = v_name where id = u.id;
    end if;
  end if;
  if p_avatar = '' then
    update app.users set avatar = null, avatar_full = null, avatar_full_ver = null, avatar_ver = avatar_ver + 1 where id = u.id and avatar is not null;
  elsif p_avatar is not null then
    if char_length(p_avatar) > 60000 or p_avatar !~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$' then raise exception 'bad_picture'; end if;
    update app.users set avatar = p_avatar, avatar_full = null, avatar_full_ver = null, avatar_ver = avatar_ver + 1, avatar_at = now() where id = u.id;
  end if;
  return json_build_object('ok', true);
end $$;

-- A new picture of your own: the small square everyone's lists use, and optionally the whole picture,
-- larger, for when someone taps it. An empty p_avatar removes the picture.
create or replace function public.er_set_picture(p_token text, p_avatar text, p_full text default null) returns json
language plpgsql security definer set search_path = '' as $$
declare u app.users;
begin
  u := app.who(p_token);
  if p_avatar is null then raise exception 'invalid'; end if;
  if p_avatar = '' then
    update app.users set avatar = null, avatar_full = null, avatar_full_ver = null, avatar_ver = avatar_ver + 1 where id = u.id and avatar is not null;
    return json_build_object('ok', true);
  end if;
  if char_length(p_avatar) > 60000 or p_avatar !~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$' then raise exception 'bad_picture'; end if;
  if p_full is not null and (char_length(p_full) > 600000 or p_full !~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$') then raise exception 'bad_picture'; end if;
  update app.users set avatar = p_avatar, avatar_ver = avatar_ver + 1, avatar_at = now(),
         avatar_full = p_full, avatar_full_ver = case when p_full is null then null else avatar_ver + 1 end
   where id = u.id;
  return json_build_object('ok', true);
end $$;

-- Anyone signed in can see a teammate's picture full size (the leaderboard shows them to everyone anyway).
-- Pictures chosen before larger copies were kept come back as the small square.
create or replace function public.er_avatar_full(p_token text, p_user uuid) returns json
language plpgsql security definer set search_path = '' as $$
declare u app.users; t app.users; big boolean;
begin
  u := app.who(p_token);
  select * into t from app.users where id = p_user and removed_at is null;
  if not found or t.avatar is null then return json_build_object('url', null); end if;
  big := t.avatar_full is not null and t.avatar_full_ver = t.avatar_ver;
  return json_build_object('ver', t.avatar_ver, 'full', big, 'url', case when big then t.avatar_full else t.avatar end);
end $$;

create or replace function public.er_avatars(p_token text, p_ids json) returns json
language plpgsql security definer set search_path = '' as $$
declare u app.users; r json;
begin
  u := app.who(p_token);
  select coalesce(json_object_agg(x.id, x.avatar), '{}'::json) into r
    from app.users x
   where x.avatar is not null
     and x.id::text in (select e from json_array_elements_text(coalesce(p_ids, '[]'::json)) e limit 80);
  return r;
end $$;

-- ---------------------------------------------------------------- everything a screen needs, in one call

-- A first call (p_since null) returns the current picture; later calls return only the projects that changed.
-- The reply stays small however much history there is: an admin gets every project that is still open plus
-- the last 8 days, with the figures for editors and categories worked out here; older projects are read a
-- page at a time through er_history. An editor gets their own latest 400.
create or replace function public.er_state(p_token text, p_since bigint default null) returns json
language plpgsql security definer set search_path = '' as $$
declare
  u app.users; m app.meta; adm boolean; t0 timestamptz := clock_timestamp(); since timestamptz;
  ws timestamp; w0 timestamptz; cut4 timestamptz; mo timestamptz; horizon timestamptz; edge timestamptz; n int;
  j_weeks json; j_bw json; j_bm json; j_aw json; j_users json; j_cats json; j_bonuses json; j_totals json; j_projects json; j_stats json; j_feat json;
begin
  u := app.who(p_token);
  adm := u.role = 'admin';
  select * into m from app.meta;
  update app.users set last_seen = t0 where id = u.id and (last_seen is null or last_seen < t0 - interval '10 minutes');
  update app.sessions set expires_at = t0 + interval '60 days'
   where token_hash = sha256(convert_to(p_token, 'UTF8')) and not revoked and expires_at < t0 + interval '50 days';
  if p_since is not null then since := to_timestamp(p_since / 1000.0) - interval '5 seconds'; end if;

  -- weeks (Monday to Sunday) and months follow the team's time zone, the same for everyone
  ws := date_trunc('week', t0 at time zone m.tz);
  w0 := (ws - interval '35 days') at time zone m.tz;        -- start of the six weeks shown per editor
  cut4 := (ws - interval '21 days') at time zone m.tz;      -- start of the "last 4 weeks" figures
  mo := date_trunc('month', t0 at time zone m.tz) at time zone m.tz;
  select json_agg(app.ms((ws - make_interval(days => 7 * i)) at time zone m.tz) order by i desc) into j_weeks from generate_series(0, 5) i;
  j_bw := app.board(ws at time zone m.tz);
  j_bm := app.board(mo);
  select coalesce(json_agg(json_build_object('u', b.editor_id, 'at', app.ms(b.awarded_at), 'label', b.label) order by b.awarded_at desc), '[]'::json) into j_aw
    from (select * from app.bonuses where not removed and awarded_at > t0 - interval '62 days' order by awarded_at desc limit 30) b;
  j_feat := app.featured_now();

  select coalesce(json_agg(json_build_object('id', c.id, 'name', c.name, 'c', c.color, 'rate', c.rate, 'archived', c.archived) order by c.created_at), '[]'::json) into j_cats from app.categories c;

  if adm then
    -- when a great deal changed at once, the current picture is quicker to send than every change
    if since is not null and (select count(*) from (select 1 from app.projects p where p.changed_at > since limit 601) c) > 600 then since := null; end if;

    select coalesce(json_agg(json_build_object(
        'id', x.id, 'name', x.name, 'username', x.username, 'role', x.role, 'owner', x.owner, 'active', x.active,
        'av', x.avatar_ver, 'has', x.avatar is not null, 'created', app.ms(x.created_at), 'seen', app.ms(x.last_seen), 'avAt', app.ms(x.avatar_at),
        'push', exists (select 1 from app.push_subs s where s.user_id = x.id and s.gone_at is null),
        'pay', exists (select 1 from app.details d where d.user_id = x.id),       -- the details themselves come from er_details
        'earned', coalesce((select sum(p.amount) from app.projects p where p.editor_id = x.id and p.received_at is not null and not p.deleted), 0),
        'bonus', coalesce((select sum(b.amount) from app.bonuses b where b.editor_id = x.id and not b.removed), 0),
        -- last sign of work: a brief handed over by the admin counts only once the editor touches it
        'last', (select app.ms(max(greatest(q.updated_at, q.submitted_at))) from (
                   select p.updated_at, p.submitted_at from app.projects p
                    where p.editor_id = x.id and not p.deleted and not (p.from_editor is not null and p.updated_at = p.started_at)
                    order by p.started_at desc limit 30) q),
        'moved', (select count(*) from app.projects p where p.editor_id = x.id and p.status = 'reassigned' and not p.deleted and p.moved_at >= cut4)
      ) order by x.created_at), '[]'::json)
      into j_users from app.users x where x.removed_at is null;

    select coalesce(json_agg(json_build_object('id', b.id, 'u', b.editor_id, 'amt', b.amount, 'label', b.label, 'at', app.ms(b.awarded_at)) order by b.awarded_at desc), '[]'::json)
      into j_bonuses from (select * from app.bonuses where not removed and awarded_at > t0 - interval '100 days' order by awarded_at desc limit 500) b;

    -- per editor: on time and late for each of the last six weeks (twelve numbers, oldest week first),
    -- this month, and the last four weeks with the total turnaround time; per category: the last 70 days
    select json_build_object(
      'editors', coalesce((select json_agg(json_build_object('u', s.editor_id, 'w', s.w, 'mo', json_build_array(s.mo_on, s.mo_late), 'four', json_build_array(s.on4, s.late4, s.turn))) from (
          select q.editor_id,
                 json_build_array(
                   count(*) filter (where q.b <= 0 and q.ok), count(*) filter (where q.b <= 0 and not q.ok),
                   count(*) filter (where q.b = 1 and q.ok), count(*) filter (where q.b = 1 and not q.ok),
                   count(*) filter (where q.b = 2 and q.ok), count(*) filter (where q.b = 2 and not q.ok),
                   count(*) filter (where q.b = 3 and q.ok), count(*) filter (where q.b = 3 and not q.ok),
                   count(*) filter (where q.b = 4 and q.ok), count(*) filter (where q.b = 4 and not q.ok),
                   count(*) filter (where q.b >= 5 and q.ok), count(*) filter (where q.b >= 5 and not q.ok)) as w,
                 count(*) filter (where q.submitted_at >= mo and q.ok) as mo_on,
                 count(*) filter (where q.submitted_at >= mo and not q.ok) as mo_late,
                 count(*) filter (where q.submitted_at >= cut4 and q.ok) as on4,
                 count(*) filter (where q.submitted_at >= cut4 and not q.ok) as late4,
                 coalesce(sum(greatest(0, extract(epoch from (q.submitted_at - q.started_at)) * 1000)) filter (where q.submitted_at >= cut4), 0)::bigint as turn
            from (select p.editor_id, p.started_at, p.submitted_at, p.submitted_at <= p.due_at as ok,
                         floor(extract(epoch from ((p.submitted_at at time zone m.tz) - (ws - interval '35 days'))) / 604800)::int as b
                    from app.projects p
                   where p.status = 'submitted' and not p.deleted and p.submitted_at >= w0) q
           group by q.editor_id) s), '[]'::json),
      'cats', coalesce((select json_agg(json_build_object('cat', c.category_id, 'on', c.on_n, 'late', c.late_n, 'lateMs', c.late_ms)) from (
          select p.category_id,
                 count(*) filter (where p.submitted_at <= p.due_at) as on_n,
                 count(*) filter (where p.submitted_at > p.due_at) as late_n,
                 coalesce(sum(extract(epoch from (p.submitted_at - p.due_at)) * 1000) filter (where p.submitted_at > p.due_at), 0)::bigint as late_ms
            from app.projects p
           where p.status = 'submitted' and not p.deleted and p.submitted_at > t0 - interval '70 days'
           group by p.category_id) c), '[]'::json))
      into j_stats;

    if since is null then
      horizon := t0 - interval '8 days';
      with win as (
        select v.ja, v.touched_at, (v.status = 'active' or (v.status = 'submitted' and v.received_at is null)) as live
          from app.pv v
         where not v.deleted and (v.status = 'active' or (v.status = 'submitted' and v.received_at is null) or v.touched_at > horizon)
         order by 3 desc, 2 desc
         limit 3000)
      select coalesce(json_agg(win.ja), '[]'::json), count(*), min(win.touched_at) filter (where not win.live) into j_projects, n, edge from win;
      if n >= 3000 then horizon := coalesce(edge, t0); end if;      -- the cap cut in: older history starts where this list stopped
    else
      select coalesce(json_agg(v.ja), '[]'::json) into j_projects from app.pv v where v.changed_at > since;
    end if;
  else
    if since is not null and (select count(*) from (select 1 from app.projects p where p.editor_id = u.id and p.changed_at > since limit 301) c) > 300 then since := null; end if;

    -- an editor gets their own work, plus only the names needed to draw the leaderboard and the featured videos
    select coalesce(json_agg(json_build_object('id', x.id, 'name', x.name, 'av', x.avatar_ver, 'has', x.avatar is not null)), '[]'::json) into j_users
      from app.users x
     where x.id = u.id
        or x.id::text in (select e ->> 'u' from json_array_elements(j_bw) e union select e ->> 'u' from json_array_elements(j_bm) e union select e ->> 'u' from json_array_elements(j_aw) e
                          union select e ->> 'u' from json_array_elements(j_feat) e);
    select coalesce(json_agg(json_build_object('id', b.id, 'u', b.editor_id, 'amt', b.amount, 'label', b.label, 'at', app.ms(b.awarded_at)) order by b.awarded_at desc), '[]'::json)
      into j_bonuses from (select * from app.bonuses where editor_id = u.id and not removed order by awarded_at desc limit 300) b;
    if since is null then
      select coalesce(json_agg(v.je), '[]'::json) into j_projects from app.pv v
       where v.id in (select q.id from app.projects q where q.editor_id = u.id and not q.deleted order by q.started_at desc limit 400);
    else
      select coalesce(json_agg(v.je), '[]'::json) into j_projects from app.pv v where v.editor_id = u.id and v.changed_at > since;
    end if;
  end if;

  j_totals := json_build_object(
    'videos', coalesce((select sum(p.amount) from app.projects p where p.editor_id = u.id and p.received_at is not null and not p.deleted), 0),
    'bonus', coalesce((select sum(b.amount) from app.bonuses b where b.editor_id = u.id and not b.removed), 0),
    'month', coalesce((select sum(p.amount) from app.projects p where p.editor_id = u.id and p.received_at >= mo and not p.deleted), 0)
           + coalesce((select sum(b.amount) from app.bonuses b where b.editor_id = u.id and not b.removed and b.awarded_at >= mo), 0));

  return json_build_object(
    'now', app.ms(clock_timestamp()), 'cursor', app.ms(t0), 'full', since is null,
    'me', json_build_object('id', u.id, 'name', u.name, 'username', u.username, 'role', u.role, 'owner', u.owner, 'av', u.avatar_ver, 'has', u.avatar is not null,
                            'avAt', app.ms(u.avatar_at), 'phones', (select count(*) from app.push_subs s where s.user_id = u.id and s.gone_at is null),
                            'details', app.details_of(u.id)),
    'settings', json_build_object('delivery', m.delivery_hours, 'grace', m.grace_hours, 'target', m.weekly_target, 'currency', m.currency, 'tz', m.tz, 'bonus', case when adm then m.bonus_default end,
                                  'push', m.vapid_public, 'picAsk', app.ms(m.pic_ask_at), 'detailsAsk', app.ms(m.details_ask_at), 'lateAsk', app.ms(m.late_ask_at),
                                  'drive', app.drive_info(adm)),
    'cats', j_cats, 'users', j_users, 'weeks', j_weeks, 'month', app.ms(mo),
    'board', json_build_object('week', j_bw, 'month', j_bm, 'awards', j_aw), 'featured', j_feat,
    'bonuses', j_bonuses, 'totals', j_totals, 'stats', j_stats, 'horizon', case when adm and since is null then horizon end,
    'projects', j_projects);
end $$;

-- Older finished projects for the admin's list, newest first, 40 at a time. p_before (and p_before_id, from
-- the previous page's "next") says where to carry on from. Anything still open or waiting is left out: the
-- admin's app always has those already.
create or replace function public.er_history(p_token text, p_before timestamptz, p_before_id uuid default null, p_status text default 'all',
                                             p_editor uuid default null, p_category uuid default null, p_uncat boolean default false) returns json
language plpgsql security definer set search_path = '' as $$
declare u app.users; j json; j_next json; n int;
begin
  u := app.admin(p_token);
  if p_before is null or p_status is null or p_status not in ('all', 'ontime', 'sublate', 'received', 'reassigned', 'submitted') then raise exception 'invalid'; end if;
  with page as (
    select v.id, v.touched_at, v.ja from app.pv v
     where not v.deleted and not (v.status = 'active' or (v.status = 'submitted' and v.received_at is null))
       and v.touched_at <= p_before and (p_before_id is null or (v.touched_at, v.id) < (p_before, p_before_id))
       and (p_editor is null or v.editor_id = p_editor)
       and case when coalesce(p_uncat, false) then v.category_id is null else p_category is null or v.category_id = p_category end
       and (p_status = 'all'
            or (p_status = 'ontime' and v.status = 'submitted' and v.submitted_at <= v.due_at)
            or (p_status = 'sublate' and v.status = 'submitted' and v.submitted_at > v.due_at)
            or (p_status = 'received' and v.status = 'submitted' and v.received_at is not null)
            or (p_status = 'reassigned' and v.status = 'reassigned')
            or (p_status = 'submitted' and v.status = 'submitted'))
     order by v.touched_at desc, v.id desc
     limit 40)
  select coalesce(json_agg(page.ja order by page.touched_at desc, page.id desc), '[]'::json), count(*),
         (select json_build_object('at', l.touched_at, 'id', l.id) from page l order by l.touched_at, l.id limit 1)
    into j, n, j_next from page;
  return json_build_object('rows', j, 'next', case when n = 40 then j_next end);
end $$;

-- ---------------------------------------------------------------- what an editor can do

-- The brief's name, category and deadline are fixed from this moment, and the clock starts on the server.
-- Sending the same brief twice within two minutes (a retry on a bad connection) logs it once.
create or replace function public.er_log_brief(p_token text, p_name text, p_category uuid default null) returns json
language plpgsql security definer set search_path = '' as $$
declare u app.users; v_id uuid; v_name text;
begin
  u := app.who(p_token);
  if p_category is null then
    if exists (select 1 from app.categories where not archived) then raise exception 'need_category'; end if;
  elsif not exists (select 1 from app.categories where id = p_category and not archived) then
    raise exception 'not_found';
  end if;
  v_name := app.clean(p_name, 140, 'bad_name');
  select p.id into v_id from app.projects p
   where p.editor_id = u.id and p.status = 'active' and not p.deleted and p.from_editor is null and p.name = v_name
     and p.category_id is not distinct from p_category and p.started_at > now() - interval '2 minutes'
   order by p.started_at desc limit 1;
  if found then return json_build_object('ok', true, 'id', v_id, 'again', true); end if;
  insert into app.projects(editor_id, name, category_id, due_hours, grace_hours)
  select u.id, v_name, p_category, m.delivery_hours, m.grace_hours from app.meta m returning id into v_id;
  return json_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.er_set_stage(p_token text, p_project uuid, p_stage int) returns json
language plpgsql security definer set search_path = '' as $$
declare u app.users;
begin
  u := app.who(p_token);
  if p_stage is null or p_stage not between 1 and 3 then raise exception 'invalid'; end if;
  update app.projects set stage = p_stage, updated_at = now() where id = p_project and editor_id = u.id and status = 'active' and not deleted;
  if not found then raise exception 'not_found'; end if;
  return json_build_object('ok', true);
end $$;

create or replace function public.er_add_update(p_token text, p_project uuid, p_text text) returns json
language plpgsql security definer set search_path = '' as $$
declare u app.users;
begin
  u := app.who(p_token);
  update app.projects set progress = app.clean(p_text, 240, 'invalid'), updated_at = now() where id = p_project and editor_id = u.id and status = 'active' and not deleted;
  if not found then raise exception 'not_found'; end if;
  return json_build_object('ok', true);
end $$;

-- Every admin's phone pings when a video comes in (an admin submitting their own work isn't told about it).
create or replace function public.er_submit(p_token text, p_project uuid, p_link text, p_note text default '') returns json
language plpgsql security definer set search_path = '' as $$
declare u app.users; p app.projects;
begin
  u := app.who(p_token);
  if p_link is null or char_length(p_link) > 600 or p_link !~ '^https?://[^[:space:]]{4,}$' then raise exception 'bad_link'; end if;
  update app.projects set status = 'submitted', link = p_link, note = left(btrim(coalesce(p_note, '')), 400), submitted_at = now(), updated_at = now()
   where id = p_project and editor_id = u.id and status = 'active' and not deleted
  returning * into p;
  if not found then raise exception 'not_found'; end if;
  perform app.notify_many(array(select x.id from app.users x where x.role = 'admin' and x.active and x.removed_at is null and x.id <> u.id),
    'submitted', p.id, 'Video submitted: ' || left(p.name, 100),
    u.name || case when p.submitted_at <= p.due_at then ' submitted it on time.' else ' submitted it after the deadline.' end);
  return json_build_object('ok', true);
end $$;

create or replace function public.er_ack_moved(p_token text, p_project uuid) returns json
language plpgsql security definer set search_path = '' as $$
declare u app.users;
begin
  u := app.who(p_token);
  update app.projects set seen_moved = true where id = p_project and editor_id = u.id and status = 'reassigned';
  if not found then raise exception 'not_found'; end if;
  return json_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- what an admin can do

create or replace function public.er_receive(p_token text, p_project uuid, p_on boolean) returns json
language plpgsql security definer set search_path = '' as $$
declare u app.users; v_amount numeric;
begin
  u := app.admin(p_token);
  if p_on then
    update app.projects p set received_at = now(), amount = (select c.rate from app.categories c where c.id = p.category_id)
     where p.id = p_project and p.status = 'submitted' and p.received_at is null and not p.deleted returning p.amount into v_amount;
  else
    update app.projects p set received_at = null, amount = null where p.id = p_project and p.status = 'submitted' and p.received_at is not null and not p.deleted;
  end if;
  if not found then raise exception 'not_found'; end if;
  return json_build_object('ok', true, 'amount', v_amount);
end $$;

create or replace function public.er_set_amount(p_token text, p_project uuid, p_amount numeric) returns json
language plpgsql security definer set search_path = '' as $$
declare u app.users;
begin
  u := app.admin(p_token);
  if p_amount is null or p_amount < 0 or p_amount > 1000000000 then raise exception 'invalid'; end if;
  update app.projects set amount = p_amount where id = p_project and status = 'submitted' and received_at is not null and not deleted;
  if not found then raise exception 'not_found'; end if;
  return json_build_object('ok', true);
end $$;

-- Back to the editor to submit again. The time it waited with the admin is added to its deadline.
create or replace function public.er_send_back(p_token text, p_project uuid, p_note text default '') returns json
language plpgsql security definer set search_path = '' as $$
declare u app.users;
begin
  u := app.admin(p_token);
  update app.projects set status = 'active', hold_ms = hold_ms + greatest(0, app.ms(now()) - app.ms(submitted_at)),
         submitted_at = null, link = null, note = '', back_at = now(), back_note = left(btrim(coalesce(p_note, '')), 300)
   where id = p_project and status = 'submitted' and received_at is null and not deleted;
  if not found then raise exception 'not_found'; end if;
  update app.featured set taken_at = now() where project_id = p_project and taken_at is null;      -- it is no longer a finished video
  return json_build_object('ok', true);
end $$;

-- The new editor gets a fresh brief and a fresh clock. The old editor keeps the record, flagged for a notice.
create or replace function public.er_reassign(p_token text, p_project uuid, p_to uuid) returns json
language plpgsql security definer set search_path = '' as $$
declare u app.users; p app.projects; v_id uuid;
begin
  u := app.admin(p_token);
  select * into p from app.projects where id = p_project and status = 'active' and not deleted for update;
  if not found then raise exception 'not_found'; end if;
  if p_to = p.editor_id or not exists (select 1 from app.users where id = p_to and active) then raise exception 'invalid'; end if;
  insert into app.projects(editor_id, name, category_id, from_editor, due_hours, grace_hours)
  select p_to, p.name, p.category_id, p.editor_id, m.delivery_hours, m.grace_hours from app.meta m returning id into v_id;
  update app.projects set status = 'reassigned', moved_to = p_to, moved_at = now(), seen_moved = false where id = p.id;
  return json_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.er_delete_project(p_token text, p_project uuid) returns json
language plpgsql security definer set search_path = '' as $$
declare u app.users;
begin
  u := app.admin(p_token);
  update app.projects set deleted = true where id = p_project and not deleted;
  if not found then raise exception 'not_found'; end if;
  update app.featured set taken_at = now() where project_id = p_project and taken_at is null;
  return json_build_object('ok', true);
end $$;

-- Puts a finished video on everyone's home screen ("Video of the moment"), or takes it down again.
-- At most five show at once: adding a sixth takes the oldest one down.
create or replace function public.er_feature(p_token text, p_project uuid, p_on boolean default true) returns json
language plpgsql security definer set search_path = '' as $$
declare u app.users; n int := 0;
begin
  u := app.admin(p_token);
  if not coalesce(p_on, true) then
    update app.featured set taken_at = now() where project_id = p_project and taken_at is null;
    return json_build_object('ok', true);
  end if;
  if not exists (select 1 from app.projects p where p.id = p_project and p.status = 'submitted' and not p.deleted and p.link is not null) then raise exception 'not_found'; end if;
  insert into app.featured(project_id, picked_by) values (p_project, u.id) on conflict (project_id) where taken_at is null do nothing;
  update app.featured f set taken_at = now()
   where f.taken_at is null
     and f.id not in (select k.id from app.featured k join app.projects q on q.id = k.project_id
                       where k.taken_at is null and q.status = 'submitted' and not q.deleted and q.link is not null
                       order by k.picked_at desc, k.id desc limit 5);
  get diagnostics n = row_count;
  return json_build_object('ok', true, 'dropped', n);
end $$;

-- The same bonus sent twice within two minutes (a retry on a bad connection) is awarded once.
create or replace function public.er_award_bonus(p_token text, p_editor uuid, p_amount numeric, p_label text default '') returns json
language plpgsql security definer set search_path = '' as $$
declare u app.users; v_id uuid; v_label text := left(btrim(regexp_replace(coalesce(p_label, ''), '\s+', ' ', 'g')), 80);
begin
  u := app.admin(p_token);
  if p_amount is null or p_amount <= 0 or p_amount > 1000000000 then raise exception 'invalid'; end if;
  if not exists (select 1 from app.users where id = p_editor and removed_at is null) then raise exception 'not_found'; end if;
  select b.id into v_id from app.bonuses b
   where b.editor_id = p_editor and not b.removed and b.amount = round(p_amount, 2) and b.label = v_label and b.awarded_at > now() - interval '2 minutes'
   order by b.awarded_at desc limit 1;
  if found then return json_build_object('ok', true, 'id', v_id, 'again', true); end if;
  insert into app.bonuses(editor_id, amount, label) values (p_editor, p_amount, v_label) returning id into v_id;
  return json_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.er_remove_bonus(p_token text, p_bonus uuid) returns json
language plpgsql security definer set search_path = '' as $$
declare u app.users;
begin
  u := app.admin(p_token);
  update app.bonuses set removed = true where id = p_bonus and not removed;
  if not found then raise exception 'not_found'; end if;
  return json_build_object('ok', true);
end $$;

-- A new grace period applies straight away to every brief still in progress: the ones being worked on, and the
-- ones waiting with an admin, which could still be sent back. Finished, reassigned and deleted ones keep theirs.
-- A new delivery time applies to briefs logged from then on, so no deadline that is already running moves (and
-- nobody's on-time record changes). Says how many briefs took the new grace period.
create or replace function public.er_save_settings(p_token text, p_delivery int, p_grace int, p_target int default null, p_currency text default '', p_bonus numeric default null) returns json
language plpgsql security definer set search_path = '' as $$
declare u app.users; n int;
begin
  u := app.admin(p_token);
  if p_delivery is null or p_delivery not between 1 and 720 or p_grace is null or p_grace not between 0 and 720
     or (p_target is not null and p_target not between 1 and 999) or char_length(coalesce(p_currency, '')) > 6
     or (p_bonus is not null and (p_bonus < 0 or p_bonus > 1000000000)) then
    raise exception 'invalid';
  end if;
  update app.meta set delivery_hours = p_delivery, grace_hours = p_grace, weekly_target = p_target, currency = btrim(coalesce(p_currency, '')), bonus_default = p_bonus where id;
  update app.projects set grace_hours = p_grace
   where grace_hours <> p_grace and not deleted and (status = 'active' or (status = 'submitted' and received_at is null));
  get diagnostics n = row_count;
  return json_build_object('ok', true, 'briefs', n);
end $$;

-- Briefs in progress follow the grace period in Settings (er_save_settings keeps them in step). Until October
-- 2026 a new grace period reached only briefs logged afterwards; this brings the ones logged before into line,
-- and does nothing once they are.
update app.projects p set grace_hours = m.grace_hours
  from app.meta m
 where p.grace_hours <> m.grace_hours and not p.deleted and (p.status = 'active' or (p.status = 'submitted' and p.received_at is null));

create or replace function public.er_save_category(p_token text, p_id uuid, p_name text, p_rate numeric default null) returns json
language plpgsql security definer set search_path = '' as $$
declare u app.users; v_name text; v_color int; v_id uuid := p_id;
begin
  u := app.admin(p_token);
  v_name := app.clean(p_name, 40, 'bad_name');
  if p_rate is not null and (p_rate < 0 or p_rate > 1000000000) then raise exception 'invalid'; end if;
  if exists (select 1 from app.categories c where not c.archived and lower(c.name) = lower(v_name) and (p_id is null or c.id <> p_id)) then raise exception 'taken'; end if;
  if p_id is null then
    if (select count(*) from app.categories where not archived) >= 60 then raise exception 'full'; end if;
    select c into v_color from generate_series(0, 7) c order by (select count(*) from app.categories k where k.color = c and not k.archived), c limit 1;
    insert into app.categories(name, color, rate) values (v_name, v_color, p_rate) returning id into v_id;
  else
    update app.categories set name = v_name, rate = p_rate where id = p_id and not archived;
    if not found then raise exception 'not_found'; end if;
  end if;
  return json_build_object('ok', true, 'id', v_id);
end $$;

-- Removed categories are kept out of sight, so projects already logged under them keep their name.
create or replace function public.er_remove_category(p_token text, p_id uuid) returns json
language plpgsql security definer set search_path = '' as $$
declare u app.users;
begin
  u := app.admin(p_token);
  update app.categories set archived = true where id = p_id and not archived;
  if not found then raise exception 'not_found'; end if;
  return json_build_object('ok', true);
end $$;

create or replace function public.er_add_user(p_token text, p_name text, p_username text, p_password text, p_role text default 'editor') returns json
language plpgsql security definer set search_path = '' as $$
declare u app.users; v_user text; v_id uuid;
begin
  u := app.admin(p_token);
  if p_role not in ('admin', 'editor') or (p_role = 'admin' and not u.owner) then raise exception 'forbidden'; end if;
  v_user := app.username(p_username);
  if exists (select 1 from app.users where username = v_user) then raise exception 'taken'; end if;
  insert into app.users(username, name, role, pass_hash) values (v_user, app.clean(p_name, 40, 'bad_name'), p_role, app.password(p_password)) returning id into v_id;
  return json_build_object('ok', true, 'id', v_id);
end $$;

-- Rename, switch a login on or off, change a role, set a new password or take a picture down.
-- Only the owner changes roles or touches other admins, and nobody else can change the owner.
create or replace function public.er_update_user(p_token text, p_user uuid, p_name text default null, p_active boolean default null, p_role text default null, p_password text default null, p_avatar text default null) returns json
language plpgsql security definer set search_path = '' as $$
declare u app.users; t app.users;
begin
  u := app.admin(p_token);
  select * into t from app.users where id = p_user and removed_at is null;
  if not found then raise exception 'not_found'; end if;
  if t.id <> u.id and (t.owner or (t.role = 'admin' and not u.owner)) then raise exception 'forbidden'; end if;
  if p_role is not null then
    if not u.owner or t.owner or p_role not in ('admin', 'editor') then raise exception 'forbidden'; end if;
    update app.users set role = p_role where id = t.id;
  end if;
  if p_active is not null then
    if t.id = u.id or t.owner then raise exception 'forbidden'; end if;
    update app.users set active = p_active, failed = 0, locked_until = null where id = t.id;
    if not p_active then update app.sessions set revoked = true where user_id = t.id and not revoked; end if;
  end if;
  if p_name is not null then update app.users set name = app.clean(p_name, 40, 'bad_name') where id = t.id; end if;
  if p_password is not null then
    update app.users set pass_hash = app.password(p_password), failed = 0, locked_until = null where id = t.id;
    if t.id <> u.id then update app.sessions set revoked = true where user_id = t.id and not revoked; end if;
  end if;
  if p_avatar is not null then
    if p_avatar <> '' then raise exception 'invalid'; end if;     -- an admin can remove someone's picture, not choose it
    update app.users set avatar = null, avatar_full = null, avatar_full_ver = null, avatar_ver = avatar_ver + 1 where id = t.id and avatar is not null;
  end if;
  return json_build_object('ok', true);
end $$;

-- A login made by mistake can be removed while nothing is on its record: it disappears from the team, can
-- no longer sign in, and its username becomes free again. The row itself stays as an empty shell. A login
-- with work or bonuses is kept (switch it off instead), so past projects and pay always have a name.
create or replace function public.er_delete_user(p_token text, p_user uuid) returns json
language plpgsql security definer set search_path = '' as $$
declare u app.users; t app.users;
begin
  u := app.admin(p_token);
  select * into t from app.users where id = p_user and removed_at is null;
  if not found then raise exception 'not_found'; end if;
  if t.id = u.id or t.owner or (t.role = 'admin' and not u.owner) then raise exception 'forbidden'; end if;
  if exists (select 1 from app.projects p where not p.deleted and (p.editor_id = t.id or p.from_editor = t.id or p.moved_to = t.id))
     or exists (select 1 from app.bonuses b where b.editor_id = t.id and not b.removed) then
    raise exception 'in_use';
  end if;
  update app.users set removed_at = now(), active = false, username = 'x-' || left(replace(id::text, '-', ''), 22),
         pass_hash = '!', avatar = null, avatar_full = null, avatar_full_ver = null, avatar_ver = avatar_ver + 1, failed = 0, locked_until = null
   where id = t.id;
  update app.sessions set revoked = true where user_id = t.id and not revoked;
  update app.push_subs set gone_at = now() where user_id = t.id and gone_at is null;
  return json_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- payment details

-- An editor saves their own payment details. Spaces and dashes in the account number are dropped, and what
-- is left must be 10 digits. Saving the same details again adds nothing; a login can change them at most
-- 10 times a day.
create or replace function public.er_save_details(p_token text, p_name text, p_phone text, p_bank text, p_account text) returns json
language plpgsql security definer set search_path = '' as $$
declare u app.users; cur app.details; v_name text; v_phone text; v_bank text; v_account text;
begin
  u := app.who(p_token);
  v_name := app.clean(p_name, 80, 'bad_full_name');
  if char_length(v_name) < 2 then raise exception 'bad_full_name'; end if;
  v_phone := app.clean(p_phone, 20, 'bad_phone');
  if v_phone !~ '^\+?[0-9 ()-]+$' or char_length(regexp_replace(v_phone, '[^0-9]', '', 'g')) not between 7 and 15 then raise exception 'bad_phone'; end if;
  v_bank := app.clean(p_bank, 60, 'bad_bank');
  if char_length(v_bank) < 2 then raise exception 'bad_bank'; end if;
  v_account := regexp_replace(coalesce(p_account, ''), '[[:space:]-]', '', 'g');
  if v_account !~ '^[0-9]{10}$' then raise exception 'bad_account'; end if;
  select * into cur from app.details d where d.user_id = u.id order by d.created_at desc, d.id desc limit 1;
  if found and cur.full_name = v_name and cur.phone = v_phone and cur.bank_name = v_bank and cur.bank_account = v_account then
    return json_build_object('ok', true, 'same', true);
  end if;
  if (select count(*) from app.details d where d.user_id = u.id and d.created_at > now() - interval '1 day') >= 10 then raise exception 'too_many'; end if;
  insert into app.details(user_id, full_name, phone, bank_name, bank_account) values (u.id, v_name, v_phone, v_bank, v_account);
  return json_build_object('ok', true);
end $$;

-- Payment details: everyone can read their own, and an admin anyone's. When the bank or the account number
-- changed in the last 30 days, the reply also says when, and where pay went before (the bank and the last
-- 4 digits), so the admin can check before paying.
create or replace function public.er_details(p_token text, p_user uuid) returns json
language plpgsql security definer set search_path = '' as $$
declare u app.users; cur app.details; prev app.details; since timestamptz; changed json;
begin
  u := app.who(p_token);
  if p_user is null then raise exception 'invalid'; end if;
  if p_user <> u.id and u.role <> 'admin' then raise exception 'forbidden'; end if;
  if not exists (select 1 from app.users x where x.id = p_user and x.removed_at is null) then raise exception 'not_found'; end if;
  select * into cur from app.details d where d.user_id = p_user order by d.created_at desc, d.id desc limit 1;
  if not found then return json_build_object('details', null, 'changed', null); end if;
  select * into prev from app.details d
   where d.user_id = p_user and (d.bank_account <> cur.bank_account or lower(d.bank_name) <> lower(cur.bank_name))
   order by d.created_at desc, d.id desc limit 1;
  if found then
    -- when the account in use now took over
    select min(d.created_at) into since from app.details d where d.user_id = p_user and d.created_at > prev.created_at;
    if since > now() - interval '30 days' then
      changed := json_build_object('at', app.ms(since), 'bank', prev.bank_name, 'last4', right(prev.bank_account, 4));
    end if;
  end if;
  return json_build_object('details', app.details_of(p_user), 'changed', changed);
end $$;

-- ---------------------------------------------------------------- phone notifications

-- A phone that allows notifications signs up here, for whoever is signed in on it. Signing in as someone
-- else on the same phone moves it to them. Only the big push services' addresses are accepted.
create or replace function public.er_save_push(p_token text, p_endpoint text, p_key text, p_auth text) returns json
language plpgsql security definer set search_path = '' as $$
declare u app.users; v_host text; n int;
begin
  u := app.who(p_token);
  if p_endpoint is null or char_length(p_endpoint) > 1000 or p_endpoint !~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?/[^[:space:]]+$' then raise exception 'invalid'; end if;
  v_host := lower(substring(p_endpoint from '^https://([A-Za-z0-9.-]+)'));
  if not (v_host like '%.googleapis.com' or v_host like '%.push.apple.com' or v_host = 'push.services.mozilla.com' or v_host like '%.push.services.mozilla.com' or v_host like '%.notify.windows.com') then
    raise exception 'invalid';
  end if;
  if p_key is null or p_key !~ '^[A-Za-z0-9_-]{86,88}={0,2}$' or p_auth is null or p_auth !~ '^[A-Za-z0-9_-]{16,32}={0,2}$' then raise exception 'invalid'; end if;
  insert into app.push_subs(user_id, endpoint, p256dh, auth) values (u.id, p_endpoint, p_key, p_auth)
  on conflict (endpoint) where gone_at is null do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, seen_at = now();
  select count(*) into n from app.push_subs where user_id = u.id and gone_at is null;
  return json_build_object('ok', true, 'phones', n);
end $$;

-- Turning notifications off on a phone, or signing out of it.
create or replace function public.er_drop_push(p_token text, p_endpoint text) returns json
language plpgsql security definer set search_path = '' as $$
declare u app.users;
begin
  u := app.who(p_token);
  update app.push_subs set gone_at = now() where endpoint = p_endpoint and user_id = u.id and gone_at is null;
  return json_build_object('ok', true);
end $$;

-- A test notification to your own phones.
create or replace function public.er_test_push(p_token text) returns json
language plpgsql security definer set search_path = '' as $$
declare u app.users; n int; k int;
begin
  u := app.who(p_token);
  n := app.notify_many(array[u.id], 'test', null, 'Notifications are on',
    case when u.role = 'admin' then 'This phone will ping you when an editor submits a video.' else 'This phone will ping you when a video reaches its deadline.' end);
  select count(*) into k from app.push_subs where user_id = u.id and gone_at is null;
  return json_build_object('ok', true, 'phones', k, 'queued', n);
end $$;

-- An admin sends one of three reminders, each only to the editors who still have to do what it asks:
--   picture   editors without a profile picture (their home screen asks for one too, until they add it)
--   details   editors who haven't added payment details (their home screen asks for them too)
--   overdue   editors with videos past their deadline, named in the message
-- Editors with notifications on get it on their phone ("phones" counts them). The same reminder sent again
-- within 10 minutes sends nothing new, and one that concerns nobody sends nothing at all.
create or replace function public.er_remind(p_token text, p_kind text) returns json
language plpgsql security definer set search_path = '' as $$
declare u app.users; m app.meta; last timestamptz; ids uuid[]; n int := 0;
begin
  u := app.admin(p_token);
  if p_kind is null or p_kind not in ('picture', 'details', 'overdue') then raise exception 'invalid'; end if;
  select * into m from app.meta;
  if p_kind = 'picture' then
    last := m.pic_ask_at;
    select coalesce(array_agg(x.id), '{}') into ids from app.users x where x.role = 'editor' and x.active and x.removed_at is null
       and x.avatar is null;
  elsif p_kind = 'details' then
    last := m.details_ask_at;
    select coalesce(array_agg(x.id), '{}') into ids from app.users x where x.role = 'editor' and x.active and x.removed_at is null
       and not exists (select 1 from app.details d where d.user_id = x.id);
  else
    last := m.late_ask_at;
    select coalesce(array_agg(distinct p.editor_id), '{}') into ids from app.projects p join app.users x on x.id = p.editor_id
     where p.status = 'active' and not p.deleted and p.due_at <= now() and x.active and x.removed_at is null;
  end if;
  if coalesce(array_length(ids, 1), 0) = 0 then return json_build_object('ok', true, 'editors', 0, 'phones', 0); end if;
  if last is not null and last > now() - interval '10 minutes' then
    return json_build_object('ok', true, 'editors', array_length(ids, 1), 'phones', 0, 'again', true);
  end if;
  update app.meta set pic_ask_at = case when p_kind = 'picture' then now() else pic_ask_at end,
                      details_ask_at = case when p_kind = 'details' then now() else details_ask_at end,
                      late_ask_at = case when p_kind = 'overdue' then now() else late_ask_at end
   where id;
  insert into app.reminders(user_id, kind, sent_by, title, body)
  select x.id, p_kind, u.id, t.title, t.body
    from app.users x
    cross join lateral (
      select case p_kind when 'picture' then 'Add a profile picture'
                         when 'details' then 'Add your payment details'
                         else case when l.n = 1 then 'Submit your video: ' || left(l.name, 90) else 'Submit your ' || l.n || ' late videos' end end as title,
             case p_kind when 'picture' then 'Your admin asked you to add one. It shows next to your name on the leaderboard. Tap to add it.'
                         when 'details' then 'Your admin needs your full name, phone number and bank account to pay you. Tap to add them.'
                         else case when l.n = 1 then 'It''s past its deadline. Submit it as soon as you can.'
                                   else 'They''re past their deadline, starting with ' || left(l.name, 80) || '. Submit them as soon as you can.' end end as body
        from (select count(*)::int as n, (array_agg(p.name order by p.due_at))[1] as name
                from app.projects p where p.editor_id = x.id and p.status = 'active' and not p.deleted and p.due_at <= now()) l) t
   where x.id = any(ids) and exists (select 1 from app.push_subs s where s.user_id = x.id and s.gone_at is null);
  get diagnostics n = row_count;
  return json_build_object('ok', true, 'editors', array_length(ids, 1), 'phones', n);
end $$;

-- The profile picture reminder, as copies of the app from before reminders still ask for it.
create or replace function public.er_ask_pictures(p_token text) returns json
language sql security definer set search_path = '' as $$
  select public.er_remind(p_token, 'picture')
$$;

-- ---------------------------------------------------------------- Google Drive uploads
-- The dn-drive function calls the app.drive_* functions below over its own database connection; the web API
-- can't reach them. Each one that acts for someone checks their session token first, as the er_* ones do.

-- An admin asks to connect: a one-time code for Google to hand back, tied to them and to where they came from.
create or replace function app.drive_begin(p_token text, p_back text) returns text
language plpgsql set search_path = '' as $$
declare u app.users; v text := encode(extensions.gen_random_bytes(24), 'hex');
begin
  u := app.admin(p_token);
  if p_back is null or char_length(p_back) > 300 or p_back !~ '^https?://[^[:space:]]+$' then raise exception 'invalid'; end if;
  if (select count(*) from app.drive_states s where s.user_id = u.id and s.created_at > now() - interval '1 hour') >= 20 then raise exception 'too_many'; end if;
  insert into app.drive_states(state_hash, user_id, back_to) values (sha256(convert_to(v, 'UTF8')), u.id, p_back);
  return v;
end $$;

-- Google's answer comes back with that code: it works once, within 15 minutes, for someone who is still an admin.
create or replace function app.drive_take(p_state text) returns table(who uuid, back text)
language sql set search_path = '' as $$
  update app.drive_states s set used_at = now()
    from app.users x
   where s.state_hash = sha256(convert_to(coalesce(p_state, ''), 'UTF8')) and s.used_at is null and s.created_at > now() - interval '15 minutes'
     and x.id = s.user_id and x.active and x.role = 'admin' and x.removed_at is null
  returning s.user_id, s.back_to
$$;

-- The connection Google handed over; it replaces any earlier one.
create or replace function app.drive_link(p_user uuid, p_email text, p_refresh text) returns uuid
language plpgsql set search_path = '' as $$
declare v_id uuid;
begin
  if not exists (select 1 from app.users x where x.id = p_user and x.active and x.role = 'admin' and x.removed_at is null) then raise exception 'forbidden'; end if;
  update app.drive set ended_at = now(), ended_by = p_user, end_note = 'replaced by a newer connection' where ended_at is null;
  insert into app.drive(email, refresh_token, connected_by) values (left(p_email, 320), p_refresh, p_user) returning id into v_id;
  return v_id;
end $$;

-- What Google issued the studio (see app.meta), for the function.
create or replace function app.drive_config() returns table(client_id text, api_key text, app_id text)
language sql stable set search_path = '' as $$
  select m.google_client_id, m.google_api_key, m.google_app_id from app.meta m
$$;

-- The live connection, which the function trades with Google for a key that lasts an hour.
create or replace function app.drive_key() returns table(conn uuid, refresh text, account text)
language sql stable set search_path = '' as $$
  select d.id, d.refresh_token, d.email from app.drive d where d.ended_at is null
$$;

-- Google says the connection no longer works: its owner took the app's access away, or it lapsed.
create or replace function app.drive_lost(p_id uuid, p_why text) returns void
language sql set search_path = '' as $$
  update app.drive set ended_at = now(), end_note = left(coalesce(p_why, 'Google ended the connection'), 200) where id = p_id and ended_at is null
$$;

-- An admin disconnects. The key is handed back so the function can ask Google to forget it as well.
create or replace function app.drive_unlink(p_token text) returns text
language plpgsql set search_path = '' as $$
declare u app.users; v text;
begin
  u := app.admin(p_token);
  update app.drive set ended_at = now(), ended_by = u.id, end_note = 'disconnected' where ended_at is null returning refresh_token into v;
  return v;
end $$;

-- Folders an admin picked in Google's folder picker, already checked with Google by the function: [{id, name}].
-- A folder already on the list keeps its place and takes the name it has in Drive now.
create or replace function app.drive_add_folders(p_token text, p_folders jsonb) returns int
language plpgsql set search_path = '' as $$
declare u app.users; n int;
begin
  u := app.admin(p_token);
  if p_folders is null or jsonb_typeof(p_folders) <> 'array' or jsonb_array_length(p_folders) > 50 then raise exception 'invalid'; end if;
  update app.drive_folders f set name = left(btrim(e->>'name'), 200)
    from jsonb_array_elements(p_folders) e
   where f.folder_id = e->>'id' and f.removed_at is null and btrim(coalesce(e->>'name', '')) <> '' and f.name <> left(btrim(e->>'name'), 200);
  insert into app.drive_folders(folder_id, name, added_by)
  select distinct on (e->>'id') e->>'id', left(btrim(e->>'name'), 200), u.id
    from jsonb_array_elements(p_folders) e
   where coalesce(e->>'id', '') ~ '^[A-Za-z0-9_-]{10,100}$' and btrim(coalesce(e->>'name', '')) <> ''
     and not exists (select 1 from app.drive_folders f where f.folder_id = e->>'id' and f.removed_at is null);
  get diagnostics n = row_count;
  if (select count(*) from app.drive_folders f where f.removed_at is null) > 100 then raise exception 'full'; end if;
  return n;
end $$;

-- Someone starts an upload: for their own brief, still in progress, into a folder on the list, while Drive is
-- connected. The file is named after the brief and the editor, so it reads well among the others in Drive.
create or replace function app.drive_start(p_token text, p_project uuid, p_folder uuid, p_size bigint, p_mime text, p_ext text) returns json
language plpgsql set search_path = '' as $$
declare u app.users; p app.projects; f app.drive_folders; v_name text; v_id uuid; v_mime text; v_ext text;
begin
  u := app.who(p_token);
  select * into p from app.projects where id = p_project and editor_id = u.id and status = 'active' and not deleted;
  if not found then raise exception 'not_found'; end if;
  select * into f from app.drive_folders where id = p_folder and removed_at is null;
  if not found then raise exception 'no_folder'; end if;
  if not exists (select 1 from app.drive where ended_at is null) then raise exception 'drive_off'; end if;
  if p_size is null or p_size < 1 or p_size > 53687091200 then raise exception 'too_big'; end if;
  v_mime := lower(btrim(coalesce(p_mime, '')));
  if v_mime = '' then v_mime := 'application/octet-stream'; end if;
  if v_mime !~ '^(video/[a-z0-9.+-]{1,60}|application/octet-stream)$' then raise exception 'not_video'; end if;
  v_ext := lower(coalesce(substring(coalesce(p_ext, '') from '^\.?([A-Za-z0-9]{1,8})$'), ''));
  if (select count(*) from app.uploads x where x.user_id = u.id and x.created_at > now() - interval '1 day') >= 40 then raise exception 'too_many'; end if;
  v_name := left(p.name, 200) || ' (' || left(u.name, 40) || ')' || case when v_ext <> '' then '.' || v_ext else '' end;
  insert into app.uploads(project_id, user_id, folder, file_name, size, mime) values (p.id, u.id, f.id, v_name, p_size, v_mime) returning id into v_id;
  return json_build_object('upload', v_id, 'name', v_name, 'folder', f.folder_id, 'mime', v_mime, 'brief', p.name, 'editor', u.name);
end $$;

create or replace function app.drive_session(p_upload uuid, p_url text) returns void
language sql set search_path = '' as $$
  update app.uploads set session_url = p_url where id = p_upload and done_at is null
$$;

-- One of the caller's own uploads, for carrying on with it or finishing it.
create or replace function app.drive_upload(p_token text, p_upload uuid) returns json
language plpgsql set search_path = '' as $$
declare u app.users; x app.uploads; f app.drive_folders;
begin
  u := app.who(p_token);
  select * into x from app.uploads where id = p_upload and user_id = u.id;
  if not found then raise exception 'not_found'; end if;
  select * into f from app.drive_folders where id = x.folder;
  return json_build_object('upload', x.id, 'project', x.project_id, 'folder', f.folder_id, 'size', x.size, 'session', x.session_url,
                           'done', x.done_at is not null, 'link', x.link, 'fresh', x.created_at > now() - interval '6 days');
end $$;

-- How an upload ended: the file in Drive, and its link once the brief was submitted with it.
create or replace function app.drive_done(p_upload uuid, p_file text, p_link text, p_result text) returns void
language sql set search_path = '' as $$
  update app.uploads set file_id = coalesce(left(p_file, 200), file_id), link = coalesce(left(p_link, 600), link), result = left(p_result, 300),
         done_at = case when p_link is not null then now() else done_at end
   where id = p_upload
$$;

-- An admin takes a folder off the list editors upload to. The folder and what's in it stay in Drive.
create or replace function public.er_drive_remove_folder(p_token text, p_folder uuid) returns json
language plpgsql security definer set search_path = '' as $$
declare u app.users;
begin
  u := app.admin(p_token);
  update app.drive_folders set removed_at = now(), removed_by = u.id where id = p_folder and removed_at is null;
  if not found then raise exception 'not_found'; end if;
  return json_build_object('ok', true);
end $$;

-- The timer, where the database has one (the live project). Locally this does nothing. Once a minute is
-- soon enough for a deadline, and pg_cron writes a line to cron.job_run_details for every run: about 1,440 a
-- day, which would be most of what the database grows by. That log is pg_cron's diary, not the team's
-- records, so every night the lines older than a week are cleared; a week shows whether the timer has run.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $q$select cron.schedule('dn-notices', '* * * * *', 'select app.notice_tick()')$q$;
    execute $q$select cron.schedule('dn-timer-log', '17 3 * * *', $c$delete from cron.job_run_details where end_time < now() - interval '7 days'$c$)$q$;
  end if;
end $$;

-- ---------------------------------------------------------------- who may call what

-- Nothing in "app" is reachable from the web API. The er_* functions are the whole of it: they run for the
-- "anon" role (a visitor holding only the public key) and each one checks the caller's session token itself.
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'er\_%' loop
    execute format('revoke all on function %s from public', r.fn);
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', r.fn); end if;
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('grant execute on function %s to anon', r.fn); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema app from anon';
    execute 'revoke all on all tables in schema app from anon';
    execute 'revoke all on all functions in schema app from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on schema app from authenticated';
    execute 'revoke all on all tables in schema app from authenticated';
    execute 'revoke all on all functions in schema app from authenticated';
  end if;
end $$;

notify pgrst, 'reload schema';
