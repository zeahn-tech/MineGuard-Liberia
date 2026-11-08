// ---------------------------------------------------------------------------
// SAFETY GUIDANCE — ask the assistant, browse the glossary, PPE guide, and emergency /
// first-aid reference. The reference tabs read the bundled reviewed content directly (no
// network, works offline once loaded). The assistant retrieves from the SAME content on the
// server and labels each statement's provenance. It never declares anything safe, replaces
// site emergency procedures, or decides for anyone.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { PageLoading } from "@/components/PageLoading";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { askAiAssistant, type AiAssistResponse } from "@/lib/ai-assist";
import { AiFooter, AiHeader, KindBadge, aiFailure } from "@/components/AiOutputNotice";
import { FIRST_AID, GLOSSARY, IMMEDIATE_ACTIONS, PPE, REVIEW } from "@/data/safety-reference";
import { contactScopes, explainContactError, listEmergencyContacts, PHONE_PATTERN, removeEmergencyContact, saveEmergencyContact, type ContactScope, type EmergencyContact } from "@/lib/emergencyContacts";

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
          {(res.data as { contacts?: { id: string; name: string; phone: string; label: string | null }[] } | null)?.contacts?.length ? (
            <div className="space-y-1 border border-border p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Emergency contacts set up by your company</p>
              <ul className="space-y-1">
                {(res.data as { contacts: { id: string; name: string; phone: string; label: string | null }[] }).contacts.map((c) => (
                  <li key={c.id} className="flex justify-between gap-2 text-sm"><span>{c.name}{c.label ? ` — ${c.label}` : ""}</span><a className="font-medium underline underline-offset-4" href={`tel:${c.phone.replace(/[^+\d]/g, "")}`}>{c.phone}</a></li>
                ))}
              </ul>
            </div>
          ) : null}
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

function EmergencyContacts() {
  const [rows, setRows] = useState<EmergencyContact[] | null>(null);
  const [scopes, setScopes] = useState<ContactScope[]>([]);
  const [loadErr, setLoadErr] = useState(false);
  const [tick, setTick] = useState(0);
  const [form, setForm] = useState<{ id?: string; scope: string; name: string; phone: string; label: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void Promise.all([listEmergencyContacts(), contactScopes().catch(() => [] as ContactScope[])]).then(
      ([r, sc]) => { if (live) { setRows(r); setScopes(sc); } },
      () => { if (live) setLoadErr(true); },
    );
    return () => { live = false; };
  }, [tick]);

  const scopeKey = (sc: { organization_id: string; site_id: string | null }) => `${sc.organization_id}|${sc.site_id ?? ""}`;
  const scopeName = (c: EmergencyContact) => scopes.find((x) => x.organization_id === c.organization_id && x.site_id === c.site_id);
  const canManage = (c: EmergencyContact) => !!scopeName(c);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    const sc = scopes.find((x) => scopeKey(x) === form.scope);
    if (!sc) return;
    if (!PHONE_PATTERN.test(form.phone.trim())) { setErr("Enter a valid phone number (digits, spaces, + ( ) -)."); return; }
    setBusy(true); setErr(null);
    try {
      await saveEmergencyContact({ organizationId: sc.organization_id, siteId: sc.site_id, name: form.name.trim(), phone: form.phone.trim(), roleLabel: form.label.trim() }, form.id);
      setForm(null); setTick((t) => t + 1);
    } catch (e2) { setErr(explainContactError(e2)); }
    finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    setBusy(true); setErr(null);
    try { await removeEmergencyContact(id); setTick((t) => t + 1); }
    catch (e2) { setErr(explainContactError(e2)); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Emergency contacts</h3>
      {loadErr && <p role="alert" className="text-sm">Contacts could not be loaded. Use your site&apos;s own emergency numbers.</p>}
      {!loadErr && rows === null && <PageLoading shape="list" label="emergency contacts" rows={2} compact />}
      {rows && rows.length === 0 && (
        <EmptyState title="No emergency contacts added" why="Ask your company administrator or site manager to add them. Until then, use your site's own emergency numbers." />
      )}
      {rows && rows.length > 0 && (
        <ul className="space-y-2">
          {rows.map((c) => (
            <li key={c.id} className={`flex flex-wrap items-center justify-between gap-2 border border-border p-3 text-sm ${c.active ? "" : "opacity-60"}`}>
              <span>
                <span className="font-medium">{c.name}</span>{c.role_label ? ` — ${c.role_label}` : ""}
                <span className="block text-xs text-muted-foreground">{scopeName(c)?.site_name ?? (c.site_id ? "Site contact" : "Company-wide")}{c.active ? "" : " · removed"}</span>
              </span>
              <span className="flex items-center gap-2">
                <a className="font-medium underline underline-offset-4" href={`tel:${c.phone.replace(/[^+\d]/g, "")}`}>{c.phone}</a>
                {canManage(c) && c.active && (
                  <>
                    <Button size="sm" variant="outline" onClick={() => setForm({ id: c.id, scope: `${c.organization_id}|${c.site_id ?? ""}`, name: c.name, phone: c.phone, label: c.role_label ?? "" })}>Edit</Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => remove(c.id)}>Remove</Button>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">Maintained by your company. Confirm they are current.</p>
      {scopes.length > 0 && !form && <Button size="sm" variant="outline" onClick={() => setForm({ scope: scopeKey(scopes[0]), name: "", phone: "", label: "" })}>Add emergency contact</Button>}
      {form && (
        <form onSubmit={submit} className="space-y-2 border border-border p-3">
          <select aria-label="Applies to" className="h-9 w-full border border-input bg-background px-2 text-sm" value={form.scope} disabled={!!form.id} onChange={(e) => setForm({ ...form, scope: e.target.value })}>
            {scopes.map((sc) => <option key={scopeKey(sc)} value={scopeKey(sc)}>{sc.site_name ? `Site: ${sc.site_name}` : `Whole company: ${sc.organization_name}`}</option>)}
          </select>
          <Input aria-label="Contact name" value={form.name} maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Name" required />
          <Input aria-label="Phone number" value={form.phone} maxLength={24} inputMode="tel" onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="Phone number" required />
          <Input aria-label="Role or note" value={form.label} maxLength={60} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Role (e.g. Site medic, Ambulance)" />
          {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
          <div className="flex gap-2"><Button type="submit" disabled={busy || !form.name.trim() || !form.phone.trim()}>Save contact</Button><Button type="button" variant="ghost" onClick={() => { setForm(null); setErr(null); }}>Cancel</Button></div>
        </form>
      )}
      {!form && err && <p role="alert" className="text-sm text-destructive">{err}</p>}
    </div>
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
      <EmergencyContacts />
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
