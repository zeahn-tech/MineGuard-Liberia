// ---------------------------------------------------------------------------
// ACTIVITY (company administrators, migration 0038): what happened in the company —
// membership, invitations, imports, site requests, sites and their safety records.
// A curated view: names and plain words only, never emails or raw records.
// ---------------------------------------------------------------------------
import { ActivityFeed } from "@/components/ActivityFeed";
import { api } from "@/lib/backend";
import { useQuery } from "@/lib/backend-react";
import { ShieldAlert } from "lucide-react";

export default function OperatorActivity() {
  const me = useQuery(api.workforce.myMembership);
  if (me === undefined) return <p className="p-4 text-sm text-muted-foreground md:p-6" role="status">Loading…</p>;
  if (!me || me.orgRole !== "company_admin" || me.memberStatus !== "active") {
    return (
      <div className="p-4 md:p-6">
        <div className="paper flex items-start gap-3 p-6">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
          <p className="text-sm">The company activity history is limited to company administrators.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="min-w-0 space-y-6 p-4 md:p-6">
      <header className="min-w-0">
        <p className="kicker">{me.organizationName}</p>
        <h1 className="display mt-1 text-2xl sm:text-3xl">Activity</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          What has happened in your company, newest first. Ministry actions appear as &ldquo;Ministry&rdquo;.
        </p>
      </header>
      <ActivityFeed organizationId={me.organizationId} />
    </div>
  );
}
