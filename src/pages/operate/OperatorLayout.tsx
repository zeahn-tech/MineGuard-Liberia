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

import { BrandMark } from "@/components/BrandMark";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import NotificationBell from "@/components/NotificationBell";
import { RequireOperator } from "@/components/RequireAuth";
import { useAuth } from "@/hooks/use-auth";
import {
  ensureOfflineReady,
  readQueue,
  subscribeQueue,
  type QueueItem,
  type SyncApi,
} from "@/lib/offline-queue";
import {
  startSyncScheduler,
  type SchedulerResult,
  type SyncScheduler,
} from "@/lib/offline-sync";
import { QueueManagerButton } from "@/components/QueueManager";
import { sectionJump } from "@/lib/utils";
import { api, refreshAllData } from "@/lib/backend";
import { useLatest } from "@/lib/use-latest";
import { useMutation, useQuery } from "@/lib/backend-react";
import {
  Building2,
  ClipboardList,
  CloudOff,
  FileCheck2,
  HeartPulse,
  LogOut,
  Menu,
  RefreshCw,
  ShieldCheck,
  ShieldEllipsis,
  Upload,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router";
import { toast } from "sonner";

const OPERATOR_NAV = [
  { to: "/operate", label: "Overview", icon: ClipboardList, end: true },
  { to: "/operate/sites", label: "My Sites", icon: Building2 },
  { to: "/operate/findings", label: "Findings", icon: FileCheck2 },
  { to: "/operate/corrective-actions", label: "Corrective Actions", icon: ShieldCheck },
  { to: "/operate/incidents", label: "Incidents", icon: HeartPulse },
  { to: "/operate/team", label: "Team", icon: Users, adminOnly: true },
  { to: "/operate/import", label: "Import workers", icon: Upload, onboardOnly: true },
  { to: "/operate/security", label: "Account Security", icon: ShieldEllipsis },
];

function OperatorNavLinks({
  items,
  onNavigate,
}: {
  items: readonly { to: string; label: string; icon: typeof Building2; end?: boolean }[];
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
            `flex items-center gap-2.5 rounded-sm px-3 py-2 text-sm transition-colors ${
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
  const membership = useQuery(api.workforce.myMembership);
  const isCompanyAdmin = membership?.orgRole === "company_admin" && membership.memberStatus === "active";
  const isOfficer = membership?.orgRole === "onboarding_officer" && membership.memberStatus === "active";
  const navItems = useMemo(
    () =>
      OPERATOR_NAV.filter((i) => {
        if ("adminOnly" in i && i.adminOnly) return isCompanyAdmin;
        if ("onboardOnly" in i && i.onboardOnly) return isCompanyAdmin || isOfficer;
        return true;
      }),
    [isCompanyAdmin, isOfficer],
  );
  const navigate = useNavigate();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [syncing, setSyncing] = useState(false);

  const syncReportIncident = useMutation(api.records.reportIncident);
  const syncRespondCa = useMutation(api.inspections.respondCorrectiveAction);
  const syncUploadEvidence = useMutation(api.evidence.upload);
  const syncApi = useMemo(
    () => ({
      reportIncident: syncReportIncident,
      respondCorrectiveAction: syncRespondCa,
    }),
    [syncReportIncident, syncRespondCa],
  );

  // OFF-3 scheduler: startup / visibility / online triggers with exponential
  // backoff + jitter; the effect only mirrors the durable queue into the
  // header badge (parity with the staff portal, OFF-5).
  const schedulerRef = useRef<SyncScheduler | null>(null);
  const apiRef = useLatest(syncApi);
  const uploadRef = useLatest(syncUploadEvidence);

  const announce = useCallback((r: SchedulerResult) => {
    const synced = (r.queue?.synced ?? 0) + (r.evidence?.synced ?? 0);
    const conflicts = r.queue?.conflicts ?? 0;
    const dead = (r.queue?.dead ?? 0) + (r.evidence?.dead ?? 0);
    const failed = (r.queue?.failed ?? 0) + (r.evidence?.failed ?? 0);
    if (synced > 0) toast.success(`Synced ${synced} queued item(s)`);
    if (conflicts > 0)
      toast.error(
        `${conflicts} item(s) hit a server conflict — open the queue to resolve them.`,
      );
    if (dead > 0)
      toast.error(`${dead} item(s) rejected or parked — open the queue to review.`);
    else if (failed > 0 && r.forced)
      toast.error(`${failed} submission(s) failed — will retry with backoff.`);
  }, []);

  useEffect(() => {
    const refresh = () => setQueue(readQueue());
    void ensureOfflineReady().then(refresh);
    const off = subscribeQueue(refresh);
    const api: SyncApi = {
      reportIncident: (a) => apiRef.current.reportIncident(a),
      respondCorrectiveAction: (a) => apiRef.current.respondCorrectiveAction(a),
    };
    const scheduler = startSyncScheduler({
      api,
      upload: (a) => uploadRef.current(a),
      onResult: (r) => {
        announce(r);
        refresh();
      },
      onError: (e) =>
        toast.error(e instanceof Error ? e.message : "Background sync failed"),
    });
    schedulerRef.current = scheduler;
    return () => {
      off();
      scheduler.dispose();
      schedulerRef.current = null;
    };
  }, [announce, apiRef, uploadRef]);

  const pendingCount = queue.filter((q) => q.status !== "done").length;

  const handleSignOut = async () => {
    setMobileNavOpen(false);
    await signOut();
    navigate("/");
  };

  const handleSyncNow = async () => {
    const scheduler = schedulerRef.current;
    if (!scheduler) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      toast.info("You're offline — queued items will send automatically once you reconnect");
      setQueue(readQueue());
      return;
    }
    setSyncing(true);
    try {
      const r = await scheduler.syncNow();
      refreshAllData();
      const synced = (r.queue?.synced ?? 0) + (r.evidence?.synced ?? 0);
      const failed = (r.queue?.failed ?? 0) + (r.evidence?.failed ?? 0);
      if (synced === 0 && failed === 0) {
        if (pendingCount === 0)
          toast.success("Up to date — queue is empty and data refreshed");
        else toast.info("Nothing ready to send right now — items stay queued");
      }
      setQueue(readQueue());
    } finally {
      setSyncing(false);
    }
  };

  const identity = `operator · ${user?.operatorName ?? "—"}`;

  return (
    <RequireOperator>
      <div className="min-h-dvh bg-background">
        {/* Accessibility: keyboard users skip the sidebar straight to content */}
        <a
          href="#main-content"
          onClick={sectionJump("main-content")}
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-sm focus:border focus:border-border focus:bg-card focus:px-3 focus:py-1.5 focus:text-sm"
        >
          Skip to main content
        </a>
        <div className="mx-auto flex min-h-dvh w-full max-w-[1400px]">
          {/* Sidebar (≥md) */}
          <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-sidebar md:flex print:!hidden">
            <div className="flex items-center gap-2 border-b border-border px-4 py-5">
              <BrandMark className="size-6" />
              <div>
                <div className="display text-sm leading-tight">MineGuard</div>
                <div className="kicker text-[10px]">Operator access</div>
              </div>
              <span className="ml-auto stamp text-[9px] text-muted-foreground">V1.0</span>
            </div>
            <nav aria-label="Operator" className="flex-1 space-y-1 overflow-y-auto px-2 py-4">
              <OperatorNavLinks items={navItems} />
            </nav>
            <div className="border-t border-border p-3">
              <div className="mb-2 px-2 text-[11px] leading-snug text-muted-foreground">
                <span className="font-medium text-foreground">{user?.email}</span>
                <br />
                {identity}
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start text-muted-foreground"
                onClick={() => void handleSignOut()}
              >
                <LogOut className="size-3.5" /> Sign out
              </Button>
              <div className="mt-2 border-t border-border pt-2">
                <NotificationBell side="top" align="start" />
              </div>
            </div>
          </aside>

          {/* Main column */}
          <div className="flex min-w-0 flex-1 flex-col">
            {/* Top bar — sticky and identical in structure to the staff portal
                and registry shells: it stays in view while the page scrolls. */}
            <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur print:hidden">
              <div className="flex items-center gap-3 px-4 py-3 md:px-6">
                <button
                  type="button"
                  onClick={() => setMobileNavOpen(true)}
                  className="rounded-sm border border-border p-2 text-foreground transition-colors hover:bg-accent md:hidden"
                  aria-label="Open navigation menu"
                >
                  <Menu className="size-5" strokeWidth={1.5} />
                </button>
                <Link to="/operate" className="display text-sm md:hidden">
                  MineGuard Liberia
                </Link>
                <p className="kicker hidden md:block">
                  {membership?.organizationName ?? "Operator portal"}
                </p>
                <div className="ml-auto flex items-center gap-2">
                  {/* Mobile-only bell: on ≥md the sidebar footer bell serves the
                      operator; below md the sidebar is hidden, so the
                      notification entry point must live in the header. */}
                  <div className="md:hidden">
                    <NotificationBell />
                  </div>
                  <QueueManagerButton
                    label={`Queue${pendingCount > 0 ? ` · ${pendingCount}` : ""}`}
                  />
                  {pendingCount > 0 ? (
                    <button
                      type="button"
                      onClick={() => void handleSyncNow()}
                      disabled={syncing}
                      className="flex items-center gap-1.5 rounded-sm border border-destructive/40 bg-destructive/5 px-2.5 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
                    >
                      <CloudOff className="size-3.5" />
                      {/* Keep the label compact on phones so the bell beside it
                          stays visible; full wording on ≥sm. */}
                      <span>
                        {pendingCount} queued
                        <span className="hidden sm:inline"> offline</span>
                      </span>
                      <span className="hidden sm:inline">
                        {syncing ? " — syncing…" : " — tap to sync"}
                      </span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void handleSyncNow()}
                      disabled={syncing}
                      aria-label="Refresh — sync queue and reload data"
                      title="Refresh — sync queue and reload data"
                      className="flex items-center gap-1.5 rounded-sm border border-border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent"
                    >
                      <RefreshCw className={`size-3.5 ${syncing ? "animate-spin" : ""}`} />
                      {/* icon-only on phones: the full label overflowed 320px */}
                      <span className="hidden sm:inline">Queue synced</span>
                    </button>
                  )}
                </div>
              </div>
            </header>

            <main id="main-content" tabIndex={-1} className="min-w-0 flex-1">
              {membership && membership.companyStatus !== "approved" && (
                <p role="status" className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
                  {membership.organizationName} is currently {membership.companyStatus.replace("_", " ")}.
                  Access to company records is paused by the Ministry; nothing has been deleted.
                </p>
              )}
              <Outlet />
            </main>

            <footer className="border-t border-border px-6 py-3 text-center text-[11px] text-muted-foreground print:hidden">
              Operator access is tenant-isolated: your company's records only,
              enforced server-side. Not an official Government of Liberia
              system.
            </footer>
          </div>
        </div>

        {/* Mobile navigation drawer — slides in from the left, mirrors the
            desktop sidebar (same component as the staff portal and registry).
            Tapping a link navigates and slides it back. */}
        <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
          <SheetContent side="left" className="w-72 bg-sidebar p-0 sm:max-w-[18rem]">
            <SheetHeader className="shrink-0 border-b border-border py-5 pr-14 pl-4 text-left">
              <SheetTitle className="flex items-center gap-2 text-sm">
                <BrandMark className="size-5" />
                <span className="display min-w-0 whitespace-nowrap">MineGuard Liberia</span>
                <span className="stamp ml-auto shrink-0 text-[9px] text-muted-foreground">V1.0</span>
              </SheetTitle>
              <SheetDescription className="truncate text-[11px]">
                {user?.email ?? ""}
                <br />
                {identity}
              </SheetDescription>
            </SheetHeader>
            <nav aria-label="Operator" className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 py-4">
              <OperatorNavLinks
                items={navItems}
                onNavigate={() => setMobileNavOpen(false)}
              />
            </nav>
            <div className="shrink-0 space-y-2 border-t border-border bg-sidebar p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start text-muted-foreground"
                onClick={() => void handleSignOut()}
              >
                <LogOut className="size-3.5" /> Sign out
              </Button>
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </RequireOperator>
  );
}
