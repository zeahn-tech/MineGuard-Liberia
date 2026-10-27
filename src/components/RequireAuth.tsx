import { useAuth } from "@/hooks/use-auth";
import { isStaffRole, ROLES } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { getLoadProblems, subscribeLoadProblems } from "@/lib/backend";
import { resetLocalSession } from "@/lib/supabase";
import { Loader2 } from "lucide-react";
import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Link, Navigate, useLocation } from "react-router";

/** Full-screen gate while auth resolves. BOUNDED: if the profile query
 *  cannot load (network/backend failure), the gate used to spin forever —
 *  the reported "loads forever" failure mode. After 12s it switches to an
 *  honest message; the query layer keeps retrying underneath (and re-reads the
 *  moment the tab is visible or the connection returns), so a recovered backend
 *  lands the user straight in the portal.
 *
 *  The REAL reason is shown on screen — a phone has no console to look in — and
 *  there is a recovery that changes something: "Try again" only reloads into
 *  the same state, while "Sign out and start over" drops this device's session
 *  (stale refresh token, stuck auth lock) without touching queued field work. */
export function AuthLoading({
  slowAfterMs = 12_000,
  autoResetAfterMs = 6_000,
}: {
  slowAfterMs?: number;
  /** A stored session whose profile still has not loaded after this long (while
   *  ONLINE) is treated as unrestorable — the same thing the person did by hand
   *  with "Sign out and start over": this device's session is dropped and the
   *  sign-in screen opens by itself. Queued field work is untouched. Offline, it
   *  keeps waiting: a real session on a dead connection must not be discarded. */
  autoResetAfterMs?: number;
}) {
  const [slow, setSlow] = useState(false);
  const [resetting, setResetting] = useState(false);
  const problems = useSyncExternalStore(subscribeLoadProblems, getLoadProblems);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), slowAfterMs);
    return () => clearTimeout(t);
  }, [slowAfterMs]);

  useEffect(() => {
    const t = setTimeout(() => {
      if (typeof navigator !== "undefined" && navigator.onLine === false)
        return;
      void (async () => {
        setResetting(true);
        await resetLocalSession();
        window.location.replace(
          `${window.location.pathname}${window.location.search}#/auth`,
        );
        window.location.reload();
      })();
    }, autoResetAfterMs);
    return () => clearTimeout(t);
  }, [autoResetAfterMs]);

  if (!slow) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </main>
    );
  }

  const reason = problems.find((p) => p.scope === "profiles") ?? problems[0];
  const startOver = async () => {
    setResetting(true);
    await resetLocalSession();
    window.location.assign(
      `${window.location.pathname}${window.location.search}#/auth`,
    );
    window.location.reload();
  };
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-6">
      <div className="max-w-md text-center" role="alert">
        <p className="display text-lg">Still loading your account</p>
        <p className="mt-2 text-sm text-muted-foreground">
          This is taking longer than usual. It keeps retrying in the background
          and will continue by itself when the connection recovers.
        </p>
        <p
          className="mt-3 break-words text-xs text-muted-foreground"
          data-testid="auth-problem"
        >
          {reason
            ? `What we found: ${reason.message} (${reason.scope})`
            : "No answer from the server yet — check your connection."}
        </p>
        <div className="mt-4 flex flex-col items-center gap-2 sm:flex-row sm:justify-center">
          <Button onClick={() => window.location.reload()} disabled={resetting}>
            Try again
          </Button>
          <Button
            variant="outline"
            onClick={() => void startOver()}
            disabled={resetting}
          >
            {resetting ? "Signing out…" : "Sign out and start over"}
          </Button>
        </div>
        <p className="mt-3 text-[11px] text-muted-foreground">
          Signing out only affects this device. Work queued for upload stays on
          it.
        </p>
      </div>
    </main>
  );
}

/** Signed-in + at least one platform role (staff or operator). */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated, user } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return <AuthLoading />;
  }

  if (!isAuthenticated) {
    const returnTo = `${location.pathname}${location.search}`;
    return (
      <Navigate to={`/auth?returnTo=${encodeURIComponent(returnTo)}`} replace />
    );
  }

  if (!user?.role) {
    // A signed-in account with no assigned role has no portal surface at all.
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background p-6">
        <div className="max-w-md text-center">
          <p className="display text-lg">No portal role assigned</p>
          <p className="mt-2 text-sm text-muted-foreground">
            This account is signed in but has not been assigned a platform role.
            The program office assigns roles; until then there is no surface to
            show.
          </p>
          <p className="mt-4 text-sm">
            <Link className="underline" to="/invitation">I have an invitation</Link>
            {" · "}
            <Link className="underline" to="/join">Request to join a company</Link>
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
    return <AuthLoading />;
  }

  if (!isAuthenticated) {
    const returnTo = `${location.pathname}${location.search}`;
    return (
      <Navigate to={`/auth?returnTo=${encodeURIComponent(returnTo)}`} replace />
    );
  }

  if (user?.role && !isStaffRole(user.role)) {
    // Operators belong to the operator section — send them THERE, not to
    // sign-in (they are signed in; a redirect to /auth would loop).
    if (user.role === ROLES.OPERATOR) {
      return <Navigate to="/operate" replace />;
    }
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background p-6">
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
    return <AuthLoading />;
  }

  if (!isAuthenticated) {
    const returnTo = `${location.pathname}${location.search}`;
    return (
      <Navigate to={`/auth?returnTo=${encodeURIComponent(returnTo)}`} replace />
    );
  }

  if (user?.role !== ROLES.OPERATOR) {
    return <Navigate to="/portal" replace />;
  }

  return children;
}
