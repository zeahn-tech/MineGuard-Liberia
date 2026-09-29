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
// 2. PRODUCTION DEPLOY PATH — the workflow exists, is manual-gated
//    (workflow_dispatch, typed confirmation, protected environment), runs
//    a fresh backup BEFORE deploying, builds with VITE_MINEGUARD_ENV=
//    production, verifies the seed UI is absent from the compiled bundle,
//    and verifies the deployed endpoint answers 200.
// 3. BACKUP SCHEDULE — nightly cron at 03:30 UTC, artifact retention 90
//    days, dump archive verification (pg_restore --list) inside the backup
//    script, and a weekly restore drill into a throwaway Postgres.
// 4. RESTORE TOOLING — the restore script requires an explicit target and a
//    typed confirmation, so a bare accidental invocation cannot overwrite
//    a database.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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

describe("production deploy path (gated, backed-up, verified)", () => {
  test("workflow is manual-only with a typed confirmation gate", () => {
    const wf = prodWorkflow();
    expect(wf).toContain("workflow_dispatch:");
    expect(wf).not.toMatch(/on:\s*\n\s*push:/); // never a push side effect
    expect(wf).toContain('Type "deploy-production" to confirm');
    expect(wf).toContain("deploy-production"); // the phrase being checked
    expect(wf).toContain("environment: production");
  });

  test("production deploy is preceded by a forced fresh backup", () => {
    const wf = prodWorkflow();
    expect(wf).toContain("backup-supabase.sh");
    // Job ordering: guard (backup) -> build -> deploy (github-pages env).
    expect(wf).toMatch(/guard:[\s\S]*\n  build:\s*\n\s*needs: guard/);
    expect(wf).toMatch(/\n  deploy:\s*\n\s*needs: build/);
    expect(wf).toContain("name: github-pages");
    expect(wf).toContain("if-no-files-found: error");
  });

  test("build uses the production flag and verifies the seed UI is absent", () => {
    const wf = prodWorkflow();
    expect(wf).toContain("VITE_MINEGUARD_ENV: production");
    expect(wf).toContain('grep -r "Load demo data" dist/assets/');
    expect(wf).toContain("FAIL: demo seed UI present in production bundle");
  });

  test("deploy verification: endpoint must answer 200 or the deploy fails", () => {
    const wf = prodWorkflow();
    expect(wf).toContain("Verify deployment answers");
    expect(wf).toContain("exit 1");
  });

  test("typecheck + tests run before any prod deploy step", () => {
    const wf = prodWorkflow();
    const guardIdx = wf.indexOf("Typecheck + tests must be green");
    const deployIdx = wf.indexOf("Deploy to GitHub Pages (production)");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(deployIdx).toBeGreaterThan(guardIdx);
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
