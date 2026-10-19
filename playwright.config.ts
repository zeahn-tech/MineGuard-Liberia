// Session 10 / UX-1 — Playwright smoke tests of the five core flows at the
// four reference viewports. The Supabase network is STUBBED (e2e/stub.ts):
// these tests prove the shipped UI bundle renders, navigates, validates and
// reflows — they do NOT prove backend behaviour (that is the PGlite suites'
// job) and they never touch a real Supabase project.
//
//   bun run build && bunx playwright test            # CI: playwright-managed Chromium
//   PW_CHROMIUM=/path/to/chrome bunx playwright test # sandbox: any Chromium binary
import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 4173);
const executablePath = process.env.PW_CHROMIUM || undefined;

export const VIEWPORTS = [
  { name: "320", width: 320, height: 640 },
  { name: "375", width: 375, height: 812 },
  { name: "768", width: 768, height: 1024 },
  { name: "1440", width: 1440, height: 900 },
] as const;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.e2e\.ts$/,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  retries: 0,
  reporter: [["list"]],
  outputDir: "./e2e/.artifacts",
  use: {
    baseURL: `http://localhost:${PORT}`,
    launchOptions: { executablePath, args: process.env.PW_CHROMIUM_ARGS?.split(" ").filter(Boolean) },
    serviceWorkers: "block",
  },
  projects: VIEWPORTS.map((v) => ({
    name: `w${v.name}`,
    use: { viewport: { width: v.width, height: v.height }, isMobile: v.width < 768, hasTouch: v.width < 768 },
  })),
  webServer: {
    command: `bunx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
