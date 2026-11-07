import { useState } from "react";
import { Link } from "react-router";
import { useKeysetPage, useMutation, useQuery } from "@/lib/backend-react";
import { api } from "@/lib/backend";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { CloudOff, HeartPulse, Plus } from "lucide-react";
import { enqueueIncidentReport, newClientRef, syncQueue } from "@/lib/offline-queue";
import { PageLoading } from "@/components/PageLoading";
import { IncidentInsightsPanel } from "@/components/IncidentInsightsPanel";
import { EmptyState } from "@/components/EmptyState";
import { FormField, invalidControlClass } from "@/components/FormField";
import { useFormDraft } from "@/hooks/use-form-draft";
import { toastError, toastSuccess } from "@/lib/feedback";
import { INCIDENT_FIELD_ORDER, localDateString, validateIncident, type IncidentField } from "@/lib/form-rules";
import { firstInvalid, focusField, hasErrors, type FieldErrors } from "@/lib/validation";

const TYPES = [
  { value: "fatality", label: "Fatality" },
  { value: "injury", label: "Injury" },
  { value: "near_miss", label: "Near miss" },
  { value: "equipment_accident", label: "Equipment accident" },
  { value: "vehicle_accident", label: "Vehicle accident" },
  { value: "fire", label: "Fire" },
  { value: "structural_failure", label: "Structural failure" },
  { value: "chemical_exposure", label: "Chemical exposure" },
  { value: "environmental", label: "Environmental" },
  { value: "other", label: "Other" },
] as const;

const SEVERITIES = ["low", "medium", "high", "critical"] as const;

export default function Incidents() {
  // SEC-4 v2: the list consumes the SERVER-SIDE keyset page (migration
  // 0014): 500-row windows resumable by cursor. The whole-table list query
  // stays as the fallback the hook builds on — no behavior change visible
  // at pilot scale.
  const feed = useKeysetPage(
    (before) =>
      api.records.incidentsPage({ before: before as never, limit: 500 }),
    1,
  );
  const incidents = feed.rows;
  const [reportOpen, setReportOpen] = useState(false);
  const sites = useQuery(api.sites.list);
  const setStatus = useMutation(api.records.setIncidentStatus);
  const { user } = useAuth();
  const isStaff =
    user?.role === "admin" || user?.role === "supervisor" || user?.role === "inspector";

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toastSuccess({ title: ok });
    } catch (e) {
      toastError(e, { action: "update the incident" });
    }
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="kicker">Incident management</p>
          <h1 className="display text-3xl">Incidents</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Operational categories — not legal classifications. Every record is
            attributable and time-stamped.
          </p>
        </div>
        {sites && sites.length > 0 && <ReportDialog open={reportOpen} onOpenChange={setReportOpen} />}
      </header>

      {user?.role && incidents.length > 0 && <IncidentInsightsPanel />}

      {incidents.length === 0 && feed.loading ? (
        <PageLoading shape="list" label="incidents" />
      ) : incidents.length === 0 ? (
        <EmptyState
          icon={HeartPulse}
          title="No incidents recorded yet"
          why={
            sites && sites.length === 0
              ? "Incidents are reported against a registered site, and none are registered in your area yet. An administrator registers sites."
              : "Nothing has been reported for the sites in your area. Reports appear here as soon as they are submitted, including ones sent from the field."
          }
          action={
            sites && sites.length === 0
              ? { label: "Go to Sites", to: "/portal/sites" }
              : sites
                ? { label: "Report an incident", onClick: () => setReportOpen(true) }
                : undefined
          }
        />
      ) : (
        <div className="scrollbar-hide overflow-x-auto rounded-sm border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left">
                <th className="px-4 py-2.5 font-medium">Occurred</th>
                <th className="px-4 py-2.5 font-medium">Type</th>
                <th className="px-4 py-2.5 font-medium">Description</th>
                <th className="px-4 py-2.5 font-medium">Site</th>
                <th className="px-4 py-2.5 font-medium">Severity</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                {isStaff && <th className="px-4 py-2.5" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {incidents.map((i) => (
                <tr key={i._id} className="align-top">
                  <td className="whitespace-nowrap px-4 py-3">
                    {new Date(i.occurredAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3">{i.type.replace(/_/g, " ")}</td>
                  <td className="max-w-md px-4 py-3">
                    <Link
                      to={`/portal/incidents/${i._id}`}
                      className="hover:underline"
                    >
                      {i.description}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs">{i.siteCode}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`stamp ${i.severity === "critical" || i.severity === "high" ? "text-destructive" : ""}`}>
                      {i.severity}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {i.status}
                    </Badge>
                  </td>
                  {isStaff && (
                    <td className="px-4 py-3 text-right">
                      {i.status === "reported" && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => act(() => setStatus({ incidentId: i._id, status: "investigating" }), "Status updated")}
                        >
                          Investigate
                        </Button>
                      )}
                      {i.status === "investigating" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => act(() => setStatus({ incidentId: i._id, status: "closed" }), "Incident closed")}
                        >
                          Close
                        </Button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {feed.hasMore && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" disabled={feed.loading} onClick={feed.loadMore}>
            {feed.loading ? "Loading…" : "Load more incidents"}
          </Button>
        </div>
      )}
    </div>
  );
}

function blankIncident() {
  return {
    siteId: "",
    type: "injury",
    severity: "medium",
    description: "",
    occurredAt: localDateString(),
    fatalities: "",
    injured: "",
  };
}

const FIELD_IDS: Record<IncidentField, string> = {
  siteId: "incident-site",
  description: "incident-description",
  occurredAt: "incident-date",
  fatalities: "incident-fatalities",
  injured: "incident-injured",
};

function ReportDialog({
  open: openProp,
  onOpenChange,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const sites = useQuery(api.sites.list);
  const report = useMutation(api.records.reportIncident);
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = onOpenChange ?? setOpenState;
  const [saving, setSaving] = useState(false);
  // The form is kept safe on the device as it is filled in, so a timeout,
  // a dropped connection or a closed tab never costs the person their account.
  const { form, setForm, restoredAt, hasDraft, saveFailed, clearDraft, discardDraft } = useFormDraft(
    "incident-report",
    blankIncident(),
  );
  const [errors, setErrors] = useState<FieldErrors<IncidentField>>({});
  const [attempted, setAttempted] = useState(false);

  // Edit a field: store it, and re-check just that form live once the person
  // has tried to submit (so a fixed field clears its own message straight away).
  const change = (patch: Partial<typeof form>) => {
    const next = { ...form, ...patch };
    setForm(next);
    if (attempted) setErrors(validateIncident(next));
  };

  const submit = async () => {
    if (saving) return;
    const found = validateIncident(form);
    setErrors(found);
    setAttempted(true);
    if (hasErrors(found)) {
      const first = firstInvalid(found, INCIDENT_FIELD_ORDER);
      if (first) focusField(FIELD_IDS[first]);
      return;
    }
    setSaving(true);
    let queued = false;
    try {
      // Offline-first: enqueue BEFORE any network attempt. If online the item
      // syncs immediately; if offline it stays queued and syncs on reconnect
      // with server-side clientRef dedupe (nothing is lost or duplicated).
      const clientRef = newClientRef();
      // Awaited: if the device cannot store the item (quota, private mode)
      // the rejection lands in the catch below and NO "saved" toast shows.
      await enqueueIncidentReport({
        clientRef,
        siteId: form.siteId,
        siteCode: sites?.find((s) => s._id === form.siteId)?.code ?? "site",
        type: form.type,
        severity: form.severity,
        description: form.description.trim(),
        occurredAt: new Date(form.occurredAt).getTime(),
        fatalities: form.fatalities ? Number(form.fatalities) : undefined,
        injured: form.injured ? Number(form.injured) : undefined,
      });
      queued = true;
      const siteId = form.siteId;
      const result = await syncQueue({ reportIncident: report });
      if (result.synced > 0) {
        toastSuccess({
          title: "Incident reported.",
          reassure: "It's saved and now visible to everyone responsible for this site.",
          next: { label: "View site", to: `/portal/sites/${siteId}` },
        });
      } else {
        toastSuccess({
          title: "Saved on this device.",
          reassure: "It will be sent automatically as soon as you're back online — nothing is lost, and you can keep working.",
        });
      }
      setOpen(false);
      setForm(blankIncident());
      clearDraft();
      setErrors({});
      setAttempted(false);
    } catch (e) {
      if (queued) {
        // The report is already safe on the device; only the send failed.
        toastSuccess({
          title: "Saved on this device.",
          reassure: "We couldn't send it just now, so it will be retried automatically. Nothing is lost.",
        });
        setOpen(false);
        setForm(blankIncident());
        clearDraft();
      } else {
        toastError(e, { action: "save the incident report" });
      }
    } finally {
      setSaving(false);
    }
  };

  const failing = Object.values(errors).filter(Boolean).length;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="size-4" /> {hasDraft ? "Resume draft" : "Report incident"}
        </Button>
      </DialogTrigger>
      <DialogContent className="paper max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Report incident</DialogTitle>
          <DialogDescription>
            Recorded with your identity and the current time. Numbers are optional
            but must be accurate.
          </DialogDescription>
        </DialogHeader>
        {restoredAt && (
          <p role="status" className="flex flex-wrap items-center gap-x-2 rounded-sm border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            <span>
              Restored your unsaved draft from{" "}
              {new Date(restoredAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}.
            </span>
            <button type="button" className="font-medium text-foreground underline underline-offset-2" onClick={discardDraft}>
              Start over
            </button>
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Site" required id={FIELD_IDS.siteId} error={errors.siteId} className="sm:col-span-2">
            {(a11y) => (
              <select
                {...a11y}
                className={`w-full rounded-sm border border-input bg-card px-3 py-2 text-sm ${invalidControlClass}`}
                value={form.siteId}
                onChange={(e) => change({ siteId: e.target.value })}
              >
                <option value="">Select site...</option>
                {(sites ?? []).map((s) => (
                  <option key={s._id} value={s._id}>{s.code} — {s.name}</option>
                ))}
              </select>
            )}
          </FormField>
          <div className="space-y-1.5">
            <Label htmlFor="incident-type">Type</Label>
            <select
              id="incident-type"
              className="w-full rounded-sm border border-input bg-card px-3 py-2 text-sm"
              value={form.type}
              onChange={(e) => change({ type: e.target.value })}
            >
              {TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="incident-severity">Severity</Label>
            <select
              id="incident-severity"
              className="w-full rounded-sm border border-input bg-card px-3 py-2 text-sm"
              value={form.severity}
              onChange={(e) => change({ severity: e.target.value })}
            >
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <FormField label="What happened?" required id={FIELD_IDS.description} error={errors.description} className="sm:col-span-2">
            {(a11y) => (
              <Textarea
                {...a11y}
                rows={4}
                value={form.description}
                onChange={(e) => change({ description: e.target.value })}
                placeholder="Factual account of the event..."
              />
            )}
          </FormField>
          <FormField label="Date occurred" required id={FIELD_IDS.occurredAt} error={errors.occurredAt}>
            {(a11y) => (
              <Input
                {...a11y}
                type="date"
                max={localDateString()}
                value={form.occurredAt}
                onChange={(e) => change({ occurredAt: e.target.value })}
              />
            )}
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Fatalities" id={FIELD_IDS.fatalities} error={errors.fatalities}>
              {(a11y) => (
                <Input
                  {...a11y}
                  type="number"
                  min={0}
                  value={form.fatalities}
                  onChange={(e) => change({ fatalities: e.target.value })}
                />
              )}
            </FormField>
            <FormField label="Injured" id={FIELD_IDS.injured} error={errors.injured}>
              {(a11y) => (
                <Input
                  {...a11y}
                  type="number"
                  min={0}
                  value={form.injured}
                  onChange={(e) => change({ injured: e.target.value })}
                />
              )}
            </FormField>
          </div>
        </div>
        {attempted && failing > 0 && (
          <p role="alert" className="text-sm text-destructive">
            {failing === 1 ? "One field needs attention" : `${failing} fields need attention`} — marked above.
          </p>
        )}
        {saveFailed && (
          <p role="status" className="text-xs text-muted-foreground">
            This device couldn't keep a draft of this form (its storage may be full or blocked). Finish and submit
            it now so nothing is lost.
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={submit} disabled={saving}>
            {navigator.onLine === false ? (
              <>
                <CloudOff className="size-4" /> Queue for sync
              </>
            ) : saving ? (
              "Recording..."
            ) : (
              "Record incident"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
