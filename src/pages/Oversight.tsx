// ---------------------------------------------------------------------------
// COMPANY OVERSIGHT — the Ministry's cross-company summary (migration 0039).
// One row per company: sites, open and overdue corrective actions, incidents in the
// last 30 days and the last inspection. The database scopes every number to the
// signed-in person (a county inspector sees their scope; an administrator sees all).
// ---------------------------------------------------------------------------
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { useAuth } from "@/hooks/use-auth";
import { api } from "@/lib/backend";
import { useQuery } from "@/lib/backend-react";
import { Link } from "react-router";

function Stat({ label, value, tone }: { label: string; value: number; tone?: "bad" }) {
  return (
    <Card>
      <CardContent className="pt-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={`display mt-1 text-2xl ${tone === "bad" && value > 0 ? "text-destructive" : ""}`}>{value}</p>
      </CardContent>
    </Card>
  );
}

export default function Oversight() {
  const { user } = useAuth();
  const rows = useQuery(api.oversight.list);
  const requests = useQuery(api.siteRequests.list);
  const isAdmin = user?.role === "admin";
  const pending = (requests ?? []).filter((r) => r.status === "pending").length;

  const sum = (k: "sites" | "openActions" | "overdueActions" | "incidents30d") => (rows ?? []).reduce((n, r) => n + r[k], 0);

  return (
    <div className="min-w-0 space-y-6">
      <header>
        <p className="kicker">Regulation</p>
        <h1 className="display mt-1 text-2xl sm:text-3xl">Company oversight</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          How each company stands, within your scope. Open a company to see its sites{isAdmin ? ", people and requests" : ""}.
        </p>
      </header>

      {rows === undefined ? (
        <p className="text-sm text-muted-foreground" role="status">Loading oversight…</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Stat label="Companies" value={rows.length} />
            <Stat label="Sites" value={sum("sites")} />
            <Stat label="Open actions" value={sum("openActions")} />
            <Stat label="Overdue actions" value={sum("overdueActions")} tone="bad" />
            <Stat label="Incidents (30 days)" value={sum("incidents30d")} />
          </div>
          {isAdmin && pending > 0 && (
            <p className="text-sm">
              <Link to="/portal/site-requests" className="underline underline-offset-2">{pending} site request{pending === 1 ? "" : "s"} waiting for review</Link>
            </p>
          )}
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No companies in your scope yet.</p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full min-w-[40rem] text-left text-sm">
                <thead className="bg-muted/50 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Company</th>
                    <th className="px-3 py-2 font-medium">Sites</th>
                    <th className="px-3 py-2 font-medium">Open actions</th>
                    <th className="px-3 py-2 font-medium">Overdue</th>
                    <th className="px-3 py-2 font-medium">Incidents (30 d)</th>
                    <th className="px-3 py-2 font-medium">Last inspection</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.organizationId} className="border-t">
                      <td className="px-3 py-2">
                        <Link
                          className="font-medium underline-offset-2 hover:underline"
                          to={isAdmin ? `/portal/companies/${r.organizationId}` : `/portal/sites?company=${r.organizationId}`}
                        >
                          {r.name}
                        </Link>
                        {r.status !== "approved" && <Badge variant="destructive" className="ml-2">{r.status.replace(/_/g, " ")}</Badge>}
                      </td>
                      <td className="px-3 py-2 tabular-nums">{r.sites}</td>
                      <td className="px-3 py-2 tabular-nums">{r.openActions}</td>
                      <td className={`px-3 py-2 tabular-nums ${r.overdueActions > 0 ? "font-medium text-destructive" : ""}`}>{r.overdueActions}</td>
                      <td className="px-3 py-2 tabular-nums">{r.incidents30d}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{r.lastInspection ? new Date(r.lastInspection).toLocaleDateString() : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
