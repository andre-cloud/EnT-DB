-- EnT-DB database schema. Run once in the Supabase SQL editor.
-- Safe to re-run: every statement is idempotent.

create extension if not exists pgcrypto;

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
create index if not exists entries_status_idx on public.entries (status);
create index if not exists entries_idcode_idx on public.entries (idcode);
create index if not exists entries_ip_idx     on public.entries (ip_hash, created_at);

alter table public.entries enable row level security;

-- True when the signed-in user's email is listed in public.admins.
create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admins a
    where lower(a.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- Curators read, edit and delete everything. Nobody else touches the table directly:
-- new rows come only from the "submit" edge function, which uses the service role.
drop policy if exists entries_admin_select on public.entries;
drop policy if exists entries_admin_update on public.entries;
drop policy if exists entries_admin_delete on public.entries;
create policy entries_admin_select on public.entries for select to authenticated using (public.is_admin());
create policy entries_admin_update on public.entries for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy entries_admin_delete on public.entries for delete to authenticated using (public.is_admin());

revoke all on public.entries from anon;
revoke all on public.entries from authenticated;
grant select, update, delete on public.entries to authenticated;

-- What the public site reads: approved rows only, without the private columns.
-- The view deliberately runs with its owner's rights so anonymous visitors can read it
-- although they have no access to the table. (Supabase's linter flags this as a
-- "security definer view"; here it is the intended design.)
create or replace view public.public_entries as
select id, created_at, name, smiles, idcode, structure_note, cls, role,
       origin, et_kcal, et_unc, et_reported, et_type, method, conditions,
       citation, doi, location, quote, evidence, pdf_url, pdf_label, si_url, url, url_label,
       verify_level, verify_note, uv, direct_exc, score
from public.entries
where status = 'approved';

grant select on public.public_entries to anon, authenticated;
