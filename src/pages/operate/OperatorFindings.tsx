// ---------------------------------------------------------------------------
// OPERATOR FINDINGS — findings recorded by inspectors on the operator's own
// sites. Read-only for operators by design: acknowledging/resolving is a
// staff/reviewer flow (server guard: operators cannot resolve); what an
// operator does with a finding is respond to its corrective action.
// ---------------------------------------------------------------------------

import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { useQuery } from "@/lib/backend-react";
import { api } from "@/lib/backend";
import type { Severity } from "@/lib/types";
import { Link, useSearchParams } from "react-router";
import { PageLoading } from "@/components/PageLoading";
import { EmptyState } from "@/components/EmptyState";
import { useCaAccess } from "@/hooks/use-ca-access";
import { isRespondable } from "@/lib/corrective-actions";
import { FileCheck2 } from "lucide-react";

function severityClasses(sev: Severity): string {
  switch (sev) {
    case "critical":
      return "bg-destructive/15 text-destructive border-destructive/30";
    case "high":
      return "bg-destructive/10 text-destructive border-destructive/25";
    case "medium":
      return "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

export default function OperatorFindings() {
  const findingsQ = useQuery(api.inspections.listMyFindings);
  const access = useCaAccess();
  const casQ = useQuery(api.inspections.listMyCorrectiveActions, access === "allowed" ? undefined : "skip");
  const [searchParams] = useSearchParams();
  const siteFilter = searchParams.get("siteId") ?? null;

  const all = findingsQ ?? [];
  const findings = siteFilter ? all.filter((f) => f.siteId === siteFilter) : all;

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div>
        <p className="kicker">Operator portal</p>
        <h1 className="display text-2xl">Findings on your sites</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Recorded by oversight inspectors after field inspections. Findings
          are read-only — the response channel is the corrective action the
          reviewing authority opens for a finding, handled by your
          company administrator, site managers and safety officers.
        </p>
      </div>

      {siteFilter && (
        <p className="text-sm text-muted-foreground">
          Filtered to one site.{" "}
          <Link to="/operate/findings" className="text-primary underline-offset-4 hover:underline">
            Show all
          </Link>
        </p>
      )}

      {findingsQ === undefined && (
        <PageLoading shape="list" label="findings" />
      )}
      {findingsQ !== undefined && findings.length === 0 && (
        <EmptyState
          icon={FileCheck2}
          title="No findings on your sites"
          why="Findings appear here after an oversight inspector records them during a field inspection."
        />
      )}

      <div className="space-y-3">
        {findings.map((f) => (
          <Card key={f._id} className="paper rounded-none border-border shadow-none">
            <CardContent className="pt-4">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${severityClasses(f.severity)}`}
                >
                  {f.severity}
                </span>
                <span className="text-sm font-medium">{f.title}</span>
                <span className="text-xs text-muted-foreground">
                  · {f.siteCode} {f.siteName}, {f.county}
                </span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {new Date(f.createdAt).toLocaleDateString()} ·{" "}
                  {f.status === "open"
                    ? "open"
                    : f.status === "acknowledged"
                      ? "acknowledged"
                      : f.status === "resolved"
                        ? "resolved (awaiting verification)"
                        : "verified & closed"}
                </span>
              </div>
              {f.description && (
                <p className="mt-1 text-sm text-muted-foreground">{f.description}</p>
              )}
              {access === "allowed" && casQ !== undefined && (() => {
                const cas = casQ.filter((c) => c.findingId === f._id);
                if (cas.length === 0) {
                  return (
                    <p className="mt-2 text-xs text-muted-foreground">
                      The reviewing authority has not opened a corrective action for this finding — it sets the
                      deadline. Once opened, it appears under Corrective Actions.
                    </p>
                  );
                }
                return cas.map((c) => (
                  <p key={c._id} className="mt-2 text-xs">
                    <span className="text-muted-foreground">
                      Corrective action: {c.status.replace("_", " ")} ·{" "}
                    </span>
                    <Link
                      to={`/operate/corrective-actions?siteId=${f.siteId}`}
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      {isRespondable(c.status) ? "Respond" : "View"}
                    </Link>
                  </p>
                ));
              })()}
            </CardContent>
          </Card>
        ))}
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        Findings carry severity (low → critical), not legal determinations.
        {findings.some((f) => f.status === "resolved") &&
          " Resolved findings stay visible until a reviewer verifies them."}
      </p>
    </div>
  );
}
