import { useEffect, useState, useSyncExternalStore } from "react";

function subscribe(cb: () => void): () => void {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => {
    window.removeEventListener("online", cb);
    window.removeEventListener("offline", cb);
  };
}

const getSnapshot = () => typeof navigator === "undefined" || navigator.onLine !== false;
// On the server (or before hydration) assume online: nothing to warn about.
const getServerSnapshot = () => true;

/** Live connectivity. `navigator.onLine` can say "online" on a dead link, so
 *  this is the floor, not a promise — slow/unreachable networks are handled by
 *  the loading and error states, which watch real responses. */
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** True for `ms` after the connection returns, so the "offline" bar can say
 *  "Back online" instead of just vanishing. State changes only inside the
 *  browser's online/offline event handlers. */
export function useJustReconnected(ms = 4000): boolean {
  const [just, setJust] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onOnline = () => {
      setJust(true);
      clearTimeout(timer);
      timer = setTimeout(() => setJust(false), ms);
    };
    const onOffline = () => {
      clearTimeout(timer);
      setJust(false);
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [ms]);
  return just;
}
