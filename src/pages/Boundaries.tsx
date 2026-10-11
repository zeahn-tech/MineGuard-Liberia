import { ShieldAlert } from "lucide-react";
import { useMemo } from "react";
import { api } from "@/lib/backend";
import { useMutation, useQuery } from "@/lib/backend-react";
import { useAuth } from "@/hooks/use-auth";
import { BoundaryLoader } from "@/components/BoundaryLoader";

export default function Boundaries() {
  const { user } = useAuth();
  const data = useQuery(api.mapFeatures);
  const sites = useQuery(api.sites.list);
  const saveSite = useMutation(api.gis.saveSiteBoundary);
  const saveAdmin = useMutation(api.gis.saveAdminBoundary);
  const siteList = useMemo(() => sites ?? [], [sites]);
  const adminBoundaries = useMemo(() => data?.adminBoundaries ?? [], [data]);
  const siteBoundaries = useMemo(() => data?.siteBoundaries ?? [], [data]);

  if (!user) return null;
  if (user.role !== "admin") {
    return (
      <div className="paper flex items-start gap-3 p-6">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
        <div>
          <p className="text-sm font-medium">Administrator access required</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Loading map boundaries is limited to platform administrators. Your current role:{" "}
            {user.role ?? "unassigned"}.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <header>
        <p className="kicker">Administration</p>
        <h1 className="display mt-1 text-3xl">Map boundaries</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Load site outlines and administrative areas (counties, districts…) from a GeoJSON file. Every
          shape is checked before anything is saved, and nothing is repaired or guessed. Loaded
          boundaries start as <strong>unverified</strong> and are drawn that way on the National Map.
        </p>
      </header>
      <BoundaryLoader
        sites={siteList}
        adminBoundaries={adminBoundaries}
        siteBoundaries={siteBoundaries}
        loaded={data !== undefined}
        saveSite={saveSite}
        saveAdmin={saveAdmin}
      />
    </div>
  );
}
