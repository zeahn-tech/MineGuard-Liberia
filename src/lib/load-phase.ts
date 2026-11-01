// Timing rules for the loading experience (see components/PageLoading.tsx).
// Pure, so the thresholds are unit-tested and shared.

/** After this long a load is "slow": we start saying so, with real signals. */
export const SLOW_AFTER_MS = 4_000;
/** After this long it is "stalled": we offer a retry and a light path. */
export const STALLED_AFTER_MS = 12_000;

export type LoadPhase = "loading" | "slow" | "stalled" | "offline";

export function loadPhase(elapsedMs: number, online: boolean): LoadPhase {
  if (!online) return "offline";
  if (elapsedMs >= STALLED_AFTER_MS) return "stalled";
  if (elapsedMs >= SLOW_AFTER_MS) return "slow";
  return "loading";
}
