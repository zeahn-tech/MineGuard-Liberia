// ---------------------------------------------------------------------------
// Public User programme — Phase B (migration 0048): the server-side definition of a public
// user, the guest / registered separation, and administrator restriction of public accounts.
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
  // Other files re-apply older migrations on the shared DB: assert the real end state.
  const db = await getDb();
  for (const m of ["0048_close_admin_bootstrap.sql", "0049_public_user_identity.sql", "0050_public_reports_feedback.sql", "0052_public_content.sql"]) {
    await db.exec(read(`supabase/migrations/${m}`));
  }
}, 120000);

const PUB = "dddd0048-0000-4000-8000-000000000001"; // verified, role-less
const UNV = "dddd0048-0000-4000-8000-000000000002"; // e-mail not confirmed
const ANON = "dddd0048-0000-4000-8000-000000000003"; // anonymous guest (no e-mail)
const MEM = "dddd0048-0000-4000-8000-000000000004"; // role-less but active company member
const PEN = "dddd0048-0000-4000-8000-000000000005"; // role-less, membership request pending
const DEL = "dddd0048-0000-4000-8000-000000000006"; // soft-deleted account

async function denied(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return String((e as Error).message);
  }
  return "";
}

async function world(run: Runner) {
  await run(`insert into auth.users (id, email, email_confirmed_at) values
    ('${PUB}', 'pub@example.org', now()),
    ('${UNV}', 'unv@example.org', null),
    ('${ANON}', null, null),
    ('${MEM}', 'mem@example.org', now()),
    ('${PEN}', 'pen@example.org', now()),
    ('${DEL}', 'del@example.org', now())`);
  const org = (await run("select id from public.organizations order by name limit 1"))[0].id;
  await run(`insert into public.organization_members (organization_id, user_id, org_role, status) values
    ('${org}', '${MEM}', 'worker', 'active'), ('${org}', '${PEN}', 'worker', 'pending')`);
  await run(`update public.profiles set deleted_at = now() where id = '${DEL}'`);
}
const as = (run: Runner, uid: string, anonymous = false) =>
  run("set local role authenticated").then(() =>
    run(`select set_config('request.jwt.claims', '${JSON.stringify({ sub: uid, role: "authenticated", is_anonymous: anonymous })}', true)`),
  );
const cls = async (run: Runner) => (await run("select public.mg_my_access_class() as c"))[0].c;
const flags = async (run: Runner) =>
  (await run("select public.mg_is_public_user() as pub, public.mg_is_verified_public_user() as ver, public.mg_is_anonymous() as anon"))[0];

describe("0048: who is a public user (server-derived)", () => {
  test("a verified, role-less, unrestricted account is a verified public user", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await as(run, PUB);
      expect(await flags(run)).toEqual({ pub: true, ver: true, anon: false });
      expect(await cls(run)).toBe("public_user");
    });
  });

  test("an unverified account is a public user but NOT a verified one", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await as(run, UNV);
      expect(await flags(run)).toEqual({ pub: true, ver: false, anon: false });
      expect(await cls(run)).toBe("public_user_unverified");
    });
  });

  test("an anonymous guest is never a public user", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await as(run, ANON, true);
      expect(await flags(run)).toEqual({ pub: false, ver: false, anon: true });
      expect(await cls(run)).toBe("anonymous_guest");
    });
  });

  test("defence in depth: a session with no e-mail is not a public user even if the anonymous claim were missing", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await as(run, ANON, false);
      const x = await flags(run);
      expect(x.pub).toBe(false);
      expect(x.ver).toBe(false);
      expect(await cls(run)).toBe("unregistered");
    });
  });

  test("an active company member is not a public user; a PENDING request does not change that status", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await as(run, MEM);
      expect((await flags(run)).pub).toBe(false);
      expect(await cls(run)).toBe("company_member");
      await run("reset role");
      await as(run, PEN);
      expect((await flags(run)).pub).toBe(true);
      expect(await cls(run)).toBe("public_user");
    });
  });

  test("a soft-deleted account is not a public user", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await as(run, DEL);
      expect((await flags(run)).pub).toBe(false);
      expect(await cls(run)).toBe("unregistered");
    });
  });

  test("staff and company role holders are classified as such and are never public users", async () => {
    for (const [uid, want] of [
      [f.admin, "staff"],
      [f.national, "staff"],
      [f.county, "staff"],
      [f.opA, "company_member"],
    ] as const) {
      await withRole("authenticated", { sub: uid, role: "authenticated" }, async (run) => {
        expect((await flags(run)).pub).toBe(false);
        expect(await cls(run)).toBe(want);
      });
    }
  });

  test("the fixture's role-less 'guest' account (verified e-mail) is a public user", async () => {
    await withRole("authenticated", { sub: f.guest, role: "authenticated" }, async (run) => {
      expect((await flags(run)).pub).toBe(true);
    });
  });

  test("no session, and the anon API role, cannot call the helpers", async () => {
    await withRole("anon", null, async (run) => {
      for (const fn of ["mg_is_public_user()", "mg_is_verified_public_user()", "mg_is_anonymous()", "mg_my_access_class()"]) {
        expect(await denied(run(`select public.${fn}`))).toMatch(/permission denied/i);
      }
    });
  });

  test("helpers are stable SECURITY DEFINER functions with a pinned search_path (usable once-per-statement in policies)", async () => {
    await withRole("postgres", null, async (run) => {
      const rows = await run(`select proname, provolatile, prosecdef, proconfig::text as cfg from pg_proc
        where pronamespace = 'public'::regnamespace
          and proname in ('mg_is_public_user','mg_is_verified_public_user','mg_is_anonymous','mg_my_access_class')`);
      expect(rows.length).toBe(4);
      for (const r of rows) {
        expect(r.provolatile).toBe("s");
        expect(r.prosecdef).toBe(true);
        expect(String(r.cfg)).toContain("search_path=public");
      }
    });
  });
});

describe("0048: restriction cannot be self-applied, self-lifted or read by the account holder", () => {
  test("a public user cannot set or clear restricted_at on their own profile, nor insert one with it", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await as(run, PUB);
      expect(await denied(run(`update public.profiles set restricted_at = now() where id = '${PUB}'`))).toContain("FORBIDDEN_ROLE_CHANGE");
      await run("reset role");
      await run(`update public.profiles set restricted_at = now() where id = '${PUB}'`);
      await as(run, PUB);
      expect(await denied(run(`update public.profiles set restricted_at = null where id = '${PUB}'`))).toContain("FORBIDDEN_ROLE_CHANGE");
      await run("reset role");
      await run(`delete from public.profiles where id = '${UNV}'`);
      await as(run, UNV);
      expect(await denied(run(`insert into public.profiles (id, restricted_at) values ('${UNV}', now())`))).toContain("FORBIDDEN_ROLE_CHANGE");
    });
  });

  test("the restriction history is administrator-only (no read, no write for anyone else)", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await run(`insert into public.account_restriction_events (user_id, action, reason, actor_id)
                 values ('${PUB}', 'restrict', 'seeded for the test', '${f.admin}')`);
      for (const uid of [PUB, f.opA, f.county, f.national]) {
        await run("reset role");
        await as(run, uid);
        expect((await run("select * from public.account_restriction_events")).length).toBe(0);
        expect(await denied(run(`insert into public.account_restriction_events (user_id, action, reason, actor_id)
          values ('${PUB}', 'release', 'forged release attempt', '${uid}')`))).toMatch(/permission denied|row-level security/i);
      }
      await run("reset role");
      await as(run, f.admin);
      expect((await run("select * from public.account_restriction_events")).length).toBe(1);
    });
  });
});

describe("0048: mg_set_account_restriction (administrator only, public accounts only, audited)", () => {
  test("non-administrators are refused", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      for (const uid of [PUB, f.opA, f.county, f.national]) {
        await run("reset role");
        await as(run, uid);
        expect(await denied(run(`select public.mg_set_account_restriction('${UNV}', true, 'abusive reports repeatedly')`))).toContain("FORBIDDEN");
      }
      await run("reset role");
      await as(run, ANON, true);
      expect(await denied(run(`select public.mg_set_account_restriction('${UNV}', true, 'abusive reports repeatedly')`))).toContain("FORBIDDEN");
    });
  });

  test("an administrator restricts and releases a public account; the helpers follow and the reason is kept admin-side", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await as(run, f.admin);
      await run(`select public.mg_set_account_restriction('${PUB}', true, 'Repeated abusive submissions')`);
      await run("reset role");
      await as(run, PUB);
      expect((await flags(run)).pub).toBe(false);
      expect(await cls(run)).toBe("restricted");
      // the restricted person's own profile row shows only a timestamp — never the reason or the actor
      const me = (await run(`select * from public.profiles where id = '${PUB}'`))[0];
      expect(me.restricted_at).not.toBeNull();
      expect(JSON.stringify(me)).not.toContain("abusive submissions");
      await run("reset role");
      await as(run, f.admin);
      const ev = await run(`select action, reason, actor_id from public.account_restriction_events where user_id = '${PUB}'`);
      expect(ev).toEqual([{ action: "restrict", reason: "Repeated abusive submissions", actor_id: f.admin }]);
      await run(`select public.mg_set_account_restriction('${PUB}', false, 'Reviewed on appeal, reinstated')`);
      await run("reset role");
      await as(run, PUB);
      expect((await flags(run)).pub).toBe(true);
      expect(await cls(run)).toBe("public_user");
      // and the change is in the audit trail
      await run("reset role");
      const audit = await run(`select count(*)::int as n from public.audit_log where entity_id = '${PUB}'`);
      expect(audit[0].n).toBeGreaterThan(0);
    });
  });

  test("it refuses: self, staff, company members, unknown accounts, and missing or short reasons", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await as(run, f.admin);
      const call = (u: string, why = "a perfectly good reason") => denied(run(`select public.mg_set_account_restriction('${u}', true, '${why}')`));
      expect(await call(f.admin)).toMatch(/cannot restrict your own/);
      expect(await call(f.county)).toMatch(/public accounts/);
      expect(await call(f.opA)).toMatch(/public accounts/);
      expect(await call(MEM)).toMatch(/public accounts/);
      expect(await call("dddd0048-0000-4000-8000-0000000000ff")).toMatch(/NOT_FOUND/);
      expect(await call(PUB, "short")).toMatch(/INVALID/);
      expect(await call(DEL)).toMatch(/NOT_FOUND/);
    });
  });
});

describe("0048: guest sessions and registered accounts are separated on existing writes", () => {
  const sub = { p_endpoint: "https://push.example/ep1", p_p256dh: "k", p_auth: "a" };
  const push = (run: Runner) =>
    run(`select public.mg_register_push_subscription('${sub.p_endpoint}', '${sub.p_p256dh}', '${sub.p_auth}')`);

  test("anonymous guests cannot register push subscriptions or edit a profile", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await as(run, ANON, true);
      expect(await denied(push(run))).toContain("FORBIDDEN");
      expect(await denied(run("select public.mg_update_my_profile('Guest Person', 'Visitor')"))).toContain("FORBIDDEN");
      await run("reset role");
      expect((await run("select count(*)::int as n from public.push_subscriptions"))[0].n).toBe(0);
    });
  });

  test("registered accounts keep both, restricted accounts lose push registration", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await as(run, PUB);
      await push(run);
      await run("select public.mg_update_my_profile('Public Person', 'Resident')");
      await run("reset role");
      expect((await run(`select name, job_title from public.profiles where id = '${PUB}'`))[0]).toEqual({ name: "Public Person", job_title: "Resident" });
      await run(`update public.profiles set restricted_at = now() where id = '${PUB}'`);
      await as(run, PUB);
      expect(await denied(run(`select public.mg_register_push_subscription('https://push.example/ep2', 'k', 'a')`))).toContain("FORBIDDEN");
    });
  });

  test("an anonymous guest still sees nothing of company, Ministry or other people's records", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await as(run, ANON, true);
      for (const t of ["sites", "incidents", "inspections", "findings", "corrective_actions", "evidence", "organizations",
        "organization_members", "organization_invitations", "audit_log", "emergency_alerts", "worker_voice_reports", "account_restriction_events"]) {
        const n = (await run(`select count(*)::int as n from public.${t}`).catch(() => [{ n: -1 }]))[0].n;
        expect(n <= 0, `${t} must be invisible to a guest`).toBe(true);
      }
      expect((await run("select count(*)::int as n from public.profiles"))[0].n).toBe(1); // only their own row
    });
  });
});

describe("0048: existing roles are unaffected", () => {
  test("operators, inspectors, supervisors and administrators still see and do what they did", async () => {
    await withRole("authenticated", { sub: f.opA, role: "authenticated" }, async (run) => {
      expect((await run("select id from public.sites")).length).toBeGreaterThan(0);
      await run("select public.mg_update_my_profile('Bob Operator', 'Safety Lead')");
    });
    await withRole("authenticated", { sub: f.county, role: "authenticated" }, async (run) => {
      expect((await run("select id from public.sites")).length).toBeGreaterThan(0);
    });
    await withRole("authenticated", { sub: f.national, role: "authenticated" }, async (run) => {
      expect((await run("select id from public.sites")).length).toBe(2);
    });
    await withRole("authenticated", { sub: f.admin, role: "authenticated" }, async (run) => {
      expect((await run("select id from public.profiles")).length).toBeGreaterThan(3);
      expect((await run(`update public.profiles set job_title = 'Director' where id = '${f.national}' returning 1`)).length).toBe(1);
    });
  });
});

describe("0048: source contracts", () => {
  test("the UI reads the server-derived class, tolerates a database without 0048, and never decides access itself", () => {
    const b = read("src/lib/backend.ts");
    expect(b).toContain('rpc("mg_my_access_class")');
    expect(b).toMatch(/PGRST202[\s\S]{0,200}"unknown"/);
    const r = read("src/components/RequireAuth.tsx");
    expect(r).toContain("api.account.accessClass");
    expect(r).toContain("anonymous_guest");
  });
  test("the migration is additive: it never grants a role, never loosens a policy", () => {
    const m = read("supabase/migrations/0049_public_user_identity.sql").replace(/--[^\n]*/g, "");
    expect(m).not.toMatch(/\bgrant\s+(insert|update|delete|all)\b/i);
    expect(m).not.toMatch(/to anon/i);
    expect(m).not.toMatch(/using\s*\(\s*true\s*\)/i);
  });
});
