import { useQuery } from "@/lib/backend-react";
import { api } from "@/lib/backend";
import { PublicShell } from "@/components/PublicShell";
import { ContentText } from "@/components/ContentText";
import { PageLoading } from "@/components/PageLoading";
import { EmptyState } from "@/components/EmptyState";
import { Badge } from "@/components/ui/badge";
import { ShieldCheck } from "lucide-react";

export default function PublicSafety() {
  const items = useQuery(api.publicContent.list, "safety_guidance");
  return (
    <PublicShell kicker="Stay safe" title="Safety information" intro="General safety guidance published by the Ministry. In an emergency, contact local emergency services first.">
      {items === undefined ? (
        <PageLoading label="safety information" />
      ) : items.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="No safety guidance has been published yet"
          why="Guidance appears here only after Ministry review and approval."
        />
      ) : (
        <div className="space-y-4">
          {items.map((g) => (
            <article key={g.id} className="paper space-y-2 p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-medium">{g.title}</h2>
                {g.category && <Badge variant="outline">{g.category}</Badge>}
              </div>
              {g.summary && <p className="text-sm text-muted-foreground">{g.summary}</p>}
              <ContentText text={g.body} />
            </article>
          ))}
        </div>
      )}
    </PublicShell>
  );
}
