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
  });

  test("0001 core objects exist (tables, RLS, triggers, RPCs)", async () => {
    await withRole("postgres", null, async (run) => {
      const tables = await one(
        run,
        `select count(*) from information_schema.tables
          where table_schema = 'public' and table_type = 'BASE TABLE'`,
      );
      // 14 domain tables + evidence_url_audit (0006).
      expect(Number(scalar(tables))).toBe(15);

      const rls = await one(
        run,
        `select count(*) from pg_tables
          where schemaname = 'public' and rowsecurity = true`,
      );
      expect(Number(scalar(rls))).toBe(15);

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
