import { Link } from "react-router";
import { useQuery } from "@/lib/backend-react";
import { api } from "@/lib/backend";
import { PublicHeader } from "@/components/PublicHeader";
import { PageLoading } from "@/components/PageLoading";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FileText } from "lucide-react";

// What the person is told about each stage. Same wording as the public tracking page; nothing
// from the reviewer's notes ever reaches this screen (the server does not return it).
const STATUS_COPY: Record<string, string> = {
  submitted: "Received — awaiting triage by authorized personnel.",
  under_review: "Under review — an officer is assessing the report.",
  verified: "Verified — the concern was substantiated during review.",
  dismissed: "Not substantiated — review concluded no further action.",
  referred: "Referred — forwarded to the appropriate authority.",
};

const CATEGORY_LABEL: Record<string, string> = {
  suspected_illegal_mining: "Suspected illegal mining",
  pollution: "Pollution",
  environmental_damage: "Environmental damage",
  safety_concern: "Safety concern",
  land_concern: "Land concern",
  unauthorized_activity: "Unauthorized activity",
  other: "Other mining-related concern",
};

const fmt = (ms: number) => new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

export default function MyReports() {
  const reports = useQuery(api.account.myReports);
  return (
    <div className="min-h-screen bg-background paper-grain">
      <PublicHeader width="3xl">
        <Link to="/report" className="inline-flex min-h-9 shrink-0 items-center text-sm text-muted-foreground hover:text-foreground">
          New report
        </Link>
      </PublicHeader>
      <main className="mx-auto max-w-3xl px-4 py-10 md:px-8">
        <p className="kicker">My account</p>
        <h1 className="display mt-2 text-3xl md:text-4xl">My reports</h1>
        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
          Reports you chose to link to your account. A report is a concern under assessment — it is
          not a finding against anyone. Reports you sent anonymously are not listed here; use their
          tracking code on the tracking page.
        </p>

        <div className="mt-8 space-y-4">
          {reports === undefined ? (
            <PageLoading label="your reports" />
          ) : reports.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="No linked reports yet"
              why="When you report a concern and tick “Link this report to my account”, it appears here with its status."
              action={{ label: "Report a concern", to: "/report" }}
            />
          ) : (
            reports.map((r) => (
              <article key={r.id} className="paper space-y-2 p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Badge variant="outline">{CATEGORY_LABEL[r.category] ?? r.category}</Badge>
                  <span className="text-xs text-muted-foreground">Sent {fmt(r.createdAt)}</span>
                </div>
                <p className="whitespace-pre-wrap break-words text-sm">{r.description}</p>
                <p className="text-xs text-muted-foreground">
                  {[r.community, r.district, r.county].filter(Boolean).join(", ")}
                </p>
                <p className="text-sm font-medium">{STATUS_COPY[r.status] ?? r.status}</p>
                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  <span className="stat-figure text-sm tracking-wide">{r.trackingCode}</span>
                  <Button asChild size="sm" variant="outline">
                    <Link to={`/report/track?code=${r.trackingCode}`}>Public tracking page</Link>
                  </Button>
                </div>
              </article>
            ))
          )}
        </div>
      </main>
    </div>
  );
}
