import { useParams, Link } from "react-router";
import { useQuery, useMutation } from "@/lib/backend-react";
import { api } from "@/lib/backend";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { ArrowLeft, MapPin, ShieldCheck } from "lucide-react";
import { isStaffRole } from "@/lib/types";
import EvidenceSection from "@/components/EvidenceSection";

const VERIF_STYLE: Record<string, string> = {
  verified: "text-foreground",
  measured: "text-foreground",
  observed: "text-muted-foreground",
  unverified: "text-muted-foreground",
  alleged: "text-destructive",
};

export default function ObservationDetail() {
  const { observationId } = useParams<{ observationId: string }>();
  const observation = useQuery(
    api.records.getObservation,
    observationId ? { observationId } : "skip",
  );
  const setStatus = useMutation(api.records.setObservationStatus);
  const { user } = useAuth();
  // Status transitions are staff-only (rules).
  const isStaff = isStaffRole(user?.role);

  if (!observationId)
    return (
      <p className="text-sm text-muted-foreground">No observation selected.</p>
    );
  if (observation === undefined)
    return <p className="py-16 text-center text-sm text-muted-foreground">Loading…</p>;
  if (observation === null)
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
          <Link to="/portal/environment">
            <ArrowLeft className="size-4" /> Observations
          </Link>
        </Button>
      </div>

      <header className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="kicker">Environmental observation</p>
          <h1 className="display mt-1 text-2xl">
            {observation.category.replace(/_/g, " ")}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className={`stamp ${VERIF_STYLE[observation.verification]}`}>
              {observation.verification}
            </span>
            <Badge variant="outline" className="font-mono text-[10px]">
              {observation.status}
            </Badge>
            <span className="text-xs text-muted-foreground">
              Observed {new Date(observation.observedAt).toLocaleString()}
            </span>
          </div>
        </div>
        {isStaff && observation.status !== "resolved" && (
          <div className="flex flex-col gap-2 sm:flex-row">
            {observation.status === "open" && (
              <Button
                variant="outline"
                onClick={() =>
                  act(
                    () => setStatus({ observationId, status: "monitoring" }),
                    "Moved to monitoring",
                  )
                }
              >
                Monitor
              </Button>
            )}
            <Button
              onClick={() =>
                act(
                  () => setStatus({ observationId, status: "resolved" }),
                  "Marked resolved",
                )
              }
            >
              Resolve
            </Button>
          </div>
        )}
      </header>

      {/* Provenance */}
      <section className="grid gap-3 text-xs text-muted-foreground sm:grid-cols-3">
        <div className="border border-border p-3">
          <p className="kicker mb-1">Site</p>
          <p className="flex items-center gap-1">
            <MapPin className="size-3.5" />
            <span className="font-mono">{observation.siteCode ?? "—"}</span>
            {observation.siteName ? ` · ${observation.siteName}` : ""}
          </p>
        </div>
        <div className="border border-border p-3">
          <p className="kicker mb-1">County</p>
          <p>{observation.county ?? "—"}</p>
        </div>
        <div className="border border-border p-3">
          <p className="kicker mb-1">Coordinates</p>
          <p className="flex items-center gap-1">
            <ShieldCheck className="size-3.5" />
            {observation.latitude != null
              ? `${observation.latitude.toFixed(5)}, ${observation.longitude?.toFixed(5)}`
              : "No GPS captured"}
          </p>
        </div>
      </section>

      <section>
        <h2 className="display border-b border-border pb-2 text-lg">
          What was observed
        </h2>
        <p className="mt-3 text-sm leading-relaxed">{observation.description}</p>
        <p className="mt-3 text-xs text-muted-foreground">
          Verification state records how the observation was established —
          a distinction this platform enforces before any figure is used in
          analysis.
        </p>
      </section>

      {/* Evidence — online-only uploads, tenant-scoped by rules + data layer */}
      <EvidenceSection
        parentType="observation"
        parentId={observation._id}
        siteId={observation.siteId}
      />
    </div>
  );
}
