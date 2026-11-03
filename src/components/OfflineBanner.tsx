import { Wifi, WifiOff } from "lucide-react";
import { useJustReconnected, useOnlineStatus } from "@/hooks/use-online";

/**
 * Tells people the truth about being offline so they never stare at a blank or
 * frozen screen: what they are looking at, what still works, and what happens
 * to their work. Rendered inside each shell's sticky header so it stays in view.
 *
 *  - "app":      staff/operator shells — reports and inspections queue on the
 *                device and are sent when the connection returns.
 *  - "readonly": shells with no offline capture (the company registry) — says
 *                plainly that changes need a connection.
 *  - "public":   signed-out pages (report form, legal) — says what can't be
 *                sent until the connection returns.
 *
 * `pending` is the number of items already waiting on this device to be sent.
 */
export function OfflineBanner({
  variant = "app",
  pending = 0,
}: {
  variant?: "app" | "readonly" | "public";
  pending?: number;
}) {
  const online = useOnlineStatus();
  const justReconnected = useJustReconnected();

  if (online && !justReconnected) return null;

  if (online) {
    return (
      <div
        role="status"
        className="flex items-start gap-2 border-t border-border bg-emerald-100 px-4 py-2 text-xs text-emerald-950 md:px-6 dark:bg-emerald-950/60 dark:text-emerald-100"
      >
        <Wifi className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <p>
          <strong className="font-semibold">Back online.</strong>
          {variant === "app" ? " Sending anything you saved while you were away." : ""}
        </p>
      </div>
    );
  }

  const waiting =
    pending > 0 ? ` ${pending} item${pending === 1 ? " is" : "s are"} waiting to be sent.` : "";

  return (
    <div
      role="status"
      className="flex items-start gap-2 border-t border-border bg-amber-100 px-4 py-2 text-xs text-amber-950 md:px-6 dark:bg-amber-950/60 dark:text-amber-100"
    >
      <WifiOff className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <p>
        <strong className="font-semibold">You're offline.</strong>
        {variant === "public"
          ? " You can keep filling this in, but it can only be sent once you reconnect."
          : variant === "readonly"
            ? " Showing what was last loaded on this device. Changes need a connection."
            : ` Showing what was last loaded on this device. Reports and inspections you save are kept here and sent when you reconnect.${waiting}`}
      </p>
    </div>
  );
}
