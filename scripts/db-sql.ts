// ---------------------------------------------------------------------------
// DB SQL RUNNER — applies a .sql file (or stdin) to the live Supabase project
// through the Supabase Management API's database/query endpoint.
//
//   SUPABASE_ACCESS_TOKEN=<token> bun scripts/db-sql.ts <file.sql>
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

async function main() {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) {
    console.error("SUPABASE_ACCESS_TOKEN is not set.");
    process.exit(2);
  }
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: bun scripts/db-sql.ts <file.sql | ->");
    process.exit(2);
  }
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

  const res = await fetch(API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: sql }),
  });
  const body = await res.text();
  if (!res.ok) {
    console.error(`HTTP ${res.status}`);
    console.error(body);
    process.exit(1);
  }
  console.log(body);
}

main();
