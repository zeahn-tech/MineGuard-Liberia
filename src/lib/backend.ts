// ---------------------------------------------------------------------------
// MINEGUARD LIBERIA — SUPABASE DATA LAYER
//
// Replaces the previous Firebase data layer function-for-function. Every
// function re-derives authorization from the caller's profile BEFORE touching
// data (defense in depth); Postgres RLS + guard triggers + security-definer
// RPCs (supabase/migrations/0001_initial_schema.sql) are the authoritative
// server-side boundary. Every consequential write is appended to audit_log
// by the SERVER (mg_audit_row() SECURITY DEFINER triggers — migration
// 0009_audit_integrity.sql): clients hold no INSERT privilege on the audit
// trail, so nothing in this file can forge or lose an audit row.
//
// Timestamp contract: the UI speaks epoch-ms numbers (the former Firestore
// shape). Postgres timestamptz values are mapped to ms numbers at this edge,
// and ms numbers back to ISO strings on write — pages need no changes.
// Column contract: Postgres snake_case rows are mapped to the camelCase
// domain types in ./types.ts (with `_id` for the primary key) at this edge.
// ---------------------------------------------------------------------------

import {
  authUserId,
  backendError,
  bumpProfileVersion,
  mfaAal,
  supabase,
  uploadWithProgress,
} from "./supabase";
import { validateTemplateSections } from "./template-schema";
import {
  computeRiskFactors,
  factorsFromCounts,
  factorsFromCountsAndIds,
  type RiskFactor,
  type RiskInputCounts,
} from "./risk-model";
import { sha256Hex } from "./sha256";
import {
  MAP_LAYER_CONFIGS,
  type MapFeature,
  type MapLayerConfig,
  type AdminBoundary,
  type SiteBoundary,
} from "./types";

/** doc 08: AI output is labeled as assistance — this label ships with every
 *  AI payload so no surface can present it as fact without the marker. */
const AI_DISCLAIMER =
  "AI-assisted explanation — generated from the recorded risk factors only; decision support, not a determination.";
