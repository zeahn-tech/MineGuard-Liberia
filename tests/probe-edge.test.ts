// TEMPORARY probe — separate transactions per experiment. Deleted after.
import { describe, expect, test } from "bun:test";
import { getEdgeDb, EDGE_IDS as f } from "./helpers/backend-edge";

describe("probe8", () => {
  test("isolated experiments", async () => {
    const db = await getEdgeDb();
    const claims = JSON.stringify({ sub: f.admin, role: "authenticated" });

    // (1) 12-col with nulls
    const sql1 = `insert into public.sites (name, operator_name, county, district, community, mineral_type, latitude, longitude, notes, status, code, created_by) values ('P8a', 'AgriLib Mining', 'Bomi', 'Senjeh', null, null, 6.9, -10.9, null, 'pending_verification', 'MGL-BOMI-0001', '${f.admin}') returning id`;
    try {
      const r = await db.exec(`begin; set local role authenticated; set local request.jwt.claims = '${claims}'; ${sql1}; rollback;`);
      console.log("12-col-with-nulls:", r.map((s) => `${s.command}(${s.rows.length})`).join(" "));
    } catch (e) {
      console.log("12-col-with-nulls FAIL:", e instanceof Error ? e.message : String(e));
    }

    // (2) 6-col, no nulls
    const sql2 = `insert into public.sites (name, operator_name, county, status, code, created_by) values ('P8b', 'AgriLib Mining', 'Bomi', 'pending_verification', 'MGL-BOMI-0002', '${f.admin}') returning id`;
    try {
      const r = await db.exec(`begin; set local role authenticated; set local request.jwt.claims = '${claims}'; ${sql2}; rollback;`);
      console.log("6-col-no-nulls:", r.map((s) => `${s.command}(${s.rows.length})`).join(" "));
    } catch (e) {
      console.log("6-col-no-nulls FAIL:", e instanceof Error ? e.message : String(e));
    }

    // (3) 12-col but explicit DEFAULTs instead of null
    const sql3 = `insert into public.sites (name, operator_name, county, district, community, mineral_type, latitude, longitude, notes, status, code, created_by) values ('P8c', 'AgriLib Mining', 'Bomi', 'Senjeh', 'Bomi Hills', 'Gold', 6.9, -10.9, 'n', 'pending_verification', 'MGL-BOMI-0003', '${f.admin}') returning id`;
    try {
      const r = await db.exec(`begin; set local role authenticated; set local request.jwt.claims = '${claims}'; ${sql3}; rollback;`);
      console.log("12-col-no-nulls:", r.map((s) => `${s.command}(${s.rows.length})`).join(" "));
    } catch (e) {
      console.log("12-col-no-nulls FAIL:", e instanceof Error ? e.message : String(e));
    }

    expect(true).toBe(true);
  });
});
