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
import { api } from "@/lib/backend";
import { useQuery } from "@/lib/backend-react";
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
    // No assigned role: the only surface is accepting an invitation / requesting to join.
    return <NoRoleScreen />;
  }

  return children;
}

/** An invite email lands on the site root (the app uses a hash router, so the
 *  email cannot deep-link). If the signed-in person has an invitation waiting,
 *  send them straight to it; otherwise show the notice with the next steps. */
function NoRoleScreen() {
  const invitations = useQuery(api.companies.myInvitations);
  if (invitations === undefined) return <AuthLoading />;
  if (invitations.length > 0) return <Navigate to="/invitation" replace />;
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

/** A role-less account reaching a staff route. (1) A waiting company invitation
 *  wins: go accept it. (2) Otherwise show a neutral notice. There is deliberately NO
 *  "I am Ministry staff" self-onboarding choice any more (migration 0047): Ministry and
 *  inspection staff receive their role from an administrator before they can complete a
 *  staff profile, and company people join through an invitation or a membership request.
 *  Convenience only: the server decides what any account can actually do. */
function RolelessGate() {
  const invitations = useQuery(api.companies.myInvitations);
  const accessClass = useQuery(api.account.accessClass);
  if (invitations === undefined) return <AuthLoading />;
  if (invitations.length > 0) return <Navigate to="/invitation" replace />;
  if (accessClass === undefined) return <AuthLoading />;
  // Public accounts and guests have their own, separate area (Public User programme, Phase D): they
  // are never parked on a staff gate. Routing convenience only — the database decides access.
  if (accessClass === "anonymous_guest") return <Navigate to="/public" replace />;
  if (accessClass === "public_user" || accessClass === "public_user_unverified" || accessClass === "restricted") {
    return <Navigate to="/account" replace />;
  }
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-6">
      <div className="w-full max-w-md space-y-3 text-center">
        <p className="display text-lg">Your account is registered</p>
        <p className="text-sm text-muted-foreground">
          It has no platform role yet, so there is no workspace to open here. Ministry and inspection
          staff are given their role by a program administrator; company staff join through an
          invitation or a membership request.
        </p>
        <Link to="/join" className="block rounded-md border p-4 text-left text-sm hover:bg-muted/40">
          <span className="font-medium">I work for a mining company</span>
          <span className="mt-1 block text-xs text-muted-foreground">
            Accept an invitation or ask your company to add you.
          </span>
        </Link>
        <Link to="/report" className="block rounded-md border p-4 text-left text-sm hover:bg-muted/40">
          <span className="font-medium">Report a mining concern</span>
          <span className="mt-1 block text-xs text-muted-foreground">
            Anyone can submit a safety or environmental concern and track it.
          </span>
        </Link>
      </div>
    </main>
  );
}


/** Pages for a signed-in PUBLIC account (My reports, Feedback). Routing convenience only: every
 *  read and write behind these pages is enforced by the database (migrations 0048/0049), so this
 *  never decides what anyone can access. Guests are sent to sign in, unverified accounts are told
 *  to verify their e-mail, and company or staff accounts go to their own workspace. */
export function RequirePublicAccount({ children }: { children: React.ReactNode }) {
  const { isLoading, isAuthenticated } = useAuth();
  const accessClass = useQuery(api.account.accessClass, isAuthenticated ? undefined : "skip");
  const location = useLocation();
  if (isLoading) return <AuthLoading />;
  if (!isAuthenticated) return <Navigate to="/auth" state={{ from: location.pathname }} replace />;
  if (accessClass === undefined) return <AuthLoading />;
  if (accessClass === "public_user" || accessClass === "restricted") return <>{children}</>;
  if (accessClass === "staff") return <Navigate to="/portal" replace />;
  if (accessClass === "company_member") return <Navigate to="/operate" replace />;
  const unverified = accessClass === "public_user_unverified";
  const guest = accessClass === "anonymous_guest";
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-6">
      <div className="w-full max-w-md space-y-3 text-center">
        <p className="display text-lg">
          {guest ? "Create an account first" : unverified ? "Verify your e-mail first" : "This area is not available"}
        </p>
        <p className="text-sm text-muted-foreground">
          {guest
            ? "Guests can read public information and send an anonymous report. An account is needed to follow your own reports or send feedback."
            : unverified
              ? "Open the confirmation link we e-mailed you, then come back. Until then you can still read public information and send reports anonymously."
              : "Your account type does not use this area. You can still read public information and send an anonymous report."}
        </p>
        <Link to="/public" className="block rounded-md border p-4 text-sm hover:bg-muted/40">
          Read public information
        </Link>
        <Link to="/report" className="block rounded-md border p-4 text-sm hover:bg-muted/40">
          Send an anonymous report
        </Link>
      </div>
    </main>
  );
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

  if (!user?.role) {
    // No role yet: a company invitee must never be dropped into the staff portal.
    // See RolelessGate.
    return <RolelessGate />;
  }

  if (user?.role && !isStaffRole(user.role)) {
    // Operators belong to the operator section — send them THERE, not to
    // sign-in (they are signed in; a redirect to /auth would loop).
    if (user.role === ROLES.OPERATOR) {
      return <Navigate to="/operate" replace />;
    }
    if (user.role === ROLES.REGISTRAR) {
      return <Navigate to="/registry" replace />;
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

  if (user?.role === ROLES.REGISTRAR) {
    return <Navigate to="/registry" replace />;
  }
  if (user?.role !== ROLES.OPERATOR) {
    return <Navigate to="/portal" replace />;
  }

  return children;
}

/** REGISTRY SECTION GATE — the Company registrar only. Everyone else is sent to
 *  their own section (the database is the real boundary; this is routing). */
export function RequireRegistrar({ children }: { children: ReactNode }) {
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

  if (user?.role !== ROLES.REGISTRAR) {
    return <Navigate to={user?.role === ROLES.OPERATOR ? "/operate" : "/portal"} replace />;
  }

  return children;
}
