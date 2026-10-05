-- ============================================================================
-- MINEGUARD LIBERIA — migration 0010: organizations, geography & permissions
-- (SEC-5, SITE-1, §6 of the security roadmap — Session 2)
--
-- Before this migration the tenancy model had three structural weaknesses:
--
--   1. TENANCY WAS A DISPLAY STRING. `sites.operator_name` / profiles
--      `operator_name` were free text: renaming an operator broke the tenant
--      link, two operators with the same name silently shared a tenant, and
--      there was no stable identifier to key isolation on.
--   2. GEOGRAPHY WAS FLAT. county/district/community were denormalized text
--      columns with no hierarchy, so scopes beyond 'county' had nowhere to
--      point. `scope='site'` existed in the enum but was UNIMPLEMENTED — a
--      site-scoped profile matched no branch of mg_can_access_site and saw
--      nothing (and every operator account was provisioned with it anyway).
--   3. ROLES WERE HARDCODED IN POLICY TEXT. Every RLS policy spelled out the
--      role matrix inline; there was no single, inspectable role → permission
--      set, and no way to grant a capability without editing policy SQL.
--
-- What this migration does (single transaction, idempotent — safe to re-run;
-- verified by tests/migration-apply.test.ts and tests/rls.test.ts):
--
--   A/B  user_scope grows to six values — national, regional, county,
--        district, site, operator. ALTER TYPE ADD VALUE cannot be *used* in
--        the same transaction on an existing column (probe-verified on this
--        harness: "unsafe use of new value"), so the enum is extended by
--        renaming the old type aside, creating the canonical six-value type
--        under the same name, repointing profiles.scope, and dropping the
--        predecessor when nothing depends on it. Operator accounts holding
--        the old, unimplemented scope='site' are converted to
--        scope='operator'; 'site' now means "staff assigned to specific
--        sites" and is implemented through site_assignments below.
--
--   C    permissions(role, permission) — the role → permission matrix,
--        seeded for all four roles and consumed by the RLS helper
--        mg_has_permission(), which the site/organization/assignment/audit
--        policies and the site guard now call instead of inline role tests.
--        Deleting an admin's permission row revokes the capability (proved
--        adversarially in tests/rls.test.ts).
--
--   D    admin_areas — a configurable hierarchy (national → region → county
--        → district → community, parent_id self-reference), backfilled from
--        the counties/districts/communities already present in the data.
--        regional and district scopes resolve through it.
--
--   E/F  organizations — the operator registry, keyed by a UUID. `name` is
--        deliberately NOT unique: two distinct operators may share a display
--        name and isolation must never depend on it. site_assignments links
--        staff to specific sites (the 'site' scope, and explicit grants on
--        top of any staff scope). Both tables are audit-trailed by the 0009
--        trigger (organizations also gets the integrity stamps).
--
--   G/H  sites.organization_id + profiles.organization_id become the tenant
--        key. `operator_name` is kept as a COMPATIBILITY/DISPLAY column,
--        maintained by sync triggers:
--          * sites: organization_id is authoritative. A name-only insert
--            (the existing client contract, api.sites.create) resolves or
--            creates the organization by name; once bound, operator_name is
--            re-derived from the organization on every write.
--          * profiles: an explicit operator_name change re-points the tenant
--            (the admin directory UX, and the revocation path proven in
--            tests/evidence-url.test.ts); an organization rename cascades
--            the display name onto sites and profiles under a
--            transaction-local flag so the cascade can never re-resolve by
--            name against a same-named sibling organization.
--
--   I    mg_can_access_site_row(id, county, district, operator, org) — the
--        tenant/scope matrix, computed over the row's OWN columns (keeps
--        0007's INSERT…RETURNING fix: no inner select on sites):
--          admin → all · staff national → all · staff county → county ·
--          staff regional → county under their region (admin_areas) ·
--          staff district → their district · staff site → site_assignments
--          (any staff scope + an explicit assignment also grants that site) ·
--          operator → organization_id match, with operator_name matching as
--          the legacy fallback only while the profile has no organization.
--        The uuid form (storage policies, evidence_for_parent, guards) and
--        the "sites read/insert/update" policies are recreated on top of it;
--        the obsolete two-argument row form is dropped. The site write guard
--        moves to SECURITY INVOKER + current_user (the 0004-proven pattern)
--        so direct database maintenance — including this migration's
--        backfill — can run, while client sessions are gated by permissions.
--        "audit staff read" now reads the permission set too (the seeded
--        matrix grants audit.read to exactly the roles mg_is_staff() did).
--
--   J    profile guard parity: organization_id and scope_area_id join the
--        admin-only column list, so a self-service profile update can never
--        move its own tenant key.
--
--   K    Backfill: admin_areas rows, one organization per distinct operator
--        name, then sites/profiles bound to them. After this, isolation keys
--        on UUIDs; operator_name is display only.
--
-- Acceptance (tests/rls.test.ts "SEC-5/SITE-1", tests/operator-isolation):
--   * renamed operator → isolation unchanged (organization_id), display follows
--   * same-name operators → distinct tenants
--   * site-scoped staff → exactly the assigned site; none assigned → nothing
--   * cross-county / cross-tenant reads and writes stay denied
--   * no behaviour regression: every pre-0010 persona keeps its access
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- A. user_scope — six values, same canonical type name.
--    Sequence (probe-verified against PGlite): rename the three-value type
--    aside, create the full type under the canonical name, repoint the
--    column, drop the predecessor only when nothing (columns, composite
--    attributes) still depends on it. Re-running skips straight through:
--    the canonical name already carries six values, so nothing is renamed.
--
--    The "inspections read" policy expression pins profiles.scope in
--    pg_depend (its `(select scope from mg_profile()) = 'national'` field
--    selection is recorded against the column), which blocks ALTER TYPE —
--    so it is dropped here and recreated verbatim immediately after the
--    repoint. Policy count and behaviour are unchanged.
-- ---------------------------------------------------------------------------
drop policy if exists "inspections read" on public.inspections;

do $do$
begin
  if exists (select 1 from pg_enum e
              where e.enumtypid = 'public.user_scope'::regtype
                and e.enumlabel = 'site')
     and not exists (select 1 from pg_enum e
                      where e.enumtypid = 'public.user_scope'::regtype
                        and e.enumlabel = 'operator') then
    execute 'alter type public.user_scope rename to user_scope_v1';
  end if;
end $do$;

do $do$
begin
  if not exists (select 1 from pg_type t
                   join pg_namespace n on n.oid = t.typnamespace
                  where n.nspname = 'public' and t.typname = 'user_scope') then
    execute 'create type public.user_scope as enum (''national'',''regional'',''county'',''district'',''site'',''operator'')';
  end if;
end $do$;

alter table public.profiles
  alter column scope type public.user_scope
  using (scope::text::public.user_scope);

do $do$
begin
  if exists (select 1 from pg_type t
               join pg_namespace n on n.oid = t.typnamespace
              where n.nspname = 'public' and t.typname = 'user_scope_v1')
     and not exists (select 1 from pg_depend d
                      where d.refclassid = 'pg_type'::regclass
                        and d.refobjid = to_regtype('public.user_scope_v1')
                        and d.deptype <> 'i') then
    execute 'drop type public.user_scope_v1';
  end if;
end $do$;

-- Recreated verbatim (0001): same name, same qualification, same logic —
-- re-bound to the repointed column.
create policy "inspections read" on public.inspections
  for select using (
    public.mg_can_access_site(site_id)
    and (
      public.mg_is_admin()
      or (select scope from public.mg_profile()) = 'national'
      or inspector_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- B. Fix scope='site': operator accounts never used it (the operator branch
--    of the matrix is organization-based); 'site' now belongs to staff with
--    explicit site_assignments. Existing operator rows move to
--    scope='operator'. Idempotent: the predicate stops matching immediately.
-- ---------------------------------------------------------------------------
update public.profiles
   set scope = 'operator'
 where role = 'operator' and scope = 'site';

-- ---------------------------------------------------------------------------
-- C. permissions — the role → permission matrix.
--    Consumed by mg_has_permission() below; the tenancy policies and guards
--    call that helper instead of inline role tests. The remaining entries
--    document the full matrix (the legacy role-based guards still enforce
--    them; policies migrate over time). Client roles hold SELECT only —
--    there is deliberately no write policy: the matrix changes by migration.
-- ---------------------------------------------------------------------------
create table if not exists public.permissions (
  id         uuid primary key default gen_random_uuid(),
  role       public.user_role not null,
  permission text not null,
  created_at timestamptz not null default now(),
  unique (role, permission)
);

alter table public.permissions enable row level security;

drop policy if exists "permissions read" on public.permissions;
create policy "permissions read" on public.permissions
  for select to authenticated
  using ((select role from public.mg_profile()) is not null);

insert into public.permissions (role, permission) values
  ('admin',      'sites.insert'),
  ('admin',      'sites.update'),
  ('admin',      'organizations.write'),
  ('admin',      'geo.write'),
  ('admin',      'assignments.manage'),
  ('admin',      'users.manage'),
  ('admin',      'templates.write'),
  ('admin',      'reports.triage'),
  ('admin',      'records.status'),
  ('admin',      'audit.read'),
  ('supervisor', 'templates.write'),
  ('supervisor', 'reports.triage'),
  ('supervisor', 'records.status'),
  ('supervisor', 'audit.read'),
  ('inspector',  'templates.write'),
  ('inspector',  'records.status'),
  ('inspector',  'audit.read'),
  ('operator',   'records.submit')
on conflict (role, permission) do nothing;

create or replace function public.mg_has_permission(p_permission text)
returns boolean
language sql
stable
security definer set search_path = public
as $mg$
  select coalesce(
    (select bool_or(per.permission = p_permission)
       from public.permissions per
      where per.role = (select p.role from public.mg_profile() p)),
    false)
$mg$;

-- ---------------------------------------------------------------------------
-- D. admin_areas — configurable geography hierarchy.
--    Levels are a checked text column (not an enum) precisely so the level
--    set stays configurable in later migrations; this one seeds the five
--    documented levels. Anonymous callers hold no grant (0009 defaults), so
--    the read policy is for signed-in accounts only.
-- ---------------------------------------------------------------------------
create table if not exists public.admin_areas (
  id         uuid primary key default gen_random_uuid(),
  level      text not null
             check (level in ('national','region','county','district','community')),
  name       text not null,
  code       text,
  parent_id  uuid references public.admin_areas(id),
  created_at timestamptz not null default now()
);

create unique index if not exists admin_areas_parent_name_key
  on public.admin_areas (level, parent_id, name);

alter table public.admin_areas enable row level security;

drop policy if exists "admin_areas read" on public.admin_areas;
create policy "admin_areas read" on public.admin_areas
  for select to authenticated
  using (true);

drop policy if exists "admin_areas insert" on public.admin_areas;
create policy "admin_areas insert" on public.admin_areas
  for insert to authenticated
  with check (public.mg_has_permission('geo.write'));

drop policy if exists "admin_areas update" on public.admin_areas;
create policy "admin_areas update" on public.admin_areas
  for update to authenticated
  using (public.mg_has_permission('geo.write'))
  with check (public.mg_has_permission('geo.write'));

-- ---------------------------------------------------------------------------
-- E. organizations — the operator registry. `name` is NOT unique (two
--    operators may share a display name; isolation keys on id). Integrity
--    stamps + the 0009 touch/audit triggers: a rename is a server-written,
--    diffed audit event. The write guard mirrors the site guard: permission
--    check for client sessions, direct-database bypass otherwise.
-- ---------------------------------------------------------------------------
create table if not exists public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  kind        text not null default 'operator',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz,
  updated_by  uuid,
  row_version integer not null default 1
);

alter table public.organizations enable row level security;

-- Tenant/scope keys on the existing tables. They must exist before the
-- organizations read policy below, whose expression selects
-- `organization_id` from the profiles composite (field selections are
-- resolved when the policy is created).
alter table public.sites
  add column if not exists organization_id uuid references public.organizations(id);
alter table public.profiles
  add column if not exists organization_id uuid references public.organizations(id);
alter table public.profiles
  add column if not exists scope_area_id uuid references public.admin_areas(id);

drop policy if exists "organizations read" on public.organizations;
create policy "organizations read" on public.organizations
  for select to authenticated
  using (
    public.mg_is_staff()
    or (
      (select role from public.mg_profile()) = 'operator'
      and (select organization_id from public.mg_profile()) is not distinct from id
    )
  );

drop policy if exists "organizations insert" on public.organizations;
create policy "organizations insert" on public.organizations
  for insert to authenticated
  with check (public.mg_has_permission('organizations.write'));

drop policy if exists "organizations update" on public.organizations;
create policy "organizations update" on public.organizations
  for update to authenticated
  using (public.mg_has_permission('organizations.write'))
  with check (public.mg_has_permission('organizations.write'));

create or replace function public.mg_guard_org_write()
returns trigger
language plpgsql
security invoker set search_path = public
as $mg$
begin
  if tg_op = 'DELETE' then
    raise exception 'FORBIDDEN: organizations are never deleted (rename instead)';
  end if;
  -- SECURITY INVOKER: current_user genuinely distinguishes a client session
  -- from direct database maintenance (the 0004-proven pattern — a definer
  -- guard would see its own owner and bypass itself).
  if current_user <> 'authenticated' then
    return coalesce(new, old);
  end if;
  if not public.mg_has_permission('organizations.write') then
    raise exception 'FORBIDDEN: organization write requires the organizations.write permission';
  end if;
  return coalesce(new, old);
end;
$mg$;

drop trigger if exists organizations_guard on public.organizations;
create trigger organizations_guard
  before insert or update or delete on public.organizations
  for each row execute function public.mg_guard_org_write();

drop trigger if exists organizations_touch on public.organizations;
create trigger organizations_touch
  before insert or update on public.organizations
  for each row execute function public.mg_touch_row();

drop trigger if exists organizations_audit on public.organizations;
create trigger organizations_audit
  after insert or update on public.organizations
  for each row execute function public.mg_audit_row();

-- Rename cascade: organization_id is the tenant key, operator_name is
-- display. When the organization is renamed, every bound site and profile
-- follows — under a transaction-local flag so the profile sync trigger
-- cannot re-resolve the NEW name against a same-named sibling organization
-- (which would silently transfer tenants). SECURITY INVOKER: the cascaded
-- writes run with the caller's identity and pass the site/profile guards
-- exactly like any other admin edit (organization renames are RLS-gated to
-- organizations.write above, so the caller is an admin session).
create or replace function public.mg_sync_org_rename()
returns trigger
language plpgsql
security invoker set search_path = public
as $mg$
begin
  if new.name is distinct from old.name then
    perform set_config('mg.tenant_cascade', '1', true);
    update public.sites s
       set operator_name = new.name
     where s.organization_id = new.id
       and s.operator_name is distinct from new.name;
    update public.profiles p
       set operator_name = new.name
     where p.organization_id = new.id
       and p.operator_name is distinct from new.name;
    perform set_config('mg.tenant_cascade', '0', true);
  end if;
  return new;
end;
$mg$;

drop trigger if exists organizations_rename on public.organizations;
create trigger organizations_rename
  after update of name on public.organizations
  for each row execute function public.mg_sync_org_rename();

-- ---------------------------------------------------------------------------
-- F. site_assignments — explicit staff↔site grants. Backs scope='site'
--    (a staff member with no assignment sees nothing) and extends any staff
--    scope with individually assigned sites. Admin-managed only; every
--    grant is audit-trailed by the 0009 trigger.
-- ---------------------------------------------------------------------------
create table if not exists public.site_assignments (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  site_id     uuid not null references public.sites(id) on delete cascade,
  assigned_by uuid references public.profiles(id),
  note        text,
  created_at  timestamptz not null default now()
);

create unique index if not exists site_assignments_user_site_key
  on public.site_assignments (user_id, site_id);

alter table public.site_assignments enable row level security;

drop policy if exists "site_assignments read" on public.site_assignments;
create policy "site_assignments read" on public.site_assignments
  for select to authenticated
  using (
    user_id = auth.uid()
    or public.mg_has_permission('assignments.manage')
  );

drop policy if exists "site_assignments insert" on public.site_assignments;
create policy "site_assignments insert" on public.site_assignments
  for insert to authenticated
  with check (public.mg_has_permission('assignments.manage'));

drop policy if exists "site_assignments update" on public.site_assignments;
create policy "site_assignments update" on public.site_assignments
  for update to authenticated
  using (public.mg_has_permission('assignments.manage'))
  with check (public.mg_has_permission('assignments.manage'));

drop trigger if exists site_assignments_audit on public.site_assignments;
create trigger site_assignments_audit
  after insert or update on public.site_assignments
  for each row execute function public.mg_audit_row();

-- ---------------------------------------------------------------------------
-- H. Name ⇄ organization sync.
--    mg_resolve_organization is SECURITY DEFINER so tenant binding behaves
--    identically from every entry point (client session, definer RPC,
--    migration backfill); its EXECUTE privilege is revoked from client
--    roles — only the definer sync triggers reach it, so no client can mint
--    organizations directly. Every created row is still audit-trailed with
--    the session actor by organizations_audit.
-- ---------------------------------------------------------------------------
create or replace function public.mg_resolve_organization(p_name text)
returns uuid
language plpgsql
security definer set search_path = public
as $mg$
declare
  v_id uuid;
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
begin
  if v_name is null then
    return null;
  end if;
  select id into v_id
    from public.organizations
   where lower(name) = lower(v_name)
   order by created_at, id
   limit 1;
  if v_id is null then
    insert into public.organizations (name, kind)
    values (v_name, 'operator')
    returning id into v_id;
  end if;
  return v_id;
end;
$mg$;

-- Sites: organization_id is authoritative; operator_name is re-derived from
-- it on every write. A name-only write (the long-standing client contract)
-- resolves or creates the organization first. SECURITY DEFINER so the
-- binding runs uniformly regardless of the calling session's grants.
create or replace function public.mg_sync_site_org()
returns trigger
language plpgsql
security definer set search_path = public
as $mg$
declare
  v_name text;
begin
  if new.organization_id is null and new.operator_name is not null then
    new.organization_id := public.mg_resolve_organization(new.operator_name);
  end if;
  if new.organization_id is not null then
    select name into v_name from public.organizations where id = new.organization_id;
    if v_name is not null then
      new.operator_name := v_name;
    end if;
  end if;
  return new;
end;
$mg$;

drop trigger if exists sites_org on public.sites;
create trigger sites_org
  before insert or update on public.sites
  for each row execute function public.mg_sync_site_org();

-- Profiles: an explicit operator_name change re-points the tenant (admin
-- directory UX + revocation path); otherwise the bound organization wins the
-- display name. The rename cascade short-circuits on the transaction-local
-- flag (see mg_sync_org_rename).
create or replace function public.mg_sync_profile_org()
returns trigger
language plpgsql
security definer set search_path = public
as $mg$
declare
  v_name text;
begin
  if current_setting('mg.tenant_cascade', true) = '1' then
    if new.organization_id is not null then
      select name into v_name from public.organizations where id = new.organization_id;
      if v_name is not null then
        new.operator_name := v_name;
      end if;
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' and new.operator_name is distinct from old.operator_name then
    -- Explicit change: bind (or revoke, when cleared) by name.
    new.organization_id := public.mg_resolve_organization(new.operator_name);
  elsif new.organization_id is null and new.operator_name is not null then
    -- Legacy name-only row: bind it on demand.
    new.organization_id := public.mg_resolve_organization(new.operator_name);
  end if;

  if new.organization_id is not null then
    select name into v_name from public.organizations where id = new.organization_id;
    if v_name is not null then
      new.operator_name := v_name;
    end if;
  end if;
  return new;
end;
$mg$;

drop trigger if exists profiles_org on public.profiles;
create trigger profiles_org
  before insert or update on public.profiles
  for each row execute function public.mg_sync_profile_org();

-- Site guard, moved to SECURITY INVOKER + current_user (the 0004-proven
-- discrimination): client sessions are gated by the permissions table, while
-- direct database maintenance — this migration's backfill, ops scripts —
-- passes. The delete refusal is unchanged (belt behind SEC-3's revoke).
create or replace function public.mg_guard_site_write()
returns trigger
language plpgsql
security invoker set search_path = public
as $mg$
begin
  if tg_op = 'DELETE' then
    raise exception 'FORBIDDEN: sites are never deleted (lifecycle only)';
  end if;
  if current_user <> 'authenticated' then
    return coalesce(new, old);
  end if;
  if tg_op = 'INSERT' and not public.mg_has_permission('sites.insert') then
    raise exception 'FORBIDDEN: admin required to modify the site registry';
  end if;
  if tg_op = 'UPDATE' and not public.mg_has_permission('sites.update') then
    raise exception 'FORBIDDEN: admin required to modify the site registry';
  end if;
  return coalesce(new, old);
end;
$mg$;

-- ---------------------------------------------------------------------------
-- I. The tenant/scope matrix — row form over the row's OWN columns (keeps
--    0007's INSERT…RETURNING fix: no inner select on sites), plus the uuid
--    form every other policy/guard consumes. The obsolete two-argument row
--    form is dropped so no caller can silently use the pre-0010 matrix.
-- ---------------------------------------------------------------------------
create or replace function public.mg_can_access_site_row(
  p_site_id       uuid,
  p_county        text,
  p_district      text,
  p_operator_name text,
  p_org_id        uuid
)
returns boolean
language sql
stable
security definer set search_path = public
as $mg$
  select coalesce(
    (
      select public.mg_is_admin()
        -- Staff: scope matrix + any explicit site assignment.
        or exists (
          select 1
            from public.mg_profile() p
           where p.role in ('admin','supervisor','inspector')
             and (
                   p.scope = 'national'
                or (p.scope = 'county' and p.county = p_county)
                or (p.scope = 'regional' and exists (
                      select 1
                        from public.admin_areas c
                        join public.admin_areas r on r.id = c.parent_id
                       where c.level = 'county'
                         and c.name = p_county
                         and r.id = p.scope_area_id))
                or (p.scope = 'district' and exists (
                      select 1
                        from public.admin_areas d
                       where d.level = 'district'
                         and d.id = p.scope_area_id
                         and d.name = p_district
                         and d.parent_id = (select a.id
                                              from public.admin_areas a
                                             where a.level = 'county'
                                               and a.name = p_county)))
                or exists (
                      select 1
                        from public.site_assignments sa
                       where sa.user_id = p.id
                         and sa.site_id = p_site_id)
             )
        )
        -- Operators: organization UUID, with name matching ONLY as the
        -- legacy fallback for profiles not yet bound to an organization.
        or exists (
          select 1
            from public.mg_profile() p
           where p.role = 'operator'
             and (
                   (p.organization_id is not null and p.organization_id = p_org_id)
                or (p.organization_id is null and p.operator_name = p_operator_name)
             )
        )
    ),
    false)
$mg$;

create or replace function public.mg_can_access_site(p_site_id uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $mg$
  select coalesce(
    (
      select public.mg_can_access_site_row(
               s.id, s.county, s.district, s.operator_name, s.organization_id)
        from public.sites s
       where s.id = p_site_id
    ),
    false)
$mg$;

-- Sites policies: visibility through the full matrix, writes through the
-- permissions table (identical behaviour for every seeded persona — only
-- admin holds sites.insert/sites.update — but now revocable per role
-- without editing policy SQL).
drop policy if exists "sites read" on public.sites;
create policy "sites read" on public.sites
  for select using (
    public.mg_can_access_site_row(id, county, district, operator_name, organization_id)
  );

drop policy if exists "sites insert" on public.sites;
create policy "sites insert" on public.sites
  for insert with check (public.mg_has_permission('sites.insert'));

drop policy if exists "sites update" on public.sites;
create policy "sites update" on public.sites
  for update using (public.mg_has_permission('sites.update'))
  with check (public.mg_has_permission('sites.update'));

-- Audit read: same roles as the old mg_is_staff() filter (the seeded matrix
-- grants audit.read to admin + supervisor + inspector, nobody else), now
-- sourced from the permissions table. Policy name kept so the audit_log
-- policy surface stays exactly one row.
drop policy if exists "audit staff read" on public.audit_log;
create policy "audit staff read" on public.audit_log
  for select using (public.mg_has_permission('audit.read'));

-- Retire the pre-0010 two-argument row form (no remaining callers: the
-- "sites read" policy and mg_can_access_site() above are recreated already).
drop function if exists public.mg_can_access_site_row(text, text);

-- ---------------------------------------------------------------------------
-- J. Profile guard parity: the new tenancy columns join role/scope/county/
--    operator_name/email as admin-only fields (self-service profile edits
--    can never move their own tenant key). Otherwise 0004's body verbatim.
-- ---------------------------------------------------------------------------
create or replace function public.mg_guard_profile_update()
returns trigger
language plpgsql security invoker set search_path = public
as $mg$
begin
  if current_user <> 'authenticated' then
    return new; -- security-definer RPCs / direct database maintenance
  end if;

  if auth.uid() is null or auth.uid() <> new.id then
    if not public.mg_is_admin() then
      raise exception 'FORBIDDEN';
    end if;
    return new; -- admin provisioning another account
  end if;

  if new.role is distinct from old.role
     or new.scope is distinct from old.scope
     or new.county is distinct from old.county
     or new.operator_name is distinct from old.operator_name
     or new.organization_id is distinct from old.organization_id
     or new.scope_area_id is distinct from old.scope_area_id
     or new.email is distinct from old.email then
    -- First-run bootstrap: while NO profile holds a role, the first
    -- signed-in account may claim admin (documented onboarding flow).
    if new.role = 'admin' and old.role is null
       and not public.mg_any_profile_role() then
      return new;
    end if;
    raise exception 'FORBIDDEN_ROLE_CHANGE';
  end if;
  return new;
end;
$mg$;

-- ---------------------------------------------------------------------------
-- K. Backfill — geography first (regional/district scopes resolve through
--    it), then one organization per distinct operator name, then bind sites
--    and profiles. All statements are no-ops on re-run.
-- ---------------------------------------------------------------------------
insert into public.admin_areas (level, name)
select 'national', 'Liberia'
where not exists (
  select 1 from public.admin_areas where level = 'national' and name = 'Liberia');

insert into public.admin_areas (level, name, parent_id)
select 'county', c.name,
       (select a.id from public.admin_areas a
         where a.level = 'national' order by a.created_at, a.id limit 1)
  from (
        select distinct county as name from public.sites
         where county is not null and btrim(county) <> ''
        union
        select distinct county from public.profiles
         where county is not null and btrim(county) <> ''
        union
        select distinct county from public.community_reports
         where county is not null and btrim(county) <> ''
       ) c
 where not exists (
  select 1 from public.admin_areas a where a.level = 'county' and a.name = c.name);

insert into public.admin_areas (level, name, parent_id)
select distinct 'district', x.district, c.id
  from (
        select district, county from public.sites where district is not null
        union
        select district, county from public.community_reports
         where district is not null
       ) x
  join public.admin_areas c on c.level = 'county' and c.name = x.county
 where btrim(x.district) <> ''
   and not exists (
    select 1 from public.admin_areas a
     where a.level = 'district' and a.name = x.district and a.parent_id = c.id);

insert into public.admin_areas (level, name, parent_id)
select distinct 'community', x.community, coalesce(d.id, c.id)
  from (
        select community, district, county from public.sites
         where community is not null
        union
        select community, district, county from public.community_reports
         where community is not null
       ) x
  join public.admin_areas c on c.level = 'county' and c.name = x.county
  left join public.admin_areas d
         on d.level = 'district' and d.name = x.district and d.parent_id = c.id
 where btrim(x.community) <> ''
   and not exists (
    select 1 from public.admin_areas a
     where a.level = 'community' and a.name = x.community
       and a.parent_id = coalesce(d.id, c.id));

insert into public.organizations (name, kind)
select distinct src.name, 'operator'
  from (
        select btrim(operator_name) as name from public.sites
         where operator_name is not null and btrim(operator_name) <> ''
        union
        select btrim(operator_name) from public.profiles
         where operator_name is not null and btrim(operator_name) <> ''
       ) src
 where not exists (
  select 1 from public.organizations o
   where lower(o.name) = lower(src.name));

-- Only organization_id is written here: listing operator_name in the SET
-- clause would fire sites_rescope (0001) on a live lineage, whose cascaded
-- child updates hit the session-less guard triggers and abort the migration.
-- The display column is normalized by sites_org (BEFORE UPDATE) instead —
-- same transaction, no rescope, child stamps keep their original case.
update public.sites s
   set organization_id = (
         select o.id from public.organizations o
          where lower(o.name) = lower(s.operator_name)
          order by o.created_at, o.id limit 1)
 where s.organization_id is null
   and exists (
    select 1 from public.organizations o
     where lower(o.name) = lower(s.operator_name));

update public.profiles p
   set organization_id = (
         select o.id from public.organizations o
          where lower(o.name) = lower(p.operator_name)
          order by o.created_at, o.id limit 1)
 where p.organization_id is null
   and p.operator_name is not null
   and exists (
    select 1 from public.organizations o
     where lower(o.name) = lower(p.operator_name));

-- ---------------------------------------------------------------------------
-- L. Privileges on the new surface.
--   * Policy helpers need EXECUTE for the roles whose policies call them
--     (RLS expressions run as the calling role — 0002's parity note).
--   * mg_resolve_organization and the sync/guard triggers are definer or
--     trigger-only machinery: clients get no callable surface onto them, so
--     nobody can mint organizations or bypass the guards via RPC. (Re-applied
--     when 0002 is re-run by the idempotency suite, which re-grants EXECUTE
--     on every function to both client roles.)
-- ---------------------------------------------------------------------------
grant execute on function public.mg_has_permission(text) to anon, authenticated;
grant execute on function public.mg_can_access_site(uuid) to anon, authenticated;
grant execute on function public.mg_can_access_site_row(uuid, text, text, text, uuid)
  to anon, authenticated;

revoke execute on function public.mg_resolve_organization(text) from anon, authenticated;
revoke execute on function public.mg_sync_site_org() from anon, authenticated;
revoke execute on function public.mg_sync_profile_org() from anon, authenticated;
revoke execute on function public.mg_sync_org_rename() from anon, authenticated;
revoke execute on function public.mg_guard_org_write() from anon, authenticated;

commit;
