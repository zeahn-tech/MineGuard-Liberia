-- ============================================================================
-- MINEGUARD LIBERIA — migration 0009: audit & integrity foundation
-- (SEC-1, SEC-2, SEC-3 of the security roadmap)
--
-- Before this migration the audit trail had three structural defects:
--   1. AUDIT ROWS WERE CLIENT-WRITTEN. audit_log carried an "audit append"
--      INSERT policy (auth.uid() is not null) and a blanket client INSERT
--      grant, so any signed-in session could insert arbitrary rows with a
--      forged actor_label, and a client that crashed between its mutation
--      and its logAudit() call silently lost the trail.
--   2. MUTATIONS LEFT NO SERVER-SIDE TRACE. There was no before/after diff,
--      no server-derived actor on the row itself, and no way to tell a
--      tampered row from a real one.
--   3. CLIENTS COULD DELETE. 0002 granted DELETE on every public table to
--      anon + authenticated, and the default privileges kept re-granting it.
--      Templates even had an admin DELETE policy (0008).
--
-- What this migration does (statement-by-statement, single transaction,
-- idempotent — safe to re-run; verified by tests/migration-apply.test.ts and
-- tests/rls.test.ts):
--
--   SEC-1  A SECURITY DEFINER trigger (mg_audit_row) now writes ONE audit row
--          for every INSERT and UPDATE on each domain table. actor_id comes
--          from auth.uid() — the session — never from the client-supplied
--          row; entity, timestamp and a structured before/after diff
--          (audit_log.details) are written in the same transaction as the
--          mutation, so a client crash cannot lose or forge the trail.
--          Client INSERT/UPDATE on audit_log is revoked and the "audit
--          append" policy is dropped. The client-side logAudit() helper in
--          src/lib/backend.ts is demoted to a non-authoritative breadcrumb.
--          triage_community_report() loses its manual audit INSERT — the
--          triggers are now the single writer (exactly one row per mutation).
--
--   SEC-2  updated_at / updated_by / row_version columns on all ten domain
--          tables, stamped by a BEFORE trigger (mg_touch_row) that OVERWRITES
--          any client-supplied value: row_version increments on every
--          UPDATE, updated_by is always auth.uid().
--          Soft-delete lifecycle: inspection_templates gains archived_at;
--          archiving replaces deletion (client DELETE is revoked outright,
--          the template guard refuses DELETE, the 0008 "templates delete"
--          policy is dropped).
--
--   SEC-3  REVOKE DELETE on every public table from anon + authenticated
--          (belt: the guard triggers still refuse sites/template deletes),
--          anon is trimmed to the bare minimum — SELECT on the two public
--          mirrors (meta, report_tracking) plus its documented RPC execute
--          surface — and the default privileges are re-written so FUTURE
--          tables never hand out DELETE or any anon table grant again.
--
-- Acceptance (tests/rls.test.ts "SEC-1/2/3" + tests/migration-apply.test.ts):
--   * forged audit insert fails for every client role (anon + all personas)
--   * every mutation produces exactly one server-written audit row, with the
--     session user as actor, even though the client never writes the log
--   * no DELETE succeeds for any client role (including admin)
--   * row_version increments and spoofed row_version/updated_by are
--     overwritten by the server
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- SEC-1a: audit_log gains the structured before/after payload.
-- The original columns stay as they are (actor/actor_label/action/entity/
-- summary already match what the UI reads via mapAudit()).
-- ---------------------------------------------------------------------------
alter table public.audit_log add column if not exists details jsonb;

-- ---------------------------------------------------------------------------
-- SEC-2a: integrity columns on every domain table.
-- row_version is NOT NULL default 1 so existing rows (live lineage) backfill
-- correctly; updated_at/updated_by are stamped exclusively by mg_touch_row.
-- ---------------------------------------------------------------------------
alter table public.profiles                   add column if not exists updated_at    timestamptz;
alter table public.profiles                   add column if not exists updated_by    uuid;
alter table public.profiles                   add column if not exists row_version   integer not null default 1;
alter table public.sites                      add column if not exists updated_at    timestamptz;
alter table public.sites                      add column if not exists updated_by    uuid;
alter table public.sites                      add column if not exists row_version   integer not null default 1;
alter table public.inspection_templates       add column if not exists updated_at    timestamptz;
alter table public.inspection_templates       add column if not exists updated_by    uuid;
alter table public.inspection_templates       add column if not exists row_version   integer not null default 1;
alter table public.inspections                add column if not exists updated_at    timestamptz;
alter table public.inspections                add column if not exists updated_by    uuid;
alter table public.inspections                add column if not exists row_version   integer not null default 1;
alter table public.findings                   add column if not exists updated_at    timestamptz;
alter table public.findings                   add column if not exists updated_by    uuid;
alter table public.findings                   add column if not exists row_version   integer not null default 1;
alter table public.corrective_actions         add column if not exists updated_at    timestamptz;
alter table public.corrective_actions         add column if not exists updated_by    uuid;
alter table public.corrective_actions         add column if not exists row_version   integer not null default 1;
alter table public.incidents                  add column if not exists updated_at    timestamptz;
alter table public.incidents                  add column if not exists updated_by    uuid;
alter table public.incidents                  add column if not exists row_version   integer not null default 1;
alter table public.environmental_observations add column if not exists updated_at    timestamptz;
alter table public.environmental_observations add column if not exists updated_by    uuid;
alter table public.environmental_observations add column if not exists row_version   integer not null default 1;
alter table public.community_reports          add column if not exists updated_at    timestamptz;
alter table public.community_reports          add column if not exists updated_by    uuid;
alter table public.community_reports          add column if not exists row_version   integer not null default 1;
alter table public.evidence                   add column if not exists updated_at    timestamptz;
alter table public.evidence                   add column if not exists updated_by    uuid;
alter table public.evidence                   add column if not exists row_version   integer not null default 1;

-- ---------------------------------------------------------------------------
-- SEC-2b: templates are archived, never deleted (soft lifecycle).
-- ---------------------------------------------------------------------------
alter table public.inspection_templates add column if not exists archived_at timestamptz;

-- ---------------------------------------------------------------------------
-- SEC-2c: server-side stamping trigger. Runs BEFORE INSERT/UPDATE and
-- OVERWRITES whatever the client sent for the three integrity columns —
-- the client can name them in an UPDATE but can never set them.
-- SECURITY DEFINER so auth.uid() is read with a stable search_path; the
-- function only touches NEW/OLD (the row the statement already authorized).
-- ---------------------------------------------------------------------------
create or replace function public.mg_touch_row()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.updated_at  := now();
    new.updated_by  := auth.uid();   -- session identity, never client-supplied
    new.row_version := 1;            -- spoofed pre-bumps are overwritten
    return new;
  end if;
  -- UPDATE
  new.updated_at  := now();
  new.updated_by  := auth.uid();     -- spoofed actors are overwritten
  new.row_version := coalesce(old.row_version, 0) + 1;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- SEC-1b: the authoritative audit writer. AFTER INSERT/UPDATE, one row per
-- mutated row, written in the SAME transaction as the mutation (a client
-- crash after commit cannot lose it; a crash before commit takes the
-- mutation with it — trail and mutation are atomic).
--
--   * actor_id  = auth.uid() filtered through profiles (FK-safe); null for
--                 definer/system writes with no session → actor_label
--                 'system' / 'unregistered:<sub>'.
--   * entity    = the table (entity_type) + row id (entity_id).
--   * timestamp = created_at (server clock).
--   * diff      = details: {before, after} of the CHANGED business columns
--                 for updates (the stamp columns change every time and
--                 would drown the signal), full row under 'after' on insert.
--   * action    = '<table>.insert' / '<table>.update'.
--
-- SECURITY DEFINER: clients hold no INSERT privilege on audit_log anymore,
-- so the trigger must insert with the function owner's rights. audit_log has
-- no audit trigger of its own — no recursion.
-- ---------------------------------------------------------------------------
create or replace function public.mg_audit_row()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_actor   uuid;
  v_label   text;
  v_id      text;
  v_row     jsonb;
  v_before  jsonb;
  v_after   jsonb;
  v_b_diff  jsonb := '{}'::jsonb;
  v_a_diff  jsonb := '{}'::jsonb;
  v_keys    text[] := '{}';
  v_summary text;
begin
  -- Actor from the SESSION only. The row's own columns are never trusted
  -- for attribution (SEC-1 acceptance: forged actor impossible).
  select p.id, coalesce(p.email, p.name, 'system')
    into v_actor, v_label
    from public.profiles p
   where p.id = v_uid;
  if v_label is null then
    v_label := case when v_uid is null then 'system'
                    else 'unregistered:' || v_uid::text end;
  end if;

  v_row := to_jsonb(new);
  v_id  := v_row ->> 'id';

  if tg_op = 'INSERT' then
    insert into public.audit_log
      (actor_id, actor_label, action, entity_type, entity_id, summary, details)
    values (
      v_actor,
      v_label,
      tg_table_name || '.insert',
      tg_table_name,
      v_id,
      tg_table_name || ' ' || coalesce(v_id, '?') || ' created',
      jsonb_build_object('before', null, 'after', v_row)
    );
    return new;
  end if;

  -- UPDATE: business-column diff (stamp columns excluded by design).
  v_before := (to_jsonb(old) - 'updated_at' - 'updated_by' - 'row_version');
  v_after  := (v_row        - 'updated_at' - 'updated_by' - 'row_version');

  select coalesce(array_agg(e.k order by e.k), '{}'),
         coalesce(jsonb_object_agg(e.k, v_before -> e.k), '{}'::jsonb),
         coalesce(jsonb_object_agg(e.k, v_after  -> e.k), '{}'::jsonb)
    into v_keys, v_b_diff, v_a_diff
    from jsonb_each(v_before) e(k, val)
   where (v_after -> e.k) is distinct from e.val;

  if coalesce(array_length(v_keys, 1), 0) = 0 then
    v_summary := tg_table_name || ' ' || coalesce(v_id, '?') || ' touched';
  else
    v_summary := tg_table_name || ' ' || coalesce(v_id, '?')
               || ' updated (' || array_to_string(v_keys, ', ') || ')';
    if 'status' = any (v_keys) then
      v_summary := v_summary || format(' status: %s -> %s',
                     coalesce(v_before ->> 'status', 'null'),
                     coalesce(v_after  ->> 'status', 'null'));
    end if;
  end if;

  insert into public.audit_log
    (actor_id, actor_label, action, entity_type, entity_id, summary, details)
  values (
    v_actor,
    v_label,
    tg_table_name || '.update',
    tg_table_name,
    v_id,
    v_summary,
    jsonb_build_object('before', v_b_diff, 'after', v_a_diff)
  );
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- SEC-1c/SEC-2d: attach exactly ONE touch + ONE audit trigger per domain
-- table. Exactly one ⇒ acceptance "exactly one audit row per mutation".
-- DROP IF EXISTS first: this file must be re-runnable (idempotency tests).
-- Only INSERT/UPDATE are audited: client DELETE no longer exists at all
-- (SEC-3), and the remaining owner-only deletes are test/ops fixtures.
-- ---------------------------------------------------------------------------
drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before insert or update on public.profiles
  for each row execute function public.mg_touch_row();
drop trigger if exists profiles_audit on public.profiles;
create trigger profiles_audit after insert or update on public.profiles
  for each row execute function public.mg_audit_row();

drop trigger if exists sites_touch on public.sites;
create trigger sites_touch before insert or update on public.sites
  for each row execute function public.mg_touch_row();
drop trigger if exists sites_audit on public.sites;
create trigger sites_audit after insert or update on public.sites
  for each row execute function public.mg_audit_row();

drop trigger if exists inspection_templates_touch on public.inspection_templates;
create trigger inspection_templates_touch before insert or update on public.inspection_templates
  for each row execute function public.mg_touch_row();
drop trigger if exists inspection_templates_audit on public.inspection_templates;
create trigger inspection_templates_audit after insert or update on public.inspection_templates
  for each row execute function public.mg_audit_row();

drop trigger if exists inspections_touch on public.inspections;
create trigger inspections_touch before insert or update on public.inspections
  for each row execute function public.mg_touch_row();
drop trigger if exists inspections_audit on public.inspections;
create trigger inspections_audit after insert or update on public.inspections
  for each row execute function public.mg_audit_row();

drop trigger if exists findings_touch on public.findings;
create trigger findings_touch before insert or update on public.findings
  for each row execute function public.mg_touch_row();
drop trigger if exists findings_audit on public.findings;
create trigger findings_audit after insert or update on public.findings
  for each row execute function public.mg_audit_row();

drop trigger if exists corrective_actions_touch on public.corrective_actions;
create trigger corrective_actions_touch before insert or update on public.corrective_actions
  for each row execute function public.mg_touch_row();
drop trigger if exists corrective_actions_audit on public.corrective_actions;
create trigger corrective_actions_audit after insert or update on public.corrective_actions
  for each row execute function public.mg_audit_row();

drop trigger if exists incidents_touch on public.incidents;
create trigger incidents_touch before insert or update on public.incidents
  for each row execute function public.mg_touch_row();
drop trigger if exists incidents_audit on public.incidents;
create trigger incidents_audit after insert or update on public.incidents
  for each row execute function public.mg_audit_row();

drop trigger if exists environmental_observations_touch on public.environmental_observations;
create trigger environmental_observations_touch before insert or update on public.environmental_observations
  for each row execute function public.mg_touch_row();
drop trigger if exists environmental_observations_audit on public.environmental_observations;
create trigger environmental_observations_audit after insert or update on public.environmental_observations
  for each row execute function public.mg_audit_row();

drop trigger if exists community_reports_touch on public.community_reports;
create trigger community_reports_touch before insert or update on public.community_reports
  for each row execute function public.mg_touch_row();
drop trigger if exists community_reports_audit on public.community_reports;
create trigger community_reports_audit after insert or update on public.community_reports
  for each row execute function public.mg_audit_row();

drop trigger if exists evidence_touch on public.evidence;
create trigger evidence_touch before insert or update on public.evidence
  for each row execute function public.mg_touch_row();
drop trigger if exists evidence_audit on public.evidence;
create trigger evidence_audit after insert or update on public.evidence
  for each row execute function public.mg_audit_row();

-- ---------------------------------------------------------------------------
-- SEC-2e: templates archive instead of delete.
-- The guard's DELETE branch previously ALLOWED admin deletes (paired with
-- 0008's DELETE policy). Both are gone: the policy is dropped and the guard
-- now refuses DELETE for everyone (defense in depth behind the privilege
-- revoke below). INSERT/UPDATE behaviour (staff-managed) is unchanged.
-- ---------------------------------------------------------------------------
create or replace function public.mg_guard_template_write()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'ARCHIVE_ONLY: templates are archived, not deleted';
  end if;
  if not public.mg_is_staff() then
    raise exception 'FORBIDDEN: staff required to manage templates';
  end if;
  return coalesce(new, old);
end;
$$;

drop policy if exists "templates delete" on public.inspection_templates;

-- ---------------------------------------------------------------------------
-- SEC-1d: triage_community_report() loses its hand-rolled audit INSERT.
-- The community_reports UPDATE already fires mg_audit_row, which writes
-- exactly one row with the session actor and the full status diff — the
-- manual row was a second, weaker copy (and the only writer that could be
-- skipped if a future branch forgot it). Function signature unchanged.
-- ---------------------------------------------------------------------------
create or replace function public.triage_community_report(
  p_report_id uuid,
  p_decision  text,
  p_note      text default null
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_report public.community_reports%rowtype;
begin
  if not public.mg_is_reviewer() then
    raise exception 'FORBIDDEN: reviewer role required';
  end if;
  select * into v_report from public.community_reports where id = p_report_id;
  if not found then raise exception 'NOT_FOUND'; end if;

  update public.community_reports
    set status = p_decision::report_state,
        triage_note = p_note,
        reviewed_by_id = auth.uid(),
        reviewed_at = now()
    where id = p_report_id;

  update public.report_tracking
    set status = p_decision
    where tracking_code = v_report.tracking_code;
  -- Audit row: written by the community_reports audit trigger (exactly one,
  -- actor = auth.uid(), details carry submitted -> triaged status diff).
end;
$$;

-- ---------------------------------------------------------------------------
-- SEC-1e: nobody but the server writes audit_log.
--   * "audit append" (0001) dropped — no policy means no row under RLS.
--   * INSERT/UPDATE/DELETE privileges revoked from both client roles — the
--     privilege layer refuses even before RLS is consulted.
--   * SELECT stays: "audit staff read" (mg_is_staff) remains the row filter
--     for the audit surface. The definer trigger and definer RPCs insert
--     with the owner's rights, unaffected by client revokes.
-- ---------------------------------------------------------------------------
drop policy if exists "audit append" on public.audit_log;
revoke insert, update, delete on public.audit_log from anon, authenticated;

-- ---------------------------------------------------------------------------
-- SEC-3: no client role may DELETE anything, and anon drops to the minimum
-- read surface (public RPCs + the two world-readable mirrors).
--   * authenticated: keeps SELECT/INSERT/UPDATE (RLS is the row boundary),
--     loses DELETE — soft lifecycle everywhere (archive/unpublish/status).
--   * anon: loses every table privilege; re-granted SELECT on meta +
--     report_tracking only. Public flows go through SECURITY DEFINER RPCs
--     (submit_community_report, refresh_public_stats), which need no client
--     table grants at all.
-- ---------------------------------------------------------------------------
revoke delete on all tables in schema public from anon, authenticated;
revoke all on all tables in schema public from anon;
grant select on public.meta to anon;
grant select on public.report_tracking to anon;
revoke usage, select on all sequences in schema public from anon;

-- Future tables: 0002's default privileges re-granted SELECT/INSERT/UPDATE/
-- DELETE to both client roles on every new table. Rewrite the defaults so a
-- table created by a LATER migration starts closed: no DELETE for anyone,
-- no anon table grants at all. (Public mirrors still get an explicit
-- `grant select` in the migration that introduces them.)
alter default privileges in schema public revoke delete on tables from authenticated;
alter default privileges in schema public revoke select, insert, update, delete on tables from anon;
alter default privileges in schema public revoke usage, select on sequences from anon;

commit;
