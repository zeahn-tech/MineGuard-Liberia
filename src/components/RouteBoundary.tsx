import { Suspense, type ReactNode } from "react";
import { PageLoading } from "@/components/PageLoading";
import { useNavigationPending } from "@/lib/route-preload";

/**
 * The page area of a shell (portal, operator, registry).
 *
 * Pages are lazy chunks. If one is still downloading, only THIS area shows a
 * skeleton — the sidebar, header and banners around it stay on screen. Without a
 * boundary here the nearest one was the app root, which could blank the whole
 * window (see lib/route-preload.ts for the full story).
 *
 * While a tab click is waiting for the next page, the current page stays put and
 * a thin bar runs along the top of the window (no spinner, no fake percentage).
 */
export function RouteBoundary({ children }: { children: ReactNode }) {
  const pending = useNavigationPending();
  return (
    <>
      <div
        aria-hidden="true"
        data-slot="nav-progress"
        className={`pointer-events-none fixed inset-x-0 top-0 z-[60] h-0.5 overflow-hidden transition-opacity duration-150 ${pending ? "opacity-100" : "opacity-0"}`}
      >
        <div className="h-full w-1/3 bg-primary motion-safe:animate-[mg-nav-slide_1s_ease-in-out_infinite] motion-reduce:w-full motion-reduce:opacity-60" />
      </div>
      <Suspense fallback={<PageLoading shape="cards" label="page" />}>{children}</Suspense>
    </>
  );
}
