// ---------------------------------------------------------------------------
// The database deployment pipeline's decision logic (scripts/db/lib.mjs): file validation,
// the destructive-change gate, the local-vs-remote history comparison (fails closed) and the
// selection of only the tests that touch the changed database objects.
// ---------------------------------------------------------------------------
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
// @ts-expect-error plain ESM helper without type declarations
// @ts-expect-error plain ESM helper without type declarations
import { diffFingerprints } from "../scripts/db/diff-fingerprint.mjs";
// @ts-expect-error plain ESM helper without type declarations
import { compareHistory, extractObjects, loadPolicy, parseMigrationList, readMigrationDir, selectTests, validateMigrations } from "../scripts/db/lib.mjs";

const ROOT = join(import.meta.dir, "..");
const policy = loadPolicy(ROOT);
const ok = (name: string, sql = "begin;\ncreate table if not exists public.x_table (id int);\ncommit;\n") => ({ name, sql });
const chain = (n: number) => Array.from({ length: n }, (_, i) => ok(`${String(i + 1).padStart(4, "0")}_m${i + 1}.sql`));
const errs = (files: { name: string; sql: string }[], opts = {}) => validateMigrations(files, { knownDuplicateVersions: {} }, opts).errors;

describe("migration file validation", () => {
  test("the repository's own migrations pass", () => {
    expect(validateMigrations(readMigrationDir(ROOT), policy, { destructiveSince: policy.firstManagedVersion }).errors).toEqual([]);
  });
  test("a duplicate version is rejected unless it is the pinned historical pair", () => {
    expect(errs([...chain(2), ok("0002_again.sql")]).join()).toMatch(/duplicate version 0002/);
    const pair = [ok("0001_a.sql"), ok("0001_b.sql")];
    expect(validateMigrations(pair, { knownDuplicateVersions: { "0001": ["0001_a.sql", "0001_b.sql"] } }).errors).toEqual([]);
    expect(validateMigrations([...pair, ok("0001_c.sql")], { knownDuplicateVersions: { "0001": ["0001_a.sql", "0001_b.sql"] } }).errors.join()).toMatch(/duplicate version 0001/);
  });
  test("gaps, malformed names and CRLF are rejected", () => {
    expect(errs([ok("0001_a.sql"), ok("0003_c.sql")]).join()).toMatch(/gap or reorder/);
    expect(errs([ok("1_bad.sql")]).join()).toMatch(/not NNNN_snake_case/);
    expect(errs([ok("0001_Bad.sql")]).join()).toMatch(/not NNNN_snake_case/);
    expect(errs([ok("0001_a.sql", "select 1;\r\n")]).join()).toMatch(/CRLF/);
  });
  test("migrations from 0047 on must be transactional", () => {
    const files = [...chain(46), ok("0047_x.sql", "create table public.t_table (id int);")];
    expect(errs(files).join()).toMatch(/begin; … commit;/);
  });
  test("destructive statements need an explicit approval marker; comments and policy drops do not trigger it", () => {
    const base = chain(54);
    const drop = (sql: string) => errs([...base, ok("0055_x.sql", `begin;\n${sql}\ncommit;\n`)], { destructiveSince: "0055" });
    expect(drop("drop table public.old_table;").join()).toMatch(/destructive/);
    expect(drop("alter table public.t drop column c;").join()).toMatch(/destructive/);
    expect(drop("truncate public.t;").join()).toMatch(/destructive/);
    expect(drop("delete from public.t;").join()).toMatch(/destructive/);
    expect(drop("-- destructive-approved: test data only, ticket 12\ndrop table public.old_table;")).toEqual([]);
    // statements inside function bodies run later, not at migration time
    expect(drop("create function public.f() returns void language plpgsql as $f$ begin\n  delete from public.t where x; end $f$;")).toEqual([]);
    // but a DO block executes during the migration
    expect(drop("do $$ begin\n  delete from public.t; end $$;").join()).toMatch(/destructive/);
    expect(drop("-- we will not drop table public.t\ndrop policy if exists \"p\" on public.t;")).toEqual([]);
  });
});

// A trimmed copy of the real `supabase migration list --linked` output that exposed the problem.
const REAL = `
   Local  | Remote | Time (UTC)
  --------|--------|------------
   \`0045\` | \`0045\` | \`0045\`
   \`0046\` | \`0046\` | \`0046\`
   \`0046\` | \` \`    | \`0046\`
   \`0047\` | \` \`    | \`0047\`
   \`0048\` | \` \`    | \`0048\`
`;
describe("history comparison (fails closed)", () => {
  test("parses the CLI table, including a duplicated local version with no remote row", () => {
    expect(parseMigrationList(REAL)).toEqual({ local: ["0045", "0046", "0046", "0047", "0048"], remote: ["0045", "0046"] });
  });
  test("the pre-renumbering state is refused: a duplicate 0046 can never be recorded by the CLI", () => {
    const old = { firstManagedVersion: "0055", knownDuplicateVersions: { "0046": ["0046_a.sql", "0046_b.sql"] } };
    const { errors } = compareHistory(parseMigrationList(REAL), old);
    expect(errors.join("\n")).toMatch(/duplicate version 0046/);
    expect(errors.join("\n")).toMatch(/below firstManagedVersion 0055.*0047, 0048/);
  });
  test("production's recorded history (0001-0046) against this repository: exactly 0047 onward is pending, nothing is refused", () => {
    const local = readMigrationDir(ROOT).map((f: { name: string }) => f.name.slice(0, 4));
    const remote = local.filter((v: string) => v <= "0046");
    const r = compareHistory({ local, remote }, policy);
    expect(r.errors).toEqual([]);
    expect(r.pending[0]).toBe("0047");
    expect(r.pending.length).toBe(local.length - 46);
  });
  test("a hand-applied version below firstManagedVersion is refused", () => {
    const local = Array.from({ length: 50 }, (_, i) => String(i + 1).padStart(4, "0"));
    const r = compareHistory({ local, remote: local.slice(0, 40) }, policy);
    expect(r.errors.join()).toMatch(/below firstManagedVersion 0047.*0041.*0046/);
  });
  test("a reconciled history with one new migration passes and reports exactly that migration", () => {
    const local = Array.from({ length: 57 }, (_, i) => String(i + 1).padStart(4, "0"));
    const remote = local.slice(0, 56);
    const r = compareHistory({ local, remote }, policy);
    expect(r.errors).toEqual([]);
    expect(r.pending).toEqual(["0057"]);
  });
  test("a remote-only version, an out-of-order pending version and a local duplicate are refused", () => {
    const v = (n: number) => String(n).padStart(4, "0");
    const local = Array.from({ length: 57 }, (_, i) => v(i + 1));
    expect(compareHistory({ local, remote: [...local.slice(0, 56), "0099"] }, policy).errors.join()).toMatch(/0099 that no local file/);
    expect(compareHistory({ local, remote: local.filter((x) => x !== "0056") }, policy).errors.join()).toMatch(/older than the newest applied/);
    expect(compareHistory({ local: [...local, "0057"], remote: local.slice(0, 56) }, policy).errors.join()).toMatch(/local duplicate version 0057/);
  });
  test("an up-to-date database has nothing pending", () => {
    const local = Array.from({ length: 57 }, (_, i) => String(i + 1).padStart(4, "0"));
    expect(compareHistory({ local, remote: local }, policy)).toEqual({ errors: [], pending: [] });
  });
});

describe("targeted test selection", () => {
  test("object names are read from create/alter/drop statements", () => {
    expect(extractObjects(`create or replace function public.mg_wv_notify(a int) returns void as $$ $$;
      create policy "worker voice read" on public.worker_voice_reports for select using (true);
      alter table public.worker_voice_reports add column foo_bar text; -- create table commented_out`)).toEqual(
      expect.arrayContaining(["mg_wv_notify", "worker voice read", "worker_voice_reports"]));
    expect(extractObjects("-- create table public.ghost_table (id int);")).toEqual([]);
  });
  test("an access-function migration selects the suites that exercise it, plus the structural ones", () => {
    const r = selectTests(["supabase/migrations/0056_retire_legacy_access_layer.sql"], ROOT);
    expect(r.tests).toContain("tests/migration-hygiene.test.ts");
    expect(r.tests).toContain("tests/phase-e-legacy-access-retirement.test.ts");
    expect(r.tests.some((t: string) => /company-sites|operator-isolation|rls/.test(t))).toBe(true);
  });
  test("an unrelated migration does not pull in the whole suite", () => {
    const all = selectTests([], ROOT).tests;
    const voice = selectTests(["supabase/migrations/0053_voice_hardening.sql"], ROOT).tests;
    // with nothing changed, only the structural suites run (migration hygiene/apply/replay, pipeline logic, phase-e) — never feature suites
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((t: string) => /migration-|db-pipeline|phase-e-/.test(t))).toBe(true);
    expect(voice.some((t: string) => /voice/.test(t))).toBe(true);
    expect(voice.length).toBeLessThan(60);
  });
});

describe("fingerprint comparison (rehearsal report)", () => {
  const row = (kind: string, obj: string, h: string) => ({ kind, obj, h });
  test("classifies equal, different, repo-only and live-only objects and ignores platform noise", () => {
    const expected = [row("function", "mg_a()", "1"), row("function", "mg_b()", "2"), row("policy", "t.p1", "3"), row("constraint", "t_x_not_null", "9"), row("function", "digest(text)", "7")];
    const actual = [row("function", "mg_a()", "1"), row("function", "mg_b()", "CHANGED"), row("policy", "t.legacy", "4"), row("function", "gen_random_bytes(int)", "8")];
    expect(diffFingerprints(expected, actual)).toEqual({ equal: 1, differs: ["function|mg_b()"], repoOnly: ["policy|t.p1"], liveOnly: ["policy|t.legacy"] });
  });
  test("compares long signatures on their first 63 characters (identifier truncation in exports)", () => {
    const long = "mg_" + "x".repeat(80) + "(p uuid)";
    expect(diffFingerprints([row("function", long, "1")], [row("function", long.slice(0, 63), "1")]).equal).toBe(1);
  });
});
