import { useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery } from "@/lib/backend-react";
import { api } from "@/lib/backend";
import { PublicHeader } from "@/components/PublicHeader";
import { PageLoading } from "@/components/PageLoading";
import { EmptyState } from "@/components/EmptyState";
import { FormField } from "@/components/FormField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { MessageSquare } from "lucide-react";
import { toast } from "sonner";
import { toastError, toastProblem } from "@/lib/feedback";

const STATUS_LABEL: Record<string, string> = {
  new: "Received",
  in_review: "Being looked at",
  answered: "Answered",
  closed: "Closed",
};

const fmt = (ms: number) => new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

export default function MyFeedback() {
  const items = useQuery(api.account.myFeedback);
  const send = useMutation(api.account.sendFeedback);
  const [kind, setKind] = useState<"feedback" | "inquiry">("feedback");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const subjectProblem = subject.trim().length > 0 && subject.trim().length < 3 ? "Use at least 3 characters." : undefined;
  const messageProblem = message.trim().length > 0 && message.trim().length < 10 ? "Use at least 10 characters." : undefined;
  const ready = subject.trim().length >= 3 && message.trim().length >= 10 && !busy;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    try {
      await send({ kind, subject: subject.trim(), message: message.trim() });
      setSubject("");
      setMessage("");
      toast.success("Sent. The Ministry's answer will appear below.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("DUPLICATE") || msg.includes("RATE_LIMITED") || msg.includes("LIMIT")) {
        toastProblem({
          what: "Your message was not sent.",
          whose: msg.replace(/^[A-Z_]+:\s*/, ""),
          fix: "What you typed is still here; send it again later or edit it.",
        });
      } else {
        toastError(err, { action: "send your message" });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-background paper-grain">
      <PublicHeader width="3xl">
        <Link to="/account/reports" className="inline-flex min-h-9 shrink-0 items-center text-sm text-muted-foreground hover:text-foreground">
          My reports
        </Link>
      </PublicHeader>
      <main className="mx-auto max-w-3xl px-4 py-10 md:px-8">
        <p className="kicker">My account</p>
        <h1 className="display mt-2 text-3xl md:text-4xl">Feedback and questions</h1>
        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
          Tell the Ministry what works and what does not, or ask a question about mining safety
          information. This is not for reporting a concern — use the report form for that. Answers
          appear on this page.
        </p>

        <form onSubmit={submit} className="paper mt-8 space-y-4 p-5">
          <div className="flex gap-2" role="radiogroup" aria-label="Kind of message">
            {(["feedback", "inquiry"] as const).map((k) => (
              <Button
                key={k}
                type="button"
                size="sm"
                role="radio"
                aria-checked={kind === k}
                variant={kind === k ? "default" : "outline"}
                onClick={() => setKind(k)}
              >
                {k === "feedback" ? "Feedback" : "Question"}
              </Button>
            ))}
          </div>
          <FormField label="Subject" id="fb-subject" error={subjectProblem}>
            {(a11y) => <Input {...a11y} value={subject} maxLength={120} onChange={(e) => setSubject(e.target.value)} />}
          </FormField>
          <FormField label="Message" id="fb-message" error={messageProblem}>
            {(a11y) => <Textarea {...a11y} rows={5} value={message} maxLength={2000} onChange={(e) => setMessage(e.target.value)} />}
          </FormField>
          <p className="text-xs text-muted-foreground">
            Plain text only, up to 2,000 characters, at most two web links. Do not include passwords or
            bank details.
          </p>
          <Button type="submit" disabled={!ready}>
            {busy ? "Sending…" : "Send"}
          </Button>
        </form>

        <div className="mt-8 space-y-4">
          {items === undefined ? (
            <PageLoading label="your messages" />
          ) : items.length === 0 ? (
            <EmptyState
              icon={MessageSquare}
              title="Nothing sent yet"
              why="Messages you send appear here with their status and the Ministry's answer."
            />
          ) : (
            items.map((m) => (
              <article key={m.id} className="paper space-y-2 p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium">{m.subject}</span>
                  <Badge variant="outline">{STATUS_LABEL[m.status] ?? m.status}</Badge>
                </div>
                <p className="whitespace-pre-wrap break-words text-sm">{m.message}</p>
                <p className="text-xs text-muted-foreground">
                  {m.kind === "inquiry" ? "Question" : "Feedback"} · sent {fmt(m.createdAt)}
                </p>
                {m.response && (
                  <div className="rounded-md border-l-2 border-foreground/40 bg-muted/40 p-3">
                    <p className="kicker">Answer{m.respondedAt ? ` · ${fmt(m.respondedAt)}` : ""}</p>
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm">{m.response}</p>
                  </div>
                )}
              </article>
            ))
          )}
        </div>
      </main>
    </div>
  );
}
