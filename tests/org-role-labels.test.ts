import { describe, expect, test } from "bun:test";
import { ORG_ROLE_LABEL, orgRoleLabel } from "../src/lib/org-roles";

describe("company role labels", () => {
  test("every assignable org role has its own label", () => {
    expect(orgRoleLabel("company_admin")).toBe("Company administrator");
    expect(orgRoleLabel("safety_officer")).toBe("Safety officer");
    expect(orgRoleLabel("site_manager")).toBe("Site manager");
    expect(orgRoleLabel("worker")).toBe("Worker");
    expect(orgRoleLabel("onboarding_officer")).toBe("Onboarding officer");
    expect(orgRoleLabel("supervisor")).toBe("Supervisor");
    expect(Object.keys(ORG_ROLE_LABEL)).toHaveLength(6);
  });
  test("missing role falls back, unknown role is readable", () => {
    expect(orgRoleLabel(undefined)).toBe("Company member");
    expect(orgRoleLabel(null, "X")).toBe("X");
    expect(orgRoleLabel("future_role")).toBe("future role");
  });
});
