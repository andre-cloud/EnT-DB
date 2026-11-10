-- EnT-DB database schema. Run once in the Supabase SQL editor.
-- Safe to re-run: every statement is idempotent.

create extension if not exists pgcrypto with schema extensions;

-- Curators. Add your own address after running this file (see README).
create table if not exists public.admins (
  email text primary key
);
alter table public.admins enable row level security;   -- no policies: readable only through is_admin()

create table if not exists public.entries (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  status         text not null default 'pending' check (status in ('pending','approved','rejected')),
  decided_at     timestamptz,
  -- molecule
  name           text not null,
  smiles         text not null,
  idcode         text,                       -- OpenChemLib canonical code, used to find the same structure
  smiles_checked boolean not null default false,
  structure_note text,
  cls            text,
  role           text not null default 'acceptor' check (role in ('acceptor','donor','both')),
  -- triplet energy
  origin         text not null check (origin in ('exp','calc')),
  et_kcal        numeric not null,
  et_unc         numeric,
  et_reported    text,
  et_type        text,
  method         text,
  conditions     text,
  -- source
  citation       text,
  doi            text,
  location       text,
  quote          text,
  evidence       text,
  pdf_url        text,
  pdf_label      text,
  si_url         text,
  url            text,
  url_label      text,
  verify_level   text,
  verify_note    text,
  -- absorption
  uv             text,
  direct_exc     text,
  -- review
  source_kind    text not null default 'form',
  score          int,
  score_items    jsonb,
  -- never public
  submitted_by   text,
  note           text,
  ip_hash        text
);
-- Key of an entry imported from a literature batch (docs/batches/*.json); makes imports repeatable.
alter table public.entries add column if not exists import_key text;
create unique index if not exists entries_import_key_idx on public.entries (import_key);
-- Papers in which the molecule was used in photocatalysis: [{"doi": "...", "note": "..."}]
alter table public.entries add column if not exists uses jsonb;
create index if not exists entries_status_idx on public.entries (status);
create index if not exists entries_idcode_idx on public.entries (idcode);
create index if not exists entries_ip_idx     on public.entries (ip_hash, created_at);

alter table public.entries enable row level security;

-- True when the signed-in user's account has a confirmed email listed in public.admins.
-- The email is read from auth.users, not from the sign-in token, and must be confirmed,
-- so signing up with a curator's address that has no account yet gives no rights.
create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from auth.users u
    join public.admins a on lower(a.email) = lower(u.email)
    where u.id = auth.uid() and u.email_confirmed_at is not null
  );
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;
-- Only the functions above and below read these tables.
revoke all on public.admins from anon, authenticated;

-- Curators read, edit and delete everything. Nobody else touches the table directly:
-- new rows come only from the "submit" edge function, which uses the service role.
drop policy if exists entries_admin_select on public.entries;
drop policy if exists entries_admin_update on public.entries;
drop policy if exists entries_admin_delete on public.entries;
drop policy if exists entries_admin_insert on public.entries;
-- "(select ...)" makes Postgres call is_admin() once per query instead of once per row.
create policy entries_admin_insert on public.entries for insert to authenticated with check ((select public.is_admin()));
create policy entries_admin_select on public.entries for select to authenticated using ((select public.is_admin()));
create policy entries_admin_update on public.entries for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy entries_admin_delete on public.entries for delete to authenticated using ((select public.is_admin()));

revoke all on public.entries from anon;
revoke all on public.entries from authenticated;
grant select, insert, update, delete on public.entries to authenticated;

-- What the public site reads: approved rows only, without the private columns.
-- The view deliberately runs with its owner's rights so anonymous visitors can read it
-- although they have no access to the table. (Supabase's linter flags this as a
-- "security definer view"; here it is the intended design.)
create or replace view public.public_entries as
select id, created_at, name, smiles, idcode, structure_note, cls, role,
       origin, et_kcal, et_unc, et_reported, et_type, method, conditions,
       citation, doi, location, quote, evidence, pdf_url, pdf_label, si_url, url, url_label,
       verify_level, verify_note, uv, direct_exc, score, uses
from public.entries
where status = 'approved';

-- ---------------------------------------------------------------------------
-- Shared site login (optional).
-- While public.site_access has at least one row, the public data can be read and
-- entries can be submitted only with a matching user name and password.
-- Empty table = open site. Passwords are stored as bcrypt hashes, never in clear.
-- Set or change the login with the statement in the README; open the site with
--   delete from public.site_access;
-- ---------------------------------------------------------------------------
create table if not exists public.site_access (
  username  text primary key,
  pass_hash text not null
);
alter table public.site_access enable row level security;   -- no policies: used only by the functions below
revoke all on public.site_access from anon, authenticated;

create or replace function public.check_access(p_user text default '', p_pass text default '')
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select not exists (select 1 from public.site_access)
      or exists (
        select 1 from public.site_access s
        where s.username = coalesce(p_user, '')
          and s.pass_hash = extensions.crypt(coalesce(p_pass, ''), s.pass_hash)
      );
$$;

create or replace function public.list_entries(p_user text default '', p_pass text default '')
returns setof public.public_entries
language sql stable security definer
set search_path = ''
as $$
  select * from public.public_entries
  where public.check_access(p_user, p_pass);
$$;

-- The view is no longer readable directly: the site goes through list_entries().
revoke all on public.public_entries from anon, authenticated;
revoke all on function public.check_access(text, text) from public, anon, authenticated;
revoke all on function public.list_entries(text, text) from public, anon, authenticated;
grant execute on function public.check_access(text, text) to anon, authenticated, service_role;
grant execute on function public.list_entries(text, text) to anon, authenticated, service_role;
