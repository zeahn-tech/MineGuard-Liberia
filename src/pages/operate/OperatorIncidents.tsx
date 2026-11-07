// ---------------------------------------------------------------------------
// OPERATOR INCIDENTS — the operator's own incident records and the
// submission form. Incidents are how an operator reports what happened at
// their site (injury, near miss, discharge…); oversight staff set the
// investigation status. The submission form is offline-capable: it persists
// to the on-device queue FIRST (nothing silently dropped) and syncs with
// clientRef dedupe on reconnect — the same contract as staff field flows.
//
// DOCUMENT SUBMISSION: an incident report can carry supporting documents
// (photos of the scene, PDFs) through api.evidence.upload — metadata row +
// storage object + audit write server-side, kind detected from MIME
// (documents are application/pdf and text/*, images become 'photo' etc).
// ---------------------------------------------------------------------------

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useMutation, useQuery } from "@/lib/backend-react";
import { api } from "@/lib/backend";
import { newClientRef, enqueueIncidentReport } from "@/lib/offline-queue";
import { enqueuePendingEvidence } from "@/lib/offline-evidence";
import type { Incident } from "@/lib/types";
import { HeartPulse, Loader2, Paperclip, Send, X } from "lucide-react";
import { useRef, useState } from "react";
import { EmptyState } from "@/components/EmptyState";
import { FormField } from "@/components/FormField";
import { useFormDraft } from "@/hooks/use-form-draft";
import { toastError, toastProblem, toastSuccess } from "@/lib/feedback";
import { INCIDENT_FIELD_ORDER, validateIncident, type IncidentField } from "@/lib/form-rules";
import { firstInvalid, focusField, hasErrors, type FieldErrors } from "@/lib/validation";
import { PageLoading } from "@/components/PageLoading";

const DAY = 86_400_000;

const INCIDENT_TYPES: Incident["type"][] = [
  "fatality",
  "injury",
  "near_miss",
  "equipment_accident",
  "vehicle_accident",
  "fire",
  "structural_failure",
  "chemical_exposure",
  "environmental",
  "other",
];

const SEVERITIES: Incident["severity"][] = ["low", "medium", "high", "critical"];

type PendingDoc = { file: File; siteId: string };

function blankOperatorIncident() {
  return {
    siteId: "",
    type: "near_miss" as Incident["type"],
    severity: "low" as Incident["severity"],
    description: "",
    occurredAt: new Date(Date.now() - DAY).toISOString().slice(0, 10),
    fatalities: "",
    injured: "",
  };
}

const OP_FIELD_IDS: Record<IncidentField, string> = {
  siteId: "op-site",
  description: "op-desc",
  occurredAt: "op-date",
  fatalities: "op-fatal",
  injured: "op-inj",
};

function OperatorIncidentForm({ onDone }: { onDone: () => void }) {
  const sitesQ = useQuery(api.sites.list);
  const report = useMutation(api.records.reportIncident);
  const upload = useMutation(api.evidence.upload);

  // The written part of the report is kept safe on the device as it is typed
  // (a timeout, a dropped connection or a closed tab must not lose it). Attached
  // files can't be kept in a draft, so they are re-added after a restore.
  const { form, setForm, restoredAt, saveFailed, clearDraft, discardDraft } = useFormDraft(
    "operator-incident-report",
    blankOperatorIncident(),
  );
  const { siteId, type, severity, description, occurredAt, fatalities, injured } = form;
  const [errors, setErrors] = useState<FieldErrors<IncidentField>>({});
  const [attempted, setAttempted] = useState(false);
  const change = (patch: Partial<typeof form>) => {
    const next = { ...form, ...patch };
    setForm(next);
    if (attempted) setErrors(validateIncident(next));
  };
  const [docs, setDocs] = useState<PendingDoc[]>([]);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const sites = sitesQ ?? [];
  const selectedSite = sites.find((s) => s._id === siteId);

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files)) {
      if (f.size > 25 * 1024 * 1024) {
        toastProblem({ what: `${f.name} is over the 25 MB limit.`, whose: "Larger files can't be stored with a report.", fix: "Choose a smaller file, or compress it first." });
        continue;
      }
      if (!siteId) {
        toastProblem({ what: "Choose the site first.", whose: "Documents are stored against a site.", fix: "Pick the site above, then attach your files." });
        return;
      }
      setDocs((d) => [...d, { file: f, siteId }]);
    }
    if (fileRef.current) fileRef.current.value = "";
  };

  /** Upload every attached document; reports which failed but never blocks
   *  the incident itself (documents can also be attached later from the
   *  incident detail view). */
  const uploadDocs = async (incidentId: string): Promise<number> => {
    let ok = 0;
    for (const d of docs) {
      try {
        await upload({
          file: d.file,
          fileName: d.file.name,
          mimeType: d.file.type || "application/octet-stream",
          parentType: "incident",
          parentId: incidentId,
          siteId: d.siteId,
          caption: "Submitted with incident report",
        });
        ok++;
      } catch (err) {
        console.error("Document upload failed:", err);
        toastProblem({ what: `${d.file.name} didn't upload.`, whose: "The report itself was saved.", fix: "Open the incident from the list below and attach the file there." });
      }
    }
    return ok;
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const found = validateIncident(form);
    setErrors(found);
    setAttempted(true);
    if (hasErrors(found)) {
      const first = firstInvalid(found, INCIDENT_FIELD_ORDER);
      if (first) focusField(OP_FIELD_IDS[first]);
      return;
    }
    setBusy(true);
    const clientRef = newClientRef();
    const args = {
      siteId,
      type,
      severity,
      description: description.trim(),
      occurredAt: new Date(`${occurredAt}T12:00:00Z`).getTime(),
      fatalities: fatalities ? Number(fatalities) : undefined,
      injured: injured ? Number(injured) : undefined,
      clientRef,
    };
    try {
      // Online path: submit directly (clientRef dedupe protects retries).
      const incidentId = await report(args);
      if (docs.length > 0) await uploadDocs(incidentId);
      toastSuccess({
        title: "Incident reported.",
        reassure: "It's saved and attributed to your account. You can follow its status in the list.",
      });
      setForm(blankOperatorIncident());
      clearDraft();
      onDone();
    } catch (err) {
      // OFFLINE PATH: persist to the device queue — nothing silently dropped.
      // The queued item syncs automatically on reconnect with the SAME
      // clientRef, so the server creates exactly one record.
      const msg = err instanceof Error ? err.message : String(err);
      if (!navigator.onLine || msg.includes("Failed to fetch")) {
        try {
          // Awaited: a device that cannot persist rejects here and NOTHING
          // below claims the report was saved (OFF-2).
          await enqueueIncidentReport({
            clientRef,
            siteId,
            siteCode: selectedSite?.code ?? "",
            type,
            severity,
            description: description.trim(),
            occurredAt: args.occurredAt,
            fatalities: args.fatalities,
            injured: args.injured,
          });
          // OFF-6: the documents are queued against the LOCAL incident
          // (parentRef) — they upload once the parent syncs and receives its
          // server id, instead of being dropped with the offline branch.
          for (const d of docs) {
            await enqueuePendingEvidence({
              parentType: "incident",
              parentId: "",
              parentRef: clientRef,
              siteId: d.siteId,
              fileName: d.file.name,
              mimeType: d.file.type || "application/octet-stream",
              blob: d.file,
              caption: "Submitted with incident report",
              capturedAt: Date.now(),
            });
          }
        } catch (e) {
          toastError(e, { action: "save the report on this device" });
          return; // stay in the form: the data exists only here right now
        }
        toastSuccess({
          title: "Saved on this device.",
          reassure: `You appear to be offline. The report${docs.length > 0 ? ` and ${docs.length} document${docs.length === 1 ? "" : "s"}` : ""} will be sent automatically when you reconnect — nothing is lost.`,
        });
        setForm(blankOperatorIncident());
        clearDraft();
        onDone();
        return;
      }
      console.error("Incident report failed:", err);
      if (msg.includes("NOT_FOUND")) {
        toastProblem({
          what: "That site isn't visible to your account.",
          whose: "It may have been removed or reassigned.",
          fix: "Choose another site from the list. If it should be there, ask your company administrator.",
        });
      } else if (msg.includes("FORBIDDEN")) {
        toastProblem({
          what: "You can only report incidents on your own company's sites.",
          whose: "The site you chose belongs to another company.",
          fix: "Choose one of your company's sites from the list.",
        });
      } else {
        toastError(err, { action: "submit the incident report" });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="paper rounded-none border-border shadow-none">
      <CardHeader className="pb-2">
        <p className="kicker">New report</p>
        <CardTitle className="display text-lg">Report an incident</CardTitle>
        <CardDescription>
          Operational categories only — this is not a legal determination. The
          report is attributed to your account in the audit trail.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} noValidate className="space-y-3">
          {restoredAt && (
            <p role="status" className="flex flex-wrap items-center gap-x-2 rounded-sm border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              <span>
                Restored your unsaved draft from{" "}
                {new Date(restoredAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}. Attached
                files aren't kept in drafts — add them again.
              </span>
              <button type="button" className="font-medium text-foreground underline underline-offset-2" onClick={discardDraft}>
                Start over
              </button>
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Site" required id={OP_FIELD_IDS.siteId} error={errors.siteId}>
              {(a11y) => (
              <Select value={siteId} onValueChange={(v) => change({ siteId: v })} disabled={busy}>
                <SelectTrigger {...a11y}>
                  <SelectValue placeholder="Your sites…" />
                </SelectTrigger>
                <SelectContent>
                  {sites.map((s) => (
                    <SelectItem key={s._id} value={s._id}>
                      {s.code} — {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              )}
            </FormField>
            <FormField label="Occurred on" required id={OP_FIELD_IDS.occurredAt} error={errors.occurredAt}>
              {(a11y) => (
                <Input
                  {...a11y}
                  type="date"
                  value={occurredAt}
                  onChange={(e) => change({ occurredAt: e.target.value })}
                  disabled={busy}
                />
              )}
            </FormField>
            <div className="space-y-1.5">
              <Label htmlFor="op-type">Type</Label>
              <Select value={type} onValueChange={(v) => change({ type: v as Incident["type"] })} disabled={busy}>
                <SelectTrigger id="op-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INCIDENT_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t.replace(/_/g, " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="op-sev">Severity</Label>
              <Select value={severity} onValueChange={(v) => change({ severity: v as Incident["severity"] })} disabled={busy}>
                <SelectTrigger id="op-sev">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SEVERITIES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <FormField label="Fatalities (if any)" id={OP_FIELD_IDS.fatalities} error={errors.fatalities}>
              {(a11y) => (
                <Input
                  {...a11y}
                  type="number"
                  min={0}
                  value={fatalities}
                  onChange={(e) => change({ fatalities: e.target.value })}
                  placeholder="0"
                  disabled={busy}
                />
              )}
            </FormField>
            <FormField label="Injured (if any)" id={OP_FIELD_IDS.injured} error={errors.injured}>
              {(a11y) => (
                <Input
                  {...a11y}
                  type="number"
                  min={0}
                  value={injured}
                  onChange={(e) => change({ injured: e.target.value })}
                  placeholder="0"
                  disabled={busy}
                />
              )}
            </FormField>
          </div>
          <FormField label="What happened" required id={OP_FIELD_IDS.description} error={errors.description}>
            {(a11y) => (
              <Textarea
                {...a11y}
                value={description}
                onChange={(e) => change({ description: e.target.value })}
                rows={4}
                placeholder="Describe the incident factually…"
                disabled={busy}
              />
            )}
          </FormField>

          {/* Document submission */}
          <div className="space-y-1.5">
            <Label>Supporting documents (optional)</Label>
            <input
              ref={fileRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => addFiles(e.target.files)}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || !siteId}
                onClick={() => fileRef.current?.click()}
              >
                <Paperclip className="mr-1.5 size-3.5" strokeWidth={1.5} />
                Attach files
              </Button>
              {docs.map((d, i) => (
                <span
                  key={`${d.file.name}-${i}`}
                  className="flex items-center gap-1 rounded border border-border bg-muted/40 px-2 py-1 text-xs"
                >
                  {d.file.name.slice(0, 28)}
                  <button
                    type="button"
                    aria-label={`Remove ${d.file.name}`}
                    onClick={() => setDocs((arr) => arr.filter((_, j) => j !== i))}
                    disabled={busy}
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Photos, PDFs or other files up to 25MB each. Stored in the
              evidence vault with a metadata row and audit entry.
            </p>
          </div>

          {attempted && Object.values(errors).some(Boolean) && (
            <p role="alert" className="text-sm text-destructive">
              {Object.values(errors).filter(Boolean).length === 1
                ? "One field needs attention"
                : `${Object.values(errors).filter(Boolean).length} fields need attention`}{" "}
              — marked above.
            </p>
          )}
          {saveFailed && (
            <p role="status" className="text-xs text-muted-foreground">
              This device couldn't keep a draft of this form (its storage may be full or blocked). Submit it now so
              nothing is lost.
            </p>
          )}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Send className="mr-2 size-4" strokeWidth={1.5} />}
            Submit incident report
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export default function OperatorIncidents() {
  const incidentsQ = useQuery(api.records.listIncidents);
  const [showForm, setShowForm] = useState(false);

  const incidents = incidentsQ ?? [];

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="kicker">Operator portal</p>
          <h1 className="display text-2xl">Incidents</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Reports from your company's sites. Investigation status is set by
            the oversight staff — you report, they investigate.
          </p>
        </div>
        <Button variant={showForm ? "outline" : "default"} onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Close form" : "Report an incident"}
        </Button>
      </div>

      {showForm && (
        <OperatorIncidentForm
          onDone={() => {
            setShowForm(false);
          }}
        />
      )}

      {incidentsQ === undefined && (
        <PageLoading shape="list" label="incidents" />
      )}
      {incidentsQ !== undefined && incidents.length === 0 && (
        <EmptyState
          icon={HeartPulse}
          title="No incidents reported yet"
          why="Nothing has been reported for your company's sites. When something happens, including a near miss, report it here so it is on record."
          action={showForm ? undefined : { label: "Report an incident", onClick: () => setShowForm(true) }}
        />
      )}

      <div className="space-y-3">
        {incidents.map((i) => (
          <Card key={i._id} className="paper rounded-none border-border shadow-none">
            <CardContent className="pt-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{i.type.replace(/_/g, " ")}</span>
                <span className="text-xs text-muted-foreground">· {i.siteCode} {i.siteName}</span>
                <span
                  className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                    i.severity === "critical" || i.severity === "high"
                      ? "border-destructive/30 bg-destructive/10 text-destructive"
                      : "border-border bg-muted text-muted-foreground"
                  }`}
                >
                  {i.severity}
                </span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {new Date(i.occurredAt).toLocaleDateString()} · status: {i.status}
                </span>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{i.description}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
