// Guard for the tests that talk to a REAL PostgreSQL (everything else runs on in-memory PGlite, which has no network
// connection at all — see getDb() in pglite-db.ts: `new PGlite({ extensions })`, no URL, no path).
//
// A real-database test may only run when ALL of these hold; otherwise it throws BEFORE any connection is made:
//   1. SITE_CODE_PG_ALLOW_WRITES=yes is set (an explicit opt-in: these tests INSERT rows that cannot be deleted)
//   2. the host is this machine (localhost, 127.0.0.1, ::1) — a remote host, Supabase pooler or *.supabase.co is refused
//   3. the database name contains "test", "scratch" or "disposable"
//   4. the URL does not mention a known production/staging project ref
export const KNOWN_PROJECT_REFS = ["ewukneoblhogtreeekqc"];

export function assertDisposablePgUrl(raw: string | undefined, env: Record<string, string | undefined> = process.env): URL {
  if (!raw) throw new Error("SITE_CODE_PG_URL is not set");
  if (env.SITE_CODE_PG_ALLOW_WRITES !== "yes") {
    throw new Error("Refusing to run: set SITE_CODE_PG_ALLOW_WRITES=yes to confirm this database is disposable (the test writes rows that cannot be deleted).");
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("Refusing to run: SITE_CODE_PG_URL is not a valid URL.");
  }
  if (u.protocol !== "postgresql:" && u.protocol !== "postgres:") throw new Error("Refusing to run: not a postgres URL.");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
    throw new Error(`Refusing to run: host "${host}" is not this machine. Real-database tests only run against a local, disposable database.`);
  }
  if (/supabase\.(co|com)|pooler/i.test(raw) || KNOWN_PROJECT_REFS.some((r) => raw.includes(r))) {
    throw new Error("Refusing to run: the URL looks like a Supabase / production target.");
  }
  const db = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (!/(test|scratch|disposable)/i.test(db)) {
    throw new Error(`Refusing to run: database name "${db}" must contain "test", "scratch" or "disposable".`);
  }
  return u;
}
