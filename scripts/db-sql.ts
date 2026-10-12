// ---------------------------------------------------------------------------
// DB SQL RUNNER — applies a .sql file (or stdin) to the live Supabase project
// through the Supabase Management API's database/query endpoint.
//
//   SUPABASE_ACCESS_TOKEN=<token> bun scripts/db-sql.ts <file.sql> [more.sql …]
//   echo "select 1" | SUPABASE_ACCESS_TOKEN=<token> bun scripts/db-sql.ts -
//
// The Management API runs each call as the `postgres` role inside a single
// server-side transaction. Files that wrap themselves in `begin; … commit;`
// therefore execute atomically: any error rolls the whole file back, which is
// exactly the behaviour migration 0002/0003 promise.
//
// Never commit a token: this script only reads SUPABASE_ACCESS_TOKEN from the
// environment.
// ---------------------------------------------------------------------------

const PROJECT_REF = "ewukneoblhogtreeekqc";
const API = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

async function runSql(sql: string): Promise<{ ok: boolean; status: number; body: string }> {
  const res = await fetch(API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: sql }),
  });
  return { ok: res.ok, status: res.status, body: await res.text() };
}

async function main() {
  if (!process.env.SUPABASE_ACCESS_TOKEN) {
    console.error("SUPABASE_ACCESS_TOKEN is not set.");
    process.exit(2);
  }
  const targets = process.argv.slice(2);
  if (targets.length === 0) {
    console.error("Usage: bun scripts/db-sql.ts <file.sql | -> [more.sql …]");
    process.exit(2);
  }
  console.error(`Project: ${PROJECT_REF}`);
  // Files run strictly in the order given and the run STOPS at the first
  // failure, so a later migration is never applied on top of a failed one.
  for (const target of targets) {
    const sql =
      target === "-"
        ? await new Promise<string>((resolve, reject) => {
            let buf = "";
            process.stdin.setEncoding("utf8");
            process.stdin.on("data", (c) => (buf += c));
            process.stdin.on("end", () => resolve(buf));
            process.stdin.on("error", reject);
          })
        : await Bun.file(target).text();
    const result = await runSql(sql);
    if (!result.ok) {
      console.error(`FAILED: ${target} (HTTP ${result.status})`);
      console.error(result.body);
      process.exit(1);
    }
    console.error(`OK: ${target}`);
    console.log(result.body);
  }
}

main();
