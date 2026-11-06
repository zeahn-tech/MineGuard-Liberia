import { AlertTriangle } from "lucide-react";

/** Shown wherever an emergency alert is displayed. Never imply MineGuard is the site's emergency system. */
export const EMERGENCY_DISCLAIMER =
  "MineGuard alerts are a supplementary aid. They may be delayed or may not reach every device. They do not replace your site's sirens, radios, supervisors or approved emergency procedure — follow those first.";

export function EmergencyDisclaimer({ className = "" }: { className?: string }) {
  return (
    <p className={`flex items-start gap-2 text-xs leading-relaxed text-muted-foreground ${className}`}>
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.5} aria-hidden />
      <span>{EMERGENCY_DISCLAIMER}</span>
    </p>
  );
}
