import { QueryCtx, MutationCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { ROLES } from "../schema";

/**
 * Server-side authorization core.
 * Every Convex function re-derives permissions here. The client is never
 * trusted: frontend hiding is NOT authorization.
 */

export type StaffRole =
  | typeof ROLES.ADMIN
  | typeof ROLES.SUPERVISOR
  | typeof ROLES.INSPECTOR;

export function isStaff(role?: string): boolean {
  return (
    role === ROLES.ADMIN ||
    role === ROLES.SUPERVISOR ||
    role === ROLES.INSPECTOR
  );
}

export async function requireUser(ctx: QueryCtx | MutationCtx) {
  const user = await ctx.auth.getUserIdentity();
  if (!user) throw new Error("UNAUTHENTICATED");
  const dbUser = await ctx.db
    .query("users")
    .withIndex("email", (q) => q.eq("email", user.email ?? ""))
    .unique();
  if (!dbUser) throw new Error("UNREGISTERED_USER");
  return dbUser;
}

export async function requireStaff(ctx: QueryCtx | MutationCtx) {
  const user = await requireUser(ctx);
  if (!isStaff(user.role)) throw new Error("FORBIDDEN");
  return user;
}

export async function requireAdmin(ctx: QueryCtx | MutationCtx) {
  const user = await requireUser(ctx);
  if (user.role !== ROLES.ADMIN) throw new Error("FORBIDDEN");
  return user;
}

/** Staff with review/approval authority (admin or supervisor). */
export async function requireReviewer(ctx: QueryCtx | MutationCtx) {
  const user = await requireUser(ctx);
  if (user.role !== ROLES.ADMIN && user.role !== ROLES.SUPERVISOR)
    throw new Error("FORBIDDEN");
  return user;
}

/**
 * Geographic + organizational scope check.
 * - admin: national, all sites
 * - supervisor/inspector with scope "national": all sites
 * - supervisor/inspector with scope "county": only sites in their county
 * - operator: only sites whose operatorName matches their operatorName
 */
export function canAccessSite(
  user: Doc<"users">,
  site: Doc<"sites">,
): boolean {
  if (user.role === ROLES.ADMIN) return true;
  if (user.role === ROLES.OPERATOR) {
    return !!user.operatorName && site.operatorName === user.operatorName;
  }
  if (user.scope === "national") return true;
  if (user.scope === "county") return user.county === site.county;
  return false;
}

export async function assertSiteAccess(
  ctx: QueryCtx | MutationCtx,
  siteId: Id<"sites">,
): Promise<{ user: Doc<"users">; site: Doc<"sites"> }> {
  const user = await requireUser(ctx);
  const site = await ctx.db.get(siteId);
  if (!site) throw new Error("NOT_FOUND");
  if (!canAccessSite(user, site)) throw new Error("FORBIDDEN");
  return { user, site };
}

/** Append an entry to the immutable audit log. */
export async function logAudit(
  ctx: MutationCtx,
  entry: {
    actorId?: Id<"users">;
    actorLabel: string;
    action: string;
    entityType: string;
    entityId?: string;
    summary: string;
  },
) {
  await ctx.db.insert("auditLog", {
    actorId: entry.actorId,
    actorLabel: entry.actorLabel,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    summary: entry.summary,
    createdAt: Date.now(),
  });
}

/** Generate the next unique site code, e.g. MGL-NIMBA-0007. */
export async function nextSiteCode(
  ctx: MutationCtx,
  county: string,
): Promise<string> {
  const prefix = `MGL-${county.replace(/[^A-Za-z]/g, "").slice(0, 6).toUpperCase() || "XX"}-`;
  const sites = await ctx.db.query("sites").collect();
  let max = 0;
  for (const s of sites) {
    if (s.code.startsWith(prefix)) {
      const n = parseInt(s.code.slice(prefix.length), 10);
      if (!Number.isNaN(n) && n > max) max = n;
    }
  }
  return `${prefix}${String(max + 1).padStart(4, "0")}`;
}
