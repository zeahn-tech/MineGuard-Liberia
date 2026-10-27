// ---------------------------------------------------------------------------
// OPERATIONAL READINESS (Priority D) — production deploy path + backups.
//
// These tests pin the OPERATIONAL contracts in place so they cannot rot:
//
// 1. PRODUCTION SEED GUARD (doc 14 deploy checklist item 4) — the demo
//    seeder must be unreachable in production builds: the button is not
//    rendered when VITE_MINEGUARD_ENV=production, and the call site refuses
//    the action. The guard must live in BOTH places (UI gating alone would
//    allow a re-introduced call site; call-site gating alone would still
//    render a button that always errors).
// 2. PRODUCTION DEPLOY PATH — the single canonical workflow deploys
//    automatically on push/merge to main AFTER the reusable CI gate (full
//    suite + RLS/migration/audit-hardening/rate-limit security suites)
//    passes; it has no backup, passphrase or manual-confirmation dependency;
//    builds with VITE_MINEGUARD_ENV=production, verifies the seed UI is
//    absent from the compiled bundle, and verifies the endpoint answers 200.
// 3. BACKUP SCHEDULE — nightly cron at 03:30 UTC, artifact retention 90
//    days, dump archive verification (pg_restore --list) inside the backup
//    script, and a weekly restore drill into a throwaway Postgres.
// 4. RESTORE TOOLING — the restore script requires an explicit target and a
//    typed confirmation, so a bare accidental invocation cannot overwrite
//    a database.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const prodWorkflow = () =>
  readFileSync(join(".github", "workflows", "deploy-production.yml"), "utf8");
const backupWorkflow = () =>
  readFileSync(join(".github", "workflows", "backup.yml"), "utf8");
const layout = () => readFileSync(join("src", "pages", "PortalLayout.tsx"), "utf8");
const backupScript = () => readFileSync(join("scripts", "backup-supabase.sh"), "utf8");
const restoreScript = () => readFileSync(join("scripts", "restore-supabase.sh"), "utf8");

describe("production seed guard (doc 14 checklist item 4)", () => {
  test("seed button not rendered under VITE_MINEGUARD_ENV=production", () => {
    const src = layout();
    expect(src).toContain('import.meta.env.VITE_MINEGUARD_ENV !== "production"');
  });

  test("seed call site refuses the action in production (defense in depth)", () => {
    const src = layout();
    expect(src).toContain('if (import.meta.env.VITE_MINEGUARD_ENV === "production")');
    expect(src).toContain("Demo seeding is disabled in production deployments.");
  });
});

describe("production deploy path (automatic, validated, verified)", () => {
  test("deploys automatically on push/merge to main; no manual gate", () => {
    const wf = prodWorkflow();
    expect(wf).toMatch(/on:\s*\n\s*push:\s*\n\s*branches:\s*\[main\]/);
    expect(wf).toContain("workflow_dispatch:"); // authorised re-run only
    expect(wf).not.toContain("confirm_prod");
    expect(wf).not.toContain("deploy-production\"");
    expect(wf).not.toContain("environment: production");
    expect(wf).not.toMatch(/workflow_dispatch:\s*\n\s*inputs:/);
  });

  test("publishing jobs only ever run for main", () => {
    const wf = prodWorkflow();
    const guards = wf.match(/if: github\.ref == 'refs\/heads\/main'/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(2); // build + deploy
  });

  test("production deploy has NO backup dependency of any kind", () => {
    const wf = prodWorkflow();
    for (const banned of [
      "BACKUP_PASSPHRASE",
      "backup-supabase",
      "pg_dump",
      "postgresql-client",
      "gpg",
      "upload-artifact",
      "SUPABASE_DB_PASSWORD",
    ]) {
      expect(wf).not.toContain(banned);
    }
  });

  test("job chain: CI gate -> build -> deploy (github-pages env)", () => {
    const wf = prodWorkflow();
    expect(wf).toMatch(/\n {2}ci:\s*\n(?: {4}.*\n)*? {4}uses: \.\/\.github\/workflows\/ci\.yml/);
    expect(wf).toMatch(/\n {2}build:\s*\n(?: {4}.*\n)*? {4}needs: ci/);
    expect(wf).toMatch(/\n {2}deploy:\s*\n(?: {4}.*\n)*? {4}needs: build/);
    expect(wf).toContain("name: github-pages");
  });

  test("build uses the production flag and verifies the seed UI is absent", () => {
    const wf = prodWorkflow();
    expect(wf).toContain("VITE_MINEGUARD_ENV: production");
    expect(wf).toContain('grep -r "Load demo data" dist/assets/');
    expect(wf).toContain("FAIL: demo seed UI present in production bundle");
    expect(wf).toContain("Content-Security-Policy");
  });

  test("deploy verification: endpoint must answer 200 or the deploy fails", () => {
    const wf = prodWorkflow();
    expect(wf).toContain("Verify deployment answers");
    expect(wf).toContain("exit 1");
  });

  test("the CI gate runs the full suite and the four security suites", () => {
    const ci = readFileSync(join(".github", "workflows", "ci.yml"), "utf8");
    expect(ci).toContain("workflow_call:");
    expect(ci).toContain("bunx tsc -b --noEmit");
    expect(ci).toContain("bunx eslint .");
    expect(ci).toContain("bun test --timeout 60000");
    for (const t of ["rls", "migration-apply", "audit-hardening", "rate-limit"]) {
      expect(ci).toContain(`tests/${t}.test.ts`);
    }
    // never lets a failure through
    expect(ci).not.toContain("continue-on-error");
    // no duplicate push run (the deploy workflow calls it instead)
    expect(ci).not.toMatch(/on:[\s\S]*\n {2}push:/);
  });

  test("exactly one workflow can publish to Pages; no unvalidated route", () => {
    const dir = join(".github", "workflows");
    const publishers = readdirSync(dir).filter((f) =>
      /actions\/deploy-pages/.test(readFileSync(join(dir, f), "utf8")),
    );
    expect(publishers).toEqual(["deploy-production.yml"]);
    expect(readdirSync(dir)).not.toContain("deploy-pages.yml");
  });

  test("optional backups are independent of deployment", () => {
    const wf = prodWorkflow();
    expect(wf).not.toMatch(/uses: \.\/\.github\/workflows\/backup\.yml/);
    expect(wf).not.toContain("needs: backup");
    const bk = backupWorkflow();
    expect(bk).not.toMatch(/\n\s*push:/);
    expect(bk).toContain("needs.config.outputs.enabled == 'true'");
  });
});

describe("backup schedule (nightly + verification + retention)", () => {
  test("nightly cron at 03:30 UTC with manual drill trigger", () => {
    const wf = backupWorkflow();
    expect(wf).toContain('cron: "30 3 * * *"');
    expect(wf).toContain("workflow_dispatch:");
  });

  test("artifacts retained 90 days; missing dump fails the run", () => {
    const wf = backupWorkflow();
    expect(wf).toContain("retention-days: 90");
    expect(wf).toContain("if-no-files-found: error");
  });

  test("backup script verifies the dump archive and writes a checksum manifest", () => {
    const s = backupScript();
    expect(s).toContain("pg_dump");
    expect(s).toContain("-Fc");
    expect(s).toContain("sha256");
    expect(s).toContain("pg_restore --list");
  });

  test("weekly restore drill restores into a throwaway database", () => {
    const wf = backupWorkflow();
    expect(wf).toContain("Restore drill (weekly");
    expect(wf).toContain("pg_restore");
    expect(wf).toContain("public.audit_log"); // domain-level sanity rows
  });

  test("stale backups are pruned to match the 90-day promise", () => {
    const wf = backupWorkflow();
    expect(wf).toContain("Prune backup artifacts older than 90 days");
    expect(wf).toContain("startswith(");
    expect(wf).toContain("db-backup-");
    expect(wf).toContain("-90 days");
  });
});

describe("restore tooling (recovery requires explicit intent)", () => {
  test("restore script refuses to run without a target and typed confirmation", () => {
    const s = restoreScript();
    expect(s).toContain(": \"${TARGET_DB_URL:?TARGET_DB_URL is required");
    expect(s).toContain("Type 'restore' to continue");
    expect(s).toContain("Confirm the target is NOT the production database");
    expect(s).toContain("--clean"); // full replace semantics declared
    expect(s).toContain("--if-exists");
  });

  test("restore script is documented with drill sanity checks", () => {
    const s = restoreScript();
    expect(s).toContain("Drill sanity checks");
    expect(s).toContain("public.sites");
  });
});
