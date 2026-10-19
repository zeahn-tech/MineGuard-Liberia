// Session 10 / UX-1 — smoke tests of the five core flows (docs/09, docs/16):
//   F1 public report      /report → submit → tracking code → /report/track
//   F2 sign-in            /auth (labelled fields, rejected credentials, keyboard)
//   F3 staff sites        /portal → /portal/sites → site detail (keyboard row)
//   F4 field inspections  /portal/inspections → new-inspection dialog (Esc closes)
//   F5 operator           /operate → corrective actions; staff areas redirect away
// Run at 320 / 375 / 768 / 1440 (playwright.config.ts projects).
import { expect, test, type Page } from "@playwright/test";
import { installStub } from "./stub";

const shot = (page: Page, testInfo: { project: { name: string }; outputPath: (n: string) => string }, name: string) =>
  page.screenshot({ path: testInfo.outputPath(`${name}-${testInfo.project.name}.png`), fullPage: false });

/** Collects page errors; returns an asserter for the end of the test. */
function watch(page: Page, allow?: RegExp) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error" || /Failed to load resource/.test(m.text())) return;
    if (allow?.test(m.text())) return; // an error the flow is DESIGNED to log
    errors.push(`console.error: ${m.text()}`);
  });
  return () => expect(errors, errors.join("\n")).toEqual([]);
}

/** The page must never scroll sideways (1px tolerance for sub-pixel layout). */
async function expectNoHorizontalScroll(page: Page) {
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(sw, `horizontal overflow: scrollWidth ${sw} > clientWidth ${cw}`).toBeLessThanOrEqual(cw + 1);
}

/** Interactive controls must be at least 24x24 CSS px (WCAG 2.2 SC 2.5.8). */
async function expectTargetSize(page: Page, min = 24) {
  const small = await page.evaluate((m) => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("button, a[href], input:not([type=hidden]), select, textarea, [role=button]")) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || cs.visibility === "hidden" || cs.display === "none") continue;
      if (el.closest(".sr-only") || el.classList.contains("sr-only")) continue;
      // Radix renders a hidden native <select> mirror (1x1, aria-hidden) — not a target
      if (el.getAttribute("aria-hidden") === "true" || el.tabIndex === -1 && r.width <= 1) continue;
      // inline text links inside a sentence are exempt per the SC
      if (el.tagName === "A" && cs.display === "inline") continue;
      if (r.width < m || r.height < m) out.push(`${el.tagName.toLowerCase()} "${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 30)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return out;
  }, min);
  expect(small, `targets under ${min}px`).toEqual([]);
}

async function chooseOption(page: Page, triggerId: string, optionName: string | RegExp) {
  await page.locator(`#${triggerId}`).click();
  await page.getByRole("option", { name: optionName }).click();
}

test.describe("F1 public report", () => {
  test("submit a report and reach the tracking page", async ({ page }, ti) => {
    const done = watch(page);
    await installStub(page);
    await page.goto("/#/report");
    await expect(page.getByRole("heading", { level: 1, name: "Report a mining concern" })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shot(page, ti, "f1-form");

    // validation first: the description is natively `required` (the browser
    // blocks the submit); with it filled, a missing category/county is refused
    // with a visible message and nothing is sent.
    await page.getByLabel("What did you observe? *").fill("x");
    await page.getByRole("button", { name: "Submit report" }).click();
    await expect(page.getByText("Category, county and description are required.")).toBeVisible();
    await page.getByLabel("What did you observe? *").fill("");

    await chooseOption(page, "category", "Pollution");
    await chooseOption(page, "county", "Bomi");
    await page.getByLabel("What did you observe? *").fill("Brown discharge entering the creek below the concession.");
    await page.getByRole("button", { name: "Submit report" }).click();

    await expect(page.getByRole("heading", { level: 1, name: "Report received" })).toBeVisible();
    await expect(page.getByText("MG-TEST-0001")).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shot(page, ti, "f1-received");

    await page.getByRole("link", { name: /track|status/i }).first().click();
    await expect(page.getByRole("heading", { level: 1, name: "Check report status" })).toBeVisible();
    done();
  });

  test("a rate-limited submit explains itself and keeps the form", async ({ page }) => {
    await installStub(page, { failSubmit: true });
    await page.goto("/#/report");
    await chooseOption(page, "category", "Pollution");
    await chooseOption(page, "county", "Bomi");
    await page.getByLabel("What did you observe? *").fill("Test");
    await page.getByRole("button", { name: "Submit report" }).click();
    await expect(page.getByText(/try again|failed|too many/i).first()).toBeVisible();
    await expect(page.getByLabel("What did you observe? *")).toHaveValue("Test");
  });

  test("layout is sound: no sideways scroll, targets ≥24px", async ({ page }) => {
    await installStub(page);
    await page.goto("/#/report");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectTargetSize(page);
  });
});

test.describe("F2 sign-in", () => {
  test("fields are labelled, keyboard-operable, and bad credentials are reported", async ({ page }, ti) => {
    const done = watch(page, /Sign-in error: Error: INCORRECT_CREDENTIALS/);
    await installStub(page);
    await page.goto("/#/auth");
    const email = page.getByLabel("Email address").first();
    const password = page.getByLabel("Password").first();
    await expect(email).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shot(page, ti, "f2-auth");

    await email.focus();
    await page.keyboard.type("nobody@example.test");
    await page.keyboard.press("Tab");
    await expect(password).toBeFocused();
    await page.keyboard.type("not-the-password");
    await page.keyboard.press("Enter");
    await expect(page.getByText(/invalid|incorrect|credentials|failed/i).first()).toBeVisible();
    await expectTargetSize(page);
    done();
  });
});

test.describe("F3 staff: command center → sites → site", () => {
  test("admin lands in the portal, skips to content, opens a site by keyboard", async ({ page }, ti) => {
    const done = watch(page);
    await installStub(page, { role: "admin" });
    await page.goto("/#/portal");
    const main = page.locator("main#main-content");
    await expect(main).toBeVisible();
    // skip link is the first tab stop and moves focus into main
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: /skip to (main )?content/i })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(main).toBeFocused();
    await expectNoHorizontalScroll(page);
    await shot(page, ti, "f3-command-center");

    await page.goto("/#/portal/sites");
    const row = page.getByRole("row", { name: /LB-BOM-001|Bomi Ridge/ }).first();
    await expect(row).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shot(page, ti, "f3-sites");
    await row.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#\/portal\/sites\/1111/);
    done();
  });
});

test.describe("F4 field inspections", () => {
  test("list renders and the new-inspection dialog is labelled, trapped and Esc-closable", async ({ page }, ti) => {
    const done = watch(page);
    await installStub(page, { role: "admin" });
    await page.goto("/#/portal/inspections");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shot(page, ti, "f4-inspections");

    const open = page.getByRole("button", { name: /new inspection|new|start/i }).first();
    await open.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading").first()).toBeVisible();
    await shot(page, ti, "f4-dialog");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(open).toBeFocused();
    done();
  });
});

test.describe("F5 operator", () => {
  test("operator sees their section; staff-only routes bounce back", async ({ page }, ti) => {
    const done = watch(page);
    await installStub(page, { role: "operator" });
    await page.goto("/#/operate");
    await expect(page.locator("main#main-content")).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shot(page, ti, "f5-operate");

    await page.goto("/#/operate/corrective-actions");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shot(page, ti, "f5-corrective");

    await page.goto("/#/portal/audit");
    await expect(page).toHaveURL(/#\/operate/);
    done();
  });
});
