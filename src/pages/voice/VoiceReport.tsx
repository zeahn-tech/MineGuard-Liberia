// ---------------------------------------------------------------------------
// WORKER VOICE — report form. Two doors onto the same form:
//   /operate/voice  signed-in members: named, confidential or anonymous
//   /voice          no account: anonymous only, with the code posted at the site
// The privacy choice comes FIRST, in plain words, before anything sensitive is typed. Status is
// honest: "saved on this device" is never presented as "received".
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { Copy, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/EmptyState";
import { PageLoading } from "@/components/PageLoading";
import { PublicHeader } from "@/components/PublicHeader";
import { NotSavedError } from "@/lib/offline-store";
import { jsaSites, type JsaSite } from "@/lib/jsa";
import {
  formatFollowUpCode, formatSiteCode, MAX_DESCRIPTION, MIN_DESCRIPTION, MODE_INFO, newFollowUpCode, normalizeSiteCode,
  PERSONAL_INFO_NOTICE, RETALIATION_NOTICE, ROUTING_NOTICE, VOICE_CATEGORIES, VOICE_PREVIOUS, VOICE_URGENCIES,
  type VoiceCategory, type VoiceFields, type VoiceMode, type VoiceUrgency,
} from "@/lib/voice";
import { describeItem, enqueue, flushQueue, listQueue, removeFromQueue } from "@/lib/voice-queue";
import { myVoiceReports, siteCode, type MyReport } from "@/lib/voice-review";
import type { QueuedReport } from "@/lib/voice";

type Phase = "form" | "received" | "saved" | "attention" | "not_saved";

function ModeCard({ mode, chosen, onChoose }: { mode: VoiceMode; chosen: boolean; onChoose: () => void }) {
  const i = MODE_INFO[mode];
  return (
    <label className={`block cursor-pointer space-y-1 border p-3 text-sm ${chosen ? "border-primary bg-primary/5" : "border-border"}`}>
      <span className="flex items-center gap-2">
        <input type="radio" name="wv-mode" checked={chosen} onChange={onChoose} />
        <span className="font-medium">{i.title}</span>
      </span>
      <span className="block text-muted-foreground">{i.summary}</span>
      {chosen && (
        <span className="block space-y-2 pt-1">
          <span className="block">{i.who}</span>
          <span className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">What this does not protect</span>
          <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">{i.limits.map((l, k) => <li key={k}>{l}</li>)}</ul>
        </span>
      )}
    </label>
  );
}

function Receipt({ phase, code, message, onAgain }: { phase: Phase; code: string; message: string | null; onAgain: () => void }) {
  const [copied, setCopied] = useState(false);
  const shown = formatFollowUpCode(code);
  const heading = phase === "received" ? "Received by MineGuard" : phase === "saved" ? "Saved on this device. Not yet received." : phase === "attention" ? "Saved on this device. It needs a change." : "Not saved";
  return (
    <section className="space-y-3 border border-border p-4" aria-live="polite">
      <h2 className="text-lg font-semibold">{heading}</h2>
      {phase === "received" && <p className="text-sm">Your report reached MineGuard and is waiting for review by your company&apos;s reviewers.</p>}
      {phase === "saved" && <p className="text-sm">{message ?? "MineGuard has not received it yet."} It will be sent when you are connected. Do not rely on it until this page says Received.</p>}
      {phase === "attention" && <p className="text-sm">{message}</p>}
      {phase === "not_saved" && <p className="text-sm">{message}</p>}
      {phase !== "not_saved" && (
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Your follow-up code</p>
          <p className="break-all font-mono text-lg font-semibold" data-testid="follow-up-code">{shown}</p>
          <Button size="sm" variant="outline" onClick={() => { void navigator.clipboard?.writeText(shown).then(() => setCopied(true)); }}><Copy className="size-4" /> {copied ? "Copied" : "Copy code"}</Button>
          <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            <li>Keep this code somewhere private. It is the only way to check this report&apos;s progress.</li>
            <li>We cannot recover it for you, and we cannot look it up by your name.</li>
            <li>Anyone who has the code can see the report&apos;s progress, so do not share it.</li>
            <li>Check progress at <Link className="underline" to="/voice/status">Check a report</Link>. You will see a stage and any update the reviewers wrote for you, and nothing else.</li>
          </ul>
        </div>
      )}
      <Button onClick={onAgain}>Send another report</Button>
    </section>
  );
}

export function VoiceReportForm({ context }: { context: "member" | "public" }) {
  const member = context === "member";
  const [mode, setMode] = useState<VoiceMode | null>(member ? null : "anonymous");
  const [sites, setSites] = useState<JsaSite[] | null>(member ? null : []);
  const [siteId, setSiteId] = useState("");
  const [siteCodeText, setSiteCodeText] = useState("");
  const [category, setCategory] = useState<VoiceCategory | "">("");
  const [urgency, setUrgency] = useState<VoiceUrgency | "">("");
  const [description, setDescription] = useState("");
  const [occurred, setOccurred] = useState("");
  const [previous, setPrevious] = useState<"no" | "yes" | "unsure">("no");
  const [concerns, setConcerns] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<Phase>("form");
  const [receipt, setReceipt] = useState<{ code: string; message: string | null } | null>(null);
  const [queue, setQueue] = useState<QueuedReport[]>([]);
  const [mine, setMine] = useState<MyReport[]>([]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    void (async () => {
      const [q, s, m] = await Promise.all([listQueue(), member ? jsaSites().catch(() => [] as JsaSite[]) : Promise.resolve([] as JsaSite[]), member ? myVoiceReports().catch(() => [] as MyReport[]) : Promise.resolve([] as MyReport[])]);
      return { q, s, m };
    })().then((r) => { if (live) { setQueue(r.q); setSites(r.s); setMine(r.m); if (r.s.length === 1) setSiteId((x) => x || r.s[0].id); } });
    return () => { live = false; };
  }, [member, tick]);

  // members choosing anonymous: fetch the site's code for them, when online. It is posted at the site too.
  useEffect(() => {
    if (!member || mode !== "anonymous" || !siteId) return;
    let live = true;
    void siteCode(siteId).then((c) => { if (live) setSiteCodeText(c); }, () => undefined);
    return () => { live = false; };
  }, [member, mode, siteId]);

  const flush = useCallback(async () => { await flushQueue({ signedIn: member }); setTick((t) => t + 1); }, [member]);
  useEffect(() => {
    const on = () => { void flush(); };
    window.addEventListener("online", on);
    return () => window.removeEventListener("online", on);
  }, [flush]);

  const reset = () => { setPhase("form"); setReceipt(null); setDescription(""); setOccurred(""); setConcerns(false); setCategory(""); setUrgency(""); setError(null); setTick((t) => t + 1); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!mode) return setError("Choose how you want to report first.");
    if (member && !siteId) return setError("Choose the site.");
    if (mode === "anonymous" && normalizeSiteCode(siteCodeText).length !== 10) return setError("Enter the 10-character site code posted at your site.");
    if (!category) return setError("Choose a category.");
    if (!urgency) return setError("Choose how urgent it is.");
    const text = description.trim();
    if (text.length < MIN_DESCRIPTION) return setError(`Describe the concern in at least ${MIN_DESCRIPTION} characters.`);
    if (text.length > MAX_DESCRIPTION) return setError(`Please keep it under ${MAX_DESCRIPTION} characters.`);
    const fields: VoiceFields = { category, urgency, description: text, occurredAt: occurred ? new Date(occurred).toISOString() : null, previouslyReported: previous, concernsReviewer: concerns };
    const id = crypto.randomUUID();
    const code = newFollowUpCode();
    setBusy(true);
    try {
      await enqueue({ id, mode, siteId: mode === "anonymous" ? undefined : siteId, siteCode: mode === "anonymous" ? normalizeSiteCode(siteCodeText) : undefined, fields, code });
    } catch (e2) {
      setBusy(false);
      setReceipt({ code, message: e2 instanceof NotSavedError ? "This phone could not save the report, and it has NOT been sent. Free some space or try again." : "The report could not be saved and has NOT been sent. Try again." });
      return setPhase("not_saved");
    }
    let results = await flushQueue({ signedIn: member, only: id });
    if (!results.some((r) => r.id === id)) results = await flushQueue({ signedIn: member, only: id });
    const mineResult = results.find((r) => r.id === id);
    const left = (await listQueue()).find((x) => x.id === id);
    setBusy(false);
    setReceipt({ code, message: left ? describeItem(left) : null });
    setPhase(mineResult?.sent ? "received" : left?.state === "needs_attention" ? "attention" : "saved");
    setTick((t) => t + 1);
  };

  const body = (
    <div className="mx-auto max-w-2xl space-y-4 p-4">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Worker Voice</h1>
        <p className="text-sm text-muted-foreground">Raise a safety concern: an unsafe condition, a near miss, an equipment or maintenance hazard, an unsafe procedure, or an action that is still not done.</p>
      </header>
      {member && sites === null && <PageLoading shape="form" label="the report form" />}
      {phase !== "form" && receipt ? <Receipt phase={phase} code={receipt.code} message={receipt.message} onAgain={reset} /> : (member && sites === null ? null : (
        <form onSubmit={submit} className="space-y-4">
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">1. How do you want to report?</legend>
            {(member ? (["named", "confidential", "anonymous"] as VoiceMode[]) : (["anonymous"] as VoiceMode[])).map((m) => (
              <ModeCard key={m} mode={m} chosen={mode === m} onChoose={() => setMode(m)} />
            ))}
            {!member && <p className="text-xs text-muted-foreground">This page needs no account. To send a named or confidential report, <Link className="underline" to="/auth">sign in</Link> and use Worker Voice in your company workspace.</p>}
          </fieldset>

          {mode && (
            <>
              <section className="space-y-2">
                <h2 className="text-sm font-medium">2. Where?</h2>
                {member && (sites ?? []).length === 0 ? (
                  <EmptyState title="No site available to report to" why="You need to be a member of a company site to report from here. Ask your company administrator." />
                ) : member ? (
                  <select aria-label="Site" className="h-9 w-full border border-input bg-background px-2 text-sm" value={siteId} onChange={(e) => setSiteId(e.target.value)}>
                    <option value="">Choose the site</option>
                    {(sites ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                ) : null}
                {mode === "anonymous" && (
                  <div className="space-y-1">
                    <Label htmlFor="wv-site-code">Site code</Label>
                    <Input id="wv-site-code" value={formatSiteCode(siteCodeText)} maxLength={11} autoCapitalize="characters" autoComplete="off" onChange={(e) => setSiteCodeText(e.target.value)} placeholder="XXXXX-XXXXX" />
                    <p className="text-xs text-muted-foreground">{member ? "Filled in for you when you are online. It is also posted at your site." : "Posted at your site. It tells MineGuard which site this is for, and nothing about you."}</p>
                  </div>
                )}
              </section>

              <section className="space-y-3">
                <h2 className="text-sm font-medium">3. What is the concern?</h2>
                <div className="space-y-1">
                  <Label htmlFor="wv-cat">Category</Label>
                  <select id="wv-cat" className="h-9 w-full border border-input bg-background px-2 text-sm" value={category} onChange={(e) => setCategory(e.target.value as VoiceCategory)}>
                    <option value="">Choose a category</option>
                    {VOICE_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="wv-urg">How urgent?</Label>
                  <select id="wv-urg" className="h-9 w-full border border-input bg-background px-2 text-sm" value={urgency} onChange={(e) => setUrgency(e.target.value as VoiceUrgency)}>
                    <option value="">Choose urgency</option>
                    {VOICE_URGENCIES.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
                  </select>
                  {urgency === "critical" && <p className="text-xs">If someone is in danger right now, follow your site&apos;s emergency procedure first. This form is not an alarm.</p>}
                </div>
                <div className="space-y-1">
                  <Label htmlFor="wv-desc">What is happening?</Label>
                  <Textarea id="wv-desc" value={description} maxLength={MAX_DESCRIPTION} rows={6} onChange={(e) => setDescription(e.target.value)} aria-describedby="wv-desc-help" />
                  <p id="wv-desc-help" className="text-xs text-muted-foreground">{PERSONAL_INFO_NOTICE} {description.length}/{MAX_DESCRIPTION}</p>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="wv-when">Approximately when? (optional)</Label>
                  <Input id="wv-when" type="datetime-local" value={occurred} onChange={(e) => setOccurred(e.target.value)} />
                </div>
                <fieldset className="space-y-1">
                  <legend className="text-sm">Has this been reported before?</legend>
                  {VOICE_PREVIOUS.map((p) => (
                    <label key={p.value} className="flex items-center gap-2 text-sm"><input type="radio" name="wv-prev" checked={previous === p.value} onChange={() => setPrevious(p.value)} /> {p.label}</label>
                  ))}
                </fieldset>
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-1" checked={concerns} onChange={(e) => setConcerns(e.target.checked)} />
                  <span>This concerns the site manager or safety officer who would normally review it. <span className="block text-xs text-muted-foreground">It will go to company administrators only. If it concerns a company administrator, MineGuard has no higher route: use your company procedure or the legal channels open to you.</span></span>
                </label>
              </section>

              <section className="space-y-1 border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                <p className="flex items-center gap-1 font-medium text-foreground"><ShieldCheck className="size-4" /> Before you send</p>
                <p>{ROUTING_NOTICE}</p>
                <p>{RETALIATION_NOTICE}</p>
              </section>

              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
              <Button type="submit" disabled={busy}>{busy ? "Sending…" : `Send ${MODE_INFO[mode].title.toLowerCase()}`}</Button>
            </>
          )}
        </form>
      ))}

      {queue.length > 0 && (
        <section className="space-y-2 border border-border p-3" aria-label="Reports waiting on this device">
          <h2 className="text-sm font-medium">Waiting on this device</h2>
          <ul className="space-y-2">
            {queue.map((q) => (
              <li key={q.id} className="space-y-1 text-sm">
                <p><span className="font-medium">{MODE_INFO[q.mode].title}</span> · saved {new Date(q.savedAt).toLocaleString()}</p>
                <p className="text-muted-foreground">{describeItem(q)}</p>
                <div className="flex gap-2">
                  {q.state !== "needs_attention" && <Button size="sm" variant="outline" onClick={() => { void flush(); }}>Try to send now</Button>}
                  <Button size="sm" variant="ghost" onClick={() => { void removeFromQueue(q.id).then(() => setTick((t) => t + 1)); }}>Delete from this device</Button>
                </div>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">Until a report is sent, its text is stored on this phone. Delete it here if you do not want it kept.</p>
        </section>
      )}

      {member && mine.length > 0 && (
        <section className="space-y-2 border border-border p-3" aria-label="Your named and confidential reports">
          <h2 className="text-sm font-medium">Your named and confidential reports</h2>
          <ul className="space-y-2 text-sm">
            {mine.map((r) => (
              <li key={r.id}>
                <span className="font-medium">{r.stage}</span> · {r.mode} · received {r.received_on}
                {r.reporter_update && <span className="block text-muted-foreground">Update{r.reporter_update_on ? ` (${r.reporter_update_on})` : ""}: {r.reporter_update}</span>}
                {r.mode === "confidential" && <span className="block text-xs text-muted-foreground">Your identity has been opened {r.identity_opened} time{r.identity_opened === 1 ? "" : "s"}.</span>}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">Anonymous reports are not listed here, because nothing links them to you. Use your follow-up code.</p>
        </section>
      )}
    </div>
  );

  return member ? body : (<><PublicHeader width="2xl"><Link className="text-sm underline" to="/voice/status">Check a report</Link></PublicHeader>{body}</>);
}

export default function VoiceReport() { return <VoiceReportForm context="member" />; }
