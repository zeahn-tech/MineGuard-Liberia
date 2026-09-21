import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { requireUser, logAudit, nextSiteCode } from "./lib/authz";

/**
 * DEV SEED — inserts representative demo data ONLY when the database is empty.
 * These are synthetic demonstration records, clearly not real government data.
 * Provenance for every seeded record is the authenticated account that runs
 * the seed, so authorship fields remain truthful.
 */
export const seedIfEmpty = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const existing = await ctx.db.query("sites").collect();
    if (existing.length > 0) {
      return { seeded: false, reason: "not_empty" as const };
    }

    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    // --- Sites (synthetic demo registry) ---
    const siteDefs = [
      { name: "Demo Gold Operation — Zorzor Corridor", operatorName: "Lofa Minerals Demo", county: "Lofa", district: "Zorzor", community: "Zorzor City", mineralType: "Gold", lat: 7.6067, lng: 9.4236 },
      { name: "Demo Iron Ore Quarry — Yekepa", operatorName: "Nimba Aggregates Demo", county: "Nimba", district: "Sanniquellie-Mahn", community: "Yekepa", mineralType: "Iron Ore", lat: 7.5989, lng: 8.6333 },
      { name: "Demo Alluvial Site — Saniquellie", operatorName: "Nimba Aggregates Demo", county: "Nimba", district: "Sanniquellie-Mahn", community: "Saniquellie", mineralType: "Alluvial Gold", lat: 7.5806, lng: 8.7236 },
      { name: "Demo Sand Mining — Robertsport", operatorName: "Grand Cape Coastal Demo", county: "Grand Cape Mount", district: "Robertsport", community: "Robertsport", mineralType: "Sand", lat: 6.7572, lng: 11.3686 },
      { name: "Demo Artisanal Camp — Gbarpolu", operatorName: "Gbarpolu Artisanal Demo", county: "Gbarpolu", district: "Bopolu", community: "Bopolu", mineralType: "Gold", lat: 6.7236, lng: 9.7167 },
      { name: "Demo Basalt Pit — Ganta", operatorName: "Nimba Aggregates Demo", county: "Nimba", district: "Gba & Ma", community: "Ganta", mineralType: "Basalt", lat: 7.2194, lng: 8.9833 },
    ];

    const siteIds: Record<
      string,
      { id: Id<"sites">; code: string; county: string }
    > = {};
    for (const def of siteDefs) {
      const code = await nextSiteCode(ctx, def.county);
      const id = await ctx.db.insert("sites", {
        code,
        name: def.name,
        operatorName: def.operatorName,
        mineralType: def.mineralType,
        county: def.county,
        district: def.district,
        community: def.community,
        status: "active",
        latitude: def.lat,
        longitude: def.lng,
        notes: "Synthetic demonstration record — not real operational data.",
        createdBy: user._id,
        createdAt: now,
      });
      siteIds[def.name] = { id, code, county: def.county };
    }

    // --- Inspection template (configurable) ---
    const templateId = await ctx.db.insert("inspectionTemplates", {
      name: "Standard Mining Safety & Environmental Inspection",
      description:
        "Configurable baseline template used by field inspectors. Sections and questions can be edited by administrators.",
      active: true,
      createdBy: user._id,
      createdAt: now,
      sections: [
        {
          title: "Site & Workforce Safety",
          questions: [
            { label: "Are workers wearing required PPE?", answerType: "boolean" as const, required: true },
            { label: "Is a trained safety officer present on site?", answerType: "boolean" as const, required: true },
            { label: "Number of workers observed on site", answerType: "number" as const, required: true },
            { label: "Overall safety condition", answerType: "select" as const, options: ["Good", "Fair", "Poor", "Immediate risk"], required: true },
          ],
        },
        {
          title: "Equipment & Infrastructure",
          questions: [
            { label: "Equipment inspected and maintained?", answerType: "boolean" as const, required: true },
            { label: "Any structural defects observed?", answerType: "boolean" as const, required: true },
            { label: "Describe defects or concerns", answerType: "text" as const, required: false },
          ],
        },
        {
          title: "Environmental Condition",
          questions: [
            { label: "Signs of water pollution or sediment discharge?", answerType: "boolean" as const, required: true },
            { label: "Waste and tailings properly managed?", answerType: "boolean" as const, required: true },
            { label: "Additional environmental observations", answerType: "text" as const, required: false },
          ],
        },
        {
          title: "Administrative",
          questions: [
            { label: "Site records available for review?", answerType: "boolean" as const, required: true },
            { label: "Inspector notes", answerType: "text" as const, required: false },
          ],
        },
      ],
    });

    // --- Inspections, findings, corrective actions, incidents, observations ---
    const zorzor = siteIds["Demo Gold Operation — Zorzor Corridor"];
    const yekepa = siteIds["Demo Iron Ore Quarry — Yekepa"];
    const robertsport = siteIds["Demo Sand Mining — Robertsport"];

    const insp1 = await ctx.db.insert("inspections", {
      siteId: zorzor.id,
      templateId,
      inspectorId: user._id,
      status: "approved",
      answers: {
        "0:0": true,
        "0:1": true,
        "0:2": 24,
        "0:3": "Fair",
        "1:0": true,
        "1:1": false,
        "2:0": true,
        "2:1": false,
        "3:0": true,
      },
      notes: "Routine inspection; PPE compliance observed at both pits.",
      latitude: 7.6067,
      longitude: 9.4236,
      submittedAt: now - 6 * day,
      reviewedAt: now - 5 * day,
      createdAt: now - 7 * day,
    });

    const f1 = await ctx.db.insert("findings", {
      inspectionId: insp1,
      siteId: zorzor.id,
      title: "Sediment discharge into seasonal stream",
      description: "Uncontrolled runoff from the processing area entering the stream.",
      severity: "high",
      status: "acknowledged",
      createdById: user._id,
      createdAt: now - 6 * day,
    });

    await ctx.db.insert("correctiveActions", {
      findingId: f1,
      siteId: zorzor.id,
      description: "Construct sediment settling basin before discharge point.",
      status: "in_progress",
      dueAt: now + 14 * day,
      openedById: user._id,
      createdAt: now - 5 * day,
    });

    const insp2 = await ctx.db.insert("inspections", {
      siteId: yekepa.id,
      templateId,
      inspectorId: user._id,
      status: "under_review",
      answers: {
        "0:0": true,
        "0:1": false,
        "0:2": 11,
        "0:3": "Fair",
        "1:0": true,
        "1:1": true,
        "1:2": "Berms eroded on eastern section.",
        "2:0": false,
        "2:1": true,
        "3:0": true,
      },
      notes: "Haul-road inspection; berms low on the eastern section.",
      latitude: 7.5989,
      longitude: 8.6333,
      submittedAt: now - 2 * day,
      createdAt: now - 3 * day,
    });

    await ctx.db.insert("findings", {
      inspectionId: insp2,
      siteId: yekepa.id,
      title: "Haul-road berms below required height",
      description: "Eastern section berms measured below 1.5m at three points.",
      severity: "medium",
      status: "open",
      createdById: user._id,
      createdAt: now - 2 * day,
    });

    await ctx.db.insert("incidents", {
      siteId: robertsport.id,
      type: "injury",
      severity: "medium",
      description: "Worker laceration from handling screen mesh; treated on site.",
      occurredAt: now - 4 * day,
      injured: 1,
      status: "investigating",
      reportedById: user._id,
      reportSource: "inspector",
      createdAt: now - 4 * day,
    });

    await ctx.db.insert("environmentalObservations", {
      siteId: zorzor.id,
      category: "water_pollution",
      verification: "measured",
      description: "Turbidity downstream visibly elevated; sample taken for analysis.",
      observedAt: now - 5 * day,
      latitude: 7.6067,
      longitude: 9.4236,
      status: "monitoring",
      reportedById: user._id,
      createdAt: now - 5 * day,
    });

    await ctx.db.insert("communityReports", {
      trackingCode: "CR-DEMO0001",
      category: "pollution",
      description: "Community reports discolored water in the creek used for washing.",
      county: "Lofa",
      community: "Zorzor City",
      status: "under_review",
      createdAt: now - 3 * day,
    });

    await ctx.db.insert("communityReports", {
      trackingCode: "CR-DEMO0002",
      category: "suspected_illegal_mining",
      description: "Unknown digging activity observed after dark near the ridge.",
      county: "Nimba",
      community: "Yekepa",
      status: "submitted",
      createdAt: now - 1 * day,
    });

    await logAudit(ctx, {
      actorId: user._id,
      actorLabel: user.email ?? user._id,
      action: "system.seed",
      entityType: "sites",
      summary: "Dev seed data inserted (synthetic demonstration records only)",
    });

    return { seeded: true as const };
  },
});

/** Read-only seed state check. */
export const checkSeeded = query({
  args: {},
  handler: async (ctx) => {
    const sites = await ctx.db.query("sites").collect();
    return { siteCount: sites.length };
  },
});
