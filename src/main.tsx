import { lazy, Suspense } from "react";
import { Toaster } from "@/components/ui/sonner";
import { RootErrorBoundary } from "@/components/RootErrorBoundary";
import { RecoveryGate } from "@/components/RecoveryGate";
import { RouteLoading } from "@/components/RouteLoading";
import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, Route, Routes } from "react-router";
import { RequireStaff } from "@/components/RequireAuth";
import "./index.css";
import { installChunkRecovery } from "@/lib/chunk-recovery";
import { startInstallPrompt } from "@/lib/install-prompt";
import { CookieBanner } from "@/components/CookieBanner";
import { InstallBanner } from "@/components/InstallBanner";

installChunkRecovery();
// Listen for the browser's install event right away — it can fire before React renders.
startInstallPrompt();

const Landing = lazy(() => import("./pages/Landing.tsx"));
const AuthPage = lazy(() => import("./pages/Auth.tsx"));
const PortalLayout = lazy(() => import("./pages/PortalLayout.tsx"));
const CommandCenter = lazy(() => import("./pages/CommandCenter.tsx"));
const OperatorPortal = lazy(() => import("./pages/OperatorPortal.tsx"));
const Companies = lazy(() => import("./pages/Companies.tsx"));
const Invitation = lazy(() => import("./pages/Invitation.tsx"));
const Join = lazy(() => import("./pages/Join.tsx"));
const OperatorTeam = lazy(() => import("./pages/operate/OperatorTeam.tsx"));
const Sites = lazy(() => import("./pages/Sites.tsx"));
const SiteDetail = lazy(() => import("./pages/SiteDetail.tsx"));
const NationalMap = lazy(() => import("./pages/NationalMap.tsx"));
const Inspections = lazy(() => import("./pages/Inspections.tsx"));
const InspectionDetail = lazy(() => import("./pages/InspectionDetail.tsx"));
const Incidents = lazy(() => import("./pages/Incidents.tsx"));
const IncidentDetail = lazy(() => import("./pages/IncidentDetail.tsx"));
const Environment = lazy(() => import("./pages/Environment.tsx"));
const ObservationDetail = lazy(() => import("./pages/ObservationDetail.tsx"));
const Community = lazy(() => import("./pages/Community.tsx"));
const CommunitySubmit = lazy(() => import("./pages/CommunitySubmit.tsx"));
const CommunityTrack = lazy(() => import("./pages/CommunityTrack.tsx"));
const Audit = lazy(() => import("./pages/Audit.tsx"));
const Reports = lazy(() => import("./pages/Reports.tsx"));
const RiskConfig = lazy(() => import("./pages/RiskConfig.tsx"));
const Security = lazy(() => import("./pages/Security.tsx"));
const TemplateList = lazy(() =>
  import("./pages/Templates.tsx").then((m) => ({ default: m.TemplateList })),
);
const TemplateEditor = lazy(() =>
  import("./pages/Templates.tsx").then((m) => ({ default: m.TemplateEditor })),
);
const Boundaries = lazy(() => import("./pages/Boundaries.tsx"));
const Terms = lazy(() => import("./pages/Terms.tsx"));
const Privacy = lazy(() => import("./pages/Privacy.tsx"));
const Cookies = lazy(() => import("./pages/Cookies.tsx"));
const NotFound = lazy(() => import("./pages/NotFound.tsx"));
const OperatorLayout = lazy(() => import("./pages/operate/OperatorLayout.tsx"));
const OperatorOverview = lazy(() => import("./pages/operate/OperatorOverview.tsx"));
const OperatorSites = lazy(() => import("./pages/operate/OperatorSites.tsx").then((m) => ({ default: m.OperatorSites })));
const OperatorSiteDetail = lazy(() => import("./pages/operate/OperatorSites.tsx").then((m) => ({ default: m.OperatorSiteDetail })));
const OperatorFindings = lazy(() => import("./pages/operate/OperatorFindings.tsx"));
const OperatorCorrectiveActions = lazy(() => import("./pages/operate/OperatorCorrectiveActions.tsx"));
const OperatorIncidents = lazy(() => import("./pages/operate/OperatorIncidents.tsx"));
const OperatorSecurity = lazy(() => import("./pages/operate/OperatorSecurity.tsx"));
const InspectionsLocal = lazy(() =>
  import("./pages/Inspections.tsx").then((m) => ({
    default: m.LocalInspectionForm,
  })),
);

// ---------------------------------------------------------------------------
// SERVICE WORKER HYGIENE
//  - production: register the offline app shell (relative scope works at any
//    base path, including GitHub Pages project sites).
//  - dev/preview: unregister any previously installed worker and drop its
//    caches, so an earlier session's cache-first worker can never serve stale
//    modules into the preview (a common cause of a blank/broken preview).
// ---------------------------------------------------------------------------
if ("serviceWorker" in navigator) {
  if (import.meta.env.PROD) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(() => {
        /* offline support is progressive enhancement — ignore failures */
      });
    });
  } else {
    navigator.serviceWorker
      .getRegistrations()
      .then((regs) => Promise.all(regs.map((r) => r.unregister())))
      .catch(() => {});
    if ("caches" in window) {
      caches
        .keys()
        .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
        .catch(() => {});
    }
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootErrorBoundary>
      {/* HashRouter: static hosts (GitHub Pages) serve only index.html;
          hash routing keeps every deep link (/portal, /report, /auth)
          working with zero server-side rewrite configuration. */}
      <HashRouter>
       <RecoveryGate>
        <Suspense fallback={<RouteLoading />}>
          <Routes>
            {/* Public */}
            <Route path="/" element={<Landing />} />
            <Route
              path="/auth"
              element={<AuthPage redirectAfterAuth="/portal" />}
            />
            {/* Phase B: invitee landing — any signed-in account (no role yet). */}
            <Route path="/invitation" element={<Invitation />} />
            <Route path="/join" element={<Join />} />
            <Route path="/terms" element={<Terms />} />
            <Route path="/privacy" element={<Privacy />} />
            <Route path="/cookies" element={<Cookies />} />
            <Route path="/report" element={<CommunitySubmit />} />
            <Route path="/report/track" element={<CommunityTrack />} />

            {/* OPERATOR SECTION — a routed section of its own (Priority B
                §20), gated by RequireOperator. Staff identities are
                redirected to the staff portal; nothing staff-only renders
                inside this subtree. */}
            <Route
              path="/operate"
              element={<OperatorLayout />}
            >
              <Route index element={<OperatorOverview />} />
              <Route path="sites" element={<OperatorSites />} />
              <Route path="sites/:siteId" element={<OperatorSiteDetail />} />
              <Route path="findings" element={<OperatorFindings />} />
              <Route path="corrective-actions" element={<OperatorCorrectiveActions />} />
              <Route path="incidents" element={<OperatorIncidents />} />
              <Route path="team" element={<OperatorTeam />} />
              <Route path="security" element={<OperatorSecurity />} />
            </Route>

            {/* Authenticated STAFF portal — gated by RequireStaff so an
                operator account cannot render (or be navigated into) any
                staff-only surface. */}
            <Route
              path="/portal"
              element={
                <RequireStaff>
                  <PortalLayout />
                </RequireStaff>
              }
            >
              <Route index element={<CommandCenter />} />
              <Route path="operate" element={<OperatorPortal />} />
              <Route path="companies" element={<Companies />} />
              <Route path="sites" element={<Sites />} />
              <Route path="sites/:siteId" element={<SiteDetail />} />
              <Route path="map" element={<NationalMap />} />
              <Route path="inspections" element={<Inspections />} />
              {/* Static segment ranks above :inspectionId — must come as a sibling;
                  this is the offline-capable local draft form. */}
              <Route path="inspections/local/:clientRef" element={<InspectionsLocal />} />
              <Route path="inspections/:inspectionId" element={<InspectionDetail />} />
              <Route path="incidents" element={<Incidents />} />
              <Route path="incidents/:incidentId" element={<IncidentDetail />} />
              <Route path="environment" element={<Environment />} />
              <Route path="environment/:observationId" element={<ObservationDetail />} />
              <Route path="community" element={<Community />} />
              <Route path="audit" element={<Audit />} />
              <Route path="reports" element={<Reports />} />
              <Route path="risk-config" element={<RiskConfig />} />
              <Route path="boundaries" element={<Boundaries />} />
              <Route path="templates" element={<TemplateList />} />
              <Route path="templates/new" element={<TemplateEditor />} />
              <Route path="templates/:templateId" element={<TemplateEditor />} />
              <Route path="security" element={<Security />} />
            </Route>

            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
       </RecoveryGate>
       <CookieBanner />
       <InstallBanner />
      </HashRouter>
      <Toaster />
    </RootErrorBoundary>
  </StrictMode>,
);
