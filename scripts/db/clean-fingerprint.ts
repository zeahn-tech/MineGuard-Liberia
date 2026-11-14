// bun scripts/db/clean-fingerprint.ts > expected.json — fingerprint of a database built from the repo's migrations (PGlite, no Docker).
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS, PLATFORM_STUB } from "../../tests/helpers/pglite-db";

const root = join(import.meta.dir, "..", "..");
const db = new PGlite({ extensions: { pgcrypto, pg_trgm } });
await db.exec(PLATFORM_STUB);
for (const f of MIGRATIONS) await db.exec(readFileSync(join(root, "supabase", "migrations", f), "utf8"));
const r = await db.query(readFileSync(join(root, "supabase", "checks", "schema_fingerprint.sql"), "utf8"));
console.log(JSON.stringify(r.rows));
await db.close();
