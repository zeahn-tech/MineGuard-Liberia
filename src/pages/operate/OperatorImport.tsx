// ---------------------------------------------------------------------------
// BULK WORKFORCE IMPORT (Phase E) — for company administrators and the
// dedicated Onboarding officer. A CSV becomes PENDING INVITATIONS only:
// nobody is given an account, a membership or an administrative role; each
// person must still sign in with a verified email and accept.
// The browser parses for fast feedback; the DATABASE re-validates every row.
// ---------------------------------------------------------------------------

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/backend";
import { useQuery } from "@/lib/backend-react";
import {
  IMPORT_BATCH,
  IMPORT_TEMPLATE,
  errorReportCsv,
  parseImportFile,
  type ImportRow,
} from "@/lib/csv-import";
import type { ImportOutcome, ImportStatus } from "@/lib/types";
import { Download, FileUp, Loader2, MailCheck, ShieldAlert } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

type Stage = "choose" | "checking" | "preview" | "importing" | "done";

interface Preview {
  rows: ImportRow[];
  filename: string;
  /** row -> verdict (client problems first, then the server's) */
  verdicts: Map<number, { outcome: string; message: string }>;
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function errMsg(e: unknown): string {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "You're offline — reconnect and try again. Nothing is lost: retrying is safe.";
  return e instanceof Error && e.message ? e.message : "Something went wrong. Try again.";
}

const chunk = <T,>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

export default function OperatorImport() {
  const me = useQuery(api.workforce.myMembership);
  const fileRef = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<Stage>("choose");
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [progress, setProgress] = useState(0);
  const [importId, setImportId] = useState<string | null>(null);
  const [status, setStatus] = useState<ImportStatus | null>(null);
  const [sending, setSending] = useState(false);
  const [key] = useState(() => crypto.randomUUID());

  if (me === undefined) return <p className="text-sm text-muted-foreground" role="status">Loading…</p>;
  const allowed = me?.memberStatus === "active" && (me.orgRole === "company_admin" || me.orgRole === "onboarding_officer");
  if (!me || !allowed) {
    return (
      <div className="paper flex min-w-0 items-start gap-3 p-6">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
        <p className="text-sm">Importing workers is limited to company administrators and onboarding officers.</p>
      </div>
    );
  }
  if (me.companyStatus !== "approved") {
    return <div className="paper p-6 text-sm">{me.organizationName} is not currently approved, so onboarding is paused.</div>;
  }
  const orgId = me.organizationId;

  function reset() {
    setStage("choose");
    setPreview(null);
    setError(null);
    setProgress(0);
    setImportId(null);
    setStatus(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function onFile(file: File | undefined) {
    setError(null);
    if (!file) return;
    if (!/\.csv$/i.test(file.name) && file.type !== "text/csv") {
      return setError("Choose a .csv file (use the template below).");
    }
    const parsed = parseImportFile(await file.text(), file.size);
    if (!parsed.ok) return setError(parsed.error);
    setStage("checking");
    try {
      const verdicts = new Map<number, { outcome: string; message: string }>();
      for (const p of parsed.problems) if (!verdicts.has(p.row)) verdicts.set(p.row, { outcome: "error", message: p.message });
      // Server dry run in batches (writes nothing): sees existing members / invitations / sites.
      const total = parsed.rows.length;
      let done = 0;
      for (const batch of chunk(parsed.rows, IMPORT_BATCH)) {
        const out: ImportOutcome[] = await api.workforce.importCheck({ organizationId: orgId, rows: batch });
        for (const o of out) if (!verdicts.has(o.row)) verdicts.set(o.row, { outcome: o.outcome, message: o.message });
        done += batch.length;
        setProgress(Math.round((done / total) * 100));
      }
      setPreview({ rows: parsed.rows, filename: file.name, verdicts });
      setStage("preview");
    } catch (e) {
      setError(errMsg(e));
      setStage("choose");
    }
  }

  async function runImport() {
    if (!preview) return;
    setStage("importing");
    setProgress(0);
    setError(null);
    try {
      // The key makes "Start" retry-safe: the same key always resolves to the same import.
      const id = await api.workforce.importStart({ organizationId: orgId, key, filename: preview.filename, totalRows: preview.rows.length });
      setImportId(id);
      let done = 0;
      for (const batch of chunk(preview.rows, IMPORT_BATCH)) {
        await api.workforce.importApply({ importId: id, rows: batch });
        done += batch.length;
        setProgress(Math.round((done / preview.rows.length) * 100));
      }
      setStatus(await api.workforce.importStatus({ importId: id }));
      setStage("done");
    } catch (e) {
      // Safe to press the button again: processed rows are never repeated.
      setError(`${errMsg(e)} You can press "Import" again — rows already processed are not repeated.`);
      setStage("preview");
    }
  }

  async function sendEmails() {
    if (!importId) return;
    setSending(true);
    setError(null);
    try {
      let totalSent = 0;
      for (let round = 0; round < 200; round++) {
        const r = await api.workforce.sendImportEmails({ importId });
        totalSent += r.sent;
        setStatus(await api.workforce.importStatus({ importId }));
        if (r.remaining === 0) break;
        if (r.sent === 0) {
          setError("Some emails could not be sent (check the email service). Press Send again later — nothing is repeated.");
          break;
        }
      }
      if (totalSent > 0) toast.success(`${totalSent} invitation email${totalSent === 1 ? "" : "s"} sent.`);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setSending(false);
    }
  }

  async function downloadReport() {
    if (!importId) return;
    try {
      const rows = await api.workforce.importProblemRows({ importId });
      download("import-problems.csv", errorReportCsv(rows));
    } catch (e) {
      setError(errMsg(e));
    }
  }

  const counts = preview
    ? [...preview.verdicts.values()].reduce(
        (a, v) => ((a[v.outcome] = (a[v.outcome] ?? 0) + 1), a),
        {} as Record<string, number>,
      )
    : {};
  const problems = preview ? [...preview.verdicts.entries()].filter(([, v]) => v.outcome === "error" || v.outcome === "duplicate_in_file").sort((a, b) => a[0] - b[0]) : [];
  const ready = counts.ok ?? 0;

  return (
    <div className="min-w-0 space-y-6">
      <header className="min-w-0">
        <p className="kicker">{me.organizationName}</p>
        <h1 className="display mt-1 text-2xl break-words sm:text-3xl">Import workers</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Upload a CSV to invite many people at once. Nobody is added until they receive the email, sign in with that address and
          accept. Only the roles <strong>worker</strong> and <strong>safety_officer</strong> can be imported.
        </p>
      </header>

      {error && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>
      )}

      {(stage === "choose" || stage === "checking") && (
        <Card>
          <CardHeader><CardTitle className="text-base">1. Choose your file</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <Button variant="outline" size="sm" onClick={() => download("mineguard-workers-template.csv", IMPORT_TEMPLATE)}>
              <Download className="size-3.5" /> Download the template
            </Button>
            <p className="text-xs text-muted-foreground">
              Columns: <code>email</code> (required), <code>role</code> (worker or safety_officer; blank = worker),
              <code> full_name</code>, <code>site_code</code> (optional; the person is assigned to that site when they accept).
              Up to 2,000 rows and 1&nbsp;MB per file.
            </p>
            <input ref={fileRef} type="file" accept=".csv,text/csv" disabled={stage === "checking"} aria-label="CSV file"
              className="block w-full text-sm file:mr-3 file:rounded-md file:border file:bg-background file:px-3 file:py-1.5 file:text-sm"
              onChange={(e) => void onFile(e.target.files?.[0])} />
            {stage === "checking" && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                <Loader2 className="size-4 animate-spin" /> Checking your file… {progress}%
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {stage === "preview" && preview && (
        <Card>
          <CardHeader><CardTitle className="text-base">2. Review before importing — {preview.filename}</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2 text-sm">
              <Badge variant="secondary">{ready} ready to invite</Badge>
              {(counts.already_member ?? 0) > 0 && <Badge variant="outline">{counts.already_member} already members</Badge>}
              {(counts.already_invited ?? 0) > 0 && <Badge variant="outline">{counts.already_invited} already invited</Badge>}
              {problems.length > 0 && <Badge variant="destructive">{problems.length} with problems</Badge>}
              <Badge variant="outline">{preview.rows.length} rows</Badge>
            </div>
            {problems.length > 0 && (
              <div className="max-h-64 overflow-auto rounded-md border">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-muted/60"><tr><th className="p-2">Row</th><th className="p-2">Email</th><th className="p-2">Problem</th></tr></thead>
                  <tbody>
                    {problems.slice(0, 100).map(([row, v]) => (
                      <tr key={row} className="border-t">
                        <td className="p-2">{row}</td>
                        <td className="break-all p-2">{preview.rows[row - 1]?.email}</td>
                        <td className="p-2">{v.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {problems.length > 100 && <p className="text-xs text-muted-foreground">Showing the first 100 problems; the full list is in the report after importing.</p>}
            <p className="text-xs text-muted-foreground">
              Rows with problems are skipped; everything else is imported. You can fix the file and import the skipped rows later.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button disabled={ready === 0} onClick={() => void runImport()}>
                <FileUp className="size-4" /> Import {ready} {ready === 1 ? "person" : "people"}
              </Button>
              <Button variant="ghost" onClick={reset}>Choose another file</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {stage === "importing" && (
        <Card>
          <CardContent className="space-y-2 pt-6">
            <p className="flex items-center gap-2 text-sm" role="status"><Loader2 className="size-4 animate-spin" /> Creating invitations… {progress}%</p>
            <div className="h-2 overflow-hidden rounded bg-muted"><div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} /></div>
            <p className="text-xs text-muted-foreground">Keep this page open. If the connection drops, press Import again — nothing is duplicated.</p>
          </CardContent>
        </Card>
      )}

      {stage === "done" && status && (
        <Card>
          <CardHeader><CardTitle className="text-base">3. Send the invitation emails</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2 text-sm">
              <Badge variant="secondary">{status.invited} invitations created</Badge>
              {status.alreadyMember > 0 && <Badge variant="outline">{status.alreadyMember} already members</Badge>}
              {status.alreadyInvited > 0 && <Badge variant="outline">{status.alreadyInvited} already invited</Badge>}
              {status.duplicates + status.errors > 0 && <Badge variant="destructive">{status.duplicates + status.errors} skipped</Badge>}
            </div>
            <p className="text-sm">
              {status.unsent > 0
                ? `${status.unsent} invitation${status.unsent === 1 ? " is" : "s are"} waiting to be emailed.`
                : "All invitation emails have been sent."}
            </p>
            <div className="flex flex-wrap gap-2">
              {status.unsent > 0 && (
                <Button disabled={sending} onClick={() => void sendEmails()}>
                  {sending ? <Loader2 className="size-4 animate-spin" /> : <MailCheck className="size-4" />} Send emails
                </Button>
              )}
              {status.duplicates + status.errors > 0 && (
                <Button variant="outline" onClick={() => void downloadReport()}><Download className="size-4" /> Download problem report</Button>
              )}
              <Button variant="ghost" onClick={reset}>Import another file</Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Invitations expire after 7 days. Emails are sent a few at a time, and failed ones can be retried without repeating the rest.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
