import { useLayoutEffect, useRef } from "react";

/**
 * Always-current ref to `value`, updated after commit (never during render).
 *
 * Layout effects run before any passive effect or event handler, so callers
 * (timers, subscriptions, async continuations) observe the latest value
 * exactly as a render-time `ref.current = value` assignment did — without
 * writing a ref while rendering, which is unsafe under concurrent rendering
 * (a render can be discarded after its assignment).
 */
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
