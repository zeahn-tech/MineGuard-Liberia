// ---------------------------------------------------------------------------
// SAFETY GUIDANCE — ask the assistant, browse the glossary, PPE guide, and emergency /
// first-aid reference. The reference tabs read the bundled reviewed content directly (no
// network, works offline once loaded). The assistant retrieves from the SAME content on the
// server and labels each statement's provenance. It never declares anything safe, replaces
// site emergency procedures, or decides for anyone.
// ---------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { askAiAssistant, type AiAssistResponse } from "@/lib/ai-assist";
import { AiFooter, AiHeader, KindBadge, aiFailure } from "@/components/AiOutputNotice";
import { EMERGENCY_CONTACTS, FIRST_AID, GLOSSARY, IMMEDIATE_ACTIONS, PPE, REVIEW } from "@/data/safety-reference";

function ReviewNotice() {
  return REVIEW.approvedBy ? (
    <p className="text-xs text-muted-foreground">Reference content signed off by {REVIEW.approvedBy}{REVIEW.approvedOn ? ` on ${REVIEW.approvedOn}` : ""}.</p>
  ) : (
    <p className="text-xs text-muted-foreground">This reference content has not yet been signed off by a named qualified safety professional. Treat it as a general aid and verify it with your safety officer.</p>
  );
}

function Ask() {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<AiAssistResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!q.trim()) return;
    setBusy(true); setErr(null); setRes(null);
    try { setRes(await askAiAssistant({ capability: "safety_guidance", query: q.trim() })); }
    catch (e2) { setErr(aiFailure(e2)); }
    finally { setBusy(false); }
  };
  return (
    <section className="space-y-3" aria-label="Safety guidance assistant">
      <AiHeader note="Answers are taken from the reference content below. Each statement says how far it can be relied on." />
      <form onSubmit={run} className="flex gap-2">
        <Input value={q} maxLength={300} onChange={(e) => setQ(e.target.value)} placeholder="e.g. what is an adit? when is a harness needed?" aria-label="Ask a safety question" />
        <Button type="submit" disabled={busy || !q.trim()}>Ask</Button>
      </form>
      {busy && <p role="status" className="text-sm text-muted-foreground">Looking through the reference content…</p>}
      {err && <p role="alert" className="text-sm">{err}</p>}
      {res && (
        <div className="space-y-3">
          {res.abstained ? <p className="text-sm">{res.abstainReason}</p> : (
            <ul className="space-y-3">
              {res.claims.map((c, i) => (
                <li key={i} className="space-y-1 border border-border p-3">
                  <KindBadge kind={c.kind} />
                  <p className="text-sm">{c.text}</p>
                </li>
              ))}
            </ul>
          )}
          <AiFooter res={res} />
        </div>
      )}
      <p className="text-xs text-muted-foreground">In an emergency, follow your site&apos;s approved emergency procedure. This assistant does not raise alarms, call anyone, or say whether anywhere is safe.</p>
    </section>
  );
}

function Glossary() {
  const [filter, setFilter] = useState("");
  const [letter, setLetter] = useState("ALL");
  const [open, setOpen] = useState<string | null>(null);
  const letters = useMemo(() => [...new Set(GLOSSARY.map((g) => g.term[0].toUpperCase()))].sort(), []);
  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return GLOSSARY.filter((g) => (letter === "ALL" || g.term[0].toUpperCase() === letter) && (!f || `${g.term} ${g.short} ${g.definition}`.toLowerCase().includes(f)));
  }, [filter, letter]);
  return (
    <section className="space-y-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-9" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search terms…" aria-label="Search glossary" />
      </div>
      <div className="flex gap-1 overflow-x-auto pb-1" role="group" aria-label="Filter by letter">
        {["ALL", ...letters].map((l) => (
          <Button key={l} size="sm" variant={letter === l ? "default" : "outline"} onClick={() => setLetter(l)} aria-pressed={letter === l}>{l}</Button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">Tap any term to expand its definition. {rows.length} of {GLOSSARY.length} terms.</p>
      <ul className="space-y-2">
        {rows.map((g) => (
          <li key={g.id} className="border border-border">
            <button type="button" className="flex w-full items-center justify-between gap-3 p-3 text-left" aria-expanded={open === g.id} onClick={() => setOpen(open === g.id ? null : g.id)}>
              <span><span className="block text-sm font-medium">{g.term}</span><span className="block text-xs text-muted-foreground">{g.short}</span></span>
              <ChevronDown className={`size-4 shrink-0 transition-transform ${open === g.id ? "rotate-180" : ""}`} />
            </button>
            {open === g.id && (
              <div className="space-y-2 border-t border-border p-3">
                <p className="text-sm">{g.definition}</p>
                <span className="inline-block rounded border border-border px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{g.category}</span>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function PpeGuide() {
  return (
    <section className="space-y-3">
      <p className="text-sm text-muted-foreground">Personal Protective Equipment — know what to wear and why.</p>
      <ul className="space-y-3">
        {PPE.map((p) => (
          <li key={p.id} className="flex gap-3 border border-border p-3">
            <span className="text-3xl" aria-hidden="true">{p.emoji}</span>
            <div className="space-y-1">
              <h3 className="text-sm font-medium">{p.name}</h3>
              <p className="text-sm text-muted-foreground">{p.description}</p>
              <p className="text-xs font-medium">{p.when}</p>
              <span className={`inline-block rounded border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${p.mandatory === "always" ? "border-destructive/60 text-destructive" : "border-border text-muted-foreground"}`}>
                {p.mandatory === "always" ? "Always required" : "Task-specific"}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function EmergencyReference() {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="space-y-4">
      <p className="border border-destructive/50 bg-destructive/5 p-3 text-sm">
        Reference only. It does not raise an alarm or call anyone. In an emergency follow your site&apos;s approved emergency procedure and use your site&apos;s emergency number.
      </p>
      <div className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Immediate actions</h3>
        <ol className="space-y-2">
          {IMMEDIATE_ACTIONS.map((a) => (
            <li key={a.id} className="flex gap-3 border border-border p-3 text-sm"><span className="font-semibold text-destructive">{a.order}</span><span>{a.text}</span></li>
          ))}
        </ol>
      </div>
      <div className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Contacts listed in the app</h3>
        <ul className="space-y-2">
          {EMERGENCY_CONTACTS.map((c) => (
            <li key={c.id} className="flex items-center justify-between border border-border p-3 text-sm">
              <span>{c.name}</span>
              <a className="font-medium underline underline-offset-4" href={`tel:${c.number.replace(/[^+\d]/g, "")}`}>{c.number}</a>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">Check that these match your site&apos;s own emergency contacts.</p>
      </div>
      <div className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">First aid quick guide</h3>
        <ul className="space-y-2">
          {FIRST_AID.map((f) => (
            <li key={f.id} className="border border-border">
              <button type="button" className="flex w-full items-center justify-between p-3 text-left text-sm font-medium" aria-expanded={open === f.id} onClick={() => setOpen(open === f.id ? null : f.id)}>
                <span><span aria-hidden="true">{f.emoji} </span>{f.title}</span>
                <ChevronDown className={`size-4 transition-transform ${open === f.id ? "rotate-180" : ""}`} />
              </button>
              {open === f.id && <ol className="list-decimal space-y-1 border-t border-border p-3 pl-8 text-sm">{f.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>}
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">A summary for awareness. It does not replace first-aid training; call for medical help.</p>
      </div>
    </section>
  );
}

export default function SafetyGuidance() {
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Safety Guidance</h1>
        <p className="text-sm text-muted-foreground">Glossary, PPE, emergency and first-aid reference, with an assistant to help you find your way.</p>
        <ReviewNotice />
      </header>
      <Tabs defaultValue="ask">
        <TabsList className="flex-wrap">
          <TabsTrigger value="ask">Ask</TabsTrigger>
          <TabsTrigger value="glossary">Glossary</TabsTrigger>
          <TabsTrigger value="ppe">PPE</TabsTrigger>
          <TabsTrigger value="emergency">Emergency</TabsTrigger>
        </TabsList>
        <TabsContent value="ask"><Ask /></TabsContent>
        <TabsContent value="glossary"><Glossary /></TabsContent>
        <TabsContent value="ppe"><PpeGuide /></TabsContent>
        <TabsContent value="emergency"><EmergencyReference /></TabsContent>
      </Tabs>
    </div>
  );
}
