// Migration 0045 — colleague names for the operator safety analytics page.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(join(import.meta.dir, "..", "supabase", "migrations", "0045_company_member_names.sql"), "utf8");

describe("mg_company_member_names (migration 0045)", () => {
  test("only an active member of the same company may call it", () => {
    expect(sql).toContain("me.organization_id = p_org and me.user_id = auth.uid() and me.status = 'active'");
    expect(sql).toContain("raise exception 'FORBIDDEN'");
  });
  test("returns id and name only — no email — and only active members", () => {
    expect(sql).toContain("returns table (user_id uuid, name text)");
    expect(sql).not.toMatch(/p\.email|m\.org_role/);
    expect(sql).toContain("m.status = 'active'");
  });
  test("is closed to anon and public", () => {
    expect(sql).toContain("revoke all on function public.mg_company_member_names(uuid) from public, anon");
  });
});
