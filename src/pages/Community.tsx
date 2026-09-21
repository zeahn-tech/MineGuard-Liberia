import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { ShieldAlert } from "lucide-react";

type Decision = "under_review" | "verified" | "dismissed" | "referred";

export default function Community() {
  const reports = useQuery(api.records.listCommunityReports);
  const triage = useMutation(api.records.triageCommunityReport);
  const { user } = useAuth();
  const isReviewer = user?.role === "admin" || user?.role === "supervisor";
  const [notes, setNotes] = useState<Record<string, string>>({});

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast.success(ok);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed");
    }
  };

  const pending = (reports ?? []).filter(
    (r) => r.status === "submitted" || r.status === "under_review",
  );
  const decided = (reports ?? []).filter(
    (r) => r.status === "verified" || r.status === "dismissed" || r.status === "referred",
  );

  return (
    <div className="space-y-8">
      <header>
        <p className="kicker">Public channel · triage</p>
        <h1 className="display text-3xl">Community reports</h1>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Reports from the public are concerns to be assessed. Verification is a human
          decision made here and recorded in the audit log. A report never becomes an
          accusation of guilt automatically.
        </p>
      </header>

      <section>
        <h2 className="display border-b border-border pb-2 text-lg">
          Awaiting triage ({pending.length})
        </h2>
        {!reports ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
        ) : pending.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">Queue is clear.</p>
        ) : (
          <ul className="divide-y divide-border">
            {pending.map((r) => (
              <li key={r._id} className="py-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-medium">
                    <span className="font-mono text-xs">{r.trackingCode}</span> ·{" "}
                    {r.category.replace(/_/g, " ")}
                  </p>
                  <span className="text-xs text-muted-foreground">
                    {new Date(r.createdAt).toLocaleString()}
                  </span>
                </div>
                <p className="mt-1.5 text-sm leading-relaxed">{r.description}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {r.county}
                  {r.district ? ` · ${r.district}` : ""}
                  {r.community ? ` · ${r.community}` : ""}
                  {r.contactPhone ? ` · contact: ${r.contactPhone}` : " · no contact provided"}
                </p>

                {isReviewer ? (
                  <div className="mt-3 space-y-2">
                    <Textarea
                      rows={2}
                      placeholder="Triage note (recorded with the decision)…"
                      value={notes[r._id] ?? ""}
                      onChange={(e) => setNotes({ ...notes, [r._id]: e.target.value })}
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          act(
                            () => triage({ reportId: r._id, decision: "under_review", note: notes[r._id] || undefined }),
                            "Marked under review",
                          )
                        }
                      >
                        Start review
                      </Button>
                      <Button
                        size="sm"
                        onClick={() =>
                          act(
                            () => triage({ reportId: r._id, decision: "verified", note: notes[r._id] || undefined }),
                            "Report verified",
                          )
                        }
                      >
                        Verify
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          act(
                            () => triage({ reportId: r._id, decision: "referred", note: notes[r._id] || undefined }),
                            "Report referred",
                          )
                        }
                      >
                        Refer
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          act(
                            () => triage({ reportId: r._id, decision: "dismissed", note: notes[r._id] || undefined }),
                            "Report dismissed",
                          )
                        }
                      >
                        Dismiss
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <ShieldAlert className="size-3.5" /> Reviewer role required to triage.
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="display border-b border-border pb-2 text-lg">
          Decided ({decided.length})
        </h2>
        {decided.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">No decided reports yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {decided.map((r) => (
              <li key={r._id} className="py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm">
                    <span className="font-mono text-xs">{r.trackingCode}</span> ·{" "}
                    {r.category.replace(/_/g, " ")} ·{" "}
                    <span className="stamp">{r.status}</span>
                  </p>
                  <span className="text-xs text-muted-foreground">
                    {r.reviewedAt ? new Date(r.reviewedAt).toLocaleDateString() : ""}
                  </span>
                </div>
                {r.triageNote && (
                  <p className="mt-1 text-xs italic text-muted-foreground">“{r.triageNote}”</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
