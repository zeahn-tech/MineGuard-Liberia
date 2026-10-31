// ---------------------------------------------------------------------------
// APP SHELL PARITY — the staff portal, company registry and operator portal are
// separate routed subtrees (deliberately: different gates, different nav), but
// they must present the same chrome: a header that stays in view while the
// page scrolls, and a slide-in navigation drawer with Sign out on phones.
//
// Source contracts, like the rest of this suite: they fail loudly if one shell
// drifts (e.g. a header that scrolls away, or a drawer reverting to an inline
// dropdown that pushes page content down).
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const SHELLS = [
  { name: "staff portal", file: "src/pages/PortalLayout.tsx" },
  { name: "company registry", file: "src/pages/RegistryLayout.tsx" },
  { name: "operator portal", file: "src/pages/operate/OperatorLayout.tsx" },
] as const;

describe.each(SHELLS)("app shell parity — $name", ({ file }) => {
  const src = read(file);

  test("the top bar is a single sticky header (stays in view on scroll, hidden in print)", () => {
    expect((src.match(/<header\b/g) ?? []).length).toBe(1);
    expect(src).toMatch(/<header className="sticky top-0 z-20 [^"]*print:hidden"/);
  });

  test("navigation on phones is a slide-in drawer opened by a labelled menu button", () => {
    expect(src).toContain('aria-label="Open navigation menu"');
    expect(src).toContain("<Sheet open={mobileNavOpen}");
    expect(src).toMatch(/<SheetContent\s+side="left"/);
    // the old inline dropdown toggle must not come back
    expect(src).not.toContain("Toggle navigation");
    expect(src).not.toMatch(/\{mobileNavOpen && \(/);
  });

  test("the menu button uses the shared bordered-square style", () => {
    expect(src).toContain(
      "rounded-sm border border-border p-2 text-foreground transition-colors hover:bg-accent md:hidden",
    );
  });

  test("Sign out is available in the sidebar and in the drawer, and returns to the landing page", () => {
    expect((src.match(/<LogOut /g) ?? []).length).toBe(2);
    expect(src).toContain("await signOut();");
    expect(src).toContain('navigate("/")');
  });

  test("the notification bell is reachable on phones (header) and on desktop (sidebar)", () => {
    expect((src.match(/<NotificationBell/g) ?? []).length).toBe(2);
  });
});
