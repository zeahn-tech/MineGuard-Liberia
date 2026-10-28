import { describe, expect, test } from "bun:test";
import { IMPORT_MAX_ROWS, IMPORT_TEMPLATE, csvSafe, errorReportCsv, parseCsv, parseImportFile } from "../src/lib/csv-import";

describe("parseCsv", () => {
  test("quotes, escaped quotes, embedded commas and newlines, CRLF, BOM", () => {
    const t = '\uFEFFa,b\r\n"x,1","he said ""hi"""\n"line\nbreak",z\r\n';
    expect(parseCsv(t)).toEqual([["a", "b"], ["x,1", 'he said "hi"'], ["line\nbreak", "z"]]);
  });
  test("blank lines are ignored and a missing trailing newline is fine", () => {
    expect(parseCsv("a,b\n\n1,2")).toEqual([["a", "b"], ["1", "2"]]);
  });
});

describe("parseImportFile", () => {
  test("the shipped template parses with no problems", () => {
    const r = parseImportFile(IMPORT_TEMPLATE, IMPORT_TEMPLATE.length);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rows.length).toBe(2);
      expect(r.problems).toEqual([]);
    }
  });
  test("role defaults to worker; spaces and dashes normalize", () => {
    const r = parseImportFile("email,role\na@x.test,\nb@x.test,Safety Officer\nc@x.test,safety-officer\n", 80);
    if (!r.ok) throw new Error(r.error);
    expect(r.rows.map((x) => x.role)).toEqual(["worker", "safety_officer", "safety_officer"]);
    expect(r.problems).toEqual([]);
  });
  test("administrative roles, bad emails and in-file duplicates are reported per row", () => {
    const csv = "email,role\nboss@x.test,company_admin\nbad,worker\nok@x.test,worker\nOK@x.test,worker\nsm@x.test,site_manager\nofficer@x.test,onboarding_officer\n";
    const r = parseImportFile(csv, csv.length);
    if (!r.ok) throw new Error(r.error);
    const by = (n: number) => r.problems.filter((p) => p.row === n).map((p) => p.message).join("|");
    expect(by(1)).toMatch(/administrative roles cannot be imported/);
    expect(by(2)).toMatch(/Invalid email/);
    expect(by(4)).toMatch(/Duplicate of row 3/);
    expect(by(5)).toMatch(/administrative roles/);
    expect(by(6)).toMatch(/administrative roles/);
    expect(by(3)).toBe("");
  });
  test("structural rejections: no header, unknown columns, size, row cap, empty", () => {
    expect(parseImportFile("name\nx\n", 10)).toMatchObject({ ok: false });
    expect(parseImportFile("email,password\na@x.test,secret\n", 30)).toMatchObject({ ok: false, error: expect.stringContaining("Unknown column") });
    expect(parseImportFile("email\n", 7)).toMatchObject({ ok: false });
    expect(parseImportFile("email\na@x.test\n", 2_000_000)).toMatchObject({ ok: false, error: expect.stringContaining("1 MB") });
    const big = "email\n" + Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => `u${i}@x.test`).join("\n");
    expect(parseImportFile(big, big.length)).toMatchObject({ ok: false, error: expect.stringContaining("limit") });
  });
});

describe("report safety", () => {
  test("spreadsheet formula injection is neutralized and quoting is correct", () => {
    expect(csvSafe("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvSafe("a,b")).toBe('"a,b"');
    const csv = errorReportCsv([{ row: 2, email: "=cmd|x", outcome: "error", message: 'bad "thing"' }]);
    expect(csv).toContain("'=cmd|x");
    expect(csv).toContain('"bad ""thing"""');
  });
});
