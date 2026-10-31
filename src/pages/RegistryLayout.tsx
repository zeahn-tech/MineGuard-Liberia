// ---------------------------------------------------------------------------
// COMPANY REGISTRY (registrar workspace). The dedicated Ministry "Company
// registrar" role authorizes companies and appoints their first administrator —
// nothing else. It deliberately has no access to sites, incidents, inspections,
// audit records, accounts or any company's workforce; the database enforces that.
// ---------------------------------------------------------------------------

import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { LogOut } from "lucide-react";

const link = ({ isActive }: { isActive: boolean }) =>
  `rounded-md px-2.5 py-1.5 text-sm ${isActive ? "bg-accent font-medium" : "text-muted-foreground hover:text-foreground"}`;
import { NavLink, Outlet } from "react-router";
import NotificationBell from "@/components/NotificationBell";

export default function RegistryLayout() {
  const { user, signOut } = useAuth();
  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="kicker">MineGuard Liberia · Ministry</p>
            <p className="display text-base">Company registry</p>
          </div>
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <nav aria-label="Registry" className="flex items-center gap-1">
              <NavLink to="/registry" end className={link}>Companies</NavLink>
              <NavLink to="/registry/security" className={link}>Account security</NavLink>
            </nav>
            <NotificationBell />
            <span className="hidden min-w-0 truncate text-xs text-muted-foreground lg:block">{user?.email}</span>
            <Button variant="ghost" size="sm" onClick={() => void signOut()} aria-label="Sign out">
              <LogOut className="size-4" /> <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>
        </div>
      </header>
      <main id="main-content" tabIndex={-1} className="mx-auto max-w-5xl min-w-0 px-4 py-6 sm:py-8">
        <Outlet />
      </main>
    </div>
  );
}
