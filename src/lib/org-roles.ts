// ---------------------------------------------------------------------------
// COMPANY ROLE LABELS — one source of truth.
//
// A company member's PLATFORM role is always "operator"; what they actually
// are inside the company is their ORG role (company_admin, site_manager,
// safety_officer, worker, onboarding_officer) assigned by the company admin.
// The profile page and the navigation drawer show the ORG role, so a safety
// officer sees "Safety officer", not a generic "Company user"/"operator".
// ---------------------------------------------------------------------------

export const ORG_ROLE_LABEL: Record<string, string> = {
  company_admin: "Company administrator",
  site_manager: "Site manager",
  safety_officer: "Safety officer",
  worker: "Worker",
  onboarding_officer: "Onboarding officer",
};

/** Human label for an org role; unknown values are shown as-is, missing → fallback. */
export function orgRoleLabel(orgRole: string | null | undefined, fallback = "Company member"): string {
  if (!orgRole) return fallback;
  return ORG_ROLE_LABEL[orgRole] ?? orgRole.replace(/_/g, " ");
}
