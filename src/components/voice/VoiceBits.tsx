// Small shared pieces for the two Worker Voice review pages: photo viewer, message thread, hold control, retention panel.
// Everything here calls an RPC that decides for itself; hiding a control is a courtesy.
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageLoading } from "@/components/PageLoading";

export function Photos({ load }: { load: () => Promise<{ id: string; bytes: number; sha256: string; data: string }[]> }) {
  const [photos, setPhotos] = useState<{ id: string; bytes: number; sha256: string; data: string }[] | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let live = true;
    void load().then((p) => { if (live) setPhotos(p); }, () => { if (live) setErr(true); });
    return () => { live = false; };
  }, [load]);
  if (err) return <p role="alert" className="text-xs">Photos could not be loaded.</p>;
  if (!photos) return <PageLoading shape="list" label="photos" rows={1} compact />;
  return (
    <ul className="flex flex-wrap gap-2" aria-label="Photos">
      {photos.map((p) => (
        <li key={p.id} className="space-y-1 text-xs">
          {/* shown only as an image: there is no link, download or address for it */}
          <img src={`data:image/jpeg;base64,${p.data}`} alt="Attached photo" className="max-h-56 max-w-full border border-border object-contain" />
          <span className="block text-muted-foreground">{Math.round(p.bytes / 1024)} KB · SHA-256 {p.sha256.slice(0, 12)}…</span>
        </li>
      ))}
      <li className="w-full text-xs text-muted-foreground">Photos are not scanned for viruses and can show people. Handle them with the same care as the report.</li>
    </ul>
  );
}

export function Thread({ messages }: { messages: { seq: number; from_reporter: boolean; body: string; at: string }[] }) {
  if (messages.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Messages with the reporter</p>
      <ul className="space-y-1">
        {messages.map((m) => (
          <li key={m.seq} className={`border p-2 text-sm ${m.from_reporter ? "border-primary/40" : "border-border"}`}>
            <span className="block text-xs text-muted-foreground">{m.from_reporter ? "Reporter" : "Reviewers"} · {new Date(m.at).toLocaleDateString()}</span>{m.body}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function HoldControl({ held, closed, onSet, canSet }: { held: boolean; closed: boolean; canSet: boolean; onSet: (hold: boolean, reason?: string) => Promise<void> }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const go = async (hold: boolean) => { setBusy(true); setMsg(null); try { await onSet(hold, hold ? reason : undefined); setReason(""); } catch { setMsg("That could not be completed. Nothing was changed."); } finally { setBusy(false); } };
  return (
    <div className="space-y-1 border-t border-border pt-2">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Retention</p>
      {held ? <p className="text-xs">On legal hold: this report will not be disposed of, even after its retention period.</p> : <p className="text-xs text-muted-foreground">{closed ? "Closed. It will be eligible for disposal at the end of the retention period unless it is held." : "Reports are kept for the retention period after they are closed."}</p>}
      {canSet && (held
        ? <Button size="sm" variant="outline" disabled={busy} onClick={() => { void go(false); }}>Lift legal hold</Button>
        : <span className="flex flex-wrap gap-2"><Input aria-label="Reason for the legal hold" className="max-w-xs" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Reason for a legal hold (at least 10 characters)" />
            <Button size="sm" variant="outline" disabled={busy || reason.trim().length < 10} onClick={() => { void go(true); }}>Place legal hold</Button></span>)}
      {msg && <p role="status" className="text-xs">{msg}</p>}
    </div>
  );
}

export function RetentionPanel({ channel, load, canSetPolicy, setPolicy, dispose }: {
  channel: "company" | "ministry"; canSetPolicy: boolean;
  load: () => Promise<{ channel: string; retention_months: number }[]>;
  setPolicy?: (ch: "company" | "ministry", months: number) => Promise<unknown>;
  dispose: (dryRun: boolean, confirm?: string) => Promise<{ dryRun: boolean; eligible?: number; deleted?: number; retentionMonths: number }>;
}) {
  const [policy, setP] = useState<{ channel: string; retention_months: number }[]>([]);
  const [eligible, setEligible] = useState<number | null>(null);
  const [word, setWord] = useState("");
  const [months, setMonths] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { let live = true; void load().then((p) => { if (live) setP(p); }, () => undefined); return () => { live = false; }; }, [load, tick]);
  const mine = policy.find((p) => p.channel === channel)?.retention_months;
  const check = async () => { setMsg(null); try { const r = await dispose(true); setEligible(r.eligible ?? 0); } catch { setMsg("The check could not be completed. Nothing was changed."); } };
  const run = async () => { setMsg(null); try { const r = await dispose(false, word); setMsg(`${r.deleted ?? 0} report(s) permanently deleted.`); setEligible(null); setWord(""); } catch { setMsg("Disposal was not carried out. Nothing was changed."); } };
  return (
    <section className="space-y-2 border border-border p-3" aria-label="Retention and disposal">
      <h2 className="text-sm font-medium">Retention and disposal</h2>
      <p className="text-xs text-muted-foreground">Closed reports are kept for {mine ?? "…"} months, then become eligible for disposal unless they are on legal hold. Nothing is deleted until you type DISPOSE. Only counts are logged, never content.</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => { void check(); }}>Check what is eligible</Button>
        {eligible !== null && <span className="self-center text-sm">{eligible} report(s) eligible</span>}
      </div>
      {eligible !== null && eligible > 0 && (
        <div className="flex flex-wrap gap-2">
          <Input aria-label="Type DISPOSE to confirm" className="max-w-xs" value={word} onChange={(e) => setWord(e.target.value)} placeholder="Type DISPOSE to delete them for good" />
          <Button size="sm" variant="destructive" disabled={word !== "DISPOSE"} onClick={() => { void run(); }}>Dispose</Button>
        </div>
      )}
      {canSetPolicy && setPolicy && (
        <div className="flex flex-wrap gap-2 border-t border-border pt-2">
          {(["company", "ministry"] as const).map((ch) => (
            <span key={ch} className="text-xs text-muted-foreground">{ch === "company" ? "Company channel" : "Ministry channel"}: {policy.find((p) => p.channel === ch)?.retention_months ?? "…"} months</span>
          ))}
          <Input aria-label="Retention months" className="h-8 w-24" inputMode="numeric" value={months} onChange={(e) => setMonths(e.target.value.replace(/\D/g, ""))} placeholder="12–120" />
          {(["company", "ministry"] as const).map((ch) => (
            <Button key={ch} size="sm" variant="outline" disabled={!months || Number(months) < 12 || Number(months) > 120} onClick={() => { void setPolicy(ch, Number(months)).then(() => { setTick((t) => t + 1); setMonths(""); }, () => setMsg("The period could not be changed.")); }}>Set {ch}</Button>
          ))}
        </div>
      )}
      {msg && <p role="status" className="text-xs">{msg}</p>}
    </section>
  );
}
