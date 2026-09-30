// ---------------------------------------------------------------------------
// ACCESSIBILITY AUDIT (§16 definition-of-done item 5) — executed 2026-09-28.
//
// Five core flows audited (docs/16):
//   F1 public report  — /report + /report/track (CommunitySubmit/Track)
//   F2 sign-in        — /auth (incl. MFA step, recovery, sign-up)
//   F3 staff inspect  — /portal command center → sites → site detail
//   F4 field inspect  — /portal/inspections list → new draft → detail form
//   F5 operator comply— /operate overview → corrective actions → respond
//
// This suite pins the CONFIRMED DEFECTS found and fixed, plus the WCAG
// contrast computation over the real design tokens, so regressions fail CI:
//
//   DEFECTS FOUND (all fixed in this session):
//   A1. muted-foreground #6b6558 on --accent = 4.20:1 < 4.5 (WCAG AA)
//       → token darkened to #5d5648 (≥4.95:1 on all surfaces).
//   A2. No "skip to main content" link; <main> had no id in either portal
//       shell → keyboard users tab through the whole sidebar.
//   A3. Table rows that navigate on click (Inspections, Sites) were not
//       focusable and had no key handler — unreachable by keyboard.
//   A4. Template editor section accordion was a clickable <div> with no
//       role/tabIndex/key handling and no aria-expanded.
//   A5. Auth page inputs were placeholder-only (no label/aria-label) —
//       screen readers announced nothing meaningful.
//   A6. New-inspection dialog labels had no htmlFor for the two <select>s;
//       draft-form question controls had no id/label association.
//   A7. Notification bell: no aria-expanded/haspopup, no Escape close, and
//       the click-away layer was keyboard-tabbable noise.
//
// FINDINGS CONFIRMED AS ALREADY COMPLIANT (documented, not "fixed"):
//   - Radix dialogs: focus trap, Escape, aria-modal, labelled titles.
//   - Native <select> everywhere (keyboard-navigable by default).
//   - Icon-only buttons carried aria-labels; all dialogs have DialogTitle.
//   - EvidenceSection: real <button> for evidence, images have alt text.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function read(p: string): string {
  return readFileSync(join(...p.split("/")), "utf8");
}

// --------------------------------------------------------- 1. contrast (WCAG)

function luminance(hex: string): number {
  const c = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255).map((v) =>
    v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4),
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrastRatio(fg: string, bg: string): number {
  const [l1, l2] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (l1 + 0.05) / (l2 + 0.05);
}

describe("contrast: design tokens meet WCAG AA (computed, not asserted)", () => {
  // Fixed token after defect A1.
  const MUTED = "#5d5648";
  const pairs: [string, string, string][] = [
    ["ink on paper", "#232019", "#f0eee6"],
    ["muted on paper", MUTED, "#f0eee6"],
    ["muted on card", MUTED, "#f8f7f2"],
    ["muted on secondary", MUTED, "#e6e3d8"],
    ["muted on accent", MUTED, "#dfdccb"], // the failing pair, now fixed
    ["destructive on paper", "#9c2b1e", "#f0eee6"],
    ["primary-fg on primary", "#f0eee6", "#232019"],
  ];
  for (const [name, fg, bg] of pairs) {
    test(`${name} ≥ 4.5:1 (${fg} on ${bg})`, () => {
      const r = contrastRatio(fg, bg);
      expect(r).toBeGreaterThanOrEqual(4.5);
    });
  }

  test("the exact former failure (#6b6558 on accent) would FAIL — guard against reintroduction", () => {
    expect(contrastRatio("#6b6558", "#dfdccb")).toBeLessThan(4.5);
  });

  test("index.css carries the fixed muted-foreground token with the audit comment", () => {
    const css = read("src/index.css");
    expect(css).toContain("--muted-foreground: #5d5648");
    expect(css).toContain("Accessibility audit 2026-09-28");
  });
});

// --------------------------------------------------- 2. landmarks & skip link

describe("landmarks and skip navigation (both portal shells)", () => {
  test("staff shell: skip link renders before layout and main has the target id", () => {
    const src = read("src/pages/PortalLayout.tsx");
    expect(src).toContain('href="#main-content"');
    expect(src).toContain("Skip to main content");
    expect(src).toContain('<main id="main-content"');
  });

  test("operator shell: same skip link + main id", () => {
    const src = read("src/pages/operate/OperatorLayout.tsx");
    expect(src).toContain('href="#main-content"');
    expect(src).toContain('<main id="main-content"');
  });

  test("both shells keep their <nav> and <aside> landmarks", () => {
    expect(read("src/pages/PortalLayout.tsx")).toMatch(/<nav/);
    expect(read("src/pages/PortalLayout.tsx")).toMatch(/<aside/);
    expect(read("src/pages/operate/OperatorLayout.tsx")).toMatch(/<nav/);
  });
});

// ------------------------------------------------------- 3. keyboard access

describe("keyboard access (defects A3, A4, A7 fixed)", () => {
  test("click-navigating table rows are focusable with Enter/Space activation (staff)", () => {
    const inspections = read("src/pages/Inspections.tsx");
    expect(inspections).toContain("tabIndex={0}");
    expect(inspections).toContain('e.key === "Enter"');
    const sites = read("src/pages/Sites.tsx");
    expect(sites).toContain("tabIndex={0}");
    expect(sites).toContain('e.key === "Enter"');
  });

  test("template editor accordion is a keyboard-operable button-like header with aria-expanded", () => {
    const src = read("src/pages/Templates.tsx");
    expect(src).toContain('role="button"');
    expect(src).toContain("aria-expanded=");
    expect(src).toContain("onKeyDown=");
  });

  test("notification bell uses an accessible Popover trigger with managed dismissal", () => {
    const src = read("src/components/NotificationBell.tsx");
    expect(src).toContain("<Popover open={open} onOpenChange={setOpen}>");
    expect(src).toContain("<PopoverTrigger asChild>");
    expect(src).toContain("<PopoverContent");
    expect(src).toContain('aria-label={`Notifications${notifs.length > 0 ? ` (${notifs.length})` : ""}`}');
    expect(src).not.toContain('onKeyDown={(e) =>');
  });
});

// ------------------------------------------------- 4. labels & announcements

describe("labels and screen-reader announcements (defects A5, A6 fixed)", () => {
  test("auth inputs are no longer placeholder-only", () => {
    const src = read("src/pages/Auth.tsx");
    for (const label of [
      'aria-label="Email address"',
      'aria-label="Password"',
      'aria-label="Full name"',
      'aria-label="Confirm password"',
      'aria-label="New password"',
      'aria-label="Confirm new password"',
      'aria-label="6-digit authenticator code"',
    ]) {
      expect(src).toContain(label);
    }
  });

  test("new-inspection dialog labels are programmatically associated", () => {
    const src = read("src/pages/Inspections.tsx");
    expect(src).toContain('htmlFor="new-insp-site"');
    expect(src).toContain('id="new-insp-site"');
    expect(src).toContain('htmlFor="new-insp-template"');
    expect(src).toContain('id="new-insp-template"');
  });

  test("draft-form question controls are label-associated by answer key", () => {
    const src = read("src/pages/Inspections.tsx");
    expect(src).toContain("htmlFor={`q-${key}`}");
    expect(src).toMatch(/id=\{`q-\$\{key\}`\}/);
  });

  test("every dialog in the audited flows has a DialogTitle", () => {
    for (const f of [
      "src/pages/Inspections.tsx",
      "src/pages/SiteDetail.tsx",
      "src/pages/PortalLayout.tsx",
      "src/pages/Incidents.tsx",
      "src/pages/Sites.tsx",
      "src/components/EvidenceSection.tsx",
    ]) {
      const src = read(f);
      const contents = (src.match(/<DialogContent/g) ?? []).length;
      const titles = (src.match(/<DialogTitle/g) ?? []).length;
      expect(titles, `${f}`).toBeGreaterThanOrEqual(contents);
    }
  });

  test("evidence thumbnails keep alt text (no bare images in audited flows)", () => {
    const src = read("src/components/EvidenceSection.tsx");
    expect(src).toMatch(/<img[^>]*alt=/s);
  });
});
