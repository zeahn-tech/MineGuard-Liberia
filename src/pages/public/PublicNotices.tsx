import { useQuery } from "@/lib/backend-react";
import { api } from "@/lib/backend";
import { PublicShell } from "@/components/PublicShell";
import { ContentText } from "@/components/ContentText";
import { PageLoading } from "@/components/PageLoading";
import { EmptyState } from "@/components/EmptyState";
import { Megaphone } from "lucide-react";

const fmt = (ms?: number) => (ms ? new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : "");

export default function PublicNotices() {
  const notices = useQuery(api.publicContent.list, "announcement");
  const sorted = [...(notices ?? [])].sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
  return (
    <PublicShell kicker="From the Ministry" title="Public notices" intro="Announcements approved for public release, newest first.">
      {notices === undefined ? (
        <PageLoading label="notices" />
      ) : sorted.length === 0 ? (
        <EmptyState icon={Megaphone} title="No notices have been published yet" why="Announcements appear here after Ministry review and approval." />
      ) : (
        <div className="space-y-4">
          {sorted.map((n) => (
            <article key={n.id} className="paper space-y-2 p-5">
              <p className="kicker">{fmt(n.publishedAt)}</p>
              <h2 className="font-medium">{n.title}</h2>
              <ContentText text={n.body} />
            </article>
          ))}
        </div>
      )}
    </PublicShell>
  );
}
