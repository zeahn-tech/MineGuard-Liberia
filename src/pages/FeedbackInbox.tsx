import { useState } from "react";
import { useMutation, useQuery } from "@/lib/backend-react";
import { api } from "@/lib/backend";
import { useAuth } from "@/hooks/use-auth";
import { StaffOnly } from "@/components/StaffOnly";
import { PageLoading } from "@/components/PageLoading";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Inbox, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { toastError } from "@/lib/feedback";

const STATUS_LABEL: Record<string, string> = {
  new: "New",
  in_review: "In review",
  answered: "Answered",
  closed: "Closed",
};

const fmt = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Ministry reviewers answer public feedback and questions here. The database enforces who may
 *  read or answer (administrators and supervisors); this screen only mirrors that. */
export default function FeedbackInbox() {
  return (
    <StaffOnly>
      <Inner />
    </StaffOnly>
  );
}

function Inner() {
  const { user } = useAuth();
  const isReviewer = user?.role === "admin" || user?.role === "supervisor";
  const items = useQuery(api.records.feedbackQueue, isReviewer ? undefined : "skip");
  const respond = useMutation(api.records.respondFeedback);
  const [drafts, setDrafts] = useState<Record<string, { response: string; note: string }>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  if (!isReviewer) {
    return (
      <div className="p-6">
        <EmptyState
          icon={ShieldAlert}
          title="Reviewer role required"
          why="Public feedback is answered by Ministry administrators and supervisors."
        />
      </div>
    );
  }

  const act = async (id: string, status: "in_review" | "answered" | "closed") => {
    const d = drafts[id] ?? { response: "", note: "" };
    setBusyId(id);
    try {
      await respond({
        id,
        status,
        response: d.response.trim() || undefined,
        internalNote: d.note.trim() || undefined,
      });
      setDrafts((x) => ({ ...x, [id]: { response: "", note: "" } }));
      toast.success(status === "answered" ? "Answer sent." : "Updated.");
    } catch (err) {
      toastError(err, { action: "update this message" });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6 p-4 md:p-8">
      <header>
        <p className="kicker">Public channel</p>
        <h1 className="display text-3xl">Feedback and questions</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          From verified public accounts. The answer you write is shown to the sender; the internal
          note is never shown to them.
        </p>
      </header>

      {items === undefined ? (
        <PageLoading label="feedback" />
      ) : items.length === 0 ? (
        <EmptyState icon={Inbox} title="Nothing here yet" why="Messages from the public appear when someone sends one." />
      ) : (
        <div className="space-y-4">
          {items.map((m) => {
            const d = drafts[m.id] ?? { response: "", note: "" };
            const open = m.status === "new" || m.status === "in_review";
            return (
              <article key={m.id} className="paper space-y-3 p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium">{m.subject}</span>
                  <span className="flex items-center gap-2">
                    <Badge variant="outline">{m.kind === "inquiry" ? "Question" : "Feedback"}</Badge>
                    <Badge variant={open ? "default" : "secondary"}>{STATUS_LABEL[m.status] ?? m.status}</Badge>
                  </span>
                </div>
                <p className="whitespace-pre-wrap break-words text-sm">{m.message}</p>
                <p className="text-xs text-muted-foreground">Received {fmt(m.createdAt)}</p>
                {m.response && (
                  <div className="rounded-md bg-muted/40 p-3 text-sm">
                    <p className="kicker">Sent answer{m.respondedAt ? ` · ${fmt(m.respondedAt)}` : ""}</p>
                    <p className="mt-1 whitespace-pre-wrap break-words">{m.response}</p>
                  </div>
                )}
                {m.internalNote && <p className="text-xs text-muted-foreground">Internal note: {m.internalNote}</p>}
                {m.status !== "closed" && (
                  <div className="space-y-2">
                    <Textarea
                      rows={3}
                      placeholder="Answer for the sender (they will read this)"
                      value={d.response}
                      onChange={(e) => setDrafts((x) => ({ ...x, [m.id]: { ...d, response: e.target.value } }))}
                    />
                    <Textarea
                      rows={2}
                      placeholder="Internal note (not shown to the sender)"
                      value={d.note}
                      onChange={(e) => setDrafts((x) => ({ ...x, [m.id]: { ...d, note: e.target.value } }))}
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" disabled={busyId === m.id || d.response.trim().length < 5} onClick={() => act(m.id, "answered")}>
                        Send answer
                      </Button>
                      <Button size="sm" variant="outline" disabled={busyId === m.id || m.status === "in_review"} onClick={() => act(m.id, "in_review")}>
                        Mark in review
                      </Button>
                      <Button size="sm" variant="outline" disabled={busyId === m.id} onClick={() => act(m.id, "closed")}>
                        Close
                      </Button>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
