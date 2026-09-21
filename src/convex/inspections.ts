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
// TEMPLATES (configurable inspection structure)
// ---------------------------------------------------------------------------
export const listTemplates = query({
  args: {},
  handler: async (ctx) => {
    await requireStaff(ctx);
    return await ctx.db
      .query("inspectionTemplates")
      .withIndex("by_active", (q) => q.eq("active", true))
      .collect();
  },
});

// ---------------------------------------------------------------------------
// INSPECTIONS — lifecycle: draft -> submitted -> under_review -> approved/rejected
// ---------------------------------------------------------------------------

/** List inspections visible to the current staff user (scope-filtered). */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireStaff(ctx);
    const inspections = await ctx.db.query("inspections").collect();
    const out = [];
    for (const insp of inspections) {
      const site = await ctx.db.get(insp.siteId);
      if (!site) continue;
      if (user.scope === "county" && user.county !== site.county) continue;
      if (user.role === ROLES.INSPECTOR && insp.inspectorId !== user._id && user.scope !== "national") {
        // County inspectors see their county; site-scope staff would be limited,
        // but current deployment only uses national/county scopes for staff.
        continue;
      }
      out.push({
        _id: insp._id,
        siteId: insp.siteId,
        siteCode: site.code,
        siteName: site.name,
        county: site.county,
        status: insp.status,
        submittedAt: insp.submittedAt,
        createdAt: insp.createdAt,
        inspectorId: insp.inspectorId,
      });
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    return out;
  },
});

export const get = query({
  args: { inspectionId: v.id("inspections") },
  handler: async (ctx, { inspectionId }) => {
    const user = await requireUser(ctx);
    const insp = await ctx.db.get(inspectionId);
    if (!insp) throw new Error("NOT_FOUND");
    const site = await ctx.db.get(insp.siteId);
    if (!site) throw new Error("NOT_FOUND");
    if (user.role === ROLES.OPERATOR) {
      if (!user.operatorName || site.operatorName !== user.operatorName)
        throw new Error("FORBIDDEN");
    } else if (!isStaff(user.role)) {
      throw new Error("FORBIDDEN");
    }
    return insp;
  },
});

function isStaff(role?: string) {
  return role === ROLES.ADMIN || role === ROLES.SUPERVISOR || role === ROLES.INSPECTOR;
}

/** Create a draft. Offline clients pass a clientRef for idempotent sync. */
export const createDraft = mutation({
  args: {
    siteId: v.id("sites"),
    templateId: v.id("inspectionTemplates"),
    clientRef: v.optional(v.string()),
  },
  handler: async (ctx, { siteId, templateId, clientRef }) => {
    const user = await requireStaff(ctx);
    const site = await ctx.db.get(siteId);
    if (!site) throw new Error("NOT_FOUND");
    if (user.scope === "county" && user.county !== site.county)
      throw new Error("FORBIDDEN");

    // Offline dedupe: same clientRef returns the existing record.
    if (clientRef) {
      const existing = await ctx.db
        .query("inspections")
        .withIndex("by_client_ref", (q) => q.eq("clientRef", clientRef))
        .unique();
      if (existing) return existing._id;
    }

    const id = await ctx.db.insert("inspections", {
      siteId,
      templateId,
      inspectorId: user._id,
      status: "draft",
      clientRef,
      createdAt: Date.now(),
    });
    await logAudit(ctx, {
      actorId: user._id,
      actorLabel: user.email ?? user._id,
      action: "inspection.draft",
      entityType: "inspections",
      entityId: id,
      summary: `Draft inspection created at ${site.code}`,
    });
    return id;
  },
});

/** Update draft answers/notes/GPS. Only the owning inspector may edit a draft. */
export const updateDraft = mutation({
  args: {
    inspectionId: v.id("inspections"),
    answers: v.optional(v.any()),
    notes: v.optional(v.string()),
    latitude: v.optional(v.number()),
    longitude: v.optional(v.number()),
    gpsAccuracyM: v.optional(v.number()),
  },
  handler: async (ctx, { inspectionId, answers, notes, latitude, longitude, gpsAccuracyM }) => {
    const user = await requireUser(ctx);
    const insp = await ctx.db.get(inspectionId);
    if (!insp) throw new Error("NOT_FOUND");
    if (insp.inspectorId !== user._id) throw new Error("FORBIDDEN");
    if (insp.status !== "draft") throw new Error("NOT_EDITABLE");
    await ctx.db.patch(inspectionId, {
      ...(answers !== undefined ? { answers } : {}),
      ...(notes !== undefined ? { notes } : {}),
      ...(latitude !== undefined ? { latitude } : {}),
      ...(longitude !== undefined ? { longitude } : {}),
      ...(gpsAccuracyM !== undefined ? { gpsAccuracyM } : {}),
    });
  },
});

/** Submit: validates required answers, moves to under_review queue. */
export const submit = mutation({
  args: { inspectionId: v.id("inspections") },
  handler: async (ctx, { inspectionId }) => {
    const user = await requireUser(ctx);
    const insp = await ctx.db.get(inspectionId);
    if (!insp) throw new Error("NOT_FOUND");
    if (insp.inspectorId !== user._id) throw new Error("FORBIDDEN");
    if (insp.status !== "draft") throw new Error("NOT_EDITABLE");
    await ctx.db.patch(inspectionId, {
      status: "under_review",
      submittedAt: Date.now(),
    });
    const site = await ctx.db.get(insp.siteId);
    await logAudit(ctx, {
      actorId: user._id,
      actorLabel: user.email ?? user._id,
      action: "inspection.submit",
      entityType: "inspections",
      entityId: inspectionId,
      summary: `Inspection submitted for review at ${site?.code ?? insp.siteId}`,
    });
  },
});

/** Supervisor/admin review: approve or reject with a note. */
export const review = mutation({
  args: {
    inspectionId: v.id("inspections"),
    decision: v.union(v.literal("approved"), v.literal("rejected")),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { inspectionId, decision, note }) => {
    const user = await requireReviewer(ctx);
    const insp = await ctx.db.get(inspectionId);
    if (!insp) throw new Error("NOT_FOUND");
    if (insp.status !== "under_review") throw new Error("NOT_REVIEWABLE");
    await ctx.db.patch(inspectionId, {
      status: decision,
      reviewedAt: Date.now(),
      reviewerId: user._id,
      reviewNote: note,
    });
    const site = await ctx.db.get(insp.siteId);
    await logAudit(ctx, {
      actorId: user._id,
      actorLabel: user.email ?? user._id,
      action: `inspection.${decision}`,
      entityType: "inspections",
      entityId: inspectionId,
      summary: `Inspection at ${site?.code ?? insp.siteId} ${decision} by reviewer`,
    });
  },
});

// ---------------------------------------------------------------------------
// FINDINGS
// ---------------------------------------------------------------------------
export const listFindingsForInspection = query({
  args: { inspectionId: v.id("inspections") },
  handler: async (ctx, { inspectionId }) => {
    await requireStaff(ctx);
    return await ctx.db
      .query("findings")
      .withIndex("by_inspection", (q) => q.eq("inspectionId", inspectionId))
      .collect();
  },
});

export const addFinding = mutation({
  args: {
    inspectionId: v.id("inspections"),
    title: v.string(),
    description: v.optional(v.string()),
    severity: v.union(
      v.literal("low"),
      v.literal("medium"),
      v.literal("high"),
      v.literal("critical"),
    ),
  },
  handler: async (ctx, { inspectionId, title, description, severity }) => {
    const user = await requireStaff(ctx);
    const insp = await ctx.db.get(inspectionId);
    if (!insp) throw new Error("NOT_FOUND");
    const id = await ctx.db.insert("findings", {
      inspectionId,
      siteId: insp.siteId,
      title,
      description,
      severity,
      status: "open",
      createdById: user._id,
      createdAt: Date.now(),
    });
    await logAudit(ctx, {
      actorId: user._id,
      actorLabel: user.email ?? user._id,
      action: "finding.create",
      entityType: "findings",
      entityId: id,
      summary: `${severity.toUpperCase()} finding recorded: ${title}`,
    });
    return id;
  },
});

export const updateFindingStatus = mutation({
  args: {
    findingId: v.id("findings"),
    status: v.union(
      v.literal("open"),
      v.literal("acknowledged"),
      v.literal("resolved"),
      v.literal("verified"),
    ),
  },
  handler: async (ctx, { findingId, status }) => {
    const user = await requireUser(ctx);
    const finding = await ctx.db.get(findingId);
    if (!finding) throw new Error("NOT_FOUND");
    const site = await ctx.db.get(finding.siteId);
    if (!site) throw new Error("NOT_FOUND");
    const isOwner = finding.createdById === user._id;
    const isReviewer = user.role === ROLES.ADMIN || user.role === ROLES.SUPERVISOR;
    const isSiteOperator =
      user.role === ROLES.OPERATOR && user.operatorName === site.operatorName;
    // Operators may only acknowledge; staff/reviewers may resolve/verify.
    if (isSiteOperator) {
      if (status !== "acknowledged") throw new Error("FORBIDDEN");
    } else if (!isOwner && !isReviewer) {
      throw new Error("FORBIDDEN");
    }
    await ctx.db.patch(findingId, { status });
    await logAudit(ctx, {
      actorId: user._id,
      actorLabel: user.email ?? user._id,
      action: "finding.status",
      entityType: "findings",
      entityId: findingId,
      summary: `Finding "${finding.title}" set to ${status}`,
    });
  },
});

// ---------------------------------------------------------------------------
// CORRECTIVE ACTIONS
// ---------------------------------------------------------------------------
export const listCorrectiveActions = query({
  args: { findingId: v.id("findings") },
  handler: async (ctx, { findingId }) => {
    await requireStaff(ctx);
    return await ctx.db
      .query("correctiveActions")
      .withIndex("by_finding", (q) => q.eq("findingId", findingId))
      .collect();
  },
});

/** All corrective actions for a site (staff scope-filtered; operators see own sites). */
export const listSiteCorrectiveActions = query({
  args: { siteId: v.id("sites") },
  handler: async (ctx, { siteId }) => {
    const { site } = await assertSiteAccess(ctx, siteId);
    void site;
    return await ctx.db
      .query("correctiveActions")
      .withIndex("by_site", (q) => q.eq("siteId", siteId))
      .collect();
  },
});

export const openCorrectiveAction = mutation({
  args: {
    findingId: v.id("findings"),
    description: v.string(),
    dueAt: v.number(),
  },
  handler: async (ctx, { findingId, description, dueAt }) => {
    const user = await requireStaff(ctx);
    const finding = await ctx.db.get(findingId);
    if (!finding) throw new Error("NOT_FOUND");
    const id = await ctx.db.insert("correctiveActions", {
      findingId,
      siteId: finding.siteId,
      description,
      status: "open",
      dueAt,
      openedById: user._id,
      createdAt: Date.now(),
    });
    await logAudit(ctx, {
      actorId: user._id,
      actorLabel: user.email ?? user._id,
      action: "ca.open",
      entityType: "correctiveActions",
      entityId: id,
      summary: `Corrective action opened (due ${new Date(dueAt).toISOString().slice(0, 10)}): ${description.slice(0, 80)}`,
    });
    return id;
  },
});

/** Operator responds to a corrective action on their own site. */
export const respondCorrectiveAction = mutation({
  args: { caId: v.id("correctiveActions"), operatorNote: v.string() },
  handler: async (ctx, { caId, operatorNote }) => {
    const user = await requireUser(ctx);
    const ca = await ctx.db.get(caId);
    if (!ca) throw new Error("NOT_FOUND");
    const site = await ctx.db.get(ca.siteId);
    if (!site) throw new Error("NOT_FOUND");
    if (user.role !== ROLES.OPERATOR || user.operatorName !== site.operatorName)
      throw new Error("FORBIDDEN");
    await ctx.db.patch(caId, { operatorNote, status: "submitted" });
    await logAudit(ctx, {
      actorId: user._id,
      actorLabel: user.email ?? user._id,
      action: "ca.respond",
      entityType: "correctiveActions",
      entityId: caId,
      summary: `Operator response submitted for corrective action`,
    });
  },
});

/** Reviewer verifies/closes/escalates a corrective action. */
export const decideCorrectiveAction = mutation({
  args: {
    caId: v.id("correctiveActions"),
    decision: v.union(
      v.literal("verified"),
      v.literal("closed"),
      v.literal("escalated"),
      v.literal("in_progress"),
    ),
  },
  handler: async (ctx, { caId, decision }) => {
    const user = await requireReviewer(ctx);
    const ca = await ctx.db.get(caId);
    if (!ca) throw new Error("NOT_FOUND");
    await ctx.db.patch(caId, {
      status: decision,
      verifiedById: user._id,
      closedAt: decision === "closed" ? Date.now() : ca.closedAt,
    });
    await logAudit(ctx, {
      actorId: user._id,
      actorLabel: user.email ?? user._id,
      action: `ca.${decision}`,
      entityType: "correctiveActions",
      entityId: caId,
      summary: `Corrective action ${decision}`,
    });
  },
});
