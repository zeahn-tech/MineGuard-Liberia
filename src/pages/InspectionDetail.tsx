import { useParams, Link } from "react-router";
import { useQuery, useMutation } from "@/lib/backend-react";
import { api } from "@/lib/backend";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useState } from "react";
import { toast } from "sonner";
import { ArrowLeft, MapPin } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Doc, Id } from "@/lib/compat-types";
import { isStaffRole } from "@/lib/types";

const SEV_STYLES: Record<string, string> = {
  low: "text-muted-foreground",
  medium: "text-foreground",
  high: "text-destructive",
  critical: "text-destructive",
};

export default function InspectionDetail() {
  const { inspectionId } = useParams<{ inspectionId: string }>();
  const inspection = useQuery(
    api.inspections.get,
    inspectionId ? { inspectionId: inspectionId as Id<"inspections"> } : "skip",
  );
  const templates = useQuery(api.inspections.listTemplates);
  const findings = useQuery(
    api.inspections.listFindingsForInspection,
    inspectionId ? { inspectionId: inspectionId as Id<"inspections"> } : "skip",
  );
  const review = useMutation(api.inspections.review);
  const addFinding = useMutation(api.inspections.addFinding);
  const updateFindingStatus = useMutation(api.inspections.updateFindingStatus);
  const openCa = useMutation(api.inspections.openCorrectiveAction);
  const decideCa = useMutation(api.inspections.decideCorrectiveAction);
  const { user } = useAuth();

  const isReviewer = user?.role === "admin" || user?.role === "supervisor";
  // Finding creation and corrective-action opening are staff-only (rules);
  // operators acknowledge findings and view the compliance chain.
  const isStaff = isStaffRole(user?.role);
  const [reviewNote, setReviewNote] = useState("");
  const [findingForm, setFindingForm] = useState({ title: "", description: "", severity: "medium" });
  const [caForm, setCaForm] = useState<{ findingId: string; description: string; dueAt: string } | null>(null);

  if (!inspectionId) return <p className="text-sm text-muted-foreground">No inspection selected.</p>;
  if (inspection === undefined)
    return <p className="py-16 text-center text-sm text-muted-foreground">Loading…</p>;
  if (inspection === null)
    return <p className="py-16 text-center text-sm text-muted-foreground">Not found or access denied.</p>;

  const template = templates?.find((t) => t._id === inspection.templateId);
  const answers = (inspection.answers ?? {}) as Record<string, unknown>;

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast.success(ok);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed");
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2 text-muted-foreground">
          <Link to="/portal/inspections">
            <ArrowLeft className="size-4" /> Inspections
          </Link>
        </Button>
      </div>

      <header className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="kicker">Inspection record</p>
          <h1 className="display mt-1 text-2xl">
            {new Date(inspection.createdAt).toLocaleDateString()} ·{" "}
            {template?.name ?? "Inspection"}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="font-mono text-[10px]">
              {inspection.status.replace(/_/g, " ")}
            </Badge>
            {inspection.submittedAt && (
              <span className="text-xs text-muted-foreground">
                Submitted {new Date(inspection.submittedAt).toLocaleString()}
              </span>
            )}
            {inspection.reviewedAt && (
              <span className="text-xs text-muted-foreground">
                Reviewed {new Date(inspection.reviewedAt).toLocaleString()}
              </span>
            )}
          </div>
        </div>
        {isReviewer && inspection.status === "under_review" && (
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              onClick={() =>
                act(
                  () => review({ inspectionId: inspectionId as Id<"inspections">, decision: "approved", note: reviewNote || undefined }),
                  "Inspection approved",
                )
              }
            >
              Approve
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                act(
                  () => review({ inspectionId: inspectionId as Id<"inspections">, decision: "rejected", note: reviewNote || undefined }),
                  "Inspection rejected — back to inspector",
                )
              }
            >
              Reject
            </Button>
          </div>
        )}
      </header>

      {isReviewer && inspection.status === "under_review" && (
        <div className="paper p-4">
          <Label>Review note (recorded with decision)</Label>
          <Textarea
            className="mt-2"
            rows={2}
            value={reviewNote}
            onChange={(e) => setReviewNote(e.target.value)}
            placeholder="Optional context for the decision…"
          />
        </div>
      )}

      {/* Provenance */}
      <section className="grid gap-3 text-xs text-muted-foreground sm:grid-cols-3">
        <div className="border border-border p-3">
          <p className="kicker mb-1">Location provenance</p>
          {inspection.latitude != null ? (
            <p className="flex items-center gap-1">
              <MapPin className="size-3.5" />
              {inspection.latitude.toFixed(5)}, {inspection.longitude?.toFixed(5)}
              {inspection.gpsAccuracyM != null && ` (±${Math.round(inspection.gpsAccuracyM)}m)`}
            </p>
          ) : (
            "No GPS captured"
          )}
        </div>
        <div className="border border-border p-3">
          <p className="kicker mb-1">Template</p>
          <p>{template?.name ?? "—"}</p>
        </div>
        <div className="border border-border p-3">
          <p className="kicker mb-1">Client reference</p>
          <p className="font-mono">{inspection.clientRef ?? "direct entry"}</p>
        </div>
      </section>

      {/* Answers */}
      <section>
        <h2 className="display border-b border-border pb-2 text-lg">Recorded answers</h2>
        <div className="mt-4 space-y-6">
          {(template?.sections ?? []).map((sec, si) => (
            <div key={si}>
              <h3 className="text-sm font-semibold">{sec.title}</h3>
              <dl className="mt-2 divide-y divide-border">
                {sec.questions.map((q, qi) => {
                  const key = `${si}:${qi}`;
                  const v = answers[key];
                  return (
                    <div key={key} className="grid grid-cols-2 gap-4 py-2 text-sm">
                      <dt className="text-muted-foreground">{q.label}</dt>
                      <dd>
                        {v === undefined || v === "" ? (
                          <span className="text-muted-foreground">—</span>
                        ) : typeof v === "boolean" ? (
                          v ? "Yes" : "No"
                        ) : (
                          String(v)
                        )}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </div>
          ))}
        </div>
        {inspection.notes && (
          <div className="mt-6 border-l-2 border-border pl-4">
            <p className="kicker">Inspector notes</p>
            <p className="mt-1 text-sm leading-relaxed">{inspection.notes}</p>
          </div>
        )}
        {inspection.reviewNote && (
          <div className="mt-4 border-l-2 border-destructive/40 pl-4">
            <p className="kicker">Review note</p>
            <p className="mt-1 text-sm leading-relaxed">{inspection.reviewNote}</p>
          </div>
        )}
      </section>

      {/* Findings */}
      <section>
        <div className="flex items-baseline justify-between border-b border-border pb-2">
          <h2 className="display text-lg">Findings</h2>
          <span className="text-xs text-muted-foreground">
            Inspection → finding → corrective action → verification
          </span>
        </div>

        {findings === undefined ? (
          <p className="py-4 text-sm text-muted-foreground">Loading…</p>
        ) : findings.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">No findings recorded.</p>
        ) : (
          <ul className="divide-y divide-border">
            {findings.map((f: Doc<"findings">) => (
              <li key={f._id} className="py-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-medium">{f.title}</p>
                  <div className="flex items-center gap-2">
                    <span className={`stamp ${SEV_STYLES[f.severity]}`}>{f.severity}</span>
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {f.status}
                    </Badge>
                  </div>
                </div>
                {f.description && (
                  <p className="mt-1 text-sm text-muted-foreground">{f.description}</p>
                )}

                {/* Finding status transitions */}
                <div className="mt-2 flex flex-wrap gap-2">
                  {f.status === "open" && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => act(() => updateFindingStatus({ findingId: f._id, status: "acknowledged" }), "Acknowledged")}
                    >
                      Acknowledge
                    </Button>
                  )}
                  {isStaff && (f.status === "acknowledged" || f.status === "open") && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => act(() => updateFindingStatus({ findingId: f._id, status: "resolved" }), "Marked resolved")}
                      >
                        Mark resolved
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setCaForm({ findingId: f._id, description: "", dueAt: "" })}
                      >
                        Open corrective action…
                      </Button>
                    </>
                  )}
                  {f.status === "resolved" && isReviewer && (
                    <Button
                      size="sm"
                      onClick={() => act(() => updateFindingStatus({ findingId: f._id, status: "verified" }), "Verified")}
                    >
                      Verify
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {/* Add finding — staff-only (rules gate finding creation) */}
        {isStaff && (
        <div className="paper mt-6 p-4">
          <p className="kicker">Record a finding</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Title</Label>
              <Input
                value={findingForm.title}
                onChange={(e) => setFindingForm({ ...findingForm, title: e.target.value })}
                placeholder="Short factual description"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Severity</Label>
              <select
                className="w-full rounded-sm border border-input bg-card px-3 py-2 text-sm"
                value={findingForm.severity}
                onChange={(e) => setFindingForm({ ...findingForm, severity: e.target.value })}
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </div>
            <div className="space-y-1.5 sm:col-span-3">
              <Label>Description</Label>
              <Input
                value={findingForm.description}
                onChange={(e) => setFindingForm({ ...findingForm, description: e.target.value })}
              />
            </div>
          </div>
          <Button
            className="mt-3"
            size="sm"
            disabled={!findingForm.title}
            onClick={() =>
              act(async () => {
                await addFinding({
                  inspectionId: inspectionId as Id<"inspections">,
                  title: findingForm.title,
                  description: findingForm.description || undefined,
                  severity: findingForm.severity as "low" | "medium" | "high" | "critical",
                });
                setFindingForm({ title: "", description: "", severity: "medium" });
              }, "Finding recorded")
            }
          >
            Record finding
          </Button>
        </div>
        )}
      </section>

      {/* Corrective action dialog */}
      {caForm && (
        <Dialog open onOpenChange={() => setCaForm(null)}>
          <DialogContent className="paper">
            <DialogHeader>
              <DialogTitle>Open corrective action</DialogTitle>
              <DialogFooter>
                <Button variant="outline" onClick={() => setCaForm(null)}>Cancel</Button>
                <Button
                  disabled={!caForm.description || !caForm.dueAt}
                  onClick={() =>
                    act(async () => {
                      await openCa({
                        findingId: caForm.findingId as never,
                        description: caForm.description,
                        dueAt: new Date(caForm.dueAt).getTime(),
                      });
                      setCaForm(null);
                    }, "Corrective action opened")
                  }
                >
                  Open action
                </Button>
              </DialogFooter>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Action required</Label>
                <Textarea
                  rows={3}
                  value={caForm.description}
                  onChange={(e) => setCaForm({ ...caForm, description: e.target.value })}
                  placeholder="What must the operator do, concretely?"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Deadline</Label>
                <Input
                  type="date"
                  value={caForm.dueAt}
                  onChange={(e) => setCaForm({ ...caForm, dueAt: e.target.value })}
                />
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
