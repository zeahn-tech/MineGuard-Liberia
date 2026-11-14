// Pure helpers behind the database deployment pipeline (no network, no database).
// Everything here is covered by tests/db-pipeline.test.ts.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const NAME_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/** A statement that can destroy data must carry `-- destructive-approved: <reason>` somewhere in the file. */
export const DESTRUCTIVE_RE =
  /^\s*(drop\s+(table|column|schema|type|extension)\b|truncate\b|delete\s+from\b|alter\s+table\b[^;]*\bdrop\s+column\b|alter\s+table\b[^;]*\balter\s+column\b[^;]*\btype\b)/im;

const stripComments = (sql) => sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

/** Remove dollar-quoted bodies (function/trigger definitions) — their statements run later, not at migration time —
 *  but KEEP the bodies of DO blocks, which do execute during the migration. */
export const stripDeferredBodies = (sql) =>
  sql.replace(/(\bdo\s+(?:language\s+\w+\s+)?)?(\$[A-Za-z_]*\$)([\s\S]*?)\2/gi, (m, doKw, _tag, body) => (doKw ? body : " "));

export function loadPolicy(root) {
  const p = join(root, "supabase", "migration-policy.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : { firstManagedVersion: "0000", knownDuplicateVersions: {} };
}

/** files: [{name, sql}] — returns {errors, warnings}. */
export function validateMigrations(files, policy, { destructiveSince } = {}) {
  const errors = [];
  const byVersion = new Map();
  for (const { name } of files) {
    const m = NAME_RE.exec(name);
    if (!m) { errors.push(`${name}: not NNNN_snake_case.sql`); continue; }
    byVersion.set(m[1], [...(byVersion.get(m[1]) ?? []), name]);
  }
  for (const [v, names] of byVersion) {
    if (names.length < 2) continue;
    const pinned = policy.knownDuplicateVersions?.[v];
    if (!pinned || JSON.stringify([...names].sort()) !== JSON.stringify([...pinned].sort()))
      errors.push(`duplicate version ${v}: ${names.join(", ")}`);
  }
  const nums = [...byVersion.keys()].map(Number).sort((a, b) => a - b);
  for (let i = 0; i < nums.length; i++) if (nums[i] !== i + 1) { errors.push(`version gap or reorder near ${String(nums[i]).padStart(4, "0")} (expected ${String(i + 1).padStart(4, "0")})`); break; }
  for (const { name, sql } of files) {
    if (!NAME_RE.test(name)) continue;
    if (sql.includes("\r")) errors.push(`${name}: contains CR (CRLF) line endings — production drift risk; commit with LF`);
    const v = name.slice(0, 4);
    if (Number(v) >= 47) {
      if (!/^begin;$/m.test(sql) || !/^commit;$/m.test(sql)) errors.push(`${name}: must be wrapped in begin; … commit;`);
    }
    if (destructiveSince && v >= destructiveSince) {
      if (DESTRUCTIVE_RE.test(stripDeferredBodies(stripComments(sql))) && !/--\s*destructive-approved:\s*\S+/.test(sql))
        errors.push(`${name}: destructive statement without '-- destructive-approved: <reason>'`);
    }
  }
  return { errors };
}

export function readMigrationDir(root) {
  const dir = join(root, "supabase", "migrations");
  return readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));
}

/** Extract the version columns from `supabase migration list` output (table of `Local | Remote | Time`). */
export function parseMigrationList(text) {
  const local = [], remote = [];
  for (const line of text.split("\n")) {
    const cells = line.split("|").map((c) => c.trim().replace(/`/g, ""));
    if (cells.length < 3) continue;
    const [l, r] = cells;
    if (/^\d+$/.test(l)) local.push(l);
    if (/^\d+$/.test(r)) remote.push(r);
  }
  return { local, remote };
}

/** Decide whether it is safe to apply. Fails closed on anything unexplained. */
export function compareHistory({ local, remote }, policy) {
  const errors = [];
  const localSet = new Set(local), remoteSet = new Set(remote);
  for (const v of remote) if (!localSet.has(v)) errors.push(`remote has version ${v} that no local file provides (deleted or renamed migration)`);
  if (new Set(remote).size !== remote.length) errors.push("remote history contains duplicate versions");
  const dupLocal = local.filter((v, i) => local.indexOf(v) !== i);
  const pendingAll = [...new Set(local)].filter((v) => !remoteSet.has(v)).sort();
  for (const v of new Set(dupLocal)) {
    const pinned = policy.knownDuplicateVersions?.[v];
    if (!pinned) errors.push(`local duplicate version ${v}`);
    else if (!remoteSet.has(v)) errors.push(`duplicate version ${v} is not recorded remotely; the CLI cannot record two files under one version`);
    else errors.push(`duplicate version ${v}: the second file can never be recorded by the CLI; reconcile before deploying (docs/db-deployment.md)`);
  }
  const maxRemote = remote.length ? [...remote].sort().at(-1) : "0000";
  const outOfOrder = pendingAll.filter((v) => v < maxRemote);
  if (outOfOrder.length) errors.push(`pending migrations older than the newest applied (${maxRemote}): ${outOfOrder.join(", ")}`);
  const unmanaged = pendingAll.filter((v) => v < (policy.firstManagedVersion ?? "0000"));
  if (unmanaged.length) errors.push(`pending migrations below firstManagedVersion ${policy.firstManagedVersion} (applied by hand, unrecorded): ${unmanaged.join(", ")}`);
  return { errors, pending: pendingAll };
}

const OBJ_RE = /\b(?:create\s+(?:or\s+replace\s+)?(?:unique\s+)?(?:table|function|view|materialized\s+view|trigger|policy|index|type)(?:\s+if\s+not\s+exists)?|alter\s+table(?:\s+if\s+exists)?(?:\s+only)?|drop\s+(?:table|function|view|trigger|policy|index|type)(?:\s+if\s+exists)?)\s+("[^"]+"|[A-Za-z_][\w.]*)/gi;
const COMMON = new Set(["public", "auth", "storage", "id", "profiles", "sites", "organizations"]);

/** Names of the database objects a migration touches (table/function/policy/trigger identifiers). */
export function extractObjects(sql) {
  const out = new Set();
  for (const m of stripComments(sql).matchAll(OBJ_RE)) {
    let n = m[1].replace(/"/g, "");
    n = n.split(".").pop();
    if (n.length >= 6 && !COMMON.has(n.toLowerCase())) out.add(n);
  }
  return [...out];
}

/** Tests that mention any object the changed migrations touch, plus the always-run structural suites. */
export function selectTests(changedMigrations, root) {
  const always = ["tests/migration-apply.test.ts", "tests/migration-hygiene.test.ts", "tests/db-pipeline.test.ts", "tests/phase-e-legacy-access-retirement.test.ts", "tests/phase-e-guard-convergence.test.ts"].filter((t) => existsSync(join(root, t)));
  const objects = new Set();
  for (const f of changedMigrations) {
    const p = join(root, f);
    if (existsSync(p)) for (const o of extractObjects(readFileSync(p, "utf8"))) objects.add(o);
  }
  const tdir = join(root, "tests");
  const picked = new Set(always);
  const reasons = {};
  for (const t of readdirSync(tdir).filter((f) => f.endsWith(".test.ts"))) {
    const body = readFileSync(join(tdir, t), "utf8");
    for (const o of objects) {
      if (new RegExp(`\\b${o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(body)) { picked.add(`tests/${t}`); (reasons[`tests/${t}`] ??= []).push(o); break; }
    }
  }
  return { tests: [...picked].sort(), objects: [...objects].sort(), reasons };
}
