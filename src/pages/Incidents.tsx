import { useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery } from "@/lib/backend-react";
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
import { toast } from "sonner";
import { CloudOff, Plus } from "lucide-react";
import { enqueueIncidentReport, newClientRef, syncQueue } from "@/lib/offline-queue";

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
  const incidents = useQuery(api.records.listIncidents);
  const sites = useQuery(api.sites.list);
  const setStatus = useMutation(api.records.setIncidentStatus);
  const { user } = useAuth();
  const isStaff =
    user?.role === "admin" || user?.role === "supervisor" || user?.role === "inspector";
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
          <p className="kicker">Incident management</p>
          <h1 className="display text-3xl">Incidents</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Operational categories — not legal classifications. Every record is
            attributable and time-stamped.
          </p>
        </div>
        {sites && sites.length > 0 && <ReportDialog />}
      </header>

      {!incidents ? (
        <p className="py-16 text-center text-sm text-muted-foreground">Loading…</p>
      ) : incidents.length === 0 ? (
        <div className="paper p-10 text-center text-sm text-muted-foreground">
          No incidents recorded in your scope.
        </div>
      ) : (
        <div className="overflow-hidden rounded-sm border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left">
                <th className="px-4 py-2.5 font-medium">Occurred</th>
                <th className="px-4 py-2.5 font-medium">Type</th>
                <th className="px-4 py-2.5 font-medium">Description</th>
                <th className="hidden px-4 py-2.5 font-medium md:table-cell">Site</th>
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
                  <td className="hidden px-4 py-3 md:table-cell">
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
    </div>
  );
}

function ReportDialog() {
  const sites = useQuery(api.sites.list);
  const report = useMutation(api.records.reportIncident);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    siteId: "",
    type: "injury",
    severity: "medium",
    description: "",
    occurredAt: new Date().toISOString().slice(0, 10),
    fatalities: "",
    injured: "",
  });

  const submit = async () => {
    if (saving) return;
    if (!form.siteId || !form.description.trim()) {
      toast.error("Site and description are required.");
      return;
    }
    setSaving(true);
    try {
      // Offline-first: enqueue BEFORE any network attempt. If online the item
      // syncs immediately; if offline it stays queued and syncs on reconnect
      // with server-side clientRef dedupe (nothing is lost or duplicated).
      const clientRef = newClientRef();
      enqueueIncidentReport({
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
      const result = await syncQueue({ reportIncident: report });
      if (result.synced > 0) toast.success("Incident recorded");
      else toast.info("Saved and queued — will sync when online.");
      setOpen(false);
      setForm({ ...form, siteId: "", description: "", fatalities: "", injured: "" });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to record incident");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="size-4" /> Report incident
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
            <Label>Type</Label>
            <select
              className="w-full rounded-sm border border-input bg-card px-3 py-2 text-sm"
              value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value })}
            >
              {TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>Severity</Label>
            <select
              className="w-full rounded-sm border border-input bg-card px-3 py-2 text-sm"
              value={form.severity}
              onChange={(e) => setForm({ ...form, severity: e.target.value })}
            >
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>What happened? *</Label>
            <Textarea
              rows={4}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="Factual account of the event…"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Date occurred</Label>
            <Input
              type="date"
              value={form.occurredAt}
              onChange={(e) => setForm({ ...form, occurredAt: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Fatalities</Label>
              <Input
                type="number"
                min={0}
                value={form.fatalities}
                onChange={(e) => setForm({ ...form, fatalities: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Injured</Label>
              <Input
                type="number"
                min={0}
                value={form.injured}
                onChange={(e) => setForm({ ...form, injured: e.target.value })}
              />
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
              "Record incident"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
