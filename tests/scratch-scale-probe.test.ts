// TEMP probe — delete after diagnosis.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { api } from "../src/lib/backend";
import { __testSetAuthUserId, __testSetSupabaseClient } from "../src/lib/supabase";
import {
  adminExec,
  adminSql,
  createEdgeClient,
  edgeIdentity,
  EDGE_IDS as f,
  getEdgeDb,
} from "./helpers/backend-edge";

const N_FINDINGS = 1500;
const SITE = "94000000-0000-4000-8000-000000000001";
const SCALING = "94000000-0000-4000-8000-000000000002";
const inspId = (i: number) => `94000100-0000-4000-8000-${String(i).padStart(12, "0")}`;
const findingId = (i: number) => `94000200-0000-4000-8000-${String(i).padStart(12, "0")}`;

beforeAll(async () => {
  await getEdgeDb();
  __testSetSupabaseClient(createEdgeClient());
  __testSetAuthUserId(f.admin);
  edgeIdentity.set(f.admin);
  // Teardown-first for rerun safety.
  await adminSql(`delete from public.findings where id::text like '94000200-%'`);
  await adminSql(`delete from public.inspections where id::text like '94000100-%'`);
  await adminSql(`alter table public.sites disable trigger sites_guard;`);
  await adminSql(`delete from public.sites where id='${SITE}'`);
  await adminSql(`alter table public.sites enable trigger sites_guard;`);
  await adminSql(`update public.inspection_templates set archived_at = now() where id='${SCALING}'`);

  await adminExec(
    `set local role authenticated;
     set local request.jwt.claims = '${JSON.stringify({ sub: f.admin, role: "authenticated" })}';
     insert into public.inspection_templates (id, name, active, created_by, sections)
     values ('${SCALING}', 'Probe940 template', true, '${f.admin}', '[]'::jsonb)
     on conflict (id) do nothing`,
  );
  await adminSql(
    `insert into public.inspections (id, site_id, template_id, inspector_id, status, answers)
     values ('${inspId(1)}', '${SITE}', '${SCALING}', '${f.admin}', 'approved', '[]'::jsonb)`,
  );
  // Site created AFTER the inspection to dodge the cascade ordering.
  await adminExec(
    `set local role authenticated;
     set local request.jwt.claims = '${JSON.stringify({ sub: f.admin, role: "authenticated" })}';
     insert into public.sites
       (id, code, name, operator_name, mineral_type, county, district, community, status, created_by)
     values ('${SITE}', 'LB-PRB-040', 'Probe Site 940', 'AgriLib Mining', 'Gold',
             'Bomi', 'Senjeh', 'Probe', 'active', '${f.admin}')
     on conflict (id) do nothing`,
  );
  const rows: string[] = [];
  for (let i = 1; i <= N_FINDINGS; i++) {
    const sev = i % 23 === 0 ? "critical" : i % 7 === 0 ? "high" : i % 2 === 0 ? "medium" : "low";
    rows.push(
      `('${findingId(i)}', '${inspId(1)}', '${SITE}', 'Probe ${i}', '${sev}', '${f.admin}')`,
    );
  }
  await adminSql(
    `insert into public.findings (id, inspection_id, site_id, title, severity, created_by_id)
     values ${rows.join(",")}`,
  );
});

afterAll(async () => {
  await adminSql(`delete from public.findings where id::text like '94000200-%'`);
  await adminSql(`delete from public.inspections where id::text like '94000100-%'`);
  await adminSql(`alter table public.sites disable trigger sites_guard;`);
  await adminSql(`delete from public.sites where id='${SITE}'`);
  await adminSql(`alter table public.sites enable trigger sites_guard;`);
  await adminSql(`update public.inspection_templates set archived_at = now() where id='${SCALING}'`);
});

function first<T>(q: { subscribe: (cb: (v: T) => void) => () => void }): Promise<T | undefined> {
  return new Promise((resolve) => {
    const unsub = q.subscribe((v) => {
      unsub();
      resolve(v);
    });
  });
}

test("probe: two riskScores calls + explanation agree", async () => {
  const s1 = await first(api.sites.riskScores());
  console.log("call1 score:", s1![SITE].score);
  console.log("call1 factors:", JSON.stringify(s1![SITE].factors.map((x) => `${x.label}:${x.points}`)));

  const s2 = await first(api.sites.riskScores());
  console.log("call2 score:", s2![SITE].score);
  console.log("call2 factors:", JSON.stringify(s2![SITE].factors.map((x) => `${x.label}:${x.points}`)));

  const expl = await first(api.ai.explainRiskScore({ siteId: SITE }));
  console.log("expl sentence sum:", expl!.sentences.reduce((n, x) => n + x.points, 0));
  console.log("expl sentences:", JSON.stringify(expl!.sentences.map((x) => `${x.factor}:${x.points}`)));

  expect(s1![SITE].score).toBe(s2![SITE].score);
});
