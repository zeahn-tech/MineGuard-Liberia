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
import type { Incident } from "@/lib/types";
import { Loader2, Paperclip, Send, X } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

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

function OperatorIncidentForm({ onDone }: { onDone: () => void }) {
  const sitesQ = useQuery(api.sites.list);
  const report = useMutation(api.records.reportIncident);
  const upload = useMutation(api.evidence.upload);

  const [siteId, setSiteId] = useState<string>("");
  const [type, setType] = useState<Incident["type"]>("near_miss");
  const [severity, setSeverity] = useState<Incident["severity"]>("low");
  const [description, setDescription] = useState("");
  const [occurredAt, setOccurredAt] = useState<string>(
    new Date(Date.now() - DAY).toISOString().slice(0, 10),
  );
  const [fatalities, setFatalities] = useState("");
  const [injured, setInjured] = useState("");
  const [docs, setDocs] = useState<PendingDoc[]>([]);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const sites = sitesQ ?? [];
  const selectedSite = sites.find((s) => s._id === siteId);

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files)) {
      if (f.size > 25 * 1024 * 1024) {
        toast.error(`${f.name} is over the 25MB limit.`);
        continue;
      }
      if (!siteId) {
        toast.error("Choose the site before attaching documents.");
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
        toast.error(`Document ${d.file.name} failed to upload — attach it from the incident page later.`);
      }
    }
    return ok;
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!siteId || !description.trim()) {
      toast.error("Site and description are required.");
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
      toast.success("Incident reported.");
      onDone();
    } catch (err) {
      // OFFLINE PATH: persist to the device queue — nothing silently dropped.
      // The queued item syncs automatically on reconnect with the SAME
      // clientRef, so the server creates exactly one record.
      const msg = err instanceof Error ? err.message : String(err);
      if (!navigator.onLine || msg.includes("Failed to fetch")) {
        enqueueIncidentReport({
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
        toast.info(
          "You appear to be offline — the report is saved on this device and will sync automatically.",
        );
        onDone();
        return;
      }
      console.error("Incident report failed:", err);
      toast.error(
        msg.includes("NOT_FOUND")
          ? "That site is not visible to your account."
          : msg.includes("FORBIDDEN")
            ? "You can only report incidents on your own company's sites."
            : "Could not submit the report.",
      );
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
        <form onSubmit={submit} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="op-site">Site</Label>
              <Select value={siteId} onValueChange={setSiteId} disabled={busy}>
                <SelectTrigger id="op-site">
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
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="op-date">Occurred on</Label>
              <Input
                id="op-date"
                type="date"
                value={occurredAt}
                onChange={(e) => setOccurredAt(e.target.value)}
                disabled={busy}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="op-type">Type</Label>
              <Select value={type} onValueChange={(v) => setType(v as Incident["type"])} disabled={busy}>
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
              <Select value={severity} onValueChange={(v) => setSeverity(v as Incident["severity"])} disabled={busy}>
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
            <div className="space-y-1.5">
              <Label htmlFor="op-fatal">Fatalities (if any)</Label>
              <Input
                id="op-fatal"
                type="number"
                min={0}
                value={fatalities}
                onChange={(e) => setFatalities(e.target.value)}
                placeholder="0"
                disabled={busy}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="op-inj">Injured (if any)</Label>
              <Input
                id="op-inj"
                type="number"
                min={0}
                value={injured}
                onChange={(e) => setInjured(e.target.value)}
                placeholder="0"
                disabled={busy}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="op-desc">What happened</Label>
            <Textarea
              id="op-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              placeholder="Describe the incident factually…"
              disabled={busy}
              required
            />
          </div>

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

          <Button type="submit" className="w-full" disabled={busy || !siteId || !description.trim()}>
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
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </p>
      )}
      {incidentsQ !== undefined && incidents.length === 0 && (
        <p className="text-sm text-muted-foreground">No incidents reported.</p>
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
