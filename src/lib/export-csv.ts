// ---------------------------------------------------------------------------
// GOVERNMENT REPORTING EXPORTS (§9) — CSV v1, client-side only.
//
// SCOPE DECISION (docs/01 §Reporting exports): v1 exports are CSV files
// serialized IN THE BROWSER from rows the caller's authorization already
// returned. There is no export endpoint, no service role, no export RPC —
// therefore no export path can exceed the caller's existing authorization
// by construction: RLS + the client authorization mirror filtered the rows
// before serialization ever sees them. An operator exporting their
// compliance obligations cannot obtain a row their feeds would not show.
//
// CSV conformance: RFC 4180 — quote fields containing comma/quote/newline,
// double embedded quotes, CRLF row terminator, UTF-8 with BOM so Excel
// decodes non-ASCII county/operator names correctly on double-click.
// ---------------------------------------------------------------------------

export type ExportColumn<T> = {
  header: string;
  value: (row: T) => string | number | boolean | null | undefined;
};

/** Serialize rows to RFC 4180 CSV (BOM included, CRLF line endings). */
export function toCsv<T>(rows: readonly T[], columns: readonly ExportColumn<T>[]): string {
  const cell = (raw: string | number | boolean | null | undefined): string => {
    if (raw === null || raw === undefined) return "";
    const s = String(raw);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    columns.map((c) => cell(c.header)).join(","),
    ...rows.map((r) => columns.map((c) => cell(c.value(r))).join(",")),
  ];
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------------
// SEC-4 v2 — STREAMING: large tables must not require whole-table memory.
// The primitives below serialize INCREMENTALLY: one chunk per page of rows
// (the row source releases each page as it is consumed), and the assembled
// bytes are exactly toCsv's output — same cell encoding, same BOM, same CRLF
// discipline — proven by csvByteParity in tests/scale-aggregation.test.ts.
// ---------------------------------------------------------------------------

/** Incremental cell encoder — the EXACT function toCsv's `cell` uses. */
export function csvCell(raw: string | number | boolean | null | undefined): string {
  if (raw === null || raw === undefined) return "";
  const s = String(raw);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The CSV's byte framing: BOM + header line + per-row CRLF-terminated lines.
 *  Exported so the batches/collects tests can splice chunks without knowing
 *  the framing. */
export const CSV_BOM = "\uFEFF";
export const CSV_EOL = "\r\n";

export function csvHeaderLine<T>(columns: readonly ExportColumn<T>[]): string {
  return columns.map((c) => csvCell(c.header)).join(",");
}

/** One page of rows → one CSV chunk (rows WITHOUT the framing/header). The
 *  terminator after the LAST row of a chunk is the caller's concat concern —
 *  covered by csvChunks/streamCsvFile (each chunk is always CRLF-terminated,
 *  which is correct for concatenation). */
export function csvRowChunk<T>(
  rows: readonly T[],
  columns: readonly ExportColumn<T>[],
): string {
  if (rows.length === 0) return "";
  return rows.map((r) => columns.map((c) => csvCell(c.value(r))).join(",")).join(
    CSV_EOL,
  ) + CSV_EOL;
}

/** Stream an ENTIRE export as an async generator of page-sized strings:
 *  chunk 0 = BOM + header, each later chunk = the page's rows. (async
 *  generators are syntax, not a runtime dependency — runs everywhere the
 *  app runs.) */
export function csvChunks<T>(
  pageSource: AsyncIterable<readonly T[]> | AsyncGenerator<readonly T[], void, unknown>,
  columns: readonly ExportColumn<T>[],
): AsyncGenerator<string, void, unknown> {
  return (async function* () {
    yield CSV_BOM + csvHeaderLine(columns) + CSV_EOL;
    for await (const page of pageSource) {
      const chunk = csvRowChunk(page, columns);
      if (chunk) yield chunk;
    }
  })();
}

/** Collect a streamed CSV into String parts (large-table friendly: the
 *  parts array holds the concatenated text, one entry per page). */
export async function csvParts<T>(
  pageSource: AsyncIterable<readonly T[]> | AsyncGenerator<readonly T[], void, unknown>,
  columns: readonly ExportColumn<T>[],
): Promise<string[]> {
  const parts: string[] = [];
  for await (const chunk of csvChunks(pageSource, columns)) parts.push(chunk);
  return parts;
}

/** Stream an entire export into ONE File (the full text assembled from the
 *  page parts) — the download path's behavior is byte-identical to csvFile,
 *  it just builds the string incrementally. For datasets too large for one
 *  in-memory string, consume csvChunks directly. */
export async function streamCsvText<T>(
  pageSource: AsyncIterable<readonly T[]> | AsyncGenerator<readonly T[], void, unknown>,
  columns: readonly ExportColumn<T>[],
): Promise<string> {
  return (await csvParts(pageSource, columns)).join("");
}

/** Stream an export into a dated File (csvFile's name/shape contract) from a
 *  page-source generator. */
export async function streamCsvFile<T>(
  pageSource: AsyncIterable<readonly T[]> | AsyncGenerator<readonly T[], void, unknown>,
  columns: readonly ExportColumn<T>[],
  baseName: string,
  now: Date = new Date(),
): Promise<File> {
  const text = await streamCsvText(pageSource, columns);
  const stamp = now.toISOString().slice(0, 10);
  const name = `mineguard-${baseName}-${stamp}.csv`;
  return new File([text], name, { type: "text/csv;charset=utf-8" });
}

/** Build a File from CSV text with a dated filename, e.g.
 *  mineguard-inspections-2026-09-28.csv — BOM + .csv extension. */
export function csvFile<T>(
  rows: readonly T[],
  columns: readonly ExportColumn<T>[],
  baseName: string,
  now: Date = new Date(),
): File {
  const stamp = now.toISOString().slice(0, 10);
  const name = `mineguard-${baseName}-${stamp}.csv`;
  return new File([toCsv(rows, columns)], name, {
    type: "text/csv;charset=utf-8",
  });
}

/** Browser download. Returns the filename the client received. The
 *  DOM-dependent default anchor implementation lives entirely inside the
 *  default trigger, so non-DOM callers/tests can inject their own. */
export function downloadFile(
  file: File,
  trigger: (f: File) => void = (f) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(f);
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  },
): string {
  trigger(file);
  return file.name;
}

// --------------------------------------------------------------- inspections
// The row shape of api.inspections.list (already scope-filtered by the
// data layer). Staff with national scope get the full set; county
// inspectors get their county; inspectors get their own submissions;
// operators get their sites' inspections read-only.

export type InspectionExportRow = {
  _id: string;
  siteCode: string;
  siteName: string;
  county: string;
  status: string;
  createdAt: number;
  submittedAt?: number;
  inspectorId: string;
};

export const INSPECTION_EXPORT_COLUMNS: ExportColumn<InspectionExportRow>[] = [
  { header: "Inspection ID", value: (r) => r._id },
  { header: "Site code", value: (r) => r.siteCode },
  { header: "Site name", value: (r) => r.siteName },
  { header: "County", value: (r) => r.county },
  { header: "Status", value: (r) => r.status },
  { header: "Created (UTC)", value: (r) => new Date(r.createdAt).toISOString() },
  {
    header: "Submitted (UTC)",
    value: (r) => (r.submittedAt ? new Date(r.submittedAt).toISOString() : ""),
  },
];

export function exportInspections(
  rows: readonly InspectionExportRow[],
  trigger?: (f: File) => void,
): string {
  return downloadFile(csvFile(rows, INSPECTION_EXPORT_COLUMNS, "inspections"), trigger);
}

// ---------------------------------------------------------- compliance (CAs)
// The row shape of api.inspections.listMyCorrectiveActions — the operator
// compliance feed, and the same shape staff can request for their scope.

export type ComplianceExportRow = {
  _id: string;
  description: string;
  status: string;
  dueAt: number;
  operatorNote?: string;
  findingTitle: string;
  findingSeverity: string;
  siteCode: string;
  siteName: string;
  county: string;
};

export const COMPLIANCE_EXPORT_COLUMNS: ExportColumn<ComplianceExportRow>[] = [
  { header: "Action ID", value: (r) => r._id },
  { header: "Site code", value: (r) => r.siteCode },
  { header: "Site name", value: (r) => r.siteName },
  { header: "County", value: (r) => r.county },
  { header: "Finding", value: (r) => r.findingTitle },
  { header: "Severity", value: (r) => r.findingSeverity },
  { header: "Action required", value: (r) => r.description },
  { header: "Status", value: (r) => r.status },
  { header: "Deadline (UTC)", value: (r) => new Date(r.dueAt).toISOString() },
  {
    header: "Deadline state",
    value: (r) =>
      r.status === "closed" || r.status === "verified"
        ? "resolved"
        : r.dueAt < Date.now()
          ? "overdue"
          : "open",
  },
  { header: "Operator response", value: (r) => r.operatorNote ?? "" },
];

export function exportComplianceObligations(
  rows: readonly ComplianceExportRow[],
  trigger?: (f: File) => void,
): string {
  return downloadFile(csvFile(rows, COMPLIANCE_EXPORT_COLUMNS, "compliance"), trigger);
}
