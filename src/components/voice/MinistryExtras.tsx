// Ministry-only panels: the Ministry's OWN intake codes, trends and companies for attention, and requests to a company.
// Each calls an RPC that checks the caller; hiding a panel is a courtesy.
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatSiteCode } from "@/lib/voice";
import {
  createRequest, explainRequestError, followUpRequest, listRequests, ministryCodeInfo, ministryCodeSites, ministryRotateCode, ministrySetAnonymous,
  ministryTrends, REQUEST_TOPICS, type CompanyRequest, type MinistryCodeInfo, type MinistryCodeSite, type MinistryTrends,
} from "@/lib/ministry-voice-review";

export function TrendsPanel() {
  const [t, setT] = useState<MinistryTrends | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { let live = true; void ministryTrends(6).then((x) => { if (live) setT(x); }, () => { if (live) setFailed(true); }); return () => { live = false; }; }, []);
  if (failed) return <p role="alert" className="text-xs">Trends could not be loaded.</p>;
  if (!t) return null;
  const max = Math.max(1, ...t.months.map((m) => m.total));
  return (
    <section className="space-y-3 border border-border p-3" aria-label="Trends and companies for attention">
      <h2 className="text-sm font-medium">Trends and companies for attention</h2>
      <p className="text-xs text-muted-foreground">{t.notice}</p>
      <ul className="space-y-1" aria-label="Reports per month">
        {t.months.map((m) => (
          <li key={m.month} className="flex items-center gap-2 text-xs">
            <span className="w-16 text-muted-foreground">{m.month}</span>
            <span className="h-3 bg-primary/70" style={{ width: `${Math.max(2, (m.total / max) * 100)}%` }} role="img" aria-label={`${m.total} reports`} />
            <span>{m.total} <span className="text-muted-foreground">(safety {m.safety}, labour {m.labour}, conduct {m.conduct}, other {m.other})</span></span>
          </li>
        ))}
      </ul>
      <p className="text-xs">Waiting too long: {t.ageing.unacknowledged3d} unacknowledged for over 3 days · {t.ageing.open14d} open over 14 days · {t.ageing.open30d} open over 30 days.</p>
      {t.attention.length === 0 ? <p className="text-xs text-muted-foreground">No company has three or more reports, or two serious ones, in the last 90 days.</p> : (
        <ul className="space-y-1">
          {t.attention.map((a) => (
            <li key={a.organization_id} className="border border-border p-2 text-sm"><span className="font-medium">{a.name}</span><span className="block text-xs text-muted-foreground">{a.why}{a.topCategory ? ` Most common: ${a.topCategory.replace(/_/g, " ")}.` : ""}</span></li>
          ))}
        </ul>
      )}
      <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">{t.limits.map((l) => <li key={l}>{l}</li>)}</ul>
    </section>
  );
}

export function CodesPanel() {
  const [q, setQ] = useState("");
  const [sites, setSites] = useState<MinistryCodeSite[]>([]);
  const [info, setInfo] = useState<Record<string, MinistryCodeInfo>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const search = async () => { setMsg(null); try { setSites(await ministryCodeSites(q)); } catch { setMsg("Sites could not be loaded."); } };
  const load = async (id: string) => { try { const i = await ministryCodeInfo(id); setInfo((m) => ({ ...m, [id]: i })); } catch { setMsg("The code could not be loaded."); } };
  return (
    <section className="space-y-2 border border-border p-3" aria-label="Ministry intake codes">
      <h2 className="text-sm font-medium">Ministry intake codes (anonymous reports)</h2>
      <p className="text-xs text-muted-foreground">These codes are the Ministry&apos;s own: a company cannot see them in its review pages, rotate them or pause them. Post one at a site so workers can report anonymously to the Ministry. Change it, or pause anonymous reporting, if it is misused.</p>
      <div className="flex gap-2">
        <Input aria-label="Search company or site" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Company or site name" />
        <Button size="sm" variant="outline" onClick={() => { void search(); }}>Find sites</Button>
      </div>
      <ul className="space-y-2">
        {sites.map((s) => {
          const i = info[s.site_id];
          return (
            <li key={s.site_id} className="space-y-1 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span><span className="font-medium">{s.site_name}</span> <span className="text-xs text-muted-foreground">{s.organization_name}</span></span>
                <span className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => { void load(s.site_id); }}>{i ? "Refresh" : "Show code"}</Button>
                  {i && <Button size="sm" variant="ghost" onClick={() => { void ministryRotateCode(s.site_id).then(() => { setMsg("New code issued. The old one no longer works. Update the poster."); return load(s.site_id); }, () => setMsg("The code could not be changed.")); }}>Change code</Button>}
                  {i && <Button size="sm" variant="ghost" onClick={() => { void ministrySetAnonymous(s.site_id, !i.enabled).then(() => load(s.site_id), () => setMsg("That could not be changed.")); }}>{i.enabled ? "Pause anonymous" : "Resume anonymous"}</Button>}
                </span>
              </div>
              {i && <p className="text-xs text-muted-foreground"><span className="font-mono text-sm font-semibold text-foreground">{formatSiteCode(i.code)}</span> · changed {i.changedOn} · {i.enabled ? "accepting anonymous reports" : "PAUSED"} · anonymous reports today {i.today}, last 7 days {i.week}{i.unusual && <span className="block font-medium text-destructive">Unusually many reports today. If this is not expected, change the code or pause anonymous reporting.</span>}</p>}
            </li>
          );
        })}
      </ul>
      {msg && <p role="status" className="text-xs">{msg}</p>}
    </section>
  );
}

export function RequestsPanel({ companies }: { companies: { id: string; name: string }[] }) {
  const [rows, setRows] = useState<CompanyRequest[]>([]);
  const [org, setOrg] = useState("");
  const [topic, setTopic] = useState("");
  const [note, setNote] = useState("");
  const [follow, setFollow] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { let live = true; void listRequests().then((r) => { if (live) setRows(r); }, () => undefined); return () => { live = false; }; }, [tick]);
  const send = async () => { setMsg(null); try { await createRequest(org, topic, note || undefined); setNote(""); setMsg("Request sent. The company's administrators were told generically."); setTick((x) => x + 1); } catch (e) { setMsg(explainRequestError(e)); } };
  return (
    <section className="space-y-2 border border-border p-3" aria-label="Requests to companies">
      <h2 className="text-sm font-medium">Requests to a company</h2>
      <p className="text-xs text-muted-foreground">Ask a company to respond on a topic. A request is allowed only when at least three reports on that topic exist for the company in 180 days, so it cannot point at one reporter. It is not linked to any report, and the company is not told whether reports exist. Do not put anything in the note that came from a report.</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <select aria-label="Company" className="h-9 border border-input bg-background px-2 text-sm" value={org} onChange={(e) => setOrg(e.target.value)}>
          <option value="">Choose a company</option>{companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select aria-label="Topic" className="h-9 border border-input bg-background px-2 text-sm" value={topic} onChange={(e) => setTopic(e.target.value)}>
          <option value="">Choose a topic</option>{REQUEST_TOPICS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </div>
      <Textarea aria-label="Note to the company" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="Optional note (what you would like to see). Nothing from any report." />
      <Button size="sm" disabled={!org || !topic} onClick={() => { void send(); }}>Send request</Button>
      {msg && <p role="status" className="text-xs">{msg}</p>}
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.id} className="space-y-1 border border-border p-2 text-sm">
            <span className="block font-medium">{r.organization_name} · {REQUEST_TOPICS.find((t) => t.value === r.topic)?.label ?? r.topic} <span className="text-xs uppercase text-muted-foreground">· {r.status}</span></span>
            <span className="block text-xs text-muted-foreground">Sent {r.created_on}{r.note ? ` · ${r.note}` : ""}</span>
            {r.responses.map((x, i) => <span key={i} className="block text-sm"><span className="text-xs text-muted-foreground">{x.from} · {x.on}: </span>{x.text}</span>)}
            {r.status !== "closed" && (
              <span className="flex flex-wrap gap-2">
                <Input aria-label="Follow-up" className="max-w-sm" value={follow[r.id] ?? ""} maxLength={1500} onChange={(e) => setFollow({ ...follow, [r.id]: e.target.value })} placeholder="Follow-up to the company" />
                <Button size="sm" variant="outline" disabled={!(follow[r.id] ?? "").trim()} onClick={() => { void followUpRequest(r.id, follow[r.id], false).then(() => { setFollow({ ...follow, [r.id]: "" }); setTick((x) => x + 1); }, (e) => setMsg(explainRequestError(e))); }}>Send</Button>
                <Button size="sm" variant="ghost" onClick={() => { void followUpRequest(r.id, "", true).then(() => setTick((x) => x + 1), (e) => setMsg(explainRequestError(e))); }}>Close</Button>
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
