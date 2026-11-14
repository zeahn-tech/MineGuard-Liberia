// ---------------------------------------------------------------------------
// Migration 0058 attaches guard triggers that production's schema lacks (found by the staging rehearsal).
// This rebuilds that unguarded state on a clean build, proves the gap, applies 0058, and proves it closed.
// Every scenario rolls back.
// ---------------------------------------------------------------------------
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDb, getFixture, withRole, type Runner } from "./helpers/pglite-db";

let f: Awaited<ReturnType<typeof getFixture>>;
const REPORT = "99999999-0000-4000-8000-000000000010";
const mig = readFileSync(join(import.meta.dir, "..", "supabase", "migrations", "0058_attach_missing_guard_triggers.sql"), "utf8")
  .replace(/^begin;$/m, "").replace(/^commit;$/m, "");
const exec = async (sql: string) => void (await (await getDb()).exec(sql));
const as = (run: Runner, uid: string) => run(`select set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true)`);
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return String((e as Error).message); } return ""; };
const savepointed = async (fn: () => Promise<unknown>) => {
  await exec("savepoint s1");
  const msg = await fails(fn());
  await exec(msg ? "rollback to savepoint s1" : "release savepoint s1");
  return msg;
};

beforeAll(async () => { f = await getFixture(); });

// production's state: the functions exist, the four triggers do not
const PRODUCTION_STATE = `
drop trigger if exists community_reports_guard on public.community_reports;
drop trigger if exists inspection_templates_guard on public.inspection_templates;
drop trigger if exists sites_guard on public.sites;
drop trigger if exists sites_rescope on public.sites;
drop function if exists public.mg_backfill_scope_stamps();
drop function if exists public.mg_operator_name();
`;

describe("0058 — guard triggers production lacks", () => {
  test("in production's state a staff user can rewrite report ownership and the tracking code (the gap)", async () => {
    await withRole("postgres", null, async (run) => {
      await exec(PRODUCTION_STATE);
      await run("set local role authenticated");
      await as(run, f.admin);
      expect(await savepointed(() => run(`update public.community_reports set submitter_id = '${f.guest}' where id = '${REPORT}'`))).toBe("");
      expect(await savepointed(() => run(`update public.community_reports set tracking_code = 'CR-HIJACKED' where id = '${REPORT}'`))).toBe("");
    });
  });

  test("after 0058 ownership and tracking code are immutable, transitions follow the rules, and legitimate triage still works", async () => {
    await withRole("postgres", null, async (run) => {
      await exec(PRODUCTION_STATE);
      await exec(mig);
      await run("set local role authenticated");
      await as(run, f.admin);
      expect(await savepointed(() => run(`update public.community_reports set submitter_id = '${f.guest}' where id = '${REPORT}'`))).toMatch(/ownership cannot be changed/);
      expect(await savepointed(() => run(`update public.community_reports set tracking_code = 'CR-HIJACKED' where id = '${REPORT}'`))).toMatch(/tracking code cannot be changed/);
      expect(await savepointed(() => run(`update public.community_reports set status = 'verified' where id = '${REPORT}'`))).toMatch(/NOT_REVIEWABLE|FORBIDDEN/); // submitted -> verified skips review
      expect(await savepointed(() => run(`update public.community_reports set status = 'under_review' where id = '${REPORT}'`))).toBe(""); // allowed step
    });
  });

  test("after 0058 sites and templates can never be deleted, and a site re-scope restamps its child rows", async () => {
    await withRole("postgres", null, async (run) => {
      await exec(PRODUCTION_STATE);
      const site = (await run(`insert into public.sites (code, name, operator_name, mineral_type, county, district, community, status, latitude, longitude, created_by)
        values ('LB-TMP-001','Temp','Tmp Co','Gold','Bomi','Senjeh','X','active',6.9,-10.9,'${f.admin}') returning id`))[0].id as string;
      const tpl = (await run(`select id from public.inspection_templates limit 1`))[0].id as string;
      // unguarded: a delete of a childless site goes through
      expect(await savepointed(() => run(`delete from public.sites where id = '${site}'`))).toBe("");
      await exec(mig);
      const site2 = (await run(`insert into public.sites (code, name, operator_name, mineral_type, county, district, community, status, latitude, longitude, created_by)
        values ('LB-TMP-002','Temp2','Tmp Co','Gold','Bomi','Senjeh','X','active',6.9,-10.9,'${f.admin}') returning id`))[0].id as string;
      expect(await savepointed(() => run(`delete from public.sites where id = '${site2}'`))).toMatch(/never deleted/);
      expect(await savepointed(() => run(`delete from public.inspection_templates where id = '${tpl}'`))).toMatch(/ARCHIVE_ONLY/);
      // re-scope restamps child rows
      const before = (await run(`select county from public.incidents where id = '${f.incidentA}'`))[0].county;
      const siteId = (await run(`select site_id from public.incidents where id = '${f.incidentA}'`))[0].site_id as string;
      await run("set local role authenticated");
      await as(run, f.admin); // the real flow: an administrator re-scopes a site
      await run(`update public.sites set county = 'Grand Cape Mount' where id = '${siteId}'`);
      await run("reset role");
      const after = (await run(`select county from public.incidents where id = '${f.incidentA}'`))[0].county;
      expect(before).not.toBe("Grand Cape Mount");
      expect(after).toBe("Grand Cape Mount");
    });
  });

  test("0058 is idempotent on a database that already has the guards", async () => {
    await withRole("postgres", null, async () => {
      expect(await savepointed(async () => { await exec(mig); await exec(mig); })).toBe("");
    });
  });
});
