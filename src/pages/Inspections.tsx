import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
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
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  CloudUpload,
  FilePlus2,
  MapPin,
  Plus,
  Save,
  Signal,
  WifiOff,
} from "lucide-react";
import {
  deleteDraft,
  enqueueInspectionSubmission,
  newClientRef,
  readDraft,
  readDrafts,
  readQueue,
  upsertDraft,
  type LocalDraft,
} from "@/lib/offline-queue";
import type { Doc, Id } from "@/convex/_generated/dataModel";

type TemplateDoc = Doc<"inspectionTemplates">;
type SiteDoc = Doc<"sites">;

// ---------------------------------------------------------------------------
// LIST + NEW INSPECTION
// ---------------------------------------------------------------------------
export default function Inspections() {
  const inspections = useQuery(api.inspections.list);
  const sites = useQuery(api.sites.list);
  const templates = useQuery(api.inspections.listTemplates);
  const navigate = useNavigate();
  const [localDrafts, setLocalDrafts] = useState<LocalDraft[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const refresh = () => setLocalDrafts(readDrafts());
    refresh();
    const i = setInterval(refresh, 1500);
    return () => clearInterval(i);
  }, []);

  const siteById = useMemo(
    () => new Map((sites ?? []).map((s) => [s._id, s])),
    [sites],
  );

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="kicker">Field operations</p>
          <h1 className="display text-3xl">Inspections</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Offline-capable. Drafts persist on this device; submissions queue and sync
            automatically with server-side dedupe.
          </p>
        </div>
        <Button onClick={() => setOpen(true)} disabled={!templates?.length}>
          <FilePlus2 className="size-4" /> New inspection
        </Button>
      </header>

      {localDrafts.length > 0 && (
        <section>
          <h2 className="display flex items-center gap-2 border-b border-border pb-2 text-lg">
            <WifiOff className="size-4" /> On this device ({localDrafts.length})
          </h2>
          <ul className="divide-y divide-border">
            {localDrafts.map((d) => (
              <li key={d.clientRef} className="flex items-center justify-between gap-3 py-3">
                <div>
                  <p className="text-sm font-medium">{d.siteCode}</p>
                  <p className="text-xs text-muted-foreground">
                    Edited {new Date(d.updatedAt).toLocaleString()} · saved locally
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button asChild size="sm" variant="outline">
                    <Link to={`/portal/inspections/local/${d.clientRef}`}>Open</Link>
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      deleteDraft(d.clientRef);
                      setLocalDrafts(readDrafts());
                    }}
                  >
                    Discard
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="display border-b border-border pb-2 text-lg">All inspections</h2>
        {!inspections ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
        ) : inspections.length === 0 ? (
          <p className="py-8 text-sm text-muted-foreground">
            No inspections yet. Start one above.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="mt-1 w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="px-2 py-2.5 font-medium">Site</th>
                  <th className="hidden px-2 py-2.5 font-medium md:table-cell">County</th>
                  <th className="px-2 py-2.5 font-medium">Created</th>
                  <th className="px-2 py-2.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {inspections.map((i) => (
                  <tr
                    key={i._id}
                    className="cursor-pointer hover:bg-accent/50"
                    onClick={() => navigate(`/portal/inspections/${i._id}`)}
                  >
                    <td className="px-2 py-3">
                      <div className="font-mono text-xs">{i.siteCode}</div>
                      <div className="font-medium">{i.siteName}</div>
                    </td>
                    <td className="hidden px-2 py-3 md:table-cell">{i.county}</td>
                    <td className="px-2 py-3">{new Date(i.createdAt).toLocaleDateString()}</td>
                    <td className="px-2 py-3">
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {i.status.replace(/_/g, " ")}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {open && (
        <NewInspectionDialog
          sites={sites ?? []}
          templates={(templates ?? []) as TemplateDoc[]}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function NewInspectionDialog({
  sites,
  templates,
  onClose,
}: {
  sites: (SiteDoc & { openActions?: number })[];
  templates: TemplateDoc[];
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [siteId, setSiteId] = useState("");
  const [templateId, setTemplateId] = useState<string>(templates[0]?._id ?? "");

  const start = () => {
    if (!siteId || !templateId) {
      toast.error("Choose a site and a template.");
      return;
    }
    const site = sites.find((s) => s._id === siteId);
    const clientRef = newClientRef();
    upsertDraft({
      clientRef,
      siteId,
      siteCode: site?.code ?? "site",
      templateId,
      answers: {},
      updatedAt: Date.now(),
    });
    navigate(`/portal/inspections/local/${clientRef}`);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="paper">
        <DialogHeader>
          <DialogTitle>New field inspection</DialogTitle>
          <DialogDescription>
            The draft is saved on this device immediately; it syncs when you submit.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Site</Label>
            <select
              className="w-full rounded-sm border border-input bg-card px-3 py-2 text-sm"
              value={siteId}
              onChange={(e) => setSiteId(e.target.value)}
            >
              <option value="">Select site…</option>
              {sites.map((s) => (
                <option key={s._id} value={s._id}>
                  {s.code} — {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>Template</Label>
            <select
              className="w-full rounded-sm border border-input bg-card px-3 py-2 text-sm"
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
            >
              {templates.map((t) => (
                <option key={t._id} value={t._id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={start}>
            <Plus className="size-4" /> Start draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// FIELD FORM (offline-capable) — routed at /portal/inspections/local/:clientRef
// ---------------------------------------------------------------------------
export function LocalInspectionForm() {
  const { clientRef } = useParams<{ clientRef: string }>();
  const sites = useQuery(api.sites.list);
  const templates = useQuery(api.inspections.listTemplates);
  const navigate = useNavigate();
  const syncCreateDraft = useMutation(api.inspections.createDraft);
  const syncUpdateDraft = useMutation(api.inspections.updateDraft);
  const syncSubmit = useMutation(api.inspections.submit);
  const [draft, setDraft] = useState<LocalDraft | null>(() =>
    clientRef ? readDraft(clientRef) ?? null : null,
  );
  const [gps, setGps] = useState<{ lat: number; lng: number; acc: number } | null>(null);
  const [saving, setSaving] = useState(false);

  const template = templates?.find((t) => t._id === draft?.templateId);
  const site = sites?.find((s) => s._id === draft?.siteId);

  const saveDraft = (patch: Partial<LocalDraft>) => {
    if (!draft || !clientRef) return;
    const next = { ...draft, ...patch, updatedAt: Date.now() };
    setDraft(next);
    upsertDraft(next);
  };

  const captureGps = () => {
    if (!navigator.geolocation) {
      toast.error("Geolocation unavailable on this device.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const g = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          acc: pos.coords.accuracy,
        };
        setGps(g);
        saveDraft({ latitude: g.lat, longitude: g.lng, gpsAccuracyM: g.acc });
        toast.success("GPS captured");
      },
      (err) => toast.error(`GPS error: ${err.message}`),
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };

  const submit = async () => {
    if (!draft || !clientRef) return;
    setSaving(true);
    try {
      // 1. Enqueue FIRST — persisted before any network attempt.
      enqueueInspectionSubmission({
        clientRef,
        siteId: draft.siteId,
        siteCode: draft.siteCode,
        templateId: draft.templateId,
        answers: draft.answers,
        notes: draft.notes,
        latitude: draft.latitude,
        longitude: draft.longitude,
        gpsAccuracyM: draft.gpsAccuracyM,
        capturedAt: Date.now(),
      });
      // 2. Try immediate sync; if offline it stays queued and syncs on reconnect.
      const { syncQueue } = await import("@/lib/offline-queue");
      await syncQueue({
        createDraft: (args) => syncCreateDraft(args as never) as unknown as Promise<string>,
        updateDraft: (args) => syncUpdateDraft(args as never) as unknown as Promise<void>,
        submit: (args) => syncSubmit(args as never) as unknown as Promise<void>,
      });
      toast.success(
        draft.latitude != null ? "Submitted with GPS captured" : "Submitted",
      );
      navigate("/portal/inspections");
    } catch {
      // Submission remains queued locally; nothing is lost.
      toast.info("Saved and queued — will sync when online.");
      navigate("/portal/inspections");
    } finally {
      setSaving(false);
    }
  };

  if (!draft) {
    return (
      <p className="py-16 text-center text-sm text-muted-foreground">
        Draft not found on this device.{" "}
        <Link to="/portal/inspections" className="underline">Back to inspections</Link>
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="kicker">Field inspection · draft on device</p>
          <h1 className="display mt-1 text-2xl">{site ? site.name : draft.siteCode}</h1>
          <p className="text-xs text-muted-foreground">
            {template?.name} · autosaves locally as you type
          </p>
        </div>
        <div className="flex flex-col items-stretch gap-2 sm:items-end">
          <div className="flex gap-2">
            <Button variant="outline" onClick={captureGps}>
              <MapPin className="size-4" /> {gps || draft.latitude != null ? "Re-capture GPS" : "Capture GPS"}
            </Button>
          </div>
          {(gps || draft.latitude != null) && (
            <p className="text-xs text-muted-foreground">
              {gps
                ? `${gps.lat.toFixed(5)}, ${gps.lng.toFixed(5)} (±${Math.round(gps.acc)}m)`
                : `${draft.latitude?.toFixed(5)}, ${draft.longitude?.toFixed(5)}`}
            </p>
          )}
        </div>
      </header>

      {/* Sections */}
      <div className="space-y-8">
        {(template?.sections ?? []).map((sec, si) => (
          <section key={si}>
            <h2 className="display border-b border-border pb-2 text-lg">{sec.title}</h2>
            <div className="mt-4 space-y-5">
              {sec.questions.map((q, qi) => {
                const key = `${si}:${qi}`;
                const val = draft.answers[key];
                return (
                  <div key={key} className="space-y-1.5">
                    <Label>
                      {q.label}
                      {q.required && <span className="text-destructive"> *</span>}
                    </Label>
                    {q.answerType === "boolean" && (
                      <div className="flex gap-2">
                        {[
                          { v: true, l: "Yes" },
                          { v: false, l: "No" },
                        ].map((o) => (
                          <button
                            key={String(o.v)}
                            type="button"
                            onClick={() => saveDraft({ answers: { ...draft.answers, [key]: o.v } })}
                            className={`rounded-sm border px-4 py-1.5 text-sm transition-colors ${
                              val === o.v
                                ? "border-foreground bg-foreground text-background"
                                : "border-border bg-card hover:bg-accent"
                            }`}
                          >
                            {o.l}
                          </button>
                        ))}
                      </div>
                    )}
                    {q.answerType === "select" && (
                      <select
                        className="w-full max-w-sm rounded-sm border border-input bg-card px-3 py-2 text-sm"
                        value={typeof val === "string" ? val : ""}
                        onChange={(e) =>
                          saveDraft({ answers: { ...draft.answers, [key]: e.target.value } })
                        }
                      >
                        <option value="">Select…</option>
                        {(q.options ?? []).map((o) => (
                          <option key={o} value={o}>{o}</option>
                        ))}
                      </select>
                    )}
                    {q.answerType === "number" && (
                      <Input
                        type="number"
                        className="max-w-[180px]"
                        value={typeof val === "number" ? val : ""}
                        onChange={(e) =>
                          saveDraft({
                            answers: { ...draft.answers, [key]: e.target.value === "" ? undefined : Number(e.target.value) },
                          })
                        }
                      />
                    )}
                    {q.answerType === "text" && (
                      <Textarea
                        rows={2}
                        value={typeof val === "string" ? val : ""}
                        onChange={(e) =>
                          saveDraft({ answers: { ...draft.answers, [key]: e.target.value } })
                        }
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ))}

        <section>
          <h2 className="display border-b border-border pb-2 text-lg">Inspector notes</h2>
          <Textarea
            className="mt-4"
            rows={4}
            value={draft.notes ?? ""}
            onChange={(e) => saveDraft({ notes: e.target.value })}
            placeholder="Context, observations, follow-up needed…"
          />
        </section>
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Signal className="size-3.5" />
          Saved locally {new Date(draft.updatedAt).toLocaleTimeString()} · submissions
          queue if offline
        </p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => navigate("/portal/inspections")}>
            <Save className="size-4" /> Keep as draft
          </Button>
          <Button onClick={submit} disabled={saving}>
            <CloudUpload className="size-4" /> {saving ? "Submitting…" : "Submit for review"}
          </Button>
        </div>
      </div>
    </div>
  );
}
