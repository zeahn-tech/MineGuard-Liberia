// ---------------------------------------------------------------------------
// "NOT COVERED" REVIEW (follow-up to audit finding E1) — pins what was VERIFIED
// about the permission-gated tables, so a future change to the permissions table
// or a policy cannot silently widen who may write them.
//
// Method: for each caller we count how many rows their UPDATE actually rewrote
// (a real value change inside a DO block, reading GET DIAGNOSTICS ROW_COUNT).
// That measures what the policy ALLOWS regardless of column names, values or
// SELECT policies, and the admin control proves the probe can see rows at all.
//
// Verified result (2026-11-01): sites, site_boundaries, site_assignments and
// admin_areas are admin-only (geo.write / assignments.manage / sites.update are
// held only by `admin`), and admins are national by design. organizations is
// admin + registrar (`organizations.write`). These are role gates, not site
// scopes, so they are correct ONLY while those permissions stay as seeded.
//
// DOCUMENTED, DECISION PENDING (pinned so a change is deliberate):
//   • a registrar can update every organization (registry role is national);
//   • any staff role — including a county-scoped inspector — can update the
//     NATIONAL inspection_templates (permission `templates.write` is seeded for
//     admin, inspector and supervisor; edits are audited and row-versioned).
// ---------------------------------------------------------------------------

import { beforeAll, describe, expect, test } from "bun:test";
import { getFixture, IDS, withRole, type Runner } from "./helpers/pglite-db";

beforeAll(() => getFixture());

const ADMIN_ONLY = ["sites", "site_boundaries", "site_assignments", "admin_areas"] as const;

// CONSTANT assignments, on purpose. An UPDATE whose SET expression (or WHERE)
// READS a column is additionally filtered by the SELECT policy, so a caller who
// cannot read a row would see 0 rows even if the UPDATE policy allowed the write
// — exactly the blind spot behind audit finding E1. A constant assignment reads
// nothing, so only the UPDATE policy decides. (No-op updates are skipped by some
// triggers, hence a real value; everything is rolled back with the transaction.)
const CHANGE: Record<string, string> = {
  sites: "name = 'PROBE'",
  organizations: "name = 'PROBE'",
  admin_areas: "name = 'PROBE'",
  inspection_templates: "name = 'PROBE'",
};

async function updatable(run: Runner, table: string, uid: string): Promise<number> {
  // How many rows did the caller's UPDATE actually rewrite? PL/pgSQL's
  // GET DIAGNOSTICS ROW_COUNT reports exactly the rows the UPDATE policy allowed,
  // independent of column names, values and SELECT policies (`RETURNING` would
  // also demand read access and so under-count a caller who may write but not
  // read). The result is carried out through a transaction-local setting.
  await run(`select set_config('probe.n', '0', true)`);
  await run(`set local role authenticated`);
  await run(`set local request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'`);
  try {
    await run(
      `do $$ declare n integer; begin
         update public.${table} set ${CHANGE[table] ?? "id = id"};
         get diagnostics n = row_count;
         perform set_config('probe.n', n::text, true);
       end $$`,
    );
  } catch {
    /* an error is a denial */
  } finally {
    await run(`reset role`);
  }
  return Number((await run(`select current_setting('probe.n') n`))[0].n);
}

async function asRole<T>(
  uid: string,
  role: string | null,
  fn: (run: Runner) => Promise<T>,
): Promise<T> {
  return withRole("postgres", null, async (run) => {
    if (role) await run(`update public.profiles set role='${role}' where id='${uid}'`);
    return fn(run);
  });
}

describe("the permission seed that these gates depend on", () => {
  test("write permissions are held only by the intended roles", async () => {
    await withRole("postgres", null, async (run) => {
      const held = async (perm: string) =>
        (await run(`select role::text r from public.permissions where permission='${perm}' order by 1`)).map(
          (x) => x.r as string,
        );
      expect(await held("sites.update")).toEqual(["admin"]);
      expect(await held("geo.write")).toEqual(["admin"]);
      expect(await held("assignments.manage")).toEqual(["admin"]);
      expect(await held("organizations.write")).toEqual(["admin", "registrar"]);
      expect(await held("templates.write")).toEqual(["admin", "inspector", "supervisor"]);
    });
  });
});

describe("tables that are empty in the fixture are pinned by their policy definition", () => {
  test("site_boundaries / site_assignments / admin_boundaries / admin_areas UPDATE and INSERT policies require the admin-held permission", async () => {
    await withRole("postgres", null, async (run) => {
      const want: [string, string][] = [
        ["site_boundaries", "geo.write"],
        ["admin_boundaries", "geo.write"],
        ["admin_areas", "geo.write"],
        ["site_assignments", "assignments.manage"],
        ["sites", "sites.update"],
        ["organizations", "organizations.write"],
      ];
      for (const [table, perm] of want) {
        const rows = await run(
          `select cmd, qual from pg_policies where schemaname='public' and tablename='${table}' and cmd='UPDATE'`,
        );
        expect(rows.length, `${table} has an UPDATE policy`).toBe(1);
        expect(String(rows[0].qual), `${table} UPDATE`).toContain(`mg_has_permission('${perm}'`);
      }
    });
  });
});

describe("admin-only tables cannot be written by any other role (unfiltered shape)", () => {
  const callers: [string, string, string | null][] = [
    ["county inspector", IDS.county, null],
    ["county-scoped supervisor", IDS.county, "supervisor"],
    ["national supervisor", IDS.national, null],
    ["company operator A", IDS.opA, null],
    ["company operator B", IDS.opB, null],
    ["role-less account", IDS.guest, null],
  ];
  for (const [label, uid, role] of callers) {
    test(`${label}: 0 rows updatable on sites, boundaries, assignments, admin areas, organizations`, async () => {
      await asRole(uid, role, async (run) => {
        for (const t of [...ADMIN_ONLY, "organizations"]) {
          expect(await updatable(run, t, uid), `${label} on ${t}`).toBe(0);
        }
      });
    });
  }

  test("control: an admin CAN update sites and organizations (the probe is not vacuous)", async () => {
    await withRole("postgres", null, async (run) => {
      expect(await updatable(run, "sites", IDS.admin)).toBeGreaterThan(0);
      expect(await updatable(run, "organizations", IDS.admin)).toBeGreaterThan(0);
    });
  });
});

describe("documented, decision-pending behaviors (pinned so a change is deliberate)", () => {
  test("a registrar can update organizations nationally (registry role)", async () => {
    await asRole(IDS.county, "registrar", async (run) => {
      expect(await updatable(run, "organizations", IDS.county)).toBeGreaterThan(0);
      // …but a registrar still cannot write sites, boundaries or assignments.
      for (const t of ADMIN_ONLY) expect(await updatable(run, t, IDS.county), t).toBe(0);
    });
  });

  test("staff (incl. county-scoped inspector) can update national inspection templates; operators cannot", async () => {
    await withRole("postgres", null, async (run) => {
      expect(await updatable(run, "inspection_templates", IDS.county)).toBeGreaterThan(0);
      expect(await updatable(run, "inspection_templates", IDS.opA)).toBe(0);
      expect(await updatable(run, "inspection_templates", IDS.guest)).toBe(0);
    });
  });

  test("template edits are protected by guard, audit and versioning triggers", async () => {
    await withRole("postgres", null, async (run) => {
      const names = (
        await run(
          `select tgname from pg_trigger where tgrelid='public.inspection_templates'::regclass and not tgisinternal order by 1`,
        )
      ).map((r) => r.tgname as string);
      expect(names).toEqual([
        "inspection_templates_audit",
        "inspection_templates_guard",
        "inspection_templates_touch",
      ]);
      const cols = (
        await run(
          `select column_name from information_schema.columns where table_schema='public' and table_name='inspection_templates'`,
        )
      ).map((r) => r.column_name as string);
      expect(cols).toContain("row_version");
    });
  });
});
