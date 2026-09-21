-- Shop Timer, database schema
--
-- Run once against a fresh Supabase project:
--   Dashboard → SQL Editor → paste this → Run
--
-- Safe to re-run: every statement is idempotent.
--
-- SECURITY MODEL, read this before deploying
--
-- This is a single-shop app. Row-level security below grants every signed-in
-- user access to all jobs and all hours, which is correct when one deployment
-- serves one shop. It also means an account is all anyone needs to read the
-- shop's entire history.
--
-- So, in the Supabase dashboard, you MUST:
--   1. Authentication → Sign In / Providers → DISABLE email sign-ups
--   2. Authentication → Users → create your shop's user(s) by hand
--
-- Leaving sign-ups on is equivalent to publishing your data: anyone who finds
-- the deployed URL can register and read everything.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- A billable job, usually a client name or a site address.
create table if not exists public.jobs (
  id          uuid primary key default gen_random_uuid(),
  name        text        not null check (length(trim(name)) between 1 and 120),
  is_general  boolean     not null default false,
  archived    boolean     not null default false,
  created_at  timestamptz not null default now()
);

-- One clock-in/clock-out shift.
create table if not exists public.sessions (
  id              uuid primary key default gen_random_uuid(),
  clocked_in_at   timestamptz not null default now(),
  clocked_out_at  timestamptz,
  total_seconds   integer     not null default 0 check (total_seconds >= 0),
  constraint sessions_closed_after_opened
    check (clocked_out_at is null or clocked_out_at >= clocked_in_at)
);

-- A span of time spent on one job within one session.
create table if not exists public.time_entries (
  id                uuid primary key default gen_random_uuid(),
  job_id            uuid        not null references public.jobs(id) on delete cascade,
  session_id        uuid        references public.sessions(id) on delete set null,
  started_at        timestamptz not null default now(),
  ended_at          timestamptz,
  duration_seconds  integer     check (duration_seconds >= 0),
  constraint time_entries_ended_after_started
    check (ended_at is null or ended_at >= started_at)
);

-- `archived` must never be NULL: `.eq('archived', false)` excludes NULL rows in
-- SQL, which silently hid jobs. The app now uses `.not('archived','is',true)`,
-- but the NOT NULL default is the real fix.
alter table public.jobs
  alter column archived set default false;
update public.jobs set archived = false where archived is null;
alter table public.jobs
  alter column archived set not null;

-- ---------------------------------------------------------------------------
-- Indexes, these back the app's hot queries
-- ---------------------------------------------------------------------------

-- Week/day totals filter on started_at.
create index if not exists time_entries_started_at_idx
  on public.time_entries (started_at desc);

-- Finding the running entry for the open session.
create index if not exists time_entries_open_idx
  on public.time_entries (session_id)
  where ended_at is null;

-- Orphan recovery scans for unclosed entries.
create index if not exists time_entries_job_id_idx
  on public.time_entries (job_id);

-- Finding the currently open session.
create index if not exists sessions_open_idx
  on public.sessions (clocked_in_at desc)
  where clocked_out_at is null;

-- The visible job list.
create index if not exists jobs_visible_idx
  on public.jobs (is_general desc, created_at)
  where archived = false;

-- Exactly one General job, it's where unallocated time goes.
create unique index if not exists jobs_single_general_idx
  on public.jobs (is_general)
  where is_general = true;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.jobs         enable row level security;
alter table public.sessions     enable row level security;
alter table public.time_entries enable row level security;

-- Signed-in users get full access; anonymous visitors get nothing. Postgres
-- RLS filters rather than erroring, so an anonymous SELECT returns zero rows.
do $$
declare t text;
begin
  foreach t in array array['jobs', 'sessions', 'time_entries'] loop
    execute format('drop policy if exists "authenticated full access" on public.%I', t);
    execute format(
      'create policy "authenticated full access" on public.%I
         for all to authenticated
         using (true) with check (true)', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Seed
-- ---------------------------------------------------------------------------

-- The General job must exist: clocking in starts its timer, and it catches
-- shop cleanup, admin and anything not billed to a client.
insert into public.jobs (name, is_general)
select 'General', true
where not exists (select 1 from public.jobs where is_general = true);

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------

-- Should return three rows, all with rowsecurity = true.
select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
  and tablename in ('jobs', 'sessions', 'time_entries');
