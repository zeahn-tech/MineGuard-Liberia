import { useEffect, useState } from "react";

/**
 * The current time as React state, refreshed every `intervalMs` (default one
 * minute). Reading `Date.now()` directly in render is impure — two renders of
 * the same props can disagree — so time-dependent UI (overdue badges, due-in
 * countdowns) reads it from here instead.
 */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
