// ---------------------------------------------------------------------------
// Migration 0061 finishes three constraints production still carried half-done: community_reports_len_chk (NOT VALID),
// rate_limits.window_start (nullable) and audit_log_actor_id_fkey (absent, with orphaned actor ids). Production's state is
// rebuilt on a clean build; 0061 is applied; the full schema fingerprint must equal the clean build again.
// Every scenario rolls back.
// ---------------------------------------------------------------------------
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS, PLATFORM_STUB } from "./helpers/pglite-db";

// A PRIVATE database: other suites (migration-apply) re-apply older migrations on the shared one, which leaves
// community_reports_len_chk in its pre-0061 NOT VALID state and makes a "clean build" baseline order-dependent.
const root = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const FINGERPRINT = read("supabase/checks/schema_fingerprint.sql");
const mig = read("supabase/migrations/0061_validate_remaining_constraints.sql").replace(/^begin;$/m, "").replace(/^commit;$/m, "");
let db: PGlite;
beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto, pg_trgm } });
  await db.exec(PLATFORM_STUB);
  for (const f of MIGRATIONS) await db.exec(read(`supabase/migrations/${f}`)); // all migrations, 0061 included
  await db.exec(`insert into public.community_reports (id, tracking_code, category, description, county, status)
    values ('99999999-0000-4000-8000-000000000010', 'CR-TEST0001', 'pollution', 'Brown water near the wash plant', 'Bomi', 'submitted')`);
});
afterAll(async () => { await db.close(); });
const exec = async (sql: string) => void (await db.exec(sql));
const q = async (sql: string) => ((await db.query(sql)).rows as Record<string, unknown>[]);
/** Run a scenario inside a transaction that is always rolled back. */
const scenario = async (fn: () => Promise<void>) => {
  await db.exec("begin");
  try { await fn(); } finally { await db.exec("rollback"); }
};
const fp = async () => (await q(FINGERPRINT)) as { kind: string; obj: string; h: string }[];
const key = (r: { kind: string; obj: string }) => `${r.kind}|${r.obj}`;
const diff = (a: { kind: string; obj: string; h: string }[], b: { kind: string; obj: string; h: string }[]) => {
  const m = new Map(a.map((r) => [key(r), r.h])), n = new Map(b.map((r) => [key(r), r.h]));
  return { changed: b.filter((r) => m.has(key(r)) && m.get(key(r)) !== r.h).map(key), added: b.filter((r) => !m.has(key(r))).map(key), removed: a.filter((r) => !n.has(key(r))).map(key) };
};
const GHOST_A = "ffffffff-0000-4000-8000-0000000000a1";
const GHOST_B = "ffffffff-0000-4000-8000-0000000000a2";

// production's state: len_chk NOT VALID, window_start nullable, no actor foreign key, audit rows whose actor no longer exists
const PRODUCTION_STATE = `
alter table public.community_reports drop constraint community_reports_len_chk;
-- production's real form: the same rule written flat (no BETWEEN), NOT VALID
alter table public.community_reports add constraint community_reports_len_chk check (
  char_length(description) >= 1 and char_length(description) <= 5000 and char_length(county) <= 100
  and (district is null or char_length(district) <= 200) and (community is null or char_length(community) <= 200)
  and (contact_phone is null or char_length(contact_phone) <= 32)) not valid;
alter table public.rate_limits alter column window_start drop not null;
alter table public.audit_log drop constraint audit_log_actor_id_fkey;
insert into public.audit_log (actor_id, actor_label, action, entity_type, entity_id, summary, details)
  values ('${GHOST_A}', 'Deleted Person A', 'test.action', 'test', 'x1', 'orphan one', '{}'::jsonb),
         ('${GHOST_B}', 'Deleted Person B', 'test.action', 'test', 'x2', 'orphan two', '{}'::jsonb);
`;

describe("0061 — the remaining constraints", () => {
  test("production's half-done constraints, then 0061, converge the whole schema fingerprint back to the clean build", async () => {
    await scenario(async () => {
      const clean = await fp();
      await exec(PRODUCTION_STATE);
      const drifted = diff(clean, await fp());
      expect(drifted.changed).toContain("constraint|community_reports.community_reports_len_chk");
      expect(drifted.changed).toContain("column|rate_limits.window_start");
      expect(drifted.removed).toContain("constraint|audit_log.audit_log_actor_id_fkey");

      await exec(mig);
      expect(diff(clean, await fp())).toEqual({ changed: [], added: [], removed: [] });
    });
  });

  test("orphaned actor ids are detached (the rows and their labels are kept) and a dangling actor can no longer be created", async () => {
    await scenario(async () => {
      await exec(PRODUCTION_STATE);
      const before = Number((await q("select count(*) n from public.audit_log"))[0].n);
      await exec(mig);
      const rows = await q(`select actor_id, actor_label from public.audit_log where summary in ('orphan one','orphan two') order by summary`);
      expect(rows.map((r) => r.actor_id)).toEqual([null, null]);
      expect(rows.map((r) => r.actor_label)).toEqual(["Deleted Person A", "Deleted Person B"]); // history is kept, only the dangling id is removed
      expect(Number((await q("select count(*) n from public.audit_log"))[0].n)).toBe(before);
      await exec("savepoint s1");
      let msg = "";
      try { await exec(`insert into public.audit_log (actor_id, actor_label, action, entity_type, entity_id, summary, details) values ('${GHOST_A}','x','a','t','1','s','{}'::jsonb)`); } catch (e) { msg = String((e as Error).message); }
      await exec("rollback to savepoint s1");
      expect(msg).toMatch(/foreign key|violates/i);
    });
  });

  test("a row that violates the length constraint, or a null window_start, makes 0061 fail instead of passing silently", async () => {
    // [description, statements run after production's state is rebuilt, before 0061]
    const cases: [string, string][] = [
      ["null window_start", `insert into public.rate_limits (bucket, window_start) values ('probe', null)`],
      ["a report longer than the rule allows",
        `alter table public.community_reports drop constraint community_reports_len_chk;
         insert into public.community_reports (id, tracking_code, category, description, county, status)
           values ('99999999-0000-4000-8000-0000000000ee', 'CR-TOOLONG1', 'pollution', 'Too long county name', repeat('x', 101), 'submitted');
         alter table public.community_reports add constraint community_reports_len_chk check (char_length(description) >= 1) not valid;`],
    ];
    for (const [label, violation] of cases) {
      await scenario(async () => {
        await exec(PRODUCTION_STATE);
        expect(Number((await q("select count(*) n from public.community_reports"))[0].n), label).toBeGreaterThan(0);
        await exec("savepoint pre");
        let failed = "";
        try { await exec(violation); await exec(mig); } catch (e) { failed = String((e as Error).message).split("\n")[0]; }
        await exec("rollback to savepoint pre").catch(() => {});
        expect(failed, label).not.toBe("");
      });
    }
  });

  test("0061 is idempotent on a database that is already clean", async () => {
    await scenario(async () => {
      const clean = await fp();
      await exec(mig);
      await exec(mig);
      expect(diff(clean, await fp())).toEqual({ changed: [], added: [], removed: [] });
    });
  });
});
