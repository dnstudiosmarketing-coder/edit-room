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

-- Row level security is on for every table, with a single rule that lets nobody through. The er_* functions
-- run as the tables' owner, which the rule does not apply to; any other route to the data is refused.
do $$
declare t text;
begin
  foreach t in array array['meta', 'users', 'sessions', 'categories', 'projects', 'bonuses', 'featured'] loop
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
    update app.users set avatar = null, avatar_ver = avatar_ver + 1 where id = u.id and avatar is not null;
  elsif p_avatar is not null then
    if char_length(p_avatar) > 60000 or p_avatar !~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$' then raise exception 'bad_picture'; end if;
    update app.users set avatar = p_avatar, avatar_ver = avatar_ver + 1 where id = u.id;
  end if;
  return json_build_object('ok', true);
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
        'av', x.avatar_ver, 'has', x.avatar is not null, 'created', app.ms(x.created_at), 'seen', app.ms(x.last_seen),
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
    'me', json_build_object('id', u.id, 'name', u.name, 'username', u.username, 'role', u.role, 'owner', u.owner, 'av', u.avatar_ver, 'has', u.avatar is not null),
    'settings', json_build_object('delivery', m.delivery_hours, 'grace', m.grace_hours, 'target', m.weekly_target, 'currency', m.currency, 'tz', m.tz, 'bonus', case when adm then m.bonus_default end),
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
  if p_before is null or p_status is null or p_status not in ('all', 'ontime', 'sublate', 'received', 'reassigned') then raise exception 'invalid'; end if;
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
            or (p_status = 'reassigned' and v.status = 'reassigned'))
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

create or replace function public.er_submit(p_token text, p_project uuid, p_link text, p_note text default '') returns json
language plpgsql security definer set search_path = '' as $$
declare u app.users;
begin
  u := app.who(p_token);
  if p_link is null or char_length(p_link) > 600 or p_link !~ '^https?://[^[:space:]]{4,}$' then raise exception 'bad_link'; end if;
  update app.projects set status = 'submitted', link = p_link, note = left(btrim(coalesce(p_note, '')), 400), submitted_at = now(), updated_at = now()
   where id = p_project and editor_id = u.id and status = 'active' and not deleted;
  if not found then raise exception 'not_found'; end if;
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

-- A new delivery time or grace period applies to briefs logged from then on; ones already logged keep theirs.
create or replace function public.er_save_settings(p_token text, p_delivery int, p_grace int, p_target int default null, p_currency text default '', p_bonus numeric default null) returns json
language plpgsql security definer set search_path = '' as $$
declare u app.users;
begin
  u := app.admin(p_token);
  if p_delivery is null or p_delivery not between 1 and 720 or p_grace is null or p_grace not between 0 and 720
     or (p_target is not null and p_target not between 1 and 999) or char_length(coalesce(p_currency, '')) > 6
     or (p_bonus is not null and (p_bonus < 0 or p_bonus > 1000000000)) then
    raise exception 'invalid';
  end if;
  update app.meta set delivery_hours = p_delivery, grace_hours = p_grace, weekly_target = p_target, currency = btrim(coalesce(p_currency, '')), bonus_default = p_bonus where id;
  return json_build_object('ok', true);
end $$;

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
    update app.users set avatar = null, avatar_ver = avatar_ver + 1 where id = t.id and avatar is not null;
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
         pass_hash = '!', avatar = null, avatar_ver = avatar_ver + 1, failed = 0, locked_until = null
   where id = t.id;
  update app.sessions set revoked = true where user_id = t.id and not revoked;
  return json_build_object('ok', true);
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
