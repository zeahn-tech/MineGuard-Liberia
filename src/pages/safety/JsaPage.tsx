// ---------------------------------------------------------------------------
// JOB SAFETY ANALYSIS — prepare, submit, and review. AI may DRAFT prompts (hazards,
// consequences, controls, questions); a person decides what to keep, and a DIFFERENT
// authorised person must approve before the JSA counts as reviewed. Approval authorises
// nothing by itself. All authority is enforced by the database (migration 0043).
// ---------------------------------------------------------------------------
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { askAiAssistant, type AiAssistResponse } from "@/lib/ai-assist";
import { AiFooter, AiHeader, KindBadge, aiFailure } from "@/components/AiOutputNotice";
import { canReview, explainJsaError, jsaSites, listJsas, newKey, RISK_LEVELS, reviewJsa, saveJsa, submitJsa, type Jsa, type JsaHazard, type JsaSite } from "@/lib/jsa";
import { EmptyState } from "@/components/EmptyState";
import { PageLoading } from "@/components/PageLoading";
import { PPE } from "@/data/safety-reference";

interface Suggestion { id: string; hazard: string; consequences: string[]; controls: string[]; ppe: { id: string; name: string }[]; questions: string[] }
interface SuggestionData { suggestions: Suggestion[]; generalQuestions: string[] }

const STATUS_LABEL = { draft: "Draft", submitted: "Awaiting review", approved: "Reviewed and approved", rejected: "Returned for changes" } as const;
const blankHazard = (): JsaHazard => ({ hazard: "", risk_level: "medium", control: "", source: "person" });

function Editor({ sites, existing, onDone }: { sites: JsaSite[]; existing?: Jsa; onDone: () => void }) {
  const keyRef = useRef(newKey());
  const [siteId, setSiteId] = useState(existing?.site_id ?? sites[0]?.id ?? "");
  const [task, setTask] = useState(existing?.task_description ?? "");
  const [location, setLocation] = useState(existing?.location_area ?? "");
  const [jobDate, setJobDate] = useState(existing?.job_date ?? new Date().toISOString().slice(0, 10));
  const [hazards, setHazards] = useState<JsaHazard[]>(existing?.hazards?.length ? existing.hazards : [blankHazard()]);
  const [ppe, setPpe] = useState<string[]>(existing?.ppe ?? []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ai, setAi] = useState<AiAssistResponse<SuggestionData> | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState<string | null>(null);

  const patch = (i: number, p: Partial<JsaHazard>) => setHazards((hs) => hs.map((h, j) => (j === i ? { ...h, ...p } : h)));
  const suggest = async () => {
    setAiBusy(true); setAiErr(null); setAi(null);
    try { setAi(await askAiAssistant<SuggestionData>({ capability: "jsa_suggestions", task: task.trim(), ...(location.trim() ? { location: location.trim() } : {}) })); }
    catch (e) { setAiErr(aiFailure(e)); }
    finally { setAiBusy(false); }
  };
  const addSuggestion = (s: Suggestion) => {
    setHazards((hs) => [...hs.filter((h) => h.hazard.trim() || h.control.trim()), { hazard: s.hazard, consequence: s.consequences.join("; "), risk_level: "medium", control: s.controls.join("; "), source: "ai_suggested" }]);
    setPpe((p) => [...new Set([...p, ...s.ppe.map((x) => x.id)])]);
  };
  const save = async (andSubmit: boolean) => {
    setBusy(true); setErr(null);
    try {
      const clean = hazards.filter((h) => h.hazard.trim() || h.control.trim()).map((h) => ({ ...h, hazard: h.hazard.trim(), control: h.control.trim(), consequence: h.consequence?.trim() || undefined }));
      const id = await saveJsa({ siteId, task: task.trim(), location: location.trim(), jobDate, hazards: clean, ppe }, keyRef.current, existing?.id);
      if (andSubmit) await submitJsa(id);
      onDone();
    } catch (e) { setErr(explainJsaError(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-4 border border-border p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1"><Label htmlFor="jsa-site">Site</Label>
          <select id="jsa-site" className="h-9 w-full border border-input bg-background px-2 text-sm" value={siteId} onChange={(e) => setSiteId(e.target.value)} disabled={!!existing}>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.code})</option>)}
          </select></div>
        <div className="space-y-1"><Label htmlFor="jsa-date">Date</Label><Input id="jsa-date" type="date" value={jobDate} onChange={(e) => setJobDate(e.target.value)} /></div>
        <div className="space-y-1 sm:col-span-2"><Label htmlFor="jsa-task">Job / task description</Label><Textarea id="jsa-task" value={task} maxLength={500} onChange={(e) => setTask(e.target.value)} placeholder="Describe the task and its steps" /></div>
        <div className="space-y-1 sm:col-span-2"><Label htmlFor="jsa-loc">Location / area</Label><Input id="jsa-loc" value={location} maxLength={120} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Pit 3 - Bench 12" /></div>
      </div>

      <section className="space-y-2 border border-dashed border-primary/40 bg-primary/5 p-3" aria-label="AI-assisted hazard prompts">
        <AiHeader note="Draft prompts to think with. They are general and can miss hazards; nothing is added unless you choose it." />
        <Button size="sm" variant="outline" disabled={aiBusy || task.trim().length < 10} onClick={suggest}>{aiBusy ? <Loader2 className="size-4 animate-spin" /> : "Suggest hazards and controls"}</Button>
        {aiErr && <p role="alert" className="text-sm">{aiErr}</p>}
        {ai && (ai.abstained ? <p className="text-sm">{ai.abstainReason}</p> : (
          <div className="space-y-3">
            <ul className="space-y-3">
              {ai.data?.suggestions.map((s) => (
                <li key={s.id} className="space-y-1 border border-border bg-background p-3 text-sm">
                  <KindBadge kind="needs_verification" />
                  <p className="font-medium">{s.hazard}</p>
                  <p><span className="text-muted-foreground">Possible consequences: </span>{s.consequences.join("; ")}</p>
                  <p><span className="text-muted-foreground">Controls to consider: </span>{s.controls.join("; ")}</p>
                  <p><span className="text-muted-foreground">Questions for further assessment: </span>{s.questions.join(" ")}</p>
                  <Button size="sm" variant="outline" onClick={() => addSuggestion(s)}><Plus className="size-4" /> Add to this JSA as AI-suggested</Button>
                </li>
              ))}
            </ul>
            <div className="text-sm"><p className="font-medium">Questions to ask for every task</p><ul className="list-disc pl-5 text-muted-foreground">{ai.data?.generalQuestions.map((q, i) => <li key={i}>{q}</li>)}</ul></div>
          </div>
        ))}
        {ai && <AiFooter res={ai} />}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">Hazard identification</h3>
        {hazards.map((h, i) => (
          <div key={i} className="space-y-2 border border-border p-3">
            {h.source === "ai_suggested" && <span className="inline-block rounded-full border border-primary/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">AI-suggested — edit and verify</span>}
            <Input aria-label="Hazard identified" value={h.hazard} maxLength={200} onChange={(e) => patch(i, { hazard: e.target.value })} placeholder="Hazard identified" />
            <Textarea aria-label="Possible consequences" value={h.consequence ?? ""} maxLength={400} onChange={(e) => patch(i, { consequence: e.target.value })} placeholder="Possible consequences" />
            <select aria-label="Risk level" className="h-9 w-full border border-input bg-background px-2 text-sm" value={h.risk_level} onChange={(e) => patch(i, { risk_level: e.target.value as JsaHazard["risk_level"] })}>
              {RISK_LEVELS.map((r) => <option key={r} value={r}>{r[0].toUpperCase() + r.slice(1)}</option>)}
            </select>
            <Textarea aria-label="Control measure" value={h.control} maxLength={600} onChange={(e) => patch(i, { control: e.target.value })} placeholder="Control measure" />
            <Button size="sm" variant="ghost" onClick={() => setHazards((hs) => hs.filter((_, j) => j !== i))}><Trash2 className="size-4" /> Remove</Button>
          </div>
        ))}
        <Button size="sm" variant="outline" disabled={hazards.length >= 20} onClick={() => setHazards((hs) => [...hs, blankHazard()])}><Plus className="size-4" /> Add hazard</Button>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">PPE required for this task</h3>
        <div className="flex flex-wrap gap-2">
          {PPE.map((p) => (
            <Button key={p.id} size="sm" variant={ppe.includes(p.id) ? "default" : "outline"} aria-pressed={ppe.includes(p.id)} onClick={() => setPpe((x) => (x.includes(p.id) ? x.filter((y) => y !== p.id) : [...x, p.id]))}>
              <span aria-hidden="true">{p.emoji} </span>{p.name}
            </Button>
          ))}
        </div>
      </section>

      {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
      <p className="text-xs text-muted-foreground">Submitting sends this JSA to a different qualified person for review. It is not approved, and the task is not authorised, until they approve it.</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy || task.trim().length < 10 || !siteId} onClick={() => save(false)}>Save draft</Button>
        <Button disabled={busy || task.trim().length < 10 || !siteId} onClick={() => save(true)}>Submit for review</Button>
        <Button variant="ghost" disabled={busy} onClick={onDone}>Cancel</Button>
      </div>
    </div>
  );
}

function ReviewBox({ jsa, onDone }: { jsa: Jsa; onDone: () => void }) {
  const [word, setWord] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const act = async (d: "approve" | "reject") => {
    setBusy(true); setErr(null);
    try { await reviewJsa(jsa.id, d, d === "approve" ? "APPROVE" : "REJECT", note); onDone(); }
    catch (e) { setErr(explainJsaError(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className="space-y-2 border border-primary/40 p-3">
      <p className="text-sm font-medium">Review this JSA</p>
      {jsa.ai_assisted && <p className="text-xs text-muted-foreground">Some hazards or controls were suggested by AI. Check each against the real task.</p>}
      <Textarea aria-label="Review note" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} placeholder="Note (required when returning for changes)" />
      <Input aria-label="Type APPROVE to confirm" value={word} onChange={(e) => setWord(e.target.value)} placeholder="Type APPROVE to confirm you reviewed it" />
      {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
      <div className="flex gap-2">
        <Button disabled={busy || word !== "APPROVE"} onClick={() => act("approve")}>Approve</Button>
        <Button variant="outline" disabled={busy || !note.trim()} onClick={() => act("reject")}>Return for changes</Button>
      </div>
      <p className="text-xs text-muted-foreground">Approval records that you reviewed the analysis. It does not by itself authorise the task.</p>
    </div>
  );
}

export default function JsaPage() {
  const [items, setItems] = useState<Jsa[] | null>(null);
  const [sites, setSites] = useState<JsaSite[] | null>(null);
  const [sitesFailed, setSitesFailed] = useState(false);
  const isCompany = useLocation().pathname.startsWith("/operate");
  const [mode, setMode] = useState<"list" | "new" | { edit: Jsa }>("list");
  const [reviewable, setReviewable] = useState<Set<string>>(new Set());
  const [me, setMe] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    void (async () => {
      let sitesFailed = false;
      const [list, s] = await Promise.all([
        listJsas(),
        jsaSites().catch(() => { sitesFailed = true; return [] as JsaSite[]; }),
      ]);
      const { supabase } = await import("@/lib/supabase");
      const { data } = await supabase.auth.getUser();
      const submittedSites = [...new Set(list.filter((j) => j.status === "submitted").map((j) => j.site_id))];
      const ok = await Promise.all(submittedSites.map(async (id) => ((await canReview(id)) ? id : null)));
      return { list, s, sitesFailed, uid: data.user?.id ?? null, ok: new Set(ok.filter((x): x is string => !!x)) };
    })().then((r) => {
      if (!live) return;
      setMe(r.uid); setItems(r.list); setSites(r.s); setSitesFailed(r.sitesFailed); setReviewable(r.ok);
    }, () => { if (live) setLoadErr("JSAs could not be loaded. Nothing has been changed."); });
    return () => { live = false; };
  }, [tick]);

  const done = () => { setMode("list"); setTick((t) => t + 1); };
  if (loadErr) return <p role="alert" className="p-4 text-sm">{loadErr}</p>;
  if (!items || !sites) return <PageLoading shape="list" label="job safety analyses" />;

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Job Safety Analysis</h1>
        <p className="text-sm text-muted-foreground">Complete a JSA before starting any high-risk task. A different qualified person must review it. AI can suggest prompts but can never approve anything.</p>
      </header>
      {mode === "list" && sites.length > 0 && <Button onClick={() => setMode("new")}><Plus className="size-4" /> New JSA</Button>}
      {/* Never hide the way to start a JSA without saying why: company members always see the button, and when
          it cannot be used the reason is on screen (sites failed to load, or no site is assigned to them). */}
      {mode === "list" && sites.length === 0 && isCompany && (
        <div className="space-y-2 border border-border p-3">
          <Button disabled aria-describedby="jsa-no-sites"><Plus className="size-4" /> New JSA</Button>
          <p id="jsa-no-sites" role={sitesFailed ? "alert" : "status"} className="text-sm text-muted-foreground">
            {sitesFailed
              ? "Your sites could not be loaded, so a new JSA cannot be started right now. Nothing has been changed."
              : "A JSA is prepared for a site your company has registered and you are assigned to. None is available to you yet — ask your site manager or company administrator to assign you to a site."}
          </p>
          {sitesFailed && <Button size="sm" variant="outline" onClick={() => setTick((t) => t + 1)}>Try again</Button>}
        </div>
      )}
      {mode === "new" && <Editor sites={sites} onDone={done} />}
      {typeof mode === "object" && mode !== null && "edit" in mode && <Editor sites={sites} existing={mode.edit} onDone={done} />}
      {mode === "list" && (items.length === 0 ? <EmptyState title="No job safety analyses" why="Prepared JSAs, and any waiting for your review, will be listed here." /> : (
        <ul className="space-y-3">
          {items.map((j) => (
            <li key={j.id} className="space-y-2 border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded border border-border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide">{STATUS_LABEL[j.status]}</span>
                {j.ai_assisted && <span className="rounded-full border border-primary/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">AI-assisted</span>}
                <span className="text-xs text-muted-foreground">{j.job_date}{j.location_area ? ` · ${j.location_area}` : ""}</span>
              </div>
              <p className="text-sm font-medium">{j.task_description}</p>
              <ul className="space-y-1 text-sm">
                {j.hazards.map((h, i) => (
                  <li key={i}><span className="font-medium">{h.hazard}</span> <span className="text-xs uppercase text-muted-foreground">({h.risk_level})</span>{h.source === "ai_suggested" ? <span className="text-xs text-primary"> · AI-suggested</span> : null}<br /><span className="text-muted-foreground">Control: {h.control}</span></li>
                ))}
              </ul>
              {j.ppe.length > 0 && <p className="text-xs text-muted-foreground">PPE: {j.ppe.map((id) => PPE.find((p) => p.id === id)?.name ?? id).join(", ")}</p>}
              {j.review_note && <p className="text-xs"><span className="font-medium">Reviewer note:</span> {j.review_note}</p>}
              {j.status === "approved" && <p className="text-xs text-muted-foreground">Reviewed {j.reviewed_at ? new Date(j.reviewed_at).toLocaleString() : ""} by a different authorised person.</p>}
              {(j.status === "draft" || j.status === "rejected") && j.prepared_by === me && <Button size="sm" variant="outline" onClick={() => setMode({ edit: j })}>Edit</Button>}
              {j.status === "submitted" && j.prepared_by !== me && reviewable.has(j.site_id) && <ReviewBox jsa={j} onDone={done} />}
              {j.status === "submitted" && j.prepared_by === me && <p className="text-xs text-muted-foreground">Waiting for a different authorised person to review.</p>}
            </li>
          ))}
        </ul>
      ))}
    </div>
  );
}
