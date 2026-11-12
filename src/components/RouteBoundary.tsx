import { Suspense, type ReactNode } from "react";
import { PageLoading } from "@/components/PageLoading";

/**
 * The page area of a shell (portal, operator, registry).
 *
 * Pages are lazy chunks. If one is still downloading, only THIS area shows a
 * skeleton — the sidebar, header and banners around it stay on screen. Without a
 * boundary here the nearest one was the app root, which blanked the whole window
 * (see lib/route-preload.ts for the full story).
 */
export function RouteBoundary({ children }: { children: ReactNode }) {
  return <Suspense fallback={<PageLoading shape="cards" label="page" />}>{children}</Suspense>;
}
