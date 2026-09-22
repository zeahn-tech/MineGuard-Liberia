import { lazy, Suspense } from "react";
import { Toaster } from "@/components/ui/sonner";
import { RequireAuth } from "@/components/RequireAuth";
import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, Route, Routes } from "react-router";
import "./index.css";

const Landing = lazy(() => import("./pages/Landing.tsx"));
const AuthPage = lazy(() => import("./pages/Auth.tsx"));
const PortalLayout = lazy(() => import("./pages/PortalLayout.tsx"));
const CommandCenter = lazy(() => import("./pages/CommandCenter.tsx"));
const Sites = lazy(() => import("./pages/Sites.tsx"));
const SiteDetail = lazy(() => import("./pages/SiteDetail.tsx"));
const NationalMap = lazy(() => import("./pages/NationalMap.tsx"));
const Inspections = lazy(() => import("./pages/Inspections.tsx"));
const InspectionDetail = lazy(() => import("./pages/InspectionDetail.tsx"));
const Incidents = lazy(() => import("./pages/Incidents.tsx"));
const Environment = lazy(() => import("./pages/Environment.tsx"));
const Community = lazy(() => import("./pages/Community.tsx"));
const CommunitySubmit = lazy(() => import("./pages/CommunitySubmit.tsx"));
const CommunityTrack = lazy(() => import("./pages/CommunityTrack.tsx"));
const Audit = lazy(() => import("./pages/Audit.tsx"));
const NotFound = lazy(() => import("./pages/NotFound.tsx"));
const InspectionsLocal = lazy(() =>
  import("./pages/Inspections.tsx").then((m) => ({
    default: m.LocalInspectionForm,
  })),
);

function RouteLoading() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="animate-pulse text-muted-foreground">Loading…</div>
    </div>
  );
}

class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; message: string; stack: string }
> {
  state = { hasError: false, message: "", stack: "" };
  static getDerivedStateFromError(error: Error) {
    return {
      hasError: true,
      message: error.message || "Unknown runtime error",
      stack: error.stack || "",
    };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-background text-foreground p-6">
          <div className="max-w-lg text-center">
            <p className="text-sm font-semibold">Preview runtime error</p>
            <p className="mt-2 text-xs text-muted-foreground break-words">
              {this.state.message}
            </p>
            {this.state.stack && (
              <pre className="mt-3 text-left text-[10px] leading-4 text-muted-foreground/80 max-h-40 overflow-auto rounded border border-border/60 p-2">
                {this.state.stack}
              </pre>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootErrorBoundary>
      {/* HashRouter: static hosts (GitHub Pages) serve only index.html;
          hash routing keeps every deep link (/portal, /report, /auth)
          working with zero server-side rewrite configuration. */}
      <HashRouter>
        <Suspense fallback={<RouteLoading />}>
          <Routes>
            {/* Public */}
            <Route path="/" element={<Landing />} />
            <Route
              path="/auth"
              element={<AuthPage redirectAfterAuth="/portal" />}
            />
            <Route path="/report" element={<CommunitySubmit />} />
            <Route path="/report/track" element={<CommunityTrack />} />

            {/* Authenticated portal */}
            <Route
              path="/portal"
              element={
                <RequireAuth>
                  <PortalLayout />
                </RequireAuth>
              }
            >
              <Route index element={<CommandCenter />} />
              <Route path="sites" element={<Sites />} />
              <Route path="sites/:siteId" element={<SiteDetail />} />
              <Route path="map" element={<NationalMap />} />
              <Route path="inspections" element={<Inspections />} />
              {/* Static segment ranks above :inspectionId — must come as a sibling;
                  this is the offline-capable local draft form. */}
              <Route path="inspections/local/:clientRef" element={<InspectionsLocal />} />
              <Route path="inspections/:inspectionId" element={<InspectionDetail />} />
              <Route path="incidents" element={<Incidents />} />
              <Route path="environment" element={<Environment />} />
              <Route path="community" element={<Community />} />
              <Route path="audit" element={<Audit />} />
            </Route>

            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </HashRouter>
      <Toaster />
    </RootErrorBoundary>
  </StrictMode>,
);
