import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import {
  requireStaff,
  requireAdmin,
  requireUser,
  assertSiteAccess,
  logAudit,
} from "./lib/authz";
import { ROLES } from "./schema";

// ---------------------------------------------------------------------------
// STATISTICS — every number computed from actual stored data. No fake stats.
// ---------------------------------------------------------------------------

export const commandCenter = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireStaff(ctx);

    const sites = await ctx.db.query("sites").collect();
    const inspections = await ctx.db.query("inspections").collect();
    const findings = await ctx.db.query("findings").collect();
    const cas = await ctx.db.query("correctiveActions").collect();
    const incidents = await ctx.db.query("incidents").collect();
    const env = await ctx.db.query("environmentalObservations").collect();
    const reports = await ctx.db.query("communityReports").collect();
    const now = Date.now();

    // Scope filter: which sites may this user see?
    const visibleSites: typeof sites = [];
    for (const s of sites) {
      const site = s; // stable ref
      if (user.role === ROLES.ADMIN || user.scope === "national") {
        visibleSites.push(site);
      } else if (user.scope === "county" && user.county === site.county) {
        visibleSites.push(site);
      }
    }
    const visibleIds = new Set(visibleSites.map((s) => s._id));

    const countBy = <K extends keyof (typeof incidents)[number]>(arr: (typeof incidents)[number][], key: K) => {
      const m: Record<string, number> = {};
      for (const item of arr) {
        const k = String(item[key]);
        m[k] = (m[k] ?? 0) + 1;
      }
      return m;
    };

    const visInspections = inspections.filter((i) => visibleIds.has(i.siteId));
    const visFindings = findings.filter((f) => visibleIds.has(f.siteId));
    const visCas = cas.filter((c) => visibleIds.has(c.siteId));
    const visIncidents = incidents.filter((i) => visibleIds.has(i.siteId));
    const visEnv = env.filter((o) => visibleIds.has(o.siteId));

    const openCa = visCas.filter((c) => c.status !== "closed" && c.status !== "verified");
    const overdueCa = openCa.filter((c) => c.dueAt < now);
    const fatalities = visIncidents.filter((i) => i.type === "fatality").reduce((a, i) => a + (i.fatalities ?? (i.type === "fatality" ? 1 : 0)), 0);

    // Environmental "alerts" = open observations that are measured/verified.
    const envAlerts = visEnv.filter(
      (o) => o.status !== "resolved" && (o.verification === "measured" || o.verification === "verified"),
    );

    // Inspection coverage: sites that have at least one approved inspection.
    const approved = new Set(visInspections.filter((i) => i.status === "approved").map((i) => i.siteId));
    const coverage = visibleSites.length === 0
      ? 0
      : Math.round((approved.size / visibleSites.length) * 100);

    // County breakdown of visible sites.
    const countyCounts: Record<string, number> = {};
    for (const s of visibleSites) {
      countyCounts[s.county] = (countyCounts[s.county] ?? 0) + 1;
    }

    return {
      scope: user.scope ?? "national",
      sites: visibleSites.length,
      activeSites: visibleSites.filter((s) => s.status === "active").length,
      inspectionsTotal: visInspections.length,
      inspectionsUnderReview: visInspections.filter((i) => i.status === "under_review").length,
      findingsTotal: visFindings.length,
      findingsCriticalOpen: visFindings.filter((f) => f.severity === "critical" && (f.status === "open" || f.status === "acknowledged")).length,
      correctiveActionsOpen: openCa.length,
      correctiveActionsOverdue: overdueCa.length,
      incidentsTotal: visIncidents.length,
      fatalities,
      envAlerts: envAlerts.length,
      envByCategory: countBy(visEnv as unknown as (typeof incidents)[number][], "category" as never),
      communityReports: reports.length,
      communityReportsPending: reports.filter((r) => r.status === "submitted").length,
      inspectionCoveragePct: coverage,
      countyCounts,
      incidentTypes: countBy(visIncidents, "type"),
    };
  },
});

// ---------------------------------------------------------------------------
// AUDIT LOG — staff-visible trail of consequential actions.
// ---------------------------------------------------------------------------
export const recentAuditLog = query({
  args: {},
  handler: async (ctx) => {
    await requireStaff(ctx);
    return await ctx.db
      .query("auditLog")
      .withIndex("by_created")
      .order("desc")
      .take(200);
  },
});

// ---------------------------------------------------------------------------
// PUBLIC — aggregate, non-sensitive counts for the landing page.
// Never exposes descriptions, coordinates, or any record content.
// ---------------------------------------------------------------------------
export const publicStats = query({
  args: {},
  handler: async (ctx) => {
    const sites = await ctx.db.query("sites").collect();
    const inspections = await ctx.db.query("inspections").collect();
    const incidents = await ctx.db.query("incidents").collect();
    const reports = await ctx.db.query("communityReports").collect();
    return {
      sites: sites.length,
      inspections: inspections.length,
      incidents: incidents.length,
      communityReports: reports.length,
    };
  },
});

// ---------------------------------------------------------------------------
// USER MANAGEMENT (admin assigns roles; audit logged)
// ---------------------------------------------------------------------------

export const listUsers = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return await ctx.db.query("users").collect();
  },
});

export const setUserRole = mutation({
  args: {
    userId: v.id("users"),
    role: v.union(
      v.literal(ROLES.ADMIN),
      v.literal(ROLES.SUPERVISOR),
      v.literal(ROLES.INSPECTOR),
      v.literal(ROLES.OPERATOR),
    ),
    scope: v.optional(
      v.union(v.literal("national"), v.literal("county"), v.literal("site")),
    ),
    county: v.optional(v.string()),
    operatorName: v.optional(v.string()),
  },
  handler: async (ctx, { userId, role, scope, county, operatorName }) => {
    const user = await requireAdmin(ctx);
    const target = await ctx.db.get(userId);
    if (!target) throw new Error("NOT_FOUND");
    await ctx.db.patch(userId, {
      role,
      scope: scope ?? target.scope,
      county: county ?? target.county,
      operatorName: operatorName ?? target.operatorName,
      profileComplete: true,
    });
    await logAudit(ctx, {
      actorId: user._id,
      actorLabel: user.email ?? user._id,
      action: "user.role.set",
      entityType: "users",
      entityId: userId,
      summary: `Role ${role} assigned to ${target.email ?? target._id}`,
    });
  },
});

/** Admin provisions a role by email; fails if the email has not signed up yet. */
export const provisionByEmail = mutation({
  args: {
    email: v.string(),
    role: v.union(
      v.literal(ROLES.ADMIN),
      v.literal(ROLES.SUPERVISOR),
      v.literal(ROLES.INSPECTOR),
      v.literal(ROLES.OPERATOR),
    ),
    scope: v.union(v.literal("national"), v.literal("county"), v.literal("site")),
    county: v.optional(v.string()),
    operatorName: v.optional(v.string()),
  },
  handler: async (ctx, { email, role, scope, county, operatorName }) => {
    const user = await requireAdmin(ctx);
    const target = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email.toLowerCase()))
      .unique();
    if (!target) throw new Error("USER_NOT_FOUND: that email has not signed in yet");
    await ctx.db.patch(target._id, {
      role,
      scope,
      county: county ?? target.county,
      operatorName: operatorName ?? target.operatorName,
      profileComplete: true,
    });
    await logAudit(ctx, {
      actorId: user._id,
      actorLabel: user.email ?? user._id,
      action: "user.role.set",
      entityType: "users",
      entityId: target._id,
      summary: `Role ${role} (${scope}) assigned to ${email}`,
    });
  },
});

// Self-service: new staff users declare scope details; operators declare org.
export const completeProfile = mutation({
  args: {
    jobTitle: v.string(),
    organization: v.string(),
    scope: v.optional(
      v.union(v.literal("national"), v.literal("county"), v.literal("site")),
    ),
    county: v.optional(v.string()),
    operatorName: v.optional(v.string()),
  },
  handler: async (ctx, { jobTitle, organization, scope, county, operatorName }) => {
    const user = await requireUser(ctx);
    await ctx.db.patch(user._id, {
      jobTitle,
      organization,
      scope: scope ?? user.scope,
      county: county ?? user.county,
      operatorName: operatorName ?? user.operatorName,
      profileComplete: true,
      role: user.role ?? ROLES.INSPECTOR,
    });
    await logAudit(ctx, {
      actorId: user._id,
      actorLabel: user.email ?? user._id,
      action: "user.profile.complete",
      entityType: "users",
      entityId: user._id,
      summary: `Profile completed for ${user.email ?? user._id}`,
    });
  },
});
