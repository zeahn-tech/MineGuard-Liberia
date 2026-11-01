import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { RefreshCw, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { useOnlineStatus } from "@/hooks/use-online";
import { loadPhase } from "@/lib/load-phase";

// ---------------------------------------------------------------------------
// PAGE LOADING — the loading, slow-network and offline-with-nothing-saved
// states in one component, so no screen shows a bare spinner or a dead "Loading…".
//
//  1. LOADING   Skeletons in the SHAPE of what is coming (list, cards, detail,
//               table, form) so the layout does not jump when data arrives.
//  2. SLOW      After SLOW_AFTER_MS: real signals only — seconds waited, how
//               much has loaded when the caller knows, and what the connection
//               looks like — plus the honest fact that it keeps retrying.
//  3. STALLED   After STALLED_AFTER_MS: a "Try again" and, when the screen has
//               one, a LIGHT PATH — something useful that works on a poor link.
//  4. OFFLINE   When there is no connection and nothing saved to show yet: say
//               so, say it loads on reconnect, and offer the light path.
//
// Nothing here is faked: no invented percentages, no looping bar that implies
// progress that isn't happening.
// ---------------------------------------------------------------------------

export type LoadingShape = "list" | "cards" | "detail" | "table" | "form";

/** A useful thing to do while the page loads or the link is poor. */
export interface LightPath {
  label: string;
  /** Router path (hash routing), e.g. "/portal/incidents". */
  to: string;
  /** One sentence on why this works on a bad connection. */
  hint?: string;
}

const LightPathContext = createContext<LightPath | null>(null);

/** Each shell supplies the light path that suits its users. */
export function LightPathProvider({ value, children }: { value: LightPath | null; children: ReactNode }) {
  return <LightPathContext.Provider value={value}>{children}</LightPathContext.Provider>;
}

/** What the connection looks like, when the browser will tell us. */
function connectionHint(): string | null {
  if (typeof navigator === "undefined") return null;
  const c = (navigator as unknown as { connection?: { effectiveType?: string; saveData?: boolean } }).connection;
  if (!c) return null;
  if (c.effectiveType === "slow-2g" || c.effectiveType === "2g") return "Your connection looks very slow.";
  if (c.effectiveType === "3g") return "Your connection looks slow.";
  return null;
}

function useElapsedMs(): number {
  const [ms, setMs] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const t = setInterval(() => setMs(Date.now() - start), 500);
    return () => clearInterval(t);
  }, []);
  return ms;
}

const pulse = "motion-reduce:animate-none";

function Shape({ shape, rows }: { shape: LoadingShape; rows: number }) {
  if (shape === "cards") {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-hidden="true">
        {Array.from({ length: Math.min(rows, 8) }).map((_, i) => (
          <div key={i} className="space-y-3 rounded-sm border border-border p-4">
            <Skeleton className={`h-3 w-1/3 ${pulse}`} />
            <Skeleton className={`h-8 w-1/2 ${pulse}`} />
            <Skeleton className={`h-3 w-2/3 ${pulse}`} />
          </div>
        ))}
      </div>
    );
  }
  if (shape === "detail") {
    return (
      <div className="space-y-5" aria-hidden="true">
        <div className="space-y-2">
          <Skeleton className={`h-3 w-24 ${pulse}`} />
          <Skeleton className={`h-8 w-2/3 ${pulse}`} />
          <Skeleton className={`h-4 w-1/2 ${pulse}`} />
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          <Skeleton className={`h-24 ${pulse}`} />
          <Skeleton className={`h-24 ${pulse}`} />
          <Skeleton className={`h-24 ${pulse}`} />
        </div>
        <Skeleton className={`h-40 w-full ${pulse}`} />
      </div>
    );
  }
  if (shape === "table") {
    return (
      <div className="overflow-hidden rounded-sm border border-border" aria-hidden="true">
        <div className="flex gap-4 border-b border-border bg-muted/40 px-4 py-3">
          {[24, 16, 32, 12].map((w, i) => (
            <Skeleton key={i} className={`h-3 ${pulse}`} style={{ width: `${w}%` }} />
          ))}
        </div>
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex gap-4 border-b border-border px-4 py-3.5 last:border-0">
            {[24, 16, 32, 12].map((w, j) => (
              <Skeleton key={j} className={`h-4 ${pulse}`} style={{ width: `${w}%` }} />
            ))}
          </div>
        ))}
      </div>
    );
  }
  if (shape === "form") {
    return (
      <div className="space-y-4" aria-hidden="true">
        {Array.from({ length: Math.min(rows, 6) }).map((_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className={`h-3 w-28 ${pulse}`} />
            <Skeleton className={`h-9 w-full ${pulse}`} />
          </div>
        ))}
        <Skeleton className={`h-9 w-32 ${pulse}`} />
      </div>
    );
  }
  // list
  return (
    <div className="space-y-3" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-sm border border-border p-4">
          <Skeleton className={`size-9 shrink-0 rounded-full ${pulse}`} />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className={`h-4 w-2/5 ${pulse}`} />
            <Skeleton className={`h-3 w-4/5 ${pulse}`} />
          </div>
          <Skeleton className={`hidden h-6 w-16 sm:block ${pulse}`} />
        </div>
      ))}
    </div>
  );
}

export interface PageLoadingProps {
  /** The silhouette of what is loading. */
  shape?: LoadingShape;
  /** What is loading, for screen readers and the slow message ("incidents"). */
  label?: string;
  /** Placeholder rows/cards. */
  rows?: number;
  /** Real progress, when the caller knows it (e.g. a paged list). */
  progress?: { loaded: number; total?: number; unit?: string };
  /** Retry action; defaults to re-reading data (or reloading the page). */
  onRetry?: () => void;
  /** Overrides the shell's light path. */
  lightPath?: LightPath | null;
  /** Tighter spacing for sections inside a page. */
  compact?: boolean;
  className?: string;
}

async function defaultRetry() {
  try {
    const m = await import("@/lib/backend");
    m.refreshAllData();
  } catch {
    window.location.reload();
  }
}

export function PageLoading({
  shape = "list",
  label = "page",
  rows,
  progress,
  onRetry,
  lightPath,
  compact = false,
  className = "",
}: PageLoadingProps) {
  const online = useOnlineStatus();
  const elapsed = useElapsedMs();
  const ctxPath = useContext(LightPathContext);
  const light = lightPath === undefined ? ctxPath : lightPath;
  const phase = loadPhase(elapsed, online);
  const seconds = Math.floor(elapsed / 1000);
  const hint = connectionHint();
  const count = rows ?? (shape === "cards" ? 4 : shape === "table" ? 6 : shape === "form" ? 4 : 5);

  const total = progress?.total;
  const pct = progress && total && total > 0 ? Math.min(100, Math.round((progress.loaded / total) * 100)) : null;

  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className={`min-w-0 space-y-4 ${compact ? "" : "py-2"} ${className}`}
    >
      <span className="sr-only">
        {phase === "offline" ? `You're offline. ${label} will load when you reconnect.` : `Loading ${label}…`}
      </span>

      {phase !== "loading" && (
        <div className="space-y-2 rounded-sm border border-border bg-muted/40 p-3 text-sm">
          {phase === "offline" ? (
            <>
              <p className="flex items-center gap-2 font-medium">
                <WifiOff className="size-4 shrink-0" aria-hidden="true" />
                You're offline.
              </p>
              <p className="text-muted-foreground">
                This {label} hasn't been opened on this device yet, so there's nothing saved to show. It will load
                by itself as soon as you reconnect.
              </p>
            </>
          ) : (
            <>
              <p className="font-medium">
                {phase === "stalled" ? "This is taking much longer than usual." : `Still loading ${label}…`}
              </p>
              <p className="text-muted-foreground">
                {hint ? `${hint} ` : ""}Waiting {seconds}s. We keep retrying in the background, so you don't need to
                refresh.
              </p>
            </>
          )}
          {progress && phase !== "offline" && (
            <div className="space-y-1">
              {pct !== null ? <Progress value={pct} aria-label={`${label} loaded`} /> : null}
              <p className="text-xs text-muted-foreground">
                {pct !== null
                  ? `${progress.loaded} of ${total} ${progress.unit ?? "items"} loaded (${pct}%)`
                  : `${progress.loaded} ${progress.unit ?? "items"} loaded so far`}
              </p>
            </div>
          )}
          {(phase === "stalled" || phase === "offline" || light) && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {phase === "stalled" && (
                <Button size="sm" variant="outline" onClick={onRetry ?? (() => void defaultRetry())}>
                  <RefreshCw className="size-3.5" /> Try again
                </Button>
              )}
              {light && (
                <Button size="sm" variant="outline" asChild>
                  <a href={`#${light.to}`}>{light.label}</a>
                </Button>
              )}
            </div>
          )}
          {light?.hint && (phase === "stalled" || phase === "offline") && (
            <p className="text-xs text-muted-foreground">{light.hint}</p>
          )}
        </div>
      )}

      <Shape shape={shape} rows={count} />
    </div>
  );
}
