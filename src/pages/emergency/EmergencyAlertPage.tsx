// ---------------------------------------------------------------------------
// EMERGENCY ALERT — one alert, two audiences:
//  * the worker it is addressed to: clear instructions, source, acknowledgment, updates;
//  * authorized managers / in-scope oversight staff: delivery + acknowledgment status that
//    says plainly what cannot be verified, and the activate / update / cancel / resolve actions.
// Authorization is the database's. This page only shows what the server returned.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Link, useLocation, useParams } from "react-router";
import { ArrowLeft, CheckCircle2, Loader2, MapPin, RefreshCw, Siren, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmWordDialog } from "@/components/emergency/ConfirmWordDialog";
import { EmergencyDisclaimer } from "@/components/emergency/EmergencyNotice";
import { severityClasses } from "@/components/emergency/severity";
import { PushSetupCard } from "@/components/emergency/PushSetupCard";
import { useMyEmergencyAlerts, useNow } from "@/hooks/use-my-emergency-alerts";
import { toastError, toastSuccess } from "@/lib/feedback";
import {
  ackView,
  activateAlert,
  closeAlert,
  deliveryStateLabel,
  describeFreshness,
  explainEmergencyError,
  fetchDashboard,
  refreshPushRegistration,
  reportDisplayed,
  requestPushDispatch,
  SEVERITY_LABEL,
  TARGET_GROUP_LABEL,
  updateAlert,
  type Dashboard,
  type EmergencyAction,
  type MyAlert,
  type Severity,
} from "@/lib/emergency";
import { enqueueEmergencyAck, readQueue, subscribeQueue } from "@/lib/offline-queue";

function useQueuedAckRevision(alertId: string): number | null {
  const snapshot = useSyncExternalStore(
    subscribeQueue,
    () => JSON.stringify(readQueue().filter((q) => q.kind === "emergencyAck" && q.status !== "done").map((q) => q.emergencyAck)),
  );
  return useMemo(() => {
    const items = JSON.parse(snapshot) as Array<{ alertId: string; revision: number } | undefined>;
    const mine = items.filter((i) => i?.alertId === alertId).map((i) => i!.revision);
    return mine.length ? Math.max(...mine) : null;
  }, [snapshot, alertId]);
}

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");

function WorkerView({ alert, onChanged }: { alert: MyAlert; onChanged: () => void }) {
  const queuedRev = useQueuedAckRevision(alert.id);
  const view = ackView(alert, queuedRev);
  const [busy, setBusy] = useState(false);

  // Report "shown on this device" once per revision (best-effort; not proof anyone read it).
  useEffect(() => {
    if (alert.status === "active" && navigator.onLine !== false) void reportDisplayed(alert.id, alert.revision).catch(() => {});
  }, [alert.id, alert.revision, alert.status]);

  const acknowledge = async () => {
    setBusy(true);
    try {
      await enqueueEmergencyAck({
        clientRef: `ack-${alert.id}-${alert.revision}`,
        siteId: alert.site_id,
        siteCode: alert.site_code,
        alertId: alert.id,
        revision: alert.revision,
      });
      onChanged();
    } catch (e) {
      toastError(e, { action: "save your acknowledgment" });
    } finally {
      setBusy(false);
    }
  };

  const closed = alert.status !== "active";
  return (
    <section aria-labelledby="mg-alert-h" className={`rounded-lg border-2 p-4 md:p-6 ${closed ? "border-border bg-muted" : severityClasses[alert.severity]}`}>
      <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
        <Siren className="size-4" aria-hidden />
        {closed ? (alert.status === "cancelled" ? "ALERT CANCELLED" : "ALERT RESOLVED") : `${SEVERITY_LABEL[alert.severity].toUpperCase()} EMERGENCY ALERT`}
      </p>
      <h2 id="mg-alert-h" className="mt-1 text-2xl font-semibold leading-tight">{alert.title}</h2>
      <p className="mt-1 flex flex-wrap items-center gap-x-3 text-sm text-muted-foreground">
        <span className="inline-flex items-center gap-1"><MapPin className="size-3.5" aria-hidden />{alert.site_name}{alert.zone_label ? ` · ${alert.zone_label}` : ""}</span>
        <span>Update {alert.revision}</span>
      </p>

      {closed && (
        <p className="mt-3 rounded-md bg-background p-3 text-sm">
          {alert.status === "cancelled" ? "This alert was cancelled" : "This alert was marked resolved"} on {fmt(alert.closed_at)}.
          {alert.close_reason ? ` Reason given: ${alert.close_reason}` : ""} Follow your site's own instructions.
        </p>
      )}

      <h3 className="mt-4 text-sm font-semibold">What to do</h3>
      <p className="mt-1 whitespace-pre-wrap text-lg leading-relaxed">{alert.instructions}</p>

      {alert.assembly_point && (
        <>
          <h3 className="mt-4 text-sm font-semibold">Assembly point</h3>
          <p className="mt-1 text-base">{alert.assembly_point}</p>
        </>
      )}
      {alert.procedure_ref && (
        <>
          <h3 className="mt-4 text-sm font-semibold">Site-approved procedure</h3>
          <p className="mt-1 text-base">{alert.procedure_ref}</p>
        </>
      )}

      <p className="mt-4 text-sm">
        <span className="font-semibold">Issued by:</span> {alert.initiated_by}
        {alert.source_org ? `, ${alert.source_org}` : ""}
        {alert.activated_at ? ` · ${fmt(alert.activated_at)}` : ""}
      </p>

      {alert.updates.length > 0 && (
        <div className="mt-4">
          <h3 className="text-sm font-semibold">Updates</h3>
          <ol className="mt-1 space-y-1 text-sm">
            {alert.updates.map((u, i) => (
              <li key={i}>
                <span className="text-muted-foreground">{fmt(u.at)} — </span>
                {u.type === "updated" ? "Updated" : u.type === "cancelled" ? "Cancelled" : "Resolved"}
                {u.note ? `: ${u.note}` : ""}
              </li>
            ))}
          </ol>
        </div>
      )}

      <div className="mt-5 border-t pt-4">
        {view.state === "acknowledged" && (
          <p className="flex items-center gap-2 text-sm font-medium"><CheckCircle2 className="size-4" aria-hidden />You acknowledged this update. Keep following your site's procedure.</p>
        )}
        {view.state === "saved_on_device" && (
          <p role="status" className="flex items-start gap-2 text-sm"><WifiOff className="mt-0.5 size-4 shrink-0" aria-hidden />Your acknowledgment is saved on this device and has not reached the server yet. It will be sent when you have a connection. This does not replace telling your supervisor.</p>
        )}
        {view.state === "needed_after_update" && (
          <p className="mb-2 text-sm font-medium">This alert changed after you acknowledged it. Please read it again and acknowledge.</p>
        )}
        {(view.state === "needed" || view.state === "needed_after_update") && (
          <Button size="lg" className="w-full md:w-auto" onClick={acknowledge} disabled={busy}>
            {busy && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />}
            I have read this alert
          </Button>
        )}
        <p className="mt-2 text-xs text-muted-foreground">Acknowledging tells your managers you have seen this screen. It is not a safety check-in.</p>
      </div>
    </section>
  );
}

function ManagerPanel({ id }: { id: string }) {
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [denied, setDenied] = useState(false);
  const [action, setAction] = useState<EmergencyAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [form, setForm] = useState({ title: "", severity: "warning" as Severity, instructions: "", assemblyPoint: "", zoneLabel: "", procedureRef: "" });

  const load = useCallback(async () => {
    try {
      const d = await fetchDashboard(id);
      setDash(d);
      setForm({
        title: d.alert.title,
        severity: d.alert.severity,
        instructions: d.alert.instructions,
        assemblyPoint: d.alert.assembly_point ?? "",
        zoneLabel: d.alert.zone_label ?? "",
        procedureRef: d.alert.procedure_ref ?? "",
      });
    } catch (e) {
      if (/FORBIDDEN/.test(String((e as Error)?.message))) setDenied(true);
    }
  }, [id]);
  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    const t = window.setInterval(() => document.visibilityState === "visible" && void load(), 20_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(t);
    };
  }, [load]);

  if (denied || !dash) return null;
  const a = dash.alert;
  const open = a.status === "draft" || a.status === "active";

  const run = async (typed: string) => {
    setBusy(true);
    setErr(null);
    try {
      if (action === "activate") await activateAlert(a.id, a.revision, typed);
      else if (action === "update")
        await updateAlert(a.id, a.revision, typed, note, {
          title: form.title, severity: form.severity, instructions: form.instructions,
          assemblyPoint: form.assemblyPoint, zoneLabel: form.zoneLabel, procedureRef: form.procedureRef,
        });
      else await closeAlert(a.id, action === "cancel" ? "cancelled" : "resolved", reason, typed, a.revision);
      // The alert state is now committed in the database. Push is a best-effort extra.
      const d = action === "activate" || action === "update" || action === "cancel" || action === "resolve" ? await requestPushDispatch(a.id) : { ok: true };
      toastSuccess(d.ok ? { title: "Done.", reassure: "Delivery status is shown below." } : { title: "Done.", reassure: "Push notifications could not be sent right now; the alert itself is saved in MineGuard." });
      setAction(null); setEditing(false); setNote(""); setReason("");
      await load();
    } catch (e) {
      setErr(explainEmergencyError(e));
    } finally {
      setBusy(false);
    }
  };

  const c = dash.counts;
  const rows: Array<[string, number, string]> = [
    ["In audience", c.audience, "People who currently have access to this site and match the target group."],
    ["Acknowledged this version", c.acknowledged_current, "Pressed “I have read this alert”."],
    ["Acknowledged an earlier version", c.acknowledged_earlier_revision, "Need to read the latest update."],
    ["App reports it was shown", c.displayed_reported_current, "Reported by the worker's app; cannot be independently verified."],
    ["Push service accepted", c.push_service_accepted, "Accepted by the browser vendor's push service. Not proof it reached the device."],
    ["Push waiting to send", c.push_queued, "Not yet handed to the push service."],
    ["Push failed or expired", c.push_failed_or_expired, "The push service refused it or the device registration is gone."],
    ["No push registration", c.no_push_subscription, "Cannot be reached by push at all (not enabled, blocked or unsupported)."],
  ];

  return (
    <section aria-labelledby="mg-mgr-h" className="paper space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="mg-mgr-h" className="text-lg font-semibold">Alert control and delivery status</h2>
        <span className="text-sm text-muted-foreground">Status: <strong>{a.status}</strong> · version {a.revision} · {TARGET_GROUP_LABEL[a.target_group]}</span>
      </div>

      {dash.can_manage && open && (
        <div className="flex flex-wrap gap-2">
          {a.status === "draft" && <Button onClick={() => { setErr(null); setAction("activate"); }}>Activate alert…</Button>}
          <Button variant="outline" onClick={() => setEditing((v) => !v)}>{editing ? "Close editor" : "Edit alert"}</Button>
          {a.status === "active" && <Button variant="outline" onClick={() => { setErr(null); setAction("resolve"); }}>Mark resolved…</Button>}
          <Button variant="destructive" onClick={() => { setErr(null); setAction("cancel"); }}>{a.status === "draft" ? "Discard draft…" : "Cancel alert…"}</Button>
          {a.status === "active" && (
            <Button variant="ghost" onClick={async () => { const r = await requestPushDispatch(a.id); toastSuccess(r.ok ? { title: "Retried push delivery." } : { title: "Push delivery could not be completed right now.", reassure: "Use radio, sirens and your site procedure." }); await load(); }}>
              <RefreshCw className="mr-2 size-4" aria-hidden />Retry push delivery
            </Button>
          )}
        </div>
      )}

      {editing && (
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); setErr(null); setAction("update"); }}>
          <div><Label htmlFor="e-title">Title</Label><Input id="e-title" value={form.title} maxLength={120} onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
          <div><Label htmlFor="e-sev">Severity</Label>
            <select id="e-sev" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value as Severity })}>
              <option value="advisory">Advisory</option><option value="warning">Warning</option><option value="critical">Critical</option>
            </select></div>
          <div><Label htmlFor="e-ins">Instructions</Label><Textarea id="e-ins" rows={4} maxLength={2000} value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} /></div>
          <div><Label htmlFor="e-ap">Assembly point</Label><Input id="e-ap" value={form.assemblyPoint} maxLength={300} onChange={(e) => setForm({ ...form, assemblyPoint: e.target.value })} /></div>
          <div><Label htmlFor="e-zone">Area / zone label</Label><Input id="e-zone" value={form.zoneLabel} maxLength={80} onChange={(e) => setForm({ ...form, zoneLabel: e.target.value })} /></div>
          <div><Label htmlFor="e-proc">Site-approved procedure reference</Label><Input id="e-proc" value={form.procedureRef} maxLength={300} onChange={(e) => setForm({ ...form, procedureRef: e.target.value })} /></div>
          {a.status === "active" && (
            <div><Label htmlFor="e-note">What changed (shown to workers)</Label><Input id="e-note" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} /></div>
          )}
          <div><Button type="submit" disabled={a.status === "active" && !note.trim()}>Save changes…</Button></div>
        </form>
      )}

      <div>
        <h3 className="text-sm font-semibold">Delivery and acknowledgment</h3>
        <dl className="mt-2 grid gap-2 sm:grid-cols-2">
          {rows.map(([k, v, hint]) => (
            <div key={k} className="rounded-md border p-2">
              <dt className="text-xs text-muted-foreground">{k}</dt>
              <dd className="text-xl font-semibold">{v}</dd>
              <dd className="text-xs text-muted-foreground">{hint}</dd>
            </div>
          ))}
        </dl>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          {dash.limits.map((l) => <li key={l}>{l}</li>)}
        </ul>
      </div>

      <details>
        <summary className="cursor-pointer text-sm font-semibold">People ({dash.people.length})</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead><tr className="text-xs text-muted-foreground"><th className="py-1 pr-2">Name</th><th className="pr-2">Role</th><th className="pr-2">Acknowledged</th><th className="pr-2">App shown</th><th>Push</th></tr></thead>
            <tbody>
              {dash.people.map((p) => (
                <tr key={p.user_id} className="border-t align-top">
                  <td className="py-1 pr-2">{p.name}{!p.in_audience && <span className="text-xs text-muted-foreground"> (no longer in audience)</span>}</td>
                  <td className="pr-2">{p.org_role ?? "—"}</td>
                  <td className="pr-2">{p.ack_revision ? `v${p.ack_revision} · ${fmt(p.ack_at)}` : "Not acknowledged — unknown, not “unsafe”"}</td>
                  <td className="pr-2">{p.displayed_revision_reported ? `v${p.displayed_revision_reported} (reported)` : "Not reported"}</td>
                  <td>{!p.has_push_subscription ? "No registration" : p.push_states.length ? p.push_states.map(deliveryStateLabel).join("; ") : "Nothing sent yet"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <details>
        <summary className="cursor-pointer text-sm font-semibold">History ({dash.history.length})</summary>
        <ol className="mt-2 space-y-1 text-sm">
          {dash.history.map((h, i) => (
            <li key={i}><span className="text-muted-foreground">{fmt(h.at)} — </span>{h.type} (v{h.revision}){h.by ? ` by ${h.by}` : ""}{h.note ? `: ${h.note}` : ""}</li>
          ))}
        </ol>
      </details>

      <ConfirmWordDialog
        open={action !== null}
        action={action ?? "activate"}
        busy={busy}
        error={err}
        onCancel={() => setAction(null)}
        onConfirm={run}
        title={action === "activate" ? "Activate this emergency alert?" : action === "update" ? "Send this update to workers?" : action === "resolve" ? "Mark this alert resolved?" : a.status === "draft" ? "Discard this draft?" : "Cancel this alert?"}
        description={
          <div className="space-y-2">
            <p>
              {action === "activate" && `This immediately shows “${a.title}” to everyone currently in the audience (${c.audience} people) and tries to notify their devices.`}
              {action === "update" && "Workers will see the new instructions and be asked to acknowledge again."}
              {(action === "cancel" || action === "resolve") && "Workers will be told the alert is no longer active."}
            </p>
            <p>This does not replace sirens, radios or your site's procedure. Do not rely on it as the only way to warn people.</p>
            {(action === "cancel" || action === "resolve") && (
              <div><Label htmlFor="c-reason">Reason (recorded and shown to workers)</Label><Input id="c-reason" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} /></div>
            )}
          </div>
        }
      />
    </section>
  );
}

export default function EmergencyAlertPage() {
  const { alertId = "" } = useParams();
  const mine = useMyEmergencyAlerts(true);
  const alert = mine.alerts.find((a) => a.id === alertId) ?? null;
  const now = useNow(15_000);
  const fresh = describeFreshness(mine.checkedAt, now, mine.online, mine.lastCheckFailed);
  const base = useLocation().pathname.startsWith("/portal") ? "/portal" : "/operate";

  useEffect(() => { void refreshPushRegistration(); }, []);

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 py-6 md:px-8">
      <Link to={`${base}/emergency`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"><ArrowLeft className="size-4" aria-hidden />All alerts</Link>
      <p role="status" className={`rounded-md border p-2 text-xs ${fresh.level === "live" ? "text-muted-foreground" : "border-amber-600 bg-amber-500/10"}`}>{fresh.message}</p>
      {alert ? <WorkerView alert={alert} onChanged={() => void mine.refresh()} /> : (
        <p className="text-sm text-muted-foreground">{mine.checkedAt ? "This alert is not addressed to you, or it is no longer available." : "Checking for this alert…"}</p>
      )}
      <EmergencyDisclaimer />
      <ManagerPanel id={alertId} />
      <PushSetupCard />
    </div>
  );
}
