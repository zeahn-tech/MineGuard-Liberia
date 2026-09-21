import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import {
  requireStaff,
  requireAdmin,
  assertSiteAccess,
  canAccessSite,
  logAudit,
  nextSiteCode,
} from "./lib/authz";

/** Registry listing, filtered server-side by role and geographic scope. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireStaff(ctx);
    const all = await ctx.db.query("sites").collect();
    const visible = all
      .filter((s) => canAccessSite(user, s))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Compute open corrective actions per site for the list view.
    const allCas = await ctx.db.query("correctiveActions").collect();
    const cas = allCas.filter((c) => c.status !== "closed");
    const openBySite = new Map<string, number>();
    for (const ca of cas) {
      openBySite.set(ca.siteId, (openBySite.get(ca.siteId) ?? 0) + 1);
    }

    return visible.map((s) => ({
      ...s,
      openActions: openBySite.get(s._id) ?? 0,
    }));
  },
});

export const get = query({
  args: { siteId: v.id("sites") },
  handler: async (ctx, { siteId }) => {
    const { site } = await assertSiteAccess(ctx, siteId);
    return site;
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    operatorName: v.string(),
    county: v.string(),
    district: v.optional(v.string()),
    community: v.optional(v.string()),
    mineralType: v.optional(v.string()),
    latitude: v.optional(v.number()),
    longitude: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireAdmin(ctx);
    const code = await nextSiteCode(ctx, args.county);
    const siteId = await ctx.db.insert("sites", {
      ...args,
      status: "pending_verification",
      code,
      createdBy: user._id,
      createdAt: Date.now(),
    });
    await logAudit(ctx, {
      actorId: user._id,
      actorLabel: user.email ?? user.name ?? user._id,
      action: "site.create",
      entityType: "sites",
      entityId: siteId,
      summary: `Registered site ${code} (${args.name}) in ${args.county}`,
    });
    return siteId;
  },
});

export const setStatus = mutation({
  args: { siteId: v.id("sites"), status: v.string() },
  handler: async (ctx, { siteId, status }) => {
    const user = await requireAdmin(ctx);
    const { site } = await assertSiteAccess(ctx, siteId);
    if (!["active", "suspended", "closed", "pending_verification"].includes(status)) {
      throw new Error("INVALID_STATUS");
    }
    await ctx.db.patch(siteId, { status: status as never });
    await logAudit(ctx, {
      actorId: user._id,
      actorLabel: user.email ?? user._id,
      action: "site.status",
      entityType: "sites",
      entityId: siteId,
      summary: `Site ${site.code} status set to ${status}`,
    });
  },
});

/** Risk indicator per site: explainable, configurable weights, auditable. */
export const riskScores = query({
  args: {},
  handler: async (ctx) => {
    await requireStaff(ctx);
    const sites = await ctx.db.query("sites").collect();
    const findings = await ctx.db.query("findings").collect();
    const cas = await ctx.db.query("correctiveActions").collect();
    const incidents = await ctx.db.query("incidents").collect();
    const env = await ctx.db.query("environmentalObservations").collect();
    const now = Date.now();

    // Configurable weights — tuned by the program owner, not hardcoded law.
    const W = {
      criticalFinding: 10,
      highFinding: 6,
      mediumFinding: 3,
      lowFinding: 1,
      repeatFinding: 4, // per additional finding beyond the first at a site
      overdueCA: 8,
      fatality: 15,
      seriousIncident: 7,
      envAlert: 5,
    };

    const out: Record<
      string,
      { score: number; factors: { label: string; points: number }[] }
    > = {};
    for (const site of sites) {
      const factors: { label: string; points: number }[] = [];
      const siteFindings = findings.filter((f) => f.siteId === site._id);
      let points = 0;
      const sevCount: Record<string, number> = { low: 0, medium: 0, high: 0, critical: 0 };
      for (const f of siteFindings) {
        const p =
          f.severity === "critical"
            ? W.criticalFinding
            : f.severity === "high"
              ? W.highFinding
              : f.severity === "medium"
                ? W.mediumFinding
                : W.lowFinding;
        points += p;
        sevCount[f.severity]++;
      }
      if (sevCount.critical) factors.push({ label: `${sevCount.critical} critical finding(s)`, points: sevCount.critical * W.criticalFinding });
      if (sevCount.high) factors.push({ label: `${sevCount.high} high finding(s)`, points: sevCount.high * W.highFinding });
      if (sevCount.medium) factors.push({ label: `${sevCount.medium} medium finding(s)`, points: sevCount.medium * W.mediumFinding });
      if (sevCount.low) factors.push({ label: `${sevCount.low} low finding(s)`, points: sevCount.low * W.lowFinding });

      const resolvedSet = new Set(siteFindings.map((f) => f.title));
      const resolvedCount = siteFindings.filter(
        (f) => f.status === "resolved" || f.status === "verified",
      ).length;
      const repeatFactor = siteFindings.length > 3 ? W.repeatFinding * Math.floor(siteFindings.length / 4) : 0;
      if (repeatFactor) factors.push({ label: "Repeat findings at site", points: repeatFactor });
      points += repeatFactor;

      const overdue = cas.filter(
        (c) =>
          c.siteId === site._id &&
          c.status !== "closed" &&
          c.status !== "verified" &&
          c.dueAt < now,
      ).length;
      if (overdue) {
        factors.push({ label: `${overdue} overdue corrective action(s)`, points: overdue * W.overdueCA });
        points += overdue * W.overdueCA;
      }

      const fatalities = incidents
        .filter((i) => i.siteId === site._id && i.type === "fatality")
        .length;
      if (fatalities) {
        factors.push({ label: `${fatalities} fatality incident(s)`, points: fatalities * W.fatality });
        points += fatalities * W.fatality;
      }
      const serious = incidents.filter(
        (i) =>
          i.siteId === site._id &&
          i.type !== "fatality" &&
          (i.severity === "critical" || i.severity === "high"),
      ).length;
      if (serious) {
        factors.push({ label: `${serious} serious incident(s)`, points: serious * W.seriousIncident });
        points += serious * W.seriousIncident;
      }
      const envAlerts = env.filter(
        (o) =>
          o.siteId === site._id &&
          o.status !== "resolved" &&
          (o.verification === "measured" || o.verification === "verified"),
      ).length;
      if (envAlerts) {
        factors.push({ label: `${envAlerts} verified environmental alert(s)`, points: envAlerts * W.envAlert });
        points += envAlerts * W.envAlert;
      }

      out[site._id] = { score: points, factors };
    }
    return out;
  },
});
