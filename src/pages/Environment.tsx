import { useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery } from "@/lib/backend-react";
import { api } from "@/lib/backend";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { CloudOff, Leaf, Plus } from "lucide-react";
import { enqueueObservationReport, newClientRef, syncQueue } from "@/lib/offline-queue";
import { PageLoading } from "@/components/PageLoading";
import { EmptyState } from "@/components/EmptyState";
import { FormField, invalidControlClass } from "@/components/FormField";
import { useFormDraft } from "@/hooks/use-form-draft";
import { toastError, toastSuccess } from "@/lib/feedback";
import { OBSERVATION_FIELD_ORDER, localDateString, validateObservation, type ObservationField } from "@/lib/form-rules";
import { firstInvalid, focusField, hasErrors, type FieldErrors } from "@/lib/validation";

const CATEGORIES = [
  { value: "water_pollution", label: "Water pollution" },
  { value: "river_disturbance", label: "River disturbance" },
  { value: "river_diversion", label: "River diversion" },
  { value: "deforestation", label: "Deforestation" },
  { value: "soil_degradation", label: "Soil degradation" },
  { value: "waste", label: "Waste" },
  { value: "tailings", label: "Tailings" },
  { value: "chemical_handling", label: "Chemical handling" },
  { value: "rehabilitation", label: "Rehabilitation" },
  { value: "land_impact", label: "Land impact" },
] as const;

const VERIFICATION = [
  { value: "observed", label: "Observed (seen directly)" },
  { value: "measured", label: "Measured (instrument reading)" },
  { value: "verified", label: "Verified (confirmed by analyst)" },
  { value: "unverified", label: "Unverified (not yet confirmed)" },
  { value: "alleged", label: "Alleged (reported by others)" },
] as const;

const VERIF_STYLE: Record<string, string> = {
  verified: "text-foreground",
  measured: "text-foreground",
  observed: "text-muted-foreground",
  unverified: "text-muted-foreground",
  alleged: "text-destructive",
};

export default function Environment() {
  const observations = useQuery(api.records.listObservations);
  const sites = useQuery(api.sites.list);
  const setStatus = useMutation(api.records.setObservationStatus);
  const [recordOpen, setRecordOpen] = useState(false);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toastSuccess({ title: ok });
    } catch (e) {
      toastError(e, { action: "update the observation" });
    }
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="kicker">Environmental monitoring</p>
          <h1 className="display text-3xl">Observations</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every observation carries an explicit verification state — a core data
            integrity rule of this platform.
          </p>
        </div>
        {sites && sites.length > 0 && <ObservationDialog open={recordOpen} onOpenChange={setRecordOpen} />}
      </header>

      {!observations ? (
        <PageLoading shape="list" label="observations" />
      ) : observations.length === 0 ? (
        <EmptyState
          icon={Leaf}
          title="No observations recorded yet"
          why={
            sites && sites.length === 0
              ? "Observations are recorded against a registered site, and none are registered in your area yet. An administrator registers sites."
              : "Nothing has been recorded for the sites in your area. Record what you see, and how sure you are of it, as soon as you observe it."
          }
          action={
            sites && sites.length === 0
              ? { label: "Go to Sites", to: "/portal/sites" }
              : sites
                ? { label: "Record an observation", onClick: () => setRecordOpen(true) }
                : undefined
          }
        />
      ) : (
        <ul className="divide-y divide-border rounded-sm border border-border">
          {observations.map((o) => (
            <li key={o._id} className="p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <Link
                  to={`/portal/environment/${o._id}`}
                  className="text-sm font-medium hover:underline"
                >
                  {o.category.replace(/_/g, " ")}
                </Link>
                <div className="flex items-center gap-2">
                  <span className={`stamp ${VERIF_STYLE[o.verification]}`}>{o.verification}</span>
                  <span className="stamp">{o.status}</span>
                </div>
              </div>
              <p className="mt-1.5 text-sm text-muted-foreground">{o.description}</p>
              <p className="mt-1.5 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                <span className="font-mono">{o.siteCode}</span>
                <span>{new Date(o.observedAt).toLocaleDateString()}</span>
                {o.latitude != null && (
                  <span>
                    {o.latitude.toFixed(4)}, {o.longitude?.toFixed(4)}
                  </span>
                )}
              </p>
              {o.status !== "resolved" && (
                <div className="mt-2 flex gap-2">
                  {o.status === "open" && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => act(() => setStatus({ observationId: o._id, status: "monitoring" }), "Moved to monitoring")}
                    >
                      Monitor
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => act(() => setStatus({ observationId: o._id, status: "resolved" }), "Marked resolved")}
                  >
                    Resolve
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function blankObservation() {
  return {
    siteId: "",
    category: "water_pollution",
    verification: "observed",
    description: "",
    observedAt: localDateString(),
    latitude: "",
    longitude: "",
  };
}

const OBS_FIELD_IDS: Record<ObservationField, string> = {
  siteId: "obs-site",
  description: "obs-description",
  observedAt: "obs-date",
  latitude: "obs-lat",
  longitude: "obs-lng",
};

function ObservationDialog({
  open: openProp,
  onOpenChange,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const sites = useQuery(api.sites.list);
  const report = useMutation(api.records.reportObservation);
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = onOpenChange ?? setOpenState;
  const [saving, setSaving] = useState(false);
  const { form, setForm, restoredAt, hasDraft, saveFailed, clearDraft, discardDraft } = useFormDraft(
    "observation-report",
    blankObservation(),
  );
  const [errors, setErrors] = useState<FieldErrors<ObservationField>>({});
  const [attempted, setAttempted] = useState(false);

  const change = (patch: Partial<typeof form>) => {
    const next = { ...form, ...patch };
    setForm(next);
    if (attempted) setErrors(validateObservation(next));
  };

  const submit = async () => {
    if (saving) return;
    const found = validateObservation(form);
    setErrors(found);
    setAttempted(true);
    if (hasErrors(found)) {
      const first = firstInvalid(found, OBSERVATION_FIELD_ORDER);
      if (first) focusField(OBS_FIELD_IDS[first]);
      return;
    }
    setSaving(true);
    let queued = false;
    try {
      // Offline-first: enqueue BEFORE any network attempt; syncs immediately
      // when online, or on reconnect with server-side clientRef dedupe.
      const clientRef = newClientRef();
      // Awaited: a failed on-device write rejects here, so the catch below
      // surfaces "not saved" instead of claiming a queued submission.
      await enqueueObservationReport({
        clientRef,
        siteId: form.siteId,
        siteCode: sites?.find((s) => s._id === form.siteId)?.code ?? "site",
        category: form.category,
        verification: form.verification,
        description: form.description.trim(),
        observedAt: new Date(form.observedAt).getTime(),
        latitude: form.latitude ? Number(form.latitude) : undefined,
        longitude: form.longitude ? Number(form.longitude) : undefined,
      });
      queued = true;
      const siteId = form.siteId;
      const result = await syncQueue({ reportObservation: report });
      if (result.synced > 0) {
        toastSuccess({
          title: "Observation recorded.",
          reassure: "It's saved with the verification state you chose, and is now part of this site's record.",
          next: { label: "View site", to: `/portal/sites/${siteId}` },
        });
      } else {
        toastSuccess({
          title: "Saved on this device.",
          reassure: "It will be sent automatically as soon as you're back online — nothing is lost, and you can keep working.",
        });
      }
      setOpen(false);
      setForm(blankObservation());
      clearDraft();
      setErrors({});
      setAttempted(false);
    } catch (e) {
      if (queued) {
        toastSuccess({
          title: "Saved on this device.",
          reassure: "We couldn't send it just now, so it will be retried automatically. Nothing is lost.",
        });
        setOpen(false);
        setForm(blankObservation());
        clearDraft();
      } else {
        toastError(e, { action: "save the observation" });
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
          <Plus className="size-4" /> {hasDraft ? "Resume draft" : "Record observation"}
        </Button>
      </DialogTrigger>
      <DialogContent className="paper max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Record environmental observation</DialogTitle>
          <DialogDescription>
            Choose the verification state honestly — it changes how the record may be
            used in analysis and reporting.
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
          <FormField label="Site" required id={OBS_FIELD_IDS.siteId} error={errors.siteId} className="sm:col-span-2">
            {(a11y) => (
              <select
                {...a11y}
                className={`w-full rounded-sm border border-input bg-card px-3 py-2 text-sm ${invalidControlClass}`}
                value={form.siteId}
                onChange={(e) => change({ siteId: e.target.value })}
              >
                <option value="">Select site…</option>
                {(sites ?? []).map((s) => (
                  <option key={s._id} value={s._id}>{s.code} — {s.name}</option>
                ))}
              </select>
            )}
          </FormField>
          <div className="space-y-1.5">
            <Label htmlFor="obs-category">Category</Label>
            <select
              id="obs-category"
              className="w-full rounded-sm border border-input bg-card px-3 py-2 text-sm"
              value={form.category}
              onChange={(e) => change({ category: e.target.value })}
            >
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="obs-verification">Verification state</Label>
            <select
              id="obs-verification"
              className="w-full rounded-sm border border-input bg-card px-3 py-2 text-sm"
              value={form.verification}
              onChange={(e) => change({ verification: e.target.value })}
            >
              {VERIFICATION.map((v) => (
                <option key={v.value} value={v.value}>{v.label}</option>
              ))}
            </select>
          </div>
          <FormField label="What was observed?" required id={OBS_FIELD_IDS.description} error={errors.description} className="sm:col-span-2">
            {(a11y) => (
              <Textarea
                {...a11y}
                rows={4}
                value={form.description}
                onChange={(e) => change({ description: e.target.value })}
                placeholder="Factual description; note measurement method if applicable…"
              />
            )}
          </FormField>
          <FormField label="Date observed" required id={OBS_FIELD_IDS.observedAt} error={errors.observedAt}>
            {(a11y) => (
              <Input
                {...a11y}
                type="date"
                max={localDateString()}
                value={form.observedAt}
                onChange={(e) => change({ observedAt: e.target.value })}
              />
            )}
          </FormField>
          <div className="grid grid-cols-2 gap-2">
            <FormField label="Latitude" id={OBS_FIELD_IDS.latitude} error={errors.latitude} hint="Optional">
              {(a11y) => (
                <Input
                  {...a11y}
                  inputMode="decimal"
                  value={form.latitude}
                  onChange={(e) => change({ latitude: e.target.value })}
                  placeholder="6.43"
                />
              )}
            </FormField>
            <FormField label="Longitude" id={OBS_FIELD_IDS.longitude} error={errors.longitude} hint="Optional">
              {(a11y) => (
                <Input
                  {...a11y}
                  inputMode="decimal"
                  value={form.longitude}
                  onChange={(e) => change({ longitude: e.target.value })}
                  placeholder="-9.43"
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
              "Record observation"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
