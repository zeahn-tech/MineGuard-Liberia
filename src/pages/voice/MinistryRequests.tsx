// Requests the Ministry has sent to this company, and the company's answers. Company administrators only
// (the database enforces it). A request names a topic; it is never tied to any report, and the company is
// not told whether reports exist.
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/EmptyState";
import { PageLoading } from "@/components/PageLoading";
import { explainRequestError, listRequests, REQUEST_TOPICS, respondToRequest, type CompanyRequest } from "@/lib/ministry-voice-review";

export default function MinistryRequests() {
  const [rows, setRows] = useState<CompanyRequest[] | null>(null);
  const [denied, setDenied] = useState(false);
  const [text, setText] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    void listRequests().then((r) => { if (live) setRows(r); }, () => { if (live) setDenied(true); });
    return () => { live = false; };
  }, [tick]);

  if (denied) return <div className="p-4"><EmptyState title="Company administrators only" why="Requests from the Ministry are seen and answered by your company's administrators." /></div>;
  if (!rows) return <PageLoading shape="list" label="Ministry requests" />;
  const send = async (id: string) => {
    setMsg(null);
    try { await respondToRequest(id, text[id]); setText({ ...text, [id]: "" }); setTick((t) => t + 1); setMsg("Your answer was sent to the Ministry."); }
    catch (e) { setMsg(explainRequestError(e)); }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Requests from the Ministry</h1>
        <p className="text-sm text-muted-foreground">The Ministry may ask your company to respond on a topic. A request does not tell you whether anyone has reported anything, and you should not try to work out who might have. Answer about your company&apos;s practice and records.</p>
      </header>
      {msg && <p role="status" className="text-sm">{msg}</p>}
      {rows.length === 0 ? <EmptyState title="No requests from the Ministry" why="If the Ministry sends your company a request, you will get a notification and it will be listed here." /> : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r.id} className="space-y-2 border border-border p-3 text-sm">
              <p className="font-medium">{REQUEST_TOPICS.find((t) => t.value === r.topic)?.label ?? r.topic} <span className="text-xs uppercase text-muted-foreground">· {r.status} · sent {r.created_on}</span></p>
              {r.note && <p className="text-muted-foreground">{r.note}</p>}
              {r.responses.map((x, i) => <p key={i}><span className="text-xs text-muted-foreground">{x.from} · {x.on}: </span>{x.text}</p>)}
              {r.status !== "closed" ? (
                <div className="space-y-1">
                  <Textarea aria-label="Your answer to the Ministry" value={text[r.id] ?? ""} maxLength={1500} onChange={(e) => setText({ ...text, [r.id]: e.target.value })} placeholder="Your company's answer" />
                  <Button size="sm" disabled={!(text[r.id] ?? "").trim()} onClick={() => { void send(r.id); }}>Send answer</Button>
                </div>
              ) : <p className="text-xs text-muted-foreground">This request is closed.</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
