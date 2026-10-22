import { RouteLoading } from "@/components/RouteLoading";
import { useRecoveryState } from "@/hooks/use-recovery";
import { useEffect, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";

/** Where the set-new-password panel lives (see pages/Auth.tsx). */
export const RECOVERY_ROUTE = "/auth?mode=reset";

/** Holds a password-recovery session on the set-new-password screen.
 *
 *  A reset link signs the person in with a one-time session. Without this gate
 *  that session looked like any other sign-in: the app showed the landing page
 *  or portal and never asked for a new password. While a recovery is pending,
 *  every route except the reset panel is replaced by that panel; an expired or
 *  already-used link is sent to the sign-in page with an explanation. */
export function RecoveryGate({ children }: { children: ReactNode }) {
  const { pending, ready, linkError } = useRecoveryState();
  const location = useLocation();
  const navigate = useNavigate();

  const onResetScreen =
    location.pathname === "/auth" &&
    new URLSearchParams(location.search).get("mode") === "reset";
  const onAuthScreen = location.pathname === "/auth";

  useEffect(() => {
    if (!ready) return; // wait until supabase-js has finished reading the URL
    if (pending && !onResetScreen) navigate(RECOVERY_ROUTE, { replace: true });
    else if (!pending && linkError && !onAuthScreen) navigate("/auth", { replace: true });
  }, [ready, pending, linkError, onResetScreen, onAuthScreen, navigate]);

  // Never flash the landing page / portal (or a 404 for the raw token
  // fragment) while the redirect to the right screen is being resolved.
  if ((pending && !onResetScreen) || (!ready && !onAuthScreen && pending)) return <RouteLoading />;
  return <>{children}</>;
}
