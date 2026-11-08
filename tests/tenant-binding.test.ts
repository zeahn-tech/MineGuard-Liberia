// ---------------------------------------------------------------------------
// Phase B0 — self-service tenant lockdown (migration 0024).
// Regression for: complete_staff_profile() let any signed-in user re-point
// their company binding by typing a company name. All sessions roll back.
// ---------------------------------------------------------------------------
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { asUser, getDb, getFixture } from "./helpers/pglite-db";

let f: Awaited<ReturnType<typeof getFixture>>;
beforeAll(async () => {
  f = await getFixture();
  // Other files re-apply older migrations on the shared DB; assert the real end state
  // (0047 replaces 0024's complete_staff_profile: role holders only, no privilege fields).
  const db = await getDb();
  for (const m of ["0047_close_admin_bootstrap.sql", "0048_public_user_identity.sql"]) {
    await db.exec(readFileSync(join(import.meta.dir, "..", "supabase", "migrations", m), "utf8"));
  }
});

async function denied(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return String((e as Error).message);
  }
  return "";
}

describe("0024 self-service tenant lockdown", () => {
  test("operator cannot re-point tenant via complete_staff_profile", async () => {
    await asUser(f.opA, async (run) => {
      const before = await run("select operator_name, organization_id from public.profiles where id = auth.uid()");
      await run("select public.complete_staff_profile('x','y','operator',null,'OreCo Liberia')");
      const after = await run("select operator_name, organization_id from public.profiles where id = auth.uid()");
      expect(after[0].operator_name).toBe(before[0].operator_name);
      expect(after[0].organization_id).toBe(before[0].organization_id);
      const sites = await run("select operator_name from public.sites");
      expect(sites.every((s) => s.operator_name === before[0].operator_name)).toBe(true);
      expect(sites.length).toBeGreaterThan(0);
    });
  });

  test("role-less user cannot bind to a company by typing its name (and cannot complete a staff profile at all)", async () => {
    await asUser(f.guest, async (run) => {
      const msg = await denied(run("select public.complete_staff_profile('x','y','operator',null,'AgriLib Mining')"));
      expect(msg).toMatch(/FORBIDDEN/);
      const me = await run("select operator_name, organization_id from public.profiles where id = auth.uid()");
      expect(me[0].operator_name).toBeNull();
      expect(me[0].organization_id).toBeNull();
    });
  });

  test("operator cannot change own role, scope or tenant by direct update", async () => {
    await asUser(f.opA, async (run) => {
      for (const set of [
        "role = 'admin'",
        "operator_name = 'OreCo Liberia'",
        "organization_id = (select id from public.organizations where name = 'OreCo Liberia' limit 1)",
      ]) {
        const msg = await denied(run(`update public.profiles set ${set} where id = auth.uid()`));
        expect(msg).toMatch(/FORBIDDEN/);
      }
    });
  });

  test("defence in depth: tenant trigger blocks a non-admin self change even from a definer path", async () => {
    await asUser(f.opA, async (run) => {
      // Simulate a future definer RPC: run as the definer owner but with the caller's claims.
      const msg = await denied(
        run("set local role postgres").then(() =>
          run("update public.profiles set operator_name = 'OreCo Liberia' where id = auth.uid()"),
        ),
      );
      expect(msg).toMatch(/FORBIDDEN_TENANT_CHANGE/);
    });
  });

  test("administrator provisioning still binds a company and records the change", async () => {
    await asUser(f.admin, async (run) => {
      await run("select public.provision_user_by_email('frank@guest.test','operator','operator',null,'OreCo Liberia')");
      const row = await run("select role, operator_name, organization_id from public.profiles where email = 'frank@guest.test'");
      expect(row[0].role).toBe("operator");
      expect(row[0].operator_name).toBe("OreCo Liberia");
      expect(row[0].organization_id).not.toBeNull();
    });
  });

  test("0047: complete_staff_profile never creates an administrator or stores a scope, even with NO admin", async () => {
    await asUser(f.guest, async (run) => {
      await run("set local role postgres");
      await run("update public.profiles set role = null, scope = null, county = null");
      await run("set local role authenticated");
      await run(`select set_config('request.jwt.claims', '{"sub":"${f.guest}","role":"authenticated"}', true)`);
      const msg = await denied(run("select public.complete_staff_profile('x','y','national')"));
      expect(msg).toMatch(/FORBIDDEN/);
      const me = await run("select role, scope, county, profile_complete from public.profiles where id = auth.uid()");
      expect(me[0]).toEqual({ role: null, scope: null, county: null, profile_complete: false });
    });
  });

  test("0047: a role holder completes only job title and organization — scope, county and company stay as assigned", async () => {
    await asUser(f.county, async (run) => {
      const before = await run("select role, scope, county, operator_name, organization_id from public.profiles where id = auth.uid()");
      await run("select public.complete_staff_profile('Chief Inspector','Ministry','national','Nimba','OreCo Liberia')");
      const after = await run("select role, scope, county, operator_name, organization_id, job_title, organization, profile_complete from public.profiles where id = auth.uid()");
      expect(after[0]).toMatchObject({ ...before[0], job_title: "Chief Inspector", organization: "Ministry", profile_complete: true });
    });
  });
});
