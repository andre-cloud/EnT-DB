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
  commercial_name text,
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
  uv_lmax        int,
  uv_eps         int,
  uv_cond        text,
  direct_exc     jsonb,
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
-- Reactions the molecule was employed in (at most 10), drawn with the reaction sketcher:
-- [{"doi", "role": "donor"|"acceptor", "reactants": [smiles], "products": [smiles], "catalyst": smiles|null,
--   "loading", "wavelength": nm, "temperature", "solvent", "description" (<= 50 words)}]
-- The entry's own molecule is implicit: the photocatalyst for "donor", the first reactant for "acceptor".
alter table public.entries add column if not exists reactions jsonb;
-- CAS registry number, the first key used to recognise the same molecule.
alter table public.entries add column if not exists cas text;
-- Commercial or common name (optional; displayed as main title with IUPAC name underneath when set).
alter table public.entries add column if not exists commercial_name text;
-- Structured UV-vis columns (replacing legacy free-text uv).
alter table public.entries add column if not exists uv_lmax int;
alter table public.entries add column if not exists uv_eps int;
alter table public.entries add column if not exists uv_cond text;
-- Two-admin verification log: [{"email": "curator@...", "at": "2026-...Z"}, ...].
alter table public.entries add column if not exists approvals jsonb not null default '[]'::jsonb;

-- Drop dependent view/function before migrating legacy uv / direct_exc columns (recreated below).
drop function if exists public.list_entries(text, text);
drop view if exists public.public_entries;

do $$
declare
  v_direct_type text;
  v_has_uv boolean;
begin
  select data_type into v_direct_type
  from information_schema.columns
  where table_schema = 'public' and table_name = 'entries' and column_name = 'direct_exc';

  if v_direct_type = 'text' then
    alter table public.entries
      alter column direct_exc type jsonb
      using (
        case
          when direct_exc is null or btrim(direct_exc) = '' then null
          when direct_exc ~ '^\s*\{' then direct_exc::jsonb
          when direct_exc ~ '([0-9]{3,4})' then jsonb_build_object(
            coalesce(
              nullif(btrim(regexp_replace(regexp_replace(direct_exc, '^.*?(with\s+(a\s+)?|at\s+)', '', 'i'), '[0-9]+\s*nm\.?', '', 'gi')), ''),
              'irradiation'
            ),
            substring(direct_exc from '([0-9]{3,4})')::int
          )
          else null
        end
      );
  end if;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'entries' and column_name = 'uv'
  ) into v_has_uv;

  if v_has_uv then
    update public.entries
    set
      uv_lmax = coalesce(uv_lmax, nullif(substring(uv from '([0-9]{3,4})\s*nm'), '')::int),
      uv_eps  = coalesce(uv_eps,  nullif(replace(substring(uv from 'ε[^0-9]{0,12}([0-9][0-9,]*)'), ',', ''), '')::int),
      uv_cond = coalesce(uv_cond, nullif(btrim(substring(uv from '\(([^()]+)\)\s*$')), ''))
    where uv is not null and btrim(uv) <> '' and uv_lmax is null and uv_cond is null;

    alter table public.entries drop column uv;
  end if;
end $$;

alter table public.entries drop constraint if exists entries_uv_lmax_range;
alter table public.entries add constraint entries_uv_lmax_range
  check (uv_lmax is null or (uv_lmax >= 100 and uv_lmax <= 1500)) not valid;
alter table public.entries drop constraint if exists entries_uv_eps_nonneg;
alter table public.entries add constraint entries_uv_eps_nonneg
  check (uv_eps is null or uv_eps >= 0) not valid;
alter table public.entries drop constraint if exists entries_direct_exc_object;
alter table public.entries add constraint entries_direct_exc_object
  check (direct_exc is null or jsonb_typeof(direct_exc) = 'object') not valid;
alter table public.entries drop constraint if exists entries_reactions_shape;
alter table public.entries add constraint entries_reactions_shape
  check (reactions is null or (jsonb_typeof(reactions) = 'array' and jsonb_array_length(reactions) <= 10)) not valid;
-- Every reaction names its paper by DOI only (never a link), like the entry's own source.
create or replace function public.reactions_dois_ok(p jsonb)
returns boolean
language sql immutable
set search_path = ''
as $$
  select p is null or jsonb_typeof(p) <> 'array' or not exists (
    select 1 from jsonb_array_elements(p) r
    where jsonb_typeof(r) <> 'object'
       or coalesce(r->>'doi', '') !~ '^10\.[0-9]{4,9}/[^[:space:]]+$'
       or coalesce(r->>'role', '') not in ('donor', 'acceptor')
  );
$$;
alter table public.entries drop constraint if exists entries_reactions_dois;
alter table public.entries add constraint entries_reactions_dois
  check (public.reactions_dois_ok(reactions)) not valid;
alter table public.entries drop constraint if exists entries_approvals_array;
alter table public.entries add constraint entries_approvals_array
  check (jsonb_typeof(approvals) = 'array') not valid;
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

-- Confirmed lowercase email of the signed-in curator, or null if not an admin.
create or replace function public.current_admin_email()
returns text
language sql stable security definer
set search_path = ''
as $$
  select lower(u.email)
  from auth.users u
  join public.admins a on lower(a.email) = lower(u.email)
  where u.id = auth.uid() and u.email_confirmed_at is not null
  limit 1;
$$;
revoke all on function public.current_admin_email() from public, anon;
grant execute on function public.current_admin_email() to authenticated;

-- Count distinct valid curator emails currently listed in public.admins.
create or replace function public.count_valid_approvals(p_approvals jsonb)
returns int
language sql stable security definer
set search_path = ''
as $$
  select count(distinct lower(elem->>'email'))::int
  from jsonb_array_elements(
    case when jsonb_typeof(p_approvals) = 'array' then p_approvals else '[]'::jsonb end
  ) elem
  join public.admins a on lower(a.email) = lower(elem->>'email');
$$;
revoke all on function public.count_valid_approvals(jsonb) from public, anon;
grant execute on function public.count_valid_approvals(jsonb) to authenticated;

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

-- Database-level two-admin verification enforcement for entries:
-- 1) Authenticated inserts start as pending with no approvals.
-- 2) Approvals can only be written via approve_entries() / revoke_entry_approval().
-- 3) Moving an entry into 'approved' requires >= 2 distinct valid admins in approvals.
-- 4) Rejecting, moving back to queue, or editing scientific/source fields while pending resets approvals.
create or replace function public.entries_enforce_approval_policy()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_rpc boolean := current_setting('trendb.allow_approval_write', true) = 'on';
begin
  if auth.uid() is null then
    return new;
  end if;

  new.approvals := coalesce(new.approvals, '[]'::jsonb);

  if tg_op = 'INSERT' then
    if new.status <> 'pending' then
      raise exception 'New entries must start as pending' using errcode = '42501';
    end if;
    if jsonb_typeof(new.approvals) <> 'array' or jsonb_array_length(new.approvals) > 0 then
      raise exception 'New entries cannot start with approvals' using errcode = '42501';
    end if;
    return new;
  end if;

  if not v_rpc then
    if new.approvals is distinct from old.approvals then
      raise exception 'Approvals can only be changed through the approval functions' using errcode = '42501';
    end if;
    if new.status = 'approved' and old.status is distinct from 'approved' then
      raise exception 'Two different admins must approve an entry before it becomes approved' using errcode = '42501';
    end if;
    if new.status = 'rejected' or (new.status = 'pending' and old.status in ('approved', 'rejected')) then
      new.approvals := '[]'::jsonb;
    elsif old.status = 'pending' and new.status = 'pending' and (
      new.smiles is distinct from old.smiles or
      new.role is distinct from old.role or
      new.origin is distinct from old.origin or
      new.et_kcal is distinct from old.et_kcal or
      new.et_unc is distinct from old.et_unc or
      new.et_reported is distinct from old.et_reported or
      new.et_type is distinct from old.et_type or
      new.method is distinct from old.method or
      new.conditions is distinct from old.conditions or
      new.citation is distinct from old.citation or
      new.doi is distinct from old.doi or
      new.location is distinct from old.location or
      new.quote is distinct from old.quote or
      new.evidence is distinct from old.evidence or
      new.uv_lmax is distinct from old.uv_lmax or
      new.uv_eps is distinct from old.uv_eps or
      new.uv_cond is distinct from old.uv_cond or
      new.direct_exc is distinct from old.direct_exc or
      new.uses is distinct from old.uses or
      new.reactions is distinct from old.reactions
    ) then
      new.approvals := '[]'::jsonb;
    end if;
  end if;

  if new.status = 'approved' and old.status is distinct from 'approved' then
    if public.count_valid_approvals(new.approvals) < 2 then
      raise exception 'Two different admins must approve an entry before it becomes approved' using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;
drop trigger if exists entries_approval_policy_trg on public.entries;
create trigger entries_approval_policy_trg
  before insert or update on public.entries
  for each row execute function public.entries_enforce_approval_policy();

-- Record the current curator's approval on one or more entries (1/2 stays pending; 2/2 publishes).
create or replace function public.approve_entries(p_ids uuid[], p_note text default null)
returns setof public.entries
language plpgsql security definer
set search_path = ''
as $$
declare
  v_email text := public.current_admin_email();
  v_row public.entries%rowtype;
  v_approvals jsonb;
  v_status text;
  v_decided_at timestamptz;
  v_updated public.entries%rowtype;
begin
  if v_email is null then
    raise exception 'Not an admin' using errcode = '42501';
  end if;
  if p_ids is null or coalesce(array_length(p_ids, 1), 0) = 0 then
    return;
  end if;

  perform set_config('trendb.allow_approval_write', 'on', true);

  for v_row in
    select * from public.entries
    where id = any(p_ids)
    order by array_position(p_ids, id)
    for update
  loop
    if v_row.status = 'approved' then
      return next v_row;
      continue;
    end if;

    select coalesce(jsonb_agg(elem order by ord), '[]'::jsonb)
    into v_approvals
    from jsonb_array_elements(
      case when v_row.status = 'rejected' then '[]'::jsonb else coalesce(v_row.approvals, '[]'::jsonb) end
    ) with ordinality as t(elem, ord)
    join public.admins a on lower(a.email) = lower(elem->>'email');

    if not exists (
      select 1 from jsonb_array_elements(v_approvals) elem
      where lower(elem->>'email') = v_email
    ) then
      v_approvals := v_approvals || jsonb_build_array(
        jsonb_build_object(
          'email', v_email,
          'at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        )
      );
    end if;

    if public.count_valid_approvals(v_approvals) >= 2 then
      v_status := 'approved';
      v_decided_at := now();
    else
      v_status := 'pending';
      v_decided_at := null;
    end if;

    update public.entries
    set approvals = v_approvals,
        status = v_status,
        decided_at = v_decided_at,
        note = case when p_note is null then v_row.note else nullif(p_note, '') end
    where id = v_row.id
    returning * into v_updated;

    return next v_updated;
  end loop;

  perform set_config('trendb.allow_approval_write', 'off', true);
end;
$$;
revoke all on function public.approve_entries(uuid[], text) from public, anon;
grant execute on function public.approve_entries(uuid[], text) to authenticated;

-- Withdraw the current curator's approval from an entry (moves approved -> pending if < 2 remain).
create or replace function public.revoke_entry_approval(p_id uuid, p_note text default null)
returns setof public.entries
language plpgsql security definer
set search_path = ''
as $$
declare
  v_email text := public.current_admin_email();
  v_row public.entries%rowtype;
  v_approvals jsonb;
  v_status text;
  v_decided_at timestamptz;
  v_updated public.entries%rowtype;
begin
  if v_email is null then
    raise exception 'Not an admin' using errcode = '42501';
  end if;

  select * into v_row from public.entries where id = p_id for update;
  if not found then
    return;
  end if;

  select coalesce(jsonb_agg(elem order by ord), '[]'::jsonb)
  into v_approvals
  from jsonb_array_elements(coalesce(v_row.approvals, '[]'::jsonb)) with ordinality as t(elem, ord)
  where lower(elem->>'email') <> v_email;

  if v_row.status = 'approved' and public.count_valid_approvals(v_approvals) < 2 then
    v_status := 'pending';
    v_decided_at := null;
  else
    v_status := v_row.status;
    v_decided_at := v_row.decided_at;
  end if;

  perform set_config('trendb.allow_approval_write', 'on', true);
  update public.entries
  set approvals = v_approvals,
      status = v_status,
      decided_at = v_decided_at,
      note = case when p_note is null then v_row.note else nullif(p_note, '') end
  where id = v_row.id
  returning * into v_updated;
  perform set_config('trendb.allow_approval_write', 'off', true);

  return next v_updated;
end;
$$;
revoke all on function public.revoke_entry_approval(uuid, text) from public, anon;
grant execute on function public.revoke_entry_approval(uuid, text) to authenticated;

-- Corrections proposed by readers for approved entries. They arrive through the "submit"
-- function (service role) and appear in the curators' queue; approving one (by two admins)
-- writes only the changed fields into the entry.
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
  ip_hash     text,
  approvals   jsonb not null default '[]'::jsonb
);
alter table public.suggestions add column if not exists approvals jsonb not null default '[]'::jsonb;
alter table public.suggestions drop constraint if exists suggestions_approvals_array;
alter table public.suggestions add constraint suggestions_approvals_array
  check (jsonb_typeof(approvals) = 'array') not valid;
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

create or replace function public.suggestions_enforce_approval_policy()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_rpc boolean := current_setting('trendb.allow_approval_write', true) = 'on';
begin
  if auth.uid() is null then
    return new;
  end if;

  new.approvals := coalesce(new.approvals, '[]'::jsonb);

  if tg_op = 'INSERT' then
    if new.status <> 'pending' then
      raise exception 'New suggestions must start as pending' using errcode = '42501';
    end if;
    if jsonb_typeof(new.approvals) <> 'array' or jsonb_array_length(new.approvals) > 0 then
      raise exception 'New suggestions cannot start with approvals' using errcode = '42501';
    end if;
    return new;
  end if;

  if not v_rpc then
    if new.approvals is distinct from old.approvals then
      raise exception 'Approvals can only be changed through the approval functions' using errcode = '42501';
    end if;
    if new.status = 'approved' and old.status is distinct from 'approved' then
      raise exception 'Two different admins must approve a suggestion before it becomes approved' using errcode = '42501';
    end if;
    if new.status = 'rejected' or (new.status = 'pending' and old.status in ('approved', 'rejected')) then
      new.approvals := '[]'::jsonb;
    elsif old.status = 'pending' and new.status = 'pending' and new.changes is distinct from old.changes then
      new.approvals := '[]'::jsonb;
    end if;
  end if;

  if new.status = 'approved' and old.status is distinct from 'approved' then
    if public.count_valid_approvals(new.approvals) < 2 then
      raise exception 'Two different admins must approve a suggestion before it becomes approved' using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;
drop trigger if exists suggestions_approval_policy_trg on public.suggestions;
create trigger suggestions_approval_policy_trg
  before insert or update on public.suggestions
  for each row execute function public.suggestions_enforce_approval_policy();

create or replace function public.approve_suggestion(p_id uuid, p_note text default null)
returns setof public.suggestions
language plpgsql security definer
set search_path = ''
as $$
declare
  v_email text := public.current_admin_email();
  v_row public.suggestions%rowtype;
  v_approvals jsonb;
  v_status text;
  v_decided_at timestamptz;
  v_updated public.suggestions%rowtype;
begin
  if v_email is null then
    raise exception 'Not an admin' using errcode = '42501';
  end if;

  select * into v_row from public.suggestions where id = p_id for update;
  if not found then
    return;
  end if;

  if v_row.status = 'approved' then
    return next v_row;
    return;
  end if;

  select coalesce(jsonb_agg(elem order by ord), '[]'::jsonb)
  into v_approvals
  from jsonb_array_elements(
    case when v_row.status = 'rejected' then '[]'::jsonb else coalesce(v_row.approvals, '[]'::jsonb) end
  ) with ordinality as t(elem, ord)
  join public.admins a on lower(a.email) = lower(elem->>'email');

  if not exists (
    select 1 from jsonb_array_elements(v_approvals) elem
    where lower(elem->>'email') = v_email
  ) then
    v_approvals := v_approvals || jsonb_build_array(
      jsonb_build_object(
        'email', v_email,
        'at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
    );
  end if;

  if public.count_valid_approvals(v_approvals) >= 2 then
    v_status := 'approved';
    v_decided_at := now();
  else
    v_status := 'pending';
    v_decided_at := null;
  end if;

  perform set_config('trendb.allow_approval_write', 'on', true);
  update public.suggestions
  set approvals = v_approvals,
      status = v_status,
      decided_at = v_decided_at,
      note = case when p_note is null then v_row.note else nullif(p_note, '') end
  where id = v_row.id
  returning * into v_updated;
  perform set_config('trendb.allow_approval_write', 'off', true);

  return next v_updated;
end;
$$;
revoke all on function public.approve_suggestion(uuid, text) from public, anon;
grant execute on function public.approve_suggestion(uuid, text) to authenticated;

create or replace function public.revoke_suggestion_approval(p_id uuid, p_note text default null)
returns setof public.suggestions
language plpgsql security definer
set search_path = ''
as $$
declare
  v_email text := public.current_admin_email();
  v_row public.suggestions%rowtype;
  v_approvals jsonb;
  v_status text;
  v_decided_at timestamptz;
  v_updated public.suggestions%rowtype;
begin
  if v_email is null then
    raise exception 'Not an admin' using errcode = '42501';
  end if;

  select * into v_row from public.suggestions where id = p_id for update;
  if not found then
    return;
  end if;

  select coalesce(jsonb_agg(elem order by ord), '[]'::jsonb)
  into v_approvals
  from jsonb_array_elements(coalesce(v_row.approvals, '[]'::jsonb)) with ordinality as t(elem, ord)
  where lower(elem->>'email') <> v_email;

  if v_row.status = 'approved' and public.count_valid_approvals(v_approvals) < 2 then
    v_status := 'pending';
    v_decided_at := null;
  else
    v_status := v_row.status;
    v_decided_at := v_row.decided_at;
  end if;

  perform set_config('trendb.allow_approval_write', 'on', true);
  update public.suggestions
  set approvals = v_approvals,
      status = v_status,
      decided_at = v_decided_at,
      note = case when p_note is null then v_row.note else nullif(p_note, '') end
  where id = v_row.id
  returning * into v_updated;
  perform set_config('trendb.allow_approval_write', 'off', true);

  return next v_updated;
end;
$$;
revoke all on function public.revoke_suggestion_approval(uuid, text) from public, anon;
grant execute on function public.revoke_suggestion_approval(uuid, text) to authenticated;

-- What the public site reads: approved rows only, without the private columns.
-- The view deliberately runs with its owner's rights so anonymous visitors can read it
-- although they have no access to the table. (Supabase's linter flags this as a
-- "security definer view"; here it is the intended design.)
-- (Dropped and recreated, together with list_entries below, because its columns change.)
create view public.public_entries as
select id, created_at, name, commercial_name, cas, smiles, idcode, structure_note, cls, role,
       origin, et_kcal, et_unc, et_reported, et_type, method, conditions,
       citation, doi, location, quote, evidence,
       uv_lmax, uv_eps, uv_cond, direct_exc, score, uses, reactions
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
      or (auth.uid() is not null and public.is_admin())
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
