import { useParams, Link } from "react-router";
import { useQuery, useMutation } from "@/lib/backend-react";
import { api } from "@/lib/backend";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { ArrowLeft, MapPin, UserCheck } from "lucide-react";
import { isStaffRole } from "@/lib/types";
import EvidenceSection from "@/components/EvidenceSection";

const SEV_STYLES: Record<string, string> = {
  low: "text-muted-foreground",
  medium: "text-foreground",
  high: "text-destructive",
  critical: "text-destructive",
};

export default function IncidentDetail() {
  const { incidentId } = useParams<{ incidentId: string }>();
  const incident = useQuery(
    api.records.getIncident,
    incidentId ? { incidentId } : "skip",
  );
  const setStatus = useMutation(api.records.setIncidentStatus);
  const { user } = useAuth();
  // Status transitions are staff-only (rules); operators read the record.
  const isStaff = isStaffRole(user?.role);

  if (!incidentId)
    return <p className="text-sm text-muted-foreground">No incident selected.</p>;
  if (incident === undefined)
    return <p className="py-16 text-center text-sm text-muted-foreground">Loading…</p>;
  if (incident === null)
    return (
      <p className="py-16 text-center text-sm text-muted-foreground">
        Not found or access denied.
      </p>
    );

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast.success(ok);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed");
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2 text-muted-foreground">
          <Link to="/portal/incidents">
            <ArrowLeft className="size-4" /> Incidents
          </Link>
        </Button>
      </div>

      <header className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="kicker">Incident record</p>
          <h1 className="display mt-1 text-2xl">
            {incident.type.replace(/_/g, " ")}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className={`stamp ${SEV_STYLES[incident.severity]}`}>
              {incident.severity}
            </span>
            <Badge variant="outline" className="font-mono text-[10px]">
              {incident.status}
            </Badge>
            <span className="text-xs text-muted-foreground">
              Occurred {new Date(incident.occurredAt).toLocaleString()}
            </span>
          </div>
        </div>
        {isStaff && incident.status !== "closed" && (
          <div className="flex flex-col gap-2 sm:flex-row">
            {incident.status === "reported" && (
              <Button
                onClick={() =>
                  act(
                    () => setStatus({ incidentId, status: "investigating" }),
                    "Investigation opened",
                  )
                }
              >
                Investigate
              </Button>
            )}
            {incident.status === "investigating" && (
              <Button
                variant="outline"
                onClick={() =>
                  act(
                    () => setStatus({ incidentId, status: "closed" }),
                    "Incident closed",
                  )
                }
              >
                Close incident
              </Button>
            )}
          </div>
        )}
      </header>

      {/* Provenance */}
      <section className="grid gap-3 text-xs text-muted-foreground sm:grid-cols-3">
        <div className="border border-border p-3">
          <p className="kicker mb-1">Site</p>
          <p className="flex items-center gap-1">
            <MapPin className="size-3.5" />
            <span className="font-mono">{incident.siteCode ?? "—"}</span>
            {incident.siteName ? ` · ${incident.siteName}` : ""}
          </p>
        </div>
        <div className="border border-border p-3">
          <p className="kicker mb-1">County</p>
          <p>{incident.county ?? "—"}</p>
        </div>
        <div className="border border-border p-3">
          <p className="kicker mb-1">Report source</p>
          <p className="flex items-center gap-1">
            <UserCheck className="size-3.5" />
            {incident.reportSource}
          </p>
        </div>
      </section>

      {/* Narrative + casualty figures */}
      <section className="space-y-4">
        <div>
          <h2 className="display border-b border-border pb-2 text-lg">
            Account
          </h2>
          <p className="mt-3 text-sm leading-relaxed">{incident.description}</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="border border-border p-3">
            <p className="kicker mb-1">Fatalities</p>
            <p className="stat-figure text-xl">{incident.fatalities ?? 0}</p>
          </div>
          <div className="border border-border p-3">
            <p className="kicker mb-1">Injured</p>
            <p className="stat-figure text-xl">{incident.injured ?? 0}</p>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Operational categories only — this record is not a legal
          classification, and figures are as reported.
        </p>
      </section>

      {/* Evidence — online-only uploads, tenant-scoped by rules + data layer */}
      <EvidenceSection
        parentType="incident"
        parentId={incident._id}
        siteId={incident.siteId}
      />
    </div>
  );
}
