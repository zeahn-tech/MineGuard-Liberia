// Source contracts for the Phase E UI (convenience gates; the database is the boundary).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8");

describe("Phase E UI contracts", () => {
  test("the import page is for company administrators and onboarding officers only", () => {
    const s = read("src/pages/operate/OperatorImport.tsx");
    expect(s).toMatch(/orgRole === "company_admin" \|\| me\.orgRole === "onboarding_officer"/);
    expect(s).toContain("limited to company administrators and onboarding officers");
  });
  test("the import sends only rows from the parsed file with a retry-safe key, in server-sized batches", () => {
    const s = read("src/pages/operate/OperatorImport.tsx");
    expect(s).toContain("importStart");
    expect(s).toContain("IMPORT_BATCH");
    expect(s).toMatch(/key,\s*filename/);
  });
  test("nav: Import workers is shown to administrators and officers, Team only to administrators", () => {
    const s = read("src/pages/operate/OperatorLayout.tsx");
    expect(s).toMatch(/"\/operate\/import"[^}]*onboardOnly: true/);
    expect(s).toMatch(/"\/operate\/team"[^}]*adminOnly: true/);
    expect((s.match(/items=\{navItems\}/g) ?? []).length).toBe(2);
  });
  test("join-request approval offers only operational roles; the officer role is appointed elsewhere", () => {
    const s = read("src/pages/operate/OperatorTeam.tsx");
    expect(s).toMatch(/REQUEST_ROLES = \["worker", "safety_officer", "site_manager"\]/);
    expect(s).toContain('"onboarding_officer"');
  });
});
