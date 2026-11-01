import type { ReactNode } from "react";
import { ShieldAlert } from "lucide-react";

/**
 * A blocked permission, explained: why the feature asks for it, how to turn it
 * on, and — always — a way to carry on without it. `children` is the way back
 * (a file picker, a manual entry, a cancel button).
 */
export function PermissionNotice({
  title,
  why,
  howToAllow,
  children,
  className = "",
}: {
  title: string;
  /** Why we ask, and what we do and don't do with it. */
  why: string;
  /** Where to switch it back on. */
  howToAllow: string;
  /** The way back / way around. */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div role="status" className={`space-y-2 rounded-sm border border-border bg-muted/40 p-3 text-sm ${className}`}>
      <p className="flex items-center gap-2 font-medium">
        <ShieldAlert className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        {title}
      </p>
      <p className="text-xs leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">Why we ask: </span>
        {why}
      </p>
      <p className="text-xs leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">To allow it: </span>
        {howToAllow}
      </p>
      {children && <div className="space-y-2 pt-1">{children}</div>}
    </div>
  );
}
