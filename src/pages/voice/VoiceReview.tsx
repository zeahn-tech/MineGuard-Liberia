// ---------------------------------------------------------------------------
// WORKER VOICE — review queue. Only people the DATABASE lets through ever receive a row: company
// administrators, and the site manager / safety officers assigned to the site (never for a report
// routed to administrators only). This page also hides what it cannot show, but that is a courtesy.
// Confidential identities are never in the list; opening one is a separate, recorded action.
// ---------------------------------------------------------------------------
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/EmptyState";
import { PageLoading } from "@/components/PageLoading";
import { PushSetupCard } from "@/components/emergency/PushSetupCard";
import { HoldControl, Photos, RetentionPanel, Thread } from "@/components/voice/VoiceBits";
import { VOICE_CATEGORIES, formatSiteCode } from "@/lib/voice";
import {
  codeInfo, createIncident, disposeCompany, eligibleReviewers, escalate, explainReviewError, listMessages, listPhotos, listVoiceReports, openIdentity, photoCounts, postUpdate, retentionPolicy, reviewerSites, setAnonymousEnabled, setHold,
  type CodeInfo, type VoiceMessage,
  rotateSiteCode, setStatus, triage, type ReportStatus, type VoiceReportRow,
} from "@/lib/voice-review";

const STATUS_LABEL: Record<ReportStatus, string> = {
  received: "Received", triage: "In triage", investigating: "Investigating", action_assigned: "Action assigned", follow_up: "Follow-up", closed: "Closed",
};
const NEXT: ReportStatus[] = ["investigating", "action_assigned", "follow_up", "closed"];
const MODE_LABEL = { named: "Named", confidential: "Confidential", anonymous: "Anonymous" } as const;
const INCIDENT_TYPES = ["near_miss", "injury", "equipment_accident", "vehicle_accident", "fire", "structural_failure", "chemical_exposure", "environmental", "other"];

function ReportCard({ r, siteName, photoN, onChanged }: { r: VoiceReportRow; siteName: string; photoN: number; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sev, setSev] = useState(r.triage_severity ?? r.urgency);
  const [assignee, setAssignee] = useState("");
  const [people, setPeople] = useState<{ user_id: string; name: string | null }[]>([]);
  const [note, setNote] = useState("");
  const [update, setUpdate] = useState("");
  const [reason, setReason] = useState("");
  const [purpose, setPurpose] = useState("");
  const [identity, setIdentity] = useState<string | null>(null);
  const [incType, setIncType] = useState("near_miss");
  const [incText, setIncText] = useState("");
  const closed = r.status === "closed";
  const [thread, setThread] = useState<VoiceMessage[]>([]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void listMessages(r.id).then((t) => { if (live) setThread(t); }, () => undefined);
    return () => { live = false; };
  }, [open, r.id, r.reporter_update]);
  const category = VOICE_CATEGORIES.find((c) => c.value === r.category)?.label ?? r.category;

  useEffect(() => {
    if (!open || closed) return;
    let live = true;
    void eligibleReviewers(r.id).then((p) => { if (live) setPeople(p); }, () => undefined);
    return () => { live = false; };
  }, [open, closed, r.id]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg(ok); onChanged(); } catch (e) { setMsg(explainReviewError(e)); } finally { setBusy(false); }
  };
  const showIdentity = () => act(async () => {
    const res = await openIdentity(r.id, purpose || undefined);
    setIdentity(res.available ? `${res.name ?? "Name not recorded"}${res.jobTitle ? ` — ${res.jobTitle}` : ""}` : "No identity is held for this report.");
  }, "Identity opened. This was recorded.");

  return (
    <li className="space-y-2 border border-border p-3">
      <button type="button" className="w-full text-left" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded border border-border px-2 py-0.5 font-medium uppercase tracking-wide">{MODE_LABEL[r.mode]}</span>
          <span className="rounded border border-border px-2 py-0.5 uppercase tracking-wide">{r.urgency}</span>
          <span className="rounded border border-border px-2 py-0.5 uppercase tracking-wide">{STATUS_LABEL[r.status]}</span>
          {r.route === "company_admin" && <span className="rounded border border-primary/50 px-2 py-0.5 text-primary">Administrators only</span>}
          {r.duplicate_of && <span className="rounded border border-amber-500/60 px-2 py-0.5 text-amber-700 dark:text-amber-400">Similar report received earlier</span>}
          {r.small_site && <span className="rounded border border-amber-500/60 px-2 py-0.5 text-amber-700 dark:text-amber-400">Small site</span>}
          {r.legal_hold && <span className="rounded border border-primary/50 px-2 py-0.5 text-primary">Legal hold</span>}
          {photoN > 0 && <span className="rounded border border-border px-2 py-0.5">{photoN} photo{photoN === 1 ? "" : "s"}</span>}
        </span>
        <span className="mt-1 block text-sm font-medium">{category} · {siteName}</span>
        <span className="block text-xs text-muted-foreground">Received {new Date(r.created_at).toLocaleString()}{r.mode !== "named" ? (r.small_site ? " (shown as a day: small site)" : " (time shown to the hour)") : ""}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-border pt-3 text-sm">
          <p className="whitespace-pre-wrap">{r.description}</p>
          {r.small_site && r.mode !== "named" && <p className="text-xs text-muted-foreground">Few people work at this site, so details in this report could point to the sender. Keep the content within the review and do not try to work out who wrote it.</p>}
          {photoN > 0 && <Photos load={() => listPhotos(r.id)} />}
          <Thread messages={thread} />
          <p className="text-xs text-muted-foreground">Reported before: {r.previously_reported}. {r.occurred_at ? `Approximately ${new Date(r.occurred_at).toLocaleString()}.` : ""}</p>

          {!closed && (
            <>
              <div className="grid gap-2 sm:grid-cols-3">
                <select aria-label="Severity" className="h-9 border border-input bg-background px-2 text-sm" value={sev} onChange={(e) => setSev(e.target.value)}>
                  {["low", "medium", "high", "critical"].map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <select aria-label="Assign to" className="h-9 border border-input bg-background px-2 text-sm" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                  <option value="">Keep current assignee</option>
                  {people.map((p) => <option key={p.user_id} value={p.user_id}>{p.name ?? "Unnamed"}</option>)}
                </select>
                <Button size="sm" disabled={busy} onClick={() => act(() => triage(r.id, sev, assignee || undefined), "Triage saved.")}>Save triage</Button>
              </div>

              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Move forward</p>
                <Textarea aria-label="Reason or note" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} placeholder="Reason (required to close)" />
                <div className="flex flex-wrap gap-2">
                  {NEXT.map((s) => <Button key={s} size="sm" variant={s === "closed" ? "outline" : "secondary"} disabled={busy} onClick={() => act(() => setStatus(r.id, s, note), `Now: ${STATUS_LABEL[s]}.`)}>{STATUS_LABEL[s]}</Button>)}
                </div>
              </div>

              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Message to the reporter</p>
                <Textarea aria-label="Message to the reporter" value={update} maxLength={500} onChange={(e) => setUpdate(e.target.value)} placeholder="Write only what the reporter may read. Do not include names, notes or details of the investigation." />
                <Button size="sm" variant="outline" disabled={busy || !update.trim()} onClick={() => act(() => postUpdate(r.id, update), "Update posted. The reporter sees it with their follow-up code.")}>Send message</Button>
                {r.reporter_update && <p className="text-xs text-muted-foreground">Current update: {r.reporter_update}</p>}
              </div>

              {r.route === "site" && (
                <div className="space-y-1">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Escalate to company administrators</p>
                  <Input aria-label="Reason for escalating" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Why (recorded; not shown to the reporter)" />
                  <Button size="sm" variant="outline" disabled={busy || reason.trim().length < 10} onClick={() => act(() => escalate(r.id, reason), "Escalated. Site-level reviewers no longer see this report.")}>Escalate</Button>
                </div>
              )}

              {!r.linked_incident_id && (
                <div className="space-y-1">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Record as an incident</p>
                  <p className="text-xs text-muted-foreground">Incident records are visible to everyone who can see the site and to the Ministry. Write the description yourself: the report text is not copied and the reporter is not linked.</p>
                  <select aria-label="Incident type" className="h-9 w-full border border-input bg-background px-2 text-sm" value={incType} onChange={(e) => setIncType(e.target.value)}>
                    {INCIDENT_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
                  </select>
                  <Textarea aria-label="Incident description" value={incText} maxLength={1500} onChange={(e) => setIncText(e.target.value)} />
                  <Button size="sm" variant="outline" disabled={busy || incText.trim().length < 20} onClick={() => act(() => createIncident(r.id, incType, incText), "Incident recorded. Continue in Incidents.")}>Create incident</Button>
                </div>
              )}
              {r.linked_incident_id && <p className="text-xs text-muted-foreground">An incident record exists for this report.</p>}
            </>
          )}
          {closed && <p className="text-xs text-muted-foreground">Closed: {r.closure_reason}</p>}

          {r.mode !== "anonymous" && (
            <div className="space-y-1 border-t border-border pt-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Reporter identity</p>
              {r.mode === "confidential" && <Input aria-label="Purpose for opening the identity" value={purpose} maxLength={300} onChange={(e) => setPurpose(e.target.value)} placeholder="Why do you need the identity? (company administrators only; recorded and shown to the reporter as a count)" />}
              {identity ? <p className="text-sm font-medium">{identity}</p> : <Button size="sm" variant="outline" disabled={busy || (r.mode === "confidential" && purpose.trim().length < 10)} onClick={showIdentity}>{r.mode === "confidential" ? "Open confidential identity" : "Show reporter"}</Button>}
            </div>
          )}
          {r.mode === "anonymous" && <p className="text-xs text-muted-foreground">Anonymous: no identity is held for this report.</p>}
          <HoldControl held={r.legal_hold} closed={closed} canSet onSet={async (hold, reason) => { try { await setHold(r.id, hold, reason); onChanged(); } catch (e) { setMsg(explainReviewError(e)); throw e; } }} />
          {msg && <p role="status" className="text-sm">{msg}</p>}
        </div>
      )}
    </li>
  );
}

function SiteCodes({ sites }: { sites: { id: string; name: string }[] }) {
  const [info, setInfo] = useState<Record<string, CodeInfo>>({});
  const [msg, setMsg] = useState<string | null>(null);
  if (sites.length === 0) return null;
  const load = async (id: string) => { try { setInfo((m) => ({ ...m, [id]: undefined as unknown as CodeInfo })); const i = await codeInfo(id); setInfo((m) => ({ ...m, [id]: i })); } catch (e) { setMsg(explainReviewError(e)); } };
  const rotate = async (id: string) => { try { await rotateSiteCode(id); setMsg("New code issued for 90 days. The old one no longer works. Update the poster."); await load(id); } catch (e) { setMsg(explainReviewError(e)); } };
  const toggle = async (id: string, enabled: boolean) => { try { await setAnonymousEnabled(id, enabled); setMsg(enabled ? "Anonymous reporting resumed." : "Anonymous reporting paused. People are told so when they try."); await load(id); } catch (e) { setMsg(explainReviewError(e)); } };
  return (
    <section className="space-y-2 border border-border p-3" aria-label="Anonymous reporting site codes">
      <h2 className="text-sm font-medium">Anonymous reporting to your company: site codes</h2>
      <p className="text-xs text-muted-foreground">This code is for reports to YOUR COMPANY only. Post it at the site. Anyone with it can send an anonymous report to your company without an account. A code lasts 90 days. Change it, or pause anonymous reporting, if it is misused. Reports to the Ministry use a separate code that only the Ministry controls.</p>
      <ul className="space-y-3">
        {sites.map((s) => {
          const i = info[s.id];
          return (
            <li key={s.id} className="space-y-1 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{s.name}</span>
                <span className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => { void load(s.id); }}>{i ? "Refresh" : "Show code"}</Button>
                  {i && <Button size="sm" variant="ghost" onClick={() => { void rotate(s.id); }}>Change code</Button>}
                  {i && <Button size="sm" variant="ghost" onClick={() => { void toggle(s.id, !i.enabled); }}>{i.enabled ? "Pause anonymous" : "Resume anonymous"}</Button>}
                </span>
              </div>
              {i && <p className="text-xs text-muted-foreground"><span className="font-mono text-sm font-semibold text-foreground">{formatSiteCode(i.code)}</span> · expires {i.expiresOn} · {i.enabled ? "accepting anonymous reports" : "PAUSED"} · anonymous reports today {i.today}, last 7 days {i.week}{i.unusual && <span className="block font-medium text-destructive">Unusually many reports today. If this is not expected, change the code or pause anonymous reporting.</span>}</p>}
            </li>
          );
        })}
      </ul>
      {msg && <p role="status" className="text-xs">{msg}</p>}
    </section>
  );
}

export default function VoiceReview() {
  const [rows, setRows] = useState<VoiceReportRow[] | null>(null);
  const [sites, setSites] = useState<{ id: string; name: string }[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);
  const [filter, setFilter] = useState<"open" | "all">("open");

  useEffect(() => {
    let live = true;
    void Promise.all([listVoiceReports(), reviewerSites().catch(() => []), photoCounts().catch(() => [])]).then(
      ([r, s, c]) => { if (live) { setRows(r); setSites(s); setCounts(Object.fromEntries(c.map((x) => [x.report_id, x.n]))); } },
      () => { if (live) setFailed(true); },
    );
    return () => { live = false; };
  }, [tick]);

  if (failed) return <p role="alert" className="p-4 text-sm">Reports could not be loaded. Nothing has been changed.</p>;
  if (!rows) return <PageLoading shape="list" label="worker voice reports" />;
  // The database returns no sites to someone who is not a reviewer. Say so plainly instead of showing an empty queue.
  if (sites.length === 0 && rows.length === 0) {
    return <div className="p-4"><EmptyState title="Reviewer access required" why="Worker Voice reports are reviewed by your company administrators, and by the site manager and safety officers assigned to the site. To raise a concern yourself, use Worker Voice." /></div>;
  }
  const shown = rows.filter((r) => filter === "all" || r.status !== "closed");
  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? "Your site";

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Worker Voice review</h1>
        <p className="text-sm text-muted-foreground">Safety reports sent to your company. Treat every report as credible until it is assessed, whether it is named, confidential or anonymous. Do not try to work out who sent an anonymous report. Reports that workers choose to send to the Ministry are a separate channel and are not shown here.</p>
      </header>
      <PushSetupCard />
      <SiteCodes sites={sites} />
      {rows[0] && <RetentionPanel channel="company" canSetPolicy={false} load={retentionPolicy} dispose={(dry, confirm) => disposeCompany(rows[0].organization_id, dry, confirm)} />}
      <div className="flex gap-2">
        <Button size="sm" variant={filter === "open" ? "default" : "outline"} onClick={() => setFilter("open")}>Open</Button>
        <Button size="sm" variant={filter === "all" ? "default" : "outline"} onClick={() => setFilter("all")}>All</Button>
      </div>
      {shown.length === 0 ? (
        <EmptyState title="No reports to review" why="Reports you are authorized to review will appear here. You will get a notification when one arrives." />
      ) : (
        <ul className="space-y-3">{shown.map((r) => <ReportCard key={r.id} r={r} photoN={counts[r.id] ?? 0} siteName={siteName(r.site_id)} onChanged={() => setTick((t) => t + 1)} />)}</ul>
      )}
    </div>
  );
}
