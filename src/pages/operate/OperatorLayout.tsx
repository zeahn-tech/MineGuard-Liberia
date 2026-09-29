// ---------------------------------------------------------------------------
// OPERATOR LAYOUT — the shell of the /operate/* section (Priority B §20).
//
// Deliberately NOT PortalLayout: the operator section is its own routed
// subtree with its own nav, its own header identity, and its own gate
// (RequireOperator). Staff surfaces are unreachable from here by routing,
// and the staff portal is unreachable from here by the same structure —
// not by a conditionally-hidden nav item.
//
// Offline field submission: operators work at sites with unreliable
// connectivity, so incident submissions support the offline queue
// (persist-locally-first, clientRef dedupe on sync) exactly like the staff
// inspection flow.
// ---------------------------------------------------------------------------

import { Button } from "@/components/ui/button";
import NotificationBell from "@/components/NotificationBell";
import { RequireOperator } from "@/components/RequireAuth";
import { useAuth } from "@/hooks/use-auth";
import { readQueue, syncQueue, type QueueItem } from "@/lib/offline-queue";
import { api } from "@/lib/backend";
import { useMutation } from "@/lib/backend-react";
import {
  Building2,
  ClipboardList,
  FileCheck2,
  HeartPulse,
  LogOut,
  Menu,
  RefreshCw,
  ShieldCheck,
  ShieldEllipsis,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router";
import { toast } from "sonner";

const OPERATOR_NAV = [
  { to: "/operate", label: "Overview", icon: ClipboardList, end: true },
  { to: "/operate/sites", label: "My Sites", icon: Building2 },
  { to: "/operate/findings", label: "Findings", icon: FileCheck2 },
  { to: "/operate/corrective-actions", label: "Corrective Actions", icon: ShieldCheck },
  { to: "/operate/incidents", label: "Incidents", icon: HeartPulse },
  { to: "/operate/security", label: "Account Security", icon: ShieldEllipsis },
];

function OperatorNavLinks({
  items,
  onNavigate,
}: {
  items: typeof OPERATOR_NAV;
  onNavigate?: () => void;
}) {
  return (
    <>
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={"end" in item ? (item as { end?: boolean }).end : false}
          onClick={onNavigate}
          className={({ isActive }) =>
            `flex items-center gap-2.5 rounded px-3 py-2 text-sm transition-colors ${
              isActive
                ? "bg-accent font-medium text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
            }`
          }
        >
          <item.icon className="size-4" strokeWidth={1.5} />
          {item.label}
        </NavLink>
      ))}
    </>
  );
}

export default function OperatorLayout() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [syncing, setSyncing] = useState(false);

  const syncReportIncident = useMutation(api.records.reportIncident);
  const syncApi = useMemo(
    () => ({ reportIncident: syncReportIncident }),
    [syncReportIncident],
  );

  useEffect(() => {
    const refresh = () => setQueue(readQueue());
    refresh();
    const interval = setInterval(refresh, 1500);
    const onOnline = () => {
      setSyncing(true);
      syncQueue(syncApi)
        .then((r) => {
          if (r.synced > 0) toast.success(`Synced ${r.synced} submission(s)`);
          if (r.failed > 0) toast.error(`${r.failed} submission(s) failed — will retry`);
        })
        .finally(() => {
          setSyncing(false);
          refresh();
        });
    };
    window.addEventListener("online", onOnline);
    return () => {
      clearInterval(interval);
      window.removeEventListener("online", onOnline);
    };
  }, [syncApi]);

  const pendingCount = queue.filter((q) => q.status !== "done").length;

  const handleSyncNow = async () => {
    setSyncing(true);
    try {
      const r = await syncQueue(syncApi);
      if (r.synced > 0) toast.success(`Synced ${r.synced} submission(s)`);
      if (r.synced === 0 && r.failed === 0) toast.info("Queue is empty");
    } finally {
      setSyncing(false);
      setQueue(readQueue());
    }
  };

  return (
    <RequireOperator>
      <div className="min-h-screen bg-background">
        {/* Accessibility: keyboard users skip the sidebar straight to content */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-sm focus:border focus:border-border focus:bg-card focus:px-3 focus:py-1.5 focus:text-sm"
        >
          Skip to main content
        </a>
        <div className="mx-auto flex min-h-screen w-full max-w-[1400px]">
          {/* Sidebar */}
          <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-sidebar md:flex">
            <div className="flex items-center gap-2 border-b border-border px-4 py-5">
              <ShieldCheck className="size-6 text-foreground" strokeWidth={1.5} />
              <div>
                <div className="display text-sm leading-tight">MineGuard</div>
                <div className="kicker text-[10px]">Operator access</div>
              </div>
              <span className="ml-auto stamp text-[9px] text-muted-foreground">V1.0</span>
            </div>
            <nav className="flex-1 space-y-1 overflow-y-auto px-2 py-4">
              <OperatorNavLinks items={OPERATOR_NAV} />
            </nav>
            <div className="border-t border-border p-3">
              <div className="mb-2 px-2 text-[11px] leading-snug text-muted-foreground">
                <span className="font-medium text-foreground">{user?.email}</span>
                <br />
                operator · {user?.operatorName ?? "—"}
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start text-muted-foreground"
                onClick={async () => {
                  await signOut();
                  navigate("/");
                }}
              >
                <LogOut className="size-3.5" /> Sign out
              </Button>
            </div>
          </aside>

          {/* Main column */}
          <div className="flex min-w-0 flex-1 flex-col">
            {/* Top bar */}
            <header className="flex items-center gap-3 border-b border-border px-4 py-3 md:hidden">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setMobileNavOpen((v) => !v)}
                aria-label="Toggle navigation"
              >
                <Menu className="size-5" strokeWidth={1.5} />
              </Button>
              <Link to="/operate" className="display text-sm">
                MineGuard <span className="kicker text-[10px]">Operator</span>
              </Link>
              <div className="ml-auto flex items-center gap-1">
                <NotificationBell />
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  onClick={() => void handleSyncNow()}
                  disabled={syncing}
                >
                  <RefreshCw className={`size-3.5 ${syncing ? "animate-spin" : ""}`} />
                  {pendingCount > 0 ? `${pendingCount} queued` : "Sync"}
                </Button>
              </div>
            </header>

            {mobileNavOpen && (
              <nav className="space-y-1 border-b border-border px-3 py-3 md:hidden">
                <OperatorNavLinks
                  items={OPERATOR_NAV}
                  onNavigate={() => setMobileNavOpen(false)}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start text-muted-foreground"
                  onClick={async () => {
                    await signOut();
                    navigate("/");
                  }}
                >
                  <LogOut className="size-3.5" /> Sign out
                </Button>
              </nav>
            )}

            {/* Desktop sync strip */}
            <div className="hidden items-center justify-end gap-3 border-b border-border px-6 py-2 md:flex">
              <NotificationBell />
              {pendingCount > 0 && (
                <span className="text-xs text-muted-foreground">
                  {pendingCount} submission(s) queued offline
                </span>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => void handleSyncNow()}
                disabled={syncing}
              >
                <RefreshCw className={`mr-1.5 size-3.5 ${syncing ? "animate-spin" : ""}`} />
                Sync now
              </Button>
            </div>

            <main id="main-content" className="min-w-0 flex-1">
              <Outlet />
            </main>

            <footer className="border-t border-border px-6 py-3 text-center text-[11px] text-muted-foreground">
              Operator access is tenant-isolated: your company's records only,
              enforced server-side. Not an official Government of Liberia
              system.
            </footer>
          </div>
        </div>
      </div>
    </RequireOperator>
  );
}
