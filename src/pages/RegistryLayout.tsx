// ---------------------------------------------------------------------------
// COMPANY REGISTRY (registrar workspace). The dedicated Ministry "Company
// registrar" role authorizes companies and appoints their first administrator —
// nothing else. It deliberately has no access to sites, incidents, inspections,
// audit records, accounts or any company's workforce; the database enforces that.
//
// The shell (desktop sidebar, sticky header, mobile navigation drawer, sign-out)
// deliberately mirrors the staff portal (PortalLayout) so the Ministry's
// workspaces look and behave the same. Only the navigation differs: the
// registrar sees two destinations, nothing else.
// ---------------------------------------------------------------------------

import { useState } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router";
import { Building2, LogOut, Menu, RefreshCw, ShieldEllipsis } from "lucide-react";
import { toast } from "sonner";
import { BrandMark } from "@/components/BrandMark";
import { LegalLinks } from "@/components/LegalLayout";
import NotificationBell from "@/components/NotificationBell";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useAuth } from "@/hooks/use-auth";
import { refreshAllData } from "@/lib/backend";
import { sectionJump } from "@/lib/utils";

const NAV: { to: string; label: string; icon: typeof Building2; end?: boolean }[] = [
  { to: "/registry", label: "Companies", icon: Building2, end: true },
  { to: "/registry/security", label: "Account Security", icon: ShieldEllipsis },
];

// Shared navigation list: rendered in the desktop sidebar and the mobile
// drawer so both surfaces always show the same destinations.
function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <>
      {NAV.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
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

export default function RegistryLayout() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const handleSignOut = async () => {
    setMobileNavOpen(false);
    await signOut();
    navigate("/");
  };

  const handleRefresh = () => {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      toast.info("You're offline — data will refresh once you reconnect");
      return;
    }
    // Re-read whatever screen is open from the server.
    refreshAllData();
    toast.success("Data refreshed");
  };

  const identity = `${user?.role ?? "unassigned"} · ${user?.scope ?? "—"}`;

  return (
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
            <span className="display min-w-0 text-sm whitespace-nowrap">MineGuard Liberia</span>
            <span className="stamp ml-auto shrink-0 text-[9px] text-muted-foreground">V1.0</span>
          </div>
          <nav aria-label="Registry" className="flex-1 space-y-1 overflow-y-auto px-2 py-4">
            <NavLinks />
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

        {/* Main */}
        <div className="flex min-w-0 flex-1 flex-col">
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
              <Link to="/registry" className="display text-sm md:hidden">
                MineGuard Liberia
              </Link>
              <p className="kicker hidden md:block">Ministry · Company registry</p>
              <div className="ml-auto flex items-center gap-2">
                {/* Mobile-only bell: on ≥md the sidebar footer bell serves the
                    registrar; below md the sidebar is hidden, so the
                    notification entry point must live in the header. */}
                <div className="md:hidden">
                  <NotificationBell />
                </div>
                <button
                  type="button"
                  onClick={handleRefresh}
                  aria-label="Refresh — reload data"
                  title="Refresh — reload data"
                  className="flex items-center gap-1.5 rounded-sm border border-border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent"
                >
                  <RefreshCw className="size-3.5" />
                  {/* icon-only on phones: a label overflows 320px */}
                  <span className="hidden sm:inline">Refresh</span>
                </button>
              </div>
            </div>
          </header>
          <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 px-4 py-6 md:px-8 md:py-8">
            <Outlet />
          </main>

          <footer className="border-t border-border px-4 py-4 text-[11px] text-muted-foreground md:px-8 print:hidden">
            MineGuard Liberia — government-ready architecture, designed for potential
            government adoption. Not an official Government of Liberia system.{" "}
            <LegalLinks />
          </footer>
        </div>
      </div>

      {/* Mobile navigation drawer — slides in from the left, mirrors the
          desktop sidebar. Tapping a link navigates and slides it back. */}
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
          <nav aria-label="Registry" className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 py-4">
            <NavLinks onNavigate={() => setMobileNavOpen(false)} />
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
  );
}
