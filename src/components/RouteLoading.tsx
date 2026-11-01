import { PageLoading } from "@/components/PageLoading";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Suspense fallback while a lazily loaded route's code downloads.
 *
 * Shows the outline of a page (top bar + heading + content) rather than a
 * pulsing word, and — through PageLoading — says so honestly when the download
 * is slow, offers "Try again" if it stalls, and tells people plainly when they
 * are offline.
 */
export function RouteLoading() {
  return (
    <div className="min-h-screen bg-background">
      <div className="border-b border-border" aria-hidden="true">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-4 md:px-8">
          <Skeleton className="size-5 rounded-sm motion-reduce:animate-none" />
          <Skeleton className="h-4 w-36 motion-reduce:animate-none" />
        </div>
      </div>
      <div className="mx-auto max-w-6xl space-y-6 px-4 py-8 md:px-8">
        <div className="space-y-2" aria-hidden="true">
          <Skeleton className="h-3 w-24 motion-reduce:animate-none" />
          <Skeleton className="h-8 w-64 max-w-full motion-reduce:animate-none" />
        </div>
        <PageLoading shape="list" label="page" onRetry={() => window.location.reload()} />
      </div>
    </div>
  );
}
