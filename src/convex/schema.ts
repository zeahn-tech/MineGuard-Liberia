import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { Infer, v } from "convex/values";

// ---------------------------------------------------------------------------
// ROLES & SCOPES
// Access is always computed server-side from user profile + record ownership.
// Never trust the client. Frontend hiding is NOT authorization.
// ---------------------------------------------------------------------------
export const ROLES = {
  ADMIN: "admin", // national oversight administrator
  SUPERVISOR: "supervisor", // regional/county supervision, review & approval
  INSPECTOR: "inspector", // field officer: inspections, incidents, observations
  OPERATOR: "operator", // mining operator: own sites only, strict tenant isolation
} as const;

export const roleValidator = v.union(
  v.literal(ROLES.ADMIN),
  v.literal(ROLES.SUPERVISOR),
  v.literal(ROLES.INSPECTOR),
  v.literal(ROLES.OPERATOR),
);
export type Role = Infer<typeof roleValidator>;

export const SCOPES = {
  NATIONAL: "national",
  COUNTY: "county",
  SITE: "site",
} as const;
export const scopeValidator = v.union(
  v.literal(SCOPES.NATIONAL),
  v.literal(SCOPES.COUNTY),
  v.literal(SCOPES.SITE),
);

export const siteStatusValidator = v.union(
  v.literal("active"),
  v.literal("suspended"),
  v.literal("closed"),
  v.literal("pending_verification"),
);
export const inspectionStatusValidator = v.union(
  v.literal("draft"),
  v.literal("submitted"),
  v.literal("under_review"),
  v.literal("approved"),
  v.literal("rejected"),
);
export const severityValidator = v.union(
  v.literal("low"),
  v.literal("medium"),
  v.literal("high"),
  v.literal("critical"),
);
export const findingStatusValidator = v.union(
  v.literal("open"),
  v.literal("acknowledged"),
  v.literal("resolved"),
  v.literal("verified"),
);
export const caStatusValidator = v.union(
  v.literal("open"),
  v.literal("in_progress"),
  v.literal("submitted"),
  v.literal("verified"),
  v.literal("closed"),
  v.literal("escalated"),
);
export const incidentTypeValidator = v.union(
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
);
export const envCategoryValidator = v.union(
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
);
export const verificationValidator = v.union(
  v.literal("observed"),
  v.literal("measured"),
  v.literal("verified"),
  v.literal("unverified"),
  v.literal("alleged"),
);
export const reportCategoryValidator = v.union(
  v.literal("suspected_illegal_mining"),
  v.literal("pollution"),
  v.literal("environmental_damage"),
  v.literal("safety_concern"),
  v.literal("land_concern"),
  v.literal("unauthorized_activity"),
);
export const reportStatusValidator = v.union(
  v.literal("submitted"),
  v.literal("under_review"),
  v.literal("verified"),
  v.literal("dismissed"),
  v.literal("referred"),
);
export const incidentStatusValidator = v.union(
  v.literal("reported"),
  v.literal("investigating"),
  v.literal("closed"),
);
export const evidenceKindValidator = v.union(
  v.literal("photo"),
  v.literal("video"),
  v.literal("audio"),
  v.literal("document"),
);

const schema = defineSchema(
  {
    // default auth tables using convex auth.
    ...authTables, // do not remove or modify

    users: defineTable({
      name: v.optional(v.string()), // name of the user. do not remove
      image: v.optional(v.string()), // image of the user. do not remove
      email: v.optional(v.string()), // email of the user. do not remove
      emailVerificationTime: v.optional(v.number()), // do not remove
      isAnonymous: v.optional(v.boolean()), // do not remove

      role: v.optional(roleValidator), // do not remove

      // --- MineGuard Liberia profile (assigned server-side by an admin) ---
      jobTitle: v.optional(v.string()),
      organization: v.optional(v.string()),
      scope: v.optional(scopeValidator), // national | county | site
      county: v.optional(v.string()), // required when scope = county
      operatorName: v.optional(v.string()), // required when role = operator
      profileComplete: v.optional(v.boolean()),
    }).index("email", ["email"]), // do not remove or modify

    // --- MINING SITE REGISTRY ----------------------------------------------
    sites: defineTable({
      code: v.string(), // unique human reference, e.g. MGL-NIM-0007
      name: v.string(),
      operatorName: v.string(),
      mineralType: v.optional(v.string()),
      county: v.string(),
      district: v.optional(v.string()),
      community: v.optional(v.string()),
      status: siteStatusValidator,
      latitude: v.optional(v.number()),
      longitude: v.optional(v.number()),
      notes: v.optional(v.string()),
      createdBy: v.id("users"),
      createdAt: v.number(),
    })
      .index("by_code", ["code"])
      .index("by_county", ["county"])
      .index("by_status", ["status"]),

    // --- CONFIGURABLE INSPECTION TEMPLATES ---------------------------------
    inspectionTemplates: defineTable({
      name: v.string(),
      description: v.optional(v.string()),
      active: v.boolean(),
      sections: v.array(
        v.object({
          title: v.string(),
          questions: v.array(
            v.object({
              label: v.string(),
              answerType: v.union(
                v.literal("boolean"),
                v.literal("text"),
                v.literal("select"),
                v.literal("number"),
              ),
              options: v.optional(v.array(v.string())),
              required: v.boolean(),
            }),
          ),
        }),
      ),
      createdBy: v.id("users"),
      createdAt: v.number(),
    }).index("by_active", ["active"]),

    // --- INSPECTIONS (offline-capable, lifecycle states) --------------------
    inspections: defineTable({
      siteId: v.id("sites"),
      templateId: v.id("inspectionTemplates"),
      inspectorId: v.id("users"),
      status: inspectionStatusValidator,
      answers: v.optional(v.any()), // { [questionKey]: value }
      notes: v.optional(v.string()),
      latitude: v.optional(v.number()),
      longitude: v.optional(v.number()),
      gpsAccuracyM: v.optional(v.number()),
      clientRef: v.optional(v.string()), // offline queue dedupe reference
      submittedAt: v.optional(v.number()),
      reviewedAt: v.optional(v.number()),
      reviewerId: v.optional(v.id("users")),
      reviewNote: v.optional(v.string()),
      createdAt: v.number(),
    })
      .index("by_site", ["siteId"])
      .index("by_status", ["status"])
      .index("by_inspector", ["inspectorId"])
      .index("by_client_ref", ["clientRef"]),

    // --- FINDINGS (inspection -> finding -> violation chain) ----------------
    findings: defineTable({
      inspectionId: v.id("inspections"),
      siteId: v.id("sites"),
      title: v.string(),
      description: v.optional(v.string()),
      severity: severityValidator,
      status: findingStatusValidator,
      createdById: v.id("users"),
      createdAt: v.number(),
    })
      .index("by_site", ["siteId"])
      .index("by_inspection", ["inspectionId"])
      .index("by_status", ["status"]),

    // --- CORRECTIVE ACTIONS -------------------------------------------------
    correctiveActions: defineTable({
      findingId: v.id("findings"),
      siteId: v.id("sites"),
      description: v.string(),
      status: caStatusValidator,
      dueAt: v.number(),
      openedById: v.id("users"),
      operatorNote: v.optional(v.string()),
      verifiedById: v.optional(v.id("users")),
      closedAt: v.optional(v.number()),
      createdAt: v.number(),
    })
      .index("by_site", ["siteId"])
      .index("by_finding", ["findingId"])
      .index("by_status", ["status"]),

    // --- INCIDENTS ----------------------------------------------------------
    incidents: defineTable({
      siteId: v.id("sites"),
      type: incidentTypeValidator,
      severity: severityValidator,
      description: v.string(),
      occurredAt: v.number(),
      fatalities: v.optional(v.number()),
      injured: v.optional(v.number()),
      status: incidentStatusValidator,
      reportedById: v.id("users"),
      reportSource: v.union(v.literal("inspector"), v.literal("operator")),
      createdAt: v.number(),
    })
      .index("by_site", ["siteId"])
      .index("by_type", ["type"])
      .index("by_status", ["status"]),

    // --- EVIDENCE (secure storage-backed; device URIs never stored) ---------
    evidence: defineTable({
      storageId: v.id("_storage"),
      parentType: v.union(
        v.literal("inspection"),
        v.literal("incident"),
        v.literal("observation"),
      ),
      parentId: v.string(), // id of the parent record
      siteId: v.optional(v.id("sites")),
      kind: evidenceKindValidator,
      fileName: v.string(),
      mimeType: v.string(),
      sizeBytes: v.number(),
      caption: v.optional(v.string()),
      capturedAt: v.optional(v.number()),
      uploadedById: v.id("users"),
      createdAt: v.number(),
    })
      .index("by_parent", ["parentType", "parentId"])
      .index("by_site", ["siteId"]),

    // --- ENVIRONMENTAL OBSERVATIONS -----------------------------------------
    environmentalObservations: defineTable({
      siteId: v.id("sites"),
      category: envCategoryValidator,
      verification: verificationValidator,
      description: v.string(),
      observedAt: v.number(),
      latitude: v.optional(v.number()),
      longitude: v.optional(v.number()),
      status: v.union(v.literal("open"), v.literal("monitoring"), v.literal("resolved")),
      reportedById: v.id("users"),
      createdAt: v.number(),
    })
      .index("by_site", ["siteId"])
      .index("by_category", ["category"]),

    // --- COMMUNITY REPORTS (public submission, controlled triage workflow) ---
    // A report is an allegation or concern. It NEVER becomes an accusation of
    // guilt; verification is a human decision recorded in the audit log.
    communityReports: defineTable({
      trackingCode: v.string(),
      category: reportCategoryValidator,
      description: v.string(),
      county: v.string(),
      district: v.optional(v.string()),
      community: v.optional(v.string()),
      latitude: v.optional(v.number()),
      longitude: v.optional(v.number()),
      contactPhone: v.optional(v.string()),
      status: reportStatusValidator,
      triageNote: v.optional(v.string()),
      reviewedById: v.optional(v.id("users")),
      reviewedAt: v.optional(v.number()),
      createdAt: v.number(),
    })
      .index("by_tracking_code", ["trackingCode"])
      .index("by_status", ["status"])
      .index("by_county", ["county"]),

    // --- AUDIT LOG (append-only record of consequential actions) -------------
    auditLog: defineTable({
      actorId: v.optional(v.id("users")),
      actorLabel: v.string(), // email/name or "public"
      action: v.string(),
      entityType: v.string(),
      entityId: v.optional(v.string()),
      summary: v.string(),
      createdAt: v.number(),
    }).index("by_created", ["createdAt"]),
  },
  {
    schemaValidation: false,
  },
);

export default schema;
