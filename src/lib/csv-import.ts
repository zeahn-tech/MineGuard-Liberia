// ---------------------------------------------------------------------------
// Bulk workforce import — client-side CSV parsing and PRE-validation (Phase E).
// This is a convenience for fast feedback. It is NOT the security boundary: the
// server re-validates every row (mg_import_check / mg_import_apply) and only
// ever creates pending invitations for `worker` / `safety_officer`.
// ---------------------------------------------------------------------------

export const IMPORT_MAX_BYTES = 1_000_000; // 1 MB
export const IMPORT_MAX_ROWS = 2000;
export const IMPORT_BATCH = 100;

export const IMPORT_TEMPLATE =
  "email,role,full_name,site_code\nworker.one@example.com,worker,Worker One,\nsafety.lead@example.com,safety_officer,Safety Lead,LB-BOM-001\n";

export interface ImportRow {
  /** 1-based data-row number (header excluded), stable across retries. */
  row: number;
  email: string;
  role: string;
  full_name: string;
  site_code: string;
}

export interface RowProblem {
  row: number;
  message: string;
}

export type ParseResult =
  | { ok: false; error: string }
  | { ok: true; rows: ImportRow[]; problems: RowProblem[] };

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ALLOWED_ROLES = new Set(["worker", "safety_officer"]);

/** RFC-4180-style parser: quotes, escaped quotes, CRLF/LF, BOM, embedded commas/newlines. */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

/** A spreadsheet cell starting with = + - @ can execute as a formula when the error report is opened. */
export function csvSafe(value: string): string {
  const v = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function parseImportFile(text: string, byteLength: number): ParseResult {
  if (byteLength > IMPORT_MAX_BYTES) return { ok: false, error: "The file is larger than 1 MB. Split it into smaller files." };
  const table = parseCsv(text);
  if (table.length < 2) return { ok: false, error: "The file has no data rows." };
  const header = table[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const iEmail = col("email");
  if (iEmail < 0) return { ok: false, error: 'The first row must be a header with an "email" column.' };
  const known = new Set(["email", "role", "full_name", "site_code"]);
  const unknown = header.filter((h) => h && !known.has(h));
  if (unknown.length) return { ok: false, error: `Unknown column(s): ${unknown.join(", ")}. Use email, role, full_name, site_code.` };
  const data = table.slice(1);
  if (data.length > IMPORT_MAX_ROWS) return { ok: false, error: `The file has ${data.length} rows; the limit is ${IMPORT_MAX_ROWS} per import.` };

  const get = (r: string[], name: string) => (col(name) >= 0 ? (r[col(name)] ?? "").trim() : "");
  const rows: ImportRow[] = data.map((r, idx) => ({
    row: idx + 1,
    email: get(r, "email").toLowerCase(),
    role: get(r, "role").toLowerCase().replace(/[\s-]+/g, "_") || "worker",
    full_name: get(r, "full_name"),
    site_code: get(r, "site_code"),
  }));

  const problems: RowProblem[] = [];
  const seen = new Map<string, number>();
  for (const r of rows) {
    if (!r.email) problems.push({ row: r.row, message: "Email is required" });
    else if (!EMAIL.test(r.email) || r.email.length > 254) problems.push({ row: r.row, message: "Invalid email address" });
    else if (seen.has(r.email)) problems.push({ row: r.row, message: `Duplicate of row ${seen.get(r.email)}` });
    else seen.set(r.email, r.row);
    if (!ALLOWED_ROLES.has(r.role)) {
      problems.push({ row: r.row, message: "Role must be worker or safety_officer (administrative roles cannot be imported)" });
    }
    if (r.full_name.length > 120) problems.push({ row: r.row, message: "Name is too long (120 characters maximum)" });
  }
  return { ok: true, rows, problems };
}

export function errorReportCsv(items: { row: number; email: string; outcome: string; message: string }[]): string {
  const lines = ["row,email,outcome,message", ...items.map((i) => [String(i.row), csvSafe(i.email), csvSafe(i.outcome), csvSafe(i.message)].join(","))];
  return lines.join("\r\n") + "\r\n";
}
