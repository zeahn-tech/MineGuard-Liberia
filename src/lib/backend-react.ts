// ---------------------------------------------------------------------------
// CONVEX-COMPATIBLE REACT HOOKS OVER SUPABASE
//
// useQuery(fn, args) — subscribes to live data, returns undefined while
// loading (identical semantics to convex/react's useQuery). `fn` is a
// function taking the args object and returning a QueryHandle.
// useMutation(fn) — returns a callable wrapping the async backend function.
//
// PERFORMANCE MODEL (this is what makes tab switches instant):
//  1. Subscriptions are SHARED per (query function, args). Twenty components
//     reading the same query = one network loop, not twenty.
//  2. Cache entries outlive unmount (KEEPALIVE_MS). Navigating to another tab
//     and back replays the last value SYNCHRONOUSLY, then refreshes in the
//     background — no loading flash, no re-download.
//  3. Auth state is a module-level store (src/lib/supabase.ts); sign-in/out
//     bumps a single epoch that auth-bound subscriptions re-derive from.
//     Non-auth-bound subscriptions (public stats, tracking) survive epochs.
//  4. useSyncExternalStore drives re-renders straight from the cache — no
//     per-component state copies, no extra render passes.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import {
  authUserId,
  isAuthReady,
  onAuthStateChangedSupabase,
  onProfileVersionChanged,
} from "./supabase";
import type { QueryHandle } from "./backend";

type Listener = () => void;

// Query handles may declare themselves auth-bound: their result depends on
// who is signed in, so an auth change must re-derive them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandle = QueryHandle<any> & { authBound?: boolean };

interface CacheEntry {
  value: unknown | undefined; // undefined = not yet loaded
  hasValue: boolean;
  listeners: Set<Listener>;
  handle: AnyHandle | null;
  unsubHandle: (() => void) | null;
  epoch: number; // auth epoch this subscription was established under
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type QueryFn = (args?: any) => AnyHandle;

const CACHE = new Map<string, CacheEntry>();

/** How long an unused cache entry stays subscribed after its last consumer
 *  goes away. Long enough that tab A → B → A never refetches; short enough
 *  that sign-out doesn't linger another user's data for long. */
const KEEPALIVE_MS = 90_000;

function getEntry(key: string): CacheEntry {
  let e = CACHE.get(key);
  if (!e) {
    e = {
      value: undefined,
      hasValue: false,
      listeners: new Set(),
      handle: null,
      unsubHandle: null,
      epoch: -1,
    };
    CACHE.set(key, e);
  }
  return e;
}

function notify(e: CacheEntry) {
  for (const l of e.listeners) l();
}

/** Establish or refresh the underlying live subscription for a cache entry.
 *  Skipped entirely when a valid subscription already exists. */
function ensureSubscribed(
  key: string,
  fn: QueryFn,
  args: unknown,
  epoch: number,
) {
  const e = getEntry(key);
  if (e.unsubHandle) {
    const authBound = e.handle?.authBound === true;
    // Non-auth-bound subscriptions (public stats doc) stay valid forever.
    // Auth-bound ones stay valid only within the epoch they were built in.
    if (!authBound || e.epoch === epoch) return;
    e.unsubHandle();
    e.unsubHandle = null;
    // Auth changed underneath an auth-bound query: back to loading.
    e.value = undefined;
    e.hasValue = false;
  }
  // Resubscribing after keepalive teardown within the same epoch: keep the
  // cached value so consumers replay it instantly; the fetcher will deliver
  // a fresh copy momentarily.
  e.epoch = epoch;
  e.handle = fn(args);
  e.unsubHandle = e.handle.subscribe((v) => {
    if (!e.hasValue && v === undefined) return; // remain "loading"
    e.value = v;
    e.hasValue = true;
    notify(e);
  });
}

function releaseSubscription(key: string) {
  const e = CACHE.get(key);
  if (!e) return;
  if (e.listeners.size > 0) return; // another consumer took over
  const scheduleTeardown = () => {
    window.setTimeout(() => {
      const cur = CACHE.get(key);
      if (!cur || cur.listeners.size > 0) return;
      const idleFor = Date.now() - lastActiveAt(key);
      if (idleFor < KEEPALIVE_MS) {
        // Activity happened after this timer was scheduled — re-arm.
        scheduleTeardown();
        return;
      }
      cur.unsubHandle?.();
      cur.unsubHandle = null;
      cur.handle = null;
      // NOTE: cached value is intentionally kept so a remount replays it.
    }, KEEPALIVE_MS);
  };
  scheduleTeardown();
}

// Last-active bookkeeping for keepalive decisions.
const LAST_ACTIVE = new Map<string, number>();
function touch(key: string) {
  LAST_ACTIVE.set(key, Date.now());
}
function lastActiveAt(key: string): number {
  return LAST_ACTIVE.get(key) ?? 0;
}

// ---------------------------------------------------------------------------
// AUTH STATE — module-level, shared, no per-component subscriptions.
// Backed by the Supabase auth store in ./supabase.ts (mirrors the former
// Firebase onAuthStateChanged wiring).
// ---------------------------------------------------------------------------

let authEpoch = 0;
let authReadySeen = false;
const epochListeners = new Set<Listener>();

onAuthStateChangedSupabase((uid) => {
  authReadySeen = isAuthReady();
  // Any identity change (including signed-out → anonymous guest) invalidates
  // auth-bound subscriptions; emits only fire on the supabase store's own
  // change events, so identical states don't loop.
  authEpoch++;
  void uid;
});

// Profile writes (completeProfile, role assignment) change what auth-bound
// queries are allowed to see; fold those into the same epoch so scope/role
// changes re-derive without a sign-out/in cycle.
onProfileVersionChanged(() => {
  authEpoch++;
});

function useAuthEpoch(): number {
  return useSyncExternalStore(
    (cb) => {
      epochListeners.add(cb);
      return () => epochListeners.delete(cb);
    },
    () => authEpoch,
    () => 0,
  );
}

// ---------------------------------------------------------------------------
// useQuery
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useQuery<T = any>(
  // Keep T in the parameter type so it is inferred from the query factory at
  // every call site (e.g. api.stats.commandCenter → CommandCenterStats).
  fn: (args?: any) => QueryHandle<T>,
  args?: unknown,
): T | undefined {
  const epoch = useAuthEpoch();
  // Convex "skip" sentinel: keep the query undefined without subscribing.
  const skipped = args === "skip";
  // Args are often inline object literals; key on their JSON so identical
  // values don't resubscribe every render.
  const argsKey = skipped || args === undefined ? "" : JSON.stringify(args);
  const key = skipped ? null : `${fnCacheId(fn)}|${argsKey}`;

  // Stable per call-site identity even though `fn` may be re-created.
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const argsRef = useRef(args);
  argsRef.current = args;

  const subscribe = useCallback(
    (cb: Listener) => {
      if (!key) return () => {};
      const e = getEntry(key);
      e.listeners.add(cb);
      touch(key);
      return () => {
        e.listeners.delete(cb);
        touch(key);
        releaseSubscription(key);
      };
    },
    [key],
  );

  const snapshot = useCallback(() => {
    if (!key) return undefined;
    const e = getEntry(key);
    return e.hasValue ? e.value : undefined;
  }, [key]);

  const value = useSyncExternalStore(subscribe, snapshot, snapshot);

  // Establish/refresh the underlying subscription after render (mount, args
  // change, or auth-epoch change). Effects, not render, own network work.
  useEffect(() => {
    if (!key || skipped) return;
    // QueryHandle<T> is assignable to AnyHandle (authBound is optional).
    ensureSubscribed(
      key,
      fnRef.current as unknown as QueryFn,
      argsRef.current,
      epoch,
    );
  }, [key, epoch, skipped]);

  if (skipped) return undefined;
  return value as T | undefined;
}

/** Identity for the query fn so call sites don't need to memoize it. */
const FN_IDS = new WeakMap<object, string>();
let FN_SEQ = 0;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fnCacheId(fn: (args?: any) => AnyHandle): string {
  let id = FN_IDS.get(fn);
  if (!id) {
    id = `q${FN_SEQ++}`;
    FN_IDS.set(fn, id);
  }
  return id;
}

// ---------------------------------------------------------------------------
// useMutation — thin stable wrapper around the async backend function.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useMutation(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fn: (...args: any[]) => Promise<any>,
): // eslint-disable-next-line @typescript-eslint/no-explicit-any
(...args: any[]) => Promise<any> {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (...args: any[]) => fnRef.current(...args);
}

export function useIsAuthenticated(): {
  isLoading: boolean;
  isAuthenticated: boolean;
} {
  useAuthEpoch();
  return {
    isLoading: !authReadySeen,
    isAuthenticated: authUserId() !== null,
  };
}
