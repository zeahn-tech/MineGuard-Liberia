import { Link } from "react-router";
import { Siren } from "lucide-react";
import { useMyEmergencyAlerts, useNow } from "@/hooks/use-my-emergency-alerts";
import { describeFreshness, SEVERITY_LABEL } from "@/lib/emergency";
import { severityClasses } from "./severity";

/** Persistent banner for the worker shell: any active alert addressed to this person, or a
 *  recent cancellation, with a link to the full instructions. Offline/stale state is stated. */
export function EmergencyBanner({ basePath }: { basePath: string }) {
  const { alerts, checkedAt, online, lastCheckFailed, reloadNeeded } = useMyEmergencyAlerts(true);
  const now = useNow(15_000);
  const shown = alerts.filter((a) => a.status === "active" || (a.status !== "draft" && a.closed_at && now - Date.parse(a.closed_at) < 3_600_000));
  const fresh = describeFreshness(checkedAt, now, online, lastCheckFailed);
  if (shown.length === 0 && !reloadNeeded) return null;
  return (
    <div className="space-y-2 px-4 pt-3 md:px-8">
      {reloadNeeded && (
        <p role="status" className="rounded-md border border-amber-600 bg-amber-500/10 p-3 text-sm">
          This copy of MineGuard is out of date and may not show emergency alerts correctly. Reload the page while online.
        </p>
      )}
      {shown.map((a) => (
        <Link
          key={a.id}
          to={`${basePath}/emergency/${a.id}`}
          role={a.status === "active" && a.severity === "critical" ? "alert" : "status"}
          className={`block rounded-md border-2 p-3 focus-visible:outline-2 focus-visible:outline-offset-2 ${severityClasses[a.severity]}`}
        >
          <span className="flex items-center gap-2 text-sm font-semibold">
            <Siren className="size-4" aria-hidden />
            {a.status === "active" ? `${SEVERITY_LABEL[a.severity]} emergency alert` : a.status === "cancelled" ? "Alert cancelled" : "Alert resolved"}
            <span className="font-normal">· {a.site_name}</span>
          </span>
          <span className="mt-1 block text-base font-medium">{a.title}</span>
          <span className="mt-1 block text-xs text-muted-foreground">
            {a.my_ack_revision === a.revision ? "You acknowledged this." : "Open for instructions and to acknowledge."}
            {fresh.level !== "live" ? ` ${fresh.message}` : ""}
          </span>
        </Link>
      ))}
    </div>
  );
}
