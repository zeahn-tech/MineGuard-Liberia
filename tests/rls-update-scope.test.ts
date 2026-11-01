// ---------------------------------------------------------------------------
// E1 REGRESSION — UPDATE policies must be site-scoped (migration 0035).
//
// Before 0035, a scope-limited staff user (e.g. a Bomi county inspector) could
// change rows belonging to ANOTHER county with an UNFILTERED update, because the
// UPDATE policies checked only the caller's role. A filtered update by id was
// already blocked (the SELECT policy hides the row), which is why the original
// suite never caught it. These tests therefore exercise BOTH shapes, as a
// hostile API client would, against the real migrated schema and real RLS.
//
// Each test runs inside the helper's rolled-back transaction; out-of-scope
// rows are created as the table owner and inspected AFTER the role is reset.
// ---------------------------------------------------------------------------

import { beforeAll, describe, expect, test } from "bun:test";
import { getFixture, IDS, withRole, type Runner } from "./helpers/pglite-db";

beforeAll(() => getFixture());


// Out-of-scope (siteB / Grand Cape Mount) and in-scope (siteA / Bomi) rows.
const INC_B = "ffffffff-0000-4000-8000-0000000000b1";
const INC_A2 = "ffffffff-0000-4000-8000-0000000000a2";
const INSP_B = "dddddddd-0000-4000-8000-0000000000b1";
const INSP_A = "dddddddd-0000-4000-8000-0000000000a1";
const CA_B = "eeeeeeee-0000-4000-8000-0000000000b1";

async function seed(run: Runner, inspectorB: string = IDS.admin, inspectorA: string = IDS.admin) {
  await run(
    `insert into public.incidents (id,site_id,type,severity,description,occurred_at,status,reported_by_id,report_source,fatalities)
     values ('${INC_B}','${IDS.siteB}','injury','high','ORIGINAL-B',now(),'reported','${IDS.opB}','operator',0),
            ('${INC_A2}','${IDS.siteA}','injury','low','ORIGINAL-A',now(),'reported','${IDS.opA}','operator',0)`,
  );
  await run(
    `insert into public.inspections (id,site_id,template_id,inspector_id,status,answers)
     values ('${INSP_B}','${IDS.siteB}','${IDS.template}','${inspectorB}','draft','[]'::jsonb),
            ('${INSP_A}','${IDS.siteA}','${IDS.template}','${inspectorA}','draft','[]'::jsonb)`,
  );
  await run(
    `insert into public.corrective_actions (id,finding_id,site_id,description,due_at,opened_by_id)
     values ('${CA_B}','${IDS.findingB}','${IDS.siteB}','ORIGINAL-CA-B',now()+interval '7 days','${IDS.admin}')`,
  );
}

/** Switch the open transaction to an authenticated caller. */
async function become(run: Runner, uid: string) {
  await run(`set local role authenticated`);
  await run(`set local request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'`);
}
const unbecome = (run: Runner) => run(`reset role`);

/** Run statements as the caller; RLS errors (WITH CHECK) are tolerated — the
 *  assertion is always on the resulting data, never on "it didn't throw". */
async function attempt(run: Runner, stmts: string[]) {
  for (const s of stmts) {
    try {
      await run(s);
    } catch {
      /* a denied write is an acceptable outcome */
    }
  }
}

const val = async (run: Runner, sql: string) => Object.values((await run(sql))[0] ?? {})[0];

// What a hostile client would send: no WHERE, a filter by id, and a row-move.
const attacks = (table: string, set: string, id: string) => [
  `update public.${table} set ${set}`,
  `update public.${table} set ${set} where id='${id}'`,
];

const TABLES = [
  { table: "incidents", set: "description='TAMPERED'", id: INC_B, read: "description", orig: "ORIGINAL-B" },
  { table: "environmental_observations", set: "status='resolved'", id: IDS.obsB, read: "status", orig: null },
  { table: "findings", set: "title='TAMPERED'", id: IDS.findingB, read: "title", orig: "Tailings pond overtopping risk" },
  { table: "corrective_actions", set: "description='TAMPERED'", id: CA_B, read: "description", orig: "ORIGINAL-CA-B" },
  { table: "inspections", set: "status='submitted'", id: INSP_B, read: "status", orig: "draft" },
] as const;

describe("E1: out-of-scope rows cannot be changed by a county-scoped inspector", () => {
  for (const t of TABLES) {
    test(`${t.table}: unfiltered and by-id updates leave the other county's row untouched`, async () => {
      await withRole("postgres", null, async (run) => {
        await seed(run, IDS.county, IDS.county); // inspections owned by the caller: only SCOPE can stop it
        const before = await val(run, `select ${t.read} from public.${t.table} where id='${t.id}'`);
        // the county user is an inspector; findings/CA/inspections need reviewer or owner rights,
        // so the strongest hostile shape is the supervisor variant below. Here: the inspector.
        await become(run, IDS.county);
        await attempt(run, attacks(t.table, t.set, t.id));
        await unbecome(run);
        const after = await val(run, `select ${t.read} from public.${t.table} where id='${t.id}'`);
        expect(after).toBe(before);
        if (t.orig) expect(after).toBe(t.orig);
      });
    });
  }
});

describe("E1: out-of-scope rows cannot be changed by a county-scoped SUPERVISOR (reviewer)", () => {
  for (const t of TABLES) {
    test(`${t.table}: reviewer rights do not cross county lines`, async () => {
      await withRole("postgres", null, async (run) => {
        await seed(run);
        await run(`update public.profiles set role='supervisor' where id='${IDS.county}'`);
        const before = await val(run, `select ${t.read} from public.${t.table} where id='${t.id}'`);
        await become(run, IDS.county);
        await attempt(run, attacks(t.table, t.set, t.id));
        await unbecome(run);
        expect(await val(run, `select ${t.read} from public.${t.table} where id='${t.id}'`)).toBe(before);
      });
    });
  }

  test("incident fatalities / severity / description cannot be rewritten (the confirmed attack)", async () => {
    await withRole("postgres", null, async (run) => {
      await seed(run);
      await become(run, IDS.county);
      await attempt(run, [
        `update public.incidents set description='TAMPERED'`,
        `update public.incidents set fatalities=99`,
        `update public.incidents set severity='low'`,
      ]);
      await unbecome(run);
      const [row] = await run(
        `select description, fatalities, severity from public.incidents where id='${INC_B}'`,
      );
      expect(row).toEqual({ description: "ORIGINAL-B", fatalities: 0, severity: "high" });
    });
  });
});

describe("E1: a row cannot be moved to (or out of) a site the caller cannot see", () => {
  test("county inspector cannot re-home an in-scope incident to another county", async () => {
    await withRole("postgres", null, async (run) => {
      await seed(run);
      await become(run, IDS.county);
      await attempt(run, [`update public.incidents set site_id='${IDS.siteB}' where id='${INC_A2}'`]);
      await unbecome(run);
      expect(await val(run, `select site_id from public.incidents where id='${INC_A2}'`)).toBe(IDS.siteA);
    });
  });

  test("county supervisor cannot re-home a finding or corrective action to another county", async () => {
    await withRole("postgres", null, async (run) => {
      await seed(run);
      await run(`update public.profiles set role='supervisor' where id='${IDS.county}'`);
      await become(run, IDS.county);
      await attempt(run, [
        `update public.findings set site_id='${IDS.siteB}' where id='${IDS.findingA}'`,
        `update public.corrective_actions set site_id='${IDS.siteB}' where id='${IDS.caA}'`,
      ]);
      await unbecome(run);
      expect(await val(run, `select site_id from public.findings where id='${IDS.findingA}'`)).toBe(IDS.siteA);
      expect(await val(run, `select site_id from public.corrective_actions where id='${IDS.caA}'`)).toBe(IDS.siteA);
    });
  });
});

describe("E1: legitimate work is NOT broken", () => {
  test("county inspector still updates incidents in their own county", async () => {
    await withRole("postgres", null, async (run) => {
      await seed(run);
      await become(run, IDS.county);
      await run(`update public.incidents set status='investigating' where id='${INC_A2}'`);
      await unbecome(run);
      expect(await val(run, `select status from public.incidents where id='${INC_A2}'`)).toBe("investigating");
    });
  });

  test("an inspector still updates their OWN inspection in scope; not their own at an out-of-scope site", async () => {
    await withRole("postgres", null, async (run) => {
      await seed(run, IDS.county, IDS.county);
      await become(run, IDS.county);
      await attempt(run, [
        `update public.inspections set status='submitted' where id='${INSP_A}'`,
        `update public.inspections set status='submitted' where id='${INSP_B}'`,
      ]);
      await unbecome(run);
      expect(await val(run, `select status from public.inspections where id='${INSP_A}'`)).toBe("submitted");
      expect(await val(run, `select status from public.inspections where id='${INSP_B}'`)).toBe("draft");
    });
  });

  test("county supervisor still reviews findings and actions in their own county", async () => {
    await withRole("postgres", null, async (run) => {
      await seed(run);
      await run(`update public.profiles set role='supervisor' where id='${IDS.county}'`);
      await become(run, IDS.county);
      await run(`update public.findings set title='Reviewed' where id='${IDS.findingA}'`);
      await run(`update public.corrective_actions set description='Reviewed' where id='${IDS.caA}'`);
      await unbecome(run);
      expect(await val(run, `select title from public.findings where id='${IDS.findingA}'`)).toBe("Reviewed");
      expect(await val(run, `select description from public.corrective_actions where id='${IDS.caA}'`)).toBe("Reviewed");
    });
  });

  test("national supervisor and admin can still update across every county", async () => {
    for (const uid of [IDS.national, IDS.admin]) {
      await withRole("postgres", null, async (run) => {
        await seed(run);
        await become(run, uid);
        await attempt(run, [
          `update public.incidents set status='investigating' where id='${INC_B}'`,
          `update public.findings set title='Nat' where id='${IDS.findingB}'`,
          `update public.corrective_actions set description='Nat' where id='${CA_B}'`,
          `update public.environmental_observations set status='resolved' where id='${IDS.obsB}'`,
        ]);
        await unbecome(run);
        expect(await val(run, `select status from public.incidents where id='${INC_B}'`)).toBe("investigating");
        expect(await val(run, `select title from public.findings where id='${IDS.findingB}'`)).toBe("Nat");
        expect(await val(run, `select description from public.corrective_actions where id='${CA_B}'`)).toBe("Nat");
        expect(await val(run, `select status from public.environmental_observations where id='${IDS.obsB}'`)).toBe("resolved");
      });
    }
  });

  test("company operator A still cannot touch company B's incident or action", async () => {
    await withRole("postgres", null, async (run) => {
      await seed(run);
      await become(run, IDS.opA);
      await attempt(run, [
        `update public.incidents set description='TAMPERED'`,
        `update public.corrective_actions set description='TAMPERED'`,
      ]);
      await unbecome(run);
      expect(await val(run, `select description from public.incidents where id='${INC_B}'`)).toBe("ORIGINAL-B");
      expect(await val(run, `select description from public.corrective_actions where id='${CA_B}'`)).toBe("ORIGINAL-CA-B");
    });
  });

  test("a role-less account changes nothing", async () => {
    await withRole("postgres", null, async (run) => {
      await seed(run);
      await become(run, IDS.guest);
      await attempt(run, TABLES.flatMap((t) => attacks(t.table, t.set, t.id)));
      await unbecome(run);
      expect(await val(run, `select description from public.incidents where id='${INC_B}'`)).toBe("ORIGINAL-B");
      expect(await val(run, `select title from public.findings where id='${IDS.findingB}'`)).toBe("Tailings pond overtopping risk");
    });
  });
});

describe("E1: the policy shape itself (guards against silent regression)", () => {
  test("all five UPDATE policies require mg_can_access_site in USING and WITH CHECK", async () => {
    await withRole("postgres", null, async (run) => {
      const rows = await run(
        `select tablename, qual, with_check from pg_policies
          where schemaname='public' and cmd='UPDATE'
            and tablename in ('incidents','environmental_observations','findings','corrective_actions','inspections')`,
      );
      expect(rows.map((r) => r.tablename as string).sort()).toEqual([
        "corrective_actions",
        "environmental_observations",
        "findings",
        "incidents",
        "inspections",
      ]);
      for (const r of rows) {
        expect(String(r.qual), `${r.tablename} USING`).toContain("mg_can_access_site");
        expect(String(r.with_check), `${r.tablename} WITH CHECK`).toContain("mg_can_access_site");
      }
    });
  });

  test("no UPDATE policy on a site-bearing table is role-only (sweep)", async () => {
    await withRole("postgres", null, async (run) => {
      const rows = await run(
        `select p.tablename, p.qual
           from pg_policies p
           join information_schema.columns c
             on c.table_schema='public' and c.table_name=p.tablename and c.column_name='site_id'
          where p.schemaname='public' and p.cmd in ('UPDATE','ALL')`,
      );
      for (const r of rows) {
        expect(String(r.qual), `${r.tablename}: UPDATE policy must be site-scoped`).toMatch(
          /mg_can_access_site|mg_has_permission|site_assignments|organization_members|user_id|auth\.uid\(\)/,
        );
        // the specific role-only shapes that caused E1
        expect(String(r.qual).replace(/\s+/g, " ")).not.toBe("mg_is_staff()");
      }
    });
  });
});
