// TEMPORARY DIAGNOSTIC — delete after use.
import { test } from "bun:test";
import { adminSql, EDGE_IDS as f } from "./helpers/backend-edge";

test("dump siteA corrective actions", async () => {
  const rows = await adminSql(
    `select id, description, status, due_at, due_at < now() as overdue
       from public.corrective_actions where site_id = '${f.siteA}' order by created_at`,
  );
  console.log("PROBE-DUMP " + JSON.stringify(rows));
});
