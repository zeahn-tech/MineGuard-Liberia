// ---------------------------------------------------------------------------
// MIGRATION APPLICATION TESTS — the mechanical check the forensic re-audit
// (docs/11 §0.2) demanded: run every file under supabase/migrations/ against
// a COMPLETELY EMPTY database, in order, and fail if any statement errors.
//
// The original 0002 referenced types/signatures that did not exist in 0001
// (`report_status`, `evidence_parent_type`, enum params, a two-argument
// mg_can_access_site in the storage policy) and had no transaction, so a
// clean apply would have halted halfway and silently skipped the storage
// section. Applying the files through getDb() IS that verification: the
// helper throws with the offending migration name if anything fails.
// ---------------------------------------------------------------------------

import { beforeAll, describe, expect, test } from "bun:test";
import {
  getDb,
  getFixture,
  MIGRATIONS,
  PLATFORM_STUB,
  withRole,
  type Runner,
} from "./helpers/pglite-db";
import { readFileSync } from "node:fs";
import { join } from "node:path";

beforeAll(() => getFixture());

const ROOT = join(import.meta.dir, "..");

async function one(run: Runner, sql: string): Promise<Record<string, unknown>> {
  const rows = await run(sql);
  return rows[0];
}

function scalar(row: Record<string, unknown> | undefined): unknown {
  if (!row) return undefined;
  return Object.values(row)[0];
}

describe("migrations apply to a clean database", () => {
  test("every .sql file is discovered in order", () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(4);
    expect(MIGRATIONS).toEqual([...MIGRATIONS].sort());
    expect(MIGRATIONS[0]).toBe("0001_initial_schema.sql");
    // The session's own migrations must all be present in the repo listing.
    expect(MIGRATIONS).toContain("0002_grants_and_storage.sql");
    expect(MIGRATIONS).toContain("0003_profiles_read_hardening.sql");
    expect(MIGRATIONS).toContain("0005_per_source_report_rate_limit.sql");
    expect(MIGRATIONS).toContain("0009_audit_integrity.sql");
    expect(MIGRATIONS).toContain("0010_organizations_scopes_permissions.sql");
    expect(MIGRATIONS).toContain("0011_function_execute_surface.sql");
  });

  test("0001 core objects exist (tables, RLS, triggers, RPCs)", async () => {
    await withRole("postgres", null, async (run) => {
      const tables = await one(
        run,
        `select count(*) from information_schema.tables
          where table_schema = 'public' and table_type = 'BASE TABLE'`,
      );
      // 14 domain tables + evidence_url_audit (0006) + 0010's four
      // (organizations, admin_areas, site_assignments, permissions).
      expect(Number(scalar(tables))).toBe(19);

      const rls = await one(
        run,
        `select count(*) from pg_tables
          where schemaname = 'public' and rowsecurity = true`,
      );
      expect(Number(scalar(rls))).toBe(19);

      const guards = await one(
        run,
        `select count(*) from pg_trigger
          where tgname like '%_guard' and not tgisinternal`,
      );
      expect(Number(scalar(guards))).toBeGreaterThanOrEqual(9);
    });
  });

  test("0002 is idempotent — it can be re-run without error", async () => {
    const db = await getDb();
    const sql = readFileSync(
      join(ROOT, "supabase", "migrations", "0002_grants_and_storage.sql"),
      "utf8",
    );
    // db.exec resolves to the per-statement results (BEGIN/GRANT/…), so the
    // invariant is simply: re-running never errors, and the policy surface is
    // unchanged afterwards (no duplicate/overwritten policies).
    await db.exec(sql);
    await db.exec(sql);
    // 0002 is the historical GRANTS file: re-running it re-opens the client
    // surface (SELECT/INSERT/UPDATE/DELETE to anon + authenticated, and the
    // permissive default privileges — including EXECUTE on every function,
    // which revives mg_resolve_organization for anon). This suite shares ONE
    // database with every other test file, so re-apply 0009 (SEC-3 hardening),
    // 0010 (the tenant/permission work) and 0011 (the deny-by-default
    // function surface — 0002's blanket EXECUTE grants must not survive it)
    // to restore the hardened state before any later test observes it.
    await db.exec(
      readFileSync(
        join(ROOT, "supabase", "migrations", "0009_audit_integrity.sql"),
        "utf8",
      ),
    );
    await db.exec(
      readFileSync(
        join(ROOT, "supabase", "migrations", "0010_organizations_scopes_permissions.sql"),
        "utf8",
      ),
    );
    await db.exec(
      readFileSync(
        join(ROOT, "supabase", "migrations", "0011_function_execute_surface.sql"),
        "utf8",
      ),
    );
    const storage = await db.query<{ n: string }>(
      `select count(*)::text as n from pg_policies
        where schemaname = 'storage' and tablename = 'objects'`,
    );
    expect(Number(storage.rows[0]?.n)).toBe(3);
  });

  test("0003 is idempotent — it can be re-run without error", async () => {
    const db = await getDb();
    const sql = readFileSync(
      join(ROOT, "supabase", "migrations", "0003_profiles_read_hardening.sql"),
      "utf8",
    );
    await db.exec(sql);
    await db.exec(sql);
    const profiles = await db.query<{ n: string }>(
      `select count(*)::text as n from pg_policies
        where schemaname = 'public' and tablename = 'profiles'`,
    );
    expect(Number(profiles.rows[0]?.n)).toBe(3);
  });

  test("0005 is idempotent — it can be re-run without error", async () => {
    const db = await getDb();
    const sql = readFileSync(
      join(ROOT, "supabase", "migrations", "0005_per_source_report_rate_limit.sql"),
      "utf8",
    );
    await db.exec(sql);
    await db.exec(sql);
    const fns = await db.query<{ n: string }>(
      `select count(*)::text as n from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('submit_community_report', 'mg_client_ip')`,
    );
    // create or replace (not create) ⇒ re-running must never duplicate.
    expect(Number(fns.rows[0]?.n)).toBe(2);
  });

  test("0005 keeps the RPC signature that 0002 grants and the client calls", async () => {
    // Gap Closure Directive acceptance: same public contract. The identity
    // signature in pg_proc must still equal the one 0002's EXECUTE grant
    // names and src/lib/backend.ts invokes — otherwise a fresh install would
    // break the public reporting endpoint while looking green.
    const db = await getDb();
    const sig = await db.query<{ identity: string }>(
      `select pg_get_function_identity_arguments(p.oid) as identity
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'submit_community_report'`,
    );
    expect(sig.rows[0]?.identity).toBe(
      "p_tracking_code text, p_category text, p_description text, p_county text, p_district text, p_community text, p_latitude double precision, p_longitude double precision, p_contact_phone text",
    );
  });

  test("0005's limiter helper is stable and NOT security definer", async () => {
    // mg_client_ip reads a session GUC; it must not need (or carry) definer
    // privileges, and it must be marked stable so the planner can treat it
    // as constant within a statement.
    const db = await getDb();
    const rows = await db.query<{
      provolatile: string;
      prosecdef: boolean;
    }>(
      `select provolatile, prosecdef from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'mg_client_ip'`,
    );
    expect(rows.rows[0]?.provolatile).toBe("s");
    expect(rows.rows[0]?.prosecdef).toBe(false);
  });

  test("0006 is idempotent and keeps the mint-gate signature", async () => {
    const db = await getDb();
    const sql = readFileSync(
      join(ROOT, "supabase", "migrations", "0006_evidence_url_revocation.sql"),
      "utf8",
    );
    await db.exec(sql);
    await db.exec(sql);
    const fns = await db.query<{ n: string }>(
      `select count(*)::text as n from pg_proc p
         join pg_namespace n2 on n2.oid = p.pronamespace
        where n2.nspname = 'public'
          and p.proname = 'evidence_url'
          and pg_get_function_identity_arguments(p.oid) =
              'p_evidence_id uuid, p_ttl_seconds integer'`,
    );
    // create or replace ⇒ re-running must never duplicate the signature.
    expect(Number(fns.rows[0]?.n)).toBe(1);
    // The audit table exists with RLS enabled and no policies (definer-only).
    const audit = await db.query<{ rls: boolean; policies: string }>(
      `select c.relrowsecurity as rls,
              (select count(*)::text from pg_policies pol
                where pol.schemaname = 'public'
                  and pol.tablename = 'evidence_url_audit') as policies
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'evidence_url_audit'`,
    );
    expect(audit.rows[0]?.rls).toBe(true);
    expect(audit.rows[0]?.policies).toBe("0");
  });

  test("0002 wraps itself in a single transaction", () => {
    const sql = readFileSync(
      join(ROOT, "supabase", "migrations", "0002_grants_and_storage.sql"),
      "utf8",
    );
    // Assert against executable SQL only: the header comment legitimately
    // NARRATES the historical defect signatures, and a raw-text not.toContain
    // would false-positive on that documentation.
    const code = sql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(/^\s*begin\s*;/im.test(code)).toBe(true);
    expect(/^\s*commit\s*;/im.test(code)).toBe(true);
    // The signatures granted must match 0001's definitions exactly.
    expect(code).toContain(
      "public.provision_user_by_email(text, text, text, text, text)",
    );
    expect(code).toContain("public.triage_community_report(uuid, text, text)");
    expect(code).toContain("public.evidence_for_parent(text, uuid)");
    expect(code).toContain(
      "public.submit_community_report(text, text, text, text, text, text, double precision, double precision, text)",
    );
    // The defect signatures must NOT reappear in executable SQL.
    expect(code).not.toContain("public.report_status");
    expect(code).not.toContain("public.evidence_parent_type");
    expect(code).not.toContain("public.user_role,");
    expect(code).not.toContain("mg_can_access_site(e.county, e.operator_name)");
  });

  test("evidence bucket exists with the 25MB cap", async () => {
    await withRole("postgres", null, async (run) => {
      const b = await one(
        run,
        "select id, public, file_size_limit from storage.buckets where id = 'evidence'",
      );
      expect(b).toBeDefined();
      expect(b!.public).toBe(false);
      expect(Number(b!.file_size_limit)).toBe(26214400);
    });
  });

  test("exactly the intended storage policies exist (no stale variants)", async () => {
    await withRole("postgres", null, async (run) => {
      const rows = await run(
        `select policyname from pg_policies
          where schemaname = 'storage' and tablename = 'objects'
          order by policyname`,
      );
      const names = rows.map((r) => r.policyname);
      // 0001 and 0002 converge on the same three names; the historical
      // 0002-only names ("…own namespace", "…storage read") must be gone.
      expect(names).toEqual([
        "evidence owner update",
        "evidence read scoped",
        "evidence upload own folder",
      ]);
    });
  });
});

describe("first-admin bootstrap (the user-facing onboarding path)", () => {
  test("an authenticated account can claim admin while no role exists", async () => {
    // Regression guard for the defect found by this suite: repo-lineage
    // 0001's mg_guard_profile_update rejected ANY role/scope transition for
    // non-admins, including the documented first-admin bootstrap — so a
    // fresh install could never create an admin. 0004 grants parity with the
    // live deployment (definer-RPC bypass + first-run bootstrap allowance).
    await withRole("postgres", null, async (run) => {
      // (No try/finally with a manual ROLLBACK here: withRole always rolls
      // back, and a test-issued ROLLBACK would end its transaction early.)
      await run(`insert into auth.users (id, email) values
          ('dddddddd-0000-4000-8000-00000000aaaa', 'bootstrap@mineguard.test')`);
        // NOTE: fixture already has an admin, so simulate the first-run state
        // by clearing roles inside this transaction only.
        await run("update public.profiles set role = null, scope = null");
        await run("set local role authenticated");
        await run(
          `set local request.jwt.claims = '{"sub":"dddddddd-0000-4000-8000-00000000aaaa","role":"authenticated"}'`,
        );
        await run(
          `update public.profiles set role = 'admin', scope = 'national',
                  profile_complete = true
            where id = 'dddddddd-0000-4000-8000-00000000aaaa'`,
        );
        const rows = await run(
          `select role from public.profiles
            where id = 'dddddddd-0000-4000-8000-00000000aaaa'`,
        );
        expect(rows[0]?.role).toBe("admin");
    });
  });

  test("a non-admin still cannot self-assign a role afterwards", async () => {
    await withRole("postgres", null, async (run) => {
      await run("set local role authenticated");
      await run(
        `set local request.jwt.claims = '{"sub":"${(await getFixture()).guest}","role":"authenticated"}'`,
      );
      let message = "";
      try {
        await run(
          `update public.profiles set role = 'admin'
            where id = '${(await getFixture()).guest}'`,
        );
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      expect(message).toContain("FORBIDDEN_ROLE_CHANGE");
    });
  });
});

describe("RLS policy hygiene (§0.1 regression suite)", () => {
  test("anon is DENIED profiles even before RLS is evaluated", async () => {
    // 0003 revokes anon's table privileges outright: this must be a hard
    // 42501, not merely an empty result set.
    await withRole("anon", null, async (run) => {
      let message = "";
      try {
        await run("select * from public.profiles");
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      expect(message).toContain("permission denied for table profiles");
    });
  });

  test("reintroducing the 0001 defect IS detected by that assertion", async () => {
    // Sensitivity proof (remediation-prompt verification gate): re-grant anon
    // + recreate the permissive 0001 policy inside a transaction, and the
    // same read that must fail above now returns the whole directory — i.e.
    // the assertion is genuinely sensitive to the defect, and rolling back
    // restores the hardened state.
    await withRole("postgres", null, async (run) => {
      await run("grant select on public.profiles to anon");
      await run(
        `create policy "profiles read" on public.profiles for select using (true)`,
      );
      await run("set local role anon");
      await run("set local request.jwt.claims = ''");
      const rows = await run("select id, email from public.profiles");
      expect(rows.length).toBeGreaterThan(0); // defect visible ⇒ tests fail
    });

    // …and after rollback the directory is closed again.
    await withRole("anon", null, async (run) => {
      let denied = false;
      try {
        await run("select * from public.profiles");
      } catch (e) {
        denied = (e instanceof Error ? e.message : String(e)).includes(
          "permission denied",
        );
      }
      expect(denied).toBe(true);
    });
  });

  test("world-readable surfaces stay readable (meta + tracking)", async () => {
    await withRole("anon", null, async (run) => {
      const meta = await one(run, "select count(*) from public.meta");
      expect(Number(scalar(meta))).toBeGreaterThan(0);
      const tracking = await one(
        run,
        "select count(*) from public.report_tracking",
      );
      expect(Number(scalar(tracking))).toBeGreaterThan(0);
    });
  });

  test("admin-only RPCs must never succeed for anon", async () => {
    await withRole("anon", null, async (run) => {
      for (const stmt of [
        `select public.provision_user_by_email('x@y.z', 'inspector', 'national')`,
        `select public.triage_community_report(gen_random_uuid(), 'verified')`,
        `select public.complete_staff_profile('t', 'o')`,
      ]) {
        let message = "";
        try {
          await run(stmt);
        } catch (e) {
          message = e instanceof Error ? e.message : String(e);
        }
        // Which layer refuses is lineage-dependent: Postgres grants EXECUTE
        // to PUBLIC by default, so before 0002's revokes bite, anon reaches
        // the definer body and is stopped by its internal admin check
        // (FORBIDDEN). After the revokes apply, the privilege layer refuses
        // (permission denied). What must NEVER happen is a successful call —
        // i.e. an empty error message.
        expect(message).toMatch(/FORBIDDEN|permission denied/i);
      }
    });
  });

  test("authenticated users can execute the documented RPC surface", async () => {
    const f = await getFixture();
    await withRole(
      "authenticated",
      { sub: f.opA, role: "authenticated" },
      async (run) => {
        const rows = await run(
          `select e.id from public.evidence_for_parent('incident', '${f.incidentA}') e`,
        );
        expect(rows.length).toBe(1);
        expect(rows[0].id).toBe(f.evidenceA);
      },
    );
  });
});

describe("0009 audit & integrity foundation (SEC-1/2/3)", () => {
  test("0009 is idempotent — it can be re-run without error", async () => {
    const db = await getDb();
    const sql = readFileSync(
      join(ROOT, "supabase", "migrations", "0009_audit_integrity.sql"),
      "utf8",
    );
    await db.exec(sql);
    await db.exec(sql);
    // Re-running must not duplicate triggers or revive dropped policies.
    const trig = await db.query<{ touch: string; audit: string }>(
      `select
         (select count(*)::text from pg_trigger
           where tgname like '%\_touch' and not tgisinternal) as touch,
         (select count(*)::text from pg_trigger
           where tgname like '%\_audit' and not tgisinternal) as audit`,
    );
    // 10 domain tables + organizations (0010's integrity stamps).
    expect(Number(trig.rows[0]?.touch)).toBe(11);
    // …and organizations + site_assignments join the audit trail: exactly one
    // row per mutation, one trigger per table.
    expect(Number(trig.rows[0]?.audit)).toBe(12);
    // "audit append" (0001) stays gone; only the staff-read policy remains.
    const pol = await db.query<{ n: string }>(
      `select count(*)::text as n from pg_policies
        where schemaname = 'public' and tablename = 'audit_log'`,
    );
    expect(Number(pol.rows[0]?.n)).toBe(1);
    // Re-running 0009 DROPS and recreates triage_community_report — a fresh
    // function materializes the platform-default PUBLIC grant, undoing
    // 0011's surface for that signature. Re-apply 0011 so the pinned GAP-0
    // block (and every later suite) observes the hardened surface.
    await db.exec(
      readFileSync(
        join(ROOT, "supabase", "migrations", "0011_function_execute_surface.sql"),
        "utf8",
      ),
    );
    // 0008's admin DELETE policy stays dropped — archive is the lifecycle.
    const tpl = await db.query<{ n: string }>(
      `select count(*)::text as n from pg_policies
        where schemaname = 'public' and tablename = 'inspection_templates'
          and policyname ilike '%delete%'`,
    );
    expect(Number(tpl.rows[0]?.n)).toBe(0);
  });

  test("SEC-1: audit_log grants are read-only for clients", async () => {
    const db = await getDb();
    const audit = await db.query<{ p: string | null }>(
      `select string_agg(privilege_type, ',' order by privilege_type) as p
         from information_schema.table_privileges
        where table_schema = 'public' and table_name = 'audit_log'
          and grantee in ('anon', 'authenticated')`,
    );
    // authenticated keeps SELECT ("audit staff read" is the row filter);
    // anon holds nothing; neither holds any write privilege.
    expect(audit.rows[0]?.p).toBe("SELECT");
  });

  test("SEC-3: no DELETE for any client role; anon trimmed to the mirrors", async () => {
    const db = await getDb();
    const rows = (
      await db.query<{
        t: string;
        a_del: boolean;
        a_ins: boolean;
        n_sel: boolean;
        n_ins: boolean;
      }>(
        `select c.relname::text as t,
                has_table_privilege('authenticated', c.oid::regclass, 'DELETE') as a_del,
                has_table_privilege('authenticated', c.oid::regclass, 'INSERT') as a_ins,
                has_table_privilege('anon', c.oid::regclass, 'SELECT') as n_sel,
                has_table_privilege('anon', c.oid::regclass, 'INSERT') as n_ins
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r'
          order by c.relname`,
      )
    ).rows;
    expect(rows.length).toBeGreaterThanOrEqual(15);
    for (const r of rows) {
      expect(r.a_del, `authenticated must not hold DELETE on ${r.t}`).toBe(false);
      expect(r.a_ins, `authenticated INSERT on ${r.t}`).toBe(r.t !== "audit_log");
      expect(r.n_ins, `anon must not hold INSERT on ${r.t}`).toBe(false);
      const anonReadable = r.t === "meta" || r.t === "report_tracking";
      expect(r.n_sel, `anon SELECT surface on ${r.t}`).toBe(anonReadable);
    }
  });

  test("SEC-2: integrity columns, audit diff column, archive column", async () => {
    const db = await getDb();
    const cols = await db.query<{ n: string }>(
      `select count(*)::text as n from information_schema.columns
        where table_schema = 'public'
          and table_name in ('profiles','sites','inspection_templates','inspections',
                             'findings','corrective_actions','incidents',
                             'environmental_observations','community_reports','evidence')
          and column_name in ('updated_at','updated_by','row_version')`,
    );
    expect(Number(cols.rows[0]?.n)).toBe(30); // 10 domain tables × 3 columns

    const extra = await db.query<{ n: string }>(
      `select count(*)::text as n from information_schema.columns
        where table_schema = 'public'
          and ((table_name = 'audit_log' and column_name = 'details')
            or (table_name = 'inspection_templates' and column_name = 'archived_at'))`,
    );
    expect(Number(extra.rows[0]?.n)).toBe(2);

    const rv = await db.query<{ column_default: string; is_nullable: string }>(
      `select column_default, is_nullable from information_schema.columns
        where table_schema = 'public' and table_name = 'sites'
          and column_name = 'row_version'`,
    );
    expect(String(rv.rows[0]?.column_default)).toContain("1");
    expect(rv.rows[0]?.is_nullable).toBe("NO");
  });

  test("SEC-1/2: trigger functions are SECURITY DEFINER; triage writes no manual audit row", async () => {
    const db = await getDb();
    const fns = await db.query<{ proname: string; prosecdef: boolean }>(
      `select p.proname, p.prosecdef
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('mg_audit_row', 'mg_touch_row')
        order by p.proname`,
    );
    expect(fns.rows.length).toBe(2);
    // mg_audit_row MUST be definer (clients hold no audit INSERT privilege);
    // mg_touch_row is definer for search_path/consistency parity.
    expect(fns.rows.every((r) => r.prosecdef)).toBe(true);

    const triage = await db.query<{ def: string; identity: string }>(
      `select pg_get_functiondef(p.oid) as def,
              pg_get_function_identity_arguments(p.oid) as identity
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'triage_community_report'`,
    );
    // Public contract unchanged (0002's EXECUTE grant names this signature),
    // but the hand-rolled audit INSERT is gone — triggers own the trail.
    expect(triage.rows[0]?.identity).toBe(
      "p_report_id uuid, p_decision text, p_note text",
    );
    expect(triage.rows[0]?.def).not.toContain("insert into public.audit_log");

    const guard = await db.query<{ def: string }>(
      `select pg_get_functiondef(p.oid) as def
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'mg_guard_template_write'`,
    );
    expect(guard.rows[0]?.def).toContain("ARCHIVE_ONLY");
  });

  test("default privileges: future tables start closed", async () => {
    // 0002's default privileges handed anon+authenticated SELECT/INSERT/
    // UPDATE/DELETE to every future table. 0009 rewrote them: authenticated
    // gets SELECT/INSERT/UPDATE (RLS still the row boundary), anon gets
    // nothing — verified on a freshly created table's inherited ACL.
    await withRole("postgres", null, async (run) => {
      await run("create table public._mg0009_acl_probe (id int)");
      const rows = await run(
        `select has_table_privilege('anon', 'public._mg0009_acl_probe', 'SELECT') as n_sel,
                has_table_privilege('anon', 'public._mg0009_acl_probe', 'INSERT') as n_ins,
                has_table_privilege('authenticated', 'public._mg0009_acl_probe', 'SELECT') as a_sel,
                has_table_privilege('authenticated', 'public._mg0009_acl_probe', 'INSERT') as a_ins,
                has_table_privilege('authenticated', 'public._mg0009_acl_probe', 'DELETE') as a_del`,
      );
      expect(rows[0].n_sel).toBe(false);
      expect(rows[0].n_ins).toBe(false);
      expect(rows[0].a_sel).toBe(true);
      expect(rows[0].a_ins).toBe(true);
      expect(rows[0].a_del).toBe(false);
      await run("drop table public._mg0009_acl_probe");
    });
  });
});

// ---------------------------------------------------------------------------
// SEC-5 / SITE-1 — migration 0010 (organizations, geography, permission
// matrix). Its header promises idempotency "verified by
// tests/migration-apply.test.ts"; this block is that verification.
// ---------------------------------------------------------------------------
describe("0010 organizations, scopes & permissions (SEC-5/SITE-1)", () => {
  async function snapshot(): Promise<{ orgs: string; areas: string; perms: string }> {
    const db = await getDb();
    const r = await db.query<{ orgs: string; areas: string; perms: string }>(
      `select (select count(*)::text from public.organizations) as orgs,
              (select count(*)::text from public.admin_areas) as areas,
              (select count(*)::text from public.permissions) as perms`,
    );
    return r.rows[0];
  }

  test("0010 is idempotent — re-runs mint nothing new", async () => {
    const db = await getDb();
    const sql = readFileSync(
      join(ROOT, "supabase", "migrations", "0010_organizations_scopes_permissions.sql"),
      "utf8",
    );
    // An earlier re-run inside this file (the 0002 idempotency test) may
    // still be the one that bound rows a committed suite left behind — the
    // backfill is data-driven. From here on every re-run must be a no-op:
    // no duplicate organizations, admin areas, or matrix rows.
    await db.exec(sql);
    const first = await snapshot();
    await db.exec(sql);
    expect(await snapshot()).toEqual(first);
    // The matrix seeds exactly once (10 admin + 4 supervisor + 3 inspector
    // + 1 operator) — the unique constraint is the backstop, the count is
    // the drift alarm.
    expect(Number(first.perms)).toBe(18);
    // The scope enum stands at its six values: the rename-and-repoint
    // sequence skips straight through on re-run (no seven-value creep, no
    // resurrection of the three-value predecessor).
    const enumVals = await db.query<{ n: string }>(
      `select count(*)::text as n
         from pg_enum e
         join pg_type t on t.oid = e.enumtypid
        where t.typname = 'user_scope'`,
    );
    expect(Number(enumVals.rows[0]?.n)).toBe(6);
  });

  test("the 0010 policy surface is recreated, not duplicated", async () => {
    const db = await getDb();
    const pol = await db.query<{ t: string; n: string }>(
      `select tablename::text as t, count(*)::text as n
         from pg_policies
        where schemaname = 'public'
          and tablename in ('admin_areas','organizations','permissions','site_assignments')
        group by tablename
        order by tablename`,
    );
    // drop-if-exists + create: exactly one policy per operation —
    // read/insert/update on the three guarded tables, read-only matrix.
    expect(pol.rows.map((r) => [r.t, Number(r.n)])).toEqual([
      ["admin_areas", 3],
      ["organizations", 3],
      ["permissions", 1],
      ["site_assignments", 3],
    ]);
  });
});

// ---------------------------------------------------------------------------
// GAP-0 — migration 0011 (deny-by-default function execute surface).
// docs/04 Gap 0: privileged surfaces must be guarantees, not intent. Before
// 0011 the intent (0009/0010's per-function revokes) was defeated by the
// built-in PUBLIC grant — anon executed triage_community_report and
// mg_resolve_organization despite explicit revokes. These tests pin the
// surface so the guarantee survives every future migration.
// ---------------------------------------------------------------------------
describe("GAP-0: function execute surface (0011)", () => {
  /** Our own functions — extension members (pgcrypto/pg_trgm planner
   *  support) are a platform surface, not ours, and are excluded. */
  const OUR_FNS = `
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and not exists (
            select 1 from pg_depend d
             where d.classid = 'pg_proc'::regclass and d.objid = p.oid
               and d.deptype = 'e')`;
  const SIG = `p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')'`;

  /** The complete, documented anon surface: the two public flows. This set
   *  includes any PUBLIC-fallback grant (has_function_privilege accounts
   *  for it), so a recreated function with the platform-default =X fails
   *  here too. */
  const ANON_SURFACE = [
    "refresh_public_stats()",
    "submit_community_report(text, text, text, text, text, text, double precision, double precision, text)",
  ];

  /** The complete authenticated surface: the client RPC surface + the
   *  authorization helpers policies/invoker guards evaluate as the caller. */
  const AUTH_SURFACE = [
    "complete_staff_profile(text, text, text, text, text)",
    "evidence_for_parent(text, uuid)",
    "evidence_url(uuid, integer)",
    "mg_any_profile_role()",
    "mg_can_access_site(uuid)",
    "mg_can_access_site_row(uuid, text, text, text, uuid)",
    "mg_command_center_stats()",
    // 0014's five scale surfaces — SECURITY INVOKER row sources 0011 must
    // keep granted when it re-runs (see 0011 header, bullet E).
    "mg_compliance_page(timestamp with time zone, uuid, integer)",
    "mg_has_permission(text)",
    "mg_incidents_page(timestamp with time zone, uuid, integer)",
    "mg_inspections_page(timestamp with time zone, uuid, integer)",
    "mg_is_admin()",
    "mg_is_reviewer()",
    "mg_is_staff()",
    "mg_operator_name()",
    "mg_profile()",
    "mg_risk_explanation(uuid)",
    "mg_risk_scores()",
    "mg_role()",
    "provision_user_by_email(text, text, text, text, text)",
    "refresh_public_stats()",
    "submit_community_report(text, text, text, text, text, text, double precision, double precision, text)",
    "triage_community_report(uuid, text, text)",
  ];

  /** Executed first in this block: it re-applies 0011 (cleaning any surface
   *  drift earlier re-runs introduced) before the pins observe it. */
  test("0011 is idempotent — re-runs leave the surface unchanged", async () => {
    const db = await getDb();
    const sql = readFileSync(
      join(ROOT, "supabase", "migrations", "0011_function_execute_surface.sql"),
      "utf8",
    );
    const snap = async () =>
      (
        await db.query<{ f: string; pub: boolean; anon: boolean; auth: boolean }>(
          `select ${SIG} as f,
                  case when p.proacl is null then true
                       else exists (select 1 from aclexplode(p.proacl) a
                                     where a.grantee = 0 and a.privilege_type = 'EXECUTE')
                  end as pub,
                  has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
                  has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth
             ${OUR_FNS}
             order by 1`,
        )
      ).rows;
    await db.exec(sql);
    const first = await snap();
    await db.exec(sql);
    expect(await snap()).toEqual(first);
  });

  test("anon executes exactly the two public flows", async () => {
    const db = await getDb();
    const rows = (
      await db.query<{ f: string }>(
        `select ${SIG} as f
           ${OUR_FNS}
             and has_function_privilege('anon', p.oid, 'EXECUTE')
           order by 1`,
      )
    ).rows.map((r) => r.f);
    expect(rows).toEqual(ANON_SURFACE);
    // Machinery is unreachable for anon in particular: 0010's intent is now
    // a guarantee.
    expect(rows.join()).not.toContain("mg_resolve_organization");
    expect(rows.join()).not.toContain("triage_community_report");
  });

  test("no function retains a PUBLIC execute grant (the =X fallback)", async () => {
    const db = await getDb();
    const rows = (
      await db.query<{ f: string }>(
        `select ${SIG} as f
           ${OUR_FNS}
             and (p.proacl is null
                  or exists (select 1 from aclexplode(p.proacl) a
                              where a.grantee = 0 and a.privilege_type = 'EXECUTE'))
           order by 1`,
      )
    ).rows.map((r) => r.f);
    // A freshly created function materializes the built-in PUBLIC grant on
    // this PostgreSQL (default privileges cannot express its removal), so
    // this pin is what forces every future migration to revoke it explicitly.
    expect(rows).toEqual([]);
  });

  test("authenticated executes exactly the pinned allowlist", async () => {
    const db = await getDb();
    const rows = (
      await db.query<{ f: string }>(
        `select ${SIG} as f
           ${OUR_FNS}
             and has_function_privilege('authenticated', p.oid, 'EXECUTE')
           order by 1`,
      )
    ).rows.map((r) => r.f);
    expect(rows).toEqual(AUTH_SURFACE);
  });

  test("future functions start closed for client roles (default privileges)", async () => {
    const db = await getDb();
    const defs = await db.query<{ acl: string }>(
      `select defaclacl::text as acl
         from pg_default_acl
        where defaclnamespace = 'public'::regnamespace
          and defaclobjtype = 'f'`,
    );
    // 0002 granted execute on every future function to anon+authenticated;
    // 0011 reverses it. An absent row means "no default grants" (the PUBLIC
    // builtin is separate and covered by the pin above).
    for (const r of defs.rows) {
      expect(r.acl).not.toContain("anon=");
      expect(r.acl).not.toContain("authenticated=");
    }
  });

  test("every client-reachable definer function self-authorizes (Gap 0's core)", async () => {
    const db = await getDb();
    const rows = (
      await db.query<{ name: string; args: string; def: string }>(
        `select p.proname as name,
                pg_get_function_identity_arguments(p.oid) as args,
                pg_get_functiondef(p.oid) as def
           ${OUR_FNS}
             and p.prosecdef
             and pg_get_function_result(p.oid) <> 'trigger'
             and (has_function_privilege('anon', p.oid, 'EXECUTE')
                  or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
           order by 1`,
      )
    ).rows;
    // The reachable set must actually be non-trivial, or this assertion is
    // vacuous.
    expect(rows.length).toBeGreaterThanOrEqual(15);
    const PUBLIC_FLOWS = new Set(["submit_community_report", "refresh_public_stats"]);
    const HELPERS = new Set([
      "mg_any_profile_role",
      "mg_can_access_site",
      "mg_can_access_site_row",
      "mg_has_permission",
      "mg_is_admin",
      "mg_is_reviewer",
      "mg_is_staff",
      "mg_operator_name",
      "mg_profile",
      "mg_role",
    ]);
    const AUTH_PATTERN =
      /mg_is_admin\(|mg_is_staff\(|mg_is_reviewer\(|mg_has_permission\(|mg_profile\(\)|mg_any_profile_role\(|auth\.uid\(|mg_can_access_site\(/;
    for (const r of rows) {
      const ok =
        PUBLIC_FLOWS.has(r.name) || HELPERS.has(r.name) || AUTH_PATTERN.test(r.def);
      expect(
        ok,
        `client-reachable definer ${r.name}(${r.args}) must carry an internal ` +
          `authorization check or be a reviewed helper/public flow`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// SESSION 4 — migration 0013 (offline reliability): two new evidence parents,
// the sha256 integrity column, site-less (community-report) evidence, and the
// widened evidence read/insert/storage policies + RPC scope branches.
// ---------------------------------------------------------------------------
describe("0013 evidence parents & integrity (Session 4)", () => {
  const SQL_0013 = join(
    ROOT,
    "supabase",
    "migrations",
    "0013_offline_reliability.sql",
  );
  const CR = "99999999-0000-4000-8000-000000000010"; // seeded community report

  async function snapshot() {
    const db = await getDb();
    const enumLabels = (
      await db.query<{ l: string }>(
        `select e.enumlabel l from pg_enum e
           join pg_type t on t.oid = e.enumtypid
          where t.typname = 'evidence_parent'
          order by e.enumsortorder`,
      )
    ).rows.map((r) => r.l);
    const cols = (
      await db.query<{ c: string; n: string }>(
        `select column_name c, is_nullable n from information_schema.columns
          where table_schema = 'public' and table_name = 'evidence'
          order by column_name`,
      )
    ).rows;
    const constraint = (
      await db.query<{ d: string }>(
        `select pg_get_constraintdef(oid) d from pg_constraint
          where conname = 'evidence_sha256_fmt'`,
      )
    ).rows[0]?.d;
    const evidencePolicies = (
      await db.query<{ n: string; q: string; w: string }>(
        `select policyname n, coalesce(qual, '') q, coalesce(with_check, '') w
           from pg_policies
          where schemaname = 'public' and tablename = 'evidence'
          order by policyname`,
      )
    ).rows;
    const storagePolicies = (
      await db.query<{ n: string; q: string; w: string }>(
        `select policyname n, coalesce(qual, '') q, coalesce(with_check, '') w
           from pg_policies
          where schemaname = 'storage' and tablename = 'objects'
            and policyname like 'evidence%'
          order by policyname`,
      )
    ).rows;
    const fns = (
      await db.query<{ n: string; d: string }>(
        `select proname n, pg_get_functiondef(oid) d from pg_proc
          where proname in ('evidence_for_parent', 'evidence_url')
          order by proname`,
      )
    ).rows;
    const privs = (
      await db.query<{ n: string; a: boolean; an: boolean }>(
        `select p.proname n,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') as a,
                has_function_privilege('anon', p.oid, 'EXECUTE') as an
           from pg_proc p
          where p.proname in ('evidence_for_parent', 'evidence_url')
          order by p.proname`,
      )
    ).rows;
    return { enumLabels, cols, constraint, evidencePolicies, storagePolicies, fns, privs };
  }

  test("0013 is idempotent — re-runs change nothing", async () => {
    const db = await getDb();
    const sql = readFileSync(SQL_0013, "utf8");
    // Normalize first: this file's earlier idempotency chains re-apply 0002,
    // which recreates the storage read policy from 0002's (pre-0013) text —
    // a test-order artifact of the re-run chains (the live lineage applies
    // each migration exactly once, in order). One 0013 apply restores the
    // branch; from here on every re-run must be a no-op.
    await db.exec(sql);
    const first = await snapshot();
    await db.exec(sql);
    expect(await snapshot()).toEqual(first);

    const before = first;
    // Exactly the five parents, in definition order (0001's three, then the
    // two appended by 0013 — no label creep, no reordering).
    expect(before.enumLabels).toEqual([
      "inspection",
      "incident",
      "observation",
      "community_report",
      "corrective_action",
    ]);
    // Site-less evidence: site_id nullable, sha256 present + format-pinned.
    expect(before.cols.find((c) => c.c === "site_id")?.n).toBe("YES");
    expect(before.cols.find((c) => c.c === "sha256")?.c).toBe("sha256");
    expect(before.constraint).toContain("~");
    // Policy NAMES pinned elsewhere in this file stay exactly as they were;
    // the 0013 branch lives inside the existing quals (mg_is_staff).
    expect(before.evidencePolicies.map((p) => p.n)).toEqual([
      "evidence insert",
      "evidence read",
    ]);
    // The staff branch lives in qual (SELECT) or with_check (INSERT).
    expect(
      before.evidencePolicies.every((p) =>
        (p.q + p.w).includes("mg_is_staff"),
      ),
    ).toBe(true);
    expect(before.storagePolicies.map((p) => p.n)).toEqual([
      "evidence owner update",
      "evidence read scoped",
      "evidence upload own folder",
    ]);
    expect(
      before.storagePolicies.find((p) => p.n === "evidence read scoped")?.q,
    ).toContain("mg_is_staff");
    // Both recreated functions carry the staff branch AND keep 0011's grant
    // shape: authenticated only — never anon, never PUBLIC.
    expect(before.fns.map((f) => f.d).join("\n")).toContain("mg_is_staff");
    expect(before.privs).toEqual([
      { n: "evidence_for_parent", a: true, an: false },
      { n: "evidence_url", a: true, an: false },
    ]);
  });

  test("site-less evidence: staff-only across RLS, the list RPC, and the stamp guard", async () => {
    const f = await getFixture();
    const EV = "99999999-0000-4000-8000-0000000000fe";
    try {
      // Staff (admin) may insert a site-less community-report attachment;
      // the null-site stamp guard leaves the 'Unknown' defaults intact.
      await withRole(
        "authenticated",
        { sub: f.admin, role: "authenticated" },
        async (run) => {
          const rows = await run(
            `insert into public.evidence
               (id, storage_path, parent_type, parent_id, site_id, kind,
                file_name, mime_type, size_bytes, uploaded_by_id)
             values ('${EV}', 'triage/${EV}__note.jpg', 'community_report',
                     '${CR}', null, 'photo', 'note.jpg', 'image/jpeg', 10,
                     '${f.admin}')
             returning id`,
          );
          expect(rows).toHaveLength(1);
          const stamp = await run(
            `select county, operator_name from public.evidence where id = '${EV}'`,
          );
          expect(stamp[0].county).toBe("Unknown");
          expect(stamp[0].operator_name).toBe("Unknown");
          // The scoped list RPC returns it for staff.
          const list = await run(
            `select id from public.evidence_for_parent('community_report', '${CR}')`,
          );
          expect(list).toHaveLength(1);
        },
      );

      // An operator (not staff) can neither insert nor see site-less rows.
      await withRole(
        "authenticated",
        { sub: f.opA, role: "authenticated" },
        async (run) => {
          await expect(
            run(
              `insert into public.evidence
                 (id, storage_path, parent_type, parent_id, site_id, kind,
                  file_name, mime_type, size_bytes, uploaded_by_id)
               values ('99999999-0000-4000-8000-0000000000fd',
                       'x/99999999-0000-4000-8000-0000000000fd__no.jpg',
                       'community_report', '${CR}', null, 'photo', 'no.jpg',
                       'image/jpeg', 10, '${f.opA}')
               returning id`,
            ),
          ).rejects.toThrow(/row-level security/);
          const list = await run(
            `select id from public.evidence_for_parent('community_report', '${CR}')`,
          );
          expect(list).toHaveLength(0);
          const direct = await run(
            `select id from public.evidence where id = '${EV}'`,
          );
          expect(direct).toHaveLength(0); // RLS hides it from direct reads too
        },
      );
    } finally {
      await withRole("postgres", null, async (run) => {
        await run(`delete from public.audit_log where entity_id like '${EV}%'`);
        await run(`delete from public.evidence where id = '${EV}'`);
      });
    }
  });
});
