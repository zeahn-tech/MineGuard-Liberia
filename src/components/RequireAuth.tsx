import { useAuth } from "@/hooks/use-auth";
import { isStaffRole, ROLES } from "@/lib/types";
import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";

/** Signed-in + at least one platform role (staff or operator). */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated, user } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </main>
    );
  }

  if (!isAuthenticated) {
    const returnTo = `${location.pathname}${location.search}`;
    return (
      <Navigate
        to={`/auth?returnTo=${encodeURIComponent(returnTo)}`}
        replace
      />
    );
  }

  if (!user?.role) {
    // A signed-in account with no assigned role has no portal surface at all.
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="max-w-md text-center">
          <p className="display text-lg">No portal role assigned</p>
          <p className="mt-2 text-sm text-muted-foreground">
            This account is signed in but has not been assigned a platform
            role. The program office assigns roles; until then there is no
            surface to show.
          </p>
        </div>
      </main>
    );
  }

  return children;
}

/** STAFF SECTION GATE — admin / supervisor / inspector only. An operator or
 *  unassigned account hitting any /portal/* staff route is bounced to their
 *  own section (operators) or a no-role notice. This is the structural
 *  complement of the server's RLS: the UI never renders a staff surface for
 *  a non-staff identity, and every staff QUERY underneath re-derives
 *  authorization server-side anyway. */
export function RequireStaff({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated, user } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </main>
    );
  }

  if (!isAuthenticated) {
    const returnTo = `${location.pathname}${location.search}`;
    return (
      <Navigate
        to={`/auth?returnTo=${encodeURIComponent(returnTo)}`}
        replace
      />
    );
  }

  if (user?.role && !isStaffRole(user.role)) {
    // Operators belong to the operator section — send them THERE, not to
    // sign-in (they are signed in; a redirect to /auth would loop).
    if (user.role === ROLES.OPERATOR) {
      return <Navigate to="/operate" replace />;
    }
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="max-w-md text-center">
          <p className="display text-lg">No staff surface for this account</p>
          <p className="mt-2 text-sm text-muted-foreground">
            This section is for oversight personnel. Your account has no staff
            role assigned.
          </p>
        </div>
      </main>
    );
  }

  return children;
}

/** OPERATOR SECTION GATE — operator role only. Any other authenticated
 *  identity (staff, unassigned) cannot render the operator section: staff
 *  are sent to the staff portal, unassigned to the no-role notice. */
export function RequireOperator({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated, user } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </main>
    );
  }

  if (!isAuthenticated) {
    const returnTo = `${location.pathname}${location.search}`;
    return (
      <Navigate
        to={`/auth?returnTo=${encodeURIComponent(returnTo)}`}
        replace
      />
    );
  }

  if (user?.role !== ROLES.OPERATOR) {
    return <Navigate to="/portal" replace />;
  }

  return children;
}
