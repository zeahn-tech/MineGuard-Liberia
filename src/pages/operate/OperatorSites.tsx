// ---------------------------------------------------------------------------
// OPERATOR SITES — the operator's own licensed sites (registry reads are the
// same server-scoped queries the staff portal uses; for an operator identity
// RLS + the client mirror return ONLY their tenant's rows).
// ---------------------------------------------------------------------------

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useQuery } from "@/lib/backend-react";
import { api } from "@/lib/backend";
import { Building2, FileCheck2, Loader2, MapPin } from "lucide-react";
import { Link, useParams } from "react-router";

export function OperatorSites() {
  const sitesQ = useQuery(api.sites.list);

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div>
        <p className="kicker">Operator portal</p>
        <h1 className="display text-2xl">My sites</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Registry records for your company. Status changes (verification,
          suspension, closure) are made by the oversight administrator — not by
          operators.
        </p>
      </div>

      {sitesQ === undefined && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </p>
      )}
      {sitesQ !== undefined && (sitesQ ?? []).length === 0 && (
        <p className="text-sm text-muted-foreground">
          No sites are registered to your company yet.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {(sitesQ ?? []).map((s) => (
          <Link key={s._id} to={`/operate/sites/${s._id}`} className="block">
            <Card className="paper h-full rounded-none border-border shadow-none transition-colors hover:bg-muted/30">
              <CardContent className="pt-4">
                <div className="flex items-center gap-2">
                  <Building2 className="size-4 text-muted-foreground" strokeWidth={1.5} />
                  <span className="text-sm font-medium">{s.name}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {s.code} · {s.county}
                  {s.mineralType ? ` · ${s.mineralType}` : ""}
                </p>
                <p className="mt-2 flex items-center gap-1.5 text-xs">
                  <FileCheck2 className="size-3.5 text-muted-foreground" strokeWidth={1.5} />
                  {s.openActions ?? 0} open corrective action{(s.openActions ?? 0) === 1 ? "" : "s"}
                </p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}

export function OperatorSiteDetail() {
  const { siteId } = useParams();
  const siteQ = useQuery(api.sites.get, { siteId: siteId ?? "" });

  return (
    <div className="space-y-4 p-4 md:p-6">
      <Link
        to="/operate/sites"
        className="text-sm text-muted-foreground underline-offset-4 hover:underline"
      >
        ← My sites
      </Link>

      {siteQ === undefined && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </p>
      )}
      {siteQ === null && (
        <Card className="paper rounded-none border-border shadow-none">
          <CardContent className="pt-4">
            <p className="text-sm">
              Not found or not visible to your account. Sites belong to exactly
              one operator; this one is not your company's.
            </p>
          </CardContent>
        </Card>
      )}
      {siteQ && (
        <>
          <div>
            <p className="kicker">{siteQ.code}</p>
            <h1 className="display text-2xl">{siteQ.name}</h1>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <MapPin className="size-3.5" strokeWidth={1.5} />
              {siteQ.county}
              {siteQ.district ? ` · ${siteQ.district}` : ""}
              {siteQ.community ? ` · ${siteQ.community}` : ""}
              {siteQ.mineralType ? ` · ${siteQ.mineralType}` : ""}
            </p>
          </div>

          <Card className="paper rounded-none border-border shadow-none">
            <CardHeader className="pb-2">
              <p className="kicker">Registry</p>
              <CardTitle className="display text-lg">Status &amp; lifecycle</CardTitle>
              <CardDescription>
                Registry status is maintained by the oversight administrator.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2 text-sm">
              <span className="rounded border border-border bg-muted/40 px-2 py-1">
                status: {siteQ.status.replace("_", " ")}
              </span>
              <span className="rounded border border-border bg-muted/40 px-2 py-1">
                open corrective actions: {siteQ.openActions ?? 0}
              </span>
            </CardContent>
          </Card>

          <div className="grid gap-3 sm:grid-cols-2">
            <Link to={`/operate/findings?siteId=${siteQ._id}`} className="block">
              <Card className="paper h-full rounded-none border-border shadow-none transition-colors hover:bg-muted/30">
                <CardContent className="flex items-center gap-3 pt-4">
                  <FileCheck2 className="size-5 text-muted-foreground" strokeWidth={1.5} />
                  <div>
                    <p className="text-sm font-medium">Findings on this site</p>
                    <p className="text-xs text-muted-foreground">What inspectors recorded</p>
                  </div>
                </CardContent>
              </Card>
            </Link>
            <Link to={`/operate/corrective-actions?siteId=${siteQ._id}`} className="block">
              <Card className="paper h-full rounded-none border-border shadow-none transition-colors hover:bg-muted/30">
                <CardContent className="flex items-center gap-3 pt-4">
                  <FileCheck2 className="size-5 text-muted-foreground" strokeWidth={1.5} />
                  <div>
                    <p className="text-sm font-medium">Corrective actions</p>
                    <p className="text-xs text-muted-foreground">Obligations &amp; responses</p>
                  </div>
                </CardContent>
              </Card>
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
