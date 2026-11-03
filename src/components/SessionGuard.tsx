import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ACTIVITY_KEY,
  IDLE_LIMIT_MS,
  WARNING_MS,
  formatCountdown,
  idleState,
  type IdleState,
} from "@/lib/session-expiry";

// ---------------------------------------------------------------------------
// SESSION GUARD — signs people out after IDLE_LIMIT_MS of inactivity, kindly.
//
//  1. A minute before, a dialog says what is about to happen, shows a real
//     countdown, and offers "Stay signed in".
//  2. At the limit, the person is signed out WITHOUT wiping anything on the
//     device (signOutIdle): queued reports, inspection drafts and in-progress
//     report forms (useFormDraft) are kept.
//  3. The sign-in screen then says what happened, why, and that work is kept,
//     and returns the person to the page they were on.
//
// Activity is shared across tabs, so working in one tab keeps the others alive.
//
// OFFLINE: signing someone out when they cannot sign back in would strand a
// field worker. While offline the sign-out is deferred; if the person is still
// idle when the connection returns, it happens then.
// ---------------------------------------------------------------------------

const ACTIVITY_EVENTS = ["pointerdown", "keydown", "touchstart", "wheel"] as const;
/** At most one localStorage write per this long, so activity is cheap. */
const WRITE_THROTTLE_MS = 5_000;

export interface SessionGuardProps {
  limitMs?: number;
  warnMs?: number;
  tickMs?: number;
  /** Sign out for inactivity (keeps work). Defaults to the backend's signOutIdle. */
  onExpire?: () => Promise<void>;
  /** Sign out right now from the dialog. Defaults to the backend's signOut. */
  onSignOutNow?: () => Promise<void>;
}

async function defaultExpire() {
  const m = await import("@/lib/backend");
  try {
    await m.signOutIdle();
  } catch {
    // The network call failed (or a lock is held): drop this device's session
    // locally instead so the person is never left signed in past the limit.
    const s = await import("@/lib/supabase");
    await s.resetLocalSession();
  }
}

async function defaultSignOutNow() {
  const m = await import("@/lib/backend");
  await m.signOut();
}

export function SessionGuard({
  limitMs = IDLE_LIMIT_MS,
  warnMs = WARNING_MS,
  tickMs = 1_000,
  onExpire = defaultExpire,
  onSignOutNow = defaultSignOutNow,
}: SessionGuardProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [idle, setIdle] = useState<IdleState>({ phase: "active", msLeft: limitMs });

  const lastActive = useRef(0);
  const lastWrite = useRef(0);
  const expiring = useRef(false);
  const where = useRef(`${location.pathname}${location.search}`);
  const cbs = useRef({ onExpire, onSignOutNow });
  useEffect(() => {
    where.current = `${location.pathname}${location.search}`;
    cbs.current = { onExpire, onSignOutNow };
  });

  useEffect(() => {
    lastActive.current = Date.now();
    expiring.current = false;

    const touch = () => {
      const now = Date.now();
      lastActive.current = now;
      if (now - lastWrite.current > WRITE_THROTTLE_MS) {
        lastWrite.current = now;
        try {
          localStorage.setItem(ACTIVITY_KEY, String(now));
        } catch {
          /* private mode: this tab's own activity still counts */
        }
      }
    };

    const leave = async (fn: () => Promise<void>, to: string) => {
      if (expiring.current) return;
      expiring.current = true;
      try {
        await fn();
      } finally {
        navigate(to, { replace: true });
      }
    };

    const tick = () => {
      let shared = 0;
      try {
        shared = Number(localStorage.getItem(ACTIVITY_KEY)) || 0;
      } catch {
        /* ignore */
      }
      const s = idleState(Math.max(lastActive.current, shared), Date.now(), limitMs, warnMs);
      setIdle((prev) => (prev.phase === "active" && s.phase === "active" ? prev : s));
      if (s.phase === "expired" && navigator.onLine !== false) {
        void leave(
          () => cbs.current.onExpire(),
          `/auth?returnTo=${encodeURIComponent(where.current)}`,
        );
      }
    };

    for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, touch, { passive: true, capture: true });
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", tick);
    const timer = setInterval(tick, tickMs);
    return () => {
      clearInterval(timer);
      for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, touch, { capture: true });
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", tick);
    };
  }, [limitMs, warnMs, tickMs, navigate]);

  const stay = () => {
    const now = Date.now();
    lastActive.current = now;
    try {
      localStorage.setItem(ACTIVITY_KEY, String(now));
    } catch {
      /* ignore */
    }
    setIdle({ phase: "active", msLeft: limitMs });
  };

  const signOutNow = async () => {
    if (expiring.current) return;
    expiring.current = true;
    try {
      await cbs.current.onSignOutNow();
    } finally {
      navigate("/", { replace: true });
    }
  };

  return (
    <AlertDialog open={idle.phase === "warning"}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Are you still there?</AlertDialogTitle>
          <AlertDialogDescription>
            For your safety we sign you out after 30 minutes of inactivity. You'll be signed out in{" "}
            <strong aria-hidden="true" data-testid="idle-countdown">
              {formatCountdown(idle.msLeft)}
            </strong>
            <span className="sr-only">less than a minute</span>. Work you've saved or queued, and report forms
            you're filling in, are kept on this device either way.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => void signOutNow()}>Sign out now</AlertDialogCancel>
          <AlertDialogAction onClick={stay}>Stay signed in</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
