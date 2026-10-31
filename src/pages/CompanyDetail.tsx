// ---------------------------------------------------------------------------
// COMPANY DETAIL (Ministry administrators). One company, end to end: its status,
// administrators, invitations and counts (the same card as the Companies list)
// plus the sites registered for it, each linking to the existing site page.
// Worker names are not shown here — only counts; a company's workforce belongs to
// the company. Site visibility follows the administrator's own scope as always.
// ---------------------------------------------------------------------------

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/hooks/use-auth";
import { api } from "@/lib/backend";
import { useQuery } from "@/lib/backend-react";
import { ChevronLeft, MapPin, ShieldAlert } from "lucide-react";
import { Link, useParams } from "react-router";
import { CompanyCard } from "./Companies";

export default function CompanyDetail() {
  const { companyId } = useParams();
  const { user } = useAuth();
  const companies = useQuery(api.companies.list);
  const sites = useQuery(api.sites.list);

  if (!user) return null;
  if (user.role !== "admin") {
    return (
      <div className="paper flex min-w-0 items-start gap-3 p-6">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
        <p className="text-sm">Company details are limited to Ministry administrators.</p>
      </div>
    );
  }
  if (companies === undefined || sites === undefined) {
    return <p className="text-sm text-muted-foreground" role="status">Loading company…</p>;
  }
  const company = companies.find((c) => c.id === companyId);
  if (!company) {
    return (
      <div className="space-y-3">
        <Link to="/portal/companies" className="inline-flex items-center gap-1 text-sm underline underline-offset-2">
          <ChevronLeft className="size-4" /> Companies
        </Link>
        <p className="text-sm">That company was not found.</p>
      </div>
    );
  }
  const mine = sites.filter((s) => s.organizationId === company.id);

  return (
    <div className="min-w-0 space-y-6">
      <Link to="/portal/companies" className="inline-flex items-center gap-1 text-sm underline underline-offset-2">
        <ChevronLeft className="size-4" /> Companies
      </Link>

      <CompanyCard company={company} showActions={false} />

      <Card className="min-w-0">
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
          <CardTitle className="text-base">Sites ({mine.length})</CardTitle>
          {mine.length > 0 && (
            <Link to={`/portal/sites?company=${company.id}`} className="text-xs underline underline-offset-2">
              Open in Mining sites
            </Link>
          )}
        </CardHeader>
        <CardContent>
          {mine.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No sites registered for this company yet. Register one from{" "}
              <Link className="underline" to="/portal/sites">Mining sites</Link> and choose this company.
            </p>
          ) : (
            <ul className="space-y-2">
              {mine.map((s) => (
                <li key={s._id}>
                  <Link
                    to={`/portal/sites/${s._id}`}
                    className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border p-3 hover:bg-accent/50"
                  >
                    <span className="min-w-0">
                      <span className="block break-words text-sm font-medium">{s.name}</span>
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <MapPin className="size-3" /> {s.code} · {s.county}
                        {s.openActions ? ` · ${s.openActions} open action${s.openActions === 1 ? "" : "s"}` : ""}
                      </span>
                    </span>
                    <Badge variant={s.status === "active" ? "secondary" : "outline"}>{s.status.replace(/_/g, " ")}</Badge>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
