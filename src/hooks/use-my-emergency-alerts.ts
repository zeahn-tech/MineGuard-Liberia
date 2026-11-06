// Keeps this device's view of ITS OWN emergency alerts current.
//  - starts from the last-known copy (so a device that just lost signal still shows what it
//    last received, clearly marked as possibly out of date),
//  - re-checks every 30 s while visible, on reconnect and on return to the tab,
//  - listens to realtime changes as a speed-up only. Realtime and polling are both best-effort;
//    neither is a delivery guarantee.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  clientNeedsReload,
  fetchMyAlerts,
  loadLastKnown,
  saveLastKnown,
  type MyAlert,
} from "@/lib/emergency";
import { supabase } from "@/lib/supabase";

const POLL_MS = 30_000;

export interface MyEmergencyState {
  alerts: MyAlert[];
  checkedAt: number | null;
  online: boolean;
  lastCheckFailed: boolean;
  reloadNeeded: boolean;
  refresh: () => Promise<void>;
}

export function useMyEmergencyAlerts(enabled = true): MyEmergencyState {
  const [alerts, setAlerts] = useState<MyAlert[]>(() => (enabled ? loadLastKnown()?.alerts ?? [] : []));
  const [checkedAt, setCheckedAt] = useState<number | null>(() => (enabled ? loadLastKnown()?.checkedAt ?? null : null));
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine !== false));
  const [failed, setFailed] = useState(false);
  const [reloadNeeded, setReloadNeeded] = useState(false);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (!enabled || inFlight.current) return;
    inFlight.current = true;
    try {
      const r = await fetchMyAlerts();
      setAlerts(r.alerts);
      setCheckedAt(r.checkedAt);
      setFailed(false);
      setReloadNeeded(clientNeedsReload(r.apiVersion));
      saveLastKnown(r);
    } catch {
      setFailed(true); // keep showing the last-known alerts; the UI says they may be stale
    } finally {
      inFlight.current = false;
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const first = window.setTimeout(() => void refresh(), 0);
    const tick = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = window.setInterval(tick, POLL_MS);
    const goOnline = () => {
      setOnline(true);
      void refresh();
    };
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    document.addEventListener("visibilitychange", tick);
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === "mg-push-subscription-changed") void import("@/lib/emergency").then((m) => m.refreshPushRegistration());
    };
    navigator.serviceWorker?.addEventListener("message", onMsg);
    let channel: ReturnType<typeof supabase.channel> | null = null;
    try {
      channel = supabase
        .channel("mg-emergency-alerts")
        .on("postgres_changes", { event: "*", schema: "public", table: "emergency_alerts" }, () => void refresh())
        .subscribe();
    } catch {
      /* realtime is optional */
    }
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      document.removeEventListener("visibilitychange", tick);
      navigator.serviceWorker?.removeEventListener("message", onMsg);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [enabled, refresh]);

  return { alerts, checkedAt, online, lastCheckFailed: failed, reloadNeeded, refresh };
}

/** A clock that re-renders every `ms`, so "checked 3 min ago" stays honest without calling
 *  Date.now() during render. */
export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}
