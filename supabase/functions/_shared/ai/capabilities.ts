// ---------------------------------------------------------------------------
// DETERMINISTIC CAPABILITIES — what AI-1 does with NO model provider.
//
// Every function here:
//   * reads only through the caller's own client (RLS decides visibility);
//   * performs NO writes of any kind;
//   * returns a Draft: statements, each with the record IDs it is built from,
//     plus the set of every ID it actually retrieved. The handler then runs
//     cite-or-abstain over the Draft, so a statement can only reach the
//     caller if it is grounded in a record the caller is allowed to see;
//   * states counts and dates only. It does not characterise anyone's
//     conduct, and it never says a party is in violation of anything.
// ---------------------------------------------------------------------------

import { AiError, type Claim, type ScopedDb } from "./contract.ts";
import { UUID_RE } from "./cite.ts";
import { detectInjection, sanitizeUntrusted } from "./injection.ts";

export interface Draft {
  claims: Claim[];
  data: unknown;
  /** Every record id this request read. Citations must be a subset. */
  retrieved: Set<string>;
  notices: string[];
  abstainReason: string | null;
  injectionFlagged?: boolean;
}

type Row = Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Query = any; // the supabase-js filter builder; structural, shared with the test bridge
const ROW_CAP = 500;
const CITE_CAP = 25;
const UUID_STRICT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function read(db: ScopedDb, table: string, cols: string, shape?: (q: Query) => Query): Promise<{ rows: Row[]; capped: boolean }> {
  let q = db.from(table).select(cols);
  if (shape) q = shape(q);
  q = q.limit(ROW_CAP + 1);
  const { data, error } = await q;
  if (error) throw new AiError("QUERY_FAILED", typeof error.message === "string" ? error.message : "query failed");
  const all = (Array.isArray(data) ? data : []) as Row[];
  return { rows: all.slice(0, ROW_CAP), capped: all.length > ROW_CAP };
}

const idsOf = (rows: Row[]): string[] => rows.map((r) => String(r.id));
const cite = (ids: string[]): string[] => ids.slice(0, CITE_CAP);
const day = (v: unknown): string => String(v ?? "").slice(0, 10);

function tally(rows: Row[], key: string): [string, number][] {
  const m = new Map<string, number>();
  for (const r of rows) m.set(String(r[key] ?? "unknown"), (m.get(String(r[key] ?? "unknown")) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
const fmt = (t: [string, number][]): string => t.map(([k, n]) => `${k.replace(/_/g, " ")} ${n}`).join(", ");
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const capNote = (n: number): string => (n > CITE_CAP ? ` (first ${CITE_CAP} cited)` : "");

function assertUuid(v: unknown, name: string): string {
  if (typeof v !== "string" || !UUID_STRICT.test(v)) throw new AiError("BAD_REQUEST", `${name} must be a UUID`);
  return v.toLowerCase();
}

const isOpenCA = (r: Row): boolean => r.status !== "closed" && r.status !== "verified";

// ------------------------------------------------------------- site summary

export async function siteSummary(db: ScopedDb, siteIdRaw: unknown, now: Date): Promise<Draft> {
  const siteId = assertUuid(siteIdRaw, "siteId");
  const retrieved = new Set<string>();
  const notices: string[] = [];

  const site = (await read(db, "sites", "id,code,name,county,status,operator_name", (q) => q.eq("id", siteId))).rows[0];
  if (!site) {
    // Not found and not-in-scope are indistinguishable by design.
    return { claims: [], data: null, retrieved, notices, abstainReason: "No site with that identifier is available to you." };
  }
  retrieved.add(siteId);

  const bySite = (q: Query) => q.eq("site_id", siteId).order("created_at", { ascending: false });
  const [insp, find, cas, inc, obs] = await Promise.all([
    read(db, "inspections", "id,status,created_at,submitted_at", bySite),
    read(db, "findings", "id,severity,status,created_at", bySite),
    read(db, "corrective_actions", "id,status,due_at,created_at", bySite),
    read(db, "incidents", "id,type,severity,status,occurred_at,fatalities,injured,created_at", bySite),
    read(db, "environmental_observations", "id,verification,status,observed_at,created_at", bySite),
  ]);
  for (const t of [insp, find, cas, inc, obs]) for (const id of idsOf(t.rows)) retrieved.add(id);
  if ([insp, find, cas, inc, obs].some((t) => t.capped)) notices.push(`Some record lists were capped at ${ROW_CAP} rows; counts may be understated.`);

  const label = `${site.name as string} (${site.code as string})`;
  const claims: Claim[] = [
    { text: `${label} is in ${site.county as string} county, operated by ${site.operator_name as string}; registry status ${String(site.status).replace(/_/g, " ")}.`, citations: [siteId] },
  ];

  if (insp.rows.length) {
    claims.push({
      text: `${plural(insp.rows.length, "inspection")} recorded (${fmt(tally(insp.rows, "status"))}); the most recent was created on ${day(insp.rows[0].created_at)}.`,
      citations: cite(idsOf(insp.rows)),
    });
  }
  if (find.rows.length) {
    const sev = ["critical", "high", "medium", "low"].map((s) => [s, find.rows.filter((r) => r.severity === s).length] as [string, number]).filter(([, n]) => n > 0);
    const openN = find.rows.filter((r) => r.status === "open" || r.status === "acknowledged").length;
    claims.push({
      text: `${plural(find.rows.length, "finding")} recorded (${fmt(sev)}); ${openN} still open or acknowledged${capNote(find.rows.length)}.`,
      citations: cite(idsOf(find.rows)),
    });
  }
  if (cas.rows.length) {
    const overdue = cas.rows.filter((r) => isOpenCA(r) && Date.parse(String(r.due_at)) < now.getTime());
    claims.push({
      text: `${plural(cas.rows.length, "corrective action")} recorded (${fmt(tally(cas.rows, "status"))}); ${overdue.length} past their due date and not yet closed or verified${capNote(cas.rows.length)}.`,
      citations: cite(idsOf(cas.rows)),
    });
  }
  if (inc.rows.length) {
    const dead = inc.rows.reduce((n, r) => n + (Number(r.fatalities) || 0), 0);
    const hurt = inc.rows.reduce((n, r) => n + (Number(r.injured) || 0), 0);
    claims.push({
      text: `${plural(inc.rows.length, "incident")} recorded (${fmt(tally(inc.rows, "type"))}); recorded fatalities ${dead}, recorded injured ${hurt}${capNote(inc.rows.length)}.`,
      citations: cite(idsOf(inc.rows)),
    });
  }
  if (obs.rows.length) {
    const unresolved = obs.rows.filter((r) => r.status !== "resolved").length;
    claims.push({
      text: `${plural(obs.rows.length, "environmental observation")} recorded (verification: ${fmt(tally(obs.rows, "verification"))}); ${unresolved} not yet resolved${capNote(obs.rows.length)}.`,
      citations: cite(idsOf(obs.rows)),
    });
  }
  if (claims.length === 1) {
    claims.push({ text: `No inspections, findings, corrective actions, incidents or environmental observations are recorded for ${label}.`, citations: [siteId] });
  }

  return {
    claims,
    retrieved,
    notices,
    abstainReason: null,
    data: {
      siteId,
      counts: { inspections: insp.rows.length, findings: find.rows.length, correctiveActions: cas.rows.length, incidents: inc.rows.length, observations: obs.rows.length },
    },
  };
}

// -------------------------------------------------------------- trend notes

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function trendNotes(db: ScopedDb, args: { siteId?: unknown; months?: unknown }, now: Date): Promise<Draft> {
  const siteId = args.siteId == null ? null : assertUuid(args.siteId, "siteId");
  let months = args.months == null ? 6 : Number(args.months);
  if (!Number.isInteger(months)) throw new AiError("BAD_REQUEST", "months must be an integer");
  months = Math.min(Math.max(months, 3), 24);

  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
  const startIso = start.toISOString();
  const scope = (q: Query) => (siteId ? q.eq("site_id", siteId) : q);
  const retrieved = new Set<string>();
  const notices: string[] = [];

  const [inc, find, obs] = await Promise.all([
    read(db, "incidents", "id,occurred_at", (q) => scope(q).gte("occurred_at", startIso).order("occurred_at", { ascending: false })),
    read(db, "findings", "id,created_at", (q) => scope(q).gte("created_at", startIso).order("created_at", { ascending: false })),
    read(db, "environmental_observations", "id,observed_at", (q) => scope(q).gte("observed_at", startIso).order("observed_at", { ascending: false })),
  ]);
  for (const t of [inc, find, obs]) for (const id of idsOf(t.rows)) retrieved.add(id);
  if ([inc, find, obs].some((t) => t.capped)) notices.push(`Some lists were capped at ${ROW_CAP} rows; trends may be understated.`);

  const total = inc.rows.length + find.rows.length + obs.rows.length;
  if (total === 0) {
    return { claims: [], data: null, retrieved, notices, abstainReason: "No incidents, findings or environmental observations are recorded in this period within your access, so there is no trend to report." };
  }

  const cur = monthKey(now);
  const last = monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
  const prev = monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1)));
  notices.push(`${cur} is a partial month; comparisons use the two most recent complete months (${last} and ${prev}).`);

  const series = [
    { name: "Incidents", rows: inc.rows, key: "occurred_at" },
    { name: "Findings", rows: find.rows, key: "created_at" },
    { name: "Environmental observations", rows: obs.rows, key: "observed_at" },
  ];
  const claims: Claim[] = [];
  const data: Record<string, Record<string, number>> = {};
  for (const s of series) {
    const buckets: Record<string, Row[]> = {};
    for (const r of s.rows) (buckets[monthKey(new Date(String(r[s.key])))] ??= []).push(r);
    data[s.name] = Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length]).sort());
    const a = buckets[last] ?? [];
    const b = buckets[prev] ?? [];
    if (a.length || b.length) {
      const diff = a.length - b.length;
      const dir = diff === 0 ? "unchanged" : diff > 0 ? `up ${diff}` : `down ${-diff}`;
      claims.push({ text: `${s.name}: ${a.length} in ${last} versus ${b.length} in ${prev} (${dir}).`, citations: cite(idsOf([...a, ...b])) });
    }
    if (s.rows.length) {
      claims.push({ text: `${s.name}: ${s.rows.length} recorded from ${startIso.slice(0, 10)} to ${now.toISOString().slice(0, 10)}${capNote(s.rows.length)}.`, citations: cite(idsOf(s.rows)) });
    }
  }
  return { claims, data: { months, monthlyCounts: data }, retrieved, notices, abstainReason: null };
}

// ----------------------------------------------------- inspection priorities

export interface PriorityRow {
  rank: number;
  siteId: string;
  code: string;
  name: string;
  riskIndicator: number | null;
  overdueActions: number;
  daysSinceInspection: number | null;
}

export async function inspectionPriorities(db: ScopedDb, limitRaw: unknown, now: Date): Promise<Draft> {
  let limit = limitRaw == null ? 10 : Number(limitRaw);
  if (!Number.isInteger(limit)) throw new AiError("BAD_REQUEST", "limit must be an integer");
  limit = Math.min(Math.max(limit, 1), 25);

  const retrieved = new Set<string>();
  const notices: string[] = [
    "Ranking order: published risk indicator, then number of overdue corrective actions, then time since the last inspection. This is decision support for planning; the inspector and supervisor decide.",
  ];

  const sites = await read(db, "sites", "id,code,name,status", (q) => q.neq("status", "closed").order("code", { ascending: true }));
  if (sites.rows.length === 0) {
    return { claims: [], data: null, retrieved, notices, abstainReason: "No open sites are visible in your scope." };
  }
  for (const id of idsOf(sites.rows)) retrieved.add(id);

  const [insp, cas] = await Promise.all([
    read(db, "inspections", "id,site_id,status,created_at", (q) => q.in("status", ["submitted", "under_review", "approved"]).order("created_at", { ascending: false })),
    read(db, "corrective_actions", "id,site_id,status,due_at", (q) => q.neq("status", "closed").neq("status", "verified").lte("due_at", now.toISOString())),
  ]);
  for (const id of [...idsOf(insp.rows), ...idsOf(cas.rows)]) retrieved.add(id);
  if (insp.capped || cas.capped) notices.push(`Some lists were capped at ${ROW_CAP} rows.`);

  // The governed, versioned indicator (migration 0019). Optional: if the
  // lineage has no 0019 or the call fails, ranking proceeds without it.
  const score = new Map<string, number>();
  let configVersion: number | null = null;
  try {
    const { data, error } = await db.rpc("mg_risk_scores", { p_version: null, p_as_of: null });
    if (!error && Array.isArray(data)) {
      for (const r of data as Row[]) {
        if (typeof r.siteId === "string" && typeof r.score === "number") score.set(r.siteId, r.score);
        if (typeof r.configVersion === "number") configVersion = r.configVersion;
      }
    }
  } catch {
    /* fall through */
  }
  if (score.size === 0) notices.push("The risk indicator was unavailable; ranking used overdue actions and inspection recency only.");

  const latest = new Map<string, Row>();
  for (const r of insp.rows) if (!latest.has(String(r.site_id))) latest.set(String(r.site_id), r);
  const overdue = new Map<string, Row[]>();
  for (const r of cas.rows) (overdue.get(String(r.site_id)) ?? overdue.set(String(r.site_id), []).get(String(r.site_id))!).push(r);

  const ranked = sites.rows
    .map((s) => {
      const sid = String(s.id);
      const li = latest.get(sid);
      const days = li ? Math.max(0, Math.floor((now.getTime() - Date.parse(String(li.created_at))) / 86_400_000)) : null;
      return { s, sid, li, days, od: overdue.get(sid) ?? [], risk: score.has(sid) ? score.get(sid)! : null };
    })
    .sort((a, b) =>
      (b.risk ?? -1) - (a.risk ?? -1) ||
      b.od.length - a.od.length ||
      (b.days ?? Infinity) - (a.days ?? Infinity) ||
      String(a.s.code).localeCompare(String(b.s.code)),
    )
    .slice(0, limit);

  const rows: PriorityRow[] = [];
  const claims: Claim[] = ranked.map((r, i) => {
    const parts = [
      r.risk != null ? `risk indicator ${r.risk}${configVersion ? ` (configuration v${configVersion})` : ""}` : "risk indicator not available",
      `${plural(r.od.length, "overdue corrective action")}`,
      r.days != null ? `last inspection created ${r.days} day${r.days === 1 ? "" : "s"} ago` : "no submitted inspection on record",
    ];
    rows.push({ rank: i + 1, siteId: r.sid, code: String(r.s.code), name: String(r.s.name), riskIndicator: r.risk, overdueActions: r.od.length, daysSinceInspection: r.days });
    return {
      text: `${i + 1}. ${String(r.s.code)} ${String(r.s.name)}: ${parts.join("; ")}.`,
      citations: cite([r.sid, ...r.od.map((o) => String(o.id)), ...(r.li ? [String(r.li.id)] : [])]),
    };
  });
  return { claims, data: { method: "risk-indicator, overdue-actions, inspection-recency", configVersion, rows }, retrieved, notices, abstainReason: null };
}

// -------------------------------------------------------- executive briefing

export async function executiveBriefing(db: ScopedDb, now: Date): Promise<Draft> {
  const retrieved = new Set<string>();
  const notices: string[] = [];
  const since30 = new Date(now.getTime() - 30 * 86_400_000).toISOString();

  const sites = await read(db, "sites", "id,status");
  if (sites.rows.length === 0) {
    return { claims: [], data: null, retrieved, notices, abstainReason: "No sites are visible in your scope, so there is nothing to brief on." };
  }
  const [find, cas, inc, reports, obs] = await Promise.all([
    read(db, "findings", "id,severity,status", (q) => q.in("severity", ["critical", "high"]).in("status", ["open", "acknowledged"])),
    read(db, "corrective_actions", "id,status,due_at", (q) => q.neq("status", "closed").neq("status", "verified").lte("due_at", now.toISOString())),
    read(db, "incidents", "id,type,fatalities,injured,occurred_at", (q) => q.gte("occurred_at", since30)),
    read(db, "community_reports", "id,status", (q) => q.in("status", ["submitted", "under_review"])),
    read(db, "environmental_observations", "id,verification,status", (q) => q.in("verification", ["unverified", "alleged"]).neq("status", "resolved")),
  ]);
  for (const t of [sites, find, cas, inc, reports, obs]) for (const id of idsOf(t.rows)) retrieved.add(id);
  if ([sites, find, cas, inc, reports, obs].some((t) => t.capped)) notices.push(`Some lists were capped at ${ROW_CAP} rows; figures may be understated.`);

  const claims: Claim[] = [
    { text: `${plural(sites.rows.length, "site")} in your scope (${fmt(tally(sites.rows, "status"))})${capNote(sites.rows.length)}.`, citations: cite(idsOf(sites.rows)) },
  ];
  if (find.rows.length) claims.push({ text: `${plural(find.rows.length, "critical or high finding")} open or acknowledged${capNote(find.rows.length)}.`, citations: cite(idsOf(find.rows)) });
  if (cas.rows.length) claims.push({ text: `${plural(cas.rows.length, "corrective action")} past due and not yet closed or verified${capNote(cas.rows.length)}.`, citations: cite(idsOf(cas.rows)) });
  if (inc.rows.length) {
    const dead = inc.rows.reduce((n, r) => n + (Number(r.fatalities) || 0), 0);
    const hurt = inc.rows.reduce((n, r) => n + (Number(r.injured) || 0), 0);
    claims.push({ text: `${plural(inc.rows.length, "incident")} occurred in the last 30 days; recorded fatalities ${dead}, recorded injured ${hurt}${capNote(inc.rows.length)}.`, citations: cite(idsOf(inc.rows)) });
  }
  if (reports.rows.length) claims.push({ text: `${plural(reports.rows.length, "community report")} awaiting triage or under review${capNote(reports.rows.length)}.`, citations: cite(idsOf(reports.rows)) });
  if (obs.rows.length) claims.push({ text: `${plural(obs.rows.length, "unverified or alleged environmental observation")} not yet resolved${capNote(obs.rows.length)}.`, citations: cite(idsOf(obs.rows)) });

  const pri = await inspectionPriorities(db, 3, now);
  for (const id of pri.retrieved) retrieved.add(id);
  if (pri.claims.length) {
    claims.push(...pri.claims.map((c) => ({ text: `Inspection priority ${c.text}`, citations: c.citations })));
  }
  notices.push("Figures are counts of recorded data as of generation time. This briefing is a draft for a human author to review; it makes no finding about any operator.");

  return {
    claims,
    retrieved,
    notices,
    abstainReason: null,
    data: { asOf: now.toISOString(), priorities: (pri.data as { rows?: PriorityRow[] } | null)?.rows ?? [] },
  };
}

// ------------------------------------------------------- document analysis

export const MAX_DOC_CHARS = 20_000;
const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";
const DATE_RES = [
  /\b\d{4}-\d{2}-\d{2}\b/g,
  new RegExp(`\\b\\d{1,2}\\s+(?:${MONTHS})\\s+\\d{4}\\b`, "gi"),
  new RegExp(`\\b(?:${MONTHS})\\s+\\d{1,2},?\\s+\\d{4}\\b`, "gi"),
  /\b\d{1,2}\/\d{1,2}\/\d{4}\b/g,
];
const QTY_RE = /(?:US\$|\$)\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:m³|m3|tonnes?|tons?|kg|mg\/l|ppm|hectares?|ha|km|litres?|liters?|usd|%)(?![\w³])/gi;
const TERMS = ["spill", "leak", "collapse", "fatal", "injur", "flood", "tailings", "mercury", "cyanide", "fire", "explosion", "landslide", "unguarded", "overdue", "expired", "contaminat", "erosion", "diversion"];

export function analyzeDocument(textRaw: unknown): Draft {
  if (typeof textRaw !== "string") throw new AiError("BAD_REQUEST", "text must be a string");
  if (textRaw.length > MAX_DOC_CHARS) throw new AiError("BAD_REQUEST", `text is limited to ${MAX_DOC_CHARS} characters`);
  const text = textRaw;
  const retrieved = new Set<string>();
  const notices: string[] = [];
  if (text.trim().length < 20) {
    return { claims: [], data: null, retrieved, notices, abstainReason: "The document text is too short to analyse." };
  }
  const injection = detectInjection(text);
  if (injection.length) notices.push("The document contains instruction-like text. It was treated as content to be described, never as instructions.");

  // Spans are the document's own citations; each is verified against the text.
  const spans: { id: string; start: number; end: number; excerpt: string }[] = [];
  const span = (start: number, end: number): string => {
    const e = Math.min(end, start + 240);
    const id = `span:${start}-${e}`;
    if (!retrieved.has(id)) {
      retrieved.add(id);
      spans.push({ id, start, end: e, excerpt: sanitizeUntrusted(text.slice(start, e), 240).replace(UUID_RE, "[id]") });
    }
    return id;
  };
  const claims: Claim[] = [];

  const sentences: { start: number; end: number }[] = [];
  for (const m of text.matchAll(/[^.!?\n]+[.!?]?/g)) {
    if (m[0].trim().length > 0 && m.index !== undefined) sentences.push({ start: m.index, end: m.index + m[0].length });
  }
  claims.push({ text: `The document is ${text.length} characters long in ${plural(sentences.length, "sentence")}.`, citations: [span(0, Math.min(text.length, 240))] });

  const seenDates = new Set<string>();
  for (const re of DATE_RES) {
    for (const m of text.matchAll(re)) {
      if (m.index === undefined || seenDates.has(m[0]) || seenDates.size >= 8) continue;
      seenDates.add(m[0]);
      claims.push({ text: `A date is mentioned: ${m[0]}.`, citations: [span(m.index, m.index + m[0].length)] });
    }
  }
  let qn = 0;
  for (const m of text.matchAll(QTY_RE)) {
    if (m.index === undefined || qn >= 10) break;
    qn++;
    claims.push({ text: `A quantity is mentioned: ${m[0].trim()}.`, citations: [span(m.index, m.index + m[0].length)] });
  }
  const lower = text.toLowerCase();
  for (const term of TERMS) {
    let from = 0;
    let n = 0;
    while (n < 2) {
      const at = lower.indexOf(term, from);
      if (at < 0) break;
      const sent = sentences.find((s) => at >= s.start && at < s.end);
      if (sent) {
        const sid = span(sent.start, sent.end);
        const ex = spans.find((s) => s.id === sid)!.excerpt;
        claims.push({ text: `The document uses the word "${term}" in this passage: "${ex}"`, citations: [sid] });
      }
      n++;
      from = (sent?.end ?? at + term.length) + 0;
    }
  }
  if (claims.length === 1) notices.push("No dates, quantities, or safety/environment terms were found.");
  notices.push("This is a mechanical extraction of what the text says. It does not assess accuracy, authenticity or compliance.");
  // Self-check: every span excerpt must really be in the document.
  const valid = new Set(spans.filter((s) => s.start >= 0 && s.start < s.end && s.end <= text.length).map((s) => s.id));
  return { claims, data: { spans }, retrieved: valid, notices, abstainReason: null, injectionFlagged: injection.length > 0 };
}
