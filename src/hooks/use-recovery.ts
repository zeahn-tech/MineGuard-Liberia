import { useSyncExternalStore } from "react";
import {
  getRecoveryState,
  subscribeRecovery,
  type RecoveryState,
} from "@/lib/recovery";

/** Live view of the password-recovery landing state (see src/lib/recovery.ts). */
export function useRecoveryState(): RecoveryState {
  return useSyncExternalStore(subscribeRecovery, getRecoveryState, getRecoveryState);
}
