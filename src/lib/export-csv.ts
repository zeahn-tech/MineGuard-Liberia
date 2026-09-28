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
