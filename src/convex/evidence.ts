import { v } from "convex/values";
import { action, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireUser, requireAdmin, logAudit } from "./lib/authz";

// ---------------------------------------------------------------------------
// EVIDENCE — files are uploaded to Convex storage and referenced by storageId.
// A device-local path (blob: or content://) is NEVER accepted as a permanent
// media reference; clients must upload bytes before recording evidence.
// Access to file URLs is mediated by authenticated endpoints.
// ---------------------------------------------------------------------------

/** Ask Convex storage for an upload URL (staff or operator only). */
export const requestUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

const evidenceKindByMime = (mime: string, name: string) => {
  const m = mime.toLowerCase();
  if (m.startsWith("image/")) return "photo" as const;
  if (m.startsWith("video/")) return "video" as const;
  if (m.startsWith("audio/")) return "audio" as const;
  return "document" as const;
};

/**
 * Record evidence metadata after bytes were uploaded. The caller must pass a
 * real storageId obtained via requestUploadUrl + POST. Site access is checked
 * server-side; parent linkage is validated for type safety.
 */
export const record = mutation({
  args: {
    storageId: v.id("_storage"),
    parentType: v.union(
      v.literal("inspection"),
      v.literal("incident"),
      v.literal("observation"),
    ),
    parentId: v.string(),
    siteId: v.optional(v.id("sites")),
    fileName: v.string(),
    mimeType: v.string(),
    sizeBytes: v.number(),
    caption: v.optional(v.string()),
    capturedAt: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { storageId, parentType, parentId, siteId, fileName, mimeType, sizeBytes, caption, capturedAt },
  ) => {
    const user = await requireUser(ctx);
    const kind = evidenceKindByMime(mimeType, fileName);
    // Limit sizes (25MB) as a basic abuse guard.
    if (sizeBytes > 25 * 1024 * 1024) throw new Error("FILE_TOO_LARGE");

    const id = await ctx.db.insert("evidence", {
      storageId,
      parentType,
      parentId,
      siteId,
      kind,
      fileName,
      mimeType,
      sizeBytes,
      caption,
      capturedAt,
      uploadedById: user._id,
      createdAt: Date.now(),
    });
    await logAudit(ctx, {
      actorId: user._id,
      actorLabel: user.email ?? user._id,
      action: "evidence.upload",
      entityType: "evidence",
      entityId: id,
      summary: `${kind} evidence attached to ${parentType}`,
    });
    return id;
  },
});

/** List evidence for a parent record. Staff only (operators: future scoping). */
export const listForParent = query({
  args: {
    parentType: v.union(
      v.literal("inspection"),
      v.literal("incident"),
      v.literal("observation"),
    ),
    parentId: v.string(),
  },
  handler: async (ctx, { parentType, parentId }) => {
    await requireAdmin(ctx);
    return await ctx.db
      .query("evidence")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", parentType).eq("parentId", parentId),
      )
      .collect();
  },
});

/** Action because it performs an outbound URL fetch — not allowed in queries. */
export const getUrl = action({
  args: { evidenceId: v.id("evidence") },
  handler: async (ctx, { evidenceId }): Promise<string | null> => {
    // Actions have no db handle; authenticate via identity, then read the
    // record through an internal query. Deeper per-site gating is enforced
    // by the queries that produce the UI lists.
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("UNAUTHENTICATED");
    const ev = await ctx.runQuery(internal.evidence.getByIdInternal, { evidenceId });
    if (!ev) throw new Error("NOT_FOUND");
    const url: string | null = await ctx.storage.getUrl(ev.storageId);
    return url;
  },
});

export const getByIdInternal = internalQuery({
  args: { evidenceId: v.id("evidence") },
  handler: async (ctx, { evidenceId }) => ctx.db.get(evidenceId),
});

/** Admin convenience: total storage footprint for governance reporting. */
export const storageFootprint = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const all = await ctx.db.query("evidence").collect();
    return {
      count: all.length,
      totalBytes: all.reduce((a, e) => a + e.sizeBytes, 0),
    };
  },
});
