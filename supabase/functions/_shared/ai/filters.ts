// ---------------------------------------------------------------------------
// AUTHORIZED NATURAL-LANGUAGE SEARCH — question -> STRUCTURED FILTER -> scoped read.
//
// The question is never executed, never interpolated into SQL, and never
// trusted. It is turned into a SearchFilter, and a SearchFilter is only ever
// a value that passed validateFilter(): a closed allowlist of entities,
// fields, operators and enum values. Execution (executeFilter) uses the
// supabase-js query builder on the CALLER's client, so Row Level Security
// decides what comes back. There is no code path from text to raw SQL, and no
// code path that can name a column outside SEARCH_ENTITIES (contact phone
// numbers, free-text descriptions and evidence paths are simply not
// selectable).
// ---------------------------------------------------------------------------

import { AiError, type ScopedDb } from "./contract.ts";

type FieldType = "enum" | "text" | "date" | "uuid";
export type Op = "eq" | "neq" | "in" | "contains" | "gte" | "lte";

interface FieldSpec {
  type: FieldType;
  values?: readonly string[];
}
interface EntitySpec {
  table: string;
  /** Columns returned to the caller — a closed list. */
  columns: readonly string[];
  fields: Record<string, FieldSpec>;
  /** Default ordering + the date column "last N days" applies to. */
  dateField: string;
}

const SEVERITY = ["low", "medium", "high", "critical"] as const;

export const SEARCH_ENTITIES = {
  sites: {
    table: "sites",
    columns: ["id", "code", "name", "operator_name", "mineral_type", "county", "district", "community", "status", "created_at"],
    dateField: "created_at",
    fields: {
      county: { type: "text" },
      district: { type: "text" },
      community: { type: "text" },
      mineral_type: { type: "text" },
      operator_name: { type: "text" },
      name: { type: "text" },
      code: { type: "text" },
      status: { type: "enum", values: ["active", "suspended", "closed", "pending_verification"] },
      created_at: { type: "date" },
    },
  },
  incidents: {
    table: "incidents",
    columns: ["id", "site_id", "type", "severity", "status", "occurred_at", "fatalities", "injured"],
    dateField: "occurred_at",
    fields: {
      type: { type: "enum", values: ["fatality", "injury", "near_miss", "equipment_accident", "vehicle_accident", "fire", "structural_failure", "chemical_exposure", "environmental", "other"] },
      severity: { type: "enum", values: SEVERITY },
      status: { type: "enum", values: ["reported", "investigating", "closed"] },
      occurred_at: { type: "date" },
      site_id: { type: "uuid" },
    },
  },
  findings: {
    table: "findings",
    columns: ["id", "site_id", "inspection_id", "title", "severity", "status", "created_at"],
    dateField: "created_at",
    fields: {
      severity: { type: "enum", values: SEVERITY },
      status: { type: "enum", values: ["open", "acknowledged", "resolved", "verified"] },
      created_at: { type: "date" },
      site_id: { type: "uuid" },
    },
  },
  corrective_actions: {
    table: "corrective_actions",
    columns: ["id", "finding_id", "site_id", "status", "due_at", "closed_at", "created_at"],
    dateField: "due_at",
    fields: {
      status: { type: "enum", values: ["open", "in_progress", "submitted", "verified", "closed", "escalated"] },
      due_at: { type: "date" },
      created_at: { type: "date" },
      site_id: { type: "uuid" },
    },
  },
  inspections: {
    table: "inspections",
    columns: ["id", "site_id", "status", "submitted_at", "reviewed_at", "created_at"],
    dateField: "created_at",
    fields: {
      status: { type: "enum", values: ["draft", "submitted", "under_review", "approved", "rejected"] },
      created_at: { type: "date" },
      submitted_at: { type: "date" },
      site_id: { type: "uuid" },
    },
  },
  environmental_observations: {
    table: "environmental_observations",
    columns: ["id", "site_id", "category", "verification", "status", "observed_at"],
    dateField: "observed_at",
    fields: {
      category: { type: "enum", values: ["water_pollution", "river_disturbance", "river_diversion", "deforestation", "soil_degradation", "waste", "tailings", "chemical_handling", "rehabilitation", "land_impact"] },
      verification: { type: "enum", values: ["observed", "measured", "verified", "unverified", "alleged"] },
      status: { type: "enum", values: ["open", "monitoring", "resolved"] },
      observed_at: { type: "date" },
      site_id: { type: "uuid" },
    },
  },
  community_reports: {
    table: "community_reports",
    // contact_phone, description and triage_note are deliberately NOT selectable.
    columns: ["id", "tracking_code", "category", "status", "county", "district", "community", "created_at"],
    dateField: "created_at",
    fields: {
      category: { type: "enum", values: ["suspected_illegal_mining", "pollution", "environmental_damage", "safety_concern", "land_concern", "unauthorized_activity"] },
      status: { type: "enum", values: ["submitted", "under_review", "verified", "dismissed", "referred"] },
      county: { type: "text" },
      district: { type: "text" },
      community: { type: "text" },
      created_at: { type: "date" },
    },
  },
} as const satisfies Record<string, EntitySpec>;

export type EntityName = keyof typeof SEARCH_ENTITIES;
export const ENTITY_NAMES = Object.keys(SEARCH_ENTITIES) as EntityName[];

export interface WhereClause {
  field: string;
  op: Op;
  value: string | string[];
}
export interface SearchFilter {
  entity: EntityName;
  where: WhereClause[];
  orderBy: { field: string; direction: "asc" | "desc" };
  limit: number;
}

export const MAX_LIMIT = 50;
export const DEFAULT_LIMIT = 25;
const MAX_WHERE = 8;
const MAX_VALUE_LEN = 80;
const MAX_IN = 10;

const OPS_BY_TYPE: Record<FieldType, readonly Op[]> = {
  enum: ["eq", "neq", "in"],
  text: ["eq", "contains"],
  date: ["gte", "lte"],
  uuid: ["eq", "in"],
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

function hasOnlyKeys(o: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(o).every((k) => allowed.includes(k));
}

/** Strip characters that act as wildcards or delimiters in PostgREST/LIKE. */
export function cleanContains(raw: string): string {
  return raw.replace(/[%_\\*(),."'`;:<>{}[\]|]/g, " ").replace(/\s+/g, " ").trim();
}

export type Validation = { ok: true; filter: SearchFilter } | { ok: false; reason: string };

export function validateFilter(input: unknown): Validation {
  const bad = (reason: string): Validation => ({ ok: false, reason });
  if (!input || typeof input !== "object" || Array.isArray(input)) return bad("filter must be an object");
  const o = input as Record<string, unknown>;
  if (!hasOnlyKeys(o, ["entity", "where", "orderBy", "limit"])) return bad("unknown filter key");

  const entity = o.entity;
  if (typeof entity !== "string" || !(ENTITY_NAMES as string[]).includes(entity)) return bad("unknown entity");
  const spec: EntitySpec = SEARCH_ENTITIES[entity as EntityName];

  const whereIn = o.where ?? [];
  if (!Array.isArray(whereIn) || whereIn.length > MAX_WHERE) return bad("where must be a short array");
  const where: WhereClause[] = [];
  for (const w of whereIn) {
    if (!w || typeof w !== "object" || Array.isArray(w)) return bad("where clause must be an object");
    const c = w as Record<string, unknown>;
    if (!hasOnlyKeys(c, ["field", "op", "value"])) return bad("unknown where key");
    if (typeof c.field !== "string" || !Object.hasOwn(spec.fields, c.field)) return bad("field not searchable");
    const f = spec.fields[c.field];
    if (typeof c.op !== "string" || !OPS_BY_TYPE[f.type].includes(c.op as Op)) return bad("operator not allowed for field");
    const op = c.op as Op;

    const one = (v: unknown): string | null => {
      if (typeof v !== "string") return null;
      const s = v.trim();
      if (s.length === 0 || s.length > MAX_VALUE_LEN) return null;
      if (f.type === "enum") return f.values!.includes(s) ? s : null;
      if (f.type === "uuid") return UUID.test(s) ? s.toLowerCase() : null;
      if (f.type === "date") return ISO.test(s) && !Number.isNaN(Date.parse(s)) ? s : null;
      // text
      if (op === "contains") {
        const cl = cleanContains(s);
        return cl.length >= 2 ? cl : null;
      }
      return /^[\p{L}\p{N} '’\-.]+$/u.test(s) ? s : null;
    };

    if (op === "in") {
      if (!Array.isArray(c.value) || c.value.length === 0 || c.value.length > MAX_IN) return bad("in needs a short array");
      const vals: string[] = [];
      for (const v of c.value) {
        const s = one(v);
        if (s === null) return bad("value not allowed");
        vals.push(s);
      }
      where.push({ field: c.field, op, value: [...new Set(vals)] });
    } else {
      const s = one(c.value);
      if (s === null) return bad("value not allowed");
      where.push({ field: c.field, op, value: s });
    }
  }

  let orderBy = { field: spec.dateField, direction: "desc" as "asc" | "desc" };
  if (o.orderBy !== undefined) {
    if (!o.orderBy || typeof o.orderBy !== "object" || Array.isArray(o.orderBy)) return bad("orderBy must be an object");
    const ob = o.orderBy as Record<string, unknown>;
    if (!hasOnlyKeys(ob, ["field", "direction"])) return bad("unknown orderBy key");
    if (typeof ob.field !== "string" || !Object.hasOwn(spec.fields, ob.field) || spec.fields[ob.field].type === "uuid")
      return bad("orderBy field not allowed");
    if (ob.direction !== "asc" && ob.direction !== "desc") return bad("orderBy direction invalid");
    orderBy = { field: ob.field, direction: ob.direction };
  }

  let limit = DEFAULT_LIMIT;
  if (o.limit !== undefined) {
    if (typeof o.limit !== "number" || !Number.isInteger(o.limit) || o.limit < 1) return bad("limit invalid");
    limit = Math.min(o.limit, MAX_LIMIT);
  }
  return { ok: true, filter: { entity: entity as EntityName, where, orderBy, limit } };
}

// ---------------------------------------------------------------------------
// Deterministic question parser. Pure: question + clock in, filter out.
// ---------------------------------------------------------------------------

export const LIBERIA_COUNTIES = [
  "Bomi", "Bong", "Gbarpolu", "Grand Bassa", "Grand Cape Mount", "Grand Gedeh", "Grand Kru",
  "Lofa", "Margibi", "Maryland", "Montserrado", "Nimba", "River Cess", "River Gee", "Sinoe",
] as const;
const MINERALS = ["gold", "diamond", "iron ore", "bauxite", "manganese", "copper", "sand", "stone", "granite"];

const ENTITY_WORDS: [EntityName, RegExp][] = [
  ["corrective_actions", /\bcorrective actions?\b|\boverdue\b|\bpast due\b/],
  ["incidents", /\bincidents?\b|\baccidents?\b|\bfatalit\w+|\bnear[- ]miss(es)?\b|\binjur\w+/],
  ["findings", /\bfindings?\b/],
  ["inspections", /\binspections?\b/],
  ["environmental_observations", /\benvironment\w*\b|\bobservations?\b|\bdeforest\w+|\btailings\b/],
  ["community_reports", /\bcommunity (reports?|complaints?|tips?)\b|\bcomplaints?\b|\bcitizen reports?\b/],
  ["sites", /\bsites?\b|\bmines?\b|\bmining operations?\b|\boperations?\b/],
];

/** Extra wording per enum value, beyond the value itself (underscore ~ space/hyphen). */
const SYNONYMS: Record<string, string> = {
  fatality: "fatalit\\w+|deaths?|fatal",
  injury: "injur\\w+",
  vehicle_accident: "vehicle",
  equipment_accident: "equipment",
  environmental: "environmental incident",
  water_pollution: "water pollut\\w+|polluted water|water contamination",
  deforestation: "deforest\\w+",
  waste: "waste",
  pollution: "pollut\\w+",
  suspected_illegal_mining: "illegal mining|suspected mining",
  pending_verification: "pending|awaiting verification|unverified sites?",
  in_progress: "in progress",
  under_review: "under review|in review",
};

const FIELD_ORDER: Record<EntityName, string[]> = {
  sites: ["status"],
  incidents: ["type", "severity", "status"],
  findings: ["severity", "status"],
  corrective_actions: ["status"],
  inspections: ["status"],
  environmental_observations: ["category", "verification", "status"],
  community_reports: ["category", "status"],
};

function valueRegex(value: string): RegExp {
  const base = value.replace(/_/g, "[ _-]");
  const syn = SYNONYMS[value];
  return new RegExp(`\\b(?:${base}${syn ? `|${syn}` : ""})\\b`);
}

export interface ParsedQuestion {
  filter: SearchFilter | null;
  /** Plain-language reading of the question, shown to the user. */
  interpretation: string[];
  notes: string[];
}

const UNIT_DAYS: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };

export function parseQuestion(question: string, now: Date = new Date()): ParsedQuestion {
  const q = question.toLowerCase().slice(0, 500);
  const interpretation: string[] = [];
  const notes: string[] = [];

  let entity: EntityName | null = null;
  for (const [name, re] of ENTITY_WORDS) {
    if (re.test(q)) {
      entity = name;
      break;
    }
  }

  const county = LIBERIA_COUNTIES.find((c) => new RegExp(`\\b${c.toLowerCase()}\\b`).test(q));
  const mineral = MINERALS.find((m) => new RegExp(`\\b${m}s?\\b`).test(q));
  if (!entity && (county || mineral)) entity = "sites";
  if (!entity) {
    return { filter: null, interpretation, notes: ["No supported subject (sites, incidents, findings, corrective actions, inspections, environmental observations, community reports) was recognised."] };
  }
  const spec: EntitySpec = SEARCH_ENTITIES[entity];
  interpretation.push(`Looking at: ${entity.replace(/_/g, " ")}`);

  const where: WhereClause[] = [];

  // Enum words — each word of the question is consumed by at most one field.
  let consumed = q;
  for (const field of FIELD_ORDER[entity]) {
    const f = spec.fields[field];
    const hits: string[] = [];
    for (const v of f.values ?? []) {
      const re = valueRegex(v);
      if (re.test(consumed)) {
        hits.push(v);
        consumed = consumed.replace(new RegExp(re.source, "g"), " ");
      }
    }
    if (hits.length === 1) where.push({ field, op: "eq", value: hits[0] });
    else if (hits.length > 1) where.push({ field, op: "in", value: hits });
    if (hits.length) interpretation.push(`${field.replace(/_/g, " ")}: ${hits.join(" or ").replace(/_/g, " ")}`);
  }

  // Overdue corrective actions: due in the past and not yet closed/verified.
  if (entity === "corrective_actions" && /\boverdue\b|\bpast due\b/.test(q)) {
    where.push({ field: "due_at", op: "lte", value: now.toISOString() });
    if (!where.some((w) => w.field === "status")) {
      where.push({ field: "status", op: "neq", value: "closed" }, { field: "status", op: "neq", value: "verified" });
    }
    interpretation.push("due date before now, not closed or verified");
  }

  // Geography / commodity.
  if (county) {
    if ("county" in spec.fields) {
      where.push({ field: "county", op: "eq", value: county });
      interpretation.push(`county: ${county}`);
    } else {
      notes.push(`County "${county}" was not applied: ${entity.replace(/_/g, " ")} are not filtered by county here (your access scope still applies).`);
    }
  }
  if (mineral && entity === "sites") {
    where.push({ field: "mineral_type", op: "contains", value: mineral });
    interpretation.push(`mineral: ${mineral}`);
  }
  const named = q.match(/\b(?:named|called)\s+["“']?([a-z0-9][a-z0-9 -]{1,40})/);
  if (named && entity === "sites") {
    const nm = cleanContains(named[1]);
    if (nm.length >= 2) {
      where.push({ field: "name", op: "contains", value: nm });
      interpretation.push(`name contains "${nm}"`);
    }
  }

  // Time window.
  const dateField = spec.dateField;
  const rel = q.match(/\b(?:last|past|previous)\s+(\d{1,3})\s+(day|week|month|year)s?\b/);
  let sinceDays: number | null = null;
  if (rel) sinceDays = Number(rel[1]) * UNIT_DAYS[rel[2]];
  else if (/\brecent(ly)?\b/.test(q)) sinceDays = 30;
  else if (/\btoday\b/.test(q)) sinceDays = 1;
  else if (/\bthis week\b/.test(q)) sinceDays = 7;
  else if (/\bthis month\b/.test(q)) sinceDays = 30;
  else if (/\bthis year\b/.test(q)) sinceDays = 365;
  if (sinceDays !== null && entity !== "corrective_actions") {
    sinceDays = Math.min(Math.max(sinceDays, 1), 3650);
    const since = new Date(now.getTime() - sinceDays * 86_400_000).toISOString();
    where.push({ field: dateField, op: "gte", value: since });
    interpretation.push(`${dateField.replace(/_/g, " ")} within the last ${sinceDays} day${sinceDays === 1 ? "" : "s"}`);
  }

  // Ordering and size.
  const top = q.match(/\b(?:top|first|latest|newest)\s+(\d{1,2})\b/) ?? q.match(/\b(\d{1,2})\s+(?:most\s+)?(?:recent|latest|newest)\b/);
  const limit = top ? Math.min(Math.max(Number(top[1]), 1), MAX_LIMIT) : DEFAULT_LIMIT;
  const direction: "asc" | "desc" = /\boldest\b|\bearliest\b/.test(q) ? "asc" : entity === "corrective_actions" && /\boverdue\b|\bpast due\b/.test(q) ? "asc" : "desc";

  // Nothing but the subject word and nothing else recognised is still a valid
  // "list the latest N" question — but a question with no subject was rejected above.
  const validated = validateFilter({ entity, where, orderBy: { field: dateField, direction }, limit });
  if (!validated.ok) {
    return { filter: null, interpretation, notes: [...notes, `The question could not be turned into a supported filter (${validated.reason}).`] };
  }
  return { filter: validated.filter, interpretation, notes };
}

// ---------------------------------------------------------------------------
// Execution — the supabase-js builder on the caller's own client.
// ---------------------------------------------------------------------------

export interface SearchResult {
  entity: EntityName;
  rows: Record<string, unknown>[];
  /** True when the row cap was hit — there may be more matching records. */
  truncated: boolean;
}

export async function executeFilter(db: ScopedDb, input: SearchFilter): Promise<SearchResult> {
  // Re-validate: executeFilter never trusts that its caller validated.
  const v = validateFilter(input);
  if (!v.ok) throw new AiError("INVALID_FILTER", v.reason);
  const filter = v.filter;
  const spec: EntitySpec = SEARCH_ENTITIES[filter.entity];

  let q = db.from(spec.table).select(spec.columns.join(","));
  for (const w of filter.where) {
    switch (w.op) {
      case "eq": q = q.eq(w.field, w.value); break;
      case "neq": q = q.neq(w.field, w.value); break;
      case "in": q = q.in(w.field, w.value as string[]); break;
      case "gte": q = q.gte(w.field, w.value); break;
      case "lte": q = q.lte(w.field, w.value); break;
      case "contains": q = q.ilike(w.field, `%${w.value as string}%`); break;
    }
  }
  q = q.order(filter.orderBy.field, { ascending: filter.orderBy.direction === "asc" }).order("id", { ascending: true });
  q = q.limit(filter.limit + 1);

  const { data, error } = await q;
  if (error) throw new AiError("QUERY_FAILED", typeof error.message === "string" ? error.message : "query failed");
  const rows = (Array.isArray(data) ? data : []) as Record<string, unknown>[];
  return { entity: filter.entity, rows: rows.slice(0, filter.limit), truncated: rows.length > filter.limit };
}
