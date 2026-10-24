// Terms of Use + Privacy Policy: present, reachable, and consistent with what
// the app actually does (so the documents cannot silently drift from the code).
import { describe, expect, test } from "bun:test";
import { formatLegalDate, LEGAL_UPDATED, LEGAL_VERSION, legalContactEmail } from "../src/lib/legal";

const read = (p: string) => Bun.file(new URL(p, import.meta.url)).text();

describe("legal metadata", () => {
  test("version and ISO effective date are well-formed", () => {
    expect(LEGAL_VERSION).toMatch(/^\d+\.\d+$/);
    expect(LEGAL_UPDATED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(formatLegalDate("2026-10-24")).toBe("24 October 2026");
  });
  test("contact email is never invented — null unless configured", () => {
    expect(legalContactEmail()).toBeNull();
  });
});

describe("routes and entry points", () => {
  test("both pages are public routes", async () => {
    const main = await read("../src/main.tsx");
    expect(main).toContain('path="/terms"');
    expect(main).toContain('path="/privacy"');
    // public: neither is wrapped in RequireAuth
    const t = main.slice(main.indexOf('path="/terms"'), main.indexOf('path="/terms"') + 120);
    expect(t).not.toContain("RequireAuth");
  });
  test("linked from landing, sign-in/up, the report form and the portal footer", async () => {
    for (const f of ["Landing", "Auth", "PortalLayout"]) {
      expect(await read(`../src/pages/${f}.tsx`)).toContain("<LegalLinks");
    }
    const form = await read("../src/pages/CommunitySubmit.tsx");
    expect(form).toContain('to="/privacy"');
    expect(form).toContain('to="/terms"');
  });
});

describe("the documents match the app", () => {
  test("privacy: data the report form collects is disclosed; optional fields stay optional", async () => {
    const form = await read("../src/pages/CommunitySubmit.tsx");
    const policy = await read("../src/pages/Privacy.tsx");
    expect(form).toContain("Contact phone (optional)");
    expect(form).toContain("GPS latitude (optional)");
    for (const needle of ["contact phone", "GPS coordinates", "tracking code", "salted", "optional"]) {
      expect(policy.toLowerCase()).toContain(needle.toLowerCase());
    }
  });

  test("privacy: stated limits agree with the code (25 MB evidence, ~2 min links)", async () => {
    const policy = await read("../src/pages/Privacy.tsx");
    expect(policy).toContain("25 MB");
    expect(policy).toContain("two minutes");
    const evidence = await read("../src/components/EvidenceSection.tsx");
    expect(evidence).toMatch(/25\s*\*\s*1024\s*\*\s*1024|25MB|25 MB/);
  });

  test("privacy: no analytics/ads claim is true — nothing of the kind ships", async () => {
    const pkg = await read("../package.json");
    const html = await read("../index.html");
    for (const bad of ["gtag", "google-analytics", "sentry", "posthog", "mixpanel", "plausible", "segment"]) {
      expect(pkg.toLowerCase()).not.toContain(bad);
      expect(html.toLowerCase()).not.toContain(bad);
    }
  });

  test("privacy: named providers are the ones the app uses", async () => {
    const policy = await read("../src/pages/Privacy.tsx");
    for (const p of ["Supabase", "GitHub Pages", "OpenStreetMap"]) expect(policy).toContain(p);
    expect(await read("../src/lib/map-tiles.ts")).toContain("tile.openstreetmap.org");
  });

  test("privacy: on-device storage disclosure covers what the app stores", async () => {
    const policy = await read("../src/pages/Privacy.tsx");
    for (const s of ["sign-in session", "offline queue", "map tiles", "install"]) {
      expect(policy.toLowerCase()).toContain(s);
    }
  });

  test("terms: allegation / not-official / not-emergency framing is present", async () => {
    const terms = await read("../src/pages/Terms.tsx");
    for (const s of ["allegation", "not an official Government of Liberia system", "not an emergency service", "Governing law"]) {
      expect(terms.toLowerCase()).toContain(s.toLowerCase());
    }
  });

  test("both documents cross-link and share the layout (version + date shown)", async () => {
    expect(await read("../src/pages/Terms.tsx")).toContain('to="/privacy"');
    expect(await read("../src/pages/Privacy.tsx")).toContain('to="/terms"');
    const layout = await read("../src/components/LegalLayout.tsx");
    expect(layout).toContain("LEGAL_VERSION");
    expect(layout).toContain("formatLegalDate");
  });

  test("hash routing: contents use scrolling, not #anchors", async () => {
    const layout = await read("../src/components/LegalLayout.tsx");
    expect(layout).toContain("scrollIntoView");
    expect(layout).not.toMatch(/href=\{?[`"']#/);
  });
});
