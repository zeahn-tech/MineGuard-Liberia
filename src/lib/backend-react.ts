// ---------------------------------------------------------------------------
// CONVEX-COMPATIBLE REACT HOOKS OVER FIREBASE
//
// useQuery(fn, args) — subscribes to live data, returns undefined while
// loading (identical semantics to convex/react's useQuery). `fn` is a
// function taking the args object and returning a QueryHandle.
// useMutation(fn) — returns a callable wrapping the async backend function.
//
// Queries re-subscribe whenever Firebase auth state changes so data
// refreshes on sign-in/sign-out.
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "./firebase";
import type { QueryHandle } from "./backend";

/** Track auth state transitions so queries re-run after sign-in/out. */
export function useAuthEpoch(): number {
  const [epoch, setEpoch] = useState(0);
  useEffect(() => onAuthStateChanged(auth, () => setEpoch((e) => e + 1)), []);
  return epoch;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useQuery<T = any>(
  fn: (args?: any) => QueryHandle<T>,
  args?: unknown,
): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined);
  const epoch = useAuthEpoch();
  const fnRef = useRef(fn);
  fnRef.current = fn;
  // Convex "skip" sentinel: keep the query undefined without subscribing.
  const skipped = args === "skip";
  // Args are often inline object literals; key on their JSON so identical
  // values don't resubscribe every render.
  const argsKey = skipped || args === undefined ? "" : JSON.stringify(args);

  useEffect(() => {
    if (skipped) return;
    let cancelled = false;
    let unsub: (() => void) | undefined;
    try {
      const handle = fnRef.current(skipped ? undefined : args);
      unsub = handle.subscribe((v) => {
        if (!cancelled) setValue(v);
      });
    } catch (err) {
      console.error("[backend] query setup failed:", err);
      if (!cancelled) setValue(undefined);
    }
    return () => {
      cancelled = true;
      unsub?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epoch, argsKey]);

  return value;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useMutation(
  fn: (...args: any[]) => Promise<any>,
): (...args: any[]) => Promise<any> {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (...args: any[]) => fnRef.current(...args);
}

export function useIsAuthenticated(): {
  isLoading: boolean;
  isAuthenticated: boolean;
} {
  const [state, setState] = useState<{ ready: boolean; authed: boolean }>({
    ready: false,
    authed: false,
  });
  useEffect(
    () =>
      onAuthStateChanged(auth, (u) => {
        setState({ ready: true, authed: !!u });
      }),
    [],
  );
  return { isLoading: !state.ready, isAuthenticated: state.authed };
}
