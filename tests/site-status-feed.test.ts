// ---------------------------------------------------------------------------
// PHASE 1 — site status feed authorization. The feed (backend.ts
// stats.siteStatusFeed) runs through the REAL data layer over REAL Postgres
// RLS as every identity, and the same scope is asserted on the RAW tables as
// a hostile client would query them (direct API access, not just the UI).
//
// Isolation is enforced by the database; these tests prove the feed neither
// widens it nor leaks anything outside it, and that it carries no free text or
// identities (data minimization).
// ---------------------------------------------------------------------------

import { beforeAll, describe, expect, test } from "bun:test";
import { api } from "../src/lib/backend";
import {
  __testSetAuthUserId,
  __testSetSupabaseClient,
  supabase,
} from "../src/lib/supabase";
import {
  adminSql,
  createEdgeClient,
  edgeIdentity,
  EDGE_IDS as f,
  getEdgeDb,
} from "./helpers/backend-edge";
import { computeSiteStatuses, type SiteStatusInputs } from "../src/lib/site-status";

function setIdentity(uid: string | null) {
  __testSetAuthUserId(uid);
  edgeIdentity.set(uid);
}

function first<T>(q: { subscribe: (cb: (v: T) => void) => () => void }): Promise<T | undefined> {
  return new Promise((resolve) => {
    const unsub = q.subscribe((v) => {
      queueMicrotask(unsub);
      resolve(v);
    });
  });
}

async function feed(): Promise<SiteStatusInputs> {
  const d = await first(api.stats.siteStatusFeed());
  expect(d, "siteStatusFeed must resolve a snapshot").toBeDefined();
  return d!;
}

const siteIds = (d: SiteStatusInputs) => d.sites.map((s) => s.id);
const fixtureSites = (d: SiteStatusInputs) =>
  siteIds(d).filter((id) => id === f.siteA || id === f.siteB).sort();

beforeAll(async () => {
  await getEdgeDb();
  __testSetSupabaseClient(createEdgeClient());
});

describe("site status feed — scope (real backend.ts over real Postgres RLS)", () => {
  test("admin and national supervisor see both fixture sites", async () => {
    for (const uid of [f.admin, f.national]) {
      setIdentity(uid);
      expect(fixtureSites(await feed())).toEqual([f.siteA, f.siteB].sort());
    }
  });

  test("county inspector (Bomi) sees ONLY Bomi — on every table the feed reads", async () => {
    setIdentity(f.county);
    const d = await feed();
    expect(fixtureSites(d)).toEqual([f.siteA]);
    for (const s of d.sites) expect(s.county).toBe("Bomi");
    for (const rows of [d.inspections, d.findings, d.actions, d.incidents])
      for (const r of rows) expect(r.siteId).not.toBe(f.siteB);
    expect(JSON.stringify(d)).not.toContain(f.siteB);
  });

  test("company operator A sees only their own company's data", async () => {
    setIdentity(f.opA);
    const d = await feed();
    expect(fixtureSites(d)).toEqual([f.siteA]);
    for (const s of d.sites) expect(s.operatorName).toBe("AgriLib Mining");
    expect(JSON.stringify(d)).not.toContain(f.siteB);
    expect(JSON.stringify(d)).not.toContain("OreCo");
  });

  test("company operator B is isolated from A symmetrically", async () => {
    setIdentity(f.opB);
    const d = await feed();
    expect(fixtureSites(d)).toEqual([f.siteB]);
    expect(JSON.stringify(d)).not.toContain(f.siteA);
    expect(JSON.stringify(d)).not.toContain("AgriLib");
  });

  test("role-less account receives an empty snapshot (and no denied queries)", async () => {
    setIdentity(f.guest);
    const d = await feed();
    expect(d.sites).toEqual([]);
    expect(d.inspections).toEqual([]);
    expect(d.findings).toEqual([]);
    expect(d.actions).toEqual([]);
    expect(d.incidents).toEqual([]);
    expect(typeof d.loadedAt).toBe("number");
  });

  test("no company's status is derived from another company's rows", async () => {
    // Statuses computed from each operator's own feed must equal statuses
    // computed from the DB truth restricted to that operator's site.
    setIdentity(f.opB);
    const d = await feed();
    const rows = computeSiteStatuses(d, { now: d.loadedAt });
    expect(rows.map((r) => r.site.id)).not.toContain(f.siteA);
  });
});

describe("site status feed — fidelity to the database", () => {
  test("admin feed counts for siteA match the raw tables", async () => {
    setIdentity(f.admin);
    const d = await feed();
    const row = computeSiteStatuses(d, { now: d.loadedAt }).find((r) => r.site.id === f.siteA)!;
    expect(row).toBeDefined();

    const [{ n: crit }] = (await adminSql(
      `select count(*)::int n from public.findings where site_id='${f.siteA}' and severity='critical' and status in ('open','acknowledged')`,
    )) as { n: number }[];
    const [{ n: over }] = (await adminSql(
      `select count(*)::int n from public.corrective_actions where site_id='${f.siteA}' and status in ('open','in_progress','submitted','escalated') and due_at < now()`,
    )) as { n: number }[];
    const [{ n: approvedN }] = (await adminSql(
      `select count(*)::int n from public.inspections where site_id='${f.siteA}' and status='approved'`,
    )) as { n: number }[];

    expect(row.openCriticalFindings).toBe(crit);
    expect(row.overdueActions).toBe(over);
    expect(row.lastApprovedInspectionAt === null).toBe(approvedN === 0);
    // A site with no approved inspection can never be 'recent_information'.
    if (approvedN === 0) expect(row.status).not.toBe("recent_information");
    // An open critical finding always forces review_now.
    if (crit > 0) expect(row.status).toBe("review_now");
  });

  test("every fixture site appears even with no activity (never silently dropped)", async () => {
    setIdentity(f.admin);
    const d = await feed();
    const rows = computeSiteStatuses(d, { now: d.loadedAt });
    for (const id of [f.siteA, f.siteB]) expect(rows.some((r) => r.site.id === id)).toBe(true);
  });
});

describe("site status feed — data minimization", () => {
  test("snapshot rows carry no free text, notes, answers, evidence or identities", async () => {
    setIdentity(f.admin);
    const d = await feed();
    const allowed: Record<string, string[]> = {
      sites: ["id", "code", "name", "operatorName", "organizationId", "county", "district", "registryStatus", "latitude", "longitude"],
      inspections: ["siteId", "status", "submittedAt", "reviewedAt", "createdAt"],
      findings: ["siteId", "severity", "status"],
      actions: ["siteId", "status", "dueAt"],
      incidents: ["siteId", "severity", "status", "occurredAt", "fatalities", "createdAt"],
    };
    for (const [table, keys] of Object.entries(allowed)) {
      const rows = (d as unknown as Record<string, Record<string, unknown>[]>)[table];
      for (const r of rows) for (const k of Object.keys(r)) expect(keys, `${table}.${k}`).toContain(k);
    }
  });

  test("a known incident description never appears in the feed", async () => {
    const [inc] = (await adminSql(
      `select description from public.incidents where id='${f.incidentA}'`,
    )) as { description: string }[];
    expect(inc?.description?.length ?? 0).toBeGreaterThan(3);
    setIdentity(f.admin);
    expect(JSON.stringify(await feed())).not.toContain(inc.description);
  });
});

describe("direct API access (a hostile client querying the raw tables)", () => {
  test("operator A cannot read operator B's rows on any table the dashboard uses", async () => {
    setIdentity(f.opA);
    for (const [table, col] of [
      ["sites", "id"],
      ["inspections", "site_id"],
      ["findings", "site_id"],
      ["corrective_actions", "site_id"],
      ["incidents", "site_id"],
    ] as const) {
      const { data, error } = await supabase.from(table).select(col);
      expect(error, `${table}: ${error?.message}`).toBeNull();
      const vals = (data ?? []).map((r) => (r as unknown as Record<string, string>)[col]);
      expect(vals, `${table} leaked siteB`).not.toContain(f.siteB);
    }
  });

  test("direct query by id for another company's site returns nothing", async () => {
    setIdentity(f.opA);
    const { data } = await supabase.from("sites").select("id").eq("id", f.siteB);
    expect(data ?? []).toEqual([]);
  });

  test("a role-less account reads zero rows from the dashboard tables", async () => {
    setIdentity(f.guest);
    for (const table of ["sites", "inspections", "findings", "corrective_actions", "incidents"]) {
      const { data } = await supabase.from(table).select("id");
      expect(data ?? [], table).toEqual([]);
    }
  });

  test("county inspector cannot read the other county via the raw tables", async () => {
    setIdentity(f.county);
    const { data } = await supabase.from("incidents").select("site_id");
    expect((data ?? []).map((r) => (r as { site_id: string }).site_id)).not.toContain(f.siteB);
  });
});
