// ---------------------------------------------------------------------------
// Recover from a stale app shell.
//
// After a deploy, a phone that kept the old shell (or a cached index.html) asks
// for lazy-loaded page chunks whose hashed file names no longer exist. The
// dynamic import fails and the screen is blank. Vite reports this as a
// `vite:preloadError` event. Reloading once fetches the new shell and fixes it;
// doing it more than once would loop forever if the server itself is broken, so
// a per-session flag allows exactly one automatic reload, after which the normal
// error screen (with its Reload button) is shown.
// ---------------------------------------------------------------------------

export const CHUNK_RELOAD_KEY = "mg.chunk-reload";
/** Allow another automatic recovery after the app has run fine this long. */
const RESET_AFTER_MS = 10_000;

interface EventTargetLike {
  addEventListener(type: string, listener: (event: { preventDefault(): void }) => void): void;
}
interface StoreLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function installChunkRecovery(
  target: EventTargetLike = window,
  store: StoreLike = sessionStorage,
  reload: () => void = () => window.location.reload(),
): void {
  target.addEventListener("vite:preloadError", (event) => {
    // We are handling it: stop Vite re-throwing it as an unhandled error.
    event.preventDefault();
    try {
      if (store.getItem(CHUNK_RELOAD_KEY)) return; // already reloaded once this session
      store.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
    } catch {
      return; // no storage → cannot guard against a loop → do not reload
    }
    reload();
  });
  // A session that has been healthy for a while may recover from the NEXT deploy.
  setTimeout(() => {
    try {
      store.removeItem(CHUNK_RELOAD_KEY);
    } catch {
      /* storage unavailable: nothing to clear */
    }
  }, RESET_AFTER_MS);
}
