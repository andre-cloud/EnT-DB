-- TrEnDB database schema. Run once in the Supabase SQL editor.
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
-- CAS registry number, the first key used to recognise the same molecule.
alter table public.entries add column if not exists cas text;
create index if not exists entries_cas_idx on public.entries (cas);
create index if not exists entries_status_idx on public.entries (status);
create index if not exists entries_idcode_idx on public.entries (idcode);
create index if not exists entries_ip_idx     on public.entries (ip_hash, created_at);

alter table public.entries enable row level security;

-- Sources are stored as DOIs only. Links (publisher pages, PDFs, library proxies) are not kept:
-- the link columns are emptied and new values are refused. "not valid" checks new and changed
-- rows only, so an old row with an odd value never blocks other work.
update public.entries set pdf_url = null, pdf_label = null, si_url = null, url = null, url_label = null
where pdf_url is not null or pdf_label is not null or si_url is not null or url is not null or url_label is not null;
-- The first seed rows had links instead of DOIs for three papers; give them their DOIs.
update public.entries set doi = '10.1351/pac197541040559' where doi is null and citation like 'Saltiel, Chang, Megarity%';
update public.entries set doi = '10.1063/1.466936'        where doi is null and citation like 'Swiderek et al., J. Chem. Phys. 1994%';
update public.entries set doi = '10.1021/ja00281a058'     where doi is null and citation like 'Goodman, Peters, Misawa, Caldwell%';
alter table public.entries drop constraint if exists entries_no_links;
alter table public.entries add constraint entries_no_links
  check (pdf_url is null and si_url is null and url is null) not valid;
alter table public.entries drop constraint if exists entries_doi_format;
alter table public.entries add constraint entries_doi_format
  check (doi is null or doi ~ '^10\.[0-9]{4,9}/[^[:space:]]+$') not valid;
alter table public.entries drop constraint if exists entries_cas_format;
alter table public.entries add constraint entries_cas_format
  check (cas is null or cas ~ '^[0-9]{2,7}-[0-9]{2}-[0-9]$') not valid;

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

-- Corrections proposed by readers for approved entries. They arrive through the "submit"
-- function (service role) and appear in the curators' queue; approving one writes only the
-- changed fields into the entry.
create table if not exists public.suggestions (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  status      text not null default 'pending' check (status in ('pending','approved','rejected')),
  decided_at  timestamptz,
  entry_id    uuid not null references public.entries(id) on delete cascade,
  changes     jsonb not null,           -- {field: proposed value}
  comment     text,
  submitted_by text,
  note        text,                     -- curator's note
  ip_hash     text
);
create index if not exists suggestions_status_idx on public.suggestions (status);
create index if not exists suggestions_ip_idx on public.suggestions (ip_hash, created_at);
alter table public.suggestions enable row level security;
drop policy if exists suggestions_admin_select on public.suggestions;
drop policy if exists suggestions_admin_update on public.suggestions;
drop policy if exists suggestions_admin_delete on public.suggestions;
create policy suggestions_admin_select on public.suggestions for select to authenticated using ((select public.is_admin()));
create policy suggestions_admin_update on public.suggestions for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy suggestions_admin_delete on public.suggestions for delete to authenticated using ((select public.is_admin()));
revoke all on public.suggestions from anon, authenticated;
grant select, update, delete on public.suggestions to authenticated;

-- What the public site reads: approved rows only, without the private columns.
-- The view deliberately runs with its owner's rights so anonymous visitors can read it
-- although they have no access to the table. (Supabase's linter flags this as a
-- "security definer view"; here it is the intended design.)
-- (Dropped and recreated, together with list_entries below, because its columns change.)
drop function if exists public.list_entries(text, text);
drop view if exists public.public_entries;
create view public.public_entries as
select id, created_at, name, cas, smiles, idcode, structure_note, cls, role,
       origin, et_kcal, et_unc, et_reported, et_type, method, conditions,
       citation, doi, location, quote, evidence,
       uv, direct_exc, score, uses
       -- verify_level and verify_note are curators' working notes: never public
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
