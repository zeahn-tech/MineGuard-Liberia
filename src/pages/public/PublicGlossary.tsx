import { useMemo, useState } from "react";
import { useQuery } from "@/lib/backend-react";
import { api } from "@/lib/backend";
import { PublicShell } from "@/components/PublicShell";
import { ContentText } from "@/components/ContentText";
import { PageLoading } from "@/components/PageLoading";
import { EmptyState } from "@/components/EmptyState";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BookOpen, Search } from "lucide-react";

/** Only terms the Ministry has reviewed and published appear here. English only: no translation is
 *  offered until reviewed translations exist. */
export default function PublicGlossary() {
  const terms = useQuery(api.publicContent.list, "glossary_term");
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string | null>(null);

  const categories = useMemo(() => [...new Set((terms ?? []).map((t) => t.category).filter(Boolean) as string[])].sort(), [terms]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (terms ?? []).filter(
      (t) =>
        (!cat || t.category === cat) &&
        (!needle || t.title.toLowerCase().includes(needle) || t.body.toLowerCase().includes(needle)),
    );
  }, [terms, q, cat]);

  return (
    <PublicShell kicker="Reference" title="Mining glossary" intro="Plain-language definitions of mining terms, reviewed and published by the Ministry.">
      {terms === undefined ? (
        <PageLoading label="the glossary" />
      ) : terms.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title="The glossary has not been published yet"
          why="Terms appear here only after Ministry review and approval. Please check back soon."
        />
      ) : (
        <div className="space-y-5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Search the glossary"
              placeholder="Search terms or definitions"
              className="pl-9"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          {categories.length > 1 && (
            <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by category">
              <Button size="sm" variant={cat === null ? "default" : "outline"} onClick={() => setCat(null)}>All</Button>
              {categories.map((c) => (
                <Button key={c} size="sm" variant={cat === c ? "default" : "outline"} onClick={() => setCat(c)}>
                  {c}
                </Button>
              ))}
            </div>
          )}
          <p className="text-xs text-muted-foreground" aria-live="polite">{shown.length} of {terms.length} terms</p>
          <div className="space-y-3">
            {shown.map((t) => (
              <article key={t.id} className="paper space-y-2 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="font-medium">{t.title}</h2>
                  {t.category && <Badge variant="outline">{t.category}</Badge>}
                </div>
                <ContentText text={t.body} />
              </article>
            ))}
            {shown.length === 0 && <p className="text-sm text-muted-foreground">No terms match your search.</p>}
          </div>
        </div>
      )}
    </PublicShell>
  );
}
