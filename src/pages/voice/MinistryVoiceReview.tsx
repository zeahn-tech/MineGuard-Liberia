// ---------------------------------------------------------------------------
// WORKER VOICE → MINISTRY — review queue (staff portal). Reports that workers chose to send to the
// Ministry about a company's labour practices, unsafe work practices and work habits. Only people the
// DATABASE lets through ever receive a row: Ministry administrators and national-scope supervisors.
// Company accounts are never reviewers here. Confidential identities are never in the list; opening
// one is a separate, recorded action that only a Ministry administrator may take.
// ---------------------------------------------------------------------------
import { useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/EmptyState";
import { PageLoading } from "@/components/PageLoading";
import { PushSetupCard } from "@/components/emergency/PushSetupCard";
import { CodesPanel, RequestsPanel, TrendsPanel } from "@/components/voice/MinistryExtras";
import { HoldControl, Photos, RetentionPanel, Thread } from "@/components/voice/VoiceBits";
import { listMinistryMessages, ministryDispose, ministryPhotoCounts, ministryPhotos, ministrySetHold, retentionPolicy, setRetention, type MinistryMessage } from "@/lib/ministry-voice-review";
import { StaffOnly } from "@/components/StaffOnly";
import { useAuth } from "@/hooks/use-auth";
import { MINISTRY_CATEGORIES, MINISTRY_GROUP_LABEL } from "@/lib/voice";
import {
  explainMinistryError, listMinistryReports, ministryOpenIdentity, ministryPostUpdate, ministryReviewers, ministrySetStatus,
  ministrySummary, ministryTriage, type MinistryReportRow, type MinistryStatus, type MinistrySummary,
} from "@/lib/ministry-voice-review";

const STATUS_LABEL: Record<MinistryStatus, string> = {
  received: "Received", triage: "In triage", investigating: "Under review", action_taken: "Action taken", closed: "Closed",
};
const NEXT: MinistryStatus[] = ["investigating", "action_taken", "closed"];
const MODE_LABEL = { named: "Named", confidential: "Confidential", anonymous: "Anonymous" } as const;
const categoryLabel = (v: string) => MINISTRY_CATEGORIES.find((c) => c.value === v)?.label ?? v;

function Summary({ s }: { s: MinistrySummary }) {
  return (
    <section className="space-y-3 border border-border p-3" aria-label="Worker reports summary">
      <h2 className="text-sm font-medium">Overview</h2>
      <dl className="grid grid-cols-3 gap-2 text-sm">
        <div><dt className="text-xs text-muted-foreground">All reports</dt><dd className="text-lg font-semibold">{s.total}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Open</dt><dd className="text-lg font-semibold">{s.open}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Open, high or critical</dt><dd className="text-lg font-semibold">{s.critical_open}</dd></div>
      </dl>
      <div className="flex flex-wrap gap-2 text-xs">
        {Object.entries(s.by_group).map(([g, n]) => <span key={g} className="rounded border border-border px-2 py-0.5">{MINISTRY_GROUP_LABEL[g] ?? g}: {n}</span>)}
      </div>
      {s.by_company.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">By company</p>
          <ul className="space-y-1 text-sm">
            {s.by_company.map((c) => <li key={c.organization_id} className="flex justify-between gap-2"><span>{c.name}</span><span className="text-muted-foreground">{c.total} total · {c.open} open · {c.serious_open} serious</span></li>)}
          </ul>
          <p className="text-xs text-muted-foreground">Counts of what workers reported. They are allegations until reviewed, and are not findings against a company.</p>
        </div>
      )}
    </section>
  );
}

function ReportCard({ r, canOpenIdentity, photoN, onChanged }: { r: MinistryReportRow; canOpenIdentity: boolean; photoN: number; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sev, setSev] = useState(r.triage_severity ?? r.urgency);
  const [assignee, setAssignee] = useState("");
  const [people, setPeople] = useState<{ user_id: string; name: string | null }[]>([]);
  const [note, setNote] = useState("");
  const [update, setUpdate] = useState("");
  const [purpose, setPurpose] = useState("");
  const [identity, setIdentity] = useState<string | null>(null);
  const closed = r.status === "closed";
  const [thread, setThread] = useState<MinistryMessage[]>([]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void listMinistryMessages(r.id).then((t) => { if (live) setThread(t); }, () => undefined);
    return () => { live = false; };
  }, [open, r.id, r.reporter_update]);

  useEffect(() => {
    if (!open || closed) return;
    let live = true;
    void ministryReviewers().then((p) => { if (live) setPeople(p); }, () => undefined);
    return () => { live = false; };
  }, [open, closed]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg(ok); onChanged(); } catch (e) { setMsg(explainMinistryError(e)); } finally { setBusy(false); }
  };
  const showIdentity = () => act(async () => {
    const res = await ministryOpenIdentity(r.id, purpose || undefined);
    setIdentity(res.available ? `${res.name ?? "Name not recorded"}${res.jobTitle ? ` — ${res.jobTitle}` : ""}` : "No identity is held for this report.");
  }, "Identity opened. This was recorded.");

  return (
    <li className="space-y-2 border border-border p-3">
      <button type="button" className="w-full text-left" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded border border-border px-2 py-0.5 font-medium uppercase tracking-wide">{MODE_LABEL[r.mode]}</span>
          <span className="rounded border border-border px-2 py-0.5 uppercase tracking-wide">{r.urgency}</span>
          <span className="rounded border border-border px-2 py-0.5 uppercase tracking-wide">{STATUS_LABEL[r.status]}</span>
          {r.duplicate_of && <span className="rounded border border-amber-500/60 px-2 py-0.5 text-amber-700 dark:text-amber-400">Similar report received earlier</span>}
          {r.small_site && <span className="rounded border border-amber-500/60 px-2 py-0.5 text-amber-700 dark:text-amber-400">Small site</span>}
          {r.legal_hold && <span className="rounded border border-primary/50 px-2 py-0.5 text-primary">Legal hold</span>}
          {photoN > 0 && <span className="rounded border border-border px-2 py-0.5">{photoN} photo{photoN === 1 ? "" : "s"}</span>}
        </span>
        <span className="mt-1 block text-sm font-medium">{categoryLabel(r.category)}</span>
        <span className="block text-sm">{r.organization_name} · {r.site_name}</span>
        <span className="block text-xs text-muted-foreground">Received {new Date(r.created_at).toLocaleString()}{r.mode !== "named" ? (r.small_site ? " (shown as a day: small site)" : " (time shown to the hour)") : ""}{r.assigned_name ? ` · Assigned to ${r.assigned_name}` : ""}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-border pt-3 text-sm">
          <p className="whitespace-pre-wrap">{r.description}</p>
          {r.small_site && r.mode !== "named" && <p className="text-xs text-muted-foreground">Few people work at this site, so details in this report could point to the sender. Keep the content within the review and do not try to work out who wrote it.</p>}
          {photoN > 0 && <Photos load={() => ministryPhotos(r.id)} />}
          <Thread messages={thread.map((m) => ({ seq: m.seq, from_reporter: m.from_reporter, body: m.body, at: m.at }))} />
          <p className="text-xs text-muted-foreground">Reported before: {r.previously_reported}. {r.occurred_at ? `Approximately ${new Date(r.occurred_at).toLocaleString()}.` : ""}</p>

          {!closed && (
            <>
              <div className="grid gap-2 sm:grid-cols-3">
                <select aria-label="Severity" className="h-9 border border-input bg-background px-2 text-sm" value={sev} onChange={(e) => setSev(e.target.value)}>
                  {["low", "medium", "high", "critical"].map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
                <select aria-label="Assign to" className="h-9 border border-input bg-background px-2 text-sm" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                  <option value="">Keep current assignee</option>
                  {people.map((p) => <option key={p.user_id} value={p.user_id}>{p.name ?? "Unnamed"}</option>)}
                </select>
                <Button size="sm" disabled={busy} onClick={() => act(() => ministryTriage(r.id, sev, assignee || undefined), "Triage saved.")}>Save triage</Button>
              </div>

              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Move forward</p>
                <Textarea aria-label="Reason or note" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} placeholder="Reason (required to close)" />
                <div className="flex flex-wrap gap-2">
                  {NEXT.map((x) => <Button key={x} size="sm" variant={x === "closed" ? "outline" : "secondary"} disabled={busy} onClick={() => act(() => ministrySetStatus(r.id, x, note), `Now: ${STATUS_LABEL[x]}.`)}>{STATUS_LABEL[x]}</Button>)}
                </div>
              </div>

              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Update for the reporter</p>
                <Textarea aria-label="Update for the reporter" value={update} maxLength={500} onChange={(e) => setUpdate(e.target.value)} placeholder="Write only what the reporter may read. Do not include names, notes or details of the investigation." />
                <Button size="sm" variant="outline" disabled={busy || !update.trim()} onClick={() => act(() => ministryPostUpdate(r.id, update), "Update posted. The reporter sees it with their follow-up code.")}>Post update</Button>
                {r.reporter_update && <p className="text-xs text-muted-foreground">Current update: {r.reporter_update}</p>}
              </div>
            </>
          )}
          {closed && <p className="text-xs text-muted-foreground">Closed: {r.closure_reason}</p>}

          {r.mode !== "anonymous" && (
            <div className="space-y-1 border-t border-border pt-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Reporter identity</p>
              {r.mode === "confidential" && !canOpenIdentity && <p className="text-xs text-muted-foreground">Only a Ministry administrator can open a confidential identity.</p>}
              {(r.mode === "named" || canOpenIdentity) && (
                <>
                  {r.mode === "confidential" && <Input aria-label="Purpose for opening the identity" value={purpose} maxLength={300} onChange={(e) => setPurpose(e.target.value)} placeholder="Why do you need the identity? (recorded and shown to the reporter as a count)" />}
                  {identity ? <p className="text-sm font-medium">{identity}</p> : <Button size="sm" variant="outline" disabled={busy || (r.mode === "confidential" && purpose.trim().length < 10)} onClick={showIdentity}>{r.mode === "confidential" ? "Open confidential identity" : "Show reporter"}</Button>}
                </>
              )}
            </div>
          )}
          {r.mode === "anonymous" && <p className="text-xs text-muted-foreground">Anonymous: no identity is held for this report.</p>}
          <HoldControl held={r.legal_hold} closed={closed} canSet={canOpenIdentity} onSet={async (hold, reason) => { await ministrySetHold(r.id, hold, reason); onChanged(); }} />
          {msg && <p role="status" className="text-sm">{msg}</p>}
        </div>
      )}
    </li>
  );
}

function Inner() {
  const { user } = useAuth();
  const isReviewer = user?.role === "admin" || user?.role === "supervisor";
  const [rows, setRows] = useState<MinistryReportRow[] | null>(null);
  const [summary, setSummary] = useState<MinistrySummary | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);
  const [filter, setFilter] = useState<"open" | "all">("open");

  useEffect(() => {
    if (!isReviewer) return;
    let live = true;
    void Promise.all([listMinistryReports(), ministrySummary(), ministryPhotoCounts().catch(() => [])]).then(
      ([r, s, c]) => { if (live) { setRows(r); setSummary(s); setCounts(Object.fromEntries(c.map((x) => [x.report_id, x.n]))); } },
      () => { if (live) setFailed(true); },
    );
    return () => { live = false; };
  }, [tick, isReviewer]);

  if (!isReviewer) {
    return <div className="p-6"><EmptyState icon={ShieldAlert} title="Reviewer role required" why="Worker reports to the Ministry are reviewed by Ministry administrators and national supervisors." /></div>;
  }
  if (failed) return <p role="alert" className="p-4 text-sm">Reports could not be loaded. Your account may not be allowed to review them. Nothing has been changed.</p>;
  if (!rows || !summary) return <PageLoading shape="list" label="worker reports to the Ministry" />;
  const shown = rows.filter((r) => filter === "all" || r.status !== "closed");

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Worker reports to the Ministry</h1>
        <p className="text-sm text-muted-foreground">Confidential reports from workers about a company&apos;s labour practices, unsafe work practices and work habits. Companies cannot see these reports. Treat every report as credible until it is assessed, whether it is named, confidential or anonymous. Do not try to work out who sent an anonymous report, and do not share a report&apos;s content with the company in a way that could identify the reporter.</p>
      </header>
      <PushSetupCard />
      <Summary s={summary} />
      <TrendsPanel />
      {user?.role === "admin" && <CodesPanel />}
      {user?.role === "admin" && <RequestsPanel companies={[...new Map(rows.map((r) => [r.organization_id, { id: r.organization_id, name: r.organization_name }])).values()]} />}
      <RetentionPanel channel="ministry" canSetPolicy={user?.role === "admin"} load={retentionPolicy} setPolicy={setRetention} dispose={ministryDispose} />
      <div className="flex gap-2">
        <Button size="sm" variant={filter === "open" ? "default" : "outline"} onClick={() => setFilter("open")}>Open</Button>
        <Button size="sm" variant={filter === "all" ? "default" : "outline"} onClick={() => setFilter("all")}>All</Button>
      </div>
      {shown.length === 0 ? (
        <EmptyState title="No reports to review" why="Reports workers send to the Ministry will appear here. You will get a notification when one arrives." />
      ) : (
        <ul className="space-y-3">{shown.map((r) => <ReportCard key={r.id} r={r} photoN={counts[r.id] ?? 0} canOpenIdentity={user?.role === "admin"} onChanged={() => setTick((t) => t + 1)} />)}</ul>
      )}
    </div>
  );
}

export default function MinistryVoiceReview() {
  return <StaffOnly><Inner /></StaffOnly>;
}
