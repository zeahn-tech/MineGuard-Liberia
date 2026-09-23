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
import { toast } from "sonner";
import { CloudOff, Plus } from "lucide-react";
import { enqueueObservationReport, newClientRef, syncQueue } from "@/lib/offline-queue";

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
  const [open, setOpen] = useState(false);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast.success(ok);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed");
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
        {sites && sites.length > 0 && <ObservationDialog />}
      </header>

      {!observations ? (
        <p className="py-16 text-center text-sm text-muted-foreground">Loading…</p>
      ) : observations.length === 0 ? (
        <div className="paper p-10 text-center text-sm text-muted-foreground">
          No observations recorded in your scope.
        </div>
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

function ObservationDialog() {
  const sites = useQuery(api.sites.list);
  const report = useMutation(api.records.reportObservation);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    siteId: "",
    category: "water_pollution",
    verification: "observed",
    description: "",
    observedAt: new Date().toISOString().slice(0, 10),
    latitude: "",
    longitude: "",
  });

  const submit = async () => {
    if (saving) return;
    if (!form.siteId || !form.description.trim()) {
      toast.error("Site and description are required.");
      return;
    }
    setSaving(true);
    try {
      // Offline-first: enqueue BEFORE any network attempt; syncs immediately
      // when online, or on reconnect with server-side clientRef dedupe.
      const clientRef = newClientRef();
      enqueueObservationReport({
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
      const result = await syncQueue({ reportObservation: report });
      if (result.synced > 0) toast.success("Observation recorded");
      else toast.info("Saved and queued — will sync when online.");
      setOpen(false);
      setForm({ ...form, siteId: "", description: "", latitude: "", longitude: "" });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to record observation");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="size-4" /> Record observation
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
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Site *</Label>
            <select
              className="w-full rounded-sm border border-input bg-card px-3 py-2 text-sm"
              value={form.siteId}
              onChange={(e) => setForm({ ...form, siteId: e.target.value })}
            >
              <option value="">Select site…</option>
              {(sites ?? []).map((s) => (
                <option key={s._id} value={s._id}>{s.code} — {s.name}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>Category</Label>
            <select
              className="w-full rounded-sm border border-input bg-card px-3 py-2 text-sm"
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
            >
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>Verification state</Label>
            <select
              className="w-full rounded-sm border border-input bg-card px-3 py-2 text-sm"
              value={form.verification}
              onChange={(e) => setForm({ ...form, verification: e.target.value })}
            >
              {VERIFICATION.map((v) => (
                <option key={v.value} value={v.value}>{v.label}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>What was observed? *</Label>
            <Textarea
              rows={4}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="Factual description; note measurement method if applicable…"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Date observed</Label>
            <Input
              type="date"
              value={form.observedAt}
              onChange={(e) => setForm({ ...form, observedAt: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Coordinates (optional)</Label>
            <div className="flex gap-2">
              <Input value={form.latitude} onChange={(e) => setForm({ ...form, latitude: e.target.value })} placeholder="Lat" />
              <Input value={form.longitude} onChange={(e) => setForm({ ...form, longitude: e.target.value })} placeholder="Lng" />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={submit} disabled={saving}>
            {navigator.onLine === false ? (
              <>
                <CloudOff className="size-4" /> Queue for sync
            </>
            ) : saving ? (
              "Recording…"
            ) : (
              "Record observation"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
