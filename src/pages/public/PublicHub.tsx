import { Link } from "react-router";
import { useQuery } from "@/lib/backend-react";
import { api } from "@/lib/backend";
import { PublicShell } from "@/components/PublicShell";
import { ApprovedStatistics } from "@/components/ApprovedStatistics";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Megaphone } from "lucide-react";

const fmt = (ms?: number) => (ms ? new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "");

export default function PublicHub() {
  const notices = useQuery(api.publicContent.list, "announcement");
  const latest = (notices ?? []).sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0)).slice(0, 3);
  return (
    <PublicShell
      kicker="For everyone"
      title="Mining safety information"
      intro="Approved safety guidance, a glossary of mining terms, and public notices from the Ministry. You can read all of this without an account."
    >
      <div className="space-y-10">
        <section aria-labelledby="hub-notices">
          <h2 id="hub-notices" className="display text-xl">Latest notices</h2>
          <div className="mt-3 space-y-3">
            {notices === undefined ? null : latest.length === 0 ? (
              <EmptyState icon={Megaphone} title="No notices published" why="Announcements appear here after Ministry review and approval." />
            ) : (
              latest.map((n) => (
                <Link key={n.id} to="/public/notices" className="paper block p-4 hover:bg-muted/30">
                  <span className="text-sm font-medium">{n.title}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">{fmt(n.publishedAt)}</span>
                  {n.summary && <span className="mt-1 block text-sm text-muted-foreground">{n.summary}</span>}
                </Link>
              ))
            )}
          </div>
        </section>

        <section aria-labelledby="hub-stats" className="border-y border-border">
          <h2 id="hub-stats" className="sr-only">Approved statistics</h2>
          <ApprovedStatistics />
        </section>

        <section className="grid gap-3 sm:grid-cols-2">
          <Link to="/public/safety" className="paper block p-5 hover:bg-muted/30">
            <span className="font-medium">Safety information</span>
            <span className="mt-1 block text-sm text-muted-foreground">Guidance on staying safe around mining activity.</span>
          </Link>
          <Link to="/public/glossary" className="paper block p-5 hover:bg-muted/30">
            <span className="font-medium">Mining glossary</span>
            <span className="mt-1 block text-sm text-muted-foreground">Search and browse mining terms.</span>
          </Link>
        </section>

        <section className="paper space-y-3 p-5">
          <h2 className="display text-xl">See something unsafe?</h2>
          <p className="text-sm text-muted-foreground">
            Report a dangerous activity, an accident, an environmental concern or unsafe working
            conditions. Your report goes to authorized Ministry staff for review.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button asChild><Link to="/report">Report a concern</Link></Button>
            <Button asChild variant="outline"><Link to="/report/track">Track a report</Link></Button>
          </div>
        </section>
      </div>
    </PublicShell>
  );
}
