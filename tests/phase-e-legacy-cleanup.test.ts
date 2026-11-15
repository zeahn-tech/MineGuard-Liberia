// ---------------------------------------------------------------------------
// Migration 0060 retires the legacy layer that survived in production (found by the staging rehearsal and the
// follow-up inventory). Production's legacy objects are rebuilt on a clean build from the definitions captured from the
// live database; 0060 is applied; the full schema fingerprint (functions, policies, storage policies, triggers,
// constraints, columns, RLS flags, function execute rights) must then equal the clean build again.
// Every scenario rolls back.
// ---------------------------------------------------------------------------
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDb, getFixture, withRole, type Runner } from "./helpers/pglite-db";

const root = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const FINGERPRINT = read("supabase/checks/schema_fingerprint.sql");
const POSTURE = read("supabase/checks/security_posture.sql");
const mig = read("supabase/migrations/0060_retire_legacy_layer.sql").replace(/^begin;$/m, "").replace(/^commit;$/m, "");
const exec = async (sql: string) => void (await (await getDb()).exec(sql));
const as = (run: Runner, uid: string) => run(`select set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true)`);
let f: Awaited<ReturnType<typeof getFixture>>;
beforeAll(async () => { f = await getFixture(); });

const REPO_TRIGGERS = [
  ["corrective_actions", "corrective_actions_guard"], ["corrective_actions", "corrective_actions_stamp"],
  ["environmental_observations", "environmental_observations_guard"], ["environmental_observations", "environmental_observations_stamp"],
  ["evidence", "evidence_stamp"], ["findings", "findings_guard"], ["findings", "findings_stamp"],
  ["incidents", "incidents_guard"], ["incidents", "incidents_stamp"], ["inspections", "inspections_guard"], ["profiles", "profiles_guard"],
];

// Production's legacy layer, as captured from the live database (definitions copied from pg_get_functiondef / pg_get_triggerdef).
const PRODUCTION_LEGACY = `
${REPO_TRIGGERS.map(([t, n]) => `drop trigger if exists ${n} on public.${t};`).join("\n")}
drop function if exists public.mg_guard_incident_update();
drop function if exists public.mg_guard_observation_update();

create or replace function public.mg_is_operator() returns boolean language sql stable security definer set search_path to 'public' as $f$
  select coalesce((select role = 'operator' from public.mg_profile()), false);
$f$;
create or replace function public.mg_stamp_site() returns trigger language plpgsql security definer set search_path to 'public' as $f$
declare s record;
begin
  select county, operator_name into s from public.sites where id = new.site_id;
  new.county := coalesce(s.county, 'Unknown');
  new.operator_name := coalesce(s.operator_name, 'Unknown');
  return new;
end $f$;
create or replace function public.mg_guard_staff_update() returns trigger language plpgsql security definer set search_path to 'public' as $f$
begin
  if current_user <> 'authenticated' then return new; end if;
  if not public.mg_is_staff() then raise exception 'FORBIDDEN'; end if;
  return new;
end $f$;
create or replace function public.mg_can_read_county_rows(p_county text) returns boolean language sql stable security definer set search_path to 'public' as $f$
  select coalesce((select case when p.role = 'admin' then true when p.role in ('supervisor','inspector') then (p.scope = 'national') or (p.scope = 'county' and p.county = p_county) else false end from public.mg_profile() p), false);
$f$;
create or replace function public.mg_can_access_site_row(p_county text, p_operator_name text) returns boolean language sql stable security definer set search_path to 'public' as $f$
  select coalesce((select public.mg_is_admin() or (public.mg_is_staff() and (select scope from public.mg_profile()) = 'national')
       or (public.mg_is_staff() and (select scope from public.mg_profile()) = 'county' and (select county from public.mg_profile()) = p_county)
       or ((select role from public.mg_profile()) = 'operator' and (select operator_name from public.mg_profile()) = p_operator_name)), false);
$f$;
create or replace function public.mg_can_access_site(p_county text, p_operator text) returns boolean language sql stable security definer set search_path to 'public' as $f$
  select coalesce((select case when p.role = 'admin' then true when p.role = 'operator' then p.operator_name is not null and p.operator_name = p_operator
      when p.role in ('supervisor','inspector') then (p.scope = 'national') or (p.scope = 'county' and p.county is not null and p.county = p_county) else false end from public.mg_profile() p), false);
$f$;
create or replace function public.mg_guard_finding_update() returns trigger language plpgsql security definer set search_path to 'public' as $f$
begin
  if current_user <> 'authenticated' then return new; end if;
  if old.created_by_id = auth.uid() or public.mg_is_reviewer() then return new; end if;
  if public.mg_is_operator() and new.status = 'acknowledged' and old.status = 'open'
     and new.operator_name = (select operator_name from public.mg_profile()) then return new; end if;
  raise exception 'FORBIDDEN';
end $f$;

create trigger guard_ca_update before update on public.corrective_actions for each row execute function mg_guard_ca_update();
create trigger stamp_site_cas before insert on public.corrective_actions for each row execute function mg_stamp_site();
create trigger guard_obs_update before update on public.environmental_observations for each row execute function mg_guard_staff_update();
create trigger stamp_site_obs before insert on public.environmental_observations for each row execute function mg_stamp_site();
create trigger stamp_site_evidence before insert on public.evidence for each row execute function mg_stamp_site();
create trigger guard_finding_update before update on public.findings for each row execute function mg_guard_finding_update();
create trigger stamp_site_findings before insert on public.findings for each row execute function mg_stamp_site();
create trigger guard_incident_update before update on public.incidents for each row execute function mg_guard_staff_update();
create trigger stamp_site_incidents before insert on public.incidents for each row execute function mg_stamp_site();
create trigger guard_inspection_update before update on public.inspections for each row execute function mg_guard_inspection_update();
create trigger stamp_site_inspections before insert on public.inspections for each row execute function mg_stamp_site();
create trigger guard_profile_update before update on public.profiles for each row execute function mg_guard_profile_update();

alter table public.inspections add column county text not null default 'Unknown', add column operator_name text not null default 'Unknown';
create index inspections_county_idx on public.inspections using btree (county);
create index inspections_operator_idx on public.inspections using btree (operator_name);

create policy "evidence storage read" on storage.objects for select to authenticated using (
  bucket_id = 'evidence' and ((storage.foldername(name))[1] = (auth.uid())::text
    or exists (select 1 from evidence e where e.storage_path = objects.name and mg_can_access_site(e.county, e.operator_name))));
create policy "tracking select public" on public.report_tracking for select to public using (true);

grant execute on function public.mg_backfill_scope_stamps() to public, anon, authenticated;
grant execute on function public.mg_guard_report_update() to public, anon, authenticated;
grant execute on function public.mg_operator_name() to public, anon, authenticated;
`;

const fp = async () => ((await (await getDb()).query(FINGERPRINT)).rows as { kind: string; obj: string; h: string }[]);
const key = (r: { kind: string; obj: string }) => `${r.kind}|${r.obj}`;
const diff = (a: { kind: string; obj: string; h: string }[], b: { kind: string; obj: string; h: string }[]) => {
  const m = new Map(a.map((r) => [key(r), r.h])), n = new Map(b.map((r) => [key(r), r.h]));
  return {
    changed: b.filter((r) => m.has(key(r)) && m.get(key(r)) !== r.h).map(key),
    added: b.filter((r) => !m.has(key(r))).map(key),
    removed: a.filter((r) => !n.has(key(r))).map(key),
  };
};
const rejects = async (sql: string) => {
  await exec("savepoint chk");
  try { await exec(sql); await exec("release savepoint chk"); } catch (e) { await exec("rollback to savepoint chk"); return String((e as Error).message); }
  return "";
};

describe("0060 — retires the legacy layer production still carries", () => {
  test("production's legacy layer, then 0060, converges the whole schema fingerprint back to the clean build", async () => {
    await withRole("postgres", null, async () => {
      const clean = await fp();
      await exec(PRODUCTION_LEGACY);
      const legacy = diff(clean, await fp());
      // the simulation really reproduces the drift the rehearsal saw (functions, triggers, storage policy, policy, columns, execute rights)
      expect(legacy.added.length + legacy.removed.length + legacy.changed.length).toBeGreaterThan(30);
      expect(legacy.added).toContain("storage_policy|objects.evidence storage read");
      expect(legacy.added).toContain("policy|report_tracking.tracking select public");
      expect(legacy.added).toContain("column|inspections.county");

      await exec(mig);
      const after = diff(clean, await fp());
      expect(after).toEqual({ changed: [], added: [], removed: [] });
    });
  });

  test("0060 is idempotent on a database that is already clean", async () => {
    await withRole("postgres", null, async () => {
      const clean = await fp();
      await exec(mig);
      await exec(mig);
      expect(diff(clean, await fp())).toEqual({ changed: [], added: [], removed: [] });
    });
  });

  test("the tracking-code enumeration is closed: a signed-in non-staff account lists every tracking code before, none after", async () => {
    await withRole("postgres", null, async (run) => {
      await exec(PRODUCTION_LEGACY);
      await run("set local role authenticated");
      await as(run, f.opA);
      expect(Number((await run("select count(*) n from public.report_tracking"))[0].n)).toBeGreaterThan(0); // the exposure
      await run("reset role");
      await exec(mig);
      await run("set local role authenticated");
      await as(run, f.opA);
      expect(Number((await run("select count(*) n from public.report_tracking"))[0].n)).toBe(0);
      await as(run, f.admin);
      expect(Number((await run("select count(*) n from public.report_tracking"))[0].n)).toBeGreaterThan(0); // staff keep their read
    });
  });

  test("the posture check flags the legacy layer and passes after 0060", async () => {
    await withRole("postgres", null, async () => {
      expect(await rejects(POSTURE)).toBe(""); // clean build passes
      await exec(PRODUCTION_LEGACY);
      expect(await rejects(POSTURE)).toMatch(/SECURITY POSTURE/);
      await exec(mig);
      expect(await rejects(POSTURE)).toBe("");
    });
  });

  test("converged guards still behave: staff can update an incident and an operator of another company cannot", async () => {
    await withRole("postgres", null, async (run) => {
      await exec(PRODUCTION_LEGACY);
      await exec(mig);
      await run("set local role authenticated");
      await as(run, f.admin);
      await exec("savepoint s1");
      await run(`update public.incidents set description = description where id = '${f.incidentA}'`);
      await exec("release savepoint s1");
      await as(run, f.opB); // an operator of another company: no access to this incident
      await exec("savepoint s2");
      let blocked = "";
      try { await run(`update public.incidents set description = 'tampered' where id = '${f.incidentA}'`); } catch (e) { blocked = String((e as Error).message); }
      await exec("rollback to savepoint s2");
      const touched = Number((await run(`select count(*) n from public.incidents where id = '${f.incidentA}' and description = 'tampered'`))[0].n);
      expect(touched).toBe(0);
      expect(blocked === "" || /FORBIDDEN|row-level security|permission/i.test(blocked)).toBe(true);
    });
  });
});
