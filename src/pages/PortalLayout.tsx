import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router";
import { useQuery, useMutation } from "@/lib/backend-react";
import { api } from "@/lib/backend";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { sectionJump } from "@/lib/utils";
import NotificationBell from "@/components/NotificationBell";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ClipboardList,
  CloudOff,
  Command,
  FileCheck2,
  HeartPulse,
  Loader2,
  Landmark,
  LayoutDashboard,
  Leaf,
  LogOut,
  Map,
  Menu,
  MessageSquareWarning,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  ShieldEllipsis,
  UserCog,
} from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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
import { toast } from "sonner";
import { ROLES } from "@/lib/types";

const NAV = [
  { to: "/portal", label: "Command Center", icon: LayoutDashboard },
  { to: "/portal/sites", label: "Mining Sites", icon: Landmark },
  { to: "/portal/map", label: "National Map", icon: Map },
  { to: "/portal/inspections", label: "Field Inspections", icon: FileCheck2 },
  { to: "/portal/incidents", label: "Incidents", icon: HeartPulse },
  { to: "/portal/environment", label: "Environment", icon: Leaf },
  { to: "/portal/community", label: "Community Reports", icon: MessageSquareWarning },
  { to: "/portal/audit", label: "Audit Log", icon: ScrollText },
  { to: "/portal/templates", label: "Templates", icon: ClipboardList },
  { to: "/portal/security", label: "Account Security", icon: ShieldEllipsis },
];

export default function PortalLayout() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [showProvision, setShowProvision] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [syncing, setSyncing] = useState(false);

  // Admin-only provisioning state
  const [targetEmail, setTargetEmail] = useState("");
  const [targetRole, setTargetRole] = useState<string>("inspector");
  const [targetScope, setTargetScope] = useState<string>("national");
  const [targetCounty, setTargetCounty] = useState("");
  const [targetOperator, setTargetOperator] = useState("");

  const isStaff =
    user?.role === "admin" || user?.role === "supervisor" || user?.role === "inspector";
  const isAdmin = user?.role === "admin";

  // First-run provisioning: first admin can assign roles; seed available to staff.
  const seedData = useMutation(api.seed.seedIfEmpty);
  const provision = useMutation(api.stats.provisionByEmail);
  const syncCreateDraft = useMutation(api.inspections.createDraft);
  const syncUpdateDraft = useMutation(api.inspections.updateDraft);
  const syncSubmit = useMutation(api.inspections.submit);
  const syncReportIncident = useMutation(api.records.reportIncident);
  const syncReportObservation = useMutation(api.records.reportObservation);
  const syncRespondCa = useMutation(api.inspections.respondCorrectiveAction);
  const syncUploadEvidence = useMutation(api.evidence.upload);
  const syncApi = useMemo(
    () => ({
      createDraft: syncCreateDraft,
      updateDraft: syncUpdateDraft,
      submit: syncSubmit,
      reportIncident: syncReportIncident,
      reportObservation: syncReportObservation,
      respondCorrectiveAction: syncRespondCa,
    }),
    [syncCreateDraft, syncUpdateDraft, syncSubmit, syncReportIncident, syncReportObservation, syncRespondCa],
  );

  // Profile completion gate: EVERY signed-in user must complete a profile
  // (not just staff) — the first email account to do so becomes the platform
  // administrator via the server-side bootstrap. Without this, a fresh
  // install could never create its first admin.
  useEffect(() => {
    if (!user) return;
    if (user.profileComplete !== true) setShowProfile(true);
  }, [user]);

  // NOTE (§20 structural split): operators no longer pass through here at
  // all — RequireStaff bounces them to /operate before this layout renders.
  // The old conditional-nav and root-redirect logic is gone.

  // Offline queue state (OFF-1/3): the scheduler owns startup / visibility /
  // online triggers, backoff timing and single-flight; this effect only
  // mirrors the durable queue into the header badge.
  const schedulerRef = useRef<SyncScheduler | null>(null);
  const apiRef = useRef(syncApi);
  apiRef.current = syncApi;
  const uploadRef = useRef(syncUploadEvidence);
  uploadRef.current = syncUploadEvidence;

  const announce = useCallback((r: SchedulerResult) => {
    const synced = (r.queue?.synced ?? 0) + (r.evidence?.synced ?? 0);
    const conflicts = r.queue?.conflicts ?? 0;
    const dead = (r.queue?.dead ?? 0) + (r.evidence?.dead ?? 0);
    const failed = (r.queue?.failed ?? 0) + (r.evidence?.failed ?? 0);
    if (synced > 0)
      toast.success(`Synced ${synced} queued item(s)`);
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
    // Proxy through the ref so a fresh useMutation identity never restarts
    // the scheduler (the scheduler must outlive renders).
    const api: SyncApi = {
      createDraft: (a) => apiRef.current.createDraft(a),
      updateDraft: (a) => apiRef.current.updateDraft(a),
      submit: (a) => apiRef.current.submit(a),
      reportIncident: (a) => apiRef.current.reportIncident(a),
      reportObservation: (a) => apiRef.current.reportObservation(a),
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
  }, [announce]);

  const handleSyncNow = async () => {
    const scheduler = schedulerRef.current;
    if (!scheduler) return;
    setSyncing(true);
    try {
      const r = await scheduler.syncNow();
      // Success/failure toasts come from announce() via onResult; this
      // branch only narrates the "nothing left to send" case.
      const synced = (r.queue?.synced ?? 0) + (r.evidence?.synced ?? 0);
      const failed = (r.queue?.failed ?? 0) + (r.evidence?.failed ?? 0);
      if (synced === 0 && failed === 0) {
        if (readQueue().filter((q) => q.status !== "done").length === 0)
          toast.info("Queue is empty");
        else
          toast.info("Nothing ready to send right now — items stay queued");
      }
      setQueue(readQueue());
    } finally {
      setSyncing(false);
    }
  };

  const pendingItems = useMemo(() => queue.filter((q) => q.status !== "done"), [queue]);

  const handleSeed = async () => {
    // Production builds carry no demo seeding (doc 14 deploy checklist item 4):
    // the button is not rendered and the path is refused here as defense in
    // depth — synthetic records must never enter a production tenant.
    if (import.meta.env.VITE_MINEGUARD_ENV === "production") {
      toast.error("Demo seeding is disabled in production deployments.");
      return;
    }
    try {
      const result = await seedData({});
      if (result?.seeded) toast.success("Demo data seeded (synthetic records)");
      else toast.info("Database already contains data — seed skipped");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Seed failed");
    }
  };

  const handleProvision = async () => {
    if (!targetEmail) return;
    try {
      await provision({
        email: targetEmail.toLowerCase(),
        role: targetRole as "admin" | "supervisor" | "inspector" | "operator",
        scope: targetScope as "national" | "county" | "site",
        county: targetCounty || undefined,
        operatorName: targetOperator || undefined,
      });
      toast.success(`Role assigned to ${targetEmail}`);
      setShowProvision(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to assign role");
    }
  };

  const navItems = NAV;

  return (
    <div className="min-h-screen bg-background">
      {/* Accessibility: keyboard users skip the sidebar straight to content */}
      <a
        href="#main-content"
        onClick={sectionJump("main-content")}
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
              <div className="kicker text-[10px]">Liberia</div>
            </div>
            <span className="ml-auto stamp text-[9px] text-muted-foreground">V1.0</span>
          </div>
          <nav className="flex-1 space-y-1 overflow-y-auto px-2 py-4">
            <NavLinks items={navItems} />
          </nav>
          <div className="border-t border-border p-3">
            <div className="mb-2 px-2 text-[11px] leading-snug text-muted-foreground">
              <span className="font-medium text-foreground">{user?.email}</span>
              <br />
              {user?.role ?? "unassigned"} · {user?.scope ?? "—"}
            </div>
            {user && user.profileComplete !== true && (
              <Button
                variant="outline"
                size="sm"
                className="mb-2 w-full justify-start"
                onClick={() => setShowProfile(true)}
              >
                <FileCheck2 className="size-3.5" /> Complete profile
              </Button>
            )}
            {isAdmin && (
              <Button
                variant="outline"
                size="sm"
                className="mb-2 w-full justify-start"
                onClick={() => setShowProvision(true)}
              >
                <UserCog className="size-3.5" /> Assign roles
              </Button>
            )}
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
            <div className="mt-2 border-t border-border pt-2">
              <NotificationBell />
            </div>
          </div>
        </aside>

        {/* Main */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur">
            <div className="flex items-center gap-3 px-4 py-3 md:px-6">
              <button
                onClick={() => setMobileNavOpen(true)}
                className="rounded-sm border border-border p-2 text-foreground transition-colors hover:bg-accent md:hidden"
                aria-label="Open navigation menu"
              >
                <Menu className="size-5" strokeWidth={1.5} />
              </button>
              <Link to="/portal" className="display text-sm md:hidden">
                MineGuard Liberia
              </Link>
              <div className="ml-auto flex items-center gap-2">
                {/* Mobile-only bell: on ≥md the sidebar footer bell serves
                    staff/admins; below md the sidebar is hidden, so the
                    notification entry point must live in the header. */}
                <div className="md:hidden">
                  <NotificationBell />
                </div>
                <QueueManagerButton
                  label={`Queue${pendingItems.length > 0 ? ` · ${pendingItems.length}` : ""}`}
                />
                {pendingItems.length > 0 ? (
                  <button
                    onClick={handleSyncNow}
                    disabled={syncing}
                    className="flex items-center gap-1.5 rounded-sm border border-destructive/40 bg-destructive/5 px-2.5 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
                  >
                    <CloudOff className="size-3.5" />
                    {/* Keep the label compact on phones so the bell beside it
                        stays visible; full wording on ≥sm. */}
                    <span>
                      {pendingItems.length} queued
                      <span className="hidden sm:inline"> offline</span>
                    </span>
                    <span className="hidden sm:inline">
                      {syncing ? " — syncing…" : " — tap to sync"}
                    </span>
                  </button>
                ) : (
                  <button
                    onClick={handleSyncNow}
                    disabled={syncing}
                    className="flex items-center gap-1.5 rounded-sm border border-border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent"
                  >
                    <RefreshCw className={`size-3.5 ${syncing ? "animate-spin" : ""}`} />
                    Queue synced
                  </button>
                )}
              </div>
            </div>
          </header>            <main id="main-content" tabIndex={-1} className="flex-1 px-4 py-6 md:px-8 md:py-8">
            <Outlet />
          </main>

          <footer className="border-t border-border px-4 py-4 text-[11px] text-muted-foreground md:px-8">
            MineGuard Liberia — government-ready architecture, designed for potential
            government adoption. Not an official Government of Liberia system.
          </footer>
        </div>
      </div>

      {/* Profile completion dialog. The ✕ (and Escape/backdrop) now dismiss
          it — unassigned accounts can still browse the portal, and the
          "Complete profile" button in the sidebar/drawer reopens this dialog. */}
      <Dialog open={showProfile} onOpenChange={setShowProfile}>
        <DialogContent className="paper">
          <DialogHeader>
            <DialogTitle>Complete your staff profile</DialogTitle>
            <DialogDescription>
              Your access scope. You can also be provisioned by an administrator.
            </DialogDescription>
          </DialogHeader>
          <ProfileForm
            onDone={() => setShowProfile(false)}
            defaultScope={user?.scope ?? "national"}
          />
        </DialogContent>
      </Dialog>

      {/* Mobile navigation drawer — slides in from the left, mirrors the
          desktop sidebar. Tapping a link navigates and slides it back. */}
      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent
          side="left"
          className="w-72 bg-sidebar p-0 sm:max-w-[18rem]"
        >
          <SheetHeader className="border-b border-border px-4 py-5 text-left">
            <SheetTitle className="flex items-center gap-2 text-sm">
              <ShieldCheck className="size-5" strokeWidth={1.5} />
              <span className="display">MineGuard</span>
              <span className="kicker text-[10px]">Liberia</span>
              <span className="stamp ml-auto text-[9px] text-muted-foreground">
                V1.0
              </span>
            </SheetTitle>
            <SheetDescription className="truncate text-[11px]">
              {user?.email ?? ""}
              <br />
              {user?.role ?? "unassigned"} · {user?.scope ?? "—"}
            </SheetDescription>
          </SheetHeader>
          <nav className="flex-1 space-y-1 overflow-y-auto px-2 py-4">
            <NavLinks
              items={navItems}
              onNavigate={() => setMobileNavOpen(false)}
            />
          </nav>
          <div className="space-y-2 border-t border-border p-3">
            {user && user.profileComplete !== true && (
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-start"
                onClick={() => {
                  setMobileNavOpen(false);
                  setShowProfile(true);
                }}
              >
                <FileCheck2 className="size-3.5" /> Complete profile
              </Button>
            )}
            {isAdmin && (
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-start"
                onClick={() => {
                  setMobileNavOpen(false);
                  setShowProvision(true);
                }}
              >
                <UserCog className="size-3.5" /> Assign roles
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start text-muted-foreground"
              onClick={async () => {
                setMobileNavOpen(false);
                await signOut();
                navigate("/");
              }}
            >
              <LogOut className="size-3.5" /> Sign out
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      {/* Admin provisioning dialog */}
      <Dialog open={showProvision} onOpenChange={setShowProvision}>
        <DialogContent className="paper">
          <DialogHeader>
            <DialogTitle>Assign platform role</DialogTitle>
            <DialogDescription>
              Server-side authorization is derived from this assignment. All changes are
              audit logged.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="prov-email">User email</Label>
              <Input
                id="prov-email"
                value={targetEmail}
                onChange={(e) => setTargetEmail(e.target.value)}
                placeholder="officer@example.gov"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Role</Label>
                <Select value={targetRole} onValueChange={setTargetRole}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="admin">Admin</SelectItem>
                    <SelectItem value="supervisor">Supervisor</SelectItem>
                    <SelectItem value="inspector">Inspector</SelectItem>
                    <SelectItem value="operator">Operator</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Scope</Label>
                <Select value={targetScope} onValueChange={setTargetScope}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="national">National</SelectItem>
                    <SelectItem value="county">County</SelectItem>
                    <SelectItem value="site">Site</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {targetScope === "county" && (
              <div className="space-y-1.5">
                <Label htmlFor="prov-county">County</Label>
                <Input
                  id="prov-county"
                  value={targetCounty}
                  onChange={(e) => setTargetCounty(e.target.value)}
                  placeholder="Nimba"
                />
              </div>
            )}
            {targetRole === "operator" && (
              <div className="space-y-1.5">
                <Label htmlFor="prov-operator">Operator organization</Label>
                <Input
                  id="prov-operator"
                  value={targetOperator}
                  onChange={(e) => setTargetOperator(e.target.value)}
                  placeholder="Must match site operatorName exactly"
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowProvision(false)}>
              Cancel
            </Button>
            <Button onClick={handleProvision} disabled={!targetEmail}>
              Assign role
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dev seed — admin only, non-production builds only (doc 14 item 4) */}
      {isAdmin && import.meta.env.VITE_MINEGUARD_ENV !== "production" && (
        <SeedButton onSeed={handleSeed} />
      )}
    </div>
  );
}

// Shared navigation list: rendered in the desktop sidebar and the mobile
// drawer so both surfaces always show the same tabs.
function NavLinks({
  items,
  onNavigate,
}: {
  items: typeof NAV;
  onNavigate?: () => void;
}) {
  return (
    <>
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === "/portal"}
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

function SeedButton({ onSeed }: { onSeed: () => void }) {
  return (
    <button
      onClick={onSeed}
      className="fixed bottom-4 right-4 z-30 flex items-center gap-1.5 rounded-sm border border-border bg-card px-3 py-2 text-xs text-muted-foreground shadow-sm transition-colors hover:bg-accent"
    >
      <Command className="size-3.5" /> Load demo data
    </button>
  );
}

function ProfileForm({ onDone, defaultScope }: { onDone: () => void; defaultScope: string }) {
  const [jobTitle, setJobTitle] = useState("");
  const [organization, setOrganization] = useState("");
  const [scope, setScope] = useState(defaultScope);
  const [saving, setSaving] = useState(false);
  const complete = useMutation(api.stats.completeProfile);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await complete({
        jobTitle: jobTitle || "Field Officer",
        organization: organization || "MineGuard Program",
        scope: scope as never,
      });
      toast.success("Profile saved");
      onDone();
    } catch (e) {
      // Normalized via backendError(), but belt-and-braces: a non-Error
      // rejection (plain PostgREST object, network failure, …) stringifies as
      // "[object Object]" — never show that to the user.
      const raw = e instanceof Error ? e.message : String(e);
      const msg = !raw || raw === "[object Object]" ? "" : raw;
      const friendly =
        msg === "FORBIDDEN"
          ? "You don't have permission to complete this profile. Contact a program administrator."
          : msg === "UNAUTHENTICATED"
            ? "Your session has expired — please sign in again."
            : msg.startsWith("Your account has no profile row")
              ? msg
              : msg.includes("row-level security") || msg.includes("42501")
                ? "Server rejected the profile update (permission boundary)."
                : msg.includes("UNREGISTERED_USER")
                  ? "Your account has no profile row yet — reload the page and try again."
                  : msg.includes("GUEST_ACCOUNT")
                    ? "Guest accounts cannot complete a staff profile. Sign up with an email account."
                    : msg || "Failed to save profile — please try again.";
      toast.error(friendly);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="pf-title">Job title</Label>
        <Input id="pf-title" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="pf-org">Organization</Label>
        <Input id="pf-org" value={organization} onChange={(e) => setOrganization(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label>Scope</Label>
        <Select value={scope} onValueChange={setScope}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="national">National</SelectItem>
            <SelectItem value="county">County</SelectItem>
            <SelectItem value="site">Site</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Button className="w-full" onClick={save} disabled={saving}>
        {saving ? (
          <>
            <Loader2 className="size-4 animate-spin" /> Saving…
          </>
        ) : (
          "Save profile"
        )}
      </Button>
    </div>
  );
}


