// ---------------------------------------------------------------------------
// Public User programme — Phase E: whole-surface verification on a real Postgres (PGlite) with every
// production migration applied.
//
//   1. FUNCTION SURFACE   every function a signed-in session can execute is called with benign garbage
//                         arguments as each public persona; no state may change and no rows may come
//                         back, except a short, reviewed allowlist. A NEW function that lets a public
//                         user write or read something fails here until someone reviews it.
//   2. TABLE SURFACE      what each persona can read from every table, pinned exactly.
//   3. POLICY HYGIENE     no permissive policy on any table except reviewed reference data.
//   4. STORAGE            evidence and avatar objects per persona.
//   5. JOURNEY            public user -> membership request -> company member -> revoked, across phases.
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
  // Other files re-apply older migrations on the shared DB: assert the real end state (the whole chain,
  // in order; every file is idempotent).
  const db = await getDb();
  for (const m of [
    "0048_close_admin_bootstrap.sql",
    "0049_public_user_identity.sql",
    "0050_public_reports_feedback.sql",
    "0052_public_content.sql",
  ]) {
    await db.exec(read(`supabase/migrations/${m}`));
  }
}, 120000);

const VER = "dddd00e5-0000-4000-8000-000000000001"; // verified public user
const UNV = "dddd00e5-0000-4000-8000-000000000002"; // e-mail not confirmed
const GST = "dddd00e5-0000-4000-8000-000000000003"; // anonymous guest
const RST = "dddd00e5-0000-4000-8000-000000000004"; // restricted public account

type Persona = { label: string; role: "anon" | "authenticated"; uid: string | null; anonymous: boolean };
const PERSONAS: Persona[] = [
  { label: "anon role (no session)", role: "anon", uid: null, anonymous: false },
  { label: "anonymous guest", role: "authenticated", uid: GST, anonymous: true },
  { label: "unverified account", role: "authenticated", uid: UNV, anonymous: false },
  { label: "verified public user", role: "authenticated", uid: VER, anonymous: false },
  { label: "restricted public user", role: "authenticated", uid: RST, anonymous: false },
];

async function world(run: Runner) {
  await run(`insert into auth.users (id, email, email_confirmed_at) values
    ('${VER}', 'ver@example.org', now()), ('${UNV}', 'unv@example.org', null),
    ('${GST}', null, null), ('${RST}', 'rst@example.org', now())`);
  await run(`update public.profiles set restricted_at = now() where id = '${RST}'`);
}
async function become(run: Runner, p: Persona) {
  await run("reset role");
  await run(`set local role ${p.role}`);
  if (p.uid) {
    await run(`select set_config('request.jwt.claims', '${JSON.stringify({ sub: p.uid, role: "authenticated", is_anonymous: p.anonymous })}', true)`);
  }
}
async function denied(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return String((e as Error).message);
  }
  return "";
}

// ============================================================================================
// 1. FUNCTION SURFACE
// ============================================================================================
/** The ONLY functions a public persona may change state through with benign arguments, each
 *  reviewed. Everything else must leave every table byte-for-byte unchanged. */
const MAY_MUTATE = new Set([
  "refresh_public_stats", //     anon-executable counter refresh into meta (now unread by the public; see docs/25)
  "mg_prepare_account_deletion", // a person erasing their OWN account
  "mg_set_my_avatar", //          clearing their OWN avatar pointer
]);
/** Set-returning functions that may return rows to a public persona (none today). */
const MAY_RETURN_ROWS = new Set<string>();

const literal = (t: string): string | null => {
  const x = t.trim();
  const map: Record<string, string> = {
    uuid: "'00000000-0000-4000-8000-0000000000aa'::uuid",
    text: "'x'",
    integer: "1",
    bigint: "1",
    smallint: "1",
    boolean: "false",
    jsonb: "'{}'::jsonb",
    "double precision": "0",
    numeric: "0",
    date: "current_date",
    "text[]": "array['x']",
    "uuid[]": "array[]::uuid[]",
  };
  if (map[x]) return map[x];
  if (x.startsWith("timestamp")) return "now()";
  return null;
};

describe("1 · function surface: no public persona changes state or reads rows through any callable function", () => {
  test("every callable function, every public persona", async () => {
    const db = await getDb();
    const fns = (
      await db.query<{ proname: string; args: string; proretset: boolean; anon_ok: boolean }>(`
        select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.proretset,
               has_function_privilege('anon', p.oid, 'EXECUTE') as anon_ok
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.prokind = 'f' and pg_get_function_result(p.oid) <> 'trigger'
           and has_function_privilege('authenticated', p.oid, 'EXECUTE')
         order by 2`)
    ).rows;
    expect(fns.length).toBeGreaterThan(150); // the surface really was enumerated

    const tables = (await db.query<{ tablename: string }>(`select tablename from pg_tables where schemaname = 'public' and tablename <> 'rate_limits' order by 1`)).rows;
    const digest =
      `select md5(string_agg(x, '')) as d from (` +
      tables.map((t) => `select md5(coalesce((select string_agg(r::text, '' order by r::text) from public.${t.tablename} r), '')) as x`).join(" union all ") +
      `) s`;

    const mutated: string[] = [];
    const leaked: string[] = [];
    let called = 0;

    await db.exec("begin");
    try {
      await db.exec(`insert into auth.users (id, email, email_confirmed_at) values
        ('${VER}', 'ver@example.org', now()), ('${UNV}', 'unv@example.org', null), ('${GST}', null, null), ('${RST}', 'rst@example.org', now())`);
      await db.exec(`update public.profiles set restricted_at = now() where id = '${RST}'`);

      for (const p of PERSONAS) {
        for (const fn of fns) {
          if (p.role === "anon" && !fn.anon_ok) continue;
          const argTypes = fn.args
            ? fn.args.split(/,(?![^()]*\))/).map((a) => {
                const parts = a.trim().split(" ");
                const named = parts.length > 1 && !["precision", "with", "without"].includes(parts[1]);
                return named ? parts.slice(1).join(" ") : a.trim();
              })
            : [];
          const lits = argTypes.map(literal);
          if (lits.some((l) => l === null)) continue; // cryptographic helpers etc. with bytea arguments
          called++;

          await db.exec("reset role");
          const before = (await db.query<{ d: string }>(digest)).rows[0].d;
          await db.exec("savepoint s");
          await db.exec(`set local role ${p.role}`);
          if (p.uid) {
            await db.exec(`select set_config('request.jwt.claims', '${JSON.stringify({ sub: p.uid, role: "authenticated", is_anonymous: p.anonymous })}', true)`);
          }
          let ok = true;
          let rows = 0;
          try {
            rows = (await db.query(`select * from public.${fn.proname}(${lits.join(",")})`)).rows.length;
          } catch {
            ok = false;
          }
          if (!ok) {
            await db.exec("rollback to savepoint s");
            continue;
          }
          await db.exec("reset role");
          const after = (await db.query<{ d: string }>(digest)).rows[0].d;
          await db.exec("rollback to savepoint s");
          if (after !== before && !MAY_MUTATE.has(fn.proname)) mutated.push(`${p.label}: ${fn.proname}(${fn.args})`);
          if (fn.proretset && rows > 0 && !MAY_RETURN_ROWS.has(fn.proname)) leaked.push(`${p.label}: ${fn.proname}(${fn.args}) returned ${rows} row(s)`);
        }
      }
    } finally {
      await db.exec("rollback");
    }
    expect(called).toBeGreaterThan(500); // many calls were actually made
    expect(mutated, "functions that changed state for a public persona").toEqual([]);
    expect(leaked, "set-returning functions that returned rows to a public persona").toEqual([]);
  }, 240000);

  test("the aggregate dashboard function returns only zeros to a public user (it is scoped by row-level security, not trusted)", async () => {
    await withRole("authenticated", { sub: f.guest, role: "authenticated" }, async (run) => {
      const s = (await run("select public.mg_command_center_stats() as s"))[0].s as Record<string, unknown>;
      for (const k of ["sites", "activeSites", "findingsTotal", "incidentsTotal", "inspectionsTotal", "communityReports", "fatalities", "envAlerts", "correctiveActionsOpen"]) {
        expect(s[k], k).toBe(0);
      }
      expect(s.countyCounts).toEqual({});
      expect(s.incidentTypes).toEqual({});
    });
  });
});

// ============================================================================================
// 2. TABLE SURFACE
// ============================================================================================
describe("2 · table surface: what each persona can read, pinned", () => {
  test("public personas read only their own profile and the county/district reference list; the anon role reads nothing", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      const tables = (await run("select tablename from pg_tables where schemaname = 'public' order by 1")).map((t) => t.tablename as string);
      for (const p of PERSONAS) {
        const seen: string[] = [];
        for (const t of tables) {
          await run("reset role");
          await run("savepoint s");
          await become(run, p);
          let n = 0;
          try {
            n = (await run(`select count(*)::int as n from public.${t}`))[0].n as number;
          } catch {
            n = 0; // permission denied
          }
          await run("reset role");
          await run("rollback to savepoint s");
          if (n > 0) seen.push(`${t}=${n}`);
        }
        // county/district reference rows vary with what other suites seed, so pin the TABLES, and the one
        // profile row (their own) exactly
        const names = seen.map((x) => x.split("=")[0]).sort();
        expect(names, p.label).toEqual(p.role === "anon" ? [] : ["admin_areas", "profiles"]);
        if (p.role !== "anon") expect(seen).toContain("profiles=1");
      }
    });
  }, 120000);

  test("a company member sees only their own company's records (never the other company's)", async () => {
    await withRole("authenticated", { sub: f.opA, role: "authenticated" }, async (run) => {
      expect((await run("select name from public.organizations")).map((r) => r.name)).toEqual(["AgriLib Mining"]);
      const sites = await run("select operator_name from public.sites");
      expect(sites.length).toBeGreaterThan(0);
      expect(sites.every((s) => s.operator_name === "AgriLib Mining")).toBe(true);
      expect((await run("select count(*)::int as n from public.profiles where id <> auth.uid()"))[0].n).toBe(0);
    });
  });
});

// ============================================================================================
// 3. POLICY HYGIENE
// ============================================================================================
describe("3 · policy hygiene", () => {
  test("the only unconditional policy in the schema is the county/district reference list", async () => {
    const db = await getDb();
    const rows = (await db.query<{ tablename: string; policyname: string }>(
      `select tablename, policyname from pg_policies where schemaname in ('public','storage') and (qual = 'true' or with_check = 'true')`,
    )).rows;
    expect(rows.map((r) => `${r.tablename}:${r.policyname}`)).toEqual(["admin_areas:admin_areas read"]);
  });

  test("anon has no table-level read, and the only column-level read is the published public_content columns", async () => {
    const db = await getDb();
    const tbl = (await db.query<{ t: string }>(`select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and has_table_privilege('anon', c.oid, 'SELECT')`)).rows;
    expect(tbl).toEqual([]);
    const cols = (await db.query<{ t: string; c: string }>(`select table_name as t, column_name as c from information_schema.column_privileges
      where grantee = 'anon' and table_schema = 'public' and privilege_type = 'SELECT' order by 1, 2`)).rows;
    expect([...new Set(cols.map((x) => x.t))]).toEqual(["public_content"]);
    expect(cols.map((x) => x.c).sort()).toEqual(["body", "category", "data", "id", "kind", "language", "published_at", "slug", "summary", "title", "version"].sort());
    expect(cols.map((x) => x.c)).not.toContain("source");
  });

  test("no client role holds a write grant on any table the public programme added", async () => {
    const db = await getDb();
    const rows = (await db.query<{ t: string; r: string; p: string }>(`select table_name as t, grantee as r, privilege_type as p from information_schema.role_table_grants
      where table_schema = 'public' and grantee in ('anon', 'authenticated')
        and table_name in ('public_content', 'public_content_events', 'public_feedback', 'account_restriction_events')
        and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')`)).rows;
    expect(rows).toEqual([]);
  });
});

// ============================================================================================
// 4. STORAGE
// ============================================================================================
describe("4 · storage: evidence and avatars per persona", () => {
  test("no public persona can upload, read or change evidence objects", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      const ev = (await run("select storage_path from public.evidence where storage_path is not null limit 1"))[0]?.storage_path as string | undefined;
      const path = ev ?? `${f.opA}/seed-evidence.jpg`;
      await run(`insert into storage.objects (bucket_id, name, owner) values ('evidence', '${path}', '${f.opA}')`);
      for (const p of PERSONAS.filter((x) => x.role === "authenticated")) {
        await become(run, p);
        expect((await run(`select 1 from storage.objects where bucket_id = 'evidence' and name = '${path}'`)).length, `${p.label} read`).toBe(0);
        expect((await run(`select 1 from storage.objects where bucket_id = 'evidence'`)).length, `${p.label} list`).toBe(0);
        expect(await denied(run(`insert into storage.objects (bucket_id, name, owner) values ('evidence', '${p.uid}/mine.jpg', '${p.uid}')`)), `${p.label} upload`).toMatch(/row-level security|permission denied/i);
        expect(await denied(run(`insert into storage.objects (bucket_id, name, owner) values ('evidence', '${f.opA}/planted.jpg', '${p.uid}')`)), `${p.label} plant`).toMatch(/row-level security|permission denied/i);
        await run("savepoint u");
        const upd = await run(`update storage.objects set name = name where bucket_id = 'evidence' and name = '${path}' returning 1`);
        await run("rollback to savepoint u");
        expect(upd.length, `${p.label} update`).toBe(0);
        await run("reset role");
      }
      await run("set local role anon");
      // hosted Supabase lets anon query storage.objects but no policy matches: zero rows, never an object
      let anonRows = 0;
      try {
        anonRows = (await run("select count(*)::int as n from storage.objects"))[0].n as number;
      } catch {
        anonRows = 0;
      }
      expect(anonRows).toBe(0);
    });
  });

  test("a company member with site access can read their evidence object; another company's member cannot", async () => {
    await withRole("postgres", null, async (run) => {
      const ev = (await run("select storage_path, site_id from public.evidence where storage_path is not null limit 1"))[0] as { storage_path: string; site_id: string } | undefined;
      if (!ev) return; // fixture has no evidence row with a stored object
      const have = (await run(`select count(*)::int as n from storage.objects where bucket_id = 'evidence' and name = '${ev.storage_path}'`))[0].n as number;
      if (have === 0) await run(`insert into storage.objects (bucket_id, name, owner) values ('evidence', '${ev.storage_path}', '${f.opA}')`);
      const total = (await run(`select count(*)::int as n from storage.objects where bucket_id = 'evidence' and name = '${ev.storage_path}'`))[0].n as number;
      const seeAs = async (uid: string) => {
        await run("reset role");
        await run("set local role authenticated");
        await run(`select set_config('request.jwt.claims', '${JSON.stringify({ sub: uid, role: "authenticated" })}', true)`);
        return (await run(`select 1 from storage.objects where bucket_id = 'evidence' and name = '${ev.storage_path}'`)).length;
      };
      expect(await seeAs(f.opA)).toBe(total); // their company's evidence is readable to them
      expect(await seeAs(f.opB)).toBe(0); //     the other company's member sees nothing
    });
  });

  test("avatars: a person manages only their own file; nobody touches another person's", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await run(`insert into storage.objects (bucket_id, name, owner) values ('avatars', '${f.opA}/avatar.jpg', '${f.opA}')`);
      await become(run, PERSONAS[3]); // verified public user
      expect((await run(`select 1 from storage.objects where bucket_id = 'avatars' and name = '${f.opA}/avatar.jpg'`)).length).toBe(0);
      expect(await denied(run(`insert into storage.objects (bucket_id, name, owner) values ('avatars', '${f.opA}/avatar.jpg', '${VER}')`))).toMatch(/row-level security|permission denied|duplicate/i);
      expect(await denied(run(`insert into storage.objects (bucket_id, name, owner) values ('avatars', '${VER}/other.png', '${VER}')`))).toMatch(/row-level security|permission denied/i);
      await run(`insert into storage.objects (bucket_id, name, owner) values ('avatars', '${VER}/avatar.jpg', '${VER}')`); // their own: allowed
      await run("savepoint d");
      expect((await run(`delete from storage.objects where bucket_id = 'avatars' and name = '${f.opA}/avatar.jpg' returning 1`)).length).toBe(0);
      await run("rollback to savepoint d");
    });
  });
});

// ============================================================================================
// 5. JOURNEY: public user -> company member -> back
// ============================================================================================
describe("5 · journey: a public user becomes a company worker through the existing governed process", () => {
  test("registration, reporting, feedback, membership request, approval, revocation — one account throughout", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      const orgA = (await run("select id from public.organizations where name = 'AgriLib Mining'"))[0].id as string;
      const XA = "dddd00e5-0000-4000-8000-0000000000a1";
      await run(`insert into auth.users (id, email, email_confirmed_at) values ('${XA}', 'xa@agrilib.test', now())`);
      const asUser = async (uid: string) => {
        await run("reset role");
        await run("set local role authenticated");
        await run(`select set_config('request.jwt.claims', '${JSON.stringify({ sub: uid, role: "authenticated", is_anonymous: false })}', true)`);
      };
      // a company administrator exists through the real invitation flow
      await asUser(f.admin);
      const inv = (await run(`select public.mg_create_company_admin_invitation('${orgA}', 'xa@agrilib.test') as id`))[0].id;
      await asUser(XA);
      await run(`select public.mg_accept_invitation('${inv}')`);

      // 1. the person is a verified PUBLIC user: reports and writes to the Ministry, sees no company data
      await asUser(VER);
      expect((await run("select public.mg_my_access_class() as c"))[0].c).toBe("public_user");
      const rep = (await run(`select public.submit_my_community_report('pollution', 'Brown water in the creek every evening, below the washing plant.', 'Bomi') as r`))[0].r as { id: string };
      await run(`select public.submit_public_feedback('feedback', 'Notices in local languages', 'Please also publish the safety notices in Kpelle and Bassa.')`);
      expect((await run("select id from public.sites")).length).toBe(0);

      // 2. a membership REQUEST changes nothing about access
      await run(`select public.mg_request_membership('${orgA}')`);
      expect((await run("select id from public.sites")).length).toBe(0);
      expect((await run("select public.mg_my_access_class() as c"))[0].c).toBe("public_user");
      expect((await run("select role from public.profiles where id = auth.uid()"))[0].role).toBeNull();

      // 3. the requester cannot approve themselves; the company's administrator can
      await run("reset role");
      const memberId = (await run(`select id from public.organization_members where user_id = '${VER}' and status = 'pending'`))[0].id as string;
      await asUser(VER);
      expect(await denied(run(`select public.mg_decide_membership_request('${memberId}', true, 'worker')`))).toMatch(/FORBIDDEN/);
      await asUser(XA);
      await run(`select public.mg_decide_membership_request('${memberId}', true, 'worker')`);

      // 4. SAME account, new standing: company member, no longer a public user, own history intact
      await asUser(VER);
      expect((await run("select public.mg_my_access_class() as c"))[0].c).toBe("company_member");
      expect((await run("select public.mg_is_public_user() as p"))[0].p).toBe(false);
      expect((await run("select role from public.profiles where id = auth.uid()"))[0].role).toBe("operator");
      expect((await run("select id from public.sites")).length).toBeGreaterThan(0);
      expect((await run("select id from public.mg_my_community_reports()")).map((r) => r.id)).toEqual([rep.id]);
      expect(await denied(run(`select public.submit_my_community_report('pollution', 'A second concern, reported after joining the company.', 'Bomi')`))).toContain("FORBIDDEN");
      expect((await run("select count(*)::int as n from public.mg_my_feedback()"))[0].n).toBe(1);

      // 5. the change is in the audit trail, attributed to the administrator who made it
      await run("reset role");
      const audit = await run(`select count(*)::int as n from public.audit_log where entity_id = '${VER}' or entity_id = '${memberId}'`);
      expect(audit[0].n).toBeGreaterThan(0);

      // 6. membership revoked: the account returns to public-user standing without being recreated
      await asUser(XA);
      await run(`select public.mg_revoke_member('${memberId}')`);
      await asUser(VER);
      expect((await run("select count(*)::int as n from public.sites"))[0].n).toBe(0);
      expect((await run("select role from public.profiles where id = auth.uid()"))[0].role).toBeNull();
      expect((await run("select public.mg_my_access_class() as c"))[0].c).toBe("public_user");
      expect((await run("select id from public.mg_my_community_reports()")).length).toBe(1);
    });
  });
});
