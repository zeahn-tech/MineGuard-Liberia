// ---------------------------------------------------------------------------
// UX STATES CONTRACT — source-level guards that keep the ten UX states from
// quietly regressing as the app grows (see docs/20_UX_STATES.MD):
//
//  1 error · 2 offline · 3 slow network · 4 no results · 5 permission denied
//  6 session expired · 7 form validation · 8 success · 9 empty · 10 loading
//
// The behaviour itself is tested in ux-states-lib / ux-states-components /
// session-guard; these tests catch the shortcuts that bypass it.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...walk(rel));
    else if (/\.tsx?$/.test(name)) out.push(rel);
  }
  return out;
}

const SRC = walk("src").filter((f) => !f.includes("components/ui/"));
// Comments may legitimately quote the patterns we ban, so guards read code only.
const code = (f: string) =>
  read(f)
    .split("\n")
    .filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l))
    .join("\n");
const PAGES = SRC.filter((f) => f.startsWith("src/pages/"));
const ELLIPSIS = "(?:\\.\\.\\.|\u2026)";

describe("10 · loading shows the shape of what is coming", () => {
  test("no page renders a bare <p>Loading…</p> placeholder", () => {
    const rx = new RegExp(`<p[^>]*>\\s*Loading[^<]*${ELLIPSIS}`);
    // BoundaryLoader is an admin-only data tool whose own test asserts its
    // literal text; it is the one deliberate exception.
    const allowed = new Set(["src/components/BoundaryLoader.tsx"]);
    expect(SRC.filter((f) => !allowed.has(f) && rx.test(code(f)))).toEqual([]);
  });

  test("the lazy-route fallback is a skeleton page, not a pulsing word", () => {
    const src = read("src/components/RouteLoading.tsx");
    expect(src).toContain("PageLoading");
    expect(src).toContain("Skeleton");
    expect(src).not.toContain("animate-pulse text-muted-foreground");
  });

  test("every list/detail screen that fetches uses PageLoading", () => {
    for (const f of [
      "src/pages/Incidents.tsx",
      "src/pages/Sites.tsx",
      "src/pages/Environment.tsx",
      "src/pages/Inspections.tsx",
      "src/pages/Audit.tsx",
      "src/pages/Community.tsx",
      "src/pages/SiteDetail.tsx",
      "src/pages/CommandCenter.tsx",
      "src/pages/operate/OperatorIncidents.tsx",
      "src/pages/operate/OperatorSites.tsx",
      "src/pages/operate/OperatorTeam.tsx",
    ]) {
      expect(read(f)).toContain("<PageLoading");
    }
  });
});

describe("3 · slow network and 2 · offline", () => {
  test("every shell shows the offline banner inside its sticky header and guards the session", () => {
    for (const f of [
      "src/pages/PortalLayout.tsx",
      "src/pages/RegistryLayout.tsx",
      "src/pages/operate/OperatorLayout.tsx",
    ]) {
      const src = read(f);
      expect(src).toContain("<OfflineBanner");
      expect(src).toContain("<SessionGuard />");
      // the banner sits inside <header>…</header> so it stays in view
      const header = src.slice(src.indexOf("<header"), src.indexOf("</header>"));
      expect(header).toContain("<OfflineBanner");
    }
  });

  test("shells that can queue work give loading screens a light path", () => {
    expect(read("src/pages/PortalLayout.tsx")).toContain("<LightPathProvider");
    expect(read("src/pages/operate/OperatorLayout.tsx")).toContain("<LightPathProvider");
  });

  test("public pages show the offline notice too", () => {
    const src = read("src/components/PublicHeader.tsx");
    expect(src).toContain('<OfflineBanner variant="public"');
  });
});

describe("1 · errors say what, whose side, and how to fix", () => {
  test("no screen shows a raw exception message to the person", () => {
    const rx = /toast\.error\(\s*(?:\w+ instanceof Error \? \w+\.message|\w+\.message)\b/;
    expect(SRC.filter((f) => rx.test(code(f)))).toEqual([]);
  });

  test("the crash screen names the fault, whose it is, and how to continue — without a stack in production", () => {
    const src = read("src/components/RootErrorBoundary.tsx");
    expect(src).toContain("This is on us");
    expect(src).toContain("Reload");
    expect(src).toContain("Reference:");
    // details stay development-only (also enforced by production-cleanliness)
    expect(src).toMatch(/import\.meta\.env\.DEV[\s\S]{0,300}this\.state\.message/);
  });
});

describe("7 · forms flag the exact field instead of one toast", () => {
  test("no form validates with a 'required' or 'before submitting' toast", () => {
    const rx = /toast\.(?:error|info)\(\s*["'`][^"'`]*(?:required|before submitting|Choose a site)/i;
    expect(SRC.filter((f) => rx.test(read(f)))).toEqual([]);
  });

  test("the main entry forms use FormField and the shared rules", () => {
    for (const [f, rule] of [
      ["src/pages/Incidents.tsx", "validateIncident"],
      ["src/pages/operate/OperatorIncidents.tsx", "validateIncident"],
      ["src/pages/Environment.tsx", "validateObservation"],
      ["src/pages/Sites.tsx", "validateSite"],
      ["src/pages/CommunitySubmit.tsx", "validateCommunityReport"],
      ["src/pages/Companies.tsx", "validateCompanyName"],
      ["src/pages/operate/OperatorTeam.tsx", "validateInvite"],
    ] as const) {
      const src = read(f);
      expect(src).toContain("<FormField");
      expect(src).toContain(rule);
      expect(src).toContain("focusField");
    }
  });

  test("sign-up, reset and change-password flag the password fields themselves", () => {
    for (const f of ["src/pages/Auth.tsx", "src/pages/Security.tsx", "src/pages/operate/OperatorSecurity.tsx"]) {
      const src = read(f);
      expect(src).toContain("passwordProblem");
      expect(src).toContain("confirmProblem");
      expect(src).toContain("<FieldError");
    }
  });
});

describe("6 · a timeout never costs anyone their work", () => {
  test("the report forms keep their text on the device as it is typed", () => {
    for (const f of [
      "src/pages/Incidents.tsx",
      "src/pages/operate/OperatorIncidents.tsx",
      "src/pages/Environment.tsx",
      "src/pages/Sites.tsx",
    ]) {
      expect(read(f)).toContain("useFormDraft(");
    }
  });

  test("an idle sign-out keeps local data; an explicit sign-out follows the shared-device rule", () => {
    const b = read("src/lib/backend.ts");
    const idle = b.slice(b.indexOf("export async function signOutIdle"), b.indexOf("// ---------------------------------------------------------------------------\n// API SURFACE"));
    expect(idle).toContain('setSignedOutNotice("idle")');
    expect(idle).not.toContain("wipeOfflineDataIfSynced");
    expect(idle).not.toContain("clearAllFormDrafts");
    const out = b.slice(b.indexOf("export async function signOut()"), b.indexOf("export async function signOutIdle"));
    expect(out).toContain("wipeOfflineDataIfSynced");
    expect(out).toContain("clearAllFormDrafts");
  });

  test("the auth listener leaves a notice for sign-outs the person did not ask for", () => {
    const s = read("src/lib/supabase.ts");
    expect(s).toContain("consumeDeliberateSignOut");
    expect(s).toContain('setSignedOutNotice("ended")');
  });

  test("the sign-in screen explains why, once", () => {
    const a = read("src/pages/Auth.tsx");
    expect(a).toContain("peekSignedOutNotice");
    expect(a).toContain("clearSignedOutNotice");
    expect(a).toContain("signedOutCopy(");
  });

  test("the new storage is disclosed in the cookie and storage policy", () => {
    const p = read("src/pages/Cookies.tsx");
    for (const key of ["mg.session.lastactive.v1", "mg.session.signedoutnotice.v1", "mg.formdrafts.v1"]) {
      expect(p).toContain(key);
    }
    expect(p).toContain("signed out for inactivity");
  });
});

describe("9 · empty screens explain themselves", () => {
  test("the main list screens use EmptyState", () => {
    for (const f of [
      "src/pages/Incidents.tsx",
      "src/pages/Environment.tsx",
      "src/pages/Sites.tsx",
      "src/pages/Inspections.tsx",
      "src/pages/Templates.tsx",
      "src/pages/Audit.tsx",
      "src/pages/Companies.tsx",
      "src/pages/operate/OperatorIncidents.tsx",
      "src/pages/operate/OperatorSites.tsx",
    ]) {
      expect(read(f)).toContain("<EmptyState");
    }
  });

  test("no list screen is left with a one-line 'No … yet' paragraph", () => {
    const rx = /<p[^>]*>\s*No [a-z ]+ (?:yet|registered|recorded)[^<]*<\/p>/;
    const allowed = new Set(["src/pages/operate/OperatorSites.tsx", "src/pages/Companies.tsx", "src/pages/RiskConfig.tsx", "src/pages/InspectionDetail.tsx"]);
    const offenders = PAGES.filter((f) => !allowed.has(f) && rx.test(read(f)));
    expect(offenders).toEqual([]);
  });
});

describe("4 · searches that find nothing help", () => {
  test("the map search and the report tracker use NoResults with a verified suggestion", () => {
    const map = read("src/pages/NationalMap.tsx");
    expect(map).toContain("<NoResults");
    expect(map).toContain("suggestQuery");
    // a suggestion is only offered if it would return something
    expect(map).toMatch(/hits\.length > 0/);
    const track = read("src/pages/CommunityTrack.tsx");
    expect(track).toContain("<NoResults");
    expect(track).toContain("normalizeTrackingCode");
  });
});

describe("5 · permission denied explains why and offers a way on", () => {
  test("GPS and camera denial use PermissionNotice with a way back", () => {
    const g = read("src/pages/Inspections.tsx");
    expect(g).toContain("<PermissionNotice");
    expect(g).toContain("Continue without GPS");
    expect(g).not.toContain("`GPS error: ${err.message}`");
    const c = read("src/components/CameraCapture.tsx");
    expect(c).toContain("<PermissionNotice");
    expect(c).toContain("cameraReason(");
  });
});

describe("8 · success confirms, reassures and says what happens next", () => {
  test("creation flows use toastSuccess with a reassurance", () => {
    for (const f of [
      "src/pages/Incidents.tsx",
      "src/pages/Environment.tsx",
      "src/pages/Sites.tsx",
      "src/pages/Companies.tsx",
      "src/pages/operate/OperatorIncidents.tsx",
      "src/pages/operate/OperatorTeam.tsx",
    ]) {
      const src = read(f);
      expect(src).toContain("toastSuccess(");
      expect(src).toContain("reassure");
    }
  });

  test("a queued (offline) save never says 'submitted' or 'reported'", () => {
    const i = read("src/pages/Incidents.tsx");
    const queuedBranch = i.slice(i.indexOf('title: "Saved on this device."'), i.indexOf('title: "Saved on this device."') + 300);
    expect(queuedBranch).toContain("nothing is lost");
    expect(queuedBranch).not.toMatch(/title: "Incident reported/);
  });
});
