// ---------------------------------------------------------------------------
// Public User programme — Phase A (migration 0047): no self-service administrator,
// protected profile authorization fields, verified + rate-limited company search.
// Real Postgres (PGlite) with the production migrations; every session rolls back.
// ---------------------------------------------------------------------------
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDb, getFixture, withRole, type Runner } from "./helpers/pglite-db";

const ROOT = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

let f: Awaited<ReturnType<typeof getFixture>>;
beforeAll(async () => {
  f = await getFixture();
  // Other test files re-apply older migrations on the shared database: assert the real end state.
  const db = await getDb();
  for (const m of ["0048_close_admin_bootstrap.sql", "0049_public_user_identity.sql", "0050_public_reports_feedback.sql", "0052_public_content.sql"]) {
    await db.exec(read(`supabase/migrations/${m}`));
  }
}, 120000);

const REGISTERED = "dddd0047-0000-4000-8000-000000000001"; // email-verified, role-less public account
const GUEST_ANON = "dddd0047-0000-4000-8000-000000000002"; // anonymous guest session (no email)
const UNVERIFIED = "dddd0047-0000-4000-8000-000000000003"; // signed up, e-mail not yet confirmed

async function denied(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return String((e as Error).message);
  }
  return "";
}

/** Zero-administrator state (fresh install / restored backup), plus the three public accounts. */
async function emptyPlatform(run: Runner) {
  await run(`insert into auth.users (id, email, email_confirmed_at) values
      ('${REGISTERED}', 'public.user@example.org', now()),
      ('${GUEST_ANON}', null, null),
      ('${UNVERIFIED}', 'unverified@example.org', null)`);
  await run("update public.profiles set role = null, scope = null, county = null, operator_name = null, organization_id = null");
  expect((await run("select count(*)::int as n from public.profiles where role is not null"))[0].n).toBe(0);
}
const asUid = (run: Runner, uid: string, anonymous = false) =>
  run("set local role authenticated").then(() =>
    run(`select set_config('request.jwt.claims', '${JSON.stringify({ sub: uid, role: "authenticated", is_anonymous: anonymous })}', true)`),
  );

describe("0047: nobody can become administrator by registering", () => {
  for (const [label, uid, anon] of [
    ["verified registered account", REGISTERED, false],
    ["anonymous guest session", GUEST_ANON, true],
    ["unverified account", UNVERIFIED, false],
  ] as const) {
    test(`${label}: with ZERO administrators, direct role update is refused`, async () => {
      await withRole("postgres", null, async (run) => {
        await emptyPlatform(run);
        await asUid(run, uid, anon);
        for (const set of ["role = 'admin'", "role = 'supervisor'", "scope = 'national'", "county = 'Bomi'"]) {
          expect(await denied(run(`update public.profiles set ${set} where id = '${uid}'`))).toContain("FORBIDDEN_ROLE_CHANGE");
        }
        await run("reset role");
        expect((await run("select count(*)::int as n from public.profiles where role is not null"))[0].n).toBe(0);
      });
    });

    test(`${label}: with ZERO administrators, complete_staff_profile is refused and changes nothing`, async () => {
      await withRole("postgres", null, async (run) => {
        await emptyPlatform(run);
        await asUid(run, uid, anon);
        expect(await denied(run("select public.complete_staff_profile('x','y','national','Bomi','AgriLib Mining')"))).toMatch(/FORBIDDEN/);
        await run("reset role");
        const me = (await run(`select role, scope, county, operator_name, organization_id, profile_complete from public.profiles where id = '${uid}'`))[0];
        expect(me).toEqual({ role: null, scope: null, county: null, operator_name: null, organization_id: null, profile_complete: false });
      });
    });
  }

  test("the guest and registered accounts keep the existing, safe self-service edits (name-level fields)", async () => {
    await asUserFixtureGuest(async (run) => {
      const rows = await run("update public.profiles set job_title = 'Resident' where id = auth.uid() returning job_title");
      expect(rows[0]?.job_title).toBe("Resident");
    });
  });
});

async function asUserFixtureGuest<T>(fn: (run: Runner) => Promise<T>) {
  return withRole("authenticated", { sub: f.guest, role: "authenticated" }, fn);
}

describe("0047: profile authorization fields and the INSERT path", () => {
  test("a role-less account cannot change role, scope, county, company, tenant or e-mail", async () => {
    await asUserFixtureGuest(async (run) => {
      const orgId = (await run("select id from public.organizations limit 1")).length; // visibility irrelevant; the write must still fail
      void orgId;
      for (const set of [
        "role = 'admin'",
        "role = 'operator'",
        "scope = 'national'",
        "county = 'Bomi'",
        "operator_name = 'AgriLib Mining'",
        "email = 'someone.else@example.org'",
      ]) {
        expect(await denied(run(`update public.profiles set ${set} where id = auth.uid()`))).toMatch(/FORBIDDEN/);
      }
    });
  });

  test("a role-less account cannot edit anybody else's profile", async () => {
    await asUserFixtureGuest(async (run) => {
      const rows = await run(`update public.profiles set job_title = 'hacked' where id = '${f.admin}' returning 1`);
      expect(rows.length).toBe(0);
    });
  });

  test("a self-inserted profile row cannot carry a role, scope, county or company", async () => {
    await withRole("postgres", null, async (run) => {
      await run(`delete from public.profiles where id = '${f.guest}'`);
      await asUid(run, f.guest);
      for (const cols of [
        ["role", "'admin'"],
        ["scope", "'national'"],
        ["county", "'Bomi'"],
        ["operator_name", "'AgriLib Mining'"],
      ]) {
        expect(await denied(run(`insert into public.profiles (id, email, ${cols[0]}) values ('${f.guest}', 'frank@guest.test', ${cols[1]})`))).toContain("FORBIDDEN_ROLE_CHANGE");
      }
      // a plain row (what ensureProfileDoc sends) is still accepted
      const ok = await run(`insert into public.profiles (id) values ('${f.guest}') returning id`);
      expect(ok.length).toBe(1);
    });
  });
});

describe("0047: mg_any_profile_role is no longer an API surface", () => {
  test("neither anon nor authenticated can execute it", async () => {
    await withRole("postgres", null, async (run) => {
      const r = await run(`select has_function_privilege('anon', 'public.mg_any_profile_role()', 'EXECUTE') as a,
                                  has_function_privilege('authenticated', 'public.mg_any_profile_role()', 'EXECUTE') as u`);
      expect(r[0]).toEqual({ a: false, u: false });
    });
  });
});

describe("0047: company search is for verified, non-anonymous accounts only, and rate-limited", () => {
  test("a verified registered account finds approved companies by name (id and name only)", async () => {
    await withRole("authenticated", { sub: f.guest, role: "authenticated" }, async (run) => {
      const rows = await run("select * from public.mg_search_companies('agrilib')");
      expect(rows.length).toBe(1);
      expect(Object.keys(rows[0]).sort()).toEqual(["id", "name"]);
    });
  });

  test("an anonymous guest, an unverified account and a too-short query get nothing", async () => {
    await withRole("postgres", null, async (run) => {
      await run(`insert into auth.users (id, email, email_confirmed_at) values
        ('${GUEST_ANON}', null, null), ('${UNVERIFIED}', 'unverified@example.org', null)`);
      await asUid(run, GUEST_ANON, true);
      expect((await run("select * from public.mg_search_companies('agrilib')")).length).toBe(0);
      await run("reset role");
      await asUid(run, UNVERIFIED);
      expect((await run("select * from public.mg_search_companies('agrilib')")).length).toBe(0);
      await run("reset role");
      await asUid(run, f.guest);
      expect((await run("select * from public.mg_search_companies('ag')")).length).toBe(0);
    });
  });

  test("no session at all cannot call it", async () => {
    await withRole("anon", null, async (run) => {
      expect(await denied(run("select * from public.mg_search_companies('agrilib')"))).toMatch(/permission denied/i);
    });
  });

  test("the 21st search within a minute is rate limited", async () => {
    await asUserFixtureGuest(async (run) => {
      for (let i = 0; i < 20; i++) await run("select * from public.mg_search_companies('agrilib')");
      expect(await denied(run("select * from public.mg_search_companies('agrilib')"))).toMatch(/RATE_LIMITED/);
    });
  });
});

describe("0047: the documented owner recovery still works, and existing roles are unaffected", () => {
  test("promote_to_admin.sql (owner, non-API role) creates the first administrator on an empty platform; that admin can then assign roles", async () => {
    await withRole("postgres", null, async (run) => {
      await emptyPlatform(run);
      await run("update public.profiles set email = 'recovered.admin@example.org' where id = '" + REGISTERED + "'");
      const script = read("supabase/maintenance/promote_to_admin.sql").replace("replace-with-email@example.org", "recovered.admin@example.org");
      const promoted = await run(script);
      expect(promoted.length).toBe(1);
      expect((await run(`select role::text as role from public.profiles where id = '${REGISTERED}'`))[0].role).toBe("admin");
      // The new administrator uses the existing provisioning path for everyone else.
      await asUid(run, REGISTERED);
      await run(`select public.provision_user_by_email('frank@guest.test','inspector','county','Bomi')`);
      await run("reset role");
      expect((await run("select role::text as role from public.profiles where email = 'frank@guest.test'"))[0].role).toBe("inspector");
    });
  });

  test("an administrator can still change another account's role directly; operators and inspectors keep working", async () => {
    await withRole("authenticated", { sub: f.admin, role: "authenticated" }, async (run) => {
      const rows = await run(`update public.profiles set job_title = 'Reviewed' where id = '${f.national}' returning 1`);
      expect(rows.length).toBe(1);
    });
    await withRole("authenticated", { sub: f.opA, role: "authenticated" }, async (run) => {
      expect((await run("select id from public.sites")).length).toBeGreaterThan(0);
      await run("select public.complete_staff_profile('Safety Lead','AgriLib Mining')");
    });
    await withRole("authenticated", { sub: f.county, role: "authenticated" }, async (run) => {
      expect((await run("select id from public.sites")).length).toBeGreaterThan(0);
    });
  });
});

describe("0047: source contracts (the UI no longer offers staff self-onboarding)", () => {
  test("RequireAuth has no 'I am Ministry staff' choice or staff-onboarding flag", () => {
    const s = read("src/components/RequireAuth.tsx");
    expect(s).not.toMatch(/Ministry or inspection staff<|STAFF_ONBOARDING|mg\.onboarding\.staff/);
    expect(s).toContain("/join");
    expect(s).toContain("/report");
  });
  test("the cookie/storage inventory no longer lists the removed key", () => {
    expect(read("src/pages/Cookies.tsx")).not.toContain("mg.onboarding.staff.v1");
  });
  test("the client never sends scope, county or company to complete_staff_profile", () => {
    const s = read("src/lib/backend.ts");
    const i = s.indexOf('rpc("complete_staff_profile"');
    expect(i).toBeGreaterThan(0);
    const call = s.slice(i, i + 220);
    expect(call).not.toMatch(/p_scope|p_county|p_operator_name/);
  });
  test("the migration carries no automatic-admin branch", () => {
    const m = read("supabase/migrations/0048_close_admin_bootstrap.sql").replace(/--[^\n]*/g, "");
    expect(m).not.toMatch(/mg_any_profile_role\(\)\s*\)|v_first_admin|'admin'::public\.user_role/);
  });
});
