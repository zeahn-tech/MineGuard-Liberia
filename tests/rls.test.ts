// ---------------------------------------------------------------------------
// RLS ROLE MATRIX — per-role allow/deny assertions against a real Postgres (SEC-1/2/3 + SEC-5/SITE-1)
// seeded from supabase/migrations (docs/11 remediation prompt, Priority 1).
//
// Every case impersonates a Postgres role + JWT claims exactly the way
// PostgREST would, inside a transaction that is always rolled back:
//   anon            → no session
//   authenticated   → signed-in user (sub = profile id), RLS fully active
//   postgres        → only used to seed/inspect shared state
//
// Fixtures (tests/helpers/pglite-db.ts):
//   admin     — admin, national scope
//   opA       — operator "AgriLib Mining", site A (Bomi)
//   opB       — operator "OreCo Liberia",  site B (Grand Cape Mount)
//   county    — inspector scoped to county Bomi
//   national  — supervisor, national scope
//   guest     — authenticated account with NO role assigned
// ---------------------------------------------------------------------------

import { beforeAll, describe, expect, test } from "bun:test";
import {
  affectedRows,
  getFixture,
  IDS,
  withRole,
  type Runner,
} from "./helpers/pglite-db";

beforeAll(() => getFixture());

async function count(run: Runner, sql: string): Promise<number> {
  const rows = await run(sql);
  return Number(Object.values(rows[0])[0]);
}

/** Runs `sql`, returning the number of rows it affected/returned; a denial
 *  (RLS 42501 or a missing privilege) is reported as -1. Handles both scalar
 *  aggregate queries (`select count(*) …` — one row, one column) and bare
 *  row queries (`select 1 …` — the row count itself is the signal; an empty
 *  result means zero visible rows). */
async function countOrDenied(run: Runner, sql: string): Promise<number> {
  try {
    const rows = await run(sql);
    if (rows.length === 0) return 0;
    return Number(Object.values(rows[0])[0]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (
      msg.includes("row-level security") ||
      msg.includes("permission denied") ||
      // Guard-trigger refusals are denials too (they fire before/instead of
      // RLS depending on the statement) — anything else is a real error.
      msg.startsWith("FORBIDDEN") ||
      msg.startsWith("NOT_EDITABLE") ||
      msg.startsWith("NOT_REVIEWABLE") ||
      msg.startsWith("UNREGISTERED")
    ) {
      return -1;
    }
    throw e;
  }
}

describe("anonymous (no session)", () => {
  test("cannot read any domain table", async () => {
    const f = await getFixture();
    void f;
    await withRole("anon", null, async (run) => {
      for (const table of [
        "profiles",
        "sites",
        "inspection_templates",
        "inspections",
        "findings",
        "corrective_actions",
        "incidents",
        "environmental_observations",
        "community_reports",
        "evidence",
        "audit_log",
        "rate_limits",
      ]) {
        const visible = await countOrDenied(
          run,
          `select count(*) from public.${table}`,
        );
        expect(visible, `anon must not see rows in ${table}`).toBeLessThanOrEqual(0);
      }
    });
  });

  test("cannot write anything", async () => {
    await withRole("anon", null, async (run) => {
      for (const stmt of [
        `insert into public.sites (code, name, operator_name, county, created_by)
           values ('X','X','X','X', gen_random_uuid())`,
        `insert into public.community_reports (tracking_code, category, description, county)
           values ('CR-EVIL1','pollution','x','Bomi')`,
        `insert into public.profiles (id) values (gen_random_uuid())`,
        `insert into public.meta (key, value) values ('evil','{}'::jsonb)`,
      ]) {
        const affected = await countOrDenied(run, `${stmt} returning 1`);
        expect(affected, `anon write must be denied: ${stmt.slice(0, 40)}`)
          .toBeLessThanOrEqual(0);
      }
    });
  });

  test("can read the public mirrors (meta, report_tracking)", async () => {
    await withRole("anon", null, async (run) => {
      expect(await count(run, "select count(*) from public.meta")).toBe(1);
      expect(
        await count(run, "select count(*) from public.report_tracking"),
      ).toBe(1);
    });
  });
});

describe("guest (authenticated, no assigned role)", () => {
  test("sees only their own profile row", async () => {
    const f = await getFixture();
    await withRole(
      "authenticated",
      { sub: f.guest, role: "authenticated" },
      async (run) => {
        const rows = await run("select id from public.profiles");
        expect(rows.length).toBe(1);
        expect(rows[0].id).toBe(f.guest);
      },
    );
  });

  test("sees no operational data at all", async () => {
    const f = await getFixture();
    await withRole(
      "authenticated",
      { sub: f.guest, role: "authenticated" },
      async (run) => {
        for (const table of [
          "sites",
          "inspection_templates",
          "inspections",
          "findings",
          "corrective_actions",
          "incidents",
          "environmental_observations",
          "community_reports",
          "evidence",
          "audit_log",
        ]) {
          const visible = await count(
            run,
            `select count(*) from public.${table}`,
          );
          expect(visible, `guest must not see rows in ${table}`).toBe(0);
        }
      },
    );
    void f;
  });

  test("cannot upload evidence storage objects (no assigned role)", async () => {
    const f = await getFixture();
    await withRole(
      "authenticated",
      { sub: f.guest, role: "authenticated" },
      async (run) => {
        const affected = await countOrDenied(
          run,
          `insert into storage.objects (bucket_id, name, owner)
             values ('evidence', '${f.guest}/x.jpg', '${f.guest}') returning 1`,
        );
        expect(affected).toBeLessThanOrEqual(0);
      },
    );
  });
});

describe("operator (tenant-locked)", () => {
  test("sees only their own operator's site and records", async () => {
    const f = await getFixture();
    await withRole(
      "authenticated",
      { sub: f.opA, role: "authenticated" },
      async (run) => {
        const sites = await run("select id from public.sites");
        expect(sites.length).toBe(1);
        expect(sites[0].id).toBe(f.siteA);

        expect(await count(run, "select count(*) from public.findings")).toBe(1);
        expect(
          await count(run, "select count(*) from public.corrective_actions"),
        ).toBe(1);
        expect(await count(run, "select count(*) from public.incidents")).toBe(1);
        expect(
          await count(run, "select count(*) from public.environmental_observations"),
        ).toBe(0); // site B belongs to the other tenant
        expect(await count(run, "select count(*) from public.evidence")).toBe(1);
        expect(await count(run, "select count(*) from public.profiles")).toBe(1);
      },
    );
  });

  test("site-B rows are invisible and unwritable", async () => {
    const f = await getFixture();
    await withRole(
      "authenticated",
      { sub: f.opA, role: "authenticated" },
      async (run) => {
        expect(
          await count(
            run,
            `select count(*) from public.findings where site_id = '${f.siteB}'`,
          ),
        ).toBe(0);

        // Direct update against site-B row: 0 rows touched (RLS USING).
        const updated = await affectedRows(
          run,
          `update public.findings set status = 'acknowledged'
            where id = '${f.findingB}' returning 1`,
        );
        expect(updated).toBe(0);

        // Insert at a foreign site: RLS WITH CHECK denies it.
        const inserted = await countOrDenied(
          run,
          `insert into public.findings (inspection_id, site_id, title, severity, created_by_id)
             values ('${f.inspection}', '${f.siteB}', 'evil', 'low', '${f.opA}')
             returning 1`,
        );
        expect(inserted).toBeLessThanOrEqual(0);
      },
    );
  });

  test("can file an incident at their own site", async () => {
    const f = await getFixture();
    await withRole(
      "authenticated",
      { sub: f.opA, role: "authenticated" },
      async (run) => {
        const inserted = await count(
          run,
          `insert into public.incidents (site_id, type, severity, description,
              occurred_at, reported_by_id, report_source)
             values ('${f.siteA}', 'injury', 'medium', 'sprained ankle',
              now(), '${f.opA}', 'operator')
             returning 1`,
        );
        expect(inserted).toBe(1);
      },
    );
  });

  test("can acknowledge but not resolve a finding (guard trigger §13)", async () => {
    const f = await getFixture();
    await withRole(
      "authenticated",
      { sub: f.opA, role: "authenticated" },
      async (run) => {
        const acked = await count(
          run,
          `update public.findings set status = 'acknowledged'
            where id = '${f.findingA}' returning 1`,
        );
        expect(acked).toBe(1);

        let message = "";
        try {
          await run(
            `update public.findings set status = 'resolved'
              where id = '${f.findingA}'`,
          );
        } catch (e) {
          message = e instanceof Error ? e.message : String(e);
        }
        expect(message).toContain("FORBIDDEN");
      },
    );
  });

  test("cannot delete sites (DELETE revoked; registry is lifecycle-only)", async () => {
    const f = await getFixture();
    await withRole(
      "authenticated",
      { sub: f.opA, role: "authenticated" },
      async (run) => {
        // SEC-3 (migration 0009): the privilege layer refuses before RLS or
        // the sites guard are ever consulted.
        let message = "";
        try {
          await run(`delete from public.sites where id = '${f.siteA}' returning 1`);
        } catch (e) {
          message = e instanceof Error ? e.message : String(e);
        }
        expect(message).toContain("permission denied for table sites");
      },
    );
  });
});

describe("county-scoped inspector", () => {
  test("sees only sites and records in their county", async () => {
    const f = await getFixture();
    await withRole(
      "authenticated",
      { sub: f.county, role: "authenticated" },
      async (run) => {
        const sites = await run("select id from public.sites");
        expect(sites.length).toBe(1);
        expect(sites[0].id).toBe(f.siteA); // Bomi; Grand Cape Mount invisible

        expect(await count(run, "select count(*) from public.findings")).toBe(1);
        expect(
          await count(run, "select count(*) from public.incidents"),
        ).toBe(1);
        expect(
          await count(run, "select count(*) from public.environmental_observations"),
        ).toBe(0);
      },
    );
  });
});

describe("national supervisor (staff)", () => {
  test("sees every site and record", async () => {
    await withRole(
      "authenticated",
      { sub: (await getFixture()).national, role: "authenticated" },
      async (run) => {
        expect(await count(run, "select count(*) from public.sites")).toBe(2);
        expect(await count(run, "select count(*) from public.findings")).toBe(2);
        expect(await count(run, "select count(*) from public.incidents")).toBe(1);
        expect(
          await count(run, "select count(*) from public.environmental_observations"),
        ).toBe(1);
        expect(
          await count(run, "select count(*) from public.community_reports"),
        ).toBe(1);
        // Directory read is self-or-admin by design (0003): a non-admin
        // staff account sees exactly one profile — their own.
        expect(await count(run, "select count(*) from public.profiles")).toBe(1);
        // Staff read of audit_log. Since 0009 every seeded mutation has
        // produced a server-written row (mg_audit_row triggers), so the
        // trail is well past the single hand-written seed row.
        expect(await count(run, "select count(*) from public.audit_log")).toBeGreaterThan(1);
      },
    );
  });

  test("audit_log is closed to clients: no insert/update/delete path exists", async () => {
    // SEC-1 (migration 0009): "audit append" dropped + client write grants
    // revoked — every write fails at the privilege layer, for staff too.
    await withRole(
      "authenticated",
      { sub: (await getFixture()).national, role: "authenticated" },
      async (run) => {
        for (const stmt of [
          `update public.audit_log set summary = 'tampered'`,
          `delete from public.audit_log`,
          `insert into public.audit_log (actor_label, action, entity_type, summary)
             values ('Mallory', 'forged.action', 'audit_log', 'forged entry')`,
        ]) {
          let message = "";
          try {
            await run(`${stmt} returning 1`);
          } catch (e) {
            message = e instanceof Error ? e.message : String(e);
          }
          expect(message, stmt.trim().slice(0, 48)).toContain(
            "permission denied for table audit_log",
          );
        }
      },
    );
  });
});

describe("admin", () => {
  test("sees everything, including the full directory", async () => {
    const f = await getFixture();
    await withRole(
      "authenticated",
      { sub: f.admin, role: "authenticated" },
      async (run) => {
        expect(await count(run, "select count(*) from public.profiles")).toBe(6);
        expect(await count(run, "select count(*) from public.sites")).toBe(2);
        expect(await count(run, "select count(*) from public.findings")).toBe(2);
      },
    );
  });

  test("cannot delete a site even as admin (guard trigger)", async () => {
    const f = await getFixture();
    await withRole(
      "authenticated",
      { sub: f.admin, role: "authenticated" },
      async (run) => {
        // Either RLS silently matches nothing (no delete policy) or the
        // sites_guard trigger raises — a delete must never succeed.
        const deleted = await affectedRows(
          run,
          `delete from public.sites where id = '${f.siteA}' returning 1`,
        ).catch(() => -1);
        expect(deleted).toBeLessThanOrEqual(0);
      },
    );
  });

  test("cannot read rate_limits (definer-only table)", async () => {
    const f = await getFixture();
    await withRole(
      "authenticated",
      { sub: f.admin, role: "authenticated" },
      async (run) => {
        expect(await count(run, "select count(*) from public.rate_limits")).toBe(0);
      },
    );
  });
});

describe("evidence storage policies", () => {
  test("owner can upload into own namespace; nobody into someone else's", async () => {
    const f = await getFixture();
    await withRole(
      "authenticated",
      { sub: f.opA, role: "authenticated" },
      async (run) => {
        const own = await count(
          run,
          `insert into storage.objects (bucket_id, name, owner)
             values ('evidence', '${f.opA}/aaaa.jpg', '${f.opA}') returning 1`,
        );
        expect(own).toBe(1);

        const foreign = await countOrDenied(
          run,
          `insert into storage.objects (bucket_id, name, owner)
             values ('evidence', '${f.opB}/stolen.jpg', '${f.opB}') returning 1`,
        );
        expect(foreign).toBeLessThanOrEqual(0);
      },
    );
  });

  test("read requires a visible evidence metadata row (tenant-checked join)", async () => {
    const f = await getFixture();
    const path = `${f.opA}/${f.evidenceA}__haul-road.jpg`;

    // Owner + site tenant: visible (metadata row belongs to site A).
    await withRole(
      "authenticated",
      { sub: f.opA, role: "authenticated" },
      async (run) => {
        expect(
          await count(
            run,
            `select 1 from storage.objects where bucket_id = 'evidence' and name = '${path}'`,
          ),
        ).toBe(1);
      },
    );

    // Other tenant: no visible metadata row ⇒ object invisible.
    await withRole(
      "authenticated",
      { sub: f.opB, role: "authenticated" },
      async (run) => {
        expect(
          await affectedRows(
            run,
            `select 1 from storage.objects where bucket_id = 'evidence' and name = '${path}'`,
          ),
        ).toBe(0);
      },
    );

    // Anonymous: no session ⇒ nothing.
    await withRole("anon", null, async (run) => {
      expect(
        await countOrDenied(
          run,
          `select 1 from storage.objects where bucket_id = 'evidence'`,
        ),
      ).toBeLessThanOrEqual(0);
    });
  });

  test("owner may overwrite their own object (retry path); others may not", async () => {
    const f = await getFixture();
    const path = `${f.opA}/${f.evidenceA}__haul-road.jpg`;

    await withRole(
      "authenticated",
      { sub: f.opA, role: "authenticated" },
      async (run) => {
        expect(
          await count(
            run,
            `update storage.objects set name = name
              where bucket_id = 'evidence' and name = '${path}' returning 1`,
          ),
        ).toBe(1);
      },
    );

    await withRole(
      "authenticated",
      { sub: f.opB, role: "authenticated" },
      async (run) => {
        expect(
          await affectedRows(
            run,
            `update storage.objects set name = 'hijacked'
              where bucket_id = 'evidence' and name = '${path}' returning 1`,
          ),
        ).toBe(0);
      },
    );
  });

  test("no delete policy: evidence objects are never deletable by clients", async () => {
    const f = await getFixture();
    await withRole(
      "authenticated",
      { sub: f.opA, role: "authenticated" },
      async (run) => {
        expect(
          await affectedRows(
            run,
            `delete from storage.objects
              where bucket_id = 'evidence'
                and name = '${f.opA}/${f.evidenceA}__haul-road.jpg'
              returning 1`,
          ),
        ).toBe(0);
      },
    );
  });
});

// ===========================================================================
// SEC-1/2/3 — audit & integrity foundation (migration 0009).
//
// Acceptance for the security roadmap's Session 1:
//   * forged audit insert fails for EVERY client role
//   * every mutation produces exactly one server-written audit row (actor
//     from the session, before/after diff) with no client logging involved
//   * no DELETE succeeds for any client role — archive/status instead
//   * row_version increments; spoofed row_version/updated_by are overwritten
// ===========================================================================

const CLIENT_IDENTITIES: Array<
  ["anon" | "authenticated", Record<string, unknown> | null]
> = [
  ["anon", null],
  ["authenticated", { sub: IDS.admin, role: "authenticated" }],
  ["authenticated", { sub: IDS.opA, role: "authenticated" }],
  ["authenticated", { sub: IDS.county, role: "authenticated" }],
  ["authenticated", { sub: IDS.national, role: "authenticated" }],
  ["authenticated", { sub: IDS.guest, role: "authenticated" }],
];

/** PGlite decodes jsonb columns into JS objects already; be liberal about
 *  strings too so the same helper works against any driver shape. */
function j(v: unknown): Record<string, unknown> {
  if (typeof v === "string") return JSON.parse(v) as Record<string, unknown>;
  return v as Record<string, unknown>;
}

describe("SEC-1: the audit trail is written only by the server", () => {
  test("forged audit insert fails for every client role", async () => {
    const f = await getFixture();
    for (const [role, claims] of CLIENT_IDENTITIES) {
      await withRole(role, claims, async (run) => {
        let message = "";
        try {
          await run(
            `insert into public.audit_log (actor_id, actor_label, action, entity_type, entity_id, summary)
               values ('${f.admin}', 'Mallory', 'forged.action', 'sites', null, 'forged entry')
               returning 1`,
          );
        } catch (e) {
          message = e instanceof Error ? e.message : String(e);
        }
        expect(
          message,
          `forged audit insert must fail for ${role} ${JSON.stringify(claims)}`,
        ).toContain("permission denied for table audit_log");
      });
    }
  });

  test("exactly one server-written audit row per mutation, actor = session user", async () => {
    const f = await getFixture();
    // The client never writes the log (logAudit is a console breadcrumb),
    // so this doubles as the "client crashes" proof: the rows below exist
    // purely because the mutations committed — atomically, same transaction.
    await withRole(
      "authenticated",
      { sub: f.admin, role: "authenticated" },
      async (run) => {
        const [created] = await run(
          `insert into public.sites (code, name, operator_name, county, created_by)
             values ('LB-AUDIT-PROBE', 'Audit probe', 'AgriLib Mining', 'Bomi', '${f.admin}')
             returning id, row_version, updated_by`,
        );
        // SEC-2: INSERT stamps are server-written, not client-supplied.
        expect(Number(created.row_version)).toBe(1);
        expect(created.updated_by).toBe(f.admin);
        const siteId = String(created.id);

        await run(`update public.sites set notes = 'first touch' where id = '${siteId}'`);
        // Spoof attempt: the client sends its own row_version and actor —
        // both must be overwritten by the server.
        await run(
          `update public.sites set notes = 'second touch', row_version = 77,
                  updated_by = '${f.opB}'
            where id = '${siteId}'`,
        );

        // Read the trail as superuser (no persona-scoping interference).
        await run("set local role postgres");
        const insertRows = await run(
          `select actor_id, actor_label, entity_type, details from public.audit_log
            where action = 'sites.insert' and entity_id = '${siteId}'`,
        );
        expect(insertRows.length).toBe(1);
        expect(insertRows[0].actor_id).toBe(f.admin);
        expect(insertRows[0].entity_type).toBe("sites");
        expect(
          j(insertRows[0].details).after,
        ).toMatchObject({ code: "LB-AUDIT-PROBE" });

        const updateRows = await run(
          `select actor_id, details from public.audit_log
            where action = 'sites.update' and entity_id = '${siteId}'`,
        );
        // Exactly one row per UPDATE statement — no more, no fewer.
        expect(updateRows.length).toBe(2);
        expect(updateRows.every((r) => r.actor_id === f.admin)).toBe(true);
        const diffs = updateRows
          .map((r) => j(r.details))
          .map((d) => `${d.before.notes} -> ${d.after.notes}`)
          .sort();
        expect(diffs).toEqual([
          "first touch -> second touch",
          "null -> first touch",
        ]);

        const [row] = await run(
          `select row_version, updated_by, updated_at, notes
             from public.sites where id = '${siteId}'`,
        );
        expect(Number(row.row_version)).toBe(3); // 1 + two updates; 77 ignored
        expect(row.updated_by).toBe(f.admin);    // spoofed opB ignored
        expect(row.updated_at).not.toBeNull();
        expect(row.notes).toBe("second touch");
      },
    );
  });

  test("status transitions land in the before/after diff", async () => {
    const f = await getFixture();
    await withRole(
      "authenticated",
      { sub: f.admin, role: "authenticated" },
      async (run) => {
        const [site] = await run(
          `insert into public.sites (code, name, operator_name, county, created_by)
             values ('LB-STATUS-PROBE', 'Status probe', 'AgriLib Mining', 'Bomi', '${f.admin}')
             returning id, status`,
        );
        const siteId = String(site.id);
        await run(
          `update public.sites set status = 'active' where id = '${siteId}'`,
        );

        await run("set local role postgres");
        const rows = await run(
          `select summary, details from public.audit_log
            where action = 'sites.update' and entity_id = '${siteId}'
              and details -> 'after' ->> 'status' is not null`,
        );
        expect(rows.length).toBe(1);
        expect(String(rows[0].summary)).toContain(
          `status: ${site.status} -> active`,
        );
        const d = j(rows[0].details);
        expect(d.before.status).toBe(site.status);
        expect(d.after.status).toBe("active");
      },
    );
  });
});

describe("SEC-2/3: no client role can DELETE — lifecycle only", () => {
  test("DELETE is refused at the privilege layer for anon and every persona", async () => {
    const tables = [
      "profiles",
      "sites",
      "inspection_templates",
      "inspections",
      "findings",
      "corrective_actions",
      "incidents",
      "environmental_observations",
      "community_reports",
      "evidence",
      "audit_log",
      "meta",
      "report_tracking",
      "rate_limits",
    ];
    for (const [role, claims] of CLIENT_IDENTITIES) {
      await withRole(role, claims, async (run) => {
        for (const table of tables) {
          let message = "";
          try {
            await run(`delete from public.${table} returning 1`);
          } catch (e) {
            message = e instanceof Error ? e.message : String(e);
          }
          expect(message, `DELETE ${table} must fail for ${role}`).toContain(
            `permission denied for table ${table}`,
          );
        }
      });
    }
  });

  test("even an admin cannot delete a template — archive is the lifecycle", async () => {
    const f = await getFixture();
    await withRole(
      "authenticated",
      { sub: f.admin, role: "authenticated" },
      async (run) => {
        let message = "";
        try {
          await run(
            `delete from public.inspection_templates where id = '${f.template}' returning 1`,
          );
        } catch (e) {
          message = e instanceof Error ? e.message : String(e);
        }
        // Privilege revoke first; behind it the guard refuses with
        // ARCHIVE_ONLY (belt and braces — neither path deletes).
        expect(message).toContain(
          "permission denied for table inspection_templates",
        );

        // The sanctioned lifecycle path: archive via UPDATE.
        const archived = await run(
          `update public.inspection_templates
              set archived_at = now()
            where id = '${f.template}' returning row_version, updated_by`,
        );
        expect(archived.length).toBe(1);
        expect(Number(archived[0].row_version)).toBe(2);
        expect(archived[0].updated_by).toBe(f.admin);
      },
    );
  });
});

// ===========================================================================
// SEC-5 / SITE-1 — tenancy keyed on organization UUIDs (migration 0010).
//
// Acceptance for the security roadmap's Session 2:
//   * renamed operator → isolation unchanged (organization_id), display follows
//   * same-name operators → distinct tenants
//   * site-scoped staff → exactly the assigned site; none assigned → nothing
//   * cross-county / cross-tenant reads and writes stay denied
//   * no behaviour regression: every pre-0010 persona keeps its access
//
// Every case runs inside withRole's always-rolled-back transaction, so the
// shared fixture stays byte-identical for the suites that follow.
// ===========================================================================
describe("SEC-5/SITE-1: tenancy on organization UUIDs (0010)", () => {
  /** Mid-transaction identity swap: re-points request.jwt.claims so ONE
   *  rolled-back transaction can read as a second persona. */
  function claims(sub: string): string {
    return `set local request.jwt.claims = '${JSON.stringify({ sub, role: "authenticated" })}'`;
  }

  test("renamed operator: isolation keys on organization_id, display follows", async () => {
    const f = await getFixture();
    await withRole(
      "authenticated",
      { sub: f.admin, role: "authenticated" },
      async (run) => {
        const [site] = await run(
          `select organization_id, operator_name from public.sites where id = '${f.siteA}'`,
        );
        expect(site.organization_id).not.toBeNull();
        expect(site.operator_name).toBe("AgriLib Mining");
        const orgId = String(site.organization_id);

        // The admin renames the tenant in the registry…
        const renamed = await run(
          `update public.organizations set name = 'AgriLib Renamed Ltd'
            where id = '${orgId}' returning id`,
        );
        expect(renamed.length).toBe(1);

        // …the display mirror cascades onto every bound row…
        const [siteAfter] = await run(
          `select operator_name from public.sites where id = '${f.siteA}'`,
        );
        expect(siteAfter.operator_name).toBe("AgriLib Renamed Ltd");
        const [profileAfter] = await run(
          `select operator_name, organization_id from public.profiles where id = '${f.opA}'`,
        );
        expect(profileAfter.operator_name).toBe("AgriLib Renamed Ltd");
        expect(String(profileAfter.organization_id)).toBe(orgId); // key untouched
        const [sibling] = await run(
          `select operator_name from public.sites where id = '${f.siteB}'`,
        );
        expect(sibling.operator_name).toBe("OreCo Liberia"); // other tenant untouched

        // …and the rename lands in the audit trail as a server-written diff.
        await run("set local role postgres");
        const audit = await run(
          `select actor_id, details from public.audit_log
            where action = 'organizations.update' and entity_id = '${orgId}'`,
        );
        const renames = audit.filter(
          (r) => j(r.details).after?.name === "AgriLib Renamed Ltd",
        );
        expect(renames.length).toBeGreaterThanOrEqual(1);
        expect(renames[0].actor_id).toBe(f.admin);
        expect(j(renames[0].details).before?.name).toBe("AgriLib Mining");

        // Isolation is unchanged: the operator still sees exactly the own
        // tenant — keyed by UUID, not by the (now different) display name.
        await run("set local role authenticated");
        await run(claims(f.opA));
        const opASites = await run("select id from public.sites");
        expect(opASites.map((r) => String(r.id))).toEqual([f.siteA]);
        const opAOrgs = await run("select id from public.organizations");
        expect(opAOrgs.map((r) => String(r.id))).toEqual([orgId]);
      },
    );
  });

  test("same-name operators are distinct tenants (isolation keys on the UUID)", async () => {
    const f = await getFixture();
    await withRole(
      "authenticated",
      { sub: f.admin, role: "authenticated" },
      async (run) => {
        // Two registry entries deliberately sharing one display name…
        const [o1] = await run(
          `insert into public.organizations (name) values ('Twin Mining') returning id`,
        );
        const [o2] = await run(
          `insert into public.organizations (name) values ('Twin Mining') returning id`,
        );
        expect(String(o1.id)).not.toBe(String(o2.id));

        // …bound to the fixture tenants. `name` is display only from here.
        await run(
          `update public.sites set organization_id = '${o1.id}' where id = '${f.siteA}'`,
        );
        await run(
          `update public.sites set organization_id = '${o2.id}' where id = '${f.siteB}'`,
        );
        await run(
          `update public.profiles set organization_id = '${o1.id}' where id = '${f.opA}'`,
        );
        await run(
          `update public.profiles set organization_id = '${o2.id}' where id = '${f.opB}'`,
        );

        // Both sites now carry the SAME display string…
        const displays = await run(
          `select distinct operator_name from public.sites`,
        );
        expect(displays.map((r) => r.operator_name)).toEqual(["Twin Mining"]);

        // …yet each operator sees exactly its own tenant, and the registry
        // itself is scoped: one organization visible, never the sibling.
        await run(claims(f.opA));
        const aSites = await run("select id from public.sites");
        expect(aSites.map((r) => String(r.id))).toEqual([f.siteA]);
        const aOrgs = await run("select id from public.organizations");
        expect(aOrgs.map((r) => String(r.id))).toEqual([String(o1.id)]);

        await run(claims(f.opB));
        const bSites = await run("select id from public.sites");
        expect(bSites.map((r) => String(r.id))).toEqual([f.siteB]);
        const bOrgs = await run("select id from public.organizations");
        expect(bOrgs.map((r) => String(r.id))).toEqual([String(o2.id)]);
      },
    );
  });

  test("scope='site' staff: exactly the assigned sites, nothing with no assignment", async () => {
    const f = await getFixture();
    await withRole(
      "authenticated",
      { sub: f.admin, role: "authenticated" },
      async (run) => {
        // The county inspector is re-scoped to explicit site membership…
        await run(
          `update public.profiles set scope = 'site' where id = '${f.county}'`,
        );

        // …and with no assignment recorded sees NO sites at all.
        await run(claims(f.county));
        expect(await count(run, "select count(*) from public.sites")).toBe(0);

        // One grant → exactly that site.
        await run(claims(f.admin));
        await run(
          `insert into public.site_assignments (user_id, site_id, assigned_by)
            values ('${f.county}', '${f.siteA}', '${f.admin}')`,
        );
        await run(claims(f.county));
        const one = await run("select id from public.sites");
        expect(one.map((r) => String(r.id))).toEqual([f.siteA]);

        // A second grant extends the visible set; the unique index refuses
        // a duplicate (user, site) pair outright.
        await run(claims(f.admin));
        await run(
          `insert into public.site_assignments (user_id, site_id, assigned_by)
            values ('${f.county}', '${f.siteB}', '${f.admin}')`,
        );
        let dupMsg = "";
        try {
          await run(
            `insert into public.site_assignments (user_id, site_id)
              values ('${f.county}', '${f.siteA}') returning 1`,
          );
        } catch (e) {
          dupMsg = e instanceof Error ? e.message : String(e);
        }
        expect(dupMsg).toContain("duplicate key");

        await run(claims(f.county));
        const both = await run("select id from public.sites order by id");
        expect(both.map((r) => String(r.id))).toEqual([f.siteA, f.siteB]);
      },
    );
  });

  test("cross-county and cross-tenant writes stay denied under the UUID matrix", async () => {
    const f = await getFixture();
    // Operator A: site B is invisible (read AND write), and the own site's
    // registry row is not writable either — operators hold no sites.update.
    await withRole(
      "authenticated",
      { sub: f.opA, role: "authenticated" },
      async (run) => {
        expect(
          await affectedRows(
            run,
            `update public.sites set notes = 'probe' where id = '${f.siteB}' returning 1`,
          ),
        ).toBe(0);
        expect(
          await affectedRows(
            run,
            `update public.sites set notes = 'probe' where id = '${f.siteA}' returning 1`,
          ),
        ).toBe(0);
        expect(
          await countOrDenied(
            run,
            `insert into public.sites (code, name, operator_name, county, created_by)
               values ('LB-EVIL','Evil','Twin Mining','Bomi','${f.opA}') returning 1`,
          ),
        ).toBeLessThanOrEqual(0);

        // Moving an own row into the foreign tenant is refused — WITH CHECK
        // or the row guard, whichever reaches the statement first.
        let message = "";
        try {
          await run(
            `update public.findings set site_id = '${f.siteB}'
              where id = '${f.findingA}' returning 1`,
          );
        } catch (e) {
          message = e instanceof Error ? e.message : String(e);
        }
        expect(message).toMatch(/row-level security|FORBIDDEN/);
      },
    );

    // County inspector: the other county's site is neither read nor written.
    await withRole(
      "authenticated",
      { sub: f.county, role: "authenticated" },
      async (run) => {
        expect(
          await count(run, `select count(*) from public.sites where id = '${f.siteB}'`),
        ).toBe(0);
        expect(
          await affectedRows(
            run,
            `update public.sites set notes = 'probe' where id = '${f.siteB}' returning 1`,
          ),
        ).toBe(0);
      },
    );
  });

  test("the permission matrix drives the site guard — deleting an admin's row revokes the capability", async () => {
    const f = await getFixture();
    await withRole("postgres", null, async (run) => {
      // Baseline: the admin holds sites.update and the write lands.
      await run("set local role authenticated");
      await run(claims(f.admin));
      const before = await run(
        `select public.mg_has_permission('sites.update') as v`,
      );
      expect(before[0].v).toBe(true);
      expect(
        await affectedRows(
          run,
          `update public.sites set notes = 'matrix probe'
            where id = '${f.siteA}' returning 1`,
        ),
      ).toBe(1);

      // Revoke the single matrix row (the matrix is migration-managed,
      // so only direct database maintenance can delete it)…
      await run("set local role postgres");
      const deleted = await run(
        `delete from public.permissions
          where role = 'admin' and permission = 'sites.update' returning 1`,
      );
      expect(deleted.length).toBe(1);

      // …and the SAME admin session instantly loses the capability: the
      // helper returns false, the policy filters the row away, and new
      // writes are refused at WITH CHECK — all without editing policy SQL.
      await run("set local role authenticated");
      await run(claims(f.admin));
      const after = await run(
        `select public.mg_has_permission('sites.update') as v`,
      );
      expect(after[0].v).toBe(false);
      expect(
        await affectedRows(
          run,
          `update public.sites set notes = 'matrix probe 2'
            where id = '${f.siteA}' returning 1`,
        ),
      ).toBe(0);
      let message = "";
      try {
        await run(
          `insert into public.sites (code, name, operator_name, county, created_by)
             values ('LB-PERM-PROBE','Perm probe','AgriLib Mining','Bomi','${f.admin}')
             returning 1`,
        );
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      expect(message).toContain("row-level security");
      await run("set local role postgres");
    });
  });

  test("the seeded role → permission matrix is what the policies consume", async () => {
    const f = await getFixture();
    const matrix: Array<{ sub: string; expect: Record<string, boolean> }> = [
      {
        sub: f.admin,
        expect: {
          "sites.update": true,
          "organizations.write": true,
          "audit.read": true,
          "records.submit": false,
        },
      },
      {
        sub: f.national,
        expect: { "sites.update": false, "reports.triage": true, "audit.read": true },
      },
      {
        sub: f.county,
        expect: { "audit.read": true, "records.status": true, "sites.update": false },
      },
      {
        sub: f.opA,
        expect: {
          "records.submit": true,
          "audit.read": false,
          "sites.update": false,
          "organizations.write": false,
        },
      },
      // No assigned role → mg_profile() is role-less → no matrix rows.
      { sub: f.guest, expect: { "audit.read": false, "sites.update": false } },
    ];
    for (const persona of matrix) {
      await withRole(
        "authenticated",
        { sub: persona.sub, role: "authenticated" },
        async (run) => {
          for (const [permission, wanted] of Object.entries(persona.expect)) {
            const got = await run(
              `select public.mg_has_permission('${permission}') as v`,
            );
            expect(got[0].v, `${persona.sub} / ${permission}`).toBe(wanted);
          }
        },
      );
    }
  });

  test("no behaviour regression: every pre-0010 persona keeps its access", async () => {
    const f = await getFixture();
    const expected: Array<{
      role: "anon" | "authenticated";
      claims: Record<string, unknown> | null;
      sites: number; // -1 = privilege-denied at the grant layer
    }> = [
      { role: "anon", claims: null, sites: -1 },
      { role: "authenticated", claims: { sub: f.guest, role: "authenticated" }, sites: 0 },
      { role: "authenticated", claims: { sub: f.opA, role: "authenticated" }, sites: 1 },
      { role: "authenticated", claims: { sub: f.opB, role: "authenticated" }, sites: 1 },
      { role: "authenticated", claims: { sub: f.county, role: "authenticated" }, sites: 1 },
      { role: "authenticated", claims: { sub: f.national, role: "authenticated" }, sites: 2 },
      { role: "authenticated", claims: { sub: f.admin, role: "authenticated" }, sites: 2 },
    ];
    for (const persona of expected) {
      await withRole(persona.role, persona.claims, async (run) => {
        const seen = await countOrDenied(run, "select count(*) from public.sites");
        expect(seen, `sites visible to ${JSON.stringify(persona.claims)}`).toBe(
          persona.sites,
        );
      });
    }
  });
});
