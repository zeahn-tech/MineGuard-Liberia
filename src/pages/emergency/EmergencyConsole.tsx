// ---------------------------------------------------------------------------
// EMERGENCY ALERTS — list + "new alert" for authorized people. Alerts are created as a DRAFT
// (nothing is sent); activation is a separate, confirmed step on the alert's own page.
// Whether the signed-in person may create alerts for a site is decided by the database; a
// refusal is shown, not hidden. Supplementary aid only — not a replacement for site systems.
// ---------------------------------------------------------------------------
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { Loader2, Siren } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EmergencyDisclaimer } from "@/components/emergency/EmergencyNotice";
import { PushSetupCard } from "@/components/emergency/PushSetupCard";
import { EmptyState } from "@/components/EmptyState";
import { PageLoading } from "@/components/PageLoading";
import { supabase } from "@/lib/supabase";
import {
  createAlert,
  explainEmergencyError,
  listAlerts,
  newIdempotencyKey,
  SEVERITY_LABEL,
  TARGET_GROUP_LABEL,
  type ListedAlert,
  type Severity,
  type TargetGroup,
} from "@/lib/emergency";

interface SiteOption { id: string; name: string; code: string }

export default function EmergencyConsole() {
  const base = useLocation().pathname.startsWith("/portal") ? "/portal" : "/operate";
  const navigate = useNavigate();
  const [alerts, setAlerts] = useState<ListedAlert[] | null>(null);
  const [sites, setSites] = useState<SiteOption[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const keyRef = useRef(newIdempotencyKey()); // same key on a double-click → same alert
  const [f, setF] = useState({
    siteId: "", title: "", severity: "warning" as Severity, targetGroup: "all" as TargetGroup,
    instructions: "", assemblyPoint: "", zoneLabel: "", procedureRef: "",
  });

  useEffect(() => {
    void listAlerts().then(setAlerts).catch((e) => setLoadErr(explainEmergencyError(e)));
    void supabase.from("sites").select("id, name, code").order("name").limit(300).then(({ data }) => setSites((data ?? []) as SiteOption[]));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const id = await createAlert({ ...f, zoneLabel: f.zoneLabel || undefined, assemblyPoint: f.assemblyPoint || undefined, procedureRef: f.procedureRef || undefined }, keyRef.current);
      navigate(`${base}/emergency/${id}`);
    } catch (e2) {
      setErr(explainEmergencyError(e2));
    } finally {
      setBusy(false);
    }
  };
  const valid = f.siteId && f.title.trim().length >= 3 && f.instructions.trim().length >= 1;

  return (
    <div className="mx-auto max-w-4xl space-y-5 px-4 py-6 md:px-8">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-semibold"><Siren className="size-6" aria-hidden />Emergency alerts</h1>
        <p className="mt-1 text-sm text-muted-foreground">Create and manage alerts for people at a site. Creating an alert only saves a draft; nothing is sent until you activate it.</p>
      </header>
      <EmergencyDisclaimer />

      <div>
        <Button onClick={() => setShowNew((v) => !v)} variant={showNew ? "outline" : "default"}>{showNew ? "Close" : "New alert"}</Button>
      </div>

      {showNew && (
        <form onSubmit={submit} className="paper grid gap-3 p-4 md:p-6" aria-label="New emergency alert">
          <div>
            <Label htmlFor="n-site">Site</Label>
            <select id="n-site" required className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={f.siteId} onChange={(e) => setF({ ...f, siteId: e.target.value })}>
              <option value="">Choose a site…</option>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.code})</option>)}
            </select>
          </div>
          <div><Label htmlFor="n-title">Title</Label><Input id="n-title" required minLength={3} maxLength={120} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="n-sev">Severity</Label>
              <select id="n-sev" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value as Severity })}>
                {(Object.keys(SEVERITY_LABEL) as Severity[]).map((s) => <option key={s} value={s}>{SEVERITY_LABEL[s]}</option>)}
              </select>
            </div>
            <div>
              <Label htmlFor="n-aud">Who should see it</Label>
              <select id="n-aud" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={f.targetGroup} onChange={(e) => setF({ ...f, targetGroup: e.target.value as TargetGroup })}>
                {(Object.keys(TARGET_GROUP_LABEL) as TargetGroup[]).map((g) => <option key={g} value={g}>{TARGET_GROUP_LABEL[g]}</option>)}
              </select>
            </div>
          </div>
          <div><Label htmlFor="n-ins">Instructions for workers</Label><Textarea id="n-ins" required rows={4} maxLength={2000} value={f.instructions} onChange={(e) => setF({ ...f, instructions: e.target.value })} /></div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div><Label htmlFor="n-ap">Assembly point</Label><Input id="n-ap" maxLength={300} value={f.assemblyPoint} onChange={(e) => setF({ ...f, assemblyPoint: e.target.value })} /></div>
            <div><Label htmlFor="n-zone">Area / zone (label only)</Label><Input id="n-zone" maxLength={80} value={f.zoneLabel} onChange={(e) => setF({ ...f, zoneLabel: e.target.value })} /></div>
          </div>
          <div><Label htmlFor="n-proc">Site-approved procedure reference</Label><Input id="n-proc" maxLength={300} placeholder="e.g. the document name or number your site uses" value={f.procedureRef} onChange={(e) => setF({ ...f, procedureRef: e.target.value })} /></div>
          <p className="text-xs text-muted-foreground">The area label is shown to workers but does not narrow who receives the alert; the audience is everyone in the chosen group with access to the site.</p>
          {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
          <div><Button type="submit" disabled={!valid || busy}>{busy && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />}Save as draft</Button></div>
        </form>
      )}

      <section aria-labelledby="al-h">
        <h2 id="al-h" className="text-lg font-semibold">Alerts</h2>
        {loadErr && <p role="alert" className="text-sm text-destructive">{loadErr}</p>}
        {alerts === null && !loadErr && <PageLoading shape="list" label="emergency alerts" compact />}
        {alerts?.length === 0 && (
          <EmptyState icon={Siren} title="No emergency alerts" why="Alerts created for the sites you can manage appear here. Authorized site managers and company administrators can create one with “New alert”." />
        )}
        <ul className="mt-2 divide-y rounded-md border">
          {alerts?.map((a) => (
            <li key={a.id}>
              <Link to={`${base}/emergency/${a.id}`} className="flex flex-wrap items-center justify-between gap-2 p-3 hover:bg-muted focus-visible:outline-2">
                <span><span className="font-medium">{a.title}</span><span className="block text-xs text-muted-foreground">{SEVERITY_LABEL[a.severity]} · {new Date(a.created_at).toLocaleString()}</span></span>
                <span className="rounded-full border px-2 py-0.5 text-xs">{a.status}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
      <PushSetupCard />
    </div>
  );
}
