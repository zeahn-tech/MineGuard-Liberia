import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import {
  requireStaff,
  requireReviewer,
  requireUser,
  assertSiteAccess,
  logAudit,
} from "./lib/authz";
import { ROLES } from "./schema";

// ---------------------------------------------------------------------------
// INCIDENTS
// Configurable types. Categories here are operational, not legal classifications.
// ---------------------------------------------------------------------------
export const listIncidents = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const incidents = await ctx.db.query("incidents").collect();
    const out = [];
    for (const inc of incidents) {
      const site = await ctx.db.get(inc.siteId);
      if (!site) continue;
      if (user.role === ROLES.OPERATOR) {
        if (!user.operatorName || site.operatorName !== user.operatorName) continue;
      }
      out.push({ ...inc, siteCode: site.code, siteName: site.name, county: site.county });
    }
    out.sort((a, b) => b.occurredAt - a.occurredAt);
    return out;
  },
});

export const reportIncident = mutation({
  args: {
    siteId: v.id("sites"),
    type: v.union(
      v.literal("fatality"),
      v.literal("injury"),
      v.literal("near_miss"),
      v.literal("equipment_accident"),
      v.literal("vehicle_accident"),
      v.literal("fire"),
      v.literal("structural_failure"),
      v.literal("chemical_exposure"),
      v.literal("environmental"),
      v.literal("other"),
    ),
    severity: v.union(
      v.literal("low"),
      v.literal("medium"),
      v.literal("high"),
      v.literal("critical"),
    ),
    description: v.string(),
    occurredAt: v.number(),
    fatalities: v.optional(v.number()),
    injured: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { user, site } = await assertSiteAccess(ctx, args.siteId);
    const id = await ctx.db.insert("incidents", {
      siteId: args.siteId,
      type: args.type,
      severity: args.severity,
      description: args.description,
      occurredAt: args.occurredAt,
      fatalities: args.fatalities,
      injured: args.injured,
      status: "reported",
      reportedById: user._id,
      reportSource: user.role === ROLES.OPERATOR ? "operator" : "inspector",
      createdAt: Date.now(),
    });
    await logAudit(ctx, {
      actorId: user._id,
      actorLabel: user.email ?? user._id,
      action: "incident.report",
      entityType: "incidents",
      entityId: id,
      summary: `${args.type.replace("_", " ")} reported at ${site.code}`,
    });
    return id;
  },
});

export const setIncidentStatus = mutation({
  args: {
    incidentId: v.id("incidents"),
    status: v.union(v.literal("investigating"), v.literal("closed")),
  },
  handler: async (ctx, { incidentId, status }) => {
    const user = await requireStaff(ctx);
    const inc = await ctx.db.get(incidentId);
    if (!inc) throw new Error("NOT_FOUND");
    await ctx.db.patch(incidentId, { status });
    await logAudit(ctx, {
      actorId: user._id,
      actorLabel: user.email ?? user._id,
      action: "incident.status",
      entityType: "incidents",
      entityId: incidentId,
      summary: `Incident status set to ${status}`,
    });
  },
});

// ---------------------------------------------------------------------------
// ENVIRONMENTAL OBSERVATIONS
// Verification state is explicit: observed / measured / verified / unverified / alleged
// ---------------------------------------------------------------------------
export const listObservations = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireStaff(ctx);
    const obs = await ctx.db.query("environmentalObservations").collect();
    const out = [];
    for (const o of obs) {
      const site = await ctx.db.get(o.siteId);
      if (!site) continue;
      if (user.scope === "county" && user.county !== site.county) continue;
      out.push({ ...o, siteCode: site.code, siteName: site.name, county: site.county });
    }
    out.sort((a, b) => b.observedAt - a.observedAt);
    return out;
  },
});

export const reportObservation = mutation({
  args: {
    siteId: v.id("sites"),
    category: v.union(
      v.literal("water_pollution"),
      v.literal("river_disturbance"),
      v.literal("river_diversion"),
      v.literal("deforestation"),
      v.literal("soil_degradation"),
      v.literal("waste"),
      v.literal("tailings"),
      v.literal("chemical_handling"),
      v.literal("rehabilitation"),
      v.literal("land_impact"),
    ),
    verification: v.union(
      v.literal("observed"),
      v.literal("measured"),
      v.literal("verified"),
      v.literal("unverified"),
      v.literal("alleged"),
    ),
    description: v.string(),
    observedAt: v.number(),
    latitude: v.optional(v.number()),
    longitude: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { user, site } = await assertSiteAccess(ctx, args.siteId);
    const id = await ctx.db.insert("environmentalObservations", {
      siteId: args.siteId,
      category: args.category,
      verification: args.verification,
      description: args.description,
      observedAt: args.observedAt,
      latitude: args.latitude,
      longitude: args.longitude,
      status: "open",
      reportedById: user._id,
      createdAt: Date.now(),
    });
    await logAudit(ctx, {
      actorId: user._id,
      actorLabel: user.email ?? user._id,
      action: "observation.report",
      entityType: "environmentalObservations",
      entityId: id,
      summary: `${args.category.replace("_", " ")} (${args.verification}) at ${site.code}`,
    });
    return id;
  },
});

export const setObservationStatus = mutation({
  args: {
    observationId: v.id("environmentalObservations"),
    status: v.union(v.literal("open"), v.literal("monitoring"), v.literal("resolved")),
  },
  handler: async (ctx, { observationId, status }) => {
    const user = await requireStaff(ctx);
    await ctx.db.patch(observationId, { status });
    await logAudit(ctx, {
      actorId: user._id,
      actorLabel: user.email ?? user._id,
      action: "observation.status",
      entityType: "environmentalObservations",
      entityId: observationId,
      summary: `Observation status set to ${status}`,
    });
  },
});

// ---------------------------------------------------------------------------
// COMMUNITY REPORTS
// Public submission -> tracking code -> human triage. A report is a concern,
// never an automatic accusation of guilt.
// ---------------------------------------------------------------------------
export const listCommunityReports = query({
  args: {},
  handler: async (ctx) => {
    await requireStaff(ctx);
    const all = await ctx.db.query("communityReports").collect();
    all.sort((a, b) => b.createdAt - a.createdAt);
    return all;
  },
});

/** Public: anyone may submit a concern. No authentication required. */
export const submitCommunityReport = mutation({
  args: {
    category: v.union(
      v.literal("suspected_illegal_mining"),
      v.literal("pollution"),
      v.literal("environmental_damage"),
      v.literal("safety_concern"),
      v.literal("land_concern"),
      v.literal("unauthorized_activity"),
    ),
    description: v.string(),
    county: v.string(),
    district: v.optional(v.string()),
    community: v.optional(v.string()),
    latitude: v.optional(v.number()),
    longitude: v.optional(v.number()),
    contactPhone: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const trackingCode = `CR-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 36).toString(36).toUpperCase()}`;
    const id = await ctx.db.insert("communityReports", {
      ...args,
      trackingCode,
      status: "submitted",
      createdAt: Date.now(),
    });
    await logAudit(ctx, {
      actorLabel: "public",
      action: "communityReport.submit",
      entityType: "communityReports",
      entityId: id,
      summary: `Public report ${trackingCode} (${args.category}) in ${args.county}`,
    });
    return { id, trackingCode };
  },
});

/** Public: track by code. Returns only coarse, non-sensitive fields. */
export const trackCommunityReport = query({
  args: { trackingCode: v.string() },
  handler: async (ctx, { trackingCode }) => {
    const report = await ctx.db
      .query("communityReports")
      .withIndex("by_tracking_code", (q) => q.eq("trackingCode", trackingCode))
      .unique();
    if (!report) return null;
    return {
      trackingCode: report.trackingCode,
      status: report.status,
      createdAt: report.createdAt,
    };
  },
});

export const triageCommunityReport = mutation({
  args: {
    reportId: v.id("communityReports"),
    decision: v.union(
      v.literal("under_review"),
      v.literal("verified"),
      v.literal("dismissed"),
      v.literal("referred"),
    ),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { reportId, decision, note }) => {
    const user = await requireReviewer(ctx);
    const report = await ctx.db.get(reportId);
    if (!report) throw new Error("NOT_FOUND");
    await ctx.db.patch(reportId, {
      status: decision,
      triageNote: note,
      reviewedById: user._id,
      reviewedAt: Date.now(),
    });
    await logAudit(ctx, {
      actorId: user._id,
      actorLabel: user.email ?? user._id,
      action: "communityReport.triage",
      entityType: "communityReports",
      entityId: reportId,
      summary: `Report ${report.trackingCode} triaged: ${decision}`,
    });
  },
});
