// Session 7 — the data layer end to end (real backend.ts over the RLS bridge):
// admin-only publish, scores/explainer read the published config, version replay.
// Publishes COMMIT in this bridge, so afterAll restores version 1 as the owner.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api } from "../src/lib/backend";
import { __testSetSupabaseClient, __testSetAuthUserId } from "../src/lib/supabase";
import { adminExec, createEdgeClient, edgeIdentity, EDGE_IDS as f, getEdgeDb } from "./helpers/backend-edge";
import { LEGACY_RISK_CONFIG } from "../src/lib/risk-config";

function as(uid: string | null) {
  __testSetAuthUserId(uid);
  edgeIdentity.set(uid);
}
function first<T>(q: { subscribe: (cb: (v: T) => void) => () => void }): Promise<T | undefined> {
  return new Promise((resolve) => {
    const unsub = q.subscribe((v) => {
      unsub();
      resolve(v);
    });
  });
}

beforeAll(async () => {
  await getEdgeDb();
  __testSetSupabaseClient(createEdgeClient());
});

afterAll(async () => {
  await adminExec(`
    set session_replication_role = replica;
    delete from public.audit_log where entity_type = 'risk_config_versions' and action = 'risk_config_versions.insert'
      and (details->'after'->>'version')::int > 1;
    delete from public.risk_config_versions where version > 1;
    set session_replication_role = origin;`);
});

describe("risk config through the data layer", () => {
  test("non-admins cannot publish; admin can; scores and explainer follow the new version", async () => {
    const weights = { ...LEGACY_RISK_CONFIG.weights, highFinding: 20 };
    for (const uid of [f.national, f.county, f.opA]) {
      as(uid);
      await expect(
        api.riskConfig.publish({ weights, lookbackDays: 365, changeNote: "nope" }),
      ).rejects.toThrow();
    }

    as(f.admin);
    const before = (await first(api.sites.riskScores()))!;
    const v = await api.riskConfig.publish({ weights, lookbackDays: 365, changeNote: "raise high findings" });
    expect(v.version).toBe(2);

    const after = (await first(api.sites.riskScores()))!;
    const changed = Object.keys(after).filter((id) => after[id].score !== before[id].score);
    expect(changed.length).toBeGreaterThan(0);
    for (const id of Object.keys(after)) {
      expect(after[id].configVersion).toBe(2);
      expect(after[id].score).toBe(after[id].factors.reduce((n, x) => n + x.points, 0));
    }

    // version 1 replays exactly what was seen before the publish
    const replay = (await first(api.sites.riskScores({ version: 1 })))!;
    for (const id of Object.keys(before)) expect(replay[id].score).toBe(before[id].score);

    // explainer reads the same config
    const id = changed[0];
    const ex = (await first(api.ai.explainRiskScore({ siteId: id })))!;
    expect(ex.configVersion).toBe(2);
    expect(ex.sentences.reduce((n, s) => n + s.points, 0)).toBe(after[id].score);

    const list = (await first(api.riskConfig.list()))!;
    expect(list.map((x) => x.version)).toEqual([2, 1]);
  });
});
