#!/usr/bin/env node
// Usage:
//   node scripts/db/cli.mjs validate [--destructive-since 0055]
//   node scripts/db/cli.mjs compare <migration-list-output.txt> [--expect-none]  -> writes pending versions, exits 1 if unsafe
//   node scripts/db/cli.mjs select-tests <changed-file>...          -> prints the targeted test files
import { readFileSync, appendFileSync } from "node:fs";
import { loadPolicy, readMigrationDir, validateMigrations, parseMigrationList, compareHistory, selectTests } from "./lib.mjs";

const root = process.cwd();
const [cmd, ...args] = process.argv.slice(2);
const policy = loadPolicy(root);
const fail = (errs) => { for (const e of errs) console.error(`::error::${e}`); process.exit(1); };

if (cmd === "validate") {
  const i = args.indexOf("--destructive-since");
  const { errors } = validateMigrations(readMigrationDir(root), policy, { destructiveSince: i >= 0 ? args[i + 1] : policy.firstManagedVersion });
  if (errors.length) fail(errors);
  console.log("migration files valid");
} else if (cmd === "compare") {
  const parsed = parseMigrationList(readFileSync(args[0], "utf8"));
  if (!parsed.local.length) fail(["could not read any local versions from the migration list output"]);
  const { errors, pending } = compareHistory(parsed, policy);
  console.log(`remote versions: ${parsed.remote.length}, pending: ${pending.join(", ") || "(none)"}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `pending=${pending.join(",")}\ncount=${pending.length}\n`);
  if (args.includes("--expect-none") && pending.length) errors.push(`expected nothing pending after apply, still pending: ${pending.join(", ")}`);
  if (args.includes("--expect-none") && pending.length) errors.push(`migrations still pending after apply: ${pending.join(", ")}`);
  if (errors.length) fail(errors);
} else if (cmd === "select-tests") {
  const r = selectTests(args.filter((a) => a.startsWith("supabase/migrations/")), root);
  console.error(`objects touched: ${r.objects.length}`);
  console.log(r.tests.join("\n"));
} else {
  console.error("unknown command"); process.exit(2);
}
