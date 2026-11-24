import { useMemo, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { GLOSSARY } from "@/data/safety-reference";

/** The mining glossary (search, A–Z filter, tap-to-expand). Shared by Safety Guidance and the
 *  public Glossary page so both always show exactly the same content and layout. */
export function GlossaryBrowser() {
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
